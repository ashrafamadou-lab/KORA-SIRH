/**
 * ============================== DEMO ONLY ==================================
 * Serveur de PRÉVISUALISATION LOCALE : sert la PWA construite (dist/) et SIMULE
 * l'API avec des données factices, pour développer/capturer les écrans SANS base.
 * N'EST JAMAIS un composant de production : la PWA réelle parle à l'API KORA (E1-E9).
 * Lancement : node apps/web/scripts/preview-demo.mjs [port]
 * ===========================================================================
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(dirname(fileURLToPath(import.meta.url))), 'dist');
const port = Number(process.argv[2] ?? 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

// ---------------------------------------------------------------------------
// Données de DÉMONSTRATION (fictives, tenant « Société Béninoise de Textile »)
// ---------------------------------------------------------------------------

const T = { slug: 'sbt', name: 'Société Béninoise de Textile' };
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CO = [{ id: uid(1), code: 'SBT-SA', labelFr: 'SBT S.A.', labelEn: 'SBT Ltd', status: 'active' }];
const UNITS = [
  { id: uid(10), code: 'DG', labelFr: 'Direction Générale', labelEn: 'General Management', unitType: 'direction', companyId: uid(1), parentUnitId: null, status: 'active' },
  { id: uid(11), code: 'DRH', labelFr: 'Direction des Ressources Humaines', labelEn: 'HR Directorate', unitType: 'direction', companyId: uid(1), parentUnitId: uid(10), status: 'active' },
  { id: uid(12), code: 'PROD', labelFr: 'Département Production', labelEn: 'Production Dept', unitType: 'department', companyId: uid(1), parentUnitId: uid(10), status: 'active' },
  { id: uid(13), code: 'QUAL', labelFr: 'Service Qualité', labelEn: 'Quality Service', unitType: 'service', companyId: uid(1), parentUnitId: uid(12), status: 'active' },
  { id: uid(14), code: 'FIN', labelFr: 'Département Finances', labelEn: 'Finance Dept', unitType: 'department', companyId: uid(1), parentUnitId: uid(10), status: 'active' },
];
const EMP = [
  ['SBT-0001', 'Awa', 'Sossou', 'active', '2021-03-01', 'Cadre', 'DRH'],
  ['SBT-0002', 'Bio', 'Kassim', 'active', '2019-09-15', 'Agent de maîtrise', 'PROD'],
  ['SBT-0003', 'Chantal', 'Dossou', 'active', '2020-01-06', 'Cadre', 'PROD'],
  ['SBT-0004', 'Dieudonné', 'Agbodjan', 'on_leave', '2018-05-02', 'Ouvrier qualifié', 'QUAL'],
  ['SBT-0005', 'Edwige', 'Houngbo', 'active', '2023-11-20', 'Cadre', 'FIN'],
  ['SBT-0006', 'Faustin', 'Zinsou', 'suspended', '2022-02-14', 'Agent', 'PROD'],
  ['SBT-0007', 'Grâce', 'Amoussou', 'active', '2024-06-01', 'Cadre junior', 'QUAL'],
  ['SBT-0008', 'Hervé', 'Tokoudagba', 'terminated', '2017-08-21', 'Agent', 'FIN'],
].map(([matricule, firstName, lastName, status, hireDate, professionalStatus, unitCode], i) => ({
  id: uid(100 + i), matricule, firstName, lastName, usageFirstName: null, usageLastName: null,
  status, hireDate, professionalStatus, employerCompanyId: uid(1), mainSiteId: null,
  workEmail: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@sbt.bj`.normalize('NFD').replace(/[̀-ͯ]/g, ''),
  workPhone: `+229 01 9${i} 00 0${i}`, photoRef: null, _unit: unitCode,
}));

const routesDemo = {
  // Transport cookie (clôture Phase 1) : le jeton simulé part en HttpOnly, jamais
  // dans le corps ; le CSRF de démonstration est fixe.
  'POST /auth/login': () => ({ expiresAt: new Date(Date.now() + 864e5).toISOString(), user: { id: uid(500), email: 'demo.rh@sbt.bj' }, csrfToken: 'demo-csrf' }),
  'POST /auth/logout': () => null,
  'GET /auth/me': () => ({
    csrfToken: 'demo-csrf',
    tenantId: uid(900), userId: uid(500), sessionId: uid(901), email: 'demo.rh@sbt.bj',
    permissions: ['employees.view', 'employees.view_private', 'employees.view_identifiers', 'employees.view_documents',
      'employees.view_history', 'workflow.view', 'workflow.act', 'org.view', 'users.view', 'users.create',
      'users.manage_roles', 'sessions.revoke', 'audit.view', 'audit.export', 'parameters.view',
      'time.schedules_view', 'time.schedules_manage', 'time.schedules_assign', 'time.punches_import',
      'time.punches_view', 'time.punches_view_errors', 'time.punches_view_own', 'time.devices_manage',
      'time.results_view', 'time.results_view_own', 'time.anomalies_view', 'time.anomalies_manage',
      'time.calc_run', 'time.calc_recalc', 'time.calc_view',
      'time.correction_request_self', 'time.correction_request', 'time.correction_view', 'time.correction_admin',
      'time.attachments_view', 'time.preclose_view', 'time.period_manage', 'time.period_close',
      'time.period_reopen', 'time.payroll_view', 'time.payroll_export', 'time.rules_admin'],
    scopes: [{ type: 'tenant', ref: null }], roles: [{ key: 'rh-admin', name: 'Administrateur RH' }],
    locale: 'fr', mfaEnabled: true, tenant: T,
  }),
  'GET /auth/sessions': () => ([
    { id: uid(901), createdAt: '2026-08-01T08:12:00Z', lastSeenAt: new Date().toISOString(), expiresAt: '', ip: '154.66.135.10', userAgent: 'Chrome — Windows', current: true },
    { id: uid(902), createdAt: '2026-07-30T17:40:00Z', lastSeenAt: '2026-07-31T09:02:00Z', expiresAt: '', ip: '41.85.161.72', userAgent: 'KORA PWA — Android', current: false },
  ]),
  'POST /auth/sessions/revoke-others': () => ({ revoked: 1 }),
  'GET /notifications': () => ({
    items: [
      { id: uid(300), templateKey: 'hr.change_applied', locale: 'fr', subject: 'Dossier SBT-0004 — changement appliqué', body: 'Le changement (statut active → on_leave) prend effet le 15/07/2026.', mandatory: false, readAt: null, archivedAt: null, createdAt: '2026-07-15T10:00:00Z' },
      { id: uid(301), templateKey: 'workflow.step_pending', locale: 'fr', subject: 'Validation attendue — mutation SBT-0002', body: 'Une demande attend votre décision (étape Validation RH).', mandatory: true, readAt: null, archivedAt: null, createdAt: '2026-07-28T14:30:00Z' },
      { id: uid(302), templateKey: 'org.unit_moved', locale: 'fr', subject: 'Réorganisation — QUAL', body: 'L’unité QUAL change de rattachement au 01/09/2026.', mandatory: false, readAt: '2026-07-20T08:00:00Z', archivedAt: null, createdAt: '2026-07-19T16:45:00Z' },
    ], unreadCount: 2,
  }),
  'PUT /notifications/preferences': () => ({ locale: 'fr', channels: {} }),
  'GET /employees': (q) => {
    let items = EMP;
    if (q.get('status')) items = items.filter((e) => e.status === q.get('status'));
    const needle = (q.get('query') ?? '').toLowerCase();
    if (needle) items = items.filter((e) => `${e.matricule} ${e.firstName} ${e.lastName}`.toLowerCase().includes(needle));
    return { items, count: items.length, limit: 200 };
  },
  'GET /org/companies': () => CO,
  'GET /org/units': () => UNITS,
  'GET /org/positions': () => ([{ id: uid(40), code: 'DAF', labelFr: 'Directeur Administratif et Financier', labelEn: 'CFO', status: 'active' }]),
  'GET /org/chart': () => ({
    date: new Date().toISOString().slice(0, 10),
    tree: [{
      ...UNITS[0], children: [
        { ...UNITS[1], children: [] },
        { ...UNITS[2], children: [{ ...UNITS[3], children: [] }] },
        { ...UNITS[4], children: [] },
      ],
    }],
  }),
  'GET /workflow/instances': (q) => ({
    box: q.get('box') ?? 'inbox',
    items: (q.get('box') === 'outbox' ? [
      { id: uid(60), definitionKey: 'hr_status', status: 'approved', currentStepIndex: 0, stepName: 'Validation RH', subjectType: 'hr_change', subjectId: uid(61), createdBy: uid(500), createdAt: '2026-07-10T09:00:00Z', stepDeadline: null, revision: 2 },
    ] : [
      { id: uid(62), definitionKey: 'hr_mutation', status: 'pending', currentStepIndex: 0, stepName: 'Validation RH', subjectType: 'hr_change', subjectId: uid(63), createdBy: uid(501), createdAt: '2026-07-28T14:30:00Z', stepDeadline: '2026-08-04T14:30:00Z', revision: 1 },
      { id: uid(64), definitionKey: 'org_move', status: 'pending', currentStepIndex: 1, stepName: 'Contreseing Direction', subjectType: 'org_change', subjectId: uid(65), createdBy: uid(502), createdAt: '2026-07-30T11:10:00Z', stepDeadline: null, revision: 1 },
    ]),
  }),
  'GET /admin/users': () => ([
    { id: uid(500), email: 'demo.rh@sbt.bj', isActive: true, mfaEnabled: true, roles: ['rh-admin'] },
    { id: uid(501), email: 'chef.prod@sbt.bj', isActive: true, mfaEnabled: false, roles: ['chef-departement'] },
    { id: uid(502), email: 'ancien.compte@sbt.bj', isActive: false, mfaEnabled: false, roles: [] },
  ]),
  'GET /admin/roles': () => ([
    { id: uid(70), key: 'rh-admin', name: 'Administrateur RH', isSystem: false, permissions: ['employees.view', 'employees.manage', 'users.view'] },
    { id: uid(71), key: 'chef-departement', name: 'Chef de département', isSystem: false, permissions: ['employees.view', 'workflow.act'] },
  ]),
  'GET /config/parameters/resolve': () => ({ value: 3.6, unit: 'percent', legalRef: 'CNSS — cotisation salariale (démo)' }),
  'GET /config/parameters/history': () => ([
    { id: uid(80), value: 3.6, unit: 'percent', effectiveFrom: '2025-01-01', effectiveTo: null, status: 'active', scope: 'country' },
    { id: uid(81), value: 3.4, unit: 'percent', effectiveFrom: '2020-01-01', effectiveTo: '2025-01-01', status: 'superseded', scope: 'country' },
  ]),
  'GET /audit/events': () => ({
    items: [
      { id: '9001', occurredAt: '2026-08-01T09:14:00Z', actorUserId: uid(500), action: 'employee_private_viewed', module: 'hr', recordType: 'employee', recordId: uid(100), result: 'success', reason: null },
      { id: '9000', occurredAt: '2026-08-01T09:12:00Z', actorUserId: uid(500), action: 'login', module: 'auth', recordType: 'user', recordId: uid(500), result: 'success', reason: null },
    ], nextCursor: null,
  }),
  // ---------- Temps & pointage (E10.1) — données de DÉMONSTRATION ----------
  'GET /time/schedules/models': () => ({ items: [
    { id: uid(600), code: 'ADMIN-JOUR', labelFr: 'Administratif jour', labelEn: 'Office day', kind: 'fixed', status: 'active', versionCount: 1, lastEffectiveFrom: '2025-01-01', assignedToday: 14 },
    { id: uid(601), code: 'ROT-NUIT-4', labelFr: 'Rotation nuit 4 jours', labelEn: '4-day night rotation', kind: 'rotation', status: 'active', versionCount: 2, lastEffectiveFrom: '2026-09-01', assignedToday: 6 },
  ] }),
  [`GET /time/schedules/models/${uid(601)}`]: () => ({ model: {
    id: uid(601), code: 'ROT-NUIT-4', labelFr: 'Rotation nuit 4 jours', labelEn: '4-day night rotation', kind: 'rotation', status: 'active',
    versions: [
      { id: uid(610), version: 1, effectiveFrom: '2025-06-01', cycleDays: 4, notes: null, days: [
        { dayIndex: 0, isRest: false, startMinute: 1320, endMinute: 1800, breakStartMinute: null, breakEndMinute: null, label: 'Nuit' },
        { dayIndex: 1, isRest: false, startMinute: 480, endMinute: 1020, breakStartMinute: 720, breakEndMinute: 780, label: null },
        { dayIndex: 2, isRest: true, startMinute: null, endMinute: null, breakStartMinute: null, breakEndMinute: null, label: null },
        { dayIndex: 3, isRest: true, startMinute: null, endMinute: null, breakStartMinute: null, breakEndMinute: null, label: null },
      ] },
      { id: uid(611), version: 2, effectiveFrom: '2026-09-01', cycleDays: 4, notes: 'Pause déplacée (accord d’équipe).', days: [
        { dayIndex: 0, isRest: false, startMinute: 1320, endMinute: 1800, breakStartMinute: null, breakEndMinute: null, label: 'Nuit' },
        { dayIndex: 1, isRest: false, startMinute: 480, endMinute: 1020, breakStartMinute: 750, breakEndMinute: 810, label: null },
        { dayIndex: 2, isRest: true, startMinute: null, endMinute: null, breakStartMinute: null, breakEndMinute: null, label: null },
        { dayIndex: 3, isRest: true, startMinute: null, endMinute: null, breakStartMinute: null, breakEndMinute: null, label: null },
      ] },
    ],
  } }),
  'GET /time/schedules/assignments': () => ({ items: [
    { id: uid(620), employeeId: uid(100), matricule: 'SBT-0001', firstName: 'Awa', lastName: 'Sossou', modelId: uid(601), modelCode: 'ROT-NUIT-4', modelLabelFr: 'Rotation nuit 4 jours', modelLabelEn: '4-day night rotation', anchorDate: '2026-01-05', effectiveFrom: '2026-01-05', effectiveTo: null },
    { id: uid(621), employeeId: uid(101), matricule: 'SBT-0002', firstName: 'Bio', lastName: 'Kassim', modelId: uid(600), modelCode: 'ADMIN-JOUR', modelLabelFr: 'Administratif jour', modelLabelEn: 'Office day', anchorDate: '2025-01-06', effectiveFrom: '2025-01-06', effectiveTo: '2026-06-01' },
  ] }),
  'GET /time/devices': () => ({ items: [
    { id: uid(630), code: 'PTR-HALL', label: 'Pointeuse hall d’entrée', kind: 'clock', status: 'active', siteId: null, siteCode: 'COT-SIEGE', timeZone: null, mappingCount: 42 },
    { id: uid(631), code: 'IMPORT-RH', label: 'Fichiers du prestataire de gardiennage', kind: 'csv', status: 'active', siteId: null, siteCode: null, timeZone: null, mappingCount: 0 },
  ] }),
  'GET /time/mappings': () => ({ items: [
    { id: uid(640), externalId: 'BADGE-0142', employeeId: uid(100), matricule: 'SBT-0001', firstName: 'Awa', lastName: 'Sossou', deviceId: uid(630), deviceCode: 'PTR-HALL', status: 'active' },
    { id: uid(641), externalId: 'GARD-77', employeeId: uid(101), matricule: 'SBT-0002', firstName: 'Bio', lastName: 'Kassim', deviceId: null, deviceCode: null, status: 'active' },
  ] }),
  'GET /time/batches': () => ({ items: [
    { id: uid(650), source: 'csv', filename: 'pointages-juillet.csv', status: 'applied', atomic: true, createdAt: '2026-08-01T06:10:00Z', linesReceived: 1240, linesAccepted: 1237, linesDuplicated: 3, linesRejected: 0, linesUnmatched: 2, fileSha256: 'a'.repeat(64), fileKept: true, createdByEmail: 'demo.rh@sbt.bj' },
    { id: uid(651), source: 'xlsx', filename: 'gardiennage-s30.xlsx', status: 'rejected', atomic: true, createdAt: '2026-07-28T09:02:00Z', linesReceived: 88, linesAccepted: 0, linesDuplicated: 0, linesRejected: 5, linesUnmatched: 0, fileSha256: 'b'.repeat(64), fileKept: true, createdByEmail: 'demo.rh@sbt.bj' },
  ] }),
  [`GET /time/batches/${uid(650)}`]: () => ({ batch: {
    id: uid(650), source: 'csv', filename: 'pointages-juillet.csv', status: 'applied', atomic: true, createdAt: '2026-08-01T06:10:00Z',
    linesReceived: 1240, linesAccepted: 1237, linesDuplicated: 3, linesRejected: 0, linesUnmatched: 2,
    errorReport: [], columnMapping: { matricule: 'external_id', dateheure: 'datetime', sens: 'event_type' },
    fileSha256: 'a'.repeat(64), fileKept: true, createdByEmail: 'demo.rh@sbt.bj',
  } }),
  'GET /time/punches/raw': () => ({ items: [
    { id: uid(660), batchId: uid(650), lineNo: 2, externalEmployeeId: 'BADGE-0142', sourceDateTimeRaw: '2026-07-31 22:03', sourceTz: null, eventTypeRaw: 'E', deviceRef: 'PTR-HALL', deviceCode: 'PTR-HALL', receivedAt: '2026-08-01T06:10:01Z', matchStatus: 'matched', eventType: 'in', occurredAt: '2026-07-31T21:03:00Z', localDate: '2026-07-31', localTime: '22:03:00', tz: 'Africa/Porto-Novo', note: null, matricule: 'SBT-0001', firstName: 'Awa', lastName: 'Sossou' },
    { id: uid(661), batchId: uid(650), lineNo: 3, externalEmployeeId: 'BADGE-0142', sourceDateTimeRaw: '2026-08-01 06:01', sourceTz: null, eventTypeRaw: 'S', deviceRef: 'PTR-HALL', deviceCode: 'PTR-HALL', receivedAt: '2026-08-01T06:10:01Z', matchStatus: 'matched', eventType: 'out', occurredAt: '2026-08-01T05:01:00Z', localDate: '2026-08-01', localTime: '06:01:00', tz: 'Africa/Porto-Novo', note: null, matricule: 'SBT-0001', firstName: 'Awa', lastName: 'Sossou' },
    { id: uid(662), batchId: uid(650), lineNo: 9, externalEmployeeId: 'GARD-112', sourceDateTimeRaw: '2026-07-31 18:00', sourceTz: null, eventTypeRaw: 'E', deviceRef: null, deviceCode: null, receivedAt: '2026-08-01T06:10:01Z', matchStatus: 'unmatched_employee', eventType: 'in', occurredAt: '2026-07-31T17:00:00Z', localDate: '2026-07-31', localTime: '18:00:00', tz: 'Africa/Porto-Novo', note: null, matricule: null, firstName: null, lastName: null },
  ] }),
  'GET /time/punches/unmatched': () => ({ items: [
    { id: uid(670), rawPunchId: uid(662), matchStatus: 'unmatched_employee', note: null, localDate: '2026-07-31', localTime: '18:00:00', tz: 'Africa/Porto-Novo', externalEmployeeId: 'GARD-112', sourceDateTimeRaw: '2026-07-31 18:00', batchId: uid(650), deviceCode: null, matricule: null, firstName: null, lastName: null },
    { id: uid(671), rawPunchId: uid(663), matchStatus: 'not_yet_hired', note: 'pointage antérieur à la date d’embauche (2026-12-01)', localDate: '2026-07-30', localTime: '08:00:00', tz: 'Africa/Porto-Novo', externalEmployeeId: 'SBT-0009', sourceDateTimeRaw: '2026-07-30 08:00', batchId: uid(650), deviceCode: 'PTR-HALL', matricule: 'SBT-0009', firstName: 'Nadia', lastName: 'Gbaguidi' },
  ] }),
  'GET /time/punches/mine': () => ({ linked: true, items: [
    { id: uid(680), occurredAt: '2026-07-31T21:03:00Z', localDate: '2026-07-31', localTime: '22:03:00', tz: 'Africa/Porto-Novo', eventType: 'in', matchStatus: 'matched', deviceCode: 'PTR-HALL', siteCode: 'COT-SIEGE' },
    { id: uid(681), occurredAt: '2026-08-01T05:01:00Z', localDate: '2026-08-01', localTime: '06:01:00', tz: 'Africa/Porto-Novo', eventType: 'out', matchStatus: 'matched', deviceCode: 'PTR-HALL', siteCode: 'COT-SIEGE' },
  ] }),
  'GET /org/sites': () => ([{ id: uid(2), code: 'COT-SIEGE', labelFr: 'Siège Cotonou', labelEn: 'Cotonou HQ', status: 'active' }]),
  'POST /time/punches/import': () => ({
    kind: 'preview',
    counts: { received: 3, accepted: 2, duplicated: 1, rejected: 0, unmatched: 1 },
    errors: [], effective: { matricule: 'external_id', dateheure: 'datetime', sens: 'event_type' },
    wouldApply: true,
  }),
  'POST /time/punches/renormalize': () => ({ processed: 2, matched: 1 }),
  [`GET /time/employees/${uid(100)}/schedule`]: (q) => ({
    assigned: true, date: q.get('date') ?? '2026-07-01', modelCode: 'ROT-NUIT-4',
    modelLabelFr: 'Rotation nuit 4 jours', modelLabelEn: '4-day night rotation', modelKind: 'rotation',
    applicableVersion: 1, versionEffectiveFrom: '2025-06-01', cycleDays: 4, anchorDate: '2026-01-05',
    dayIndex: 0,
    day: { dayIndex: 0, isRest: false, startMinute: 1320, endMinute: 1800, breakStartMinute: null, breakEndMinute: null, label: 'Nuit' },
    exception: null,
    holidays: [{ labelFr: 'Fête nationale', labelEn: 'National day', calendarCode: 'FERIES-BJ' }],
  }),
  // ---------- Moteur de présence (E10.2) — données de DÉMONSTRATION ----------
  'GET /time/results': (q) => ({ items: [
    demoDay(uid(100), 'SBT-0001', 'Awa', 'Sossou', q.get('date') ?? '2026-07-31', 'present', { workedMinutes: 485, presenceMinutes: 485, nightMinutes: 480, firstIn: '2026-07-31T20:55:00.000Z', lastOut: '2026-08-01T05:00:00.000Z', overtimeCandidateMinutes: 5, workPeriods: [{ startMinute: 1315, endMinute: 1800 }] }),
    demoDay(uid(101), 'SBT-0002', 'Bio', 'Kassim', q.get('date') ?? '2026-07-31', 'late', { workedMinutes: 460, presenceMinutes: 460, lateMinutesRaw: 30, lateMinutes: 30, absenceMinutes: 30, openAnomalies: 0 }),
    demoDay(uid(102), 'SBT-0003', 'Chantal', 'Dossou', q.get('date') ?? '2026-07-31', 'incomplete_punches', { openAnomalies: 1, firstIn: '2026-07-31T07:02:00.000Z' }),
    demoDay(uid(105), 'SBT-0006', 'Faustin', 'Zinsou', q.get('date') ?? '2026-07-31', 'suspended', { openAnomalies: 1 }),
  ] }),
  'GET /time/results/mine': (q) => ({ linked: true, items: [
    demoDay(uid(100), 'SBT-0001', 'Awa', 'Sossou', q.get('to') ?? '2026-07-31', 'present', { workedMinutes: 485, nightMinutes: 480 }),
    demoDay(uid(100), 'SBT-0001', 'Awa', 'Sossou', '2026-07-30', 'late', { workedMinutes: 450, lateMinutesRaw: 12, lateMinutes: 12 }),
    demoDay(uid(100), 'SBT-0001', 'Awa', 'Sossou', '2026-07-29', 'rest_day', {}),
  ] }),
  [`GET /time/results/employee/${uid(100)}`]: () => ({ self: false, items: [
    demoDay(uid(100), 'SBT-0001', 'Awa', 'Sossou', '2026-07-29', 'rest_day', {}),
    demoDay(uid(100), 'SBT-0001', 'Awa', 'Sossou', '2026-07-30', 'late', { workedMinutes: 450, lateMinutesRaw: 12, lateMinutes: 12 }),
    demoDay(uid(100), 'SBT-0001', 'Awa', 'Sossou', '2026-07-31', 'present', { workedMinutes: 485, nightMinutes: 480, overtimeCandidateMinutes: 5 }),
  ] }),
  'GET /time/results/day': (q) => ({
    versionCount: 2, self: false,
    result: {
      ...demoDay(uid(100), 'SBT-0001', 'Awa', 'Sossou', q.get('date') ?? '2026-07-31', 'present', {
        workedMinutes: 485, presenceMinutes: 485, nightMinutes: 480, overtimeCandidateMinutes: 5,
        firstIn: '2026-07-31T20:55:00.000Z', lastOut: '2026-08-01T05:00:00.000Z',
        workPeriods: [{ startMinute: 1315, endMinute: 1800 }],
      }),
      usedEventIds: [uid(680), uid(681)], calcRunId: uid(700), computedAt: '2026-08-01T06:30:00Z',
      paramsUsed: {
        'temps.tolerance.retard': { value: 10, parameterId: uid(710), effectiveFrom: '2025-01-01', source: 'parametre' },
        'temps.nuit.debut': { value: 1320, parameterId: null, effectiveFrom: null, source: 'defaut' },
        'temps.nuit.fin': { value: 360, parameterId: null, effectiveFrom: null, source: 'defaut' },
        'temps.arrondi.minutes': { value: 1, parameterId: null, effectiveFrom: null, source: 'defaut' },
      },
    },
    anomalies: [
      { id: uid(720), code: 'punch_other_site', severity: 'info', detail: null, refs: { eventId: uid(680) }, state: 'open', stateNote: null, stateAt: null, createdAt: '2026-08-01T06:30:00Z' },
    ],
    events: [
      { id: uid(680), localDate: '2026-07-31', localTime: '21:55:00', eventType: 'in', tz: 'Africa/Porto-Novo', occurredAt: '2026-07-31T20:55:00Z', siteCode: 'COT-SIEGE', deviceCode: 'PTR-HALL' },
      { id: uid(681), localDate: '2026-08-01', localTime: '06:00:00', eventType: 'out', tz: 'Africa/Porto-Novo', occurredAt: '2026-08-01T05:00:00Z', siteCode: 'COT-SIEGE', deviceCode: 'PTR-HALL' },
    ],
  }),
  'GET /time/results/history': (q) => ({ versions: [
    { ...demoDay(uid(100), 'SBT-0001', 'Awa', 'Sossou', q.get('date') ?? '2026-07-31', 'absent', { absenceMinutes: 480, version: 1 }), isCurrent: false, computedAt: '2026-08-01T06:00:00Z', runReason: 'calcul initial', runIsRecalc: false, runStartedAt: '2026-08-01T06:00:00Z', anomalyCount: 0, paramsUsed: {} },
    { ...demoDay(uid(100), 'SBT-0001', 'Awa', 'Sossou', q.get('date') ?? '2026-07-31', 'present', { workedMinutes: 485, nightMinutes: 480, version: 2 }), isCurrent: true, computedAt: '2026-08-01T06:30:00Z', runReason: 'pointages reçus après coup', runIsRecalc: true, runStartedAt: '2026-08-01T06:30:00Z', anomalyCount: 1, paramsUsed: {} },
  ] }),
  'GET /time/results/compare': () => ({
    fields: [
      { field: 'dayStatus', a: 'absent', b: 'present' },
      { field: 'workedMinutes', a: 0, b: 485 },
      { field: 'absenceMinutes', a: 480, b: 0 },
      { field: 'nightMinutes', a: 0, b: 480 },
    ],
    a: { version: 1, runReason: 'calcul initial', runIsRecalc: false, computedAt: '2026-08-01T06:00:00Z' },
    b: { version: 2, runReason: 'pointages reçus après coup', runIsRecalc: true, computedAt: '2026-08-01T06:30:00Z' },
  }),
  'GET /time/results/aggregates': () => ({
    perEmployee: [
      { employeeId: uid(100), matricule: 'SBT-0001', firstName: 'Awa', lastName: 'Sossou', daysTotal: 31, expectedDays: 22, presentDays: 21, absentDays: 1, unresolvedDays: 0, lateCount: 2, lateMinutes: 42, earlyCount: 0, earlyDepartureMinutes: 0, workedMinutes: 10_120, nightMinutes: 9_600, restDayMinutes: 0, holidayMinutes: 480, overtimeCandidateMinutes: 160, openAnomalies: 1 },
    ],
    totals: { daysTotal: 31, expectedDays: 22, presentDays: 21, absentDays: 1, lateCount: 2, workedMinutes: 10_120 },
  }),
  'GET /time/anomalies/catalog': () => ({ items: [
    { code: 'missing_out', labelFr: 'Entrée sans sortie — aucune heure inventée', labelEn: 'In punch without out — no time invented', defaultSeverity: 'warning' },
    { code: 'punch_other_site', labelFr: 'Pointage sur un autre site que l’affectation', labelEn: 'Punch on a different site than assignment', defaultSeverity: 'info' },
    { code: 'suspended', labelFr: 'Salarié suspendu à cette date', labelEn: 'Employee suspended at this date', defaultSeverity: 'blocking' },
  ] }),
  'GET /time/anomalies': () => ({ items: [
    { id: uid(730), code: 'missing_out', severity: 'warning', detail: 'entrée sans sortie — la période n’est PAS comptée', refs: {}, state: 'open', stateNote: null, stateAt: null, createdAt: '2026-08-01T06:30:00Z', workDate: '2026-07-31', employeeId: uid(102), matricule: 'SBT-0003', firstName: 'Chantal', lastName: 'Dossou', dayStatus: 'incomplete_punches' },
    { id: uid(731), code: 'suspended', severity: 'blocking', detail: 'pointages présents alors que le salarié n’est pas en activité', refs: {}, state: 'open', stateNote: null, stateAt: null, createdAt: '2026-08-01T06:30:00Z', workDate: '2026-07-31', employeeId: uid(105), matricule: 'SBT-0006', firstName: 'Faustin', lastName: 'Zinsou', dayStatus: 'suspended' },
    { id: uid(732), code: 'punch_other_site', severity: 'info', detail: null, refs: {}, state: 'acknowledged', stateNote: 'vu', stateAt: '2026-08-01T08:00:00Z', createdAt: '2026-08-01T06:30:00Z', workDate: '2026-07-31', employeeId: uid(100), matricule: 'SBT-0001', firstName: 'Awa', lastName: 'Sossou', dayStatus: 'present' },
  ] }),
  'GET /time/calc/runs': () => ({ items: [
    { id: uid(700), periodStart: '2026-07-01', periodEnd: '2026-07-31', scopeKind: 'tenant', reason: 'calcul mensuel de juillet', isRecalc: false, engineVersion: 'kora-presence-1.0.0', status: 'completed', startedAt: '2026-08-01T06:00:00Z', finishedAt: '2026-08-01T06:00:04Z', employeesCount: 27, daysCount: 31, resultsWritten: 792, resultsUnchanged: 45, resultsError: 0, anomaliesCount: 23, durationMs: 4210 },
    { id: uid(701), periodStart: '2026-07-31', periodEnd: '2026-07-31', scopeKind: 'employee', reason: 'pointages reçus après coup', isRecalc: true, engineVersion: 'kora-presence-1.0.0', status: 'completed', startedAt: '2026-08-01T06:30:00Z', finishedAt: '2026-08-01T06:30:01Z', employeesCount: 1, daysCount: 1, resultsWritten: 1, resultsUnchanged: 0, resultsError: 0, anomaliesCount: 1, durationMs: 320 },
    { id: uid(702), periodStart: '2026-06-01', periodEnd: '2026-06-30', scopeKind: 'tenant', reason: 'course concurrente (démonstration)', isRecalc: false, engineVersion: 'kora-presence-1.0.0', status: 'failed', startedAt: '2026-07-01T06:00:00Z', finishedAt: '2026-07-01T06:00:00Z', employeesCount: 0, daysCount: 30, resultsWritten: 0, resultsUnchanged: 0, resultsError: 0, anomaliesCount: 0, durationMs: null, errorNote: 'exécution active chevauchante' },
  ] }),
  'POST /time/calc/preview': () => ({
    evaluated: 31, wouldWrite: 1, unchanged: 30,
    diffs: [{ employeeId: uid(100), date: '2026-07-31', currentVersion: 1, currentStatus: 'absent', nextStatus: 'present', changedFields: ['day_status', 'worked_minutes', 'night_minutes'], nextAnomalies: [] }],
  }),
  'POST /time/calc/run': () => ({ run: { id: uid(700), periodStart: '2026-07-01', periodEnd: '2026-07-31', scopeKind: 'tenant', reason: 'démo', isRecalc: false, engineVersion: 'kora-presence-1.0.0', status: 'completed', startedAt: '2026-08-01T06:00:00Z', finishedAt: '2026-08-01T06:00:04Z', employeesCount: 27, daysCount: 31, resultsWritten: 792, resultsUnchanged: 45, resultsError: 0, anomaliesCount: 23, durationMs: 4210 } }),
  'POST /time/calc/recalc': () => ({ run: { id: uid(701), periodStart: '2026-07-31', periodEnd: '2026-07-31', scopeKind: 'employee', reason: 'démo', isRecalc: true, engineVersion: 'kora-presence-1.0.0', status: 'completed', startedAt: '2026-08-01T06:30:00Z', finishedAt: '2026-08-01T06:30:01Z', employeesCount: 1, daysCount: 1, resultsWritten: 1, resultsUnchanged: 0, resultsError: 0, anomaliesCount: 1, durationMs: 320 } }),
  // ---------- Corrections & clôture (E10.3) — données de DÉMONSTRATION ----------
  'GET /time/corrections/mine': () => ({ items: [DEMO_CORR[0], DEMO_CORR[3]] }),
  'GET /time/corrections': (q) => {
    let items = DEMO_CORR;
    if (q.get('status')) items = items.filter((r) => r.status === q.get('status'));
    if (q.get('kind')) items = items.filter((r) => r.kind === q.get('kind'));
    return { items };
  },
  'POST /time/corrections': () => ({ id: uid(760) }),
  [`POST /time/corrections/${uid(760)}/submit`]: () => ({ version: 1 }),
  [`POST /time/corrections/${uid(760)}/attachments`]: () => ({ id: uid(765) }),
  [`GET /time/corrections/${uid(750)}`]: () => ({
    request: DEMO_CORR[0],
    attachments: [{ id: uid(766), filename: 'justificatif-transport.pdf', mime: 'application/pdf', byteSize: 182_331, sensitive: false, avStatus: 'clean', createdAt: '2026-07-31T10:05:00Z' }],
  }),
  [`POST /time/corrections/${uid(751)}/decide`]: () => ({ status: 'applied', applied: true, applicationError: null }),
  [`POST /time/corrections/${uid(751)}/apply`]: () => ({ status: 'applied' }),
  'GET /time/periods': () => ({ items: [
    { id: uid(740), scopeKind: 'tenant', companyId: null, siteId: null, label: 'PAIE-2026-07', periodStart: '2026-07-01', periodEnd: '2026-07-31', status: 'closed', revision: 1, createdAt: '2026-07-01T06:00:00Z', closeCount: 1, activeCloseNo: 1 },
    { id: uid(741), scopeKind: 'tenant', companyId: null, siteId: null, label: 'PAIE-2026-08', periodStart: '2026-08-01', periodEnd: '2026-08-31', status: 'open', revision: 1, createdAt: '2026-08-01T06:00:00Z', closeCount: 0, activeCloseNo: null },
  ] }),
  'POST /time/periods': () => ({ id: uid(742) }),
  [`POST /time/periods/${uid(741)}/status`]: () => ({ status: 'in_review' }),
  [`GET /time/periods/${uid(741)}/preclose`]: () => ({
    period: { id: uid(741), label: 'PAIE-2026-08', status: 'in_review', revision: 1, periodStart: '2026-08-01', periodEnd: '2026-08-31' },
    controls: [
      { key: 'expected_employees', count: 6, blocking: false },
      { key: 'employees_with_results', count: 6, blocking: false },
      { key: 'missing_employees', count: 0, blocking: true },
      { key: 'open_anomalies', count: 2, blocking: false },
      { key: 'blocking_anomalies', count: 1, blocking: true },
      { key: 'pending_requests', count: 1, blocking: true },
      { key: 'approved_unapplied', count: 0, blocking: true },
      { key: 'failed_days', count: 0, blocking: true },
      { key: 'no_schedule_employees', count: 0, blocking: false },
      { key: 'no_assignment_employees', count: 0, blocking: false },
      { key: 'overtime_candidate_minutes', count: 160, blocking: false },
      { key: 'worked_rest_holiday_days', count: 1, blocking: false },
      { key: 'engine_divergence', count: 0, blocking: false },
      { key: 'stale_after_correction', count: 0, blocking: true },
    ],
    blockers: 2, warnings: 4, closable: false,
  }),
  [`GET /time/periods/${uid(740)}/preclose`]: () => ({
    period: { id: uid(740), label: 'PAIE-2026-07', status: 'closed', revision: 1, periodStart: '2026-07-01', periodEnd: '2026-07-31' },
    controls: [
      { key: 'expected_employees', count: 6, blocking: false },
      { key: 'employees_with_results', count: 6, blocking: false },
      { key: 'missing_employees', count: 0, blocking: true },
      { key: 'open_anomalies', count: 0, blocking: false },
      { key: 'blocking_anomalies', count: 0, blocking: true },
      { key: 'pending_requests', count: 0, blocking: true },
      { key: 'approved_unapplied', count: 0, blocking: true },
      { key: 'failed_days', count: 0, blocking: true },
      { key: 'overtime_candidate_minutes', count: 165, blocking: false },
    ],
    blockers: 0, warnings: 1, closable: true,
  }),
  [`POST /time/periods/${uid(740)}/close`]: () => ({ close: DEMO_CLOSE }),
  [`POST /time/periods/${uid(740)}/reopen`]: () => ({ status: 'pending_workflow' }),
  [`GET /time/periods/${uid(740)}/closes`]: () => ({ items: [DEMO_CLOSE] }),
  [`GET /time/closes/${uid(770)}/payroll`]: () => ({ rows: [
    { employeeId: uid(100), matricule: 'SBT-0001', firstName: 'Awa', lastName: 'Sossou', expectedDays: 22, presentDays: 21, unjustifiedAbsenceDays: 0, justified: { maladie: { days: 1, minutes: 480 } }, lateMinutes: 42, earlyDepartureMinutes: 0, workedMinutes: 10_120, nightMinutes: 9_600, restDayMinutes: 0, holidayMinutes: 480, overtimeCandidateMinutes: 160, correctionsApplied: 1 },
    { employeeId: uid(101), matricule: 'SBT-0002', firstName: 'Bio', lastName: 'Kassim', expectedDays: 22, presentDays: 22, unjustifiedAbsenceDays: 0, justified: {}, lateMinutes: 0, earlyDepartureMinutes: 12, workedMinutes: 10_560, nightMinutes: 0, restDayMinutes: 480, holidayMinutes: 0, overtimeCandidateMinutes: 45, correctionsApplied: 1 },
    { employeeId: uid(102), matricule: 'SBT-0003', firstName: 'Chantal', lastName: 'Dossou', expectedDays: 22, presentDays: 20, unjustifiedAbsenceDays: 2, justified: {}, lateMinutes: 15, earlyDepartureMinutes: 0, workedMinutes: 9_610, nightMinutes: 0, restDayMinutes: 0, holidayMinutes: 0, overtimeCandidateMinutes: 0, correctionsApplied: 0 },
  ] }),
  [`GET /time/closes/${uid(770)}/verify`]: () => ({ match: true, datasetSha256: 'c'.repeat(64) }),
  [`GET /time/closes/${uid(770)}/exports`]: () => ({ items: [
    { id: uid(780), schemaVersion: 'kora-paie-prep-1', format: 'csv', revision: 1, sha256: 'd'.repeat(64), employeesCount: 6, status: 'active', generatedBy: 'demo.rh@sbt.bj', generatedAt: '2026-08-02T09:00:00Z', byteSize: 2_048 },
    { id: uid(781), schemaVersion: 'kora-paie-prep-1', format: 'json', revision: 1, sha256: 'e'.repeat(64), employeesCount: 6, status: 'superseded', generatedBy: 'demo.rh@sbt.bj', generatedAt: '2026-08-01T18:00:00Z', byteSize: 5_120 },
  ] }),
  [`POST /time/closes/${uid(770)}/exports`]: () => ({ export: { id: uid(780), revision: 1 }, reused: true }),
  [`GET /time/payroll-exports/${uid(780)}/download`]: () => ({
    filename: 'kora-paie-PAIE-2026-07-c1-r1.csv', mime: 'text/csv',
    contentBase64: Buffer.from('matricule;jours_attendus;jours_presents;minutes_travaillees\nSBT-0001;22;21;10120\n').toString('base64'),
  }),
};

/** Demandes de correction de DÉMONSTRATION (E10.3) — la surcouche ne remplace jamais le brut. */
const DEMO_CORR = [
  { id: uid(750), employeeId: uid(100), workDate: '2026-07-30', kind: 'justify_late', origin: 'self', status: 'applied', version: 1, requesterUserId: uid(500), motive: 'Panne de transport en commun, justificatif joint.', payload: { category: 'transport' }, beforeSnapshot: { lateMinutes: 12 }, afterSnapshot: { lateMinutes: 12, lateJustified: true }, anomalyId: null, workflowInstanceId: uid(62), appliedEventId: uid(790), applicationError: null, submittedAt: '2026-07-31T08:00:00Z', decidedAt: '2026-07-31T14:00:00Z', appliedAt: '2026-07-31T14:00:02Z', createdAt: '2026-07-31T07:55:00Z', matricule: 'SBT-0001', firstName: 'Awa', lastName: 'Sossou', attachmentCount: 1 },
  { id: uid(751), employeeId: uid(102), workDate: '2026-07-31', kind: 'add_out', origin: 'manager', status: 'submitted', version: 1, requesterUserId: uid(501), motive: 'Sortie non badgée (oubli constaté par le chef d’équipe).', payload: { localTime: '17:05', sourceNote: 'déclaré par le manager' }, beforeSnapshot: null, afterSnapshot: null, anomalyId: uid(730), workflowInstanceId: uid(64), appliedEventId: null, applicationError: null, submittedAt: '2026-08-01T09:00:00Z', decidedAt: null, appliedAt: null, createdAt: '2026-08-01T08:58:00Z', matricule: 'SBT-0003', firstName: 'Chantal', lastName: 'Dossou', attachmentCount: 0 },
  { id: uid(752), employeeId: uid(105), workDate: '2026-07-31', kind: 'exclude_event', origin: 'auto_anomaly', status: 'rejected', version: 1, requesterUserId: uid(500), motive: 'Pointages pendant suspension — à exclure après contrôle.', payload: { eventId: uid(682) }, beforeSnapshot: null, afterSnapshot: null, anomalyId: uid(731), workflowInstanceId: null, appliedEventId: null, applicationError: null, submittedAt: '2026-08-01T07:00:00Z', decidedAt: '2026-08-01T11:00:00Z', appliedAt: null, createdAt: '2026-08-01T06:30:05Z', matricule: 'SBT-0006', firstName: 'Faustin', lastName: 'Zinsou', attachmentCount: 0 },
  { id: uid(753), employeeId: uid(100), workDate: '2026-07-29', kind: 'justify_absence', origin: 'self', status: 'draft', version: 1, requesterUserId: uid(500), motive: 'Absence pour obligation familiale (brouillon).', payload: { category: 'familial' }, beforeSnapshot: null, afterSnapshot: null, anomalyId: null, workflowInstanceId: null, appliedEventId: null, applicationError: null, submittedAt: null, decidedAt: null, appliedAt: null, createdAt: '2026-08-01T10:00:00Z', matricule: 'SBT-0001', firstName: 'Awa', lastName: 'Sossou', attachmentCount: 0 },
];

