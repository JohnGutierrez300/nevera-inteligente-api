const catalogos = {
  productos: { label: 'Productos', singular: 'producto' },
  categorias: { label: 'Categorías', singular: 'categoría' },
  marcas: { label: 'Marcas', singular: 'marca' },
  unidades_medida: { label: 'Unidades de medida', singular: 'unidad de medida' },
  ingredientes: { label: 'Ingredientes', singular: 'ingrediente' }
};

const tipoAviso = { VENCIMIENTO: 'Vencimiento', STOCK_BAJO: 'Stock bajo', SUGERENCIA: 'Sugerencia' };
const movimiento = { CREADO: 'Agregado', ACTUALIZADO: 'Actualizado', ELIMINADO: 'Eliminado' };
const estadoLote = { EN_NEVERA: 'En nevera', CONSUMIDO: 'Consumido', DESPERDICIADO: 'Desperdiciado' };
const porcentaje = new Intl.NumberFormat('es-CO', { style: 'percent', maximumFractionDigits: 1 });
const normalizar = text => String(text ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
const referencia = value => typeof value === 'string' ? value : value?._id ?? '';
const rutaId = (path, id) => path + '/' + encodeURIComponent(id);
const paginaHistorial = 20;

export function createDashboard({
  request, element, action, formatDate, notice, confirmAction, showDetails, openLotDetail,
  getProfile, reload, navigate, onNotifications, onProfileSaved
}) {
  const editor = document.getElementById('editor-dialog');
  const form = document.getElementById('editor-form');
  const submit = document.getElementById('editor-save');
  const cancel = document.getElementById('editor-cancel');
  const formError = document.getElementById('editor-error');
  let catalog = 'productos';
  let alertType = '';
  let alertRead = '';

  const data = async path => (await request(path)).data;

  function group(className, ...children) {
    const node = element('div', '', className);
    node.append(...children);
    return node;
  }

  function section(title, button) {
    const node = element('section', '', 'feature-section');
    const toolbar = group('feature-toolbar', element('h2', title));
    if (button) toolbar.append(button);
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
    return { wrapper, input };
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

  function showFormError(message = '') {
    formError.hidden = !message;
    formError.textContent = message;
  }

  cancel.addEventListener('click', () => editor.close());
  editor.addEventListener('cancel', event => { if (submit.disabled) event.preventDefault(); });

  function openEditor(title, fields, save) {
    if (!getProfile() || editor.open) return;
    document.getElementById('editor-title').textContent = title;
    document.getElementById('editor-fields').replaceChildren(...fields);
    showFormError();
    form.onsubmit = async event => {
      event.preventDefault();
      submit.disabled = cancel.disabled = true;
      showFormError();
      try {
        const message = await save(Object.fromEntries(new FormData(form)));
        if (!editor.open) return;
        editor.close();
        notice(message);
        await reload();
      } catch (error) {
        if (editor.open) showFormError(error.message);
      } finally {
        submit.disabled = cancel.disabled = false;
      }
    };
    editor.showModal();
  }

  async function mutate(path, method, body, button) {
    if (button) button.disabled = true;
    try {
      const response = await request(path, method, body);
      notice(response.message);
      await reload();
    } catch (error) {
      if (getProfile()) notice(error.message, true);
    } finally {
      if (button) button.disabled = false;
    }
  }

  function remove(title, message, label, path) {
    confirmAction(title, message + ' Esta acción no se puede deshacer.', label, () => mutate(path, 'DELETE'));
  }

  async function getNotifications() {
    const profile = getProfile();
    const items = await data('/notificaciones');
    if (profile && profile === getProfile()) onNotifications(items);
    return items;
  }

  async function home() {
    const [lots, products, notifications] = await Promise.all([
      data('/inventario?estado=EN_NEVERA&orden=vencimiento'),
      data('/productos').catch(() => []),
      getNotifications()
    ]);
    const names = new Map(products.map(product => [product._id, product.nombre]));
    const now = Date.now();
    const limit = now + 72 * 60 * 60 * 1000;
    const active = lots.filter(lot => lot.cantidad > 0);
    const expired = active.filter(lot => lot.fecha_vencimiento && Date.parse(lot.fecha_vencimiento) < now);
    const soon = active.filter(lot => {
      const date = Date.parse(lot.fecha_vencimiento);
      return date >= now && date <= limit;
    });
    const metrics = [
      ['Lotes en nevera', active.length, 'inventory', ''],
      ['Vencen en 72 horas', soon.length, null, 'warning'],
      ['Lotes vencidos', expired.length, null, 'critical'],
      ['Avisos sin leer', notifications.filter(item => !item.leida).length, 'alerts', '']
    ];
    const heading = section('Hola, ' + (getProfile()?.nombre ?? ''), action('Ver inventario', () => navigate('inventory'), 'primary'));
    const tiles = metrics.map(([label, count, view, state]) => {
      const className = 'metric-card ' + state;
      const card = view ? action('', () => navigate(view), className) : element('div', '', className);
      card.append(element('strong', String(count)), element('span', label));
      return card;
    });
    heading.append(group('metric-grid', ...tiles));

    const upcoming = section('Vencimientos');
    const rows = [...expired, ...soon].slice(0, 8);
    upcoming.append(list(rows, lot => {
      const isExpired = Date.parse(lot.fecha_vencimiento) < now;
      const product = names.get(lot.producto_id) ?? lot.producto_id;
      return row(product, formatDate(lot.fecha_vencimiento) + ' · ' + lot.nevera_id,
        [action('Ver lote', () => openLotDetail(lot._id), 'secondary')],
        badge(isExpired ? 'Vencido' : 'Vence pronto', isExpired ? 'critical' : 'warning'));
    }, 'Tus lotes vigentes no tienen vencimientos próximos.'));
    return group('panel-content', heading, upcoming);
  }

  function patternSummary(pattern) {
    const values = [];
    if (Number.isFinite(pattern?.frecuencia_compra_dias)) {
      const days = pattern.frecuencia_compra_dias;
      values.push(days === 1 ? 'Compra cada día' : 'Compra cada ' + days + ' días');
    }
    if (Number.isFinite(pattern?.probabilidad_desperdicio)) {
      values.push(porcentaje.format(pattern.probabilidad_desperdicio) + ' de desperdicio estimado');
    }
    return values.join(' · ') || 'Patrón sin datos registrados';
  }

  async function editPlan(plan, suggestion, patterns, existingPlans) {
    try {
      const ingredients = await data('/ingredientes');
      if (!ingredients.length) throw new Error('El catálogo necesita al menos un ingrediente para crear planes.');
      const used = new Set(existingPlans.filter(item => item._id !== plan?._id).map(item => item.patron_predictivo_id));
      const available = patterns.filter(pattern => !used.has(pattern._id));
      const name = labelInput('Nombre del plan', 'nombre_receta', {
        required: true, value: plan?.nombre_receta ?? suggestion?.nombre_receta ?? ''
      });
      const ingredient = labelSelect('Ingrediente', 'ingrediente_nombre',
        [['', 'Selecciona un ingrediente'], ...ingredients.map(item => [item._id, item._id])],
        plan?.ingrediente_nombre ?? suggestion?.ingrediente_nombre ?? '');
      ingredient.select.required = true;
      const pattern = labelSelect('Patrón de compra', 'patron_predictivo_id', [
        ['', 'Selecciona un patrón'],
        ...available.map((item, index) => [item._id, 'Patrón ' + (index + 1) + ' · ' + patternSummary(item)])
      ], plan?.patron_predictivo_id ?? '');
      const create = labelInput('Crear un patrón para este plan', 'crear_patron', { type: 'checkbox', checked: !available.length });
      create.wrapper.className = 'check-field';
      if (!available.length) create.input.disabled = true;
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
      openEditor(plan ? 'Editar plan de comida' : 'Nuevo plan de comida', [
        name.wrapper, ingredient.wrapper, pattern.wrapper, create.wrapper, newPattern
      ], async body => {
        const payload = { nombre_receta: body.nombre_receta.trim(), ingrediente_nombre: body.ingrediente_nombre };
        if (create.input.checked) {
          payload.patron = {};
          if (body.frecuencia_compra_dias !== '') payload.patron.frecuencia_compra_dias = Number(body.frecuencia_compra_dias);
          if (body.probabilidad_desperdicio !== '') payload.patron.probabilidad_desperdicio = Number(body.probabilidad_desperdicio) / 100;
        } else {
          payload.patron_predictivo_id = body.patron_predictivo_id;
        }
        const response = await request(plan ? rutaId('/meal_preps', plan._id) : '/meal_preps', plan ? 'PUT' : 'POST', payload);
        return response.message;
      });
    } catch (error) {
      if (getProfile()) notice(error.message, true);
    }
  }

  async function planDetail(id, patterns) {
    try {
      const plan = await data(rutaId('/meal_preps', id));
      const pattern = patterns.find(item => item._id === plan.patron_predictivo_id);
      showDetails(plan.nombre_receta, [['Ingrediente', plan.ingrediente_nombre], ['Patrón de compra', patternSummary(pattern)]]);
    } catch (error) {
      if (getProfile()) notice(error.message, true);
    }
  }

  async function plans() {
    const [items, patterns, suggestions] = await Promise.all([
      data('/meal_preps'), data('/patrones_predictivos'), data('/meal_preps/sugerencias')
    ]);
    const edit = (plan, suggestion) => editPlan(plan, suggestion, patterns, items);
    const plansSection = section('Mis planes', action('Nuevo plan', () => edit(), 'primary'));
    plansSection.append(list(items, plan => row(plan.nombre_receta, plan.ingrediente_nombre, [
      action('Ver plan', () => planDetail(plan._id, patterns)),
      action('Editar', () => edit(plan)),
      action('Eliminar', () => remove('¿Eliminar este plan?', 'Se eliminará el plan ' + plan.nombre_receta + '.',
        'Eliminar plan', rutaId('/meal_preps', plan._id)), 'text-button danger')
    ]), 'Todavía no tienes planes de comida.'));

    const suggestionsSection = section('Ideas según tu inventario');
    suggestionsSection.append(list(suggestions, idea => row(
      idea.nombre_receta, 'Ingrediente disponible · ' + idea.ingrediente_nombre, [
        action('Ver lote', () => openLotDetail(idea.inventario_id)),
        idea.plan_id
          ? action('Ver plan', () => planDetail(idea.plan_id, patterns), 'secondary')
          : action('Crear plan', () => edit(null, idea), 'secondary')
      ]
    ), 'Asocia un ingrediente para sugerencias a un lote con existencias en Inventario.'));
    return group('panel-content', plansSection, suggestionsSection);
  }

  async function alerts() {
    const items = await getNotifications();
    const type = labelSelect('Tipo', 'tipo', [['', 'Todos'], ...Object.entries(tipoAviso)], alertType);
    const read = labelSelect('Estado', 'lectura', [['', 'Todos'], ['unread', 'Sin leer'], ['read', 'Leídas']], alertRead);
    const results = group('feature-list');
    function apply() {
      alertType = type.select.value;
      alertRead = read.select.value;
      const filtered = items.filter(item => (!alertType || item.tipo === alertType) &&
        (!alertRead || !!item.leida === (alertRead === 'read')));
      const content = list(filtered, item => {
        const context = [formatDate(item.fecha), item.nevera_id, item.fecha_vencimiento &&
          ('Vence ' + formatDate(item.fecha_vencimiento)), item.leida ? 'Leída' : 'Sin leer'].filter(Boolean).join(' · ');
        const endpoint = rutaId('/notificaciones', item._id);
        const buttons = [
          action(item.leida ? 'Marcar sin leer' : 'Marcar como leída',
            event => mutate(endpoint, 'PATCH', { leida: !item.leida }, event.currentTarget)),
          action('Eliminar', () => remove('¿Eliminar esta notificación?', 'Se eliminará este aviso de tu bandeja.',
            'Eliminar aviso', endpoint), 'text-button danger')
        ];
        if (item.inventario_id) buttons.unshift(action('Ver lote', () => openLotDetail(item.inventario_id), 'secondary'));
        return row(item.mensaje, context, buttons, badge(tipoAviso[item.tipo] ?? 'Aviso', item.tipo === 'VENCIMIENTO' ? 'warning' : ''));
      }, 'No hay notificaciones para estos filtros.');
      results.replaceChildren(...content.childNodes);
    }
    type.select.addEventListener('change', apply);
    read.select.addEventListener('change', apply);
    apply();
    return group('panel-content', group('feature-filters', type.wrapper, read.wrapper), results);
  }

  async function history() {
    const getPage = page => data('/historial_inventario?pagina=' + page + '&limite=' + paginaHistorial);
    const [items, products] = await Promise.all([getPage(1), data('/productos').catch(() => [])]);
    const names = new Map(products.map(product => [product._id, product.nombre]));
    const nameOf = log => {
      const product = log.snapshot_datos?.producto_id;
      return product ? names.get(product) ?? 'Producto ' + product : 'Lote de inventario';
    };
    async function historyDetail(id) {
      try {
        const entry = await data(rutaId('/historial_inventario', id));
        const lot = entry.snapshot_datos ?? {};
        showDetails(nameOf(entry), [
          ['Movimiento', movimiento[entry.accion] ?? entry.accion],
          ['Fecha', formatDate(entry.fecha)],
          ['Detalle', entry.detalles],
          ['Nevera', lot.nevera_id ?? 'Sin dato'],
          ['Cantidad registrada', lot.cantidad == null ? 'Sin dato' : lot.cantidad + ' ' + lot.unidad_medida_nombre],
          ['Estado registrado', estadoLote[lot.estado] ?? 'Sin dato'],
          ['Vencimiento del lote', formatDate(lot.fecha_vencimiento)]
        ]);
      } catch (error) {
        if (getProfile()) notice(error.message, true);
      }
    }
    const draw = item => row(nameOf(item), formatDate(item.fecha) + ' · ' + item.detalles,
      [action('Ver detalle', () => historyDetail(item._id), 'secondary')],
      badge(movimiento[item.accion] ?? item.accion, item.accion === 'ELIMINADO' ? 'critical' : ''));
    const timeline = list(items, draw, 'Todavía no hay movimientos en tu inventario.');
    let page = 1;
    const more = action('Cargar más movimientos', async () => {
      more.disabled = true;
      try {
        const next = await getPage(page + 1);
        if (!more.isConnected) return;
        page++;
        timeline.append(...next.map(draw));
        more.hidden = next.length < paginaHistorial;
      } catch (error) {
        if (more.isConnected) notice(error.message, true);
      } finally {
        more.disabled = false;
      }
    }, 'secondary');
    more.hidden = items.length < paginaHistorial;
    return group('panel-content', timeline, group('feature-actions', more));
  }

  async function addCatalogRecord(kind) {
    try {
      const meta = catalogos[kind];
      const name = labelInput('Nombre', 'nombre', { required: true });
      const fields = [name.wrapper];
      if (kind === 'productos') {
        const [brands, categories] = await Promise.all([data('/marcas'), data('/categorias')]);
        if (!brands.length || !categories.length) throw new Error('Crea primero una marca y una categoría en el catálogo.');
        for (const [label, key, options] of [['Marca', 'marca_nombre', brands], ['Categoría', 'categoria_nombre', categories]]) {
          const control = labelSelect(label, key, [['', 'Selecciona una opción'], ...options.map(item => [item._id, item._id])]);
          control.select.required = true;
          fields.push(control.wrapper);
        }
      }
      if (kind === 'unidades_medida') fields.push(labelInput('Abreviatura', 'abreviatura', { required: true }).wrapper);
      openEditor('Agregar ' + meta.singular, fields, async ({ nombre, ...details }) => {
        const value = nombre.trim();
        if (!value) throw new Error('Ingresa un nombre.');
        const payload = kind === 'productos' ? { _id: 'PROD-' + crypto.randomUUID(), nombre: value, ...details }
          : { _id: value, ...details };
        const response = await request('/' + kind, 'POST', payload);
        return response.message;
      });
    } catch (error) {
      if (getProfile()) notice(error.message, true);
    }
  }

  async function directory() {
    const kind = catalog;
    const meta = catalogos[kind];
    const items = await data('/' + kind);
    const admin = getProfile()?.catalogo_admin;
    const tabs = group('panel-tabs');
    for (const [key, entry] of Object.entries(catalogos)) {
      const tab = action(entry.label, () => {
        catalog = key;
        void reload();
      }, 'secondary');
      tab.setAttribute('aria-pressed', String(key === kind));
      tabs.append(tab);
    }
    const body = section(meta.label, admin ? action('Agregar ' + meta.singular, () => addCatalogRecord(kind), 'primary') : null);
    const search = labelInput('Buscar en ' + meta.label.toLowerCase(), 'busqueda', { type: 'search' });
    const filters = group('feature-filters', search.wrapper);
    const results = group('feature-list');
    const filtersBy = [];
    if (kind === 'productos') {
      for (const [label, key] of [['Marca', 'marca_nombre'], ['Categoría', 'categoria_nombre']]) {
        const options = [...new Set(items.map(item => referencia(item[key])).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
        const control = labelSelect(label, key, [['', 'Todas'], ...options.map(value => [value, value])]);
        control.select.addEventListener('change', apply);
        filtersBy.push([key, control.select]);
        filters.append(control.wrapper);
      }
    }
    function apply() {
      const visible = items.filter(item =>
        normalizar(item.nombre ?? item._id).includes(normalizar(search.input.value)) &&
        filtersBy.every(([key, select]) => !select.value || referencia(item[key]) === select.value)
      );
      const content = list(visible, item => {
        const name = item.nombre ?? item._id;
        const description = [referencia(item.marca_nombre), referencia(item.categoria_nombre), item.abreviatura].filter(Boolean).join(' · ');
        const buttons = admin ? [action('Eliminar', () => remove('¿Eliminar ' + meta.singular + '?',
          'Se eliminará ' + name + ' del catálogo compartido.', 'Eliminar', rutaId('/' + kind, item._id)), 'text-button danger')] : [];
        return row(name, description, buttons);
      }, 'No hay resultados en este catálogo.');
      results.replaceChildren(...content.childNodes);
    }
    search.input.addEventListener('input', apply);
    apply();
    body.append(filters, results);
    return group('panel-content', tabs, body);
  }

  function profile() {
    const account = getProfile();
    const path = rutaId('/usuarios', account._id);
    function edit() {
      const name = labelInput('Usuario', 'nombre', { required: true, value: account.nombre, autocomplete: 'username' });
      const email = labelInput('Correo', 'email', { required: true, value: account.email, type: 'email', autocomplete: 'email' });
      const password = labelInput('Contraseña actual (para cambiar el correo)', 'password_actual', {
        type: 'password', autocomplete: 'current-password'
      });
      openEditor('Editar perfil', [name.wrapper, email.wrapper, password.wrapper], async body => {
        if (body.email.trim() !== account.email && !body.password_actual) throw new Error('Confirma tu contraseña actual para cambiar el correo.');
        const response = await request(path, 'PUT', body);
        onProfileSaved(response.data, false);
        return response.message;
      });
    }
    function changePassword() {
      const current = labelInput('Contraseña actual', 'password_actual', { type: 'password', required: true, autocomplete: 'current-password' });
      const next = labelInput('Contraseña nueva', 'password', { type: 'password', minLength: 12, maxLength: 1024, required: true, autocomplete: 'new-password' });
      const confirm = labelInput('Confirma la contraseña nueva', 'confirmacion', { type: 'password', required: true, autocomplete: 'new-password' });
      const hint = element('p', 'Usa al menos 12 caracteres, con mayúsculas, minúsculas, números y símbolos.', 'muted');
      openEditor('Cambiar contraseña', [hint, current.wrapper, next.wrapper, confirm.wrapper], async ({ confirmacion, ...body }) => {
        if (body.password !== confirmacion) throw new Error('Las contraseñas nuevas deben coincidir.');
        const response = await request(path, 'PUT', body);
        onProfileSaved(response.data, true);
      });
    }
    const heading = section('Perfil', action('Editar perfil', edit, 'primary'));
    const details = document.createElement('dl');
    details.className = 'detail-list';
    const entries = [['Usuario', account.nombre], ['Correo', account.email], ['ID de cuenta', account._id]];
    if (account.catalogo_admin) entries.push(['Permiso', 'Administrador del catálogo']);
    for (const [title, value] of entries) details.append(element('dt', title), element('dd', value));
    heading.append(details, group('feature-actions', action('Cambiar contraseña', changePassword, 'secondary')));
    return group('panel-content', heading);
  }

  const loaders = { home, plans, alerts, history, catalog: directory, profile };
  return { load: view => loaders[view]() };
}
