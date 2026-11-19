/*
 * Validación de IDs en tiempo real para Swagger UI.
 * Valida mientras se escribe (con retardo) y al salir del campo, sin presionar "Execute":
 *  - Parámetros de ruta ({id}, {itemId}): la colección se toma del segmento anterior de la URL.
 *  - Parámetros de query y campos del body JSON: se validan los campos foráneos (user_nombre,
 *    producto_id, marca_nombre, ...) según el mapa que expone el servidor (derivado de los `ref`).
 */
(function () {
  'use strict';

  var BASE = '/api/validaciones';
  var RETARDO_MS = 450;
  var CACHE_MS = 5000;
  var mapaPromesa = null;
  var cache = new Map();
  var tokenAnterior;

  function cargarMapa() {
    if (!mapaPromesa) {
      mapaPromesa = fetch(BASE + '/mapa')
        .then(function (r) { return r.json(); })
        .then(function (j) { return j.data; })
        .catch(function () { mapaPromesa = null; return null; });
    }
    return mapaPromesa;
  }

  function consultar(coleccion, id) {
    var token = window.ui?.authSelectors?.authorized()?.getIn(['bearerAuth', 'value']);
    if (token !== tokenAnterior) {
      cache.clear();
      tokenAnterior = token;
    }
    var clave = coleccion + '|' + id;
    var guardado = cache.get(clave);
    if (guardado && Date.now() - guardado.t < CACHE_MS) return guardado.p;
    var opciones = token ? { headers: { Authorization: 'Bearer ' + token } } : undefined;
    var p = fetch(BASE + '/' + encodeURIComponent(coleccion) + '/' + encodeURIComponent(id), opciones)
      .then(function (r) {
        if (r.status === 401) return { success: null, message: 'Autoriza tu sesión en Swagger para validar este ID' };
        return r.json();
      })
      .catch(function () {
        cache.delete(clave);
        return { success: null, message: 'No se pudo validar el ID (sin conexión con el servidor)' };
      });
    cache.set(clave, { t: Date.now(), p: p });
    return p;
  }

  // ---------- Retroalimentación visual ----------
  function caja(el) {
    var sig = el.nextElementSibling;
    if (sig && sig.classList.contains('val-id')) return sig;
    var nueva = document.createElement('div');
    nueva.className = 'val-id';
    el.insertAdjacentElement('afterend', nueva);
    return nueva;
  }

  function limpiar(el) {
    var sig = el.nextElementSibling;
    if (sig && sig.classList.contains('val-id')) sig.remove();
    el.classList.remove('val-id-ok', 'val-id-error');
  }

  // resultados: [{ etiqueta, success, message }]
  function pintar(el, resultados) {
    if (!resultados.length) return limpiar(el);
    var c = caja(el);
    c.textContent = '';
    var hayError = false;
    resultados.forEach(function (r) {
      var linea = document.createElement('div');
      var estado = r.success === true ? 'ok' : r.success === false ? 'error' : 'pendiente';
      if (estado === 'error') hayError = true;
      linea.className = 'val-id__linea val-id__linea--' + estado;
      var icono = estado === 'ok' ? '✅ ' : estado === 'error' ? '❌ ' : '⏳ ';
      linea.textContent = icono + (r.etiqueta ? r.etiqueta + ': ' : '') + r.message;
      c.appendChild(linea);
    });
    var todoOk = resultados.every(function (r) { return r.success === true; });
    el.classList.toggle('val-id-error', hayError);
    el.classList.toggle('val-id-ok', todoOk);
  }

  // ---------- Qué validar según el campo ----------
  // Devuelve [{ etiqueta, coleccion, id }] o null si el campo no es validable
  function objetivos(el, mapa) {
    if (el.matches('textarea.body-param__text')) {
      var datos;
      try { datos = JSON.parse(el.value); } catch (e) { return null; } // JSON incompleto: esperar
      if (!datos || typeof datos !== 'object' || Array.isArray(datos)) return null;
      return Object.keys(datos)
        .filter(function (k) {
          var v = datos[k];
          return mapa.campos[k] && (typeof v === 'string' || typeof v === 'number') && String(v).trim() !== '';
        })
        .map(function (k) { return { etiqueta: k, coleccion: mapa.campos[k], id: String(datos[k]).trim() }; });
    }

    var fila = el.closest('tr[data-param-name]');
    if (!fila) return null;
    var nombre = fila.getAttribute('data-param-name');
    var ubicacion = fila.getAttribute('data-param-in');
    var valor = el.value.trim();
    var coleccion = null;

    if (ubicacion === 'path') {
      var op = el.closest('.opblock');
      var rutaEl = op && op.querySelector('[data-path]');
      if (rutaEl) {
        var segmentos = rutaEl.getAttribute('data-path').split('/');
        var i = segmentos.indexOf('{' + nombre + '}');
        if (i > 0 && mapa.colecciones[segmentos[i - 1]]) coleccion = segmentos[i - 1];
      }
    } else if (mapa.campos[nombre]) {
      coleccion = mapa.campos[nombre];
    }

    if (!coleccion) return null;
    return valor ? [{ etiqueta: '', coleccion: coleccion, id: valor }] : [];
  }

  function validar(el) {
    var turno = (el.__valTurno || 0) + 1;
    el.__valTurno = turno;
    cargarMapa().then(function (mapa) {
      if (!mapa) return;
      var lista = objetivos(el, mapa);
      if (lista === null) return;
      if (!lista.length) return limpiar(el);
      pintar(el, lista.map(function (o) { return { etiqueta: o.etiqueta, success: null, message: 'Validando...' }; }));
      Promise.all(lista.map(function (o) {
        return consultar(o.coleccion, o.id).then(function (r) {
          return { etiqueta: o.etiqueta, success: r.success, message: r.message };
        });
      })).then(function (resultados) {
        if (el.__valTurno === turno) pintar(el, resultados); // ignora respuestas viejas
      });
    });
  }

  function esCampo(el) {
    return el instanceof HTMLElement &&
      el.closest('.swagger-ui') &&
      (el.matches('textarea.body-param__text') || el.matches('tr[data-param-name] input'));
  }

  // Mientras escribe (con retardo)
  document.addEventListener('input', function (e) {
    var el = e.target;
    if (!esCampo(el)) return;
    clearTimeout(el.__valTimer);
    el.__valTimer = setTimeout(function () { validar(el); }, RETARDO_MS);
  }, true);

  // Al perder el foco (inmediato)
  document.addEventListener('focusout', function (e) {
    var el = e.target;
    if (!esCampo(el)) return;
    clearTimeout(el.__valTimer);
    validar(el);
  }, true);

  cargarMapa();
})();
