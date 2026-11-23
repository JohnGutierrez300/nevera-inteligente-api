import { action, detailList, element, formatDate, group, lotStates, passwordField } from './componentes.js';

export const catalogs = {
  productos: { label: 'Productos', singular: 'producto' },
  categorias: { label: 'Categorías', singular: 'categoría' },
  marcas: { label: 'Marcas', singular: 'marca' },
  unidades_medida: { label: 'Unidades de medida', singular: 'unidad de medida' },
  ingredientes: { label: 'Ingredientes', singular: 'ingrediente' }
};

const notificationTypes = { VENCIMIENTO: 'Vencimiento', STOCK_BAJO: 'Stock bajo', SUGERENCIA: 'Sugerencia' };
const movements = { CREADO: 'Agregado', ACTUALIZADO: 'Actualizado', ELIMINADO: 'Eliminado' };
const percent = new Intl.NumberFormat('es-CO', { style: 'percent', maximumFractionDigits: 1 });
const normalize = text => String(text ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
const reference = value => typeof value === 'string' ? value : value?._id ?? '';

function section(title, button) {
  const toolbar = group('feature-toolbar', element('h2', title));
  if (button) toolbar.append(button);
  const node = element('section', '', 'feature-section');
  node.append(toolbar);
  return node;
}

function row(title, context, actions = [], badge) {
  const article = element('article', '', 'feature-row');
  const content = group('feature-row-content');
  if (badge) content.append(badge);
  content.append(element('h3', title));
  if (context) content.append(element('p', context, 'muted'));
  article.append(content);
  if (actions.length) article.append(group('feature-actions', ...actions));
  return article;
}

function badge(text, state = '') {
  return element('span', text, 'chip ' + state);
}

function list(items, render, empty) {
  const rows = items.length ? items.map(render) : [element('p', empty, 'empty-state')];
  return group('feature-list', ...rows);
}

function labelInput(label, name, attributes = {}) {
  const input = document.createElement('input');
  input.name = name;
  Object.assign(input, attributes);
  const wrapper = element('label', label);
  wrapper.append(input);
  return { wrapper: input.type === 'password' ? passwordField(wrapper, input) : wrapper, input };
}

function labelSelect(label, name, options, current = '') {
  const select = document.createElement('select');
  select.name = name;
  for (const [value, title] of options) select.add(new Option(title, value));
  select.value = current;
  const wrapper = element('label', label);
  wrapper.append(select);
  return { wrapper, select };
}

function home({ account, products, summary, onNavigate, onViewLot }) {
  const names = new Map(products.map(product => [product._id, product.nombre]));
  const { total, expired, soon } = summary;
  const metrics = [
    ['Lotes en nevera', total, 'inventory', ''],
    ['Vencen en 72 horas', soon.length, null, 'warning'],
    ['Lotes vencidos', expired.length, null, 'critical']
  ];
  const heading = section('Hola, ' + (account?.nombre ?? ''), action('Ver inventario', () => onNavigate('inventory'), 'primary'));
  const tiles = metrics.map(([label, count, view, state]) => {
    const className = 'metric-card ' + state;
    const card = view ? action('', () => onNavigate(view), className) : element('div', '', className);
    card.append(element('strong', String(count)), element('span', label));
    return card;
  });
  const alerts = action('', () => onNavigate('alerts'), 'metric-card');
  const unread = element('strong', '—');
  const alertLabel = element('span', 'Consultando avisos…');
  alerts.append(unread, alertLabel);
  heading.append(group('metric-grid', ...tiles, alerts));

  const upcoming = section('Vencimientos');
  const rows = [...expired, ...soon].slice(0, 8);
  upcoming.append(list(rows, lot => {
    const isExpired = expired.includes(lot);
    const product = names.get(lot.producto_id) ?? lot.producto_id;
    return row(product, formatDate(lot.fecha_vencimiento) + ' · ' + lot.nevera_id,
      [action('Ver lote', () => onViewLot(lot._id), 'text-button button-view')],
      badge(isExpired ? 'Vencido' : 'Vence pronto', isExpired ? 'critical' : 'warning'));
  }, 'Tus lotes vigentes no tienen vencimientos próximos.'));

  return {
    node: group('panel-content', heading, upcoming),
    showUnread(count) {
      if (count !== null) unread.textContent = String(count);
      alertLabel.textContent = count === null ? 'Avisos no disponibles' : 'Avisos sin leer';
    }
  };
}

function patternSummary(pattern) {
  const values = [];
  if (Number.isFinite(pattern?.frecuencia_compra_dias)) {
    const days = pattern.frecuencia_compra_dias;
    values.push(days === 1 ? 'Compra cada día' : 'Compra cada ' + days + ' días');
  }
  if (Number.isFinite(pattern?.probabilidad_desperdicio)) {
    values.push(percent.format(pattern.probabilidad_desperdicio) + ' de desperdicio estimado');
  }
  return values.join(' · ') || 'Patrón sin datos registrados';
}

function planEditor({ plan, suggestion, ingredients, patterns }) {
  const name = labelInput('Nombre del plan', 'nombre_receta', {
    required: true, value: plan?.nombre_receta ?? suggestion?.nombre_receta ?? ''
  });
  const ingredient = labelSelect('Ingrediente', 'ingrediente_nombre',
    [['', 'Selecciona un ingrediente'], ...ingredients.map(item => [item._id, item._id])],
    plan?.ingrediente_nombre ?? suggestion?.ingrediente_nombre ?? '');
  ingredient.select.required = true;
  const pattern = labelSelect('Patrón de compra', 'patron_predictivo_id', [
    ['', 'Selecciona un patrón'],
    ...patterns.map((item, index) => [item._id, 'Patrón ' + (index + 1) + ' · ' + patternSummary(item)])
  ], plan?.patron_predictivo_id ?? '');
  const create = labelInput('Crear un patrón para este plan', 'crear_patron', {
    type: 'checkbox', checked: !patterns.length, disabled: !patterns.length
  });
  create.wrapper.className = 'check-field';
  const frequency = labelInput('Frecuencia de compra en días', 'frecuencia_compra_dias', { type: 'number', min: 1, step: 1 });
  const risk = labelInput('Probabilidad de desperdicio (%)', 'probabilidad_desperdicio', { type: 'number', min: 0, max: 100, step: 'any' });
  const newPattern = group('form-row', frequency.wrapper, risk.wrapper);
  function togglePattern() {
    const creating = create.input.checked;
    newPattern.hidden = !creating;
    frequency.input.disabled = risk.input.disabled = !creating;
    pattern.wrapper.hidden = pattern.select.disabled = creating;
    pattern.select.required = !creating;
  }
  togglePattern();
  create.input.addEventListener('change', togglePattern);
  return {
    title: plan ? 'Editar plan de comida' : 'Nuevo plan de comida',
    fields: [name.wrapper, ingredient.wrapper, pattern.wrapper, create.wrapper, newPattern]
  };
}

function planDetails(plan, patterns) {
  const pattern = patterns.find(item => item._id === plan.patron_predictivo_id);
  return {
    title: plan.nombre_receta,
    entries: [['Ingrediente', plan.ingrediente_nombre], ['Patrón de compra', patternSummary(pattern)]]
  };
}

function plans(items, suggestions, { onEdit, onDetail, onDelete, onViewLot }) {
  const plansSection = section('Mis planes', action('Nuevo plan', () => onEdit(), 'primary button-add'));
  plansSection.append(list(items, plan => row(plan.nombre_receta, plan.ingrediente_nombre, [
    action('Ver plan', () => onDetail(plan._id), 'text-button button-view'),
    action('Editar', () => onEdit(plan), 'text-button button-edit'),
    action('Eliminar', () => onDelete(plan), 'text-button danger')
  ]), 'Todavía no tienes planes de comida.'));

  const suggestionsSection = section('Ideas según tu inventario');
  suggestionsSection.append(list(suggestions, idea => row(
    idea.nombre_receta, 'Ingrediente disponible · ' + idea.ingrediente_nombre, [
      action('Ver lote', () => onViewLot(idea.inventario_id), 'text-button button-view'),
      idea.plan_id
        ? action('Ver plan', () => onDetail(idea.plan_id), 'text-button button-view')
        : action('Crear plan', () => onEdit(null, idea), 'secondary button-add')
    ]
  ), 'Asocia un ingrediente para sugerencias a un lote con existencias en Inventario.'));
  return group('panel-content', plansSection, suggestionsSection);
}

function alerts(items, { pagina, hay_siguiente }, filters, { onToggle, onDelete, onViewLot, onFilter, onPage }) {
  const type = labelSelect('Tipo', 'tipo', [['', 'Todos'], ...Object.entries(notificationTypes)], filters.tipo);
  const read = labelSelect('Estado', 'lectura', [['', 'Todos'], ['sin_leer', 'Sin leer'], ['leidas', 'Leídas']], filters.lectura);
  function apply() {
    filters.tipo = type.select.value;
    filters.lectura = read.select.value;
    onFilter();
  }
  const results = list(items, item => {
    const estado = item.desactualizada ? 'Desactualizada' : item.leida ? 'Leída' : 'Sin leer';
    const context = [formatDate(item.fecha), item.nevera_id, item.fecha_vencimiento &&
      ('Vence ' + formatDate(item.fecha_vencimiento)), estado].filter(Boolean).join(' · ');
    const buttons = [];
    if (!item.desactualizada) {
      if (item.inventario_id) buttons.push(action('Ver lote', () => onViewLot(item.inventario_id), 'text-button button-view'));
      const toggle = action(item.leida ? 'Marcar sin leer' : 'Marcar como leída',
        () => onToggle(item, busy => { toggle.disabled = busy; }));
      buttons.push(toggle);
    }
    buttons.push(action('Eliminar', () => onDelete(item._id), 'text-button danger'));
    const chipState = !item.desactualizada && item.tipo === 'VENCIMIENTO' ? 'warning' : '';
    return row(item.mensaje, context, buttons, badge(notificationTypes[item.tipo] ?? 'Aviso', chipState));
  }, 'No hay notificaciones para estos filtros.');
  type.select.addEventListener('change', apply);
  read.select.addEventListener('change', apply);
  const previous = action('Anterior', () => onPage(-1), 'secondary');
  const next = action('Siguiente', () => onPage(1), 'secondary');
  previous.disabled = pagina === 1;
  next.disabled = !hay_siguiente;
  const pagination = group('inventory-pagination', previous, element('span', 'Página ' + pagina), next);
  pagination.hidden = previous.disabled && next.disabled;
  pagination.setAttribute('aria-label', 'Paginación de notificaciones');
  return group('panel-content', group('feature-filters', type.wrapper, read.wrapper), results, pagination);
}

function historyName(log, names) {
  const product = log.snapshot_datos?.producto_id;
  return product ? names.get(product) ?? 'Producto ' + product : 'Lote de inventario';
}

function history(items, products, hasMore, { onDetail, onMore }) {
  const names = new Map(products.map(product => [product._id, product.nombre]));
  const draw = item => row(historyName(item, names), formatDate(item.fecha) + ' · ' + item.detalles,
    [action('Ver detalle', () => onDetail(item._id), 'text-button button-view')],
    badge(movements[item.accion] ?? item.accion, item.accion === 'ELIMINADO' ? 'critical' : ''));
  const timeline = list(items, draw, 'Todavía no hay movimientos en tu inventario.');
  const more = action('Cargar más movimientos', onMore, 'secondary');
  more.hidden = !hasMore;
  return {
    node: group('panel-content', timeline, group('feature-actions', more)),
    get connected() { return more.isConnected; },
    setBusy(busy) { more.disabled = busy; },
    append(items, hasMore) {
      timeline.append(...items.map(draw));
      more.hidden = !hasMore;
    },
    details(entry) {
      const lot = entry.snapshot_datos ?? {};
      return {
        title: historyName(entry, names),
        entries: [
          ['Movimiento', movements[entry.accion] ?? entry.accion],
          ['Fecha', formatDate(entry.fecha)],
          ['Detalle', entry.detalles],
          ['Nevera', lot.nevera_id ?? 'Sin dato'],
          ['Cantidad registrada', lot.cantidad == null ? 'Sin dato' : lot.cantidad + ' ' + lot.unidad_medida_nombre],
          ['Estado registrado', lotStates[lot.estado] ?? 'Sin dato'],
          ['Vencimiento del lote', formatDate(lot.fecha_vencimiento)]
        ]
      };
    }
  };
}

function catalogEditor(kind, { brands, categories } = {}) {
  const name = labelInput('Nombre', 'nombre', { required: true });
  const fields = [name.wrapper];
  if (kind === 'productos') {
    for (const [label, key, options] of [['Marca', 'marca_nombre', brands], ['Categoría', 'categoria_nombre', categories]]) {
      const control = labelSelect(label, key, [['', 'Selecciona una opción'], ...options.map(item => [item._id, item._id])]);
      control.select.required = true;
      fields.push(control.wrapper);
    }
  }
  if (kind === 'unidades_medida') fields.push(labelInput('Abreviatura', 'abreviatura', { required: true }).wrapper);
  return { title: 'Agregar ' + catalogs[kind].singular, fields };
}

function catalog(kind, items, admin, { onSelect, onAdd, onDelete }) {
  const meta = catalogs[kind];
  const tabs = group('panel-tabs');
  for (const [key, entry] of Object.entries(catalogs)) {
    const tab = action(entry.label, () => onSelect(key), 'secondary');
    tab.setAttribute('aria-pressed', String(key === kind));
    tabs.append(tab);
  }
  const body = section(meta.label, admin ? action('Agregar ' + meta.singular, onAdd, 'primary button-add') : null);
  const search = labelInput('Buscar en ' + meta.label.toLowerCase(), 'busqueda', { type: 'search' });
  const filters = group('feature-filters', search.wrapper);
  const results = group('feature-list');
  const filtersBy = [];
  if (kind === 'productos') {
    for (const [label, key] of [['Marca', 'marca_nombre'], ['Categoría', 'categoria_nombre']]) {
      const options = [...new Set(items.map(item => reference(item[key])).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
      const control = labelSelect(label, key, [['', 'Todas'], ...options.map(value => [value, value])]);
      control.select.addEventListener('change', apply);
      filtersBy.push([key, control.select]);
      filters.append(control.wrapper);
    }
  }
  function apply() {
    const visible = items.filter(item =>
      normalize(item.nombre ?? item._id).includes(normalize(search.input.value)) &&
      filtersBy.every(([key, select]) => !select.value || reference(item[key]) === select.value)
    );
    const content = list(visible, item => {
      const name = item.nombre ?? item._id;
      const description = [reference(item.marca_nombre), reference(item.categoria_nombre), item.abreviatura].filter(Boolean).join(' · ');
      const buttons = admin ? [action('Eliminar', () => onDelete(item._id, name), 'text-button danger')] : [];
      return row(name, description, buttons);
    }, 'No hay resultados en este catálogo.');
    results.replaceChildren(...content.childNodes);
  }
  search.input.addEventListener('input', apply);
  apply();
  body.append(filters, results);
  return group('panel-content', tabs, body);
}

function profileEditor(account) {
  const name = labelInput('Usuario', 'nombre', { required: true, value: account.nombre, autocomplete: 'username' });
  const email = labelInput('Correo', 'email', { required: true, value: account.email, type: 'email', autocomplete: 'email' });
  const password = labelInput('Contraseña actual (para cambiar el correo)', 'password_actual', {
    type: 'password', autocomplete: 'current-password'
  });
  return { title: 'Editar perfil', fields: [name.wrapper, email.wrapper, password.wrapper] };
}

function passwordEditor() {
  const current = labelInput('Contraseña actual', 'password_actual', { type: 'password', required: true, autocomplete: 'current-password' });
  const next = labelInput('Contraseña nueva', 'password', { type: 'password', minLength: 12, maxLength: 1024, required: true, autocomplete: 'new-password' });
  const confirm = labelInput('Confirma la contraseña nueva', 'confirmacion', { type: 'password', required: true, autocomplete: 'new-password' });
  const hint = element('p', 'Usa al menos 12 caracteres, con mayúsculas, minúsculas, números y símbolos.', 'muted');
  return { title: 'Cambiar contraseña', fields: [hint, current.wrapper, next.wrapper, confirm.wrapper] };
}

function profile(account, { onEdit, onChangePassword, onDelete }) {
  const heading = section('Perfil', action('Editar perfil', onEdit, 'primary button-edit'));
  const entries = [['Usuario', account.nombre], ['Correo', account.email], ['ID de cuenta', account._id]];
  if (account.catalogo_admin) entries.push(['Permiso', 'Administrador del catálogo']);
  heading.append(detailList(entries), group('feature-actions',
    action('Cambiar contraseña', onChangePassword, 'secondary'),
    action('Eliminar mi cuenta', onDelete, 'text-button danger')));
  return group('panel-content', heading);
}

export function createDashboardView() {
  const filters = { tipo: '', lectura: '' };
  return {
    home, plans, planEditor, planDetails, history, catalog, catalogEditor, profile, profileEditor, passwordEditor,
    alerts: (items, pagination, actions) => alerts(items, pagination, filters, actions),
    getAlertFilters: () => ({ ...filters }),
    resetAlertFilters() {
      filters.tipo = '';
      filters.lectura = '';
    }
  };
}
