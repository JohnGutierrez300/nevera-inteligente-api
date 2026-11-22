const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { setTimeout: pause } = require('node:timers/promises');
const { MongoMemoryReplSet } = require('mongodb-memory-server-core');
const { mongo: { MongoClient } } = require('mongoose');
const { chromium } = require('playwright');

const raiz = path.resolve(__dirname, '..');
const clave = 'PruebaNevera2026!';
const otraClave = 'PruebaNevera2030!';
const idAdmin = '7001';
const idUsuario = '7002';
const idCuenta = '7003';
const idBorrado = '7004';
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

async function esperar(comprobar, mensaje) {
  const limite = Date.now() + 15_000;
  do {
    const resultado = await comprobar();
    if (resultado) return resultado;
    await pause(100);
  } while (Date.now() < limite);
  assert.fail(mensaje + '\n' + salida);
}

async function detenerProceso(proceso) {
  if (!proceso || proceso.exitCode !== null || proceso.signalCode !== null) return;
  const cierre = once(proceso, 'exit');
  proceso.kill();
  await cierre;
}

async function api(ruta, { method = 'GET', body, token, cookie } = {}) {
  const headers = new Headers({ Origin: baseUrl });
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', 'Bearer ' + token);
  if (cookie) headers.set('Cookie', cookie);
  const respuesta = await fetch(baseUrl + '/api' + ruta, {
    method, headers, body: JSON.stringify(body), signal: AbortSignal.timeout(6000)
  });
  return {
    status: respuesta.status,
    cookie: respuesta.headers.get('set-cookie')?.split(';')[0],
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

const agregar = (body, auth = usuario) => correcto('/inventario', {
  ...auth, method: 'POST', body: { ...loteBase, ...body }
});

before(async () => {
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  mongoUri = replica.getUri('nevera_test');
  servidor = spawn(process.execPath, ['server.js'], {
    cwd: raiz,
    env: {
      ...process.env, PORT: '0', MONGO_URI: mongoUri, CATALOG_ADMIN_IDS: idAdmin,
      GMAIL_USER: '', GMAIL_APP_PASSWORD: '', DOTENV_CONFIG_QUIET: 'true'
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  for (const stream of [servidor.stdout, servidor.stderr]) {
    stream.on('data', chunk => { salida += chunk; });
  }
  const inicio = await esperar(() => /Servidor corriendo en http:\/\/localhost:(\d+)/.exec(salida), 'La API de prueba no inició.');
  baseUrl = 'http://127.0.0.1:' + inicio[1];
  await esperar(async () => (await api('/salud')).status === 200, 'MongoDB de prueba no está disponible.');

  for (const id of [idAdmin, idUsuario, idCuenta, idBorrado]) {
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

test('Un alta simultánea acumula la cantidad y una edición duplicada se revierte', async () => {
  const fecha = '2032-02-29T10:00:00-05:00';
  const datos = { nevera_id: 'ACUMULACION', fecha_vencimiento: fecha };
  const [primero, acumulado] = await Promise.all([
    agregar(datos), agregar({ ...datos, cantidad: 2, fecha_vencimiento: '2032-02-29T15:00:00Z' })
  ]);
  assert.equal(primero._id, acumulado._id);
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
    const conIngrediente = await agregar({ nevera_id: datos.nevera_id, ingrediente_nombre: 'Leche' });
    const sinIngrediente = await agregar({ nevera_id: datos.nevera_id });
    assert.equal(sinIngrediente._id, String(insertedId));
    assert.equal(sinIngrediente.cantidad, 2);
    const conflicto = await api('/inventario/' + conIngrediente._id, {
      ...usuario, method: 'PUT', body: { ingrediente_nombre: null }
    });
    assert.equal(conflicto.status, 409);
    assert.equal(conflicto.data.inventario_id, sinIngrediente._id);
  } finally {
    await cliente.close();
  }
});

test('Inventario responde 400 por fechas inválidas y solicitudes incompletas', async () => {
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

test('Cambiar correo o contraseña requiere la contraseña actual con Bearer y con cookie', async () => {
  const bearer = await sesion(idCuenta);
  const web = await sesion(idCuenta, true);
  const ruta = '/usuarios/' + idCuenta;
  const email = 'actualizado@nevera.test';
  for (const auth of [bearer, web]) {
    for (const cambio of [{ email }, { password: otraClave }]) {
      const respuesta = await api(ruta, { ...auth, method: 'PUT', body: cambio });
      assert.equal(respuesta.status, 403);
      assert.match(respuesta.message, /contraseña actual/);
    }
  }
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

async function entrar(pagina, id, direccion = baseUrl + '/app/') {
  pagina.setDefaultTimeout(8000);
  await pagina.goto(direccion);
  const formulario = pagina.locator('#auth');
  await formulario.locator('input[name=nombre]').fill(datosCuenta(id).nombre);
  await formulario.locator('input[name=password]').fill(clave);
  await formulario.getByRole('button', { name: 'Entrar', exact: true }).click();
  await pagina.locator('#dashboard').waitFor();
}

test('El frontend pagina, muestra el lote en conflicto y conserva sesión y vista al recargar', { timeout: 60_000 }, async t => {
  for (let dia = 1; dia <= 21; dia++) {
    await agregar({ nevera_id: 'PAGINAS-WEB', fecha_vencimiento: `2032-09-${String(dia).padStart(2, '0')}T12:00:00-05:00` }, admin);
  }
  const navegador = await abrirNavegador(t);
  const pagina = await navegador.newPage({ viewport: { width: 1200, height: 800 } });
  await entrar(pagina, idAdmin);
  await pagina.getByRole('button', { name: 'Inventario', exact: true }).click();
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
  const formulario = pagina.locator('#lot-form');
  await formulario.locator('input[name=fecha_vencimiento]').fill('2032-09-01T12:00');
  await formulario.getByRole('button', { name: 'Guardar', exact: true }).click();
  await formulario.locator('#lot-error').waitFor();
  assert.match(await formulario.locator('#lot-error').textContent(), /Ya existe un lote/);
  await formulario.getByRole('button', { name: 'Ver lote existente' }).click();
  await pagina.locator('#detail-dialog[open]').waitFor();
  assert.equal(await pagina.locator('#detail-title').textContent(), 'Leche de prueba');

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

test('El menú táctil horizontal funciona e Inicio sigue disponible cuando fallan los avisos', { timeout: 35_000 }, async t => {
  const navegador = await abrirNavegador(t);
  const pagina = await navegador.newPage({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });
  const responderAvisos = Promise.withResolvers();
  await pagina.route('**/api/notificaciones', async route => {
    await responderAvisos.promise;
    await route.fulfill({ status: 503, json: { success: false, message: 'Avisos no disponibles' } });
  });
  try {
    await entrar(pagina, idUsuario);
    await pagina.getByText('Lotes en nevera', { exact: true }).waitFor();
    await pagina.getByText('Consultando avisos…', { exact: true }).waitFor();
  } finally {
    responderAvisos.resolve();
  }
  await pagina.getByText('Avisos no disponibles', { exact: true }).waitFor();
  assert.ok(await pagina.getByText('Lotes en nevera', { exact: true }).isVisible());
  await pagina.getByRole('button', { name: 'Abrir menú' }).click();
  const menu = pagina.getByRole('dialog', { name: 'Menú' });
  assert.ok(await menu.isVisible());
  await menu.getByRole('button', { name: 'Inventario', exact: true }).click();
  await menu.waitFor({ state: 'hidden' });
  await pagina.getByRole('heading', { name: 'Inventario', exact: true }).waitFor();
});

test('Mi cuenta muestra el bloqueo por dependencias y cierra sesión cuando se permite eliminar', { timeout: 35_000 }, async t => {
  const idLibre = '7005';
  await correcto('/usuarios', { method: 'POST', body: datosCuenta(idLibre) });
  await agregar({ nevera_id: 'CUENTA-WEB' });
  const navegador = await abrirNavegador(t);
  const pagina = await navegador.newPage({ viewport: { width: 1200, height: 800 } });
  const confirmar = async () => {
    await pagina.getByRole('button', { name: 'Mi cuenta', exact: true }).click();
    await pagina.getByRole('button', { name: 'Eliminar mi cuenta', exact: true }).click();
    await pagina.getByRole('dialog', { name: '¿Eliminar tu cuenta?' })
      .getByRole('button', { name: 'Eliminar cuenta', exact: true }).click();
  };

  await entrar(pagina, idUsuario);
  await confirmar();
  await pagina.getByText(/Registros vinculados.*inventario/).waitFor();
  assert.ok(await pagina.locator('#dashboard').isVisible());
  await pagina.getByRole('button', { name: 'Cerrar sesión' }).click();
  await entrar(pagina, idLibre);
  await confirmar();
  await pagina.locator('#login').waitFor();
  await pagina.getByText('Usuario eliminado exitosamente', { exact: true }).waitFor();
  await pagina.reload();
  await pagina.locator('#login').waitFor();
});

test('El servidor local carga el frontend MVC y permite usar planes, avisos, catálogo e historial', { timeout: 45_000 }, async t => {
  await agregar({ nevera_id: 'FRONTEND-MVC', ingrediente_nombre: 'Leche' }, admin);
  const aviso = await correcto('/notificaciones', {
    ...admin, method: 'POST', body: { mensaje: 'Queda leche para el desayuno', tipo: 'STOCK_BAJO' }
  });
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
  await entrar(pagina, idAdmin, inicio[1]);
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

  await irA('alerts');
  const filaAviso = pagina.locator('.feature-row').filter({ hasText: aviso.mensaje });
  await filaAviso.getByRole('button', { name: 'Marcar como leída' }).click();
  await filaAviso.getByRole('button', { name: 'Marcar sin leer' }).waitFor();
  assert.equal((await correcto('/notificaciones/' + aviso._id, admin)).leida, true);

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

test('La ruta de salud detecta cuando MongoDB deja de responder', { timeout: 35_000 }, async () => {
  assert.equal((await api('/salud')).status, 200);
  await replica.stop();
  const fallo = await api('/salud');
  assert.equal(fallo.status, 503);
  assert.equal(fallo.success, false);
  assert.equal(fallo.data, null);
});
