/**
 * KORA PWA — point d'entrée (E7).
 * Assemble : session (jeton mémoire+onglet, purge sur 401), routeur à permissions
 * d'AFFICHAGE (le serveur reste seul juge), coquille, pages, service worker (shell
 * seulement — jamais de donnée RH en cache), bandeaux hors-ligne / nouvelle version.
 */
import { ApiClient, ApiError } from './core/api.ts';
import { Session } from './core/session.ts';
import { initLocale, onLocaleChange, t } from './core/i18n.ts';
import { h, mount } from './core/dom.ts';
import { matchRoute, navigate, parseHash, type RouteDef } from './core/router.ts';
import { routeRequirement } from './core/permissions.ts';
import { registerServiceWorker } from './pwa/register.ts';
import { buildShell, crumbRaw, crumbsOf, type ShellController } from './pages/shell.ts';
import { loginPage } from './pages/login.ts';
import { dashboardPage } from './pages/dashboard.ts';
import { employeesListPage, employeeDetailPage } from './pages/employees.ts';
import { orgChartPage, orgListPage } from './pages/org.ts';
import { workflowPage } from './pages/workflow.ts';
import { notificationsPage, passwordPage, sessionsPage } from './pages/account.ts';
import { adminUsersPage } from './pages/admin.ts';
import { auditPage, configPage } from './pages/config-audit.ts';
import { states, stateForError } from './ui/kit.ts';

const appRoot = document.getElementById('app')!;
initLocale();
document.documentElement.lang = initLocale();

const api = new ApiClient({
  onUnauthorized: () => {
    // Session révoquée, expirée ou compte désactivé : purge IMMÉDIATE + retour connexion.
    session.purge();
  },
});
const session = new Session(api);

let shell: ShellController | null = null;
const sw = registerServiceWorker();

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const routes: RouteDef[] = [
  { pattern: '/', render: () => dashboardPage(session) },
  { pattern: '/employees', render: (m) => employeesListPage(session, m.query), anyOf: ['employees.view'] },
  { pattern: '/employees/:id', render: (m) => employeeDetailPage(session, m.params['id']!), anyOf: ['employees.view'] },
  { pattern: '/org/companies', render: () => orgListPage(session, 'companies'), anyOf: ['org.view'] },
  { pattern: '/org/units', render: () => orgListPage(session, 'units'), anyOf: ['org.view'] },
  { pattern: '/org/positions', render: () => orgListPage(session, 'positions'), anyOf: ['org.view'] },
  { pattern: '/org/chart', render: () => orgChartPage(session), anyOf: ['org.view'] },
  { pattern: '/workflow', render: () => workflowPage(session, (n) => shell?.setInboxCount(n)), anyOf: ['workflow.view'] },
  { pattern: '/notifications', render: () => notificationsPage(session, (n) => shell?.setUnreadCount(n)) },
  { pattern: '/me/sessions', render: () => sessionsPage(session) },
  { pattern: '/me/password', render: () => Promise.resolve(passwordPage(session)) },
  { pattern: '/admin/users', render: () => adminUsersPage(session), anyOf: ['users.view'] },
  { pattern: '/config', render: () => Promise.resolve(configPage(session)), anyOf: ['parameters.view'] },
  { pattern: '/audit', render: () => auditPage(session), anyOf: ['audit.view', 'audit.view_own'] },
];

const CRUMB_BY_PREFIX: Array<[string, () => ReturnType<typeof crumbsOf>]> = [
  ['/employees', () => crumbsOf(['nav.dashboard', '/'], ['nav.employees', null])],
  ['/org/chart', () => crumbsOf(['nav.dashboard', '/'], ['nav.organization', '/org/units'], ['nav.orgChart', null])],
  ['/org', () => crumbsOf(['nav.dashboard', '/'], ['nav.organization', null])],
  ['/workflow', () => crumbsOf(['nav.dashboard', '/'], ['nav.workflow', null])],
  ['/notifications', () => crumbsOf(['nav.dashboard', '/'], ['nav.notifications', null])],
  ['/me/sessions', () => crumbsOf(['nav.dashboard', '/'], ['nav.sessions', null])],
  ['/me/password', () => crumbsOf(['nav.dashboard', '/'], ['nav.password', null])],
  ['/admin', () => crumbsOf(['nav.dashboard', '/'], ['nav.adminUsers', null])],
  ['/config', () => crumbsOf(['nav.dashboard', '/'], ['nav.config', null])],
  ['/audit', () => crumbsOf(['nav.dashboard', '/'], ['nav.audit', null])],
];

