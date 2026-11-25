const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { setTimeout: pause } = require('node:timers/promises');
const { MongoMemoryReplSet } = require('mongodb-memory-server-core');
const { mongo: { MongoClient, ObjectId } } = require('mongoose');
const { chromium } = require('playwright');
const { configurarCorreo } = require('../backend/correo-recuperacion');
const { huella, protegerClave } = require('../backend/credenciales');

const raiz = path.resolve(__dirname, '..');
const clave = 'PruebaNevera2026!';
const otraClave = 'PruebaNevera2030!';
const idAdmin = '7001';
const idAdminLocal = '7010';
const idAdminReservado = '7090';
const idAvisos = '7017';
const lotesAvisados = { editar: new ObjectId(), eliminar: new ObjectId() };
const idUsuario = '7002';
const idCuenta = '7003';
const idBorrado = '7004';
const inactividadMs = 7 * 60 * 1000;
const sesionLegada = { id: '7012', web: 'a'.repeat(64), bearer: 'b'.repeat(64) };
const catalogo = [
  ['categorias', { _id: 'Lácteos' }],
  ['marcas', { _id: 'Marca de prueba' }],
  ['unidades_medida', { _id: 'Litro', abreviatura: 'L' }],
  ['ingredientes', { _id: 'Leche' }],
  ['productos', { _id: 'LECHE', nombre: 'Leche de prueba', marca_nombre: 'Marca de prueba', categoria_nombre: 'Lácteos' }]
];
const loteBase = { producto_id: 'LECHE', unidad_medida_nombre: 'Litro', cantidad: 1 };
let replica;
let mongoUri;
let servidor;
let baseUrl;
let salida = '';
let admin;
let usuario;
const correosEnviados = [];
const eventosGmail = [];

function simularGmail() {
  let planEnvios = [];
  process.on('message', ({ configurarGmail }) => {
    if (!configurarGmail) return;
    planEnvios = configurarGmail;
    process.send({ eventoGmail: 'configurado' });
  });
  const solicitar = globalThis.fetch;
  globalThis.fetch = async (url, opciones) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      const parametros = new URLSearchParams(opciones.body);
      if (parametros.get('grant_type') !== 'refresh_token' || parametros.get('refresh_token') !== 'actualizacion-de-prueba') {
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      return Response.json({ access_token: 'acceso-de-prueba' });
    }
    if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send') {
      if (opciones.headers.Authorization !== 'Bearer acceso-de-prueba') return new Response(null, { status: 401 });
      const paso = planEnvios.shift();
      if (paso?.esperar) {
        await new Promise(resolve => {
          const reanudar = ({ continuarEnvio }) => {
            if (!continuarEnvio) return;
            process.off('message', reanudar);
            resolve();
          };
          process.on('message', reanudar);
          process.send({ eventoGmail: 'en_espera' });
        });
      }
      if (paso && paso.estado !== 200) return new Response(null, { status: paso.estado });
      process.send({ raw: JSON.parse(opciones.body).raw });
      return Response.json({ id: 'mensaje-de-prueba' });
    }
    return solicitar(url, opciones);
  };
}

async function esperar(comprobar, mensaje) {
  const limite = Date.now() + 15_000;
  do {
    const resultado = await comprobar();
    if (resultado) return resultado;
    await pause(100);
  } while (Date.now() < limite);
  assert.fail(mensaje + '\n' + salida);
}

async function esperarEventoGmail(evento) {
  return esperar(() => {
    const indice = eventosGmail.indexOf(evento);
    return indice >= 0 && eventosGmail.splice(indice, 1)[0];
  }, 'No se recibió el evento simulado de Gmail ' + evento);
}

async function prepararGmail(...pasos) {
  servidor.send({ configurarGmail: pasos });
  await esperarEventoGmail('configurado');
}

async function leerCorreoRecuperacion(email, esperarActivacion = true) {
  const raw = await esperar(() => correosEnviados.shift(), 'No se recibió el correo de recuperación de prueba.');
  const mime = Buffer.from(raw, 'base64url').toString('utf8').replace(/=\r?\n/g, '').replace(/=3D/g, '=');
  assert.ok(mime.includes(email));
  const enlace = /https:\/\/nevera-prueba\.example\/app\/#restablecer=([a-f0-9]{64})/.exec(mime);
  const codigo = /^([0-9]{6})\r?$/m.exec(mime);
  assert.ok(enlace && codigo, 'El correo debe incluir un enlace de recuperación y un código de seis dígitos.');
  const token = enlace[1];
  if (esperarActivacion) {
    const cliente = await new MongoClient(mongoUri).connect();
    try {
      const usuarios = cliente.db().collection('usuarios');
      await esperar(() => usuarios.findOne({ email, recuperacion_hash: huella(token) }),
        'El correo de prueba no se activó tras el envío.');
    } finally {
      await cliente.close();
    }
  }
  return { token, codigo: codigo[1] };
}

async function contadorIngreso(db, id) {
  const { password_hash } = await db.collection('usuarios').findOne({ _id: id });
  return { intentos: db.collection('intentos_ingreso'), filtro: { _id: huella(`${id}:${password_hash}`) } };
}

async function detenerProceso(proceso) {
  if (!proceso || proceso.exitCode !== null || proceso.signalCode !== null) return;
  const cierre = once(proceso, 'exit');
  proceso.kill();
  await cierre;
}

async function api(ruta, { method = 'GET', body, token, cookie, origin = baseUrl } = {}) {
  const headers = new Headers({ Origin: origin });
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', 'Bearer ' + token);
  if (cookie) headers.set('Cookie', cookie);
  const respuesta = await fetch(baseUrl + '/api' + ruta, {
    method, headers, body: JSON.stringify(body), signal: AbortSignal.timeout(6000)
  });
  return {
    status: respuesta.status,
    cookie: respuesta.headers.get('set-cookie')?.split(';')[0],
    retryAfter: respuesta.headers.get('retry-after'),
    solicitud: respuesta.headers.get('x-request-id'),
    ...(await respuesta.json())
  };
}

async function correcto(ruta, opciones) {
  const respuesta = await api(ruta, opciones);
  assert.equal(respuesta.status, 200, respuesta.message);
  assert.equal(respuesta.success, true, respuesta.message);
  return respuesta.data;
}

function datosCuenta(id) {
  return { id, nombre: 'usuario' + id, email: id + '@nevera.test', password: clave };
}

async function sesion(id, sesion_web = false) {
  const respuesta = await api('/usuarios/login', {
    method: 'POST', body: { id, password: clave, sesion_web }
  });
  assert.equal(respuesta.success, true, respuesta.message);
  if (sesion_web) {
    assert.match(respuesta.cookie, /^nevera_session=/);
    return { cookie: respuesta.cookie };
  }
  assert.match(respuesta.data.token, /^[a-f0-9]{64}$/);
  return { token: respuesta.data.token };
}

async function cerrarSesion(auth) {
  await correcto('/usuarios/logout', { ...auth, method: 'POST' });
}

