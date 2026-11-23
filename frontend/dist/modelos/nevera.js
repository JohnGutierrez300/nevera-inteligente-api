export async function requestApi(path, method = 'GET', body, options) {
  let response;
  try {
    response = await fetch('/api' + path, {
      ...options,
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch {
    throw new Error('No se pudo conectar con la API. Intenta de nuevo.');
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success !== true) {
    const error = new Error(payload?.message || 'La API no pudo completar la solicitud.');
    error.status = response.status;
    error.data = payload?.data;
    throw error;
  }
  return payload;
}

const byId = (path, id) => path + '/' + encodeURIComponent(id);
const productReferenceMaxAgeMs = 15_000;

function inventoryUrl(filters) {
  const { vence_desde, vence_hasta, ...options } = filters;
  const query = new URLSearchParams({ ...options, orden: 'vencimiento' });
  if (vence_desde) query.set('vence_desde', vence_desde + 'T00:00:00.000-05:00');
  if (vence_hasta) query.set('vence_hasta', vence_hasta + 'T23:59:59.999-05:00');
  return '/inventario?' + query;
}

function lotPayload(fields) {
  return {
    ...fields,
    cantidad: Number(fields.cantidad),
    fecha_vencimiento: fields.fecha_vencimiento ? fields.fecha_vencimiento + '-05:00' : null,
    ingrediente_nombre: fields.ingrediente_nombre || null
  };
}

function planPayload(fields, createPattern) {
  const { nombre_receta, ingrediente_nombre, patron_predictivo_id, frecuencia_compra_dias, probabilidad_desperdicio } = fields;
  const payload = { nombre_receta: nombre_receta.trim(), ingrediente_nombre };
  if (createPattern) {
    payload.patron = {};
    if (frecuencia_compra_dias !== '') payload.patron.frecuencia_compra_dias = Number(frecuencia_compra_dias);
    if (probabilidad_desperdicio !== '') payload.patron.probabilidad_desperdicio = Number(probabilidad_desperdicio) / 100;
  } else {
    payload.patron_predictivo_id = patron_predictivo_id;
  }
  return payload;
}

function catalogPayload(kind, { nombre, ...details }) {
  const value = nombre.trim();
  if (!value) throw new Error('Ingresa un nombre.');
  return kind === 'productos' ? { _id: 'PROD-' + crypto.randomUUID(), nombre: value, ...details }
    : { _id: value, ...details };
}

export function createModel(request) {
  const read = async path => (await request(path)).data;
  const save = (path, id, payload) => id ? request(byId(path, id), 'PUT', payload) : request(path, 'POST', payload);
  const remove = (path, id) => request(byId(path, id), 'DELETE');
  let products;

  function listProducts(reuse = false) {
    if (products && (products.expiresAt === null || (reuse && products.expiresAt > performance.now()))) {
      return products.result;
    }
    const entry = { expiresAt: null };
    entry.result = read('/productos').then(items => {
      entry.expiresAt = performance.now() + productReferenceMaxAgeMs;
      return items;
    }, error => {
      if (products === entry) products = undefined;
      throw error;
    });
    products = entry;
    return entry.result;
  }

  async function changeCatalog(kind, change) {
    const response = await change;
    if (kind === 'productos') products = undefined;
    return response;
  }

  return {
    account: {
      get: options => request('/usuarios/me', 'GET', undefined, options),
      register: fields => request('/usuarios', 'POST', fields),
      signIn: fields => request('/usuarios/login', 'POST', { ...fields, sesion_web: true }),
      signOut: () => request('/usuarios/logout', 'POST'),
      reportActivity: transcurrido_ms => request('/usuarios/actividad', 'POST', { transcurrido_ms }, { keepalive: true }),
      recover: email => request('/usuarios/recuperar-contrasena', 'POST', { email }),
      reset: (token, password) => request('/usuarios/restablecer-contrasena', 'POST', { token, password }),
      update: (id, fields) => request(byId('/usuarios', id), 'PUT', fields),
      remove: id => remove('/usuarios', id)
    },
    inventory: {
      list: filters => request(inventoryUrl(filters)),
      get: id => read(byId('/inventario', id)),
      save: (id, fields) => save('/inventario', id, lotPayload(fields)),
      setStatus: (id, estado) => request(byId('/inventario', id), 'PUT', { estado }),
      remove: id => remove('/inventario', id)
    },
    plans: {
      list: () => read('/meal_preps'),
      get: id => read(byId('/meal_preps', id)),
      suggestions: () => read('/meal_preps/sugerencias'),
      patterns: () => read('/patrones_predictivos'),
      save: (id, fields, createPattern) => save('/meal_preps', id, planPayload(fields, createPattern)),
      remove: id => remove('/meal_preps', id)
    },
    notifications: {
      summary: revision => read('/notificaciones/resumen' + (revision === undefined ? '' : '?' + new URLSearchParams({ revision }))),
      list({ pagina, limite, tipo, lectura }) {
        const params = new URLSearchParams({ pagina, limite });
        if (tipo) params.set('tipo', tipo);
        if (lectura) params.set('lectura', lectura);
        return request('/notificaciones?' + params);
      },
      setRead: (id, leida) => request(byId('/notificaciones', id), 'PATCH', { leida }),
      remove: id => remove('/notificaciones', id)
    },
    history: {
      list: (pagina, limite) => read('/historial_inventario?' + new URLSearchParams({ pagina, limite })),
      get: id => read(byId('/historial_inventario', id))
    },
    catalog: {
      list: kind => kind === 'productos' ? listProducts() : read('/' + kind),
      productsForDisplay: () => listProducts(true),
      create: (kind, fields) => changeCatalog(kind, request('/' + kind, 'POST', catalogPayload(kind, fields))),
      remove: (kind, id) => changeCatalog(kind, remove('/' + kind, id))
    }
  };
}

export function summarizeLots(lots) {
  const now = Date.now();
  const limit = now + 72 * 60 * 60 * 1000;
  const active = lots.filter(lot => lot.cantidad > 0);
  const expired = active.filter(lot => lot.fecha_vencimiento && Date.parse(lot.fecha_vencimiento) < now);
  const soon = active.filter(lot => {
    const date = Date.parse(lot.fecha_vencimiento);
    return date >= now && date <= limit;
  });
  return { total: active.length, expired, soon };
}
