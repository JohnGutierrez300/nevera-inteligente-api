import { action, byId, element, errorMessage, formatDate } from './componentes.js';

export const viewTitles = {
  home: 'Inicio',
  inventory: 'Inventario',
  plans: 'Planes de comida',
  alerts: 'Notificaciones',
  history: 'Historial',
  catalog: 'Catálogo',
  profile: 'Mi cuenta'
};

export function createAppView({ onNavigate, onLogout, onOpenNotifications, onPreviewNotifications }) {
  const dashboard = byId('dashboard');
  const results = byId('results');
  const navigation = byId('navigation');
  const logout = byId('logout');
  const bell = byId('notification-bell');
  const bellControl = bell.closest('.notification-control');
  const preview = byId('notification-preview');
  const previewList = byId('notification-preview-list');
  const bellCount = byId('bell-count');
  const menuCount = byId('unread-count');
  const toast = byId('notification-toast');
  const toastTitle = byId('notification-toast-title');
  const toastMessage = byId('notification-toast-message');
  const announcement = byId('notification-announcer');
  const mobileMenu = byId('mobile-menu');
  const mobileToggle = byId('mobile-menu-toggle');
  const mobileContent = byId('mobile-menu-content');
  const mobileViewport = matchMedia('(max-width: 44rem), (max-width: 62rem) and (max-height: 32rem) and (hover: none) and (pointer: coarse)');
  const navButtons = [...navigation.querySelectorAll('[data-view]')];
  let toastTimer;
  let previewItems;

  function closePreview() {
    preview.hidden = true;
    bell.setAttribute('aria-expanded', 'false');
  }

  function openNotifications() {
    closePreview();
    onOpenNotifications();
    bell.focus({ preventScroll: true });
  }

  function previewMessage(message) {
    previewList.replaceChildren(element('p', message, 'muted'));
  }

  function dismissNotification() {
    clearTimeout(toastTimer);
    toast.hidden = true;
    toastTitle.textContent = toastMessage.textContent = announcement.textContent = '';
    bell.removeAttribute('data-new');
  }

  function restoreSidebarMenu() {
    if (mobileMenu.open || navigation.parentElement !== mobileContent) return;
    mobileMenu.before(navigation, logout);
    mobileToggle.setAttribute('aria-expanded', 'false');
  }

  function closeMobileMenu() {
    if (mobileMenu.open) mobileMenu.close();
    restoreSidebarMenu();
  }

  mobileToggle.addEventListener('click', () => {
    if (dashboard.hidden || !mobileViewport.matches || mobileMenu.open) return;
    closePreview();
    mobileContent.append(navigation, logout);
    mobileMenu.showModal();
    mobileToggle.setAttribute('aria-expanded', 'true');
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
    void onNavigate(button.dataset.view);
  });
  logout.addEventListener('click', onLogout);
  bell.addEventListener('click', () => {
    if (!preview.hidden) return closePreview();
    if (!previewItems) previewMessage('Consultando avisos…');
    preview.hidden = false;
    bell.setAttribute('aria-expanded', 'true');
    void onPreviewNotifications();
  });
  byId('notification-preview-open').addEventListener('click', openNotifications);
  byId('notification-open').addEventListener('click', openNotifications);
  document.addEventListener('pointerdown', event => {
    if (!preview.hidden && !bellControl.contains(event.target)) closePreview();
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || preview.hidden) return;
    event.preventDefault();
    closePreview();
    bell.focus({ preventScroll: true });
  });
  byId('notification-dismiss').addEventListener('click', () => {
    dismissNotification();
    bell.focus({ preventScroll: true });
  });

  return {
    showSession(active) {
      if (!active) {
        closeMobileMenu();
        closePreview();
        previewItems = undefined;
        previewList.replaceChildren();
        dismissNotification();
      }
      for (const control of [dashboard, navigation, logout, mobileToggle]) control.hidden = !active;
    },
    setLogoutBusy(busy) { logout.disabled = busy; },
    select(view) {
      closePreview();
      byId('view-title').textContent = viewTitles[view];
      if (view === 'alerts') dismissNotification();
      for (const button of navButtons) {
        if (button.dataset.view === view) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      }
    },
    showResults(...content) { results.replaceChildren(...content); },
    showLoading() { results.replaceChildren(element('p', 'Cargando…', 'muted')); },
    showError(error, retry) {
      const message = element('p', errorMessage(error) + ' ');
      message.append(action('Reintentar', retry));
      results.replaceChildren(message);
    },
    showUnread(count) {
      for (const badge of [bellCount, menuCount]) {
        badge.hidden = count === 0;
        badge.textContent = count > 99 ? '99+' : String(count);
      }
      menuCount.setAttribute('aria-label', `${count} notificaciones sin leer`);
      bell.toggleAttribute('data-unread', count > 0);
      bell.setAttribute('aria-label', count ? `Abrir notificaciones, ${count} sin leer` : 'Abrir notificaciones');
    },
    showNotificationPreview(items) {
      if (!items || items === previewItems) return;
      previewItems = items;
      if (!items.length) return previewMessage('Todavía no tienes avisos.');
      previewList.replaceChildren(...items.map(item => {
        const link = action('', openNotifications, 'secondary notification-preview-item');
        const status = item.desactualizada ? 'Desactualizada' : item.leida ? 'Leída' : 'Sin leer';
        link.toggleAttribute('data-unread', !item.leida && !item.desactualizada);
        link.append(element('span', item.mensaje, 'notification-preview-message'),
          element('span', `${formatDate(item.fecha)} · ${status}`, 'notification-preview-meta'));
        return link;
      }));
    },
    showNotificationPreviewError() {
      if (!previewItems) previewMessage('No se pudieron consultar los avisos.');
    },
    showNotification(items) {
      const title = items.length === 1 ? 'Nueva notificación' : `${items.length} notificaciones nuevas`;
      const message = items[0].mensaje;
      clearTimeout(toastTimer);
      toastTitle.textContent = title;
      toastMessage.textContent = message;
      toast.hidden = false;
      announcement.textContent = `${title}. ${message}`;
      bell.setAttribute('data-new', '');
      toastTimer = setTimeout(() => {
        if (!toast.contains(document.activeElement)) dismissNotification();
      }, 10_000);
    }
  };
}
