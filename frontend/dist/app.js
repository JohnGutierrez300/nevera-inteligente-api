'use strict';

const apiOrigin = location.pathname.startsWith('/app/')
  ? location.origin
  : ['localhost', '127.0.0.1'].includes(location.hostname)
    ? 'http://127.0.0.1:3000'
    : 'https://nevera-inteligente-api.onrender.com';
const byId = id => document.getElementById(id);
const auth = byId('auth');
const forgotForm = byId('forgot-form');
const resetForm = byId('reset-form');
const filters = byId('filters');
const results = byId('results');
const dialog = byId('lot-dialog');
const deleteDialog = byId('delete-dialog');
const lotForm = byId('lot-form');
const navButtons = [...document.querySelectorAll('[data-view]')];
const views = {
  inventory: { title: 'Inventario', endpoint: '/inventario', empty: 'No hay lotes para mostrar.' },
  plans: { title: 'Planes de comida', endpoint: '/meal_preps', empty: 'Aún no tienes planes de comida.' },
  alerts: { title: 'Notificaciones', endpoint: '/notificaciones', empty: 'Aún no tienes notificaciones.' }
};
const states = { EN_NEVERA: 'En nevera', CONSUMIDO: 'Consumido', DESPERDICIADO: 'Desperdiciado' };
const dateFormat = new Intl.DateTimeFormat('es-CO', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Bogota'
});
const numberFormat = new Intl.NumberFormat('es-CO', { maximumSignificantDigits: 15 });
const field = (form, name) => form.elements.namedItem(name);
let token = '';
let registering = false;
let recoveryToken = '';
let currentView = 'inventory';
let viewRequest = 0;
let editingId = '';
let pendingDeletion = null;

async function request(path, method = 'GET', body) {
  const requestToken = token;
  const headers = {};
  if (requestToken) headers.Authorization = 'Bearer ' + requestToken;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(apiOrigin + '/api' + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch {
    throw new Error('No se pudo conectar con la API. Intenta de nuevo.');
  }
  const payload = await response.json().catch(() => null);
  if (response.status === 401 && requestToken && requestToken === token) signOut();
  if (!response.ok || payload?.success !== true) {
    throw new Error(payload?.message || 'La API no pudo completar la solicitud.');
  }
  return payload;
}

function notice(message = '', error = false) {
  const element = byId('notice');
  element.textContent = message;
  element.classList.toggle('error', error);
  element.hidden = !message;
}

function toggleRegistration() {
  registering = !registering;
  byId('registration').hidden = !registering;
  field(auth, 'email').disabled = !registering;
  const password = field(auth, 'password');
  password.autocomplete = registering ? 'new-password' : 'current-password';
  password.minLength = registering ? 12 : 0;
  byId('auth-title').textContent = registering ? 'Crear cuenta' : 'Iniciar sesión';
  byId('auth-submit').textContent = registering ? 'Crear cuenta' : 'Entrar';
  byId('register-toggle').textContent = registering ? 'Volver al inicio de sesión' : 'Crear una cuenta';
  byId('forgot-toggle').hidden = registering;
  notice();
}

function showSession(active) {
  byId('login').hidden = active;
  for (const id of ['dashboard', 'navigation', 'logout']) byId(id).hidden = !active;
}

function signOut() {
  token = '';
  viewRequest++;
  filters.reset();
  results.replaceChildren();
  if (dialog.open) dialog.close();
  if (deleteDialog.open) deleteDialog.close();
  pendingDeletion = null;
  showSession(false);
  notice();
}

auth.addEventListener('submit', async event => {
  event.preventDefault();
  const submit = byId('auth-submit');
  const toggle = byId('register-toggle');
  const forgotToggle = byId('forgot-toggle');
  submit.disabled = toggle.disabled = forgotToggle.disabled = true;
  notice();
  const credentials = Object.fromEntries(new FormData(auth));
  try {
    if (registering) {
      await request('/usuarios', 'POST', credentials);
      toggleRegistration();
      notice('Cuenta creada. Ya puedes iniciar sesión.');
      return;
    }
    const response = await request('/usuarios/login', 'POST', credentials);
    if (!response.data?.token) throw new Error('La API no devolvió el token de sesión.');
    token = response.data.token;
    showSession(true);
    await selectView('inventory');
  } catch (error) {
    notice(error.message, true);
  } finally {
    field(auth, 'password').value = '';
    submit.disabled = toggle.disabled = forgotToggle.disabled = false;
  }
});

byId('register-toggle').addEventListener('click', toggleRegistration);
byId('logout').addEventListener('click', signOut);

function showAuthForm(form, focus = true) {
  for (const candidate of [auth, forgotForm, resetForm]) candidate.hidden = candidate !== form;
  if (focus) form.querySelector('input').focus();
  notice();
}

byId('forgot-toggle').addEventListener('click', () => {
  field(auth, 'password').value = '';
  showAuthForm(forgotForm);
});

for (const button of document.querySelectorAll('[data-auth-back]')) {
  button.addEventListener('click', () => {
    recoveryToken = '';
    resetForm.reset();
    showAuthForm(auth);
  });
}

function submitRecovery(form, send) {
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const buttons = [...form.querySelectorAll('button')];
    for (const button of buttons) button.disabled = true;
    notice();
    try {
      await send();
    } catch (error) {
      notice(error.message, true);
    } finally {
      for (const button of buttons) button.disabled = false;
    }
  });
}

