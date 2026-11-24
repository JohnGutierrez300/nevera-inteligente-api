import { action, byId, element, field, formValues, formatDate, group, lotStates } from './componentes.js';
import { showLotError } from './dialogos.js';

const numberFormat = new Intl.NumberFormat('es-CO', { maximumSignificantDigits: 15 });
const colombiaOffsetMs = 5 * 60 * 60 * 1000;

function inventoryTable(lots, products, { onView, onEdit, onDelete }) {
  const productNames = new Map(products.map(product => [product._id, product.nombre]));
  const table = element('table', '', 'inventory-table');
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
      lot.nevera_id, formatDate(lot.fecha_vencimiento), lotStates[lot.estado] || lot.estado];
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
    const remove = action('Eliminar', () => onDelete(lot._id, name, busy => { remove.disabled = busy; }), 'text-button danger');
    actions.append(group('inventory-actions',
      action('Ver lote', () => onView(lot._id), 'text-button button-view'),
      action('Editar', () => onEdit(lot), 'text-button button-edit'),
      remove));
  }
  return table;
}

function fillSelect(form, name, records, label, selected, placeholder = 'Selecciona una opción') {
  const select = field(form, name);
  select.replaceChildren(new Option(placeholder, ''));
  for (const record of records) select.add(new Option(label(record), record._id));
  if (selected && !records.some(record => record._id === selected)) select.add(new Option(selected, selected));
  select.value = selected || '';
}

export function createInventoryView({ onFilter, onPage, onView, onAdd, onEdit, onSave, onDelete, onReload }) {
  const filters = byId('filters');
  const pagination = byId('inventory-pagination');
  const previous = byId('inventory-previous');
  const next = byId('inventory-next');
  const add = byId('add');
  const dialog = byId('lot-dialog');
  const form = byId('lot-form');
  const save = byId('save-lot');
  const cancel = byId('cancel');
  const errorTarget = byId('lot-error');
  let editing = null;

  filters.addEventListener('submit', event => {
    event.preventDefault();
    onFilter(formValues(filters));
  });
  filters.addEventListener('reset', () => queueMicrotask(() => onFilter(formValues(filters))));
  previous.addEventListener('click', () => onPage(-1));
  next.addEventListener('click', () => onPage(1));
  add.addEventListener('click', () => onAdd());
  cancel.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => { if (save.disabled) event.preventDefault(); });
  form.addEventListener('submit', event => {
    event.preventDefault();
    const fields = formValues(form);
    if (!editing) {
      void onSave(fields);
      return;
    }
    const changes = Object.fromEntries(Object.entries(fields).filter(([key, value]) => value !== editing.fields[key]));
    if (!Object.keys(changes).length) {
      showLotError(errorTarget, new Error('Cambia al menos un dato del lote para guardar.'));
      return;
    }
    void onSave({ ...changes, version: editing.version });
  });

  return {
    select(active) { add.hidden = filters.hidden = !active; },
    setLoading(active) {
      if (!active) pagination.hidden = true;
      previous.disabled = next.disabled = true;
    },
    hidePagination() { pagination.hidden = true; },
    render(lots, products, page) {
      pagination.hidden = !page || (page.pagina === 1 && !page.hay_siguiente);
      if (page) {
        byId('inventory-page').textContent = 'Página ' + page.pagina;
        previous.disabled = page.pagina <= 1;
        next.disabled = !page.hay_siguiente;
      }
      return lots.length ? inventoryTable(lots, products, { onView, onEdit, onDelete })
        : element('p', 'No hay lotes para mostrar.', 'muted');
    },
    get editorOpen() { return dialog.open; },
    setAddBusy(busy) { add.disabled = busy; },
    setSaveBusy(busy) { save.disabled = cancel.disabled = busy; },
    closeEditor() { if (dialog.open) dialog.close(); },
    showError(error) { showLotError(errorTarget, error, onView, onReload); },
    openEditor(lot, { products, units, ingredients }) {
      form.reset();
      showLotError(errorTarget);
      byId('lot-title').textContent = lot?._id ? 'Editar lote' : 'Agregar lote';
      const vencimiento = field(form, 'fecha_vencimiento');
      const hoy = new Date(Date.now() - colombiaOffsetMs).toISOString().slice(0, 10);
      vencimiento.min = lot ? '' : hoy + 'T00:00';
      fillSelect(form, 'producto_id', products, product => product.nombre, lot?.producto_id);
      fillSelect(form, 'unidad_medida_nombre', units, unit => unit._id, lot?.unidad_medida_nombre);
      fillSelect(form, 'ingrediente_nombre', ingredients, ingredient => ingredient._id, lot?.ingrediente_nombre, 'Sin ingrediente');
      if (lot) {
        for (const name of ['nevera_id', 'cantidad', 'estado']) field(form, name).value = lot[name];
        if (lot.fecha_vencimiento) {
          const bogota = new Date(Date.parse(lot.fecha_vencimiento) - colombiaOffsetMs);
          if (Number.isFinite(bogota.getTime())) vencimiento.value = bogota.toISOString().slice(0, -1);
        }
      }
      editing = lot ? { fields: formValues(form), version: lot.version ?? 0 } : null;
      dialog.showModal();
    },
    clear() {
      filters.reset();
      pagination.hidden = true;
      if (dialog.open) dialog.close();
    }
  };
}

export function lotDetails(lot, products, { onEdit, onStatus }) {
  const title = products.find(product => product._id === lot.producto_id)?.nombre ?? lot.producto_id;
  const buttons = [action('Editar lote', () => onEdit(lot), 'text-button button-edit')];
  if (lot.estado === 'EN_NEVERA') {
    buttons.push(
      action('Marcar consumido', () => onStatus(lot._id, 'CONSUMIDO', lot.version ?? 0), 'primary'),
      action('Marcar desperdiciado', () => onStatus(lot._id, 'DESPERDICIADO', lot.version ?? 0), 'secondary')
    );
  }
  return {
    title, buttons,
    entries: [
      ['Cantidad', numberFormat.format(lot.cantidad) + ' ' + lot.unidad_medida_nombre],
      ['Nevera', lot.nevera_id],
      ['Vencimiento', formatDate(lot.fecha_vencimiento)],
      ['Estado', lotStates[lot.estado] ?? lot.estado],
      ['Ingrediente para sugerencias', lot.ingrediente_nombre || 'Sin ingrediente']
    ]
  };
}

export function lotDeletionMessage(name) {
  const message = document.createDocumentFragment();
  message.append('Se eliminará el lote de ', element('strong', name), '. Esta acción no se puede deshacer.');
  return message;
}
