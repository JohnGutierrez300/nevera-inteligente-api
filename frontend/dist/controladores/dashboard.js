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
  const catalogPage = { pagina: 1, limite: 20 };
  const plansPage = { pagina: 1, limite: 20 };
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
    const inventory = await model.inventory.summary();
    const summary = view.home({
      account: getProfile(),
      summary: inventory,
      onNavigate: navigate,
      onViewLot: openLotDetail
    });
    if (generation === getGeneration()) homeSummary = summary;
    void notifications.then(result => summary.showUnread(result?.sin_leer ?? null));
    return summary.node;
  }

  async function editPlan(plan, suggestion, patterns, used) {
    const generation = getGeneration();
    try {
      const ingredients = await model.catalog.list('ingredientes');
      if (generation !== getGeneration()) return;
      if (!ingredients.length) throw new Error('El catálogo necesita al menos un ingrediente para crear planes.');
      const available = patterns.filter(pattern => !used.has(pattern._id) || pattern._id === plan?.patron_predictivo_id);
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

  async function paged(load, query) {
    const filters = { ...query };
    const generation = getGeneration();
    let result = await load(filters);
    if (!result.data.length && filters.pagina > 1) {
      filters.pagina--;
      result = await load(filters);
      if (generation === getGeneration()) query.pagina = filters.pagina;
    }
    return result;
  }

  function pageActions(query) {
    return {
      onSearch(filters) {
        Object.assign(query, filters, { pagina: 1 });
        void reload();
      },
      onPage(change) {
        query.pagina += change;
        void reload();
      }
    };
  }

  async function plans() {
    const [result, patterns, suggestions] = await Promise.all([
      paged(model.plans.page, plansPage), model.plans.patterns(), model.plans.suggestions()
    ]);
    const used = new Set(result.patrones_en_uso);
    return view.plans(result.data, suggestions, {
      ...pageActions(plansPage), pagination: result.paginacion, filters: { ...plansPage },
      unusedPatterns: patterns.filter(pattern => !used.has(pattern._id)),
      onEdit: (plan, suggestion) => editPlan(plan, suggestion, patterns, used),
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
    const [result, choices] = await Promise.all([
      paged(filters => model.catalog.page(kind, filters), catalogPage),
      kind === 'productos' ? Promise.all([model.catalog.list('marcas'), model.catalog.list('categorias')]) : []
    ]);
    return view.catalog(kind, result.data, getProfile()?.catalogo_admin, {
      ...pageActions(catalogPage), pagination: result.paginacion, filters: { ...catalogPage }, choices,
      onSelect(tab) {
        catalog = tab;
        Object.assign(catalogPage, { pagina: 1, busqueda: '' });
        delete catalogPage.marca_nombre;
        delete catalogPage.categoria_nombre;
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
      onEdit: () => {
        const editor = view.profileEditor(account);
        edit(editor, async body => {
          if (body.email.trim() !== account.email && !body.password_actual) throw new Error('Confirma tu contraseña actual para cambiar el correo.');
          try {
            const response = await model.account.update(account._id, body);
            if (getProfile()?._id === account._id) onProfileSaved(response.data, false);
            return response.message;
          } catch (error) {
            if (error.status === 409 && error.data?.nombre_editable_desde && getProfile()?._id === account._id) {
              editor.updateName(error.data);
              onProfileSaved(error.data, false);
            }
            throw error;
          }
        });
      },
      onChangePassword: () => edit(view.passwordEditor(), async ({ confirmacion, ...body }) => {
        if (body.password !== confirmacion) throw new Error('Las contraseñas nuevas deben coincidir.');
        const response = await model.account.update(account._id, body);
        if (getProfile() === account) onProfileSaved(response.data, true);
      }),
      onDelete: () => dialogs.confirm('¿Eliminar tu cuenta?',
        'La API comprobará si tienes registros vinculados. Cuando se elimine la cuenta, se cerrarán sus sesiones y se conservará el historial. Esta acción no se puede deshacer.',
        'Eliminar cuenta', async verification => {
          const response = await model.account.remove(account._id, verification);
          if (getProfile() === account) onAccountDeleted(response.message);
        }, { accountName: account.nombre, onRequestCode: () => model.account.requestDeletionCode(account._id) })
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
      Object.assign(plansPage, { pagina: 1, busqueda: '' });
      Object.assign(catalogPage, { pagina: 1, busqueda: '', marca_nombre: '', categoria_nombre: '' });
      view.resetAlertFilters();
    }
  };
}