function hoyEnColombia() {
  return new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const agregar = (body, auth = usuario) => correcto('/inventario', {
  ...auth, method: 'POST', body: { ...loteBase, ...body }
});

before(async () => {
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  mongoUri = replica.getUri('nevera_test');
  const cliente = await new MongoClient(mongoUri).connect();
  try {
    const password_hash = await protegerClave(clave);
    const db = cliente.db();
    await db.collection('usuarios').insertMany([idAdmin, idAdminLocal, idAvisos, sesionLegada.id].map(id => {
      const { nombre, email } = datosCuenta(id);
      return { _id: id, nombre, email, password_hash };
    }));
    const credencial = huella(password_hash);
    await db.collection('sesiones').insertMany([
      { _id: huella(sesionLegada.web), usuario: sesionLegada.id, credencial, web: true, vence: new Date(Date.now() + 480_000) },
      { _id: huella(sesionLegada.bearer), usuario: sesionLegada.id, credencial, web: false, vence: new Date(Date.now() + 3_600_000) }
    ]);
    const manana = new Date(Date.now() + 19 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const fecha_vencimiento = new Date(manana + 'T20:00:00-05:00');
    await db.collection('inventario').insertMany(Object.entries(lotesAvisados).map(([nevera_id, _id]) => ({
      ...loteBase, _id, user_nombre: idAvisos, nevera_id, fecha_vencimiento, estado: 'EN_NEVERA'
    })));
    const fechaVieja = new Date(fecha_vencimiento.getTime() - 3_600_000);
    await db.collection('notificaciones').insertOne({
      user_nombre: idAvisos, nevera_id: 'editar', inventario_id: lotesAvisados.editar, tipo: 'VENCIMIENTO',
      fecha: new Date(), fecha_vencimiento: fechaVieja, leida: false,
      mensaje: 'Leche vence el ' + fechaVieja.toISOString() + ' en la nevera editar.'
    });
  } finally {
    await cliente.close();
  }
  const gmail = 'data:text/javascript,' + encodeURIComponent('(' + simularGmail.toString() + ')()');
  servidor = spawn(process.execPath, ['--import', gmail, 'server.js'], {
    cwd: raiz,
    env: {
      ...process.env, PORT: '0', MONGO_URI: mongoUri, CATALOG_ADMIN_IDS: [idAdmin, idAdminLocal, idAdminReservado].join(','),
      GMAIL_USER: 'nevera@example.test', GMAIL_APP_PASSWORD: '', GMAIL_CLIENT_ID: 'cliente-de-prueba',
      GMAIL_CLIENT_SECRET: 'secreto-de-prueba', GMAIL_REFRESH_TOKEN: 'actualizacion-de-prueba',
      PASSWORD_RESET_URL: '', RENDER_EXTERNAL_URL: 'https://nevera-prueba.example', DOTENV_CONFIG_QUIET: 'true'
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  servidor.on('message', mensaje => {
    if (mensaje.raw) correosEnviados.push(mensaje.raw);
    if (mensaje.eventoGmail) eventosGmail.push(mensaje.eventoGmail);
  });
  for (const stream of [servidor.stdout, servidor.stderr]) {
    stream.on('data', chunk => { salida += chunk; });
  }
  const inicio = await esperar(() => /Servidor corriendo en http:\/\/localhost:(\d+)/.exec(salida), 'La API de prueba no inició.');
  baseUrl = 'http://127.0.0.1:' + inicio[1];
  await esperar(async () => (await api('/salud')).status === 200, 'MongoDB de prueba no está disponible.');

  for (const id of [idUsuario, idCuenta, idBorrado]) {
    await correcto('/usuarios', { method: 'POST', body: datosCuenta(id) });
  }
  admin = await sesion(idAdmin);
  usuario = await sesion(idUsuario);
  for (const [recurso, body] of catalogo) {
    await correcto('/' + recurso, { ...admin, method: 'POST', body });
  }
}, { timeout: 180_000 });

after(async () => {
  await detenerProceso(servidor);
  await replica?.stop();
});

test('El servidor publica la aplicación y los archivos de Swagger desde sus carpetas', async () => {
  const archivos = [
    ['/app/', 'frontend/dist/index.html'],
    ['/swagger-assets/validacion-tiempo-real.js', 'backend/swagger/assets/validacion-tiempo-real.js'],
    ['/swagger-assets/validacion-tiempo-real.css', 'backend/swagger/assets/validacion-tiempo-real.css']
  ];
  for (const [ruta, archivo] of archivos) {
    const respuesta = await fetch(baseUrl + ruta);
    assert.equal(respuesta.status, 200, ruta);
    assert.equal(await respuesta.text(), await readFile(path.join(raiz, archivo), 'utf8'));
  }
  const swagger = await fetch(baseUrl + '/api-docs/swagger-ui-init.js');
  assert.equal(swagger.status, 200);
  assert.match(await swagger.text(), /\/api\/notificaciones\/resumen/);
  const pagina = await fetch(baseUrl + '/app/');
  assert.match(pagina.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(pagina.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(pagina.headers.get('x-powered-by'), null);
  for (const ruta of ['/admin', '/app/admin']) {
    assert.equal((await fetch(baseUrl + ruta)).status, 404);
  }
});

test('El ingreso cuenta los fallos por cuenta y deja un intento tras cinco minutos completos', async t => {
  const reservado = await api('/usuarios', { method: 'POST', body: datosCuenta(idAdminReservado) });
  assert.equal(reservado.status, 403);
  assert.match(reservado.message, /reservado/);

  const id = '7018';
  const cuenta = datosCuenta(id);
  await correcto('/usuarios', { method: 'POST', body: { ...cuenta, catalogo_admin: true, role: 'admin' } });
  const sesionNormal = await sesion(id);
  const perfil = await correcto('/usuarios/me', sesionNormal);
  assert.equal(perfil.catalogo_admin, false);
  await cerrarSesion(sesionNormal);
  const entrar = body => api('/usuarios/login', { method: 'POST', body });
  const fallar = intento => {
    const identificador = intento % 2 ? { id } : { nombre: cuenta.nombre };
    return entrar({ ...identificador, password: otraClave });
  };
  for (let intento = 0; intento < 4; intento++) {
    assert.equal((await fallar(intento)).status, 401);
  }
  const valido = await entrar({ id, password: clave });
  assert.equal(valido.status, 200);
  await cerrarSesion({ token: valido.data.token });

  const cliente = await new MongoClient(mongoUri).connect();
  t.after(() => cliente.close());
  const { intentos, filtro } = await contadorIngreso(cliente.db(), id);
  assert.equal((await fallar(0)).status, 401);
  await intentos.updateOne(filtro, { $set: { vence: new Date(Date.now() + 30_000) } });
  const simultaneos = await Promise.all(Array.from({ length: 5 }, (_, intento) => fallar(intento)));
  assert.deepEqual(simultaneos.map(intento => intento.status).sort(), [401, 401, 401, 429, 429]);
  assert.ok(simultaneos.some(intento => intento.status === 429 && /intentos fallidos/.test(intento.message)));
  const limitado = await entrar({ id, password: clave });
  assert.equal(limitado.status, 429);
  assert.equal(limitado.data.ultimo_intento, true);
  assert.ok(Number(limitado.retryAfter) >= 297 && Number(limitado.retryAfter) <= 300);
  assert.equal((await intentos.findOne(filtro)).vence, undefined);

  await intentos.updateOne(filtro, { $set: { bloqueado_hasta: new Date(0) } });
  assert.equal((await entrar({ nombre: cuenta.nombre, password: clave })).status, 200);
  assert.equal(await intentos.findOne(filtro), null);
});

test('Los cuerpos incompletos de productos, patrones y notificaciones devuelven 400', async () => {
  for (const [ruta, campo] of [['productos', 'nombre'], ['patrones_predictivos', '_id'], ['notificaciones', 'mensaje']]) {
    for (const body of [undefined, {}, []]) {
      const respuesta = await api('/' + ruta, { ...admin, method: 'POST', body });
      assert.equal(respuesta.status, 400, ruta);
      assert.equal(respuesta.success, false);
      if (body && !Array.isArray(body)) assert.ok(respuesta.message.includes(campo));
    }
  }
});

test('El resumen pagina avisos vigentes y conserva el historial al editar o eliminar los lotes', async () => {
  const auth = await sesion(idAvisos);
  const inicial = await esperar(async () => {
    const resumen = await correcto('/notificaciones/resumen', auth);
    return resumen.sin_leer === 2 ? resumen : null;
  }, 'La revisión inicial no generó los dos avisos vigentes.');
  assert.equal(inicial.recientes.length, 3);
  const anterior = inicial.recientes.find(item => item.desactualizada);
  assert.ok(anterior);
  assert.match(anterior.mensaje, /19:00/);
  assert.ok(inicial.recientes.filter(item => !item.desactualizada).every(item => /20:00.*hora de Colombia/.test(item.mensaje)));
  assert.deepEqual(await correcto('/notificaciones/resumen?revision=' + inicial.revision, auth),
    { revision: inicial.revision, sin_leer: 2 });
  const pagina = await api('/notificaciones?pagina=1&limite=1&lectura=sin_leer&tipo=VENCIMIENTO', auth);
  assert.equal(pagina.status, 200);
  assert.equal(pagina.data.length, 1);
  assert.equal(pagina.data[0].desactualizada, false);
  assert.deepEqual(pagina.paginacion, { pagina: 1, limite: 1, hay_siguiente: true });

  const editar = '/inventario/' + lotesAvisados.editar;
  await correcto(editar, { ...auth, method: 'PUT', body: { cantidad: 2 } });
  assert.equal((await correcto('/notificaciones/resumen', auth)).revision, inicial.revision);
  const fecha_vencimiento = new Date(Date.now() + 4 * 86_400_000).toISOString();
  await correcto(editar, { ...auth, method: 'PUT', body: { fecha_vencimiento } });
  const trasEditar = await correcto('/notificaciones/resumen?revision=' + inicial.revision, auth);
  assert.equal(trasEditar.sin_leer, 1);
  assert.equal(trasEditar.revision, inicial.revision + 1);
  assert.equal(trasEditar.recientes.filter(item => item.desactualizada).length, 2);

  await correcto('/inventario/' + lotesAvisados.eliminar, { ...auth, method: 'DELETE' });
  const trasEliminar = await correcto('/notificaciones/resumen', auth);
  assert.equal(trasEliminar.sin_leer, 0);
  assert.ok(trasEliminar.recientes.every(item => item.desactualizada));
  assert.equal((await correcto('/notificaciones', auth)).length, 3);
  assert.deepEqual(await correcto('/notificaciones?lectura=sin_leer', auth), []);
  await cerrarSesion(auth);
});

test('Un alta simultánea acumula la cantidad y una edición duplicada se revierte', async () => {
  const fecha = '2032-02-29T10:00:00-05:00';
  const datos = { nevera_id: 'ACUMULACION', fecha_vencimiento: fecha };
  const [primero, acumulado] = await Promise.all([
    agregar(datos), agregar({ ...datos, cantidad: 2, fecha_vencimiento: '2032-02-29T15:00:00Z' })
  ]);
  assert.equal(primero._id, acumulado._id);
  assert.deepEqual([primero.version, acumulado.version].sort(), [0, 1]);
  assert.equal((await correcto('/inventario/' + primero._id, usuario)).cantidad, 3);

  const otro = await agregar({ ...datos, fecha_vencimiento: '2032-03-01T15:00:00Z' });
  const ruta = '/inventario/' + otro._id;
  const duplicado = await api(ruta, {
    ...usuario, method: 'PUT', body: { fecha_vencimiento: fecha, cantidad: 8 }
  });
  assert.equal(duplicado.status, 409);
  assert.equal(duplicado.success, false);
  assert.equal(duplicado.data.inventario_id, primero._id);
  assert.equal((await correcto(ruta, usuario)).fecha_vencimiento, otro.fecha_vencimiento);
  assert.equal((await correcto(ruta, usuario)).cantidad, otro.cantidad);

  const editado = await correcto(ruta, { ...usuario, method: 'PUT', body: { cantidad: 5 } });
  assert.equal(editado.cantidad, 5);
  const historial = await correcto('/historial_inventario', usuario);
  assert.deepEqual(historial.filter(registro => registro.inventario_id === otro._id).map(registro => registro.accion),
    ['ACTUALIZADO', 'CREADO']);
});

test('Los lotes distinguen ingredientes y respetan registros anteriores sin campos opcionales', async () => {
  const datos = { nevera_id: 'LEGADO', user_nombre: idUsuario, estado: 'EN_NEVERA', ...loteBase };
  const cliente = await new MongoClient(mongoUri).connect();
  try {
    const { insertedId } = await cliente.db().collection('inventario').insertOne(datos);
    assert.equal((await correcto('/inventario/' + insertedId, usuario)).version, 0);
    const conIngrediente = await agregar({ nevera_id: datos.nevera_id, ingrediente_nombre: 'Leche' });
    const sinIngrediente = await agregar({ nevera_id: datos.nevera_id });
    assert.equal(sinIngrediente._id, String(insertedId));
    assert.equal(sinIngrediente.cantidad, 2);
    assert.equal(sinIngrediente.version, 1);
    const conflicto = await api('/inventario/' + conIngrediente._id, {
      ...usuario, method: 'PUT', body: { ingrediente_nombre: null }
    });
    assert.equal(conflicto.status, 409);
    assert.equal(conflicto.data.inventario_id, sinIngrediente._id);
  } finally {
    await cliente.close();
  }
});

test('Los avisos se generan al guardar lotes próximos a vencer y se mantienen sin duplicados', async () => {
  const id = '7036';
  await correcto('/usuarios', { method: 'POST', body: datosCuenta(id) });
  const auth = await sesion(id);
  const fecha = new Date(Date.now() + 15 * 60_000).toISOString();
  const agregarProximo = (nevera_id, cantidad = 1) => agregar({ nevera_id, cantidad, fecha_vencimiento: fecha }, auth);
  const avisos = () => correcto('/notificaciones?tipo=VENCIMIENTO', auth);

  const lote = await agregarProximo('AVISO-INMEDIATO');
  const [primero] = await avisos();
  assert.equal(primero.inventario_id, lote._id);
  assert.equal(primero.fecha_vencimiento, fecha);
  assert.ok(!Object.hasOwn(lote, 'alerta_vencimiento_generada'));
  await Promise.all([agregarProximo(lote.nevera_id), agregarProximo(lote.nevera_id)]);
  assert.deepEqual((await avisos()).map(aviso => aviso._id), [primero._id]);

  const sinStock = await agregarProximo('AVISO-AL-ACUMULAR', 0);
  const masTarde = await agregar({
    nevera_id: 'AVISO-AL-EDITAR',
    fecha_vencimiento: new Date(Date.now() + 4 * 86_400_000).toISOString()
  }, auth);
  assert.equal((await avisos()).length, 1);
  assert.equal((await agregarProximo(sinStock.nevera_id))._id, sinStock._id);
  const editar = (item, body) => correcto('/inventario/' + item._id, { ...auth, method: 'PUT', body });
  await editar(masTarde, { fecha_vencimiento: fecha });
  const vigentes = await avisos();
  assert.equal(vigentes.length, 3);
  assert.ok(vigentes.some(aviso => aviso.inventario_id === sinStock._id));
  assert.ok(vigentes.some(aviso => aviso.inventario_id === masTarde._id));

  await editar(lote, { estado: 'CONSUMIDO' });
  assert.deepEqual((await avisos()).filter(aviso => aviso.desactualizada).map(aviso => aviso._id), [primero._id]);
  await cerrarSesion(auth);
});

test('El control de versión protege contra ediciones simultáneas y respeta los clientes anteriores', async () => {
  const creado = await agregar({ nevera_id: 'VERSION' });
  assert.equal(creado.version, 0);
  const ruta = '/inventario/' + creado._id;
  const actualizar = body => api(ruta, { ...usuario, method: 'PUT', body });

  const cambios = await Promise.all([
    actualizar({ version: 0, cantidad: 3 }),
    actualizar({ version: 0, cantidad: 5 })
  ]);
  assert.deepEqual(cambios.map(cambio => cambio.status).sort(), [200, 409]);
  const guardado = cambios.find(cambio => cambio.status === 200).data;
  assert.equal(guardado.version, 1);
  const conflicto = cambios.find(cambio => cambio.status === 409);
  assert.deepEqual(conflicto.data, { conflicto: 'VERSION', inventario_id: creado._id });
  const sinVersion = await actualizar({ estado: 'CONSUMIDO' });
  assert.equal(sinVersion.status, 200);
  assert.equal(sinVersion.data.version, 2);
  assert.equal(sinVersion.data.cantidad, guardado.cantidad);
  assert.equal((await actualizar({ version: 1, cantidad: 8 })).status, 409);
  assert.equal((await correcto(ruta, usuario)).estado, 'CONSUMIDO');
  assert.equal((await actualizar({ version: null, cantidad: 9 })).status, 400);
});

test('Inventario responde 400 por estados o fechas inválidos y solicitudes incompletas', async () => {
  const creado = await agregar({ cantidad: 0, fecha_vencimiento: '2032-02-29T12:00-05:00' });
  assert.equal(creado.nevera_id, 'NEVERA-01');
  assert.equal(creado.cantidad, 0);
  assert.equal(creado.fecha_vencimiento, '2032-02-29T17:00:00.000Z');
  const ruta = '/inventario/' + creado._id;
  const post = { ...usuario, method: 'POST' };
  const put = { ...usuario, method: 'PUT' };

  for (const body of [undefined, {}, [], { producto_id: 'LECHE', cantidad: 2 }]) {
    const respuesta = await api('/inventario', { ...post, body });
    assert.equal(respuesta.status, 400, respuesta.message);
  }
  for (const body of [undefined, {}, [], { user_nombre: idUsuario }]) {
    assert.equal((await api(ruta, { ...put, body })).status, 400);
  }
  for (const estado of [null, '', 'incorrecto']) {
    assert.equal((await api('/inventario', { ...post, body: { ...loteBase, estado } })).status, 400);
    assert.equal((await api(ruta, { ...put, body: { estado } })).status, 400);
  }
  for (const fecha_vencimiento of ['2032-02-30T12:00:00Z', '2031-02-29T12:00:00Z', '2032-04-31T09:00:00-05:00',
    '2032-05-01T24:00:00Z', '2032-05-01T12:00:00', '2032-05-01T12:00:00-05:75']) {
    const respuesta = await api('/inventario', { ...post, body: { ...loteBase, fecha_vencimiento } });
    assert.equal(respuesta.status, 400, fecha_vencimiento);
    assert.match(respuesta.message, /fecha_vencimiento/);
  }
  assert.equal((await api(ruta, { ...put, body: { fecha_vencimiento: '2032-02-30T12:00:00Z' } })).status, 400);
  assert.equal((await api('/inventario?vence_hasta=2032-02-30T12:00:00Z', usuario)).status, 400);
  assert.equal((await api('/inventario?vence_desde=2032-02-29T17:00:00Z&vence_hasta=2032-02-28T17:00:00Z', usuario)).status, 400);
  const dia = await correcto('/inventario?nevera_id=NEVERA-01&vence_desde=2032-02-29T17:00:00Z&vence_hasta=2032-02-29T17:00:00Z', usuario);
  assert.deepEqual(dia.map(lote => lote._id), [creado._id]);
  assert.equal((await correcto(ruta, { ...put, body: { fecha_vencimiento: null } })).fecha_vencimiento, null);
});

test('La paginación respeta filtros y orden y conserva la respuesta de las consultas sin paginar', async () => {
  const url = '/inventario?nevera_id=PAGINACION&estado=EN_NEVERA&orden=vencimiento';
  const sinFecha = await agregar({ nevera_id: 'PAGINACION' });
  const conFecha = await agregar({ nevera_id: 'PAGINACION', fecha_vencimiento: '2032-03-01T15:00:00Z' });
  await agregar({ nevera_id: 'PAGINACION', estado: 'CONSUMIDO' });
  await agregar({ nevera_id: 'PAGINACION' }, admin);
  const lista = await api(url, usuario);
  assert.deepEqual(lista.data.map(lote => lote._id), [conFecha._id, sinFecha._id]);
  assert.ok(!Object.hasOwn(lista, 'paginacion'));
  const primera = await api(url + '&limite=1', usuario);
  assert.deepEqual(primera.paginacion, { pagina: 1, limite: 1, hay_siguiente: true });
  assert.equal(primera.data[0]._id, conFecha._id);
  const ultima = await api(url + '&pagina=2&limite=1', usuario);
  assert.deepEqual(ultima.paginacion, { pagina: 2, limite: 1, hay_siguiente: false });
  assert.equal(ultima.data[0]._id, sinFecha._id);
  assert.equal((await api(url + '&pagina=0', usuario)).status, 400);
});

test('El alta de inventario admite desde hoy en Colombia y rechaza el día anterior', async () => {
  const inicioHoy = new Date(hoyEnColombia() + 'T00:00:00-05:00');
  const fechaAnterior = new Date(inicioHoy.getTime() - 1).toISOString();
  const datos = { ...loteBase, nevera_id: 'FECHAS-COLOMBIA' };
  const pasado = await api('/inventario', {
    ...usuario, method: 'POST', body: { ...datos, fecha_vencimiento: fechaAnterior }
  });
  assert.equal(pasado.status, 400);
  assert.match(pasado.message, /hoy en adelante.*Colombia/);

  const hoy = await agregar({ ...datos, fecha_vencimiento: inicioHoy.toISOString() });
  assert.equal(hoy.fecha_vencimiento, inicioHoy.toISOString());
  const sinFecha = await agregar({ ...datos, fecha_vencimiento: null });
  assert.equal(sinFecha.fecha_vencimiento, null);
  const editado = await correcto('/inventario/' + hoy._id, {
    ...usuario, method: 'PUT', body: { fecha_vencimiento: fechaAnterior }
  });
  assert.equal(editado.fecha_vencimiento, fechaAnterior);
});

test('Dos inicios simultáneos de la misma cuenta solo crean una sesión entre web y Bearer', async () => {
  const id = '7011';
  await correcto('/usuarios', { method: 'POST', body: datosCuenta(id) });
  const iniciar = (sesion_web, auth = {}) => api('/usuarios/login', {
    ...auth, method: 'POST', body: { id, password: clave, sesion_web }
  });
  const intentos = await Promise.all([iniciar(true), iniciar(false)]);
  assert.deepEqual(intentos.map(intento => intento.status).sort(), [200, 409]);
  assert.match(intentos.find(intento => intento.status === 409).message, /sesión activa/);
  const abierto = intentos.find(intento => intento.status === 200);
  const auth = abierto.cookie ? { cookie: abierto.cookie } : { token: abierto.data.token };
  assert.equal((await correcto('/usuarios/me', auth))._id, id);
  await cerrarSesion(auth);
  assert.equal((await api('/usuarios/me', auth)).status, 401);

  const web = await sesion(id, true);
  const mismoNavegador = await iniciar(true, web);
  assert.equal(mismoNavegador.status, 200);
  assert.equal(mismoNavegador.cookie, web.cookie);
  assert.equal((await iniciar(true)).status, 409);
  assert.equal((await iniciar(false)).status, 409);
  await cerrarSesion(web);
  const bearer = await sesion(id);
  assert.equal((await correcto('/usuarios/me', bearer))._id, id);
});

test('Las sesiones anteriores conservan una sola sesión y los registros vencidos liberan el acceso', async () => {
  const { id, web: primera, bearer: segunda } = sesionLegada;
  const cliente = await new MongoClient(mongoUri).connect();
  try {
    const sesiones = cliente.db().collection('sesiones');
    const anteriores = await sesiones.find({ usuario: id }).toArray();
    assert.equal(anteriores.length, 2);
    for (const anterior of anteriores) {
      const restante = anterior.actividad_hasta.getTime() - Date.now();
      assert.ok(restante > 0 && restante <= inactividadMs);
    }
    assert.equal((await api('/usuarios/me', { cookie: 'nevera_session=' + primera })).status, 401);
    assert.equal((await correcto('/usuarios/me', { token: segunda }))._id, id);
    await cerrarSesion({ token: segunda });
    assert.equal((await api('/usuarios/me', { token: primera })).status, 401);
    const nueva = await sesion(id);
    await sesiones.updateOne({ _id: huella(nueva.token) }, { $set: { vence: new Date(Date.now() - 1000) } });
    const posterior = await sesion(id, true);
    assert.equal((await correcto('/usuarios/me', posterior))._id, id);
    assert.equal((await api('/usuarios/me', nueva)).status, 401);
  } finally {
    await cliente.close();
  }
});

test('La inactividad vence en siete minutos, ignora consultas web automáticas y libera la cuenta', async t => {
  const id = '7014';
  await correcto('/usuarios', { method: 'POST', body: datosCuenta(id) });
  const inicio = await api('/usuarios/login', { method: 'POST', body: { id, password: clave, sesion_web: true } });
  assert.equal(inicio.status, 200);
  assert.ok(inicio.data.inactividad_restante_ms <= inactividadMs && inicio.data.inactividad_restante_ms > 419_000);
  const web = { cookie: inicio.cookie };
  const cliente = await new MongoClient(mongoUri).connect();
  t.after(() => cliente.close());
  const sesiones = cliente.db().collection('sesiones');
  const sesionWeb = { _id: huella(inicio.cookie.split('=')[1]) };
  const anterior = new Date(Date.now() + 20_000);
  await sesiones.updateOne(sesionWeb, { $set: { actividad_hasta: anterior } });

  const perfil = await api('/usuarios/me', web);
  assert.equal(perfil.data._id, id);
  assert.ok(perfil.inactividad_restante_ms <= 20_000);
  await correcto('/notificaciones', web);
  const registrar = opciones => api('/usuarios/actividad', { ...web, method: 'POST', ...opciones });
  assert.equal((await registrar({ origin: 'https://otro.example' })).status, 403);
  assert.equal((await registrar({ body: { transcurrido_ms: inactividadMs } })).status, 400);
  assert.deepEqual((await sesiones.findOne(sesionWeb)).actividad_hasta, anterior);

  const actividad = await registrar({ body: { transcurrido_ms: 2000 } });
  assert.equal(actividad.status, 200);
  assert.ok(actividad.data.inactividad_restante_ms <= 418_000 && actividad.data.inactividad_restante_ms > 417_000);

  await sesiones.updateOne(sesionWeb, { $set: { actividad_hasta: new Date(Date.now() - 1) } });
  assert.equal((await registrar({})).status, 401);
  assert.equal((await api('/notificaciones', web)).status, 401);

  const bearer = await sesion(id);
  const sesionBearer = { _id: huella(bearer.token) };
  const limite = new Date(Date.now() + 240_000);
  await sesiones.updateOne(sesionBearer, { $set: { actividad_hasta: anterior, vence: limite } });
  const perfilBearer = await api('/usuarios/me', bearer);
  assert.equal(perfilBearer.data._id, id);
  assert.ok(perfilBearer.inactividad_restante_ms <= 240_000 && perfilBearer.inactividad_restante_ms > 239_000);
  const tokenRenovado = await sesiones.findOne(sesionBearer);
  assert.ok(tokenRenovado.actividad_hasta > anterior);
  assert.deepEqual(tokenRenovado.vence, limite);
  await sesiones.updateOne(sesionBearer, { $set: { actividad_hasta: new Date(Date.now() - 1) } });
  assert.equal((await api('/usuarios/me', bearer)).status, 401);
  assert.ok((await sesion(id, true)).cookie);
});

test('Cambiar correo o contraseña requiere la contraseña actual con Bearer y con cookie', async () => {
  const bearer = await sesion(idCuenta);
  const ruta = '/usuarios/' + idCuenta;
  const email = 'actualizado@nevera.test';
  async function exigirClaveActual(auth) {
    for (const cambio of [{ email: 'sin-confirmar@nevera.test' }, { password: otraClave }]) {
      const respuesta = await api(ruta, { ...auth, method: 'PUT', body: cambio });
      assert.equal(respuesta.status, 403);
      assert.match(respuesta.message, /contraseña actual/);
    }
  }
  await exigirClaveActual(bearer);
  assert.equal((await api(ruta, {
    ...bearer, method: 'PUT', body: { email, password_actual: 'NoEsLaCorrecta!' }
  })).status, 403);
  const perfil = await correcto(ruta, {
    ...bearer, method: 'PUT', body: { nombre: 'Perfil editado', email: datosCuenta(idCuenta).email }
  });
  assert.equal(perfil.nombre, 'Perfil editado');
  const actualizado = await correcto(ruta, {
    ...bearer, method: 'PUT', body: { email, password_actual: clave }
  });
  assert.equal(actualizado.email, email);
  await cerrarSesion(bearer);
  const web = await sesion(idCuenta, true);
  await exigirClaveActual(web);
  await correcto(ruta, { ...web, method: 'PUT', body: { password: otraClave, password_actual: clave } });
  for (const auth of [bearer, web]) {
    assert.equal((await api('/usuarios/me', auth)).status, 401);
  }
  await correcto('/usuarios/login', { method: 'POST', body: { id: idCuenta, password: otraClave } });
});

test('Se aplican permisos, llaves foráneas y conservación de historial al borrar', async () => {
  const propietario = await sesion(idBorrado);
  const lote = await agregar({ ingrediente_nombre: 'Leche' }, propietario);
  for (const [recurso, body] of catalogo) {
    assert.equal((await api('/' + recurso)).status, 200);
    assert.equal((await api('/' + recurso, { ...usuario, method: 'POST', body })).status, 403);
    assert.equal((await api('/' + recurso + '/' + encodeURIComponent(body._id), { ...usuario, method: 'DELETE' })).status, 403);
  }
  const producto = await api('/productos/LECHE', { ...admin, method: 'DELETE' });
  assert.equal(producto.status, 409);
  assert.ok(producto.data.dependencias.some(dependencia => dependencia.coleccion === 'inventario'));
  const ajeno = await api('/inventario/' + lote._id, usuario);
  assert.equal(ajeno.status, 200);
  assert.equal(ajeno.success, false);
  assert.equal((await api('/inventario?user_nombre=' + idBorrado, usuario)).status, 403);
  assert.equal((await api('/usuarios/' + idBorrado, { ...usuario, method: 'DELETE' })).status, 403);

  const plan = await correcto('/meal_preps', {
    ...propietario, method: 'POST', body: {
      nombre_receta: 'Café con leche', ingrediente_nombre: 'Leche', patron: { frecuencia_compra_dias: 7 }
    }
  });
  const sugerencias = await correcto('/meal_preps/sugerencias', propietario);
  assert.equal(sugerencias[0].plan_id, plan._id);
  const aviso = await correcto('/notificaciones', {
    ...propietario, method: 'POST', body: { mensaje: 'Queda un litro de leche', tipo: 'STOCK_BAJO' }
  });
  const opcionBorrar = { ...propietario, method: 'DELETE' };
  const ruta = '/usuarios/' + idBorrado;
  const bloqueo = await api(ruta, opcionBorrar);
  assert.equal(bloqueo.status, 409);
  assert.deepEqual(bloqueo.data.dependencias.map(dependencia => dependencia.coleccion).sort(),
    ['inventario', 'notificaciones', 'patrones_predictivos']);
  assert.equal((await api('/patrones_predictivos/' + plan.patron_predictivo_id, opcionBorrar)).status, 409);
  await correcto('/notificaciones/' + aviso._id, opcionBorrar);
  await correcto('/meal_preps/' + plan._id, opcionBorrar);
  await correcto('/patrones_predictivos/' + plan.patron_predictivo_id, opcionBorrar);
  await correcto('/inventario/' + lote._id, opcionBorrar);
  await correcto(ruta, opcionBorrar);
  assert.equal((await api('/usuarios/me', propietario)).status, 401);
  const repetido = await api('/usuarios', { method: 'POST', body: datosCuenta(idBorrado) });
  assert.equal(repetido.success, false);
  assert.match(repetido.message, /no se puede reutilizar/);
  const cliente = await new MongoClient(mongoUri).connect();
  try {
    const historial = await cliente.db().collection('historial_inventario')
      .distinct('accion', { 'snapshot_datos.user_nombre': idBorrado });
    assert.deepEqual(historial.sort(), ['CREADO', 'ELIMINADO']);
  } finally {
    await cliente.close();
  }
});

async function abrirNavegador(t) {
  const navegador = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
  t.after(() => navegador.close());
  return navegador;
}

async function enviarLogin(pagina, id, direccion = baseUrl + '/app/') {
  pagina.setDefaultTimeout(8000);
  await pagina.goto(direccion);
  const formulario = pagina.locator('#auth');
  await formulario.locator('input[name=nombre]').fill(datosCuenta(id).nombre);
  await formulario.locator('input[name=password]').fill(clave);
  await formulario.getByRole('button', { name: 'Entrar', exact: true }).click();
}

async function entrar(pagina, id, direccion) {
  await enviarLogin(pagina, id, direccion);
  await pagina.locator('#dashboard').waitFor();
}

test('El login muestra la espera y el último intento. El código por correo desbloquea la cuenta', { timeout: 55_000 }, async t => {
  const cuenta = datosCuenta('7019');
  await correcto('/usuarios', { method: 'POST', body: cuenta });
  const sesionAnterior = await sesion(cuenta.id);
  const cliente = await new MongoClient(mongoUri).connect();
  t.after(() => cliente.close());
  const { intentos, filtro } = await contadorIngreso(cliente.db(), cuenta.id);
  const navegador = await abrirNavegador(t);
  const pagina = await navegador.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  pagina.setDefaultTimeout(8000);
  await pagina.clock.install();
  await pagina.goto(baseUrl + '/app/');
  const nombre = pagina.locator('#auth input[name=nombre]');
  const password = pagina.locator('#auth input[name=password]');
  const boton = pagina.locator('#auth-submit');
  const aviso = pagina.locator('#login-lock');
  const tiempo = aviso.getByRole('timer');
  await nombre.fill(cuenta.nombre);

  async function enviarClave(valor) {
    await pagina.waitForFunction(() => !document.getElementById('auth-submit').disabled);
    await password.fill(valor);
    const [respuesta] = await Promise.all([
      pagina.waitForResponse(response => response.url().endsWith('/api/usuarios/login')),
      boton.click()
    ]);
    return respuesta.status();
  }

  for (let intento = 1; intento <= 5; intento++) {
    assert.equal(await enviarClave(otraClave), intento === 5 ? 429 : 401);
  }
  await aviso.waitFor();
  assert.match(await tiempo.textContent(), /^\d+:[0-5]\d$/);
  assert.ok(await boton.isDisabled());

  await pagina.locator('#forgot-toggle').click();
  const recuperacion = pagina.locator('#forgot-form');
  await recuperacion.waitFor();
  await recuperacion.getByRole('button', { name: 'Volver al inicio de sesión' }).click();
  await aviso.waitFor();

  await nombre.fill(datosCuenta(idUsuario).nombre);
  assert.ok(await aviso.isHidden());
  assert.ok(await boton.isEnabled());
  await nombre.fill(cuenta.nombre);
  assert.ok(await boton.isDisabled());

  const anterior = await tiempo.textContent();
  await pagina.clock.fastForward(2000);
  assert.notEqual(await tiempo.textContent(), anterior);
  await pagina.clock.fastForward(300_000);
  assert.ok(await aviso.isHidden());
  const ultimo = pagina.locator('#login-last-attempt');
  await ultimo.waitFor();
  assert.equal(await enviarClave(clave), 429);
  await aviso.waitFor();

  await intentos.updateOne(filtro, { $set: { bloqueado_hasta: new Date(0) } });
  await pagina.clock.fastForward(300_000);
  await ultimo.waitFor();
  assert.equal(await enviarClave(otraClave), 423);
  await pagina.locator('#login-recovery-lock').waitFor();
  const bloqueada = await api('/usuarios/login', { method: 'POST', body: { id: cuenta.id, password: clave } });
  assert.equal(bloqueada.status, 423);
  assert.equal(bloqueada.retryAfter, null);
  assert.equal((await intentos.findOne(filtro)).requiere_recuperacion, true);
  const cambioDirecto = await api('/usuarios/' + cuenta.id, {
    ...sesionAnterior, method: 'PUT', body: { password_actual: clave, password: otraClave }
  });
  assert.equal(cambioDirecto.status, 423);

  await pagina.locator('#forgot-toggle').click();
  await recuperacion.locator('input[name=email]').fill(cuenta.email);
  await recuperacion.getByRole('button', { name: 'Enviar correo de recuperación' }).click();
  const formulario = pagina.locator('#reset-form');
  const codigoWeb = formulario.getByLabel('Código de 6 dígitos');
  await codigoWeb.waitFor();
  await formulario.getByRole('button', { name: 'Volver al inicio de sesión' }).click();
  await pagina.locator('#forgot-toggle').click();
  await recuperacion.getByRole('button', { name: 'Ya tengo un código' }).click();
  await codigoWeb.waitFor();
  assert.equal(await formulario.locator('input[name=email]').inputValue(), cuenta.email);
  const { token, codigo } = await leerCorreoRecuperacion(cuenta.email);
  const guardado = await cliente.db().collection('usuarios').findOne({ _id: cuenta.id });
  assert.match(guardado.recuperacion_codigo_hash, /^[a-f0-9]{64}$/);
  const casillas = formulario.locator('.recovery-code-digits > span');
  const incorrecto = codigo === '012345' ? '012346' : '012345';
  await codigoWeb.pressSequentially('0x');
  assert.deepEqual(await casillas.allTextContents(), ['0', '', '', '', '', '']);
  await codigoWeb.evaluate((input, texto) => {
    const datos = new DataTransfer();
    datos.setData('text/plain', texto);
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: datos, bubbles: true, cancelable: true }));
  }, '012 ' + incorrecto.slice(3));
  assert.equal(await codigoWeb.inputValue(), incorrecto);
  assert.deepEqual(await casillas.allTextContents(), [...incorrecto]);
  await formulario.locator('input[name=password]').fill(otraClave);
  await formulario.locator('input[name=confirmation]').fill(otraClave);
  const guardar = formulario.getByRole('button', { name: 'Guardar contraseña' });
  await guardar.click();
  await pagina.getByText(/El código es incorrecto/).waitFor();
  await codigoWeb.fill(codigo);
  await guardar.click();
  await pagina.getByText('Contraseña actualizada. Ya puedes iniciar sesión.', { exact: true }).waitFor();
  assert.equal(await intentos.findOne(filtro), null);
  assert.equal((await api('/usuarios/me', sesionAnterior)).status, 401);
  const repetir = campos => api('/usuarios/restablecer-contrasena', { method: 'POST', body: { ...campos, password: clave } });
  assert.equal((await repetir({ token })).status, 400);
  assert.equal((await repetir({ email: cuenta.email, codigo })).status, 400);
  assert.equal(await enviarClave(otraClave), 200);
  await pagina.locator('#dashboard').waitFor();
});

test('El registro muestra y valida cada requisito de contraseña mientras se escribe', { timeout: 35_000 }, async t => {
  const navegador = await abrirNavegador(t);
  const pagina = await navegador.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  pagina.setDefaultTimeout(8000);
  await pagina.goto(baseUrl + '/app/');
  const reglas = pagina.locator('#registration-password-rules');
  const claveRegistro = pagina.locator('#auth input[name=password]');
  const boton = pagina.locator('#auth-submit');
  const icono = regla => reglas.locator('[data-password-rule="' + regla + '"] .password-requirement-icon').textContent();
  await pagina.locator('#auth').waitFor();
  assert.ok(await reglas.isHidden());
  assert.ok(await boton.isEnabled());
  await pagina.getByRole('button', { name: 'Crear una cuenta', exact: true }).click();
  await reglas.waitFor();
  assert.equal(await reglas.locator('[data-password-rule="confirmation"]').count(), 0);
  assert.equal(await reglas.locator('[data-length-label]').textContent(), 'Al menos 12 caracteres');
  assert.ok(await boton.isDisabled());
  assert.equal(await icono('lowercase'), '×');

  await claveRegistro.pressSequentially('abcdefghi');
  assert.equal(await icono('lowercase'), '✓');
  assert.equal(await icono('length'), '×');
  await claveRegistro.pressSequentially('A1');
  assert.equal(await icono('uppercase'), '✓');
  assert.equal(await icono('number'), '✓');
  assert.equal(await icono('symbol'), '×');
  assert.ok(await boton.isDisabled());
  await claveRegistro.pressSequentially('!');
  assert.equal(await reglas.locator('.is-met').count(), 5);
  assert.equal(await icono('length'), '✓');
  assert.equal(await icono('symbol'), '✓');
  assert.ok(await boton.isEnabled());

  await claveRegistro.fill('A1!' + 'a'.repeat(1022));
  assert.equal(await icono('length'), '×');
  assert.equal(await reglas.locator('[data-length-label]').textContent(), 'La contraseña es demasiado larga');
  assert.ok(await boton.isDisabled());
  const password = 'abcdefghiA1!';
  const nombre = 'registro-requisitos';
  await claveRegistro.fill(password);
  await pagina.locator('#auth input[name=nombre]').fill(nombre);
  await pagina.locator('#auth input[name=email]').fill('registro-requisitos@example.test');
  await boton.click();
  await pagina.getByText('Cuenta creada. Ya puedes iniciar sesión.', { exact: true }).waitFor();
  assert.ok(await reglas.isHidden());
  await correcto('/usuarios/login', { method: 'POST', body: { nombre, password } });
});

test('El frontend pagina, muestra el lote en conflicto y conserva sesión y vista al recargar', { timeout: 60_000 }, async t => {
  const idInventarioWeb = '7007';
  await correcto('/usuarios', { method: 'POST', body: datosCuenta(idInventarioWeb) });
  const sesionInventario = await sesion(idInventarioWeb);
  let ultimo;
  for (let dia = 1; dia <= 21; dia++) {
    ultimo = await agregar({ nevera_id: 'PAGINAS-WEB', fecha_vencimiento: `2032-09-${String(dia).padStart(2, '0')}T12:00:00-05:00` }, sesionInventario);
  }
  await cerrarSesion(sesionInventario);
  const navegador = await abrirNavegador(t);
  const pagina = await navegador.newPage({ viewport: { width: 1200, height: 800 } });
  await entrar(pagina, idInventarioWeb);
  await pagina.getByRole('button', { name: 'Inventario', exact: true }).click();
  const formulario = pagina.locator('#lot-form');
  const vencimiento = formulario.locator('input[name=fecha_vencimiento]');
  await pagina.getByRole('button', { name: 'Agregar lote', exact: true }).click();
  await vencimiento.waitFor();
  assert.equal(await vencimiento.getAttribute('min'), hoyEnColombia() + 'T00:00');
  const ayer = new Date(Date.parse(hoyEnColombia() + 'T00:00:00Z') - 86_400_000).toISOString().slice(0, 10);
  await vencimiento.fill(ayer + 'T12:00');
  assert.ok(await vencimiento.evaluate(input => input.validity.rangeUnderflow));
  await formulario.getByRole('button', { name: 'Cancelar', exact: true }).click();
  const filtros = pagina.locator('#filters');
  const filas = pagina.locator('.inventory-table tbody tr');
  await filtros.locator('input[name=nevera_id]').fill('PAGINAS-WEB');
  await filtros.getByRole('button', { name: 'Filtrar' }).click();
  await filas.nth(19).waitFor();
  assert.equal(await pagina.locator('#inventory-page').textContent(), 'Página 1');
  assert.equal(await filas.count(), 20);
  await filtros.locator('input[name=busqueda]').fill('Filtro sin aplicar');
  await pagina.getByRole('button', { name: 'Siguiente' }).click();
  await pagina.getByText('Página 2', { exact: true }).waitFor();
  assert.equal(await filas.count(), 1);
  assert.ok(await pagina.getByRole('button', { name: 'Siguiente' }).isDisabled());
  await filas.first().getByRole('button', { name: 'Editar', exact: true }).click();
  await vencimiento.waitFor();
  assert.equal(await vencimiento.evaluate(input => input.min), '');
  await vencimiento.fill('2032-09-01T12:00');
  await formulario.getByRole('button', { name: 'Guardar', exact: true }).click();
  await formulario.locator('#lot-error').waitFor();
  assert.match(await formulario.locator('#lot-error').textContent(), /Ya existe un lote/);
  await formulario.getByRole('button', { name: 'Ver lote existente' }).click();
  await pagina.locator('#detail-dialog[open]').waitFor();
  assert.equal(await pagina.locator('#detail-title').textContent(), 'Leche de prueba');
  await pagina.keyboard.press('Escape');
  await pagina.locator('#detail-dialog').waitFor({ state: 'hidden' });

  await filas.first().getByRole('button', { name: 'Editar', exact: true }).click();
  const cantidad = formulario.locator('input[name=cantidad]');
  await cantidad.waitFor();
  const cookie = (await pagina.context().cookies()).find(item => item.name === 'nevera_session');
  assert.ok(cookie);
  const web = { cookie: `${cookie.name}=${cookie.value}` };
  const ruta = '/inventario/' + ultimo._id;
  await correcto(ruta, { ...web, method: 'PUT', body: { cantidad: 9 } });
  await cantidad.fill('5');
  const solicitud = pagina.waitForRequest(request => request.method() === 'PUT' && request.url().endsWith('/api' + ruta));
  await formulario.getByRole('button', { name: 'Guardar', exact: true }).click();
  assert.deepEqual((await solicitud).postDataJSON(), { cantidad: 5, version: 0 });
  const recargar = formulario.getByRole('button', { name: 'Recargar lote', exact: true });
  await recargar.click();
  await cantidad.waitFor();
  assert.equal(await cantidad.inputValue(), '9');
  assert.equal((await correcto(ruta, web)).cantidad, 9);
  await formulario.getByRole('button', { name: 'Cancelar', exact: true }).click();

  const esperarPerfil = Promise.withResolvers();
  await pagina.route('**/api/usuarios/me', async route => {
    await esperarPerfil.promise;
    await route.continue();
  });
  try {
    await pagina.reload({ waitUntil: 'domcontentloaded' });
    await pagina.locator('#session-check').waitFor();
    assert.ok(await pagina.locator('#login').isHidden());
  } finally {
    esperarPerfil.resolve();
  }
  await pagina.getByRole('heading', { name: 'Inventario', exact: true }).waitFor();
  await pagina.locator('.inventory-table').waitFor();
  assert.equal(new URL(pagina.url()).searchParams.get('vista'), 'inventory');
  assert.ok(await pagina.locator('#login').isHidden());
  await pagina.setViewportSize({ width: 844, height: 390 });
  assert.ok(await pagina.locator('#mobile-menu-toggle').isHidden());
  assert.ok(await pagina.locator('#navigation').isVisible());
  await pagina.getByRole('button', { name: 'Cerrar sesión' }).click();
  await pagina.locator('#login').waitFor();
});

test('Un segundo navegador muestra el bloqueo hasta que el primero cierra sesión', { timeout: 40_000 }, async t => {
  const id = '7013';
  await correcto('/usuarios', { method: 'POST', body: datosCuenta(id) });
  const navegador = await abrirNavegador(t);
  const primero = await navegador.newPage();
  const segundo = await navegador.newPage();
  await entrar(primero, id);
  await enviarLogin(segundo, id);
  await segundo.getByText(/cuenta ya tiene una sesión activa/).waitFor();
  assert.ok(await segundo.locator('#dashboard').isHidden());
  await primero.reload();
  await primero.locator('#dashboard').waitFor();
  await primero.getByRole('button', { name: 'Cerrar sesión' }).click();
  await primero.locator('#login').waitFor();
  await entrar(segundo, id);
});

test('La inactividad cierra la vista tras siete minutos y usar el teclado reinicia el plazo', { timeout: 35_000 }, async t => {
  const id = '7015';
  await correcto('/usuarios', { method: 'POST', body: datosCuenta(id) });
  const navegador = await abrirNavegador(t);
  const pagina = await navegador.newPage();
  await pagina.clock.install();
  await entrar(pagina, id);
  await pagina.getByText('Avisos sin leer', { exact: true }).waitFor();

  const cookie = (await pagina.context().cookies()).find(item => item.name === 'nevera_session');
  assert.ok(cookie);
  const cliente = await new MongoClient(mongoUri).connect();
  t.after(() => cliente.close());
  const sesiones = cliente.db().collection('sesiones');
  const filtro = { _id: huella(cookie.value) };
  const antes = await sesiones.findOne(filtro);
  const aviso = pagina.waitForResponse('**/api/notificaciones/resumen*');
  await pagina.clock.fastForward(60_000);
  assert.equal((await aviso).status(), 200);
  assert.deepEqual((await sesiones.findOne(filtro)).actividad_hasta, antes.actividad_hasta);

  const actividad = pagina.waitForResponse('**/api/usuarios/actividad');
  await pagina.keyboard.press('Tab');
  assert.equal((await actividad).status(), 200);
  assert.ok((await sesiones.findOne(filtro)).actividad_hasta > antes.actividad_hasta);

  await pagina.clock.fastForward(inactividadMs - 2_000);
  assert.ok(await pagina.locator('#dashboard').isVisible());
  await sesiones.updateOne(filtro, { $set: { actividad_hasta: new Date(Date.now() - 1) } });
  await pagina.clock.fastForward(3_000);
  await pagina.getByText(/Tu sesión se cerró tras 7 minutos de inactividad/).waitFor();
  assert.ok(await pagina.locator('#login').isVisible());
  assert.ok(await pagina.locator('#dashboard').isHidden());
  await entrar(await navegador.newPage(), id);
});

test('El menú táctil horizontal funciona e Inicio sigue disponible cuando fallan los avisos', { timeout: 35_000 }, async t => {
  const idMovil = '7008';
  await correcto('/usuarios', { method: 'POST', body: datosCuenta(idMovil) });
  const navegador = await abrirNavegador(t);
  const pagina = await navegador.newPage({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });
  const peticiones = new Set();
  pagina.on('request', solicitud => peticiones.add(new URL(solicitud.url()).pathname));
  const responderAvisos = Promise.withResolvers();
  await pagina.route('**/api/notificaciones/resumen*', async route => {
    await responderAvisos.promise;
    await route.fulfill({ status: 503, json: { success: false, message: 'Avisos no disponibles' } });
  });
  try {
    await entrar(pagina, idMovil);
    await pagina.getByText('Lotes en nevera', { exact: true }).waitFor();
    await pagina.getByText('Consultando avisos…', { exact: true }).waitFor();
  } finally {
    responderAvisos.resolve();
  }
  await pagina.getByText('Avisos no disponibles', { exact: true }).waitFor();
  assert.ok(await pagina.getByText('Lotes en nevera', { exact: true }).isVisible());
  assert.ok(peticiones.has('/api/inventario/resumen'));
  assert.equal(peticiones.has('/api/inventario') || peticiones.has('/api/productos'), false);
  await pagina.getByRole('button', { name: 'Abrir menú' }).click();
  const menu = pagina.getByRole('dialog', { name: 'Menú' });
  assert.ok(await menu.isVisible());
  await menu.getByRole('button', { name: 'Inventario', exact: true }).click();
  await menu.waitFor({ state: 'hidden' });
  await pagina.getByRole('heading', { name: 'Inventario', exact: true }).waitFor();
});

test('La campana ofrece vista previa y la bandeja abierta se actualiza con sus filtros', { timeout: 45_000 }, async t => {
  const id = '7016';
  await correcto('/usuarios', { method: 'POST', body: datosCuenta(id) });
  const bearer = await sesion(id);
  const crearAviso = (auth, mensaje) => correcto('/notificaciones', {
    ...auth, method: 'POST', body: { mensaje, tipo: 'STOCK_BAJO' }
  });
  const inicial = await crearAviso(bearer, 'Primer aviso al ingresar');
  await cerrarSesion(bearer);
  const navegador = await abrirNavegador(t);
  const pagina = await navegador.newPage({ viewport: { width: 1200, height: 800 } });
  await pagina.addInitScript(() => {
    window.tonosNotificacion = 0;
    window.AudioContext = class extends window.AudioContext {
      createOscillator() {
        const note = super.createOscillator();
        const start = note.start.bind(note);
        note.start = time => {
          start(time);
          window.tonosNotificacion++;
        };
        return note;
      }
    };
  });
  await pagina.clock.install();
  await entrar(pagina, id);
  const toast = pagina.locator('#notification-toast');
  await toast.getByText(inicial.mensaje, { exact: true }).waitFor();
  await pagina.waitForFunction(() => window.tonosNotificacion === 2);
  await pagina.getByRole('button', { name: 'Abrir notificaciones, 1 sin leer', exact: true }).waitFor();

  const cookie = (await pagina.context().cookies()).find(item => item.name === 'nevera_session');
  assert.ok(cookie);
  const web = { cookie: `${cookie.name}=${cookie.value}` };
  const nuevo = await crearAviso(web, 'Aviso nuevo durante la sesión');
  await pagina.clock.fastForward(60_000);
  await toast.getByText(nuevo.mensaje, { exact: true }).waitFor();
  await pagina.waitForFunction(() => window.tonosNotificacion === 4);
  assert.equal(await pagina.locator('.metric-card').filter({ hasText: 'Avisos sin leer' }).locator('strong').textContent(), '2');
  const campanaConDos = pagina.getByRole('button', { name: 'Abrir notificaciones, 2 sin leer', exact: true });
  const vistaPrevia = pagina.getByRole('region', { name: 'Notificaciones recientes' });
  await campanaConDos.click();
  await vistaPrevia.getByText(nuevo.mensaje, { exact: true }).waitFor();
  assert.ok(await pagina.getByRole('heading', { name: 'Inicio', exact: true }).isVisible());
  await pagina.keyboard.press('Escape');
  await vistaPrevia.waitFor({ state: 'hidden' });
  await campanaConDos.click();
  await vistaPrevia.getByRole('button', { name: 'Ver notificaciones', exact: true }).click();
  const fila = pagina.locator('.feature-row').filter({ hasText: nuevo.mensaje });
  await fila.getByRole('button', { name: 'Marcar como leída', exact: true }).click();
  await pagina.getByRole('button', { name: 'Abrir notificaciones, 1 sin leer', exact: true }).waitFor();
  await fila.getByRole('button', { name: 'Marcar sin leer', exact: true }).click();
  await pagina.getByRole('button', { name: 'Abrir notificaciones, 2 sin leer', exact: true }).waitFor();
  assert.equal(await pagina.evaluate(() => window.tonosNotificacion), 4);
  await pagina.locator('select[name="lectura"]').selectOption('leidas');
  await pagina.getByText('No hay notificaciones para estos filtros.', { exact: true }).waitFor();
  await campanaConDos.click();
  await vistaPrevia.getByRole('button', { name: 'Ver notificaciones', exact: true }).click();
  await fila.waitFor();

  await pagina.locator('select[name="tipo"]').selectOption('STOCK_BAJO');
  await fila.waitFor();
  const enBandeja = await crearAviso(web, 'Aviso nuevo con la bandeja abierta');
  await pagina.clock.fastForward(60_000);
  await pagina.locator('.feature-row').filter({ hasText: enBandeja.mensaje }).waitFor();
  assert.equal(await pagina.locator('select[name="tipo"]').inputValue(), 'STOCK_BAJO');
  await pagina.waitForFunction(() => window.tonosNotificacion === 6);

  await pagina.setViewportSize({ width: 360, height: 800 });
  await pagina.goto(baseUrl + '/app/?vista=inventory');
  await pagina.getByRole('button', { name: 'Abrir notificaciones, 3 sin leer', exact: true }).waitFor();
  assert.ok(await toast.isHidden());
  assert.ok(await pagina.getByRole('button', { name: 'Abrir menú' }).isVisible());
  const alRegresar = await crearAviso(web, 'Aviso recibido antes de volver');
  await pagina.reload();
  await toast.getByText(alRegresar.mensaje, { exact: true }).waitFor();
  assert.equal(await pagina.evaluate(() => window.tonosNotificacion), 0);
  const campana = pagina.getByRole('button', { name: 'Abrir notificaciones, 4 sin leer', exact: true });
  const limites = await campana.boundingBox();
  assert.ok(limites && limites.x >= 0 && limites.x + limites.width <= 360);
  await campana.click();
  const mensajePrevia = vistaPrevia.getByRole('button', { name: new RegExp(alRegresar.mensaje) });
  await mensajePrevia.waitFor();
  const limitesPrevia = await vistaPrevia.boundingBox();
  assert.ok(limitesPrevia && limitesPrevia.x >= 0 && limitesPrevia.x + limitesPrevia.width <= 360);
  await mensajePrevia.click();
  await pagina.getByRole('heading', { name: alRegresar.mensaje, exact: true }).waitFor();
  await pagina.waitForFunction(() => window.tonosNotificacion === 2);
});

test('Mi cuenta requiere el nombre exacto y respeta el bloqueo por dependencias al eliminar', { timeout: 35_000 }, async t => {
  const idLibre = '7005';
  const idCuentaWeb = '7009';
  await correcto('/usuarios', { method: 'POST', body: datosCuenta(idLibre) });
  await correcto('/usuarios', { method: 'POST', body: datosCuenta(idCuentaWeb) });
  const propietario = await sesion(idCuentaWeb);
  await agregar({ nevera_id: 'CUENTA-WEB' }, propietario);
  await cerrarSesion(propietario);
  const navegador = await abrirNavegador(t);
  const pagina = await navegador.newPage({ viewport: { width: 1200, height: 800 } });
  const irACuenta = () => pagina.getByRole('button', { name: 'Mi cuenta', exact: true }).click();
  const abrirConfirmacion = () => pagina.getByRole('button', { name: 'Eliminar mi cuenta', exact: true }).click();
  const dialogo = pagina.getByRole('dialog', { name: '¿Eliminar tu cuenta?' });
  const nombre = dialogo.getByRole('textbox');
  const eliminar = dialogo.getByRole('button', { name: 'Eliminar cuenta', exact: true });

  await entrar(pagina, idCuentaWeb);
  await irACuenta();
  await abrirConfirmacion();
  await nombre.fill(datosCuenta(idCuentaWeb).nombre);
  await eliminar.click();
  await pagina.getByText(/Registros vinculados.*inventario/).waitFor();
  assert.ok(await pagina.locator('#dashboard').isVisible());

  await pagina.getByRole('button', { name: 'Inventario', exact: true }).click();
  await pagina.getByRole('button', { name: 'Eliminar', exact: true }).click();
  const dialogoLote = pagina.getByRole('dialog', { name: '¿Estás seguro de eliminar este lote?' });
  assert.equal(await dialogoLote.getByRole('textbox').count(), 0);
  assert.ok(await dialogoLote.getByRole('button', { name: 'Eliminar lote', exact: true }).isEnabled());
  await dialogoLote.getByRole('button', { name: 'Cancelar', exact: true }).click();

  await pagina.getByRole('button', { name: 'Cerrar sesión' }).click();
  await entrar(pagina, idLibre);
  await irACuenta();
  await abrirConfirmacion();
  const nombreExacto = datosCuenta(idLibre).nombre;
  assert.equal(await dialogo.getByText(nombreExacto, { exact: true }).textContent(), nombreExacto);
  assert.ok(await eliminar.isDisabled());
  await nombre.fill(nombreExacto.toUpperCase());
  assert.ok(await eliminar.isDisabled());
  await nombre.fill(nombreExacto);
  assert.ok(await eliminar.isEnabled());
  await nombre.press('Enter');
  assert.ok(await dialogo.isVisible());
  await dialogo.getByRole('button', { name: 'Cancelar', exact: true }).click();

  await abrirConfirmacion();
  assert.equal(await nombre.inputValue(), '');
  assert.ok(await eliminar.isDisabled());
  await nombre.fill(nombreExacto);
  await eliminar.click();
  await pagina.locator('#login').waitFor();
  await pagina.getByText('Usuario eliminado exitosamente', { exact: true }).waitFor();
  await pagina.reload();
  await pagina.locator('#login').waitFor();
});

test('El servidor local carga el frontend MVC y permite usar planes, avisos, catálogo e historial', { timeout: 45_000 }, async t => {
  const sesionAdminLocal = await sesion(idAdminLocal);
  await agregar({ nevera_id: 'FRONTEND-MVC', ingrediente_nombre: 'Leche' }, sesionAdminLocal);
  const aviso = await correcto('/notificaciones', {
    ...sesionAdminLocal, method: 'POST', body: { mensaje: 'Queda leche para el desayuno', tipo: 'STOCK_BAJO' }
  });
  await cerrarSesion(sesionAdminLocal);
  const frontend = spawn(process.execPath, ['frontend/servir.js'], {
    cwd: raiz,
    env: { ...process.env, FRONTEND_PORT: '0', API_PORT: new URL(baseUrl).port },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => detenerProceso(frontend));
  let salidaFrontend = '';
  frontend.stdout.on('data', chunk => { salidaFrontend += chunk; });
  const inicio = await esperar(() => /disponible en (http:\/\/127\.0\.0\.1:\d+)/.exec(salidaFrontend), 'El frontend local no inició.');

  const navegador = await abrirNavegador(t);
  const pagina = await navegador.newPage({ viewport: { width: 1200, height: 800 } });
  await entrar(pagina, idAdminLocal, inicio[1]);
  const irA = vista => pagina.locator('#navigation [data-view="' + vista + '"]').click();
  const editor = pagina.locator('#editor-form');
  await irA('plans');
  await pagina.getByRole('button', { name: 'Nuevo plan', exact: true }).click();
  await editor.getByLabel('Nombre del plan').fill('Desayuno de prueba');
  await editor.locator('select[name=ingrediente_nombre]').selectOption('Leche');
  await editor.getByLabel('Frecuencia de compra en días').fill('7');
  await editor.getByLabel('Probabilidad de desperdicio (%)').fill('25');
  await editor.getByRole('button', { name: 'Guardar', exact: true }).click();
  const plan = pagina.locator('.feature-row').filter({ hasText: 'Desayuno de prueba' }).first();
  await plan.getByRole('button', { name: 'Ver plan', exact: true }).click();
  await pagina.locator('#detail-dialog').getByText(/Compra cada 7 días/).waitFor();
  await pagina.locator('#detail-dialog').getByRole('button', { name: 'Cerrar' }).click();

  const borrarPatron = pagina.getByRole('button', { name: 'Eliminar patrón', exact: true });
  assert.equal(await borrarPatron.count(), 0);
  await plan.getByRole('button', { name: 'Eliminar', exact: true }).click();
  const confirmar = pagina.locator('#delete-dialog');
  await confirmar.getByRole('button', { name: 'Eliminar plan', exact: true }).click();
  await borrarPatron.click();
  await confirmar.getByRole('button', { name: 'Eliminar patrón', exact: true }).click();
  await pagina.getByText('Patrón predictivo eliminado exitosamente', { exact: true }).waitFor();
  await pagina.getByRole('heading', { name: 'Patrones sin uso' }).waitFor({ state: 'hidden' });

  await irA('alerts');
  const filaAviso = pagina.locator('.feature-row').filter({ hasText: aviso.mensaje });
  await filaAviso.getByRole('button', { name: 'Marcar como leída' }).click();
  await filaAviso.getByRole('button', { name: 'Marcar sin leer' }).waitFor();
  const cookie = (await pagina.context().cookies()).find(variable => variable.name === 'nevera_session');
  assert.ok(cookie);
  assert.equal((await correcto('/notificaciones/' + aviso._id, { cookie: cookie.name + '=' + cookie.value })).leida, true);

  await irA('catalog');
  await pagina.getByRole('button', { name: 'Agregar producto', exact: true }).click();
  await editor.getByLabel('Nombre', { exact: true }).fill('Queso de prueba');
  await editor.locator('select[name=marca_nombre]').selectOption('Marca de prueba');
  await editor.locator('select[name=categoria_nombre]').selectOption('Lácteos');
  await editor.getByRole('button', { name: 'Guardar', exact: true }).click();
  await pagina.getByRole('heading', { name: 'Queso de prueba', exact: true }).waitFor();

  await irA('history');
  await pagina.getByRole('button', { name: 'Ver detalle', exact: true }).first().click();
  await pagina.locator('#detail-dialog').getByText('Cantidad registrada', { exact: true }).waitFor();
  const inexistente = await fetch(inicio[1] + '/vistas/no-existe.js');
  assert.equal(inexistente.status, 404);
});

test('Recuperación admite Gmail local y genera enlaces públicos en Render', () => {
  const local = {
    GMAIL_USER: 'nevera@example.test', GMAIL_APP_PASSWORD: ' clave de prueba ',
    PASSWORD_RESET_URL: 'http://127.0.0.1:4173/'
  };
  assert.equal(configurarCorreo(local).enlace.href, local.PASSWORD_RESET_URL);
  assert.equal(configurarCorreo(local).clave, 'clavedeprueba');
  const render = { ...local, RENDER_EXTERNAL_URL: 'https://nevera-prueba.example' };
  assert.equal(configurarCorreo(render), null);
  delete render.PASSWORD_RESET_URL;
  assert.equal(configurarCorreo(render).enlace.href, 'https://nevera-prueba.example/app/');
  assert.equal(configurarCorreo({ ...render, GMAIL_CLIENT_ID: 'incompleto' }), null);
  assert.equal(configurarCorreo({ ...render, RENDER_EXTERNAL_URL: 'mailto:nevera@example.test' }), null);
});

test('El enlace de recuperación enviado por Gmail permite cambiar la contraseña una sola vez', { timeout: 40_000 }, async t => {
  const id = '7006';
  const cuenta = datosCuenta(id);
  const password = 'abcdefghiA1!';
  await correcto('/usuarios', { method: 'POST', body: cuenta });
  const inicioAnterior = await sesion(id);
  const navegador = await abrirNavegador(t);
  const pagina = await navegador.newPage();
  pagina.setDefaultTimeout(8000);
  await pagina.goto(baseUrl + '/app/');
  await pagina.locator('#forgot-toggle').click();
  await pagina.locator('#forgot-form input[name=email]').fill(cuenta.email);
  await pagina.getByRole('button', { name: 'Enviar correo de recuperación', exact: true }).click();
  const aviso = 'Si el correo está registrado, recibirás un enlace y un código de recuperación.';
  await pagina.getByText(aviso, { exact: true }).waitFor();
  const desconocido = await api('/usuarios/recuperar-contrasena', {
    method: 'POST', body: { email: 'no-registrado@example.test' }
  });
  assert.equal(desconocido.status, 202);
  assert.equal(desconocido.message, aviso);

  const { token, codigo } = await leerCorreoRecuperacion(cuenta.email);
  const intentarCodigo = codigo => api('/usuarios/restablecer-contrasena', {
    method: 'POST', body: { email: cuenta.email, codigo, password }
  });
  const incorrecto = codigo === '000000' ? '000001' : '000000';
  const fallidos = await Promise.all(Array.from({ length: 5 }, () => intentarCodigo(incorrecto)));
  assert.ok(fallidos.every(respuesta => respuesta.status === 400));
  assert.equal((await intentarCodigo(codigo)).status, 400);
  await pagina.goto(baseUrl + '/app/#restablecer=' + token);
  const formulario = pagina.locator('#reset-form');
  const reglas = formulario.locator('#reset-password-rules');
  const guardar = formulario.getByRole('button', { name: 'Guardar contraseña', exact: true });
  const nuevaClave = formulario.locator('input[name=password]');
  const confirmarClave = formulario.locator('input[name=confirmation]');
  const indicadorCoincidencia = reglas.locator('[data-password-rule="confirmation"] .password-requirement-icon');
  await reglas.waitFor();
  assert.ok(await formulario.getByLabel('Código de 6 dígitos').isHidden());
  assert.ok(await reglas.getByText('Las contraseñas deben coincidir.').isVisible());
  assert.equal(await reglas.locator('[data-length-label]').textContent(), 'Al menos 12 caracteres');
  assert.equal(await reglas.locator('.is-met').count(), 0);
  assert.ok(await guardar.isDisabled());
  await nuevaClave.pressSequentially(password.slice(0, -1));
  assert.equal(await reglas.locator('[data-password-rule="symbol"] .password-requirement-icon').textContent(), '×');
  assert.ok(await guardar.isDisabled());
  await nuevaClave.pressSequentially('!');
  assert.equal(await reglas.locator('.is-met').count(), 5);
  assert.equal(await reglas.locator('[data-password-rule="symbol"] .password-requirement-icon').textContent(), '✓');
  assert.equal(await indicadorCoincidencia.textContent(), '×');
  assert.ok(await guardar.isDisabled());
  await confirmarClave.fill(password + 'a');
  assert.equal(await indicadorCoincidencia.textContent(), '×');
  assert.ok(await guardar.isDisabled());
  await confirmarClave.fill(password);
  assert.equal(await reglas.locator('.is-met').count(), 6);
  assert.equal(await indicadorCoincidencia.textContent(), '✓');
  assert.ok(await guardar.isEnabled());
  await nuevaClave.fill(password + 'a');
  assert.equal(await indicadorCoincidencia.textContent(), '×');
  assert.ok(await guardar.isDisabled());
  await nuevaClave.fill(password);
  assert.equal(await indicadorCoincidencia.textContent(), '✓');
  assert.ok(await guardar.isEnabled());
  await guardar.click();
  await pagina.getByText('Contraseña actualizada. Ya puedes iniciar sesión.', { exact: true }).waitFor();
  assert.equal(new URL(pagina.url()).hash, '');
  assert.equal((await api('/usuarios/me', inicioAnterior)).status, 401);
  const repetido = await api('/usuarios/restablecer-contrasena', { method: 'POST', body: { token, password } });
  assert.equal(repetido.status, 400);
  assert.equal((await api('/usuarios/login', { method: 'POST', body: { id, password: clave } })).status, 401);
  await correcto('/usuarios/login', { method: 'POST', body: { id, password } });
});

test('El enlace y el código vencen juntos y solo uno puede restablecer la contraseña en simultáneo', async t => {
  const cuenta = datosCuenta('7020');
  await correcto('/usuarios', { method: 'POST', body: cuenta });
  const ingresar = password => api('/usuarios/login', { method: 'POST', body: { id: cuenta.id, password } });
  for (let intento = 1; intento <= 5; intento++) {
    assert.equal((await ingresar(otraClave)).status, intento === 5 ? 429 : 401);
  }

  const respuesta = await api('/usuarios/recuperar-contrasena', { method: 'POST', body: { email: cuenta.email } });
  assert.equal(respuesta.status, 202);
  assert.equal(respuesta.data, null);
  const { token, codigo } = await leerCorreoRecuperacion(cuenta.email);
  const cliente = await new MongoClient(mongoUri).connect();
  t.after(() => cliente.close());
  const usuarios = cliente.db().collection('usuarios');
  const filtro = { _id: cuenta.id };
  const { recuperacion_vence } = await usuarios.findOne(filtro);
  const restablecer = (campos, password) => api('/usuarios/restablecer-contrasena', {
    method: 'POST', body: { ...campos, password }
  });
  const porEnlace = { token };
  const porCodigo = { email: cuenta.email, codigo };
  await usuarios.updateOne(filtro, { $set: { recuperacion_vence: new Date(0) } });
  assert.equal((await restablecer(porEnlace, otraClave)).status, 400);
  assert.equal((await restablecer(porCodigo, otraClave)).status, 400);
  await usuarios.updateOne(filtro, { $set: { recuperacion_vence } });

  const claves = [otraClave, 'NuevaNevera2036!'];
  const resultados = await Promise.all([restablecer(porEnlace, claves[0]), restablecer(porCodigo, claves[1])]);
  assert.deepEqual(resultados.map(resultado => resultado.status).sort(), [200, 400]);
  const ganador = resultados.findIndex(resultado => resultado.status === 200);
  assert.equal((await ingresar(claves[ganador])).status, 200);
});

test('El reenvío fallido conserva la recuperación anterior y un fallo temporal admite reintento', async t => {
  const cuenta = datosCuenta('7022');
  await correcto('/usuarios', { method: 'POST', body: cuenta });
  const solicitar = () => api('/usuarios/recuperar-contrasena', { method: 'POST', body: { email: cuenta.email } });
  const restablecer = token => api('/usuarios/restablecer-contrasena', {
    method: 'POST', body: { token, password: otraClave }
  });
  const cliente = await new MongoClient(mongoUri).connect();
  t.after(() => cliente.close());
  const usuarios = cliente.db().collection('usuarios');
  const filtro = { _id: cuenta.id };
  const permitirReenvio = () => usuarios.updateOne(filtro, { $set: { recuperacion_solicitada: new Date(0) } });

  assert.equal((await solicitar()).status, 202);
  const anterior = await leerCorreoRecuperacion(cuenta.email);
  const estadoAnterior = await usuarios.findOne(filtro);
  await permitirReenvio();
  await prepararGmail({ estado: 400 }, { estado: 200 });
  const fallo = await solicitar();
  assert.equal(fallo.status, 202);
  await esperar(() => salida.includes(JSON.stringify({
    evento: 'error_api', solicitud: fallo.solicitud, categoria: 'GMAIL_ENVIO_400', estado: 500
  })), 'El fallo permanente de Gmail debe registrarse una vez sin reintento.');
  const estadoDespues = await usuarios.findOne(filtro);
  assert.equal(estadoDespues.recuperacion_pendiente, undefined);
  for (const campo of ['recuperacion_hash', 'recuperacion_codigo_hash', 'recuperacion_codigo_intentos', 'recuperacion_vence']) {
    assert.deepEqual(estadoDespues[campo], estadoAnterior[campo]);
  }

  await permitirReenvio();
  await prepararGmail({ estado: 503 }, { estado: 200, esperar: true });
  assert.equal((await solicitar()).status, 202);
  await esperarEventoGmail('en_espera');
  const pendiente = await usuarios.findOne(filtro);
  assert.equal(pendiente.recuperacion_hash, huella(anterior.token));
  assert.ok(pendiente.recuperacion_pendiente);
  servidor.send({ continuarEnvio: true });
  const actual = await leerCorreoRecuperacion(cuenta.email);
  assert.equal((await restablecer(anterior.token)).status, 400);
  assert.equal((await restablecer(actual.token)).status, 200);
});

test('Restablecer con el enlace activo cancela un reenvío aún pendiente', async t => {
  const cuenta = datosCuenta('7023');
  await correcto('/usuarios', { method: 'POST', body: cuenta });
  const solicitar = () => api('/usuarios/recuperar-contrasena', { method: 'POST', body: { email: cuenta.email } });
  const restablecer = token => api('/usuarios/restablecer-contrasena', {
    method: 'POST', body: { token, password: otraClave }
  });

  assert.equal((await solicitar()).status, 202);
  const anterior = await leerCorreoRecuperacion(cuenta.email);
  const cliente = await new MongoClient(mongoUri).connect();
  t.after(() => cliente.close());
  const usuarios = cliente.db().collection('usuarios');
  const filtro = { _id: cuenta.id };
  await usuarios.updateOne(filtro, { $set: { recuperacion_solicitada: new Date(0) } });
  await prepararGmail({ estado: 200, esperar: true });
  assert.equal((await solicitar()).status, 202);
  await esperarEventoGmail('en_espera');
  try {
    assert.equal((await restablecer(anterior.token)).status, 200);
    const estado = await usuarios.findOne(filtro);
    assert.equal(estado.recuperacion_pendiente, undefined);
    assert.equal(estado.recuperacion_hash, undefined);
  } finally {
    servidor.send({ continuarEnvio: true });
  }
  const enviadoTarde = await leerCorreoRecuperacion(cuenta.email, false);
  assert.equal((await restablecer(enviadoTarde.token)).status, 400);
});

test('Una solicitud con JSON inválido devuelve un identificador y un mensaje seguro', async () => {
  const nota = 'marcador-local-de-prueba';
  const respuesta = await fetch(baseUrl + '/api/usuarios', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: nota, signal: AbortSignal.timeout(6000)
  });
  assert.equal(respuesta.status, 400);
  const solicitud = respuesta.headers.get('x-request-id');
  assert.match(solicitud, /^[a-f0-9-]{36}$/);
  assert.deepEqual(await respuesta.json(), { success: false, message: 'Envía un cuerpo JSON válido.', data: null });
  await esperar(() => salida.includes(JSON.stringify({ evento: 'error_api', solicitud, categoria: 'json_invalido', estado: 400 })),
    'No se registró el error de JSON con su identificador.');
  assert.ok(!salida.includes(nota));
});

test('El catálogo conserva el orden y las referencias faltantes al agrupar la consulta', async t => {
  const cliente = await new MongoClient(mongoUri).connect();
  const productos = cliente.db().collection('productos');
  const sinReferencia = {
    _id: 'PRODUCTO-LEGADO-RESUMEN', nombre: 'Producto anterior',
    marca_nombre: 'Marca anterior', categoria_nombre: 'Lácteos'
  };
  t.after(async () => {
    await productos.deleteOne({ _id: sinReferencia._id });
    await cliente.close();
  });
  await productos.insertOne(sinReferencia);
  const orden = (await productos.find().toArray()).map(item => item._id);
  const catalogo = await correcto('/productos');
  assert.deepEqual(catalogo.map(item => item._id), orden);
  assert.deepEqual(catalogo.find(item => item._id === sinReferencia._id), {
    ...sinReferencia, categoria_nombre: { _id: sinReferencia.categoria_nombre }
  });
  const leche = catalogo.find(item => item._id === loteBase.producto_id);
  assert.deepEqual(leche.marca_nombre, { _id: 'Marca de prueba' });
  assert.deepEqual(leche.categoria_nombre, { _id: 'Lácteos' });
});

test('El resumen de inventario cuenta los lotes activos del usuario y limita sus vencimientos a ocho', async t => {
  const id = '742011';
  await correcto('/usuarios', { method: 'POST', body: datosCuenta(id) });
  const auth = await sesion(id);
  assert.equal((await api('/inventario/resumen')).status, 401);
  const resumen = () => correcto('/inventario/resumen', auth);
  assert.deepEqual(await resumen(), { total: 0, vencidos: 0, proximos: 0, vencimientos: [] });

  const cliente = await new MongoClient(mongoUri).connect();
  const inventario = cliente.db().collection('inventario');
  const nevera = 'PRUEBA-RESUMEN';
  t.after(async () => {
    await inventario.deleteMany({ nevera_id: nevera });
    await cliente.close();
  });
  const lote = campos => ({ ...loteBase, _id: new ObjectId(), user_nombre: id, estado: 'EN_NEVERA', nevera_id: nevera, ...campos });
  const ahora = Date.now();
  const hora = 3_600_000;
  const vencido = lote({ producto_id: 'SIN-PRODUCTO-DE-PRUEBA', fecha_vencimiento: new Date(ahora - hora) });
  const proximos = Array.from({ length: 9 }, (_, i) => lote({ fecha_vencimiento: new Date(ahora + (i + 1) * hora) }));
  proximos[1].fecha_vencimiento = proximos[0].fecha_vencimiento;
  await inventario.insertMany([
    ...proximos.toReversed(), vencido,
    lote({ fecha_vencimiento: new Date(ahora + 73 * hora) }),
    lote({ fecha_vencimiento: null }),
    lote({}),
    lote({ fecha_vencimiento: 'no es una fecha' }),
    lote({ fecha_vencimiento: [new Date(ahora - 2 * hora)] }),
    lote({ cantidad: 0, fecha_vencimiento: new Date(ahora - 2 * hora) }),
    lote({ estado: 'CONSUMIDO', fecha_vencimiento: new Date(ahora - 3 * hora) }),
    lote({ user_nombre: idUsuario, fecha_vencimiento: new Date(ahora - 4 * hora) })
  ]);
  const { total, vencidos, proximos: cantidadProximos, vencimientos } = await resumen();
  assert.deepEqual([total, vencidos, cantidadProximos], [15, 1, 9]);
  assert.deepEqual(vencimientos.map(item => item._id), [vencido, ...proximos.slice(0, 7)].map(item => item._id.toHexString()));
  assert.deepEqual(vencimientos[0], {
    _id: vencido._id.toHexString(), nevera_id: nevera, producto_nombre: 'SIN-PRODUCTO-DE-PRUEBA',
    fecha_vencimiento: vencido.fecha_vencimiento.toISOString(), vencido: true
  });
  assert.ok(vencimientos.slice(1).every(item => item.producto_nombre === 'Leche de prueba' && !item.vencido));
});

test('La ruta de salud detecta cuando MongoDB deja de responder', { timeout: 35_000 }, async () => {
  assert.equal((await api('/salud')).status, 200);
  await replica.stop();
  const fallo = await api('/salud');
  assert.equal(fallo.status, 503);
  assert.equal(fallo.success, false);
  assert.equal(fallo.data, null);
});
