import { createModel, requestApi } from '../modelos/nevera.js';
import { createAppView, viewTitles } from '../vistas/aplicacion.js';
import { notice } from '../vistas/componentes.js';
import { createDialogs } from '../vistas/dialogos.js';
import { createInventoryView, lotDeletionMessage, lotDetails } from '../vistas/inventario.js';
import { createSessionView } from '../vistas/sesion.js';
import { createDashboardController } from './dashboard.js';

const inventoryPageSize = 20;

export function startApp() {
  let user = null;
  let currentView = 'home';
  let viewRequest = 0;
  let inventoryPage = 1;
  let inventoryFilters = {};
  let editingId = '';
  let recoveryToken = '';

  const model = createModel(async (path, method, body) => {
    const active = user;
    try {
      return await requestApi(path, method, body);
    } catch (error) {
      if (error.status === 401 && active && active === user) endSession('Tu sesión venció. Vuelve a iniciar sesión.');
      throw error;
    }
  });
  const dialogs = createDialogs();
  const app = createAppView({ onNavigate: selectView, onLogout: signOut });
  const session = createSessionView({
    onAuth: submitAuth,
    onRecover: recoverPassword,
    onReset: resetPassword,
    onBack: () => { recoveryToken = ''; },
    onRetry: restoreSession
  });
  const inventory = createInventoryView({
    onFilter: applyInventoryFilters,
    onPage(change) {
      inventoryPage += change;
      void loadView();
    },
    onView: openLotDetail,
    onAdd: () => openLot(),
    onEdit: openLot,
    onSave: saveLot,
    onDelete: confirmLotDeletion
  });
  const dashboard = createDashboardController({
    model, dialogs, openLotDetail,
    getProfile: () => user,
    getGeneration: () => viewRequest,
    reload: loadView,
    navigate: selectView,
    onUnread: app.showUnread,
    onAccountDeleted: endSession,
    onProfileSaved(profile, passwordChanged) {
      if (passwordChanged) {
        endSession('Contraseña cambiada. Inicia sesión con la nueva contraseña.');
      } else if (user) {
        user = { ...user, ...profile };
      }
    }
  });

  function showSession(active) {
    session.showSession(active);
    app.showSession(active);
  }

  function startSession(profile, view = 'home') {
    if (!profile?._id) throw new Error('No se pudo obtener el perfil de la sesión.');
    user = profile;
    showSession(true);
    return selectView(view);
  }

  function endSession(message = '') {
    user = null;
    viewRequest++;
    inventoryPage = 1;
    inventoryFilters = {};
    editingId = '';
    inventory.clear();
    app.showResults();
    dialogs.closeAll();
    app.showUnread(0);
    showSession(false);
    session.select('login', false);
    notice(message);
  }

  async function submitAuth(credentials, registering) {
    const generation = viewRequest;
    notice();
    try {
      if (registering) {
        await model.account.register(credentials);
        if (generation !== viewRequest) return;
        session.setRegistration(false);
        notice('Cuenta creada. Ya puedes iniciar sesión.');
        return;
      }
      const response = await model.account.signIn(credentials);
      if (generation === viewRequest) await startSession(response.data?.perfil);
    } catch (error) {
      if (generation === viewRequest) notice(error);
    }
  }

  async function signOut() {
    app.setLogoutBusy(true);
    try {
      await model.account.signOut();
      endSession('Sesión cerrada.');
    } catch (error) {
      if (user) notice(error);
    } finally {
      app.setLogoutBusy(false);
    }
  }

  async function recoverPassword({ email }) {
    const generation = viewRequest;
    notice();
    try {
      const response = await model.account.recover(email);
      if (generation === viewRequest) notice(response.message);
    } catch (error) {
      if (generation === viewRequest) notice(error);
    }
  }

  async function resetPassword({ password, confirmation }) {
    const generation = viewRequest;
    notice();
    try {
      if (password !== confirmation) throw new Error('Las contraseñas deben coincidir.');
      const response = await model.account.reset(recoveryToken, password);
      if (generation !== viewRequest) return;
      recoveryToken = '';
      session.resetPasswordForm();
      session.select('login');
      notice(response.message);
    } catch (error) {
      if (generation === viewRequest) notice(error);
    }
  }

  async function restoreSession() {
    const generation = viewRequest;
    session.showChecking();
    try {
      const profile = await model.account.get();
      if (generation !== viewRequest) return;
      const view = new URLSearchParams(location.search).get('vista');
      await startSession(profile, Object.hasOwn(viewTitles, view) ? view : 'home');
    } catch (error) {
      if (generation !== viewRequest) return;
      if (error.status === 401) showSession(false);
      else session.showChecking(true);
    }
  }

  function selectView(view) {
    currentView = view;
    const url = new URL(location.href);
    if (view === 'home') url.searchParams.delete('vista');
    else url.searchParams.set('vista', view);
    if (url.href !== location.href) history.replaceState(history.state, '', url);
    app.select(view);
    inventory.select(view === 'inventory');
    notice();
    return loadView();
  }

  function applyInventoryFilters(fields) {
    inventoryFilters = Object.fromEntries(Object.entries(fields)
      .map(([name, value]) => [name, value.trim()])
      .filter(([, value]) => value));
    inventoryPage = 1;
    if (currentView === 'inventory') void loadView();
  }

  async function loadView() {
    if (!user) return;
    const generation = ++viewRequest;
    const view = currentView;
    inventory.setLoading(view === 'inventory');
    app.showLoading();
    try {
      if (view !== 'inventory') {
        const page = await dashboard.load(view);
        if (generation === viewRequest) app.showResults(page);
        return;
      }
      const [items, products] = await Promise.all([
        model.inventory.list({ ...inventoryFilters, pagina: inventoryPage, limite: inventoryPageSize }),
        model.catalog.list('productos').catch(() => [])
      ]);
      if (generation === viewRequest) app.showResults(inventory.render(items.data, products, items.paginacion));
    } catch (error) {
      if (generation !== viewRequest) return;
      inventory.hidePagination();
      app.showError(error, loadView);
    }
  }

  async function openLot(lot) {
    if (!user || inventory.editorOpen) return;
    const generation = viewRequest;
    inventory.setAddBusy(true);
    notice();
    try {
      const [products, units, ingredients] = await Promise.all([
        model.catalog.list('productos'), model.catalog.list('unidades_medida'), model.catalog.list('ingredientes')
      ]);
      if (generation !== viewRequest || inventory.editorOpen) return;
      if (!lot && (!products.length || !units.length)) {
        throw new Error('El catálogo necesita al menos un producto y una unidad de medida. Puedes consultarlo en Catálogo.');
      }
      editingId = lot?._id || '';
      inventory.openEditor(lot, { products, units, ingredients });
    } catch (error) {
      if (generation === viewRequest) notice(error);
    } finally {
      inventory.setAddBusy(false);
    }
  }

  async function openLotDetail(id) {
    if (!user || dialogs.detailsOpen) return;
    const generation = viewRequest;
    try {
      const [lot, products] = await Promise.all([model.inventory.get(id), model.catalog.list('productos').catch(() => [])]);
      if (generation !== viewRequest) return;
      dialogs.showDetails(lotDetails(lot, products, {
        onEdit(item) {
          dialogs.closeDetails();
          void openLot(item);
        },
        onStatus: changeLotStatus
      }));
    } catch (error) {
      if (generation !== viewRequest) return;
      if (error.data?.recurso === 'Inventario') notice('Este lote ya no está disponible en tu inventario.', true);
      else notice(error);
    }
  }

  async function changeLotStatus(id, status) {
    const active = user;
    if (!active) return;
    dialogs.setDetailBusy(true);
    dialogs.showDetailError();
    try {
      const response = await model.inventory.setStatus(id, status);
      if (user !== active) return;
      dialogs.closeDetails();
      notice(response.message);
      await loadView();
    } catch (error) {
      if (user !== active) return;
      if (dialogs.detailsOpen) dialogs.showDetailError(error, openLotDetail);
      else notice(error);
    } finally {
      dialogs.setDetailBusy(false);
    }
  }

  async function saveLot(fields) {
    const active = user;
    if (!active) return;
    const id = editingId;
    inventory.setSaveBusy(true);
    inventory.showError();
    try {
      const response = await model.inventory.save(id, fields);
      if (user !== active) return;
      inventory.closeEditor();
      if (id) {
        notice();
        dialogs.showUpdated();
      } else {
        notice(response.message);
      }
      await loadView();
    } catch (error) {
      if (user !== active) return;
      if (inventory.editorOpen) inventory.showError(error);
      else notice(error);
    } finally {
      inventory.setSaveBusy(false);
    }
  }

  function confirmLotDeletion(id, name, setBusy) {
    if (!user) return;
    dialogs.confirm('¿Estás seguro de eliminar este lote?', lotDeletionMessage(name), 'Eliminar lote', async () => {
      const active = user;
      if (!active) return;
      setBusy(true);
      try {
        const response = await model.inventory.remove(id);
        if (user !== active) return;
        notice(response.message);
        await loadView();
      } catch (error) {
        if (user === active) notice(error);
      } finally {
        setBusy(false);
      }
    });
  }

  async function refreshUnread() {
    if (!user || document.hidden) return;
    try {
      await dashboard.loadNotifications();
    } catch {
      // La bandeja vuelve a consultar los avisos al abrirse.
    }
  }

  function openRecoveryLink() {
    const incomingToken = new URLSearchParams(location.hash.slice(1)).get('restablecer');
    if (incomingToken === null) return false;
    history.replaceState(null, '', location.pathname + location.search);
    endSession();
    recoveryToken = '';
    if (/^[a-f0-9]{64}$/.test(incomingToken)) {
      recoveryToken = incomingToken;
      session.select('reset');
    } else {
      session.select('forgot');
      notice('El enlace no es válido. Solicita uno nuevo.', true);
    }
    return true;
  }

  window.addEventListener('focus', refreshUnread);
  window.addEventListener('hashchange', openRecoveryLink);
  setInterval(refreshUnread, 60 * 1000);
  if (!openRecoveryLink()) void restoreSession();
}
