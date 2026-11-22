import { createDashboard } from './dashboard.js';

const byId = id => document.getElementById(id);
const auth = byId('auth');
const forgotForm = byId('forgot-form');
const resetForm = byId('reset-form');
const filters = byId('filters');
const results = byId('results');
const inventoryPagination = byId('inventory-pagination');
const previousPage = byId('inventory-previous');
const nextPage = byId('inventory-next');
const dialog = byId('lot-dialog');
const deleteDialog = byId('delete-dialog');
const updateDialog = byId('update-dialog');
const detailDialog = byId('detail-dialog');
const editorDialog = byId('editor-dialog');
const lotForm = byId('lot-form');
const navigation = byId('navigation');
const logoutButton = byId('logout');
const mobileMenu = byId('mobile-menu');
const mobileMenuToggle = byId('mobile-menu-toggle');
const mobileMenuContent = byId('mobile-menu-content');
const mobileViewport = matchMedia('(max-width: 44rem), (max-width: 62rem) and (max-height: 32rem) and (hover: none) and (pointer: coarse)');
const navButtons = [...document.querySelectorAll('[data-view]')];
const views = {
  home: 'Inicio',
  inventory: 'Inventario',
  plans: 'Planes de comida',
  alerts: 'Notificaciones',
  history: 'Historial',
  catalog: 'Catálogo',
  profile: 'Mi cuenta'
};
const states = { EN_NEVERA: 'En nevera', CONSUMIDO: 'Consumido', DESPERDICIADO: 'Desperdiciado' };
const dateFormat = new Intl.DateTimeFormat('es-CO', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Bogota'
});
const numberFormat = new Intl.NumberFormat('es-CO', { maximumSignificantDigits: 15 });
const field = (form, name) => form.elements.namedItem(name);
let user = null;
let registering = false;
let recoveryToken = '';
let currentView = 'home';
let viewRequest = 0;
let inventoryPage = 1;
let inventoryFilters = new URLSearchParams();
let editingId = '';
let pendingConfirmation = null;
let updateFeedbackTimer;

async function request(path, method = 'GET', body) {
  const requestUser = user;
  let response;
  try {
    response = await fetch('/api' + path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch {
    throw new Error('No se pudo conectar con la API. Intenta de nuevo.');
  }
  const payload = await response.json().catch(() => null);
  if (response.status === 401 && requestUser && requestUser === user) {
    endSession('Tu sesión venció. Vuelve a iniciar sesión.');
  }
  if (!response.ok || payload?.success !== true) {
    const error = new Error(payload?.message || 'La API no pudo completar la solicitud.');
    error.status = response.status;
    error.data = payload?.data;
    const dependencies = error.data?.dependencias;
    if (error.status === 409 && Array.isArray(dependencies) && dependencies.length) {
      const related = dependencies.map(({ coleccion, registros }) => {
        const name = coleccion === 'meal_preps' ? 'planes de comida' : coleccion.replaceAll('_', ' ');
        return `${registros} en ${name}`;
      });
      error.message += `. Registros vinculados (${related.join(', ')}).`;
    }
    throw error;
  }
  return payload;
}

function notice(message = '', error = false) {
  const element = byId('notice');
  element.textContent = message;
  element.classList.toggle('error', error);
  element.hidden = !message;
}

function closeUpdateFeedback() {
  clearTimeout(updateFeedbackTimer);
  if (updateDialog.open) updateDialog.close();
}

function showUpdateFeedback() {
  clearTimeout(updateFeedbackTimer);
  updateDialog.showModal();
  updateFeedbackTimer = setTimeout(closeUpdateFeedback, 3000);
}

function toggleRegistration() {
  maskPasswords(auth);
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
  byId('session-check').hidden = true;
  byId('login').hidden = active;
  for (const control of [byId('dashboard'), navigation, logoutButton, mobileMenuToggle]) control.hidden = !active;
}

function endSession(message = '') {
  user = null;
  viewRequest++;
  filters.reset();
  inventoryPagination.hidden = true;
  results.replaceChildren();
  if (dialog.open) dialog.close();
  if (deleteDialog.open) deleteDialog.close();
  if (detailDialog.open) detailDialog.close();
  if (editorDialog.open) editorDialog.close();
  closeMobileMenu();
  pendingConfirmation = null;
  closeUpdateFeedback();
  unreadCount([]);
  showSession(false);
  showAuthForm(auth, false);
  notice(message);
}

async function signOut() {
  logoutButton.disabled = true;
  try {
    await request('/usuarios/logout', 'POST');
    endSession('Sesión cerrada.');
  } catch (error) {
    if (user) notice(error.message, true);
  } finally {
    logoutButton.disabled = false;
  }
}

function startSession(profile, view = 'home') {
  if (!profile?._id) throw new Error('No se pudo obtener el perfil de la sesión.');
  user = profile;
  showSession(true);
  return selectView(view);
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
    const response = await request('/usuarios/login', 'POST', { ...credentials, sesion_web: true });
    await startSession(response.data?.perfil);
  } catch (error) {
    notice(error.message, true);
  } finally {
    field(auth, 'password').value = '';
    submit.disabled = toggle.disabled = forgotToggle.disabled = false;
  }
});