/** Clôture de DÉMONSTRATION : versions retenues figées + empreinte reproductible. */
const DEMO_CLOSE = {
  id: uid(770), closeNo: 1, periodRevision: 1, engineVersion: 'kora-presence-1.1.0',
  datasetSha256: 'c'.repeat(64), employeesCount: 6, daysCount: 31, resultsCount: 186,
  totals: { expected_days: 132, present_days: 127, worked_minutes: 60_480, night_minutes: 9_600, overtime_candidate_minutes: 365 },
  warnings: [{ key: 'open_anomalies', count: 2 }], status: 'active',
  closedBy: 'demo.rh@sbt.bj', closedAt: '2026-08-02T08:30:00Z', exportCount: 2,
  periodLabel: 'PAIE-2026-07', periodStart: '2026-07-01', periodEnd: '2026-07-31', periodStatus: 'closed',
};

/** Résultat journalier de DÉMONSTRATION — valeurs par défaut sûres, surchargées au besoin. */
function demoDay(employeeId, matricule, firstName, lastName, workDate, dayStatus, extra) {
  return {
    id: uid(800), employeeId, workDate, version: 1, dayStatus, calcState: 'ok', calcNote: null,
    tz: 'Africa/Porto-Novo', scheduleModelCode: 'ROT-NUIT-4', scheduleModelVersion: 1, cycleDayIndex: 0,
    plannedStartMinute: 1320, plannedEndMinute: 1800, plannedBreakStartMinute: null, plannedBreakEndMinute: null,
    plannedRest: dayStatus === 'rest_day', holiday: false, exceptionKind: null,
    firstIn: null, lastOut: null, workPeriods: [],
    presenceMinutes: 0, workedMinutes: 0, breakMinutes: 0, lateMinutesRaw: 0, lateMinutes: 0,
    earlyDepartureMinutesRaw: 0, earlyDepartureMinutes: 0, absenceMinutes: 0, nightMinutes: 0,
    restDayMinutes: 0, holidayMinutes: 0, overtimeCandidateMinutes: 0,
    engineVersion: 'kora-presence-1.0.0', openAnomalies: 0,
    matricule, firstName, lastName, siteCode: 'COT-SIEGE', unitCode: 'PROD',
    ...extra,
  };
}