submitRecovery(forgotForm, async () => {
  const email = field(forgotForm, 'email').value;
  const response = await request('/usuarios/recuperar-contrasena', 'POST', { email });
  notice(response.message);
});

submitRecovery(resetForm, async () => {
  const password = field(resetForm, 'password').value;
  if (password !== field(resetForm, 'confirmation').value) throw new Error('Las contraseñas deben coincidir.');
  const response = await request('/usuarios/restablecer-contrasena', 'POST', { token: recoveryToken, password });
  recoveryToken = '';
  resetForm.reset();
  showAuthForm(auth);
  notice(response.message);
});

const incomingToken = new URLSearchParams(location.hash.slice(1)).get('restablecer');
if (incomingToken !== null) {
  history.replaceState(null, '', location.pathname + location.search);
  if (/^[a-f0-9]{64}$/.test(incomingToken)) {
    recoveryToken = incomingToken;
    showAuthForm(resetForm);
  } else {
    showAuthForm(forgotForm);
    notice('El enlace no es válido. Solicita uno nuevo.', true);
  }
}

function inventoryQuery() {
  const query = new URLSearchParams({ orden: 'vencimiento' });
  for (const [name, value] of new FormData(filters)) {
    if (!value.trim()) continue;
    if (name === 'vence_desde') query.set(name, value + 'T00:00:00.000-05:00');
    else if (name === 'vence_hasta') query.set(name, value + 'T23:59:59.999-05:00');
    else query.set(name, value.trim());
  }
  return '?' + query;
}

function element(tag, value, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = value;
  return node;
}

function action(label, handler, className = 'text-button') {
  const button = element('button', label, className);
  button.type = 'button';
  button.addEventListener('click', handler);
  return button;
}

function formatDate(date) {
  return date && Number.isFinite(Date.parse(date)) ? dateFormat.format(new Date(date)) : 'Sin fecha';
}

function renderInventory(lots, products) {
  const productNames = new Map(products.map(product => [product._id, product.nombre]));
  const table = document.createElement('table');
  table.className = 'inventory-table';
  table.setAttribute('role', 'table');
  table.setAttribute('aria-label', 'Lotes de inventario');
  const labels = ['Producto', 'Cantidad', 'Nevera', 'Vencimiento', 'Estado', 'Acciones'];
  const head = table.createTHead();
  head.setAttribute('role', 'rowgroup');
  const headings = head.insertRow();
  headings.setAttribute('role', 'row');
  for (const label of labels) {
    const heading = element('th', label);
    heading.setAttribute('role', 'columnheader');
    heading.scope = 'col';
    headings.append(heading);
  }
  const body = table.createTBody();
  body.setAttribute('role', 'rowgroup');
  for (const lot of lots) {
    const name = productNames.get(lot.producto_id) || lot.producto_id;
    const row = body.insertRow();
    row.setAttribute('role', 'row');
    const values = [name, numberFormat.format(lot.cantidad) + ' ' + lot.unidad_medida_nombre,
      lot.nevera_id, formatDate(lot.fecha_vencimiento), states[lot.estado] || lot.estado];
    values.forEach((value, index) => {
      const cell = row.insertCell();
      cell.setAttribute('role', 'cell');
      const label = element('span', labels[index], 'cell-label');
      label.setAttribute('aria-hidden', 'true');
      cell.append(label, element('span', value, 'cell-value'));
    });
    const actions = row.insertCell();
    actions.setAttribute('role', 'cell');
    actions.className = 'row-actions';
    actions.append(
      action('Editar', () => openLot(lot)),
      action('Eliminar', event => deleteLot(lot._id, name, event.currentTarget), 'text-button danger')
    );
  }
  results.replaceChildren(table);
}

function renderList(items, isPlan) {
  results.replaceChildren(...items.map(item => {
    const card = document.createElement('article');
    card.className = 'list-item';
    const name = isPlan ? item.nombre_receta : item.mensaje;
    const detail = isPlan ? item.ingrediente_nombre : formatDate(item.fecha);
    card.append(element('strong', name), element('p', detail, 'muted'));
    return card;
  }));
}