byId('register-toggle').addEventListener('click', toggleRegistration);
logoutButton.addEventListener('click', signOut);

function showAuthForm(form, focus = true) {
  for (const candidate of [auth, forgotForm, resetForm]) {
    candidate.hidden = candidate !== form;
    if (candidate.hidden) maskPasswords(candidate);
  }
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
  showSession(false);
  if (/^[a-f0-9]{64}$/.test(incomingToken)) {
    recoveryToken = incomingToken;
    showAuthForm(resetForm);
  } else {
    showAuthForm(forgotForm);
    notice('El enlace no es válido. Solicita uno nuevo.', true);
  }
}

function applyInventoryFilters() {
  const query = new URLSearchParams();
  for (const [name, value] of new FormData(filters)) {
    if (!value.trim()) continue;
    if (name === 'vence_desde') query.set(name, value + 'T00:00:00.000-05:00');
    else if (name === 'vence_hasta') query.set(name, value + 'T23:59:59.999-05:00');
    else query.set(name, value.trim());
  }
  inventoryFilters = query;
  inventoryPage = 1;
  if (currentView === 'inventory') void loadView();
}

function inventoryQuery() {
  const query = new URLSearchParams(inventoryFilters);
  query.set('orden', 'vencimiento');
  query.set('pagina', inventoryPage);
  query.set('limite', 20);
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

function setPasswordVisibility(input, toggle, visible) {
  input.type = visible ? 'text' : 'password';
  toggle.setAttribute('aria-pressed', String(visible));
  toggle.title = visible ? 'Ocultar contraseña' : 'Mostrar contraseña';
}

function passwordField(label, input) {
  const wrapper = element('div', '', 'password-field');
  const toggle = action('', () => setPasswordVisibility(input, toggle, input.type === 'password'), 'password-toggle');
  const labelText = label.textContent.trim().toLowerCase();
  const description = labelText.startsWith('confirma') ? 'confirmación de contraseña' : labelText;
  toggle.setAttribute('aria-label', 'Mostrar ' + description);
  const icon = element('span', '', 'password-eye');
  icon.setAttribute('aria-hidden', 'true');
  toggle.append(icon);
  input.spellcheck = false;
  input.autocapitalize = 'none';
  input.setAttribute('autocorrect', 'off');
  setPasswordVisibility(input, toggle, false);
  label.before(wrapper);
  wrapper.append(label, toggle);
  return wrapper;
}

function maskPasswords(form) {
  for (const toggle of form.querySelectorAll('.password-toggle[aria-pressed="true"]')) {
    setPasswordVisibility(toggle.parentElement.querySelector('input'), toggle, false);
  }
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
    const buttons = element('div', '', 'inventory-actions');
    buttons.append(
      action('Ver lote', () => openLotDetail(lot._id), 'text-button button-view'),
      action('Editar', () => openLot(lot), 'text-button button-edit'),
      action('Eliminar', event => deleteLot(lot._id, name, event.currentTarget), 'text-button danger')
    );
    actions.append(buttons);
  }
  results.replaceChildren(table);
}