function hasAnyPermission(anyOf: string[] | undefined): boolean {
  if (!anyOf || anyOf.length === 0) return true;
  const perms = session.me?.permissions ?? [];
  return anyOf.some((p) => perms.includes(p) || (p === 'audit.view' && perms.some((x) => x.startsWith('audit.view'))));
}

// ---------------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------------

let renderSeq = 0;

async function renderRoute(): Promise<void> {
  const seq = ++renderSeq;
  const { path, query } = parseHash(location.hash);

  if (!session.isAuthenticated()) {
    shell = null;
    mount(appRoot, loginPage(session, () => {
      void enterApp();
    }, (l) => {
      void session.persistLocale(l);
    }));
    return;
  }

  if (!shell) buildAppShell();
  const s = shell!;
  s.setActiveRoute(path);
  const crumbEntry = CRUMB_BY_PREFIX.find(([prefix]) => path.startsWith(prefix) && prefix !== '/');
  s.setBreadcrumb(crumbEntry ? crumbEntry[1]() : [crumbRaw(t('nav.dashboard'))]);

  const match = matchRoute(routes, path);
  if (!match) {
    mount(s.outlet, states.notFound());
    return;
  }
  const required = match.def.anyOf ?? routeRequirement(path);
  if (!hasAnyPermission(required)) {
    mount(s.outlet, states.forbidden());
    return;
  }
  mount(s.outlet, states.loading());
  try {
    const el = await match.def.render({ pattern: match.def.pattern, params: match.params, query });
    if (seq !== renderSeq) return; // une navigation plus récente a eu lieu
    mount(s.outlet, el);
    s.outlet.focus();
  } catch (e) {
    if (seq !== renderSeq) return;
    mount(s.outlet, stateForError(e as ApiError, () => void renderRoute()));
  }
}

function buildAppShell(): void {
  shell = buildShell(session,
    async () => {
      await session.logout();
      navigate('/');
    },
    (l) => {
      void session.persistLocale(l);
    });
  mount(appRoot, shell.root);
  sw.onUpdateReady(() => shell?.showUpdateBanner(() => sw.applyUpdate()));
  shell.setOffline(!navigator.onLine);
  // Compteurs d'entête (meilleur effort, jamais bloquant).
  void refreshCounters();
}

async function refreshCounters(): Promise<void> {
  if (!session.isAuthenticated() || !shell) return;
  if (session.hasPermission('workflow.view')) {
    try {
      const inbox = await api.call<{ items: unknown[] }>('workflowInstances', { query: { box: 'inbox' } });
      shell.setInboxCount(inbox.items.length);
    } catch { /* silencieux */ }
  }
  try {
    const unread = await api.call<{ unreadCount: number }>('notifications', { query: { unread: 1, limit: 1 } });
    shell.setUnreadCount(unread.unreadCount);
  } catch { /* silencieux */ }
}

async function enterApp(): Promise<void> {
  shell = null;
  navigate('/');
  await renderRoute();
}

// ---------------------------------------------------------------------------
// Réactions globales
// ---------------------------------------------------------------------------

session.onChange(() => {
  // Déconnexion (purge) pendant l'utilisation → retour immédiat à la connexion.
  if (!session.isAuthenticated() && shell) {
    shell = null;
    void renderRoute();
  }
});

onLocaleChange(() => {
  // Tout l'écran se re-rend dans la nouvelle langue (dictionnaires complets).
  if (session.isAuthenticated()) {
    shell = null;
    void renderRoute();
  } else {
    void renderRoute();
  }
});

window.addEventListener('hashchange', () => void renderRoute());
window.addEventListener('online', () => shell?.setOffline(false));
window.addEventListener('offline', () => shell?.setOffline(true));

// ---------------------------------------------------------------------------
// Démarrage : reprise de session d'onglet puis rendu.
// ---------------------------------------------------------------------------

void (async () => {
  mount(appRoot, h('div', { class: 'login-wrap' }, states.loading()));
  await session.resume();
  await renderRoute();
})();