function employeeSubroutes(pathname, q) {
  const m = /^\/employees\/([^/]+)(?:\/([a-z]+))?$/.exec(pathname);
  if (!m) return undefined;
  const emp = EMP.find((e) => e.id === m[1]) ?? EMP[0];
  const unit = UNITS.find((u) => u.code === emp._unit) ?? UNITS[1];
  switch (m[2]) {
    case undefined:
      return {
        ...emp, createdAt: '2026-01-05T08:00:00Z', documentCount: 2,
        currentAssignment: { id: uid(200), companyId: uid(1), siteId: null, unitId: unit.id, positionId: null, jobId: null, costCenterId: null, assignmentKind: 'standard', allocationPct: 100, effectiveFrom: emp.hireDate, effectiveTo: null, unitCode: unit.code, companyCode: 'SBT-SA' },
      };
    case 'private':
      return { private: { birthDate: '1991-05-12', birthPlace: 'Cotonou', nationality: 'BJ', sex: 'f', personalEmail: 'awa.perso@exemple.bj', personalPhone: '+229 01 96 00 00 01', addressLine: 'Lot 12, Fidjrossè', addressCity: 'Cotonou', addressCountry: 'BJ', emergencyName: 'K. Sossou', emergencyRelation: 'frère', emergencyPhone: '+229 01 97 00 00 02' } };
    case 'identifiers':
      return { identifiers: { cnssNumber: 'CNSS-114-889-77', taxId: 'IFU-3201900001234', idDocumentType: 'cni', idDocumentNumber: 'CNI-2019-556677', idDocumentExpiry: '2029-04-30' } };
    case 'documents':
      return { documents: [
        { id: uid(210), docType: 'contrat', label: 'Contrat CDI 2021', sensitive: true, createdAt: '2021-03-01T09:00:00Z' },
        { id: uid(211), docType: 'diplome', label: 'Licence GRH', sensitive: false, createdAt: '2021-02-20T09:00:00Z' },
      ] };
    case 'career':
      return { events: [
        { id: '1', eventType: 'hire', effectiveDate: emp.hireDate, details: {}, occurredAt: emp.hireDate },
        { id: '2', eventType: 'confirmation', effectiveDate: '2021-09-01', details: {}, occurredAt: '2021-09-01' },
        { id: '3', eventType: 'promotion', effectiveDate: '2024-01-01', details: {}, occurredAt: '2024-01-01' },
      ] };
    case 'assignments':
      return { assignments: [
        { id: uid(200), companyId: uid(1), siteId: null, unitId: unit.id, positionId: null, isPrimary: true, assignmentKind: 'standard', allocationPct: 100, effectiveFrom: emp.hireDate, effectiveTo: null },
        { id: uid(201), companyId: uid(1), siteId: null, unitId: UNITS[3].id, positionId: null, isPrimary: false, assignmentKind: 'interim', allocationPct: 20, effectiveFrom: '2026-02-01', effectiveTo: '2026-06-01' },
      ] };
    case 'manager':
      return { date: q.get('date') ?? '', manager: { employeeId: uid(102), matricule: 'SBT-0003', firstName: 'Chantal', lastName: 'Dossou', via: 'position', managerPositionId: uid(40) } };
    case 'at':
      return { date: q.get('date') ?? '', status: emp.status, assignment: null, manager: null };
    default:
      return undefined;
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  if (url.pathname.startsWith('/api/v1')) {
    const sub = url.pathname.slice('/api/v1'.length) || '/';
    // Le stub reproduit le contrat cookie : sans cookie de session, /auth/me = 401.
    if (sub === '/auth/me' && !(req.headers.cookie ?? '').includes('kora_session=')) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ statusCode: 401, message: 'authentification requise' }));
      return;
    }
    let payload = routesDemo[`${req.method} ${sub}`]?.(url.searchParams);
    if (payload === undefined) payload = employeeSubroutes(sub, url.searchParams);
    if (payload === undefined && req.method === 'POST') payload = {};
    const headers = { 'content-type': 'application/json' };
    if (sub === '/auth/login' && req.method === 'POST') {
      headers['set-cookie'] = 'kora_session=demo-jeton-simule; Max-Age=86400; Path=/api; HttpOnly; SameSite=Strict';
    }
    if (sub === '/auth/logout') {
      headers['set-cookie'] = 'kora_session=; Max-Age=0; Path=/api; HttpOnly; SameSite=Strict';
    }
    res.writeHead(payload === undefined ? 404 : payload === null ? 204 : 200, headers);
    res.end(payload === undefined ? JSON.stringify({ message: 'demo: route inconnue' }) : payload === null ? undefined : JSON.stringify(payload));
    return;
  }
  let file = normalize(join(dist, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(dist)) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (!existsSync(file)) file = join(dist, 'index.html'); // coquille SPA
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});

server.listen(port, () => console.log(`[DEMO ONLY] KORA PWA + API simulée → http://127.0.0.1:${port}`));