async function loadView() {
  if (!user) return;
  const generation = ++viewRequest;
  const view = currentView;
  const inventory = view === 'inventory';
  if (!inventory) inventoryPagination.hidden = true;
  previousPage.disabled = nextPage.disabled = true;
  results.replaceChildren(element('p', 'Cargando…', 'muted'));
  try {
    if (!inventory) {
      const page = await dashboard.load(view);
      if (generation === viewRequest) results.replaceChildren(page);
      return;
    }
    const [items, products] = await Promise.all([
      request('/inventario' + inventoryQuery()),
      request('/productos').catch(() => ({ data: [] }))
    ]);
    if (generation !== viewRequest) return;
    if (!items.data.length) results.replaceChildren(element('p', 'No hay lotes para mostrar.', 'muted'));
    else renderInventory(items.data, products.data);
    const page = items.paginacion;
    inventoryPagination.hidden = !page || (page.pagina === 1 && !page.hay_siguiente);
    if (page) {
      byId('inventory-page').textContent = 'Página ' + page.pagina;
      previousPage.disabled = page.pagina <= 1;
      nextPage.disabled = !page.hay_siguiente;
    }
  } catch (error) {
    if (generation !== viewRequest) return;
    inventoryPagination.hidden = true;
    const message = element('p', error.message + ' ');
    message.append(action('Reintentar', loadView));
    results.replaceChildren(message);
  }
}

function selectView(view) {
  currentView = view;
  const url = new URL(location.href);
  if (view === 'home') url.searchParams.delete('vista');
  else url.searchParams.set('vista', view);
  if (url.href !== location.href) history.replaceState(history.state, '', url);
  byId('view-title').textContent = views[view];
  byId('add').hidden = filters.hidden = view !== 'inventory';
  for (const button of navButtons) {
    if (button.dataset.view === view) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  notice();
  return loadView();
}

function restoreSidebarMenu() {
  if (mobileMenu.open || navigation.parentElement !== mobileMenuContent) return;
  mobileMenu.before(navigation, logoutButton);
  mobileMenuToggle.setAttribute('aria-expanded', 'false');
}

function closeMobileMenu() {
  if (mobileMenu.open) mobileMenu.close();
  restoreSidebarMenu();
}

mobileMenuToggle.addEventListener('click', () => {
  if (!user || !mobileViewport.matches || mobileMenu.open) return;
  mobileMenuContent.append(navigation, logoutButton);
  mobileMenu.showModal();
  mobileMenuToggle.setAttribute('aria-expanded', 'true');
});
byId('mobile-menu-close').addEventListener('click', closeMobileMenu);
mobileMenu.addEventListener('close', restoreSidebarMenu);
mobileMenu.addEventListener('click', event => {
  if (event.target !== mobileMenu) return;
  const bounds = mobileMenu.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right ||
      event.clientY < bounds.top || event.clientY > bounds.bottom) closeMobileMenu();
});
mobileViewport.addEventListener('change', event => { if (!event.matches) closeMobileMenu(); });

for (const button of navButtons) button.addEventListener('click', () => {
  closeMobileMenu();
  void selectView(button.dataset.view);
});
filters.addEventListener('submit', event => {
  event.preventDefault();
  applyInventoryFilters();
});
filters.addEventListener('reset', () => queueMicrotask(applyInventoryFilters));
previousPage.addEventListener('click', () => {
  inventoryPage--;
  void loadView();
});
nextPage.addEventListener('click', () => {
  inventoryPage++;
  void loadView();
});

function fillSelect(name, records, label, selected, placeholder = 'Selecciona una opción') {
  const select = field(lotForm, name);
  select.replaceChildren(new Option(placeholder, ''));
  for (const record of records) select.add(new Option(label(record), record._id));
  if (selected && !records.some(record => record._id === selected)) select.add(new Option(selected, selected));
  select.value = selected || '';
}

function showLotError(id, error) {
  const message = byId(id);
  message.hidden = !error;
  message.textContent = error?.message ?? '';
  const conflictId = error?.status === 409 && error.data?.inventario_id;
  if (conflictId) {
    message.append(' ', action('Ver lote existente', () => {
      message.closest('dialog').close();
      void openLotDetail(conflictId);
    }, 'text-button button-view'));
  }
}

