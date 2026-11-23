const { createHash, randomBytes } = require('node:crypto');
const { once } = require('node:events');
const { readFile, rename, unlink, writeFile } = require('node:fs/promises');
const { createServer } = require('node:http');
const path = require('node:path');
const { solicitarTokenGmail } = require('../correo-recuperacion');

const archivoEnv = path.resolve(__dirname, '..', '..', '.env');
require('dotenv').config({ path: archivoEnv, quiet: true });

async function obtenerPermiso(cliente, remitente) {
  const estado = randomBytes(32).toString('base64url');
  const verificador = randomBytes(32).toString('base64url');
  const desafio = createHash('sha256').update(verificador).digest('base64url');
  const servidor = createServer();
  servidor.listen(0, '127.0.0.1');
  await once(servidor, 'listening');
  const retorno = 'http://127.0.0.1:' + servidor.address().port + '/';
  const permiso = Promise.withResolvers();
  const limite = setTimeout(() => permiso.reject(new Error('Venció la espera. Ejecuta el comando nuevamente.')), 300_000);
  servidor.on('request', (req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const url = URL.canParse(req.url, retorno) ? new URL(req.url, retorno) : null;
    if (req.method !== 'GET' || url?.pathname !== '/' || url.searchParams.get('state') !== estado) {
      res.writeHead(400).end('Esta solicitud no corresponde a la autorización iniciada.');
      return;
    }
    const codigo = url.searchParams.get('code');
    if (!codigo) {
      res.writeHead(400).end('La autorización no se completó. Puedes volver a la terminal.');
      permiso.reject(new Error('Google no concedió el permiso de envío.'));
      return;
    }
    res.end('Google devolvió la autorización. Regresa a la terminal para ver el resultado.');
    permiso.resolve(codigo);
  });

  const urlConsentimiento = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  urlConsentimiento.search = new URLSearchParams({
    client_id: cliente.client_id,
    redirect_uri: retorno,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/gmail.send',
    access_type: 'offline',
    prompt: 'consent',
    login_hint: remitente,
    state: estado,
    code_challenge: desafio,
    code_challenge_method: 'S256'
  }).toString();
  console.log('Abre este enlace en tu navegador y autoriza el envío con tu cuenta de Gmail.');
  console.log(urlConsentimiento.href);

  try {
    const code = await permiso.promise;
    return await solicitarTokenGmail({
      client_id: cliente.client_id,
      client_secret: cliente.client_secret,
      code,
      code_verifier: verificador,
      redirect_uri: retorno,
      grant_type: 'authorization_code'
    });
  } finally {
    clearTimeout(limite);
    servidor.close();
  }
}

async function main() {
  const archivoCliente = process.argv[2];
  if (!archivoCliente) throw new Error('Indica la ruta del archivo JSON del cliente de Gmail.');
  let cliente;
  try {
    cliente = JSON.parse(await readFile(archivoCliente, 'utf8')).installed;
  } catch {
    throw new Error('El archivo del cliente no se pudo leer como JSON.');
  }
  if (!cliente?.client_id || !cliente.client_secret) {
    throw new Error('Descarga el JSON de un cliente OAuth de tipo Aplicación de escritorio.');
  }
  const remitente = process.env.GMAIL_USER?.trim();
  if (!remitente) throw new Error('Completa GMAIL_USER en el archivo .env.');
  const { refresh_token } = await obtenerPermiso(cliente, remitente);
  if (typeof refresh_token !== 'string' || !refresh_token) throw new Error('Google no devolvió un token de actualización.');

  const contenido = await readFile(archivoEnv, 'utf8');
  const salto = contenido.includes('\r\n') ? '\r\n' : '\n';
  const otrasClaves = contenido.replace(/^[ \t]*(?:export[ \t]+)?GMAIL_(?:CLIENT_ID|CLIENT_SECRET|REFRESH_TOKEN)[ \t]*=[^\r\n]*(?:\r?\n|$)/gm, '');
  const claves = {
    GMAIL_CLIENT_ID: cliente.client_id,
    GMAIL_CLIENT_SECRET: cliente.client_secret,
    GMAIL_REFRESH_TOKEN: refresh_token
  };
  const bloque = Object.entries(claves).map(([nombre, valor]) => nombre + '=' + JSON.stringify(valor)).join(salto);
  const separador = otrasClaves && !otrasClaves.endsWith('\n') ? salto : '';
  const temporal = archivoEnv + '.' + randomBytes(8).toString('hex') + '.tmp';
  try {
    await writeFile(temporal, otrasClaves + separador + bloque + salto, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    if (await readFile(archivoEnv, 'utf8') !== contenido) throw new Error('El archivo .env cambió. Ejecuta el comando nuevamente.');
    await rename(temporal, archivoEnv);
  } finally {
    await unlink(temporal).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  console.log('Gmail autorizado. Las credenciales quedaron guardadas en .env.');
  console.log('Para Render, copia GMAIL_USER, GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET y GMAIL_REFRESH_TOKEN a Environment.');
}

main().catch(error => {
  const codigo = /^GMAIL_TOKEN_\d{3}$/.test(error.code) ? error.code : '';
  console.error(codigo ? 'Google rechazó el intercambio de autorización (' + codigo + ').' : error.message);
  process.exitCode = 1;
});
