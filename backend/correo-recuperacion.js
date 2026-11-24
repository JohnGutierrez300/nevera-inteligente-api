const nodemailer = require('nodemailer');
const { setTimeout: pausa } = require('node:timers/promises');

const URL_TOKEN_GMAIL = 'https://oauth2.googleapis.com/token';
const URL_ENVIO_GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const ESTADOS_HTTP_TEMPORALES = new Set([408, 429, 500, 502, 503, 504]);
const FALLOS_RED_TEMPORALES = new Set([
  'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET'
]);
const ESPERA_MINIMA_REINTENTO_MS = 250;
const ESPERA_MAXIMA_REINTENTO_MS = 5000;

function configurarCorreo(env = process.env) {
  const remitente = env.GMAIL_USER?.trim();
  const render = env.RENDER_EXTERNAL_URL?.trim();
  const direccion = env.PASSWORD_RESET_URL?.trim() ||
    (URL.canParse('/app/', render ?? '') ? new URL('/app/', render).href : '');
  if (!remitente || !URL.canParse(direccion)) return null;
  const enlace = new URL(direccion);
  const esLocal = ['localhost', '127.0.0.1', '[::1]'].includes(enlace.hostname);
  const esSegura = enlace.protocol === 'https:' || (!render && esLocal && enlace.protocol === 'http:');
  if (!esSegura || (render && esLocal) || enlace.username || enlace.password) return null;

  const oauth = {
    client_id: env.GMAIL_CLIENT_ID?.trim(),
    client_secret: env.GMAIL_CLIENT_SECRET?.trim(),
    refresh_token: env.GMAIL_REFRESH_TOKEN?.trim()
  };
  const credenciales = Object.values(oauth);
  if (credenciales.some(Boolean)) {
    return credenciales.every(Boolean) ? { remitente, enlace, oauth } : null;
  }
  const clave = env.GMAIL_APP_PASSWORD?.replace(/\s/g, '');
  return clave ? { remitente, enlace, clave } : null;
}

function errorGmail(code, respuesta) {
  return Object.assign(new Error('Gmail no pudo completar la solicitud.'), {
    code,
    estadoCorreo: respuesta?.status,
    reintentarEn: respuesta?.headers.get('Retry-After')
  });
}

function esperaReintento(error) {
  const temporal = ESTADOS_HTTP_TEMPORALES.has(error.estadoCorreo) ||
    (Number.isInteger(error.responseCode) && error.responseCode >= 400 && error.responseCode < 500) ||
    error.name === 'TimeoutError' || FALLOS_RED_TEMPORALES.has(error.code) ||
    FALLOS_RED_TEMPORALES.has(error.cause?.code);
  if (!temporal) return null;

  const espera = error.reintentarEn;
  if (!espera) return ESPERA_MINIMA_REINTENTO_MS;
  const milisegundos = /^\d+$/.test(espera) ? Number(espera) * 1000 : Date.parse(espera) - Date.now();
  return Math.max(ESPERA_MINIMA_REINTENTO_MS, Number.isNaN(milisegundos) ? 0 : milisegundos);
}

async function solicitarTokenGmail(parametros) {
  const respuesta = await fetch(URL_TOKEN_GMAIL, {
    method: 'POST',
    redirect: 'error',
    body: new URLSearchParams(parametros),
    signal: AbortSignal.timeout(10_000)
  });
  if (!respuesta.ok) {
    await respuesta.body?.cancel().catch(() => {});
    throw errorGmail('GMAIL_TOKEN_' + respuesta.status, respuesta);
  }
  return respuesta.json();
}

async function enviarPorApi(mensaje, oauth) {
  const { access_token } = await solicitarTokenGmail({ ...oauth, grant_type: 'refresh_token' });
  if (typeof access_token !== 'string' || !access_token) throw errorGmail('GMAIL_TOKEN_INVALIDO');

  const compositor = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' });
  const { message } = await compositor.sendMail(mensaje);
  const respuesta = await fetch(URL_ENVIO_GMAIL, {
    method: 'POST',
    redirect: 'error',
    headers: { Authorization: 'Bearer ' + access_token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: message.toString('base64url') }),
    signal: AbortSignal.timeout(10_000)
  });
  await respuesta.body?.cancel().catch(() => {});
  if (!respuesta.ok) throw errorGmail('GMAIL_ENVIO_' + respuesta.status, respuesta);
}

async function enviarCorreoRecuperacion(configuracion, email, enlace, codigo) {
  const mensaje = {
    from: { name: 'Nevera Inteligente', address: configuracion.remitente },
    to: { address: email, name: '' },
    subject: 'Restablece tu contraseña de Nevera Inteligente',
    text: [
      'Abre el siguiente enlace para elegir una contraseña nueva.',
      enlace,
      'También puedes escribir este código de 6 dígitos en la página de recuperación de Nevera Inteligente.',
      codigo,
      'El enlace y el código vencen en 30 minutos. Solo puedes completar el cambio una vez.',
      'Si no solicitaste el cambio, puedes ignorar este correo.'
    ].join('\n\n')
  };
  try {
    await enviarMensaje(configuracion, mensaje);
  } catch (error) {
    const espera = esperaReintento(error);
    if (espera === null || espera > ESPERA_MAXIMA_REINTENTO_MS) throw error;
    await pausa(espera);
    await enviarMensaje(configuracion, mensaje);
  }
}

async function enviarMensaje(configuracion, mensaje) {
  if (configuracion.oauth) return enviarPorApi(mensaje, configuracion.oauth);
  const transporte = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: configuracion.remitente, pass: configuracion.clave },
    dnsTimeout: 8000,
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 15000
  });
  try {
    await transporte.sendMail(mensaje);
  } finally {
    transporte.close();
  }
}

module.exports = { configurarCorreo, enviarCorreoRecuperacion, solicitarTokenGmail };
