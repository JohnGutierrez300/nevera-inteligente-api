import { summarizeLots } from '../modelos/nevera.js';
import { notice } from '../vistas/componentes.js';
import { catalogs, createDashboardView } from '../vistas/dashboard.js';

const historyPageSize = 20;
const alertsPageSize = 20;

export function createDashboardController({
  model, dialogs, getProfile, getGeneration, navigate, reload, openLotDetail,
  onNotifications, onProfileSaved, onAccountDeleted
}) {
  const view = createDashboardView();
  let catalog = 'productos';
  let notificationRequest = 0;
  let homeSummary;
  let lastSummary;
  let alertsRevision;
  let alertsPage = 1;

  function edit(form, save) {
    if (!getProfile()) return;
    const generation = getGeneration();
    dialogs.openEditor(form, async fields => {
      const message = await save(fields);
      if (generation !== getGeneration() || !dialogs.editorOpen) return;
      dialogs.closeEditor();
      notice(message);
      await reload();
    });
  }

  async function mutate(send, setBusy) {
    const account = getProfile();
    if (!account) return;
    setBusy?.(true);
    try {
      const response = await send();
      if (getProfile() !== account) return;
      notice(response.message);
      await reload();
    } catch (error) {
      if (getProfile() === account) notice(error);
    } finally {
      setBusy?.(false);
    }
  }

  function remove(title, message, label, send, setBusy) {
    dialogs.confirm(title, message + ' Esta acción no se puede deshacer.', label, () => mutate(send, setBusy));
  }

  async function loadNotifications() {
    const profile = getProfile();
    const generation = ++notificationRequest;
    const summary = await model.notifications.summary(lastSummary?.revision);
    if (profile && profile === getProfile() && generation === notificationRequest) {
      lastSummary = { ...lastSummary, ...summary };
      onNotifications(lastSummary);
      if (homeSummary?.node.isConnected) homeSummary.showUnread(summary.sin_leer);
    }
    return summary;
  }

  async function home() {
    const generation = getGeneration();
    const notifications = loadNotifications().catch(() => null);
    const [inventory, products] = await Promise.all([
      model.inventory.list({ estado: 'EN_NEVERA' }),
      model.catalog.productsForDisplay().catch(() => [])
    ]);
    const summary = view.home({
      account: getProfile(),
      products,
      summary: summarizeLots(inventory.data),
      onNavigate: navigate,
      onViewLot: openLotDetail
    });
    if (generation === getGeneration()) homeSummary = summary;
    void notifications.then(result => summary.showUnread(result?.sin_leer ?? null));
    return summary.node;
  }

  async function editPlan(plan, suggestion, patterns, existingPlans) {
    const generation = getGeneration();
    try {
      const ingredients = await model.catalog.list('ingredientes');
      if (generation !== getGeneration()) return;
      if (!ingredients.length) throw new Error('El catálogo necesita al menos un ingrediente para crear planes.');
      const used = new Set(existingPlans.filter(item => item._id !== plan?._id).map(item => item.patron_predictivo_id));
      const available = patterns.filter(pattern => !used.has(pattern._id));
      edit(view.planEditor({ plan, suggestion, ingredients, patterns: available }), async fields => {
        const createPattern = !available.length || Boolean(fields.crear_patron);
        const response = await model.plans.save(plan?._id, fields, createPattern);
        return response.message;
      });
    } catch (error) {
      if (generation === getGeneration()) notice(error);
    }
  }

  async function planDetail(id, patterns) {
    const generation = getGeneration();
    try {
      const plan = await model.plans.get(id);
      if (generation === getGeneration()) dialogs.showDetails(view.planDetails(plan, patterns));
    } catch (error) {
      if (generation === getGeneration()) notice(error);
    }
  }

  async function plans() {
    const [items, patterns, suggestions] = await Promise.all([
      model.plans.list(), model.plans.patterns(), model.plans.suggestions()
    ]);
    const used = new Set(items.map(plan => plan.patron_predictivo_id));
    return view.plans(items, suggestions, {
      unusedPatterns: patterns.filter(pattern => !used.has(pattern._id)),
      onEdit: (plan, suggestion) => editPlan(plan, suggestion, patterns, items),
      onDetail: id => planDetail(id, patterns),
      onDelete: plan => remove('¿Eliminar este plan?', 'Se eliminará el plan ' + plan.nombre_receta + '.',
        'Eliminar plan', () => model.plans.remove(plan._id)),
      onDeletePattern: (id, setBusy) => remove('¿Eliminar este patrón?', 'Se eliminará el patrón de compra sin uso.',
        'Eliminar patrón', () => model.plans.removePattern(id), setBusy),
      onViewLot: openLotDetail
    });
  }

  async function alerts(background) {
    const generation = getGeneration();
    const currentRevision = lastSummary?.revision;
    const filters = view.getAlertFilters();
    if (!background) void loadNotifications().catch(() => {});
    const list = pagina => model.notifications.list({ ...filters, pagina, limite: alertsPageSize });
    let page = alertsPage;
    let result = await list(page);
    if (!result.data.length && page > 1) {
      page--;
      result = await list(page);
    }
    if (generation === getGeneration()) {
      alertsPage = page;
      alertsRevision = currentRevision;
    }
    return view.alerts(result.data, result.paginacion, {
      onFilter() {
        alertsPage = 1;
        void reload();
      },
      onPage(change) {
        alertsPage += change;
        void reload();
      },
      onToggle: (item, setBusy) => mutate(() => model.notifications.setRead(item._id, !item.leida), setBusy),
      onDelete: id => remove('¿Eliminar esta notificación?', 'Se eliminará este aviso de tu bandeja.',
        'Eliminar aviso', () => model.notifications.remove(id)),
      onViewLot: openLotDetail
    });
  }

  async function history() {
    const [items, products] = await Promise.all([
      model.history.list(1, historyPageSize), model.catalog.productsForDisplay().catch(() => [])
    ]);
    let page = 1;
    const timeline = view.history(items, products, items.length >= historyPageSize, {
      async onDetail(id) {
        try {
          const entry = await model.history.get(id);
          if (timeline.connected) dialogs.showDetails(timeline.details(entry));
        } catch (error) {
          if (timeline.connected) notice(error);
        }
      },
      async onMore() {
        timeline.setBusy(true);
        try {
          const next = await model.history.list(page + 1, historyPageSize);
          if (!timeline.connected) return;
          page++;
          timeline.append(next, next.length >= historyPageSize);
        } catch (error) {
          if (timeline.connected) notice(error);
        } finally {
          timeline.setBusy(false);
        }
      }
    });
    return timeline.node;
  }

  async function addCatalogRecord(kind) {
    const generation = getGeneration();
    try {
      let references;
      if (kind === 'productos') {
        const [brands, categories] = await Promise.all([model.catalog.list('marcas'), model.catalog.list('categorias')]);
        if (!brands.length || !categories.length) throw new Error('Crea primero una marca y una categoría en el catálogo.');
        references = { brands, categories };
      }
      if (generation === getGeneration()) edit(view.catalogEditor(kind, references), async fields => {
        const response = await model.catalog.create(kind, fields);
        return response.message;
      });
    } catch (error) {
      if (generation === getGeneration()) notice(error);
    }
  }

  async function directory() {
    const kind = catalog;
    const items = await model.catalog.list(kind);
    return view.catalog(kind, items, getProfile()?.catalogo_admin, {
      onSelect(tab) {
        catalog = tab;
        void reload();
      },
      onAdd: () => addCatalogRecord(kind),
      onDelete: (id, name) => remove('¿Eliminar ' + catalogs[kind].singular + '?',
        'Se eliminará ' + name + ' del catálogo compartido.', 'Eliminar', () => model.catalog.remove(kind, id))
    });
  }

  function profile() {
    const account = getProfile();
    return view.profile(account, {
      onEdit: () => edit(view.profileEditor(account), async body => {
        if (body.email.trim() !== account.email && !body.password_actual) throw new Error('Confirma tu contraseña actual para cambiar el correo.');
        const response = await model.account.update(account._id, body);
        if (getProfile() === account) onProfileSaved(response.data, false);
        return response.message;
      }),
      onChangePassword: () => edit(view.passwordEditor(), async ({ confirmacion, ...body }) => {
        if (body.password !== confirmacion) throw new Error('Las contraseñas nuevas deben coincidir.');
        const response = await model.account.update(account._id, body);
        if (getProfile() === account) onProfileSaved(response.data, true);
      }),
      onDelete: () => dialogs.confirm('¿Eliminar tu cuenta?',
        'La API comprobará si tienes registros vinculados. Cuando se elimine la cuenta, se cerrarán sus sesiones y se conservará el historial. Esta acción no se puede deshacer.',
        'Eliminar cuenta', async () => {
          try {
            const response = await model.account.remove(account._id);
            if (getProfile() === account) onAccountDeleted(response.message);
          } catch (error) {
            if (getProfile() === account) notice(error);
          }
        }, { accountName: account.nombre })
    });
  }

  const loaders = { home, plans, alerts, history, catalog: directory, profile };
  return {
    load: (name, background) => loaders[name](background),
    loadNotifications,
    alertsNeedRefresh: () => !!lastSummary && alertsRevision !== lastSummary.revision,
    resetAlertFilters() {
      alertsPage = 1;
      view.resetAlertFilters();
    },
    resetNotifications() {
      notificationRequest++;
      lastSummary = homeSummary = alertsRevision = undefined;
      alertsPage = 1;
      view.resetAlertFilters();
    }
  };
}
