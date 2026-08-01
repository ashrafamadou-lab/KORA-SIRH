/**
 * Coquille applicative (E7) : sidebar rétractable (desktop) / tiroir (mobile),
 * header (identité TENANT servie par l'API, notifications, langue, profil),
 * fil d'Ariane, bandeaux hors-ligne et nouvelle version.
 * La navigation est CONSTRUITE depuis les permissions réelles (/auth/me) — et n'est
 * jamais un contrôle de sécurité.
 */
import { h, clear } from '../core/dom.ts';
import { t, getLocale, type MessageKey } from '../core/i18n.ts';
import { navigate } from '../core/router.ts';
import { visibleNav } from '../core/permissions.ts';
import type { Session } from '../core/session.ts';
import { button, countBadge, icon } from '../ui/kit.ts';

export interface Crumb { label: string; route?: string }

export interface ShellController {
  root: HTMLElement;
  outlet: HTMLElement;
  setBreadcrumb(crumbs: Crumb[]): void;
  setActiveRoute(route: string): void;
  setInboxCount(n: number): void;
  setUnreadCount(n: number): void;
  showUpdateBanner(onReload: () => void): void;
  setOffline(offline: boolean): void;
  refreshNav(): void;
}

export function buildShell(session: Session, onLogout: () => void, onLocale: (l: 'fr' | 'en') => void): ShellController {
  let collapsed = false;
  let navOpenMobile = false;
  let activeRoute = '/';
  let inboxCount = 0;
  let unreadCount = 0;

  const outlet = h('main', { id: 'main', class: 'content', tabindex: '-1' });
  const breadcrumbEl = h('nav', { class: 'breadcrumb', 'aria-label': t('nav.breadcrumb') });
  const sidebar = h('aside', { class: 'sidebar', 'aria-label': t('nav.dashboard') });
  const banners = h('div', {});

  const shell = h('div', { class: 'shell' });
  const scrim = h('div', { class: 'nav-scrim' });
  scrim.style.display = 'none';
  scrim.addEventListener('click', () => setMobileNav(false));

  function setMobileNav(open: boolean): void {
    navOpenMobile = open;
    shell.classList.toggle('nav-open', open);
    scrim.style.display = open ? '' : 'none';
  }

  function renderSidebar(): void {
    clear(sidebar);
    const me = session.me;
    sidebar.appendChild(h('div', { class: 'brand' },
      h('div', { class: 'brand-logo', 'aria-hidden': 'true' }, 'K'),
      h('div', {},
        h('div', { class: 'brand-name' }, t('app.name')),
        // Identité du TENANT : slot de personnalisation (nom commercial servi par l'API).
        h('div', { class: 'brand-tenant' }, me?.tenant?.name ?? t('app.tagline')),
      ),
    ));
    const sections = visibleNav(me?.permissions ?? []);
    for (const section of sections) {
      const box = h('div', { class: 'nav-section' });
      if (section.items.length > 1 || section.labelKey !== section.items[0]?.labelKey) {
        box.appendChild(h('h2', {}, t(section.labelKey)));
      }
      for (const item of section.items) {
        const a = h('a', {
          class: `nav-item${routeMatches(item.route) ? ' active' : ''}`,
          href: `#${item.route}`,
        }, icon(item.icon), h('span', { class: 'nav-label' }, t(item.labelKey)));
        if (item.route === '/workflow' && inboxCount > 0) a.appendChild(countBadge(inboxCount));
        if (item.route === '/notifications' && unreadCount > 0) a.appendChild(countBadge(unreadCount));
        a.addEventListener('click', () => setMobileNav(false));
        box.appendChild(a);
      }
      sidebar.appendChild(box);
    }
    const logoutBtn = h('button', { class: 'nav-item', type: 'button', onclick: () => void onLogout() },
      icon('logout'), h('span', { class: 'nav-label' }, t('nav.logout')));
    const footer = h('div', { class: 'nav-section' });
    footer.style.marginTop = 'auto';
    footer.appendChild(logoutBtn);
    sidebar.appendChild(footer);
  }

  function routeMatches(route: string): boolean {
    if (route === '/') return activeRoute === '/';
    return activeRoute === route || activeRoute.startsWith(`${route}/`);
  }

  // ---------- header ----------
  const menuBtn = h('button', { class: 'btn btn-ghost', type: 'button', 'aria-label': t('nav.menuOpen') }, icon('menu'));
  menuBtn.addEventListener('click', () => {
    if (window.matchMedia('(max-width: 900px)').matches) setMobileNav(!navOpenMobile);
    else {
      collapsed = !collapsed;
      shell.classList.toggle('collapsed', collapsed);
    }
  });

  const langBtn = h('button', { class: 'btn btn-ghost', type: 'button', 'aria-label': t('app.language') },
    icon('globe'), h('span', {}, getLocale().toUpperCase()));
  langBtn.addEventListener('click', () => {
    const next = getLocale() === 'fr' ? 'en' : 'fr';
    onLocale(next);
  });

  const bellLink = h('a', { class: 'btn btn-ghost', href: '#/notifications', 'aria-label': t('nav.notifications') }, icon('bell'));
  const profileEl = h('span', { class: 'mono' }, session.me?.email ?? '');

  const header = h('header', { class: 'header' },
    menuBtn,
    breadcrumbEl,
    h('span', { class: 'spacer' }),
    bellLink,
    langBtn,
    h('span', { class: 'btn btn-ghost', 'aria-label': t('nav.profile') }, icon('user'), profileEl),
  );

  const main = h('div', { class: 'shell-main' }, banners, header, outlet);
  shell.appendChild(sidebar);
  shell.appendChild(main);

  const skip = h('a', { class: 'skip-link', href: '#main' }, t('app.skipToContent'));
  const root = h('div', {}, skip, scrim, shell);

  const offlineBanner = h('div', { class: 'banner banner-offline glass' }, t('app.offlineBanner'));

  const api: ShellController = {
    root,
    outlet,
    setBreadcrumb(crumbs) {
      clear(breadcrumbEl);
      crumbs.forEach((c, i) => {
        if (i > 0) breadcrumbEl.appendChild(h('span', { class: 'sep', 'aria-hidden': 'true' }, '›'));
        breadcrumbEl.appendChild(c.route
          ? h('a', { href: `#${c.route}` }, c.label)
          : h('span', { 'aria-current': 'page' }, c.label));
      });
    },
    setActiveRoute(route) {
      activeRoute = route;
      renderSidebar();
    },
    setInboxCount(n) {
      inboxCount = n;
      renderSidebar();
    },
    setUnreadCount(n) {
      unreadCount = n;
      renderSidebar();
    },
    showUpdateBanner(onReload) {
      const bar = h('div', { class: 'banner banner-update glass' },
        h('span', {}, t('app.updateReady')),
        button(t('app.updateReload'), onReload, { variant: 'primary', small: true }),
      );
      banners.appendChild(bar);
    },
    setOffline(offline) {
      if (offline) {
        if (!banners.contains(offlineBanner)) banners.appendChild(offlineBanner);
      } else {
        offlineBanner.remove();
      }
    },
    refreshNav() {
      renderSidebar();
      profileEl.textContent = session.me?.email ?? '';
      const langSpan = langBtn.querySelector('span:not(.icon)');
      if (langSpan) langSpan.textContent = getLocale().toUpperCase();
    },
  };

  renderSidebar();
  return api;
}

export function crumbsOf(...pairs: Array<[MessageKey, string | null]>): Crumb[] {
  return pairs.map(([key, route]) => ({ label: t(key), route: route ?? undefined }));
}

export function crumbRaw(label: string): Crumb {
  return { label };
}

export { navigate };
