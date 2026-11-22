import { action, byId, element, errorMessage } from './componentes.js';

export const viewTitles = {
  home: 'Inicio',
  inventory: 'Inventario',
  plans: 'Planes de comida',
  alerts: 'Notificaciones',
  history: 'Historial',
  catalog: 'Catálogo',
  profile: 'Mi cuenta'
};

export function createAppView({ onNavigate, onLogout }) {
  const dashboard = byId('dashboard');
  const results = byId('results');
  const navigation = byId('navigation');
  const logout = byId('logout');
  const mobileMenu = byId('mobile-menu');
  const mobileToggle = byId('mobile-menu-toggle');
  const mobileContent = byId('mobile-menu-content');
  const mobileViewport = matchMedia('(max-width: 44rem), (max-width: 62rem) and (max-height: 32rem) and (hover: none) and (pointer: coarse)');
  const navButtons = [...navigation.querySelectorAll('[data-view]')];

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

  return {
    showSession(active) {
      if (!active) closeMobileMenu();
      for (const control of [dashboard, navigation, logout, mobileToggle]) control.hidden = !active;
    },
    setLogoutBusy(busy) { logout.disabled = busy; },
    select(view) {
      byId('view-title').textContent = viewTitles[view];
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
      const badge = byId('unread-count');
      badge.hidden = count === 0;
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.setAttribute('aria-label', `${count} notificaciones sin leer`);
    }
  };
}
