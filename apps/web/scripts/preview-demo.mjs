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
  'POST /auth/login': () => ({ token: 'k1.demo.jeton-simule', expiresAt: new Date(Date.now() + 864e5).toISOString(), user: { id: uid(500), email: 'demo.rh@sbt.bj' } }),
  'POST /auth/logout': () => null,
  'GET /auth/me': () => ({
    tenantId: uid(900), userId: uid(500), sessionId: uid(901), email: 'demo.rh@sbt.bj',
    permissions: ['employees.view', 'employees.view_private', 'employees.view_identifiers', 'employees.view_documents',
      'employees.view_history', 'workflow.view', 'workflow.act', 'org.view', 'users.view', 'users.create',
      'users.manage_roles', 'sessions.revoke', 'audit.view', 'audit.export', 'parameters.view'],
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
};

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
    let payload = routesDemo[`${req.method} ${sub}`]?.(url.searchParams);
    if (payload === undefined) payload = employeeSubroutes(sub, url.searchParams);
    if (payload === undefined && req.method === 'POST') payload = {};
    res.writeHead(payload === undefined ? 404 : payload === null ? 204 : 200, { 'content-type': 'application/json' });
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
