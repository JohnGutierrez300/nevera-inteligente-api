export const byId = id => document.getElementById(id);
export const field = (form, name) => form.elements.namedItem(name);
export const formValues = form => Object.fromEntries(new FormData(form));
export const lotStates = { EN_NEVERA: 'En nevera', CONSUMIDO: 'Consumido', DESPERDICIADO: 'Desperdiciado' };

const dateFormat = new Intl.DateTimeFormat('es-CO', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Bogota'
});

export function formatDate(date) {
  return date && Number.isFinite(Date.parse(date)) ? dateFormat.format(new Date(date)) : 'Sin fecha';
}

export function element(tag, value, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = value;
  return node;
}

export function action(label, handler, className = 'text-button') {
  const button = element('button', label, className);
  button.type = 'button';
  button.addEventListener('click', handler);
  return button;
}

export function group(className, ...children) {
  const node = element('div', '', className);
  node.append(...children);
  return node;
}

export function detailList(entries) {
  const list = element('dl', '', 'detail-list');
  for (const [label, value] of entries) list.append(element('dt', label), element('dd', value));
  return list;
}

export function errorMessage(error) {
  const dependencies = error.data?.dependencias;
  if (error.status !== 409 || !Array.isArray(dependencies) || !dependencies.length) return error.message;
  const related = dependencies.map(({ coleccion, registros }) => {
    const name = coleccion === 'meal_preps' ? 'planes de comida' : coleccion.replaceAll('_', ' ');
    return `${registros} en ${name}`;
  });
  return `${error.message}. Registros vinculados (${related.join(', ')}).`;
}

export function notice(value = '', isError = value instanceof Error) {
  const status = byId('notice');
  status.textContent = value instanceof Error ? errorMessage(value) : value;
  status.classList.toggle('error', isError);
  status.hidden = !value;
}

function setPasswordVisibility(input, toggle, visible) {
  input.type = visible ? 'text' : 'password';
  toggle.setAttribute('aria-pressed', String(visible));
  toggle.title = visible ? 'Ocultar contraseña' : 'Mostrar contraseña';
}

export function passwordField(label, input) {
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

export function maskPasswords(form) {
  for (const toggle of form.querySelectorAll('.password-toggle[aria-pressed="true"]')) {
    setPasswordVisibility(toggle.parentElement.querySelector('input'), toggle, false);
  }
}

export function bindPasswords(form) {
  for (const input of form.querySelectorAll('input[type="password"]')) passwordField(input.closest('label'), input);
  form.addEventListener('submit', () => maskPasswords(form), true);
  form.addEventListener('reset', () => maskPasswords(form));
}