async function openLot(lot) {
  if (!user || dialog.open) return;
  const generation = viewRequest;
  const add = byId('add');
  add.disabled = true;
  notice();
  try {
    const [products, units, ingredients] = await Promise.all([
      request('/productos'), request('/unidades_medida'), request('/ingredientes')
    ]);
    if (generation !== viewRequest || dialog.open) return;
    if (!lot && (!products.data.length || !units.data.length)) {
      throw new Error('El catálogo necesita al menos un producto y una unidad de medida. Puedes consultarlo en Catálogo.');
    }
    lotForm.reset();
    showLotError('lot-error');
    editingId = lot?._id || '';
    byId('lot-title').textContent = editingId ? 'Editar lote' : 'Agregar lote';
    fillSelect('producto_id', products.data, product => product.nombre, lot?.producto_id);
    fillSelect('unidad_medida_nombre', units.data, unit => unit._id, lot?.unidad_medida_nombre);
    fillSelect('ingrediente_nombre', ingredients.data, ingredient => ingredient._id, lot?.ingrediente_nombre, 'Sin ingrediente');
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

function showDetails(title, entries, buttons = []) {
  if (!user || detailDialog.open) return;
  const list = document.createElement('dl');
  list.className = 'detail-list';
  for (const [label, value] of entries) {
    list.append(element('dt', label), element('dd', value));
  }
  const content = byId('detail-content');
  content.replaceChildren(list);
  if (buttons.length) {
    const actions = element('div', '', 'detail-actions');
    actions.append(...buttons);
    content.append(actions);
  }
  showLotError('detail-error');
  byId('detail-title').textContent = title;
  detailDialog.showModal();
}

async function changeLotStatus(id, status) {
  const buttons = [...detailDialog.querySelectorAll('button')];
  for (const button of buttons) button.disabled = true;
  showLotError('detail-error');
  try {
    const response = await request('/inventario/' + encodeURIComponent(id), 'PUT', { estado: status });
    detailDialog.close();
    notice(response.message);
    await loadView();
  } catch (error) {
    if (detailDialog.open) {
      showLotError('detail-error', error);
    } else if (user) {
      notice(error.message, true);
    }
  } finally {
    for (const button of buttons) button.disabled = false;
  }
}

detailDialog.addEventListener('cancel', event => {
  if (detailDialog.querySelector('.detail-actions button:disabled')) event.preventDefault();
});

async function openLotDetail(id) {
  if (!user || detailDialog.open) return;
  const generation = viewRequest;
  try {
    const [item, products] = await Promise.all([
      request('/inventario/' + encodeURIComponent(id)), request('/productos').catch(() => ({ data: [] }))
    ]);
    if (generation !== viewRequest) return;
    const lot = item.data;
    const name = products.data.find(product => product._id === lot.producto_id)?.nombre ?? lot.producto_id;
    const buttons = [action('Editar lote', () => {
      detailDialog.close();
      void openLot(lot);
    }, 'text-button button-edit')];
    if (lot.estado === 'EN_NEVERA') {
      buttons.push(
        action('Marcar consumido', () => changeLotStatus(lot._id, 'CONSUMIDO'), 'primary'),
        action('Marcar desperdiciado', () => changeLotStatus(lot._id, 'DESPERDICIADO'), 'secondary')
      );
    }
    showDetails(name, [
      ['Cantidad', numberFormat.format(lot.cantidad) + ' ' + lot.unidad_medida_nombre],
      ['Nevera', lot.nevera_id],
      ['Vencimiento', formatDate(lot.fecha_vencimiento)],
      ['Estado', states[lot.estado] ?? lot.estado],
      ['Ingrediente para sugerencias', lot.ingrediente_nombre || 'Sin ingrediente']
    ], buttons);
  } catch (error) {
    if (generation === viewRequest) {
      const unavailable = error.data?.recurso === 'Inventario';
      notice(unavailable ? 'Este lote ya no está disponible en tu inventario.' : error.message, true);
    }
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
  showLotError('lot-error');
  const body = Object.fromEntries(new FormData(lotForm));
  const lotId = editingId;
  body.cantidad = Number(body.cantidad);
  body.fecha_vencimiento = body.fecha_vencimiento ? body.fecha_vencimiento + '-05:00' : null;
  body.ingrediente_nombre = body.ingrediente_nombre || null;
  try {
    const endpoint = lotId ? '/inventario/' + encodeURIComponent(lotId) : '/inventario';
    const response = await request(endpoint, lotId ? 'PUT' : 'POST', body);
    dialog.close();
    if (lotId) {
      notice();
      showUpdateFeedback();
    } else {
      notice(response.message);
    }
    await loadView();
  } catch (error) {
    if (dialog.open) showLotError('lot-error', error);
    else notice(error.message, true);
  } finally {
    save.disabled = byId('cancel').disabled = false;
  }
});

function deleteLot(id, name, button) {
  const message = document.createDocumentFragment();
  message.append('Se eliminará el lote de ', element('strong', name), '. Esta acción no se puede deshacer.');
  confirmAction('¿Estás seguro de eliminar este lote?', message, 'Eliminar lote', () => removeLot(id, button));
}

function confirmAction(title, message, label, onConfirm) {
  if (!user || deleteDialog.open) return;
  byId('delete-title').textContent = title;
  byId('delete-description').replaceChildren(message);
  deleteDialog.querySelector('[value="confirm"]').textContent = label;
  pendingConfirmation = onConfirm;
  deleteDialog.showModal();
}

deleteDialog.addEventListener('cancel', () => { pendingConfirmation = null; });
deleteDialog.querySelector('form').addEventListener('submit', event => {
  event.preventDefault();
  const confirm = pendingConfirmation;
  pendingConfirmation = null;
  deleteDialog.close();
  if (event.submitter?.value === 'confirm' && confirm && user) {
    void confirm();
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

function unreadCount(notifications) {
  const count = notifications.filter(item => !item.leida).length;
  const badge = byId('unread-count');
  badge.hidden = count === 0;
  badge.textContent = count > 99 ? '99+' : String(count);
  badge.setAttribute('aria-label', `${count} notificaciones sin leer`);
}

const dashboard = createDashboard({
  request, element, action, passwordField, formatDate, notice, confirmAction, showDetails, openLotDetail,
  getProfile: () => user,
  reload: loadView,
  navigate: selectView,
  onNotifications: unreadCount,
  onAccountDeleted: endSession,
  onProfileSaved(profile, passwordChanged) {
    if (passwordChanged) {
      endSession('Contraseña cambiada. Inicia sesión con la nueva contraseña.');
    } else if (user) {
      user = { ...user, ...profile };
    }
  }
});

for (const form of [auth, resetForm, byId('editor-form')]) {
  for (const input of form.querySelectorAll('input[type="password"]')) {
    passwordField(input.closest('label'), input);
  }
  form.addEventListener('submit', () => maskPasswords(form), true);
  form.addEventListener('reset', () => maskPasswords(form));
}

editorDialog.addEventListener('close', () => {
  if (editorDialog.open) return;
  const form = byId('editor-form');
  maskPasswords(form);
  for (const input of form.querySelectorAll('.password-field input')) input.value = '';
});

async function restoreSession() {
  const retry = byId('retry-session');
  const status = byId('session-status');
  retry.hidden = true;
  status.textContent = 'Comprobando tu sesión…';
  try {
    const response = await request('/usuarios/me');
    const view = new URLSearchParams(location.search).get('vista');
    await startSession(response.data, Object.hasOwn(views, view) ? view : 'home');
  } catch (error) {
    if (error.status === 401) {
      showSession(false);
    } else {
      status.textContent = 'No se pudo comprobar tu sesión. Inténtalo de nuevo.';
      retry.hidden = false;
    }
  }
}

async function refreshUnread() {
  const active = user;
  if (!active || document.hidden) return;
  try {
    const response = await request('/notificaciones');
    if (user === active) unreadCount(response.data);
  } catch {
    // The inbox retries on navigation if background refresh fails.
  }
}

window.addEventListener('focus', refreshUnread);
setInterval(refreshUnread, 60 * 1000);
byId('retry-session').addEventListener('click', restoreSession);
if (incomingToken === null) void restoreSession();
