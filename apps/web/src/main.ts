/**
 * KORA PWA — point d'entrée (E7, durci en clôture Phase 1).
 * Assemble : session par cookie HttpOnly (AUCUN jeton côté client, CSRF en mémoire,
 * purge sur 401), routeur à permissions d'AFFICHAGE (le serveur reste seul juge),
 * coquille, pages, service worker (shell seulement — jamais de donnée RH en cache),
 * bandeaux hors-ligne / nouvelle version.
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
import {
  timeAssignmentsPage, timeBatchDetailPage, timeBatchesPage, timeDevicesPage,
  timeImportPage, timeMinePage, timeModelDetailPage, timeModelsPage,
  timePunchesPage, timeUnmatchedPage,
} from './pages/time.ts';
import {
  timeAnomaliesPage, timeDayDetailPage, timeEmployeeCalendarPage,
  timeMyPresencePage, timeResultsPage, timeRunsPage,
} from './pages/time-calc.ts';
import {
  timeMyRequestsPage, timePayrollPage, timePeriodsPage, timeRequestsPage,
} from './pages/time-corrections.ts';
import {
  leaveBalancesPage, leaveCatalogPage, leaveMinePage, leaveRunsPage,
} from './pages/leave.ts';
import {
  leaveCalendarPage, leaveMyRequestsPage, leaveRequestNewPage, leaveTeamRequestsPage,
} from './pages/leave-requests.ts';
import {
  leaveClosePage, leaveIntegrationPage, leaveReportsPage,
} from './pages/leave-close.ts';
import {
  payrollPeriodsPage, payrollResultsPage, payrollRubricsPage,
} from './pages/payroll.ts';
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
  // Temps & pointage (E10.1) — l'affichage suit les permissions, le serveur tranche.
  { pattern: '/time/schedules', render: () => timeModelsPage(session), anyOf: ['time.schedules_view', 'time.schedules_manage', 'time.schedules_assign'] },
  { pattern: '/time/schedules/:id', render: (m) => timeModelDetailPage(session, m.params['id']!), anyOf: ['time.schedules_view', 'time.schedules_manage', 'time.schedules_assign'] },
  { pattern: '/time/assignments', render: () => timeAssignmentsPage(session), anyOf: ['time.schedules_assign', 'time.schedules_view'] },
  { pattern: '/time/import', render: () => timeImportPage(session), anyOf: ['time.punches_import'] },
  { pattern: '/time/batches', render: () => timeBatchesPage(session), anyOf: ['time.punches_view_errors', 'time.punches_import'] },
  { pattern: '/time/batches/:id', render: (m) => timeBatchDetailPage(session, m.params['id']!), anyOf: ['time.punches_view_errors', 'time.punches_import'] },
  { pattern: '/time/punches', render: () => timePunchesPage(session), anyOf: ['time.punches_view'] },
  { pattern: '/time/unmatched', render: () => timeUnmatchedPage(session), anyOf: ['time.punches_view_errors', 'time.punches_import', 'time.devices_manage'] },
  { pattern: '/time/devices', render: () => timeDevicesPage(session), anyOf: ['time.devices_manage'] },
  { pattern: '/time/mine', render: () => timeMinePage(session), anyOf: ['time.punches_view_own'] },
  // Moteur de présence (E10.2) — résultats versionnés, anomalies, exécutions.
  { pattern: '/time/results', render: () => timeResultsPage(session), anyOf: ['time.results_view'] },
  { pattern: '/time/results/:id/:date', render: (m) => timeDayDetailPage(session, m.params['id']!, m.params['date']!), anyOf: ['time.results_view', 'time.results_view_own'] },
  { pattern: '/time/calendar/:id', render: (m) => timeEmployeeCalendarPage(session, m.params['id']!), anyOf: ['time.results_view', 'time.results_view_own'] },
  { pattern: '/time/anomalies', render: () => timeAnomaliesPage(session), anyOf: ['time.anomalies_view', 'time.anomalies_manage'] },
  { pattern: '/time/runs', render: () => timeRunsPage(session), anyOf: ['time.calc_view', 'time.calc_run', 'time.calc_recalc'] },
  { pattern: '/time/presence', render: () => timeMyPresencePage(session), anyOf: ['time.results_view_own'] },
  // Corrections, clôture et préparation paie (E10.3).
  { pattern: '/time/requests-mine', render: () => timeMyRequestsPage(session), anyOf: ['time.correction_request_self'] },
  { pattern: '/time/requests', render: () => timeRequestsPage(session), anyOf: ['time.correction_view', 'time.correction_admin'] },
  { pattern: '/time/periods', render: () => timePeriodsPage(session), anyOf: ['time.period_manage', 'time.preclose_view', 'time.period_close', 'time.period_reopen'] },
  { pattern: '/time/payroll', render: () => timePayrollPage(session), anyOf: ['time.payroll_view', 'time.payroll_export'] },
  // Congés & absences (E11.1).
  { pattern: '/leave/catalog', render: () => leaveCatalogPage(session), anyOf: ['leave.types_admin', 'leave.policies_admin', 'leave.accrual_run'] },
  { pattern: '/leave/runs', render: () => leaveRunsPage(session), anyOf: ['leave.accrual_run', 'leave.openings_import'] },
  { pattern: '/leave/balances', render: () => leaveBalancesPage(session), anyOf: ['leave.balance_view', 'leave.balance_view_team'] },
  { pattern: '/leave/mine', render: () => leaveMinePage(session), anyOf: ['leave.balance_view_own'] },
  { pattern: '/leave/requests/new', render: () => leaveRequestNewPage(session), anyOf: ['leave.request_self', 'leave.request_for_others'] },
  { pattern: '/leave/requests/mine', render: () => leaveMyRequestsPage(session), anyOf: ['leave.requests_view_own', 'leave.request_self'] },
  { pattern: '/leave/requests/team', render: () => leaveTeamRequestsPage(session, 'team'), anyOf: ['leave.requests_view_team'] },
  { pattern: '/leave/requests/queue', render: () => leaveTeamRequestsPage(session, 'queue'), anyOf: ['leave.requests_admin'] },
  { pattern: '/leave/calendar', render: () => leaveCalendarPage(session), anyOf: ['leave.calendar_view', 'leave.requests_view_team'] },
  // Intégration présence, clôture, préparation paie, reporting (E11.3).
  { pattern: '/leave/integration', render: () => leaveIntegrationPage(session), anyOf: ['leave.integration_run', 'leave.close_run', 'leave.close_view', 'leave.requests_admin'] },
  { pattern: '/leave/periods', render: () => leaveClosePage(session), anyOf: ['leave.period_manage', 'leave.close_run', 'leave.close_view', 'leave.reopen'] },
  { pattern: '/leave/reports', render: () => leaveReportsPage(session), anyOf: ['leave.reports_view'] },
  // Paie brute (E12.1).
  { pattern: '/payroll/periods', render: () => payrollPeriodsPage(session), anyOf: ['payroll.calendar_manage', 'payroll.run', 'payroll.results_view'] },
  { pattern: '/payroll/rubrics', render: () => payrollRubricsPage(session), anyOf: ['payroll.rubrics_manage', 'payroll.structures_manage', 'payroll.results_view'] },
  { pattern: '/payroll/results', render: () => payrollResultsPage(session), anyOf: ['payroll.results_view', 'payroll.simulate', 'payroll.run'] },
];

const CRUMB_BY_PREFIX: Array<[string, () => ReturnType<typeof crumbsOf>]> = [
  ['/employees', () => crumbsOf(['nav.dashboard', '/'], ['nav.employees', null])],
  ['/org/chart', () => crumbsOf(['nav.dashboard', '/'], ['nav.organization', '/org/units'], ['nav.orgChart', null])],
  ['/org', () => crumbsOf(['nav.dashboard', '/'], ['nav.organization', null])],
  ['/workflow', () => crumbsOf(['nav.dashboard', '/'], ['nav.workflow', null])],
  ['/notifications', () => crumbsOf(['nav.dashboard', '/'], ['nav.notifications', null])],
  ['/me/sessions', () => crumbsOf(['nav.dashboard', '/'], ['nav.sessions', null])],
  ['/me/password', () => crumbsOf(['nav.dashboard', '/'], ['nav.password', null])],
  ['/time/schedules', () => crumbsOf(['nav.dashboard', '/'], ['nav.time', '/time/schedules'], ['nav.timeSchedules', null])],
  ['/time/assignments', () => crumbsOf(['nav.dashboard', '/'], ['nav.time', '/time/schedules'], ['nav.timeAssignments', null])],
  ['/time/import', () => crumbsOf(['nav.dashboard', '/'], ['nav.time', '/time/schedules'], ['nav.timeImport', null])],
  ['/time/batches', () => crumbsOf(['nav.dashboard', '/'], ['nav.time', '/time/schedules'], ['nav.timeBatches', null])],
  ['/time/punches', () => crumbsOf(['nav.dashboard', '/'], ['nav.time', '/time/schedules'], ['nav.timePunches', null])],
  ['/time/unmatched', () => crumbsOf(['nav.dashboard', '/'], ['nav.time', '/time/schedules'], ['nav.timeUnmatched', null])],
  ['/time/devices', () => crumbsOf(['nav.dashboard', '/'], ['nav.time', '/time/schedules'], ['nav.timeDevices', null])],
  ['/time/mine', () => crumbsOf(['nav.dashboard', '/'], ['nav.time', '/time/schedules'], ['nav.timeMine', null])],
  ['/time/results', () => crumbsOf(['nav.dashboard', '/'], ['nav.time', '/time/schedules'], ['nav.timeResults', null])],
  ['/time/calendar', () => crumbsOf(['nav.dashboard', '/'], ['nav.time', '/time/schedules'], ['nav.timeResults', null])],
  ['/time/anomalies', () => crumbsOf(['nav.dashboard', '/'], ['nav.time', '/time/schedules'], ['nav.timeAnomalies', null])],
  ['/time/runs', () => crumbsOf(['nav.dashboard', '/'], ['nav.time', '/time/schedules'], ['nav.timeRuns', null])],
  ['/time/presence', () => crumbsOf(['nav.dashboard', '/'], ['nav.time', '/time/schedules'], ['nav.timeMyPresence', null])],
  ['/time/requests-mine', () => crumbsOf(['nav.dashboard', '/'], ['nav.time', '/time/schedules'], ['nav.timeMyRequests', null])],
  ['/time/requests', () => crumbsOf(['nav.dashboard', '/'], ['nav.time', '/time/schedules'], ['nav.timeRequests', null])],
  ['/time/periods', () => crumbsOf(['nav.dashboard', '/'], ['nav.time', '/time/schedules'], ['nav.timePeriods', null])],
  ['/time/payroll', () => crumbsOf(['nav.dashboard', '/'], ['nav.time', '/time/schedules'], ['nav.timePayroll', null])],
  ['/leave/catalog', () => crumbsOf(['nav.dashboard', '/'], ['nav.leave', '/leave/mine'], ['nav.leaveCatalog', null])],
  ['/leave/runs', () => crumbsOf(['nav.dashboard', '/'], ['nav.leave', '/leave/mine'], ['nav.leaveRuns', null])],
  ['/leave/balances', () => crumbsOf(['nav.dashboard', '/'], ['nav.leave', '/leave/mine'], ['nav.leaveBalances', null])],
  ['/leave/mine', () => crumbsOf(['nav.dashboard', '/'], ['nav.leave', '/leave/mine'], ['nav.leaveMine', null])],
  ['/leave/requests/new', () => crumbsOf(['nav.dashboard', '/'], ['nav.leave', '/leave/mine'], ['nav.leaveNew', null])],
  ['/leave/requests/mine', () => crumbsOf(['nav.dashboard', '/'], ['nav.leave', '/leave/mine'], ['nav.leaveRequests', null])],
  ['/leave/requests/team', () => crumbsOf(['nav.dashboard', '/'], ['nav.leave', '/leave/mine'], ['nav.leaveTeam', null])],
  ['/leave/requests/queue', () => crumbsOf(['nav.dashboard', '/'], ['nav.leave', '/leave/mine'], ['nav.leaveQueue', null])],
  ['/leave/calendar', () => crumbsOf(['nav.dashboard', '/'], ['nav.leave', '/leave/mine'], ['nav.leaveCalendar', null])],
  ['/leave/integration', () => crumbsOf(['nav.dashboard', '/'], ['nav.leave', '/leave/mine'], ['nav.leaveIntegration', null])],
  ['/leave/periods', () => crumbsOf(['nav.dashboard', '/'], ['nav.leave', '/leave/mine'], ['nav.leavePeriods', null])],
  ['/leave/reports', () => crumbsOf(['nav.dashboard', '/'], ['nav.leave', '/leave/mine'], ['nav.leaveReports', null])],
  ['/payroll/periods', () => crumbsOf(['nav.dashboard', '/'], ['nav.payroll', '/payroll/periods'], ['nav.payrollPeriods', null])],
  ['/payroll/rubrics', () => crumbsOf(['nav.dashboard', '/'], ['nav.payroll', '/payroll/periods'], ['nav.payrollRubrics', null])],
  ['/payroll/results', () => crumbsOf(['nav.dashboard', '/'], ['nav.payroll', '/payroll/periods'], ['nav.payrollResults', null])],
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
