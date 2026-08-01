/**
 * E2E Core HR (E9) — conditions de validation du sponsor : FK inter-tenant rejetées
 * PAR POSTGRESQL (société, site, unité, poste, responsable), matricule unique,
 * affectations principales sans chevauchement, mutation future sans effet sur la
 * lecture passée, poste actif à la date exigé, responsable résolu par la structure,
 * cessation = clôture sans suppression, changements via workflow appliqués seulement
 * à l'approbation, portées réelles (périmètre), zones sensibles masquées sans
 * permission dédiée (listes ET audit), import CSV atomique sans insertion partielle,
 * isolation tenant, OpenAPI.
 * Fixtures : permissions issues des MIGRATIONS uniquement (la CI ne seed pas) ;
 * entités organisationnelles ACTIVÉES avant usage (les créations API naissent draft) ;
 * dates choisies pour rester vraies quelle que soit la date d'exécution.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import type { INestApplication } from '@nestjs/common';

process.env.KORA_MFA_KEY ??=
  'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
import { createApp } from '../src/main';

const MIGRATOR_URL =
  process.env.DATABASE_URL_MIGRATOR ??
  'postgres://kora_migrator:kora_migrator_dev@127.0.0.1:5432/kora';
function psql(sql: string): string {
  const r = spawnSync('psql', [MIGRATOR_URL, '-qXtA', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}
function psqlErr(sql: string): string {
  const r = spawnSync('psql', [MIGRATOR_URL, '-qXtA', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
  assert.notEqual(r.status, 0, `la requête aurait dû échouer : ${sql.slice(0, 80)}`);
  return r.stderr;
}

const rid = randomUUID().slice(0, 8);
// Les matricules sont NORMALISÉS EN MAJUSCULES à l'import : toute vérification par
// égalité stricte en base doit utiliser cette forme (le rid hexadécimal porte des
// minuscules — leçon du run CI 30706100687).
const RID = rid.toUpperCase();
const P = 'Sentier-Karite-2026!';
const slugA = `hr-a-${rid}`;
const slugB = `hr-b-${rid}`;

const admEmail = `hradm.${rid}@demo.bj`;    // employees.* complet + org + workflow + notify + audit.view (portée tenant)
const viewEmail = `hrview.${rid}@demo.bj`;  // employees.view SEUL (portée tenant)
const privEmail = `hrpriv.${rid}@demo.bj`;  // employees.view + view_private (portée tenant)
const chefEmail = `hrchef.${rid}@demo.bj`;  // view+manage+assign+view_history, portée DEPARTMENT RH uniquement
const apprEmail = `hrappr.${rid}@demo.bj`;  // approbateur workflow (rôle hrappr)
const linkEmail = `hrlink.${rid}@demo.bj`;  // compte lié au salarié E1 (destinataire des notifications)
const bAdmEmail = `hrbadm.${rid}@demo.bj`;

let app: INestApplication;
let base = '';
let tenantAId = '';
let tenantBId = '';
let admId = '';
let chefId = '';
let linkUserId = '';

async function seedUser(tenantId: string, email: string, perms: string[], roleKeys: string[], tenantScope: boolean): Promise<string> {
  const h = await argon2.hash(P, { type: argon2.argon2id });
  const id = psql(`INSERT INTO admin.users (tenant_id, email, password_hash) VALUES ('${tenantId}','${email}','${h}') RETURNING id`);
  if (tenantScope) psql(`INSERT INTO admin.user_scopes (tenant_id, user_id, scope_type) VALUES ('${tenantId}','${id}','tenant')`);
  if (perms.length > 0) {
    const role = psql(`INSERT INTO admin.roles (tenant_id, key, name) VALUES ('${tenantId}','r-${email.split('@')[0]}','R') RETURNING id`);
    for (const p of perms) psql(`INSERT INTO admin.role_permissions (tenant_id, role_id, permission_key) VALUES ('${tenantId}','${role}','${p}')`);
    psql(`INSERT INTO admin.user_roles (tenant_id, user_id, role_id) VALUES ('${tenantId}','${id}','${role}')`);
  }
  for (const rk of roleKeys) {
    const role = psql(`INSERT INTO admin.roles (tenant_id, key, name) VALUES ('${tenantId}','${rk}','${rk}') ON CONFLICT (tenant_id, key) DO UPDATE SET name = EXCLUDED.name RETURNING id`);
    psql(`INSERT INTO admin.user_roles (tenant_id, user_id, role_id) VALUES ('${tenantId}','${id}','${role}') ON CONFLICT DO NOTHING`);
  }
  return id;
}

before(async () => {
  tenantAId = psql(`INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('${slugA}','HR A',true) RETURNING id`);
  tenantBId = psql(`INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('${slugB}','HR B',true) RETURNING id`);
  admId = await seedUser(tenantAId, admEmail, [
    'employees.view', 'employees.view_private', 'employees.view_identifiers', 'employees.view_documents',
    'employees.manage', 'employees.assign', 'employees.view_history', 'employees.import',
    'org.view', 'org.manage', 'workflow.manage', 'workflow.submit', 'workflow.act', 'workflow.view',
    'notify.manage', 'audit.view',
  ], [], true);
  await seedUser(tenantAId, viewEmail, ['employees.view'], [], true);
  await seedUser(tenantAId, privEmail, ['employees.view', 'employees.view_private'], [], true);
  // chef : portée department ajoutée APRÈS la création des unités (le trigger E8
  // valide scope_ref contre l'organisation).
  chefId = await seedUser(tenantAId, chefEmail, ['employees.view', 'employees.manage', 'employees.assign', 'employees.view_history'], [], false);
  await seedUser(tenantAId, apprEmail, ['workflow.act', 'workflow.view'], [`hrappr-${rid}`], true);
  linkUserId = await seedUser(tenantAId, linkEmail, [], [], false);
  await seedUser(tenantBId, bAdmEmail, [
    'employees.view', 'employees.manage', 'employees.assign', 'employees.import', 'org.view', 'org.manage',
  ], [], true);

  app = await createApp();
  await app.listen(0);
  const addr = app.getHttpServer().address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  base = `http://127.0.0.1:${port}/api/v1`;
});

after(async () => { if (app) await app.close(); });

const tokenCache = new Map<string, string>();
async function token(slug: string, email: string): Promise<string> {
  const cached = tokenCache.get(email);
  if (cached) return cached;
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenantSlug: slug, email, password: P }),
  });
  assert.equal(res.status, 200, `login ${email}`);
  const tok = ((await res.json()) as { token: string }).token;
  tokenCache.set(email, tok);
  return tok;
}
function api(path: string, tok: string, body?: unknown, method = 'POST'): Promise<Response> {
  return fetch(`${base}${path}`, {
    method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function created(path: string, tok: string, body: unknown): Promise<string> {
  const res = await api(path, tok, body);
  if (res.status !== 201) {
    assert.fail(`${path} → ${res.status} : ${await res.text().catch(() => '')}`);
  }
  return ((await res.json()) as { id: string }).id;
}

// Organisation A (activée), organisation B, salariés.
let coA = ''; let siteA = ''; let jobDev = '';
let uDir = ''; let uRh = ''; let uIt = '';
let posDir = ''; let posLead = ''; let posDev = ''; let pos2027 = ''; let posDraft = '';
let coB = ''; let unitB = '';
let e1 = ''; let e2 = ''; let e3 = ''; let etmp = ''; let eb = '';
const CNSS1 = `CNSS-${rid}-111222`;

test('fixtures organisation (E8 source de vérité) + créations de dossiers : matricule unique et contrôlé', async () => {
  const adm = await token(slugA, admEmail);
  coA = await created('/org/companies', adm, { code: 'CO-HR', labelFr: 'Société RH', labelEn: 'HR Co' });
  siteA = await created('/org/sites', adm, { code: 'SITE-HR', labelFr: 'Site Cotonou', labelEn: 'Cotonou', companyId: coA });
  jobDev = await created('/org/jobs', adm, { code: 'JOB-DEV', labelFr: 'Développeur', labelEn: 'Developer' });
  uDir = await created('/org/units', adm, { code: 'DIR-HR', labelFr: 'Direction', labelEn: 'Directorate', unitType: 'direction', companyId: coA });
  uRh = await created('/org/units', adm, { code: 'DEP-RH', labelFr: 'Département RH', labelEn: 'HR Dept', unitType: 'department', parentUnitId: uDir, effectiveFrom: '2026-01-01' });
  uIt = await created('/org/units', adm, { code: 'DEP-IT', labelFr: 'Département IT', labelEn: 'IT Dept', unitType: 'department', parentUnitId: uDir, effectiveFrom: '2026-01-01' });
  posDir = await created('/org/positions', adm, { code: 'POS-DIR', labelFr: 'Directeur', labelEn: 'Director', unitId: uDir, companyId: coA, jobId: jobDev, effectiveFrom: '2026-01-01' });
  posLead = await created('/org/positions', adm, { code: 'POS-LEAD', labelFr: 'Lead IT', labelEn: 'IT Lead', unitId: uIt, companyId: coA, jobId: jobDev, managerPositionId: posDir, effectiveFrom: '2026-01-01' });
  posDev = await created('/org/positions', adm, { code: 'POS-DEV', labelFr: 'Développeur', labelEn: 'Developer', unitId: uIt, companyId: coA, jobId: jobDev, managerPositionId: posLead, effectiveFrom: '2026-01-01' });
  pos2027 = await created('/org/positions', adm, { code: 'POS-2027', labelFr: 'Poste 2027', labelEn: '2027 role', unitId: uIt, companyId: coA, jobId: jobDev, effectiveFrom: '2027-01-01' });
  posDraft = await created('/org/positions', adm, { code: 'POS-DRAFT', labelFr: 'Poste brouillon', labelEn: 'Draft role', unitId: uIt, companyId: coA, jobId: jobDev, effectiveFrom: '2026-01-01' });
  // ACTIVATION (les créations API naissent draft) — posDraft reste volontairement draft.
  for (const [entity, id] of [
    ['companies', coA], ['sites', siteA], ['jobs', jobDev],
    ['units', uDir], ['units', uRh], ['units', uIt],
    ['positions', posDir], ['positions', posLead], ['positions', posDev], ['positions', pos2027],
  ] as const) {
    assert.equal((await api(`/org/${entity}/${id}/status`, adm, { status: 'active' })).status, 200, `${entity} → active`);
  }
  // La portée du chef RH pointe une VRAIE unité (trigger E8) — posée maintenant.
  psql(`INSERT INTO admin.user_scopes (tenant_id, user_id, scope_type, scope_ref) VALUES ('${tenantAId}','${chefId}','department','${uRh}')`);
  // Modèle de notification E5 (socle in_app) pour hr.change_applied.
  const tpl = await api('/admin/notify/templates', adm, {
    key: 'hr.change_applied', name: 'Changement RH appliqué',
    subjectFr: 'Dossier {{matricule}} — changement appliqué', subjectEn: 'Record {{matricule}} — change applied',
    bodyFr: 'Le changement ({{type_changement}}) prend effet le {{date_effet}}.',
    bodyEn: 'The change ({{type_changement}}) is effective on {{date_effet}}.',
    variables: ['matricule', 'type_changement', 'date_effet'], channels: ['in_app'], mandatory: false,
  });
  assert.equal(tpl.status, 201);
  const { id: tplId } = (await tpl.json()) as { id: string };
  assert.equal((await api(`/admin/notify/templates/${tplId}/activate`, adm)).status, 200);

  // Dossiers salariés — créés en draft, matricule normalisé et UNIQUE.
  e1 = await created('/employees', adm, { matricule: 'hr-a-0001', firstName: 'Awa', lastName: 'Sossou', hireDate: '2026-01-01', employerCompanyId: coA, mainSiteId: siteA });
  e2 = await created('/employees', adm, { matricule: 'HR-A-0002', firstName: 'Bio', lastName: 'Kassim', hireDate: '2026-01-01' });
  e3 = await created('/employees', adm, { matricule: 'HR-A-0003', firstName: 'Chantal', lastName: 'Dossou', hireDate: '2026-01-01' });
  etmp = await created('/employees', adm, { matricule: 'HR-A-0009', firstName: 'Temp', lastName: 'Agbo', hireDate: '2026-01-01' });
  const dup = await api('/employees', adm, { matricule: 'HR-A-0001', firstName: 'X', lastName: 'X' });
  assert.equal(dup.status, 409, 'matricule en doublon (insensible à la normalisation) = 409');
  assert.equal(((await dup.json()) as { code: string }).code, 'duplicate_matricule');
  assert.equal((await api('/employees', adm, { matricule: 'écrasé!', firstName: 'X', lastName: 'X' })).status, 400, 'matricule non conforme refusé');
  const view = await token(slugA, viewEmail);
  assert.equal((await api('/employees', view, { matricule: 'HR-V-1', firstName: 'X', lastName: 'X' })).status, 403, 'employees.view ne crée pas');
  // Tenant B : organisation et dossier propres.
  const badm = await token(slugB, bAdmEmail);
  coB = await created('/org/companies', badm, { code: 'CO-B', labelFr: 'Société B', labelEn: 'B Co' });
  unitB = await created('/org/units', badm, { code: 'DIR-B', labelFr: 'Direction B', labelEn: 'B Dir', unitType: 'direction', companyId: coB });
  for (const [entity, id] of [['companies', coB], ['units', unitB]] as const) {
    assert.equal((await api(`/org/${entity}/${id}/status`, badm, { status: 'active' })).status, 200);
  }
  eb = await created('/employees', badm, { matricule: 'HR-A-0001', firstName: 'Sena', lastName: 'Agbodjan' });
  assert.ok(eb, 'même matricule dans un AUTRE tenant : permis (unicité PAR tenant)');
});

test('cycle de vie contrôlé : pas de raccourci, matricule immuable, carrière tracée', async () => {
  const adm = await token(slugA, admEmail);
  const shortcut = await api(`/employees/${e1}/status`, adm, { status: 'terminated' });
  assert.equal(shortcut.status, 400, 'draft → terminated refusé (pas de raccourci)');
  assert.equal((await api(`/employees/${e1}/status`, adm, { status: 'pre_hire', effectiveDate: '2026-01-01' })).status, 200);
  const hire = await api(`/employees/${e1}/status`, adm, { status: 'active', effectiveDate: '2026-01-01' });
  assert.equal(hire.status, 200);
  assert.equal(((await hire.json()) as { careerEvent: string }).careerEvent, 'hire', 'pre_hire → active = embauche');
  assert.equal((await api(`/employees/${e1}`, adm, { matricule: 'HR-A-9999' }, 'PATCH')).status, 400, 'matricule immuable');
  for (const [emp, date] of [[e2, '2026-01-01'], [e3, '2026-01-01'], [etmp, '2026-01-01']] as const) {
    assert.equal((await api(`/employees/${emp}/status`, adm, { status: 'active', effectiveDate: date })).status, 200);
  }
  const career = await api(`/employees/${e1}/career`, adm, undefined, 'GET');
  assert.equal(career.status, 200);
  const { events } = (await career.json()) as { events: Array<{ eventType: string }> };
  assert.deepEqual(events.map((ev) => ev.eventType), ['status_change', 'hire'], 'chaque transition est un fait de carrière');
});

test('affectations datées : principale unique (EXCLUDE PostgreSQL), secondaires avec pourcentage', async () => {
  const adm = await token(slugA, admEmail);
  const a1 = await api(`/employees/${e1}/assignments`, adm, {
    companyId: coA, unitId: uRh, siteId: siteA, effectiveFrom: '2026-01-01', managerOverrideEmployeeId: e3,
  });
  assert.equal(a1.status, 201);
  assert.equal(((await a1.json()) as { careerEvent: string }).careerEvent, 'unit_change', 'premier rattachement tracé');
  assert.equal((await api(`/employees/${e2}/assignments`, adm, { companyId: coA, unitId: uIt, positionId: posDev, jobId: jobDev, effectiveFrom: '2026-01-01' })).status, 201);
  assert.equal((await api(`/employees/${e3}/assignments`, adm, { companyId: coA, unitId: uIt, positionId: posLead, jobId: jobDev, effectiveFrom: '2026-01-01' })).status, 201);
  assert.equal((await api(`/employees/${etmp}/assignments`, adm, { companyId: coA, unitId: uRh, effectiveFrom: '2026-01-01' })).status, 201);
  // Une DEUXIÈME principale à la même date : refusée par l'API (état verrouillé)…
  const clash = await api(`/employees/${e1}/assignments`, adm, { companyId: coA, unitId: uIt, effectiveFrom: '2026-01-01' });
  assert.equal(clash.status, 400);
  // …et par POSTGRESQL lui-même (contrainte d'exclusion partielle), même hors API.
  const err = psqlErr(`INSERT INTO core.employee_assignments (tenant_id, employee_id, company_id, unit_id, is_primary, effective_from)
    VALUES ('${tenantAId}','${e1}','${coA}','${uRh}', true, '2026-06-01')`);
  assert.ok(err.includes('exclusion') || err.includes('conflicting key'), `EXCLUDE attendu : ${err}`);
  // Secondaire chevauchante avec pourcentage : PERMISE (intérim, partage de poste).
  const sec = await api(`/employees/${e1}/assignments`, adm, {
    companyId: coA, unitId: uIt, isPrimary: false, assignmentKind: 'interim', allocationPct: 20, effectiveFrom: '2026-02-01',
  });
  assert.equal(sec.status, 201);
  assert.equal((await api(`/employees/${e1}/assignments`, adm, { companyId: coA, unitId: uRh, isPrimary: false, allocationPct: 0, effectiveFrom: '2026-02-01' })).status, 400, 'pourcentage hors bornes refusé');
});

test('FK inter-tenant : PostgreSQL rejette société, unité et responsable d’un autre tenant', async () => {
  const errUnit = psqlErr(`INSERT INTO core.employee_assignments (tenant_id, employee_id, company_id, unit_id, is_primary, effective_from)
    VALUES ('${tenantAId}','${e1}','${coA}','${unitB}', false, '2026-01-01')`);
  assert.ok(errUnit.includes('foreign key'), `FK composite unité attendue : ${errUnit}`);
  const errCo = psqlErr(`INSERT INTO core.employee_assignments (tenant_id, employee_id, company_id, unit_id, is_primary, effective_from)
    VALUES ('${tenantAId}','${e1}','${coB}','${uRh}', false, '2026-01-01')`);
  assert.ok(errCo.includes('foreign key'), `FK composite société attendue : ${errCo}`);
  const errMgr = psqlErr(`INSERT INTO core.employee_assignments (tenant_id, employee_id, company_id, unit_id, is_primary, manager_override_employee_id, effective_from)
    VALUES ('${tenantAId}','${e1}','${coA}','${uRh}', false, '${eb}', '2026-01-01')`);
  assert.ok(errMgr.includes('foreign key'), `FK composite responsable attendue : ${errMgr}`);
  // Côté API, l'unité d'un autre tenant N'EXISTE PAS (RLS) : 400 référence introuvable.
  const adm = await token(slugA, admEmail);
  assert.equal((await api(`/employees/${e1}/assignments`, adm, { companyId: coA, unitId: unitB, isPrimary: false, effectiveFrom: '2026-03-01' })).status, 400);
});

test('poste requis ACTIF et rattaché à la date d’effet', async () => {
  const adm = await token(slugA, admEmail);
  const draft = await api(`/employees/${e1}/assignments`, adm, { companyId: coA, unitId: uIt, positionId: posDraft, isPrimary: false, effectiveFrom: '2026-03-01' });
  assert.equal(draft.status, 409, 'poste en brouillon = refus');
  assert.equal(((await draft.json()) as { code: string }).code, 'position_not_active');
  const early = await api(`/employees/${e2}/assignments`, adm, { companyId: coA, unitId: uIt, positionId: pos2027, isPrimary: false, effectiveFrom: '2026-03-01' });
  assert.equal(early.status, 409, 'poste actif mais NON RATTACHÉ à la date = refus');
  const ok = await api(`/employees/${e2}/assignments`, adm, { companyId: coA, unitId: uIt, positionId: pos2027, isPrimary: false, allocationPct: 30, effectiveFrom: '2027-02-01' });
  assert.equal(ok.status, 201, 'même poste, date couverte par son rattachement = accepté');
});

test('mutation propre : clôture + nouvelle ligne, la lecture PASSÉE ne bouge jamais', async () => {
  const adm = await token(slugA, admEmail);
  const move = await api(`/employees/${e2}/assignments`, adm, { companyId: coA, unitId: uRh, effectiveFrom: '2027-09-01' });
  assert.equal(move.status, 201);
  assert.equal(((await move.json()) as { careerEvent: string }).careerEvent, 'transfer', 'changement d’unité = transfert');
  const past = (await (await api(`/employees/${e2}/at?date=2026-03-15`, adm, undefined, 'GET')).json()) as { assignment: { unitId: string } | null; status: string };
  assert.equal(past.assignment?.unitId, uIt, 'au 15/03/2026, Bio reste à l’IT — la mutation future n’a rien réécrit');
  assert.equal(past.status, 'active');
  const future = (await (await api(`/employees/${e2}/at?date=2027-10-01`, adm, undefined, 'GET')).json()) as { assignment: { unitId: string } | null };
  assert.equal(future.assignment?.unitId, uRh, 'au 01/10/2027, la nouvelle affectation s’applique');
  const hist = (await (await api(`/employees/${e2}/assignments`, adm, undefined, 'GET')).json()) as { assignments: Array<{ unitId: string; effectiveTo: string | null; isPrimary: boolean }> };
  const closed = hist.assignments.find((x) => x.isPrimary && x.unitId === uIt);
  assert.ok(closed && closed.effectiveTo === '2027-09-01', 'la période IT est CLOSE, pas effacée');
  // Une ligne close est FIGÉE (close-only) et JAMAIS supprimable — gardes SQL.
  const closedId = psql(`SELECT id FROM core.employee_assignments WHERE employee_id='${e2}' AND unit_id='${uIt}' AND is_primary`);
  const rewrite = psqlErr(`UPDATE core.employee_assignments SET effective_from='2026-02-01' WHERE id='${closedId}'`);
  assert.ok(rewrite.includes('close') || rewrite.includes('historique'), `close-only attendu : ${rewrite}`);
  const del = psqlErr(`DELETE FROM core.employee_assignments WHERE id='${closedId}'`);
  assert.ok(del.length > 0, 'aucun DELETE d’affectation possible');
});

test('carrière : append-only garanti par la base', async () => {
  const upd = psqlErr(`UPDATE core.career_events SET details='{"falsifie":true}' WHERE employee_id='${e1}'`);
  assert.ok(upd.length > 0, 'UPDATE refusé');
  const del = psqlErr(`DELETE FROM core.career_events WHERE employee_id='${e1}'`);
  assert.ok(del.length > 0, 'DELETE refusé');
});

test('responsable résolu PAR LA STRUCTURE DES POSTES, dérogation explicite prioritaire', async () => {
  const adm = await token(slugA, admEmail);
  const viaPos = (await (await api(`/employees/${e2}/manager?date=2026-08-15`, adm, undefined, 'GET')).json()) as { manager: { employeeId: string; via: string; managerPositionId: string } };
  assert.equal(viaPos.manager?.employeeId, e3, 'le responsable de Bio est le TITULAIRE du poste lead (structure E8)');
  assert.equal(viaPos.manager?.via, 'position');
  assert.equal(viaPos.manager?.managerPositionId, posLead);
  const viaOverride = (await (await api(`/employees/${e1}/manager?date=2026-08-15`, adm, undefined, 'GET')).json()) as { manager: { employeeId: string; via: string } };
  assert.equal(viaOverride.manager?.employeeId, e3);
  assert.equal(viaOverride.manager?.via, 'override', 'la dérogation explicite prime');
  const noOccupant = (await (await api(`/employees/${e3}/manager?date=2026-08-15`, adm, undefined, 'GET')).json()) as { manager: { via: string; managerPositionId: string; employeeId: string | null } };
  assert.equal(noOccupant.manager?.managerPositionId, posDir, 'poste responsable identifié même sans titulaire');
  assert.equal(noOccupant.manager?.employeeId, null);
});

test('cessation : clôture des affectations, dossier et historique CONSERVÉS, réintégration possible', async () => {
  const adm = await token(slugA, admEmail);
  const term = await api(`/employees/${etmp}/status`, adm, { status: 'terminated', effectiveDate: '2026-07-01', reason: 'fin de contrat' });
  assert.equal(term.status, 200);
  assert.equal(((await term.json()) as { careerEvent: string }).careerEvent, 'termination');
  assert.equal(psql(`SELECT count(*) FROM core.employees WHERE id='${etmp}'`), '1', 'le dossier N’EST PAS supprimé');
  assert.equal(psql(`SELECT count(*) FROM core.employee_assignments WHERE employee_id='${etmp}' AND effective_to IS NULL`), '0', 'les affectations ouvertes sont CLOSES');
  assert.equal(psql(`SELECT count(*) FROM core.employee_assignments WHERE employee_id='${etmp}'`), '1', 'clôture ≠ suppression');
  const rein = await api(`/employees/${etmp}/status`, adm, { status: 'active', effectiveDate: '2027-01-01' });
  assert.equal(rein.status, 200, 'réintégration terminated → active permise');
  assert.equal(((await rein.json()) as { careerEvent: string }).careerEvent, 'reinstatement');
  const career = (await (await api(`/employees/${etmp}/career`, adm, undefined, 'GET')).json()) as { events: Array<{ eventType: string }> };
  const types = career.events.map((ev) => ev.eventType);
  assert.ok(types.includes('termination') && types.includes('reinstatement'), 'cessation ET réintégration restent des faits consultables');
});

test('zones protégées : permissions dédiées, lectures AUDITÉES, valeurs masquées dans l’audit', async () => {
  const adm = await token(slugA, admEmail);
  assert.equal((await api(`/employees/${e1}/private`, adm, {
    birthDate: '1991-05-12', nationality: 'BJ', sex: 'f', personalPhone: '+2290196000001',
    addressLine: 'Lot 12, Fidjrossè', addressCity: 'Cotonou',
    emergencyName: 'K. Sossou', emergencyRelation: 'frère', emergencyPhone: '+2290197000002',
  }, 'PUT')).status, 200);
  assert.equal((await api(`/employees/${e1}/identifiers`, adm, {
    cnssNumber: CNSS1, taxId: `IFU-${rid}-1`, idDocumentType: 'cni', idDocumentNumber: `CNI-${rid}-9`,
  }, 'PUT')).status, 200);
  // Permissions DISTINCTES par zone.
  const priv = await token(slugA, privEmail);
  const view = await token(slugA, viewEmail);
  const gp = await api(`/employees/${e1}/private`, priv, undefined, 'GET');
  assert.equal(gp.status, 200, 'view_private lit la zone personnelle');
  assert.equal(((await gp.json()) as { private: { nationality: string } }).private.nationality, 'BJ');
  assert.equal((await api(`/employees/${e1}/private`, view, undefined, 'GET')).status, 403, 'employees.view seul NE lit PAS la zone personnelle');
  assert.equal((await api(`/employees/${e1}/identifiers`, priv, undefined, 'GET')).status, 403, 'view_private ≠ view_identifiers');
  assert.equal((await api(`/employees/${e1}/identifiers`, view, undefined, 'GET')).status, 403);
  // CNSS unique : le doublon est refusé SANS jamais renvoyer la valeur.
  const dup = await api(`/employees/${e2}/identifiers`, adm, { cnssNumber: CNSS1 }, 'PUT');
  assert.equal(dup.status, 409);
  const dupBody = await dup.text();
  assert.ok(!dupBody.includes(CNSS1), 'la valeur CNSS ne sort JAMAIS dans une réponse d’erreur');
  // Chaque consultation des zones laisse une trace d'audit nominative.
  assert.ok(Number(psql(`SELECT count(*) FROM audit.audit_log WHERE tenant_id='${tenantAId}' AND action='employee_private_viewed' AND record_id='${e1}'`)) >= 1);
  // MINIMISATION À L'ÉCRITURE : l'audit ne stocke que des valeurs masquées (•••+3).
  const auditRow = psql(`SELECT new_value::text FROM audit.audit_log WHERE tenant_id='${tenantAId}' AND action='employee_identifiers_updated' ORDER BY id DESC LIMIT 1`);
  assert.ok(!auditRow.includes(CNSS1), 'le numéro complet n’atteint JAMAIS l’audit');
  assert.ok(auditRow.includes('•••'), 'seul le masque •••+3 est stocké');
  // Et la CONSULTATION d'audit (E6) masque la clé entière — double barrière.
  // La LISTE est compacte PAR CONCEPTION (aucune valeur old/new) ; les valeurs ne
  // sortent que dans le DÉTAIL, déjà masquées.
  const ev = await api(`/audit/events?module=hr&action=employee_identifiers_updated&recordId=${e1}`, adm, undefined, 'GET');
  assert.equal(ev.status, 200);
  const items = ((await ev.json()) as { items: Array<{ id: string; newValue?: unknown }> }).items;
  assert.ok(items.length >= 1);
  assert.ok(!('newValue' in items[0]!), 'la liste d’audit ne transporte JAMAIS les valeurs (minimisation E6)');
  const detail = await api(`/audit/events/${items[0]!.id}`, adm, undefined, 'GET');
  assert.equal(detail.status, 200);
  const detailBody = (await detail.json()) as { newValue: Record<string, string> };
  assert.equal(detailBody.newValue['cnssNumber'], '‹masqué›', 'le détail d’audit remplace la valeur par ‹masqué›');
  assert.ok(!JSON.stringify(detailBody).includes(CNSS1), 'le numéro CNSS complet n’apparaît nulle part dans la consultation');
  assert.ok(!JSON.stringify(detailBody).includes(`CNI-${rid}-9`), 'le numéro de pièce complet non plus');
  // Documents : métadonnées seulement, permission dédiée, lecture auditée.
  assert.equal((await api(`/employees/${e1}/documents`, adm, { docType: 'contrat', label: 'Contrat CDI 2026', fileRef: 'stockage-externe-001' })).status, 201);
  assert.equal((await api(`/employees/${e1}/documents`, priv, undefined, 'GET')).status, 403, 'view_private ≠ view_documents');
  const docs = await api(`/employees/${e1}/documents`, adm, undefined, 'GET');
  assert.equal(docs.status, 200);
  const docsText = JSON.stringify(await docs.json());
  assert.ok(docsText.includes('Contrat CDI 2026') && !docsText.includes('stockage-externe-001'), 'la référence de stockage n’est jamais exposée');
  assert.ok(Number(psql(`SELECT count(*) FROM audit.audit_log WHERE tenant_id='${tenantAId}' AND action='employee_documents_viewed'`)) >= 1);
});

test('les listes générales n’exposent JAMAIS identifiants, coordonnées personnelles ou urgence', async () => {
  const view = await token(slugA, viewEmail);
  const list = await api('/employees', view, undefined, 'GET');
  assert.equal(list.status, 200);
  const listText = JSON.stringify(await list.json());
  const detail = await api(`/employees/${e1}`, view, undefined, 'GET');
  assert.equal(detail.status, 200);
  const detailText = JSON.stringify(await detail.json());
  for (const [label, leaked] of [
    ['numéro CNSS', CNSS1], ['numéro de pièce', `CNI-${rid}-9`], ['date de naissance', '1991-05-12'],
    ['téléphone personnel', '2290196000001'], ['contact d’urgence', '2290197000002'], ['clé cnss', 'cnssNumber'],
    ['clé urgence', 'emergency'],
  ] as const) {
    assert.ok(!listText.includes(leaked), `liste générale : ${label} ne doit pas fuiter`);
    assert.ok(!detailText.includes(leaked), `détail professionnel : ${label} ne doit pas fuiter`);
  }
});

test('portées réelles : un gestionnaire borné à son département ne voit et n’agit QUE là', async () => {
  const chef = await token(slugA, chefEmail);
  const list = (await (await api('/employees', chef, undefined, 'GET')).json()) as { items: Array<{ matricule: string }> };
  assert.deepEqual(list.items.map((i) => i.matricule), ['HR-A-0001'], 'le chef RH ne voit QUE son département (affectation principale applicable)');
  assert.equal((await api(`/employees/${e2}`, chef, undefined, 'GET')).status, 404, 'hors périmètre = 404, pas de divulgation d’existence');
  // Agir DANS le périmètre : permis (suspension puis retour d'Awa).
  assert.equal((await api(`/employees/${e1}/status`, chef, { status: 'suspended', effectiveDate: '2026-06-01' })).status, 200);
  assert.equal((await api(`/employees/${e1}/status`, chef, { status: 'active', effectiveDate: '2026-06-15' })).status, 200);
  // Projeter HORS périmètre : refusé (cible non couverte).
  assert.equal((await api(`/employees/${e1}/assignments`, chef, { companyId: coA, unitId: uIt, isPrimary: false, effectiveFrom: '2026-08-01' })).status, 403);
  // Créer un dossier reste une action de niveau tenant.
  assert.equal((await api('/employees', chef, { matricule: 'HR-C-1', firstName: 'X', lastName: 'X' })).status, 403);
  // Et sans employees.manage, aucune transition, même à portée tenant.
  const view = await token(slugA, viewEmail);
  assert.equal((await api(`/employees/${e1}/status`, view, { status: 'on_leave' })).status, 403);
});

test('workflow E3 : le changement RH n’est appliqué qu’à l’APPROBATION, notification APRÈS application', async () => {
  const adm = await token(slugA, admEmail);
  const appr = await token(slugA, apprEmail);
  const key = `hr_status_${rid}`;
  const def = await api('/workflow/definitions', adm, {
    key, name: 'Changement de statut contrôlé',
    steps: [{ index: 0, name: 'Validation RH', approverType: 'role', approverRef: `hrappr-${rid}` }],
  });
  assert.equal(def.status, 201);
  const { id: defId } = (await def.json()) as { id: string };
  assert.equal((await api(`/workflow/definitions/${defId}/activate`, adm)).status, 200);
  // Compte lié au salarié E1 : destinataire de la notification d'application.
  psql(`UPDATE admin.users SET employee_id='${e1}' WHERE id='${linkUserId}'`);
  const notifBefore = Number(psql(`SELECT count(*) FROM notify.notifications WHERE tenant_id='${tenantAId}' AND template_key='hr.change_applied' AND user_id IN ('${admId}','${linkUserId}')`));

  const sub = await api(`/employees/${e1}/status`, adm, { status: 'on_leave', effectiveDate: '2026-08-20', workflowDefinitionKey: key });
  assert.equal(sub.status, 200);
  const { pendingChangeId, workflowInstanceId } = (await sub.json()) as { pendingChangeId: string; workflowInstanceId: string };
  assert.equal(psql(`SELECT status FROM core.employees WHERE id='${e1}'`), 'active', 'RIEN n’est appliqué avant l’approbation');
  assert.equal(Number(psql(`SELECT count(*) FROM notify.notifications WHERE tenant_id='${tenantAId}' AND template_key='hr.change_applied' AND user_id IN ('${admId}','${linkUserId}')`)), notifBefore, 'aucune notification avant application');
  let change = (await (await api(`/hr/changes/${pendingChangeId}`, adm, undefined, 'GET')).json()) as { status: string };
  assert.equal(change.status, 'pending');

  assert.equal((await api(`/workflow/instances/${workflowInstanceId}/approve`, appr)).status, 200);
  change = (await (await api(`/hr/changes/${pendingChangeId}`, adm, undefined, 'GET')).json()) as { status: string };
  assert.equal(change.status, 'applied');
  assert.equal(psql(`SELECT status FROM core.employees WHERE id='${e1}'`), 'on_leave', 'appliqué à l’approbation');
  assert.equal(psql(`SELECT count(*) FROM core.career_events WHERE employee_id='${e1}' AND workflow_instance_id IS NOT NULL`), '1', 'l’événement de carrière référence l’instance de workflow');
  const notifAfter = Number(psql(`SELECT count(*) FROM notify.notifications WHERE tenant_id='${tenantAId}' AND template_key='hr.change_applied' AND user_id IN ('${admId}','${linkUserId}')`));
  assert.equal(notifAfter, notifBefore + 2, 'notification APRÈS application : demandeur + salarié lié');

  // Rejet : rien ne bouge.
  const sub2 = await api(`/employees/${e1}/status`, adm, { status: 'active', effectiveDate: '2026-09-01', workflowDefinitionKey: key });
  const s2 = (await sub2.json()) as { pendingChangeId: string; workflowInstanceId: string };
  assert.equal((await api(`/workflow/instances/${s2.workflowInstanceId}/reject`, appr, { comment: 'période non conforme' })).status, 200);
  assert.equal(psql(`SELECT status FROM core.employees WHERE id='${e1}'`), 'on_leave', 'un rejet n’applique RIEN');
  const change2 = (await (await api(`/hr/changes/${s2.pendingChangeId}`, adm, undefined, 'GET')).json()) as { status: string };
  assert.equal(change2.status, 'rejected');
  // Remise en état pour la suite.
  assert.equal((await api(`/employees/${e1}/status`, adm, { status: 'active', effectiveDate: '2026-09-05' })).status, 200);
});

const csvHeader = 'matricule;last_name;first_name;hire_date;company_code;site_code;unit_code;position_code;job_code;cost_center_code;effective_from;professional_status;work_email;birth_date;nationality;personal_email;personal_phone;cnss_number;tax_id';

test('import CSV : preview sans écriture, apply ATOMIQUE, rejet SANS insertion partielle', async () => {
  const adm = await token(slugA, admEmail);
  const csv = [
    csvHeader,
    `IMP-${rid}-1;Sagbo;Inès;2026-02-01;CO-HR;SITE-HR;DEP-RH;;;;2026-02-01;cadre;ines.${rid}@corp.bj;1991-03-04;BJ;;;CNSS-IMP-${rid}-1;`,
    `IMP-${rid}-2;Toko;Marc;2026-02-01;CO-HR;;DEP-IT;POS-DEV;JOB-DEV;;2026-02-15;;;;NE;;;;IFU-IMP-${rid}-2`,
    `IMP-${rid}-3;Zinsou;Reine;2026-03-01;CO-HR;;DEP-RH;;;;2026-03-01;;;;;;;;`,
  ].join('\r\n');
  // Stratégies non implémentées : refus EXPLICITE, pas de simulation.
  const notImpl = await api('/hr/import', adm, { csv, mode: 'apply', strategy: 'update' });
  assert.equal(notImpl.status, 400);
  assert.ok((await notImpl.text()).includes('create_only'));
  // Preview : rapport complet, AUCUNE écriture.
  const prev = await api('/hr/import', adm, { csv, mode: 'preview', strategy: 'create_only' });
  assert.equal(prev.status, 200);
  const prevBody = (await prev.json()) as { valid: boolean; counts: Record<string, number> };
  assert.equal(prevBody.valid, true);
  assert.equal(prevBody.counts['employees'], 3);
  assert.equal(psql(`SELECT count(*) FROM core.employees WHERE tenant_id='${tenantAId}' AND matricule LIKE 'IMP-%'`), '0', 'preview n’écrit rien');
  // Apply : les 3 dossiers, zones, affectations et embauches naissent ENSEMBLE.
  const apply = await api('/hr/import', adm, { csv, mode: 'apply', strategy: 'create_only' });
  assert.equal(apply.status, 200);
  assert.equal(psql(`SELECT count(*) FROM core.employees WHERE tenant_id='${tenantAId}' AND matricule LIKE 'IMP-%'`), '3');
  assert.equal(psql(`SELECT count(*) FROM core.employee_assignments a JOIN core.employees e ON e.id=a.employee_id WHERE e.matricule LIKE 'IMP-%' AND a.is_primary`), '3');
  assert.equal(psql(`SELECT count(*) FROM core.career_events c JOIN core.employees e ON e.id=c.employee_id WHERE e.matricule LIKE 'IMP-%' AND c.event_type='hire'`), '3');
  assert.equal(psql(`SELECT cnss_number FROM core.employee_identifiers i JOIN core.employees e ON e.id=i.employee_id WHERE e.matricule='IMP-${RID}-1'`), `CNSS-IMP-${rid}-1`);
  // Rejouer le même fichier : 422 (create_only) et rien de plus n'est écrit.
  const replay = await api('/hr/import', adm, { csv, mode: 'apply', strategy: 'create_only' });
  assert.equal(replay.status, 422);
  assert.equal(psql(`SELECT count(*) FROM core.employees WHERE tenant_id='${tenantAId}' AND matricule LIKE 'IMP-%'`), '3');
  // Lot avec UNE erreur : AUCUNE ligne n'entre — pas d'insertion partielle.
  const badCsv = [
    csvHeader,
    `IMP-OK-${rid};Bon;Dossier;2026-04-01;CO-HR;;DEP-RH;;;;2026-04-01;;;;;;;;`,
    `IMP-BAD-${rid};Mauvais;Dossier;2026-04-01;CO-HR;;UNIT-NOPE;;;;2026-04-01;;;;;;;;`,
  ].join('\r\n');
  const bad = await api('/hr/import', adm, { csv: badCsv, mode: 'apply', strategy: 'create_only' });
  assert.equal(bad.status, 422);
  const badBody = (await bad.json()) as { errors: Array<{ line: number; error: string }> };
  assert.ok(badBody.errors.some((er) => er.line === 3 && er.error.includes('UNIT-NOPE')));
  assert.equal(psql(`SELECT count(*) FROM core.employees WHERE tenant_id='${tenantAId}' AND matricule IN ('IMP-OK-${RID}','IMP-BAD-${RID}')`), '0', 'la ligne VALIDE du lot fautif n’est pas entrée non plus');
  // Doublon CNSS DANS le fichier : signalé par ligne, la VALEUR ne sort jamais.
  const cnssDup = `CNSS-DUP-${rid}-424242`;
  const dupCsv = [
    csvHeader,
    `IMP-D1-${rid};Un;Deux;2026-04-01;CO-HR;;DEP-RH;;;;2026-04-01;;;;;;;${cnssDup};`,
    `IMP-D2-${rid};Trois;Quatre;2026-04-01;CO-HR;;DEP-RH;;;;2026-04-01;;;;;;;${cnssDup};`,
  ].join('\r\n');
  const dup = await api('/hr/import', adm, { csv: dupCsv, mode: 'apply', strategy: 'create_only' });
  assert.equal(dup.status, 422);
  const dupText = await dup.text();
  assert.ok(dupText.includes('CNSS'), 'l’erreur nomme le doublon CNSS');
  assert.ok(!dupText.includes(cnssDup), 'la valeur CNSS ne figure JAMAIS dans le rapport');
});

test('isolation tenant : B ne voit rien de A, ni en liste, ni en détail, ni par import', async () => {
  const badm = await token(slugB, bAdmEmail);
  const list = (await (await api('/employees', badm, undefined, 'GET')).json()) as { items: Array<{ matricule: string }> };
  assert.ok(list.items.every((i) => !i.matricule.startsWith('HR-A-000') || i.matricule === 'HR-A-0001'), 'B ne liste que SES dossiers');
  assert.ok(list.items.some((i) => i.matricule === 'HR-A-0001'), 'le dossier homonyme de B existe bien chez B');
  assert.equal(list.items.length, 1, 'aucun dossier de A ne fuit chez B');
  assert.equal((await api(`/employees/${e1}`, badm, undefined, 'GET')).status, 404, 'le dossier de A n’existe pas pour B (RLS)');
  assert.equal((await api(`/employees/${e1}/private`, badm, undefined, 'GET')).status, 403, 'et B n’a de toute façon pas la permission dédiée');
  assert.equal((await api(`/employees/${e1}/status`, badm, { status: 'terminated' })).status, 404, 'B ne peut pas agir sur un dossier de A');
  // Import chez B référençant les codes de A : références INCONNUES (résolution sous RLS).
  const crossCsv = [csvHeader, `IMP-X-${rid};Croise;Tenant;2026-04-01;CO-HR;;DEP-RH;;;;2026-04-01;;;;;;;;`].join('\r\n');
  const cross = await api('/hr/import', badm, { csv: crossCsv, mode: 'apply', strategy: 'create_only' });
  assert.equal(cross.status, 422);
  assert.ok((await cross.text()).includes('référence inconnue'), 'les codes de A n’existent pas dans le tenant B');
});

test('OpenAPI : les chemins Core HR sont documentés', async () => {
  const res = await fetch(`${base}/openapi.json`);
  assert.equal(res.status, 200);
  const spec = (await res.json()) as { paths: Record<string, unknown> };
  for (const p of [
    '/employees', '/employees/{id}', '/employees/{id}/private', '/employees/{id}/identifiers',
    '/employees/{id}/documents', '/employees/{id}/status', '/employees/{id}/assignments',
    '/employees/{id}/career', '/employees/{id}/at', '/employees/{id}/manager',
    '/hr/import', '/hr/changes/{id}',
  ]) {
    assert.ok(spec.paths[p], `chemin ${p} documenté`);
  }
});
