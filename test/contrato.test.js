const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const YAML = require('yamljs');

test('Swagger documenta las operaciones de Express y sus respuestas nuevas', () => {
  const raiz = path.resolve(__dirname, '..');
  const servidor = fs.readFileSync(path.join(raiz, 'server.js'), 'utf8');
  const swagger = YAML.load(path.join(raiz, 'swagger.yaml'));
  const rutas = /(?:app\.(get|post|put|patch|delete)\(|mutacion\('(get|post|put|patch|delete)',\s*)'(\/api\/[^']+)'/g;
  const implementadas = Array.from(servidor.matchAll(rutas), ([, directo, transaccion, ruta]) =>
    (directo ?? transaccion) + ' ' + ruta.replace(/:(\w+)/g, '{$1}'));
  const metodos = new Set(['get', 'post', 'put', 'patch', 'delete']);
  const documentadas = Object.entries(swagger.paths).flatMap(([ruta, operaciones]) =>
    Object.keys(operaciones).filter(metodo => metodos.has(metodo)).map(metodo => metodo + ' ' + ruta));
  assert.deepEqual(documentadas.sort(), implementadas.sort());

  for (const recurso of ['categorias', 'marcas', 'unidades_medida', 'ingredientes', 'productos']) {
    const permiso = '#/components/responses/CatalogAdminRequired';
    assert.equal(swagger.paths['/api/' + recurso].post.responses[403].$ref, permiso);
    assert.equal(swagger.paths['/api/' + recurso + '/{id}'].delete.responses[403].$ref, permiso);
  }
  assert.match(swagger.components.schemas.UsuarioUpdate.properties.password_actual.description, /cualquier tipo de sesión/);
  assert.ok(swagger.paths['/api/inventario/{itemId}'].put.responses[409]);
  assert.ok(swagger.paths['/api/salud'].get.responses[503]);
});

test('Las consultas de productos se comparten y se invalidan después de eliminar un producto', async () => {
  const { createModel } = require('../frontend/dist/modelos/nevera.js');
  const producto = { _id: 'LECHE', nombre: 'Leche de prueba' };
  let lecturas = 0;
  let respuesta = Promise.resolve([producto]);
  const catalogo = createModel(async (ruta, metodo = 'GET') => {
    if (metodo === 'DELETE') return { success: true };
    assert.equal(ruta, '/productos');
    lecturas++;
    return { data: await respuesta };
  }).catalog;

  const inicial = catalogo.productsForDisplay();
  assert.equal(catalogo.productsForDisplay(), inicial);
  await inicial;
  assert.deepEqual(await catalogo.productsForDisplay(), [producto]);
  assert.equal(lecturas, 1);

  const anterior = Promise.withResolvers();
  respuesta = anterior.promise;
  const consultaAnterior = catalogo.list('productos');
  await catalogo.remove('productos', producto._id);
  respuesta = Promise.resolve([]);
  assert.deepEqual(await catalogo.productsForDisplay(), []);
  anterior.resolve([producto]);
  await consultaAnterior;
  assert.deepEqual(await catalogo.productsForDisplay(), []);
  assert.equal(lecturas, 3);
});