async function loadView() {
  if (!token) return;
  const generation = ++viewRequest;
  const view = views[currentView];
  const inventory = currentView === 'inventory';
  const plans = currentView === 'plans';
  results.replaceChildren(element('p', 'Cargando…', 'muted'));
  try {
    const [items, products] = await Promise.all([
      request(view.endpoint + (inventory ? inventoryQuery() : '')),
      inventory ? request('/productos').catch(() => ({ data: [] })) : null
    ]);
    if (generation !== viewRequest) return;
    if (!items.data.length) results.replaceChildren(element('p', view.empty, 'muted'));
    else if (inventory) renderInventory(items.data, products.data);
    else renderList(items.data, plans);
  } catch (error) {
    if (generation !== viewRequest) return;
    const message = element('p', error.message + ' ');
    message.append(action('Reintentar', loadView));
    results.replaceChildren(message);
  }
}

function selectView(view) {
  currentView = view;
  byId('view-title').textContent = views[view].title;
  byId('add').hidden = filters.hidden = view !== 'inventory';
  for (const button of navButtons) {
    if (button.dataset.view === view) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  notice();
  return loadView();
}

for (const button of navButtons) button.addEventListener('click', () => selectView(button.dataset.view));
filters.addEventListener('submit', event => {
  event.preventDefault();
  void loadView();
});
filters.addEventListener('reset', () => queueMicrotask(() => {
  if (currentView === 'inventory') void loadView();
}));

function fillSelect(name, records, label, selected) {
  const select = field(lotForm, name);
  select.replaceChildren(new Option('Selecciona una opción', ''));
  for (const record of records) select.add(new Option(label(record), record._id));
  if (selected && !records.some(record => record._id === selected)) select.add(new Option(selected, selected));
  select.value = selected || '';
}

function lotError(message = '') {
  byId('lot-error').hidden = !message;
  byId('lot-error').textContent = message;
}

async function openLot(lot) {
  if (!token || dialog.open) return;
  const generation = viewRequest;
  const add = byId('add');
  add.disabled = true;
  notice();
  try {
    const [products, units] = await Promise.all([request('/productos'), request('/unidades_medida')]);
    if (generation !== viewRequest || dialog.open) return;
    if (!lot && (!products.data.length || !units.data.length)) {
      throw new Error('Registra al menos un producto y una unidad de medida en Swagger.');
    }
    lotForm.reset();
    lotError();
    editingId = lot?._id || '';
    byId('lot-title').textContent = editingId ? 'Editar lote' : 'Agregar lote';
    fillSelect('producto_id', products.data, product => product.nombre, lot?.producto_id);
    fillSelect('unidad_medida_nombre', units.data, unit => unit._id, lot?.unidad_medida_nombre);
    if (lot) {
      for (const name of ['nevera_id', 'cantidad', 'estado']) field(lotForm, name).value = lot[name];
      if (lot.fecha_vencimiento) {
        const bogota = new Date(Date.parse(lot.fecha_vencimiento) - 5 * 60 * 60 * 1000);
        if (Number.isFinite(bogota.getTime())) field(lotForm, 'fecha_vencimiento').value = bogota.toISOString().slice(0, -1);
      }
    }
    dialog.showModal();
  } catch (error) {
    if (generation === viewRequest) notice(error.message, true);
  } finally {
    add.disabled = false;
  }
}

byId('add').addEventListener('click', () => openLot());
byId('cancel').addEventListener('click', () => dialog.close());
dialog.addEventListener('cancel', event => {
  if (byId('save-lot').disabled) event.preventDefault();
});

lotForm.addEventListener('submit', async event => {
  event.preventDefault();
  const save = byId('save-lot');
  save.disabled = byId('cancel').disabled = true;
  lotError();
  const body = Object.fromEntries(new FormData(lotForm));
  body.cantidad = Number(body.cantidad);
  body.fecha_vencimiento = body.fecha_vencimiento ? body.fecha_vencimiento + '-05:00' : null;
  try {
    const endpoint = editingId ? '/inventario/' + encodeURIComponent(editingId) : '/inventario';
    const response = await request(endpoint, editingId ? 'PUT' : 'POST', body);
    dialog.close();
    notice(response.message);
    await loadView();
  } catch (error) {
    if (dialog.open) lotError(error.message);
    else notice(error.message, true);
  } finally {
    save.disabled = byId('cancel').disabled = false;
  }
});

function deleteLot(id, name, button) {
  if (!token || deleteDialog.open) return;
  byId('delete-product').textContent = name;
  pendingDeletion = { id, button };
  deleteDialog.showModal();
}

deleteDialog.addEventListener('cancel', () => { pendingDeletion = null; });
deleteDialog.querySelector('form').addEventListener('submit', event => {
  event.preventDefault();
  const selection = pendingDeletion;
  pendingDeletion = null;
  deleteDialog.close();
  if (event.submitter?.value === 'confirm' && selection && token) {
    void removeLot(selection.id, selection.button);
  }
});

async function removeLot(id, button) {
  button.disabled = true;
  try {
    const response = await request('/inventario/' + encodeURIComponent(id), 'DELETE');
    notice(response.message);
    await loadView();
  } catch (error) {
    notice(error.message, true);
  } finally {
    button.disabled = false;
  }
}
