/**
 * Navigation par permissions (E7) — modèle d'AFFICHAGE uniquement.
 * Masquer un menu n'est JAMAIS un contrôle de sécurité : chaque route API applique ses
 * gardes ; le routeur re-vérifie ; le serveur tranche.
 */
import type { MessageKey } from './i18n.ts';

export interface NavItem {
  route: string;
  labelKey: MessageKey;
  /** L'entrée s'affiche si l'utilisateur porte AU MOINS UNE de ces permissions. */
  anyOf: string[];
  icon: string; // identifiant d'icône interne (dessinée en CSS/SVG maison)
}

export interface NavSection {
  labelKey: MessageKey;
  items: NavItem[];
}

/** Déclaration UNIQUE de la carte de navigation (sections métier séparées). */
export const NAV_MAP: NavSection[] = [
  {
    labelKey: 'nav.dashboard',
    items: [
      { route: '/', labelKey: 'nav.dashboard', anyOf: [], icon: 'home' },
      { route: '/workflow', labelKey: 'nav.workflow', anyOf: ['workflow.view'], icon: 'tasks' },
      { route: '/notifications', labelKey: 'nav.notifications', anyOf: [], icon: 'bell' },
    ],
  },
  {
    labelKey: 'nav.hr',
    items: [
      { route: '/employees', labelKey: 'nav.employees', anyOf: ['employees.view'], icon: 'people' },
    ],
  },
  {
    labelKey: 'nav.organization',
    items: [
      { route: '/org/units', labelKey: 'nav.orgUnits', anyOf: ['org.view'], icon: 'org' },
      { route: '/org/chart', labelKey: 'nav.orgChart', anyOf: ['org.view'], icon: 'chart' },
      { route: '/org/companies', labelKey: 'nav.orgCompanies', anyOf: ['org.view'], icon: 'building' },
      { route: '/org/positions', labelKey: 'nav.orgPositions', anyOf: ['org.view'], icon: 'seat' },
    ],
  },
  {
    labelKey: 'nav.time',
    items: [
      { route: '/time/schedules', labelKey: 'nav.timeSchedules', anyOf: ['time.schedules_view', 'time.schedules_manage', 'time.schedules_assign'], icon: 'clock' },
      { route: '/time/assignments', labelKey: 'nav.timeAssignments', anyOf: ['time.schedules_assign', 'time.schedules_view'], icon: 'calendar' },
      { route: '/time/import', labelKey: 'nav.timeImport', anyOf: ['time.punches_import'], icon: 'upload' },
      { route: '/time/batches', labelKey: 'nav.timeBatches', anyOf: ['time.punches_view_errors', 'time.punches_import'], icon: 'layers' },
      { route: '/time/punches', labelKey: 'nav.timePunches', anyOf: ['time.punches_view'], icon: 'fingerprint' },
      { route: '/time/unmatched', labelKey: 'nav.timeUnmatched', anyOf: ['time.punches_view_errors', 'time.punches_import', 'time.devices_manage'], icon: 'alert' },
      { route: '/time/devices', labelKey: 'nav.timeDevices', anyOf: ['time.devices_manage'], icon: 'device' },
      { route: '/time/mine', labelKey: 'nav.timeMine', anyOf: ['time.punches_view_own'], icon: 'stamp' },
    ],
  },
  {
    labelKey: 'nav.admin',
    items: [
      { route: '/admin/users', labelKey: 'nav.adminUsers', anyOf: ['users.view'], icon: 'shield' },
      { route: '/config', labelKey: 'nav.config', anyOf: ['parameters.view'], icon: 'sliders' },
      { route: '/audit', labelKey: 'nav.audit', anyOf: ['audit.view', 'audit.view_own'], icon: 'scroll' },
    ],
  },
  {
    labelKey: 'nav.personal',
    items: [
      { route: '/me/sessions', labelKey: 'nav.sessions', anyOf: [], icon: 'devices' },
      { route: '/me/password', labelKey: 'nav.password', anyOf: [], icon: 'key' },
    ],
  },
];

export function allowed(item: NavItem, permissions: readonly string[]): boolean {
  if (item.anyOf.length === 0) return true;
  return item.anyOf.some((p) => permissions.includes(p) || matchesPrefixFamily(p, permissions));
}

/** audit.view_own / audit.view_<module> ouvrent la consultation d'audit. */
function matchesPrefixFamily(required: string, permissions: readonly string[]): boolean {
  if (required === 'audit.view') return permissions.some((p) => p.startsWith('audit.view'));
  return false;
}

/** Sections visibles pour un ensemble de permissions (sections vides retirées). */
export function visibleNav(permissions: readonly string[]): NavSection[] {
  return NAV_MAP
    .map((s) => ({ labelKey: s.labelKey, items: s.items.filter((i) => allowed(i, permissions)) }))
    .filter((s) => s.items.length > 0);
}

/** Permissions minimales par route (garde d'affichage du routeur — le serveur re-tranche). */
export function routeRequirement(route: string): string[] {
  for (const section of NAV_MAP) {
    for (const item of section.items) {
      if (item.route === route || (item.route !== '/' && route.startsWith(item.route))) return item.anyOf;
    }
  }
  return [];
}
