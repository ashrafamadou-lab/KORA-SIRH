/**
 * E2E Organisation (E8) — conditions de validation du sponsor : FK inter-tenant
 * rejetées PAR POSTGRESQL, cycles refusés, réorganisations datées sans réécriture du
 * passé, chevauchements rejetés, aucune suppression physique, désactivation sans
 * orphelins, portées RBAC réelles (évaluation PAR CIBLE), import CSV atomique sans
 * insertion partielle, changements sensibles via workflow E3 + notifications E5,
 * isolation tenant, recherche/pagination, OpenAPI.
 * Fixtures : permissions issues des MIGRATIONS uniquement (la CI ne seed pas).
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
/** Exécute une requête ATTENDUE EN ÉCHEC ; retourne le stderr PostgreSQL. */
function psqlErr(sql: string): string {
  const r = spawnSync('psql', [MIGRATOR_URL, '-qXtA', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
  assert.notEqual(r.status, 0, `la requête aurait dû échouer : ${sql.slice(0, 80)}`);
  return r.stderr;
}

const rid = randomUUID().slice(0, 8);
const P = 'Trajet-Manguier-2026!';
const slugA = `org-a-${rid}`;
const slugB = `org-b-${rid}`;

const adminEmail = `adm.${rid}@demo.bj`;    // org.* + import + workflow + notify (portée tenant)
const viewerEmail = `view.${rid}@demo.bj`;  // org.view seul (portée tenant)
const chefEmail = `chef.${rid}@demo.bj`;    // org.manage + org.view, SANS portée tenant (department ajouté plus tard)
const deptEmail = `dept.${rid}@demo.bj`;    // aucune permission, portée department sur une AUTRE unité
const apprEmail = `appr.${rid}@demo.bj`;    // approbateur du workflow org (rôle orgapprover)
const bAdminEmail = `badm.${rid}@demo.bj`;

let app: INestApplication;
let base = '';
let tenantAId = '';
let tenantBId = '';
let chefId = '';
let deptUserId = '';

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
  tenantAId = psql(`INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('${slugA}','ORG A',true) RETURNING id`);
  tenantBId = psql(`INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('${slugB}','ORG B',true) RETURNING id`);
  const adminPerms = ['org.view', 'org.manage', 'org.import',
    'workflow.manage', 'workflow.submit', 'workflow.act', 'workflow.view', 'notify.manage'];
  await seedUser(tenantAId, adminEmail, adminPerms, [], true);
  await seedUser(tenantAId, viewerEmail, ['org.view'], [], true);
  chefId = await seedUser(tenantAId, chefEmail, ['org.manage', 'org.view'], [], false);
  deptUserId = await seedUser(tenantAId, deptEmail, [], [], false);
  await seedUser(tenantAId, apprEmail, ['workflow.act', 'workflow.view'], [`orgappr-${rid}`], true);
  await seedUser(tenantBId, bAdminEmail, ['org.view', 'org.manage', 'org.import'], [], true);

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

let coA = ''; let siteA = ''; let jobA = ''; let ccA = '';
let uDir = ''; let uFin = ''; let uCpt = ''; let uDir2 = '';
let posDaf = ''; let posCpt1 = '';
let bUnitId = '';

test('référentiel : créations bilingues, doublon 409, RBAC, audité avec valeurs', async () => {
  const adm = await token(slugA, adminEmail);
  coA = await created('/org/companies', adm, { code: 'CO-A', labelFr: 'Société A', labelEn: 'Company A', legalForm: 'SA' });
  siteA = await created('/org/sites', adm, { code: 'SITE-COT', labelFr: 'Site Cotonou', labelEn: 'Cotonou site', companyId: coA, city: 'Cotonou' });
  jobA = await created('/org/jobs', adm, { code: 'JOB-CPT', labelFr: 'Comptable', labelEn: 'Accountant' });
  ccA = await created('/org/cost-centers', adm, { code: 'CC-100', labelFr: 'CC Finance', labelEn: 'Finance CC' });
  // Doublon de code : 409 explicite.
  assert.equal((await api('/org/companies', adm, { code: 'CO-A', labelFr: 'X', labelEn: 'X' })).status, 409);
  // Un viewer ne crée rien (403), un viewer liste (200).
  const view = await token(slugA, viewerEmail);
  assert.equal((await api('/org/companies', view, { code: 'CO-V', labelFr: 'X', labelEn: 'X' })).status, 403);
  assert.equal((await api('/org/companies', view, undefined, 'GET')).status, 200);
  // Audit avec valeurs (couvertes par la chaîne).
  const audited = psql(`SELECT count(*) FROM audit.audit_log WHERE tenant_id='${tenantAId}' AND module='org' AND action='org_company_created' AND new_value IS NOT NULL`);
  assert.ok(Number(audited) >= 1);
  // La création chez B (pour le test FK inter-tenant SQL).
  const badm = await token(slugB, bAdminEmail);
  const coB = await created('/org/companies', badm, { code: 'CO-B', labelFr: 'Société B', labelEn: 'Company B' });
  bUnitId = await created('/org/units', badm, { code: 'DIR-B', labelFr: 'Direction B', labelEn: 'Dir B', unitType: 'direction', companyId: coB });
});

test('unités : hiérarchie DATÉE créée, consultée à une date', async () => {
  const adm = await token(slugA, adminEmail);
  uDir = await created('/org/units', adm, { code: 'DIR-A', labelFr: 'Direction Générale', labelEn: 'General Directorate', unitType: 'direction', companyId: coA });
  uFin = await created('/org/units', adm, { code: 'DEP-FIN', labelFr: 'Département Finance', labelEn: 'Finance Dept', unitType: 'department', parentUnitId: uDir, effectiveFrom: '2026-01-01' });
  uCpt = await created('/org/units', adm, { code: 'SRV-CPT', labelFr: 'Service Comptabilité', labelEn: 'Accounting', unitType: 'service', parentUnitId: uFin, effectiveFrom: '2026-01-01' });
  uDir2 = await created('/org/units', adm, { code: 'DIR-B2', labelFr: 'Direction Support', labelEn: 'Support Directorate', unitType: 'direction', companyId: coA });
  const detail = (await (await api(`/org/units/${uFin}`, adm, undefined, 'GET')).json()) as { parentHistory: unknown[] };
  assert.equal(detail.parentHistory.length, 1);
});

test('FK inter-tenant : rejetée par POSTGRESQL, pas seulement par l’API', async () => {
  // Lien hiérarchique tenant A → parent du tenant B : violation de FK COMPOSITE en base.
  // NB : on vise DIR (racine, aucune ligne hiérarchique) — sur une unité déjà rattachée,
  // la contrainte d'EXCLUSION (index) se déclencherait avant la FK (after-trigger) et
  // masquerait le message ; les deux refusent, mais c'est la FK qu'on veut exposer ici.
  const err1 = psqlErr(`INSERT INTO org.unit_parents (tenant_id, unit_id, parent_unit_id, effective_from)
    VALUES ('${tenantAId}','${uDir}','${bUnitId}','2026-02-01')`);
  assert.ok(err1.includes('foreign key'), `attendu une violation de FK : ${err1}`);
  // Rattachement de poste vers l'unité d'un autre tenant : même refus structurel.
  const fkPos = psql(`INSERT INTO org.positions (tenant_id, code, label_fr, label_en) VALUES ('${tenantAId}','FKTEST','FK','FK') RETURNING id`);
  const err2 = psqlErr(`INSERT INTO org.position_assignments (tenant_id, position_id, unit_id, company_id, job_id, effective_from)
    VALUES ('${tenantAId}','${fkPos}','${bUnitId}','${coA}','${jobA}','2026-02-01')`);
  assert.ok(err2.includes('foreign key'), `violation de FK composite attendue : ${err2}`);
});

test('cycles : refusés par l’API (409) et par la base', async () => {
  const adm = await token(slugA, adminEmail);
  // DIR sous CPT alors que CPT descend de DIR → cycle.
  const res = await api(`/org/units/${uDir}/move`, adm, { newParentUnitId: uCpt, effectiveFrom: '2026-06-01' });
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { code: string }).code, 'cycle');
  const err = psqlErr(`INSERT INTO org.unit_parents (tenant_id, unit_id, parent_unit_id, effective_from)
    VALUES ('${tenantAId}','${uDir}','${uCpt}','2026-06-01')`);
  assert.ok(err.includes('cycle'), `trigger anti-cycle attendu : ${err}`);
});

test('réorganisation datée : le passé ne bouge JAMAIS, l’historique est conservé', async () => {
  const adm = await token(slugA, adminEmail);
  // CPT quitte FIN pour DIR au 2026-07-01 (clôture + nouvelle ligne).
  const mv = await api(`/org/units/${uCpt}/move`, adm, { newParentUnitId: uDir, effectiveFrom: '2026-07-01' });
  assert.equal(mv.status, 200, await mv.text().catch(() => ''));
  type Chart = { tree: Array<{ id: string; children: Array<{ id: string; children: Array<{ id: string }> }> }> };
  const before7 = (await (await api('/org/chart?date=2026-03-01', adm, undefined, 'GET')).json()) as Chart;
  const dirBefore = before7.tree.find((n) => n.id === uDir)!;
  const finBefore = dirBefore.children.find((n) => n.id === uFin)!;
  assert.ok(finBefore.children.some((n) => n.id === uCpt), 'au 2026-03-01, CPT reste sous FIN (le passé est intact)');
  const after7 = (await (await api('/org/chart?date=2026-08-01', adm, undefined, 'GET')).json()) as Chart;
  const dirAfter = after7.tree.find((n) => n.id === uDir)!;
  assert.ok(dirAfter.children.some((n) => n.id === uCpt), 'au 2026-08-01, CPT est sous DIR');
  // L'historique porte l'ancienne position, close proprement.
  const detail = (await (await api(`/org/units/${uCpt}`, adm, undefined, 'GET')).json()) as {
    parentHistory: Array<{ parentUnitId: string; effectiveFrom: string; effectiveTo: string | null }>;
  };
  assert.equal(detail.parentHistory.length, 2);
  assert.equal(detail.parentHistory[0]!.parentUnitId, uFin);
  assert.ok(detail.parentHistory[0]!.effectiveTo?.startsWith('2026-07-01'), 'ancienne période close au 2026-07-01');
  assert.equal(detail.parentHistory[1]!.parentUnitId, uDir);
  assert.equal(detail.parentHistory[1]!.effectiveTo, null);
});

test('chevauchements : rejetés par l’API et par la contrainte d’exclusion', async () => {
  const adm = await token(slugA, adminEmail);
  // Une date d'effet antérieure au début de la période ouverte : refus propre.
  const res = await api(`/org/units/${uCpt}/move`, adm, { newParentUnitId: uFin, effectiveFrom: '2026-05-01' });
  assert.equal(res.status, 400);
  // Insertion directe chevauchante : contrainte EXCLUDE (23P01).
  const err = psqlErr(`INSERT INTO org.unit_parents (tenant_id, unit_id, parent_unit_id, effective_from)
    VALUES ('${tenantAId}','${uCpt}','${uFin}','2026-09-01')`);
  assert.ok(err.includes('exclusion') || err.includes('conflicting key'), `EXCLUDE attendu : ${err}`);
});

test('postes : rattachements datés, UN SEUL manager applicable, ligne managériale', async () => {
  const adm = await token(slugA, adminEmail);
  posDaf = await created('/org/positions', adm, {
    code: 'POS-DAF', labelFr: 'Directeur financier', labelEn: 'CFO',
    unitId: uFin, companyId: coA, jobId: jobA, siteId: siteA, costCenterId: ccA, effectiveFrom: '2026-01-01',
  });
  posCpt1 = await created('/org/positions', adm, {
    code: 'POS-CPT1', labelFr: 'Comptable senior', labelEn: 'Senior accountant',
    unitId: uCpt, companyId: coA, jobId: jobA, managerPositionId: posDaf, effectiveFrom: '2026-01-01',
  });
  const line = (await (await api(`/org/positions/${posCpt1}/manager-line?date=2026-03-01`, adm, undefined, 'GET')).json()) as { managers: Array<{ id: string }> };
  assert.deepEqual(line.managers.map((m) => m.id), [posDaf], 'ligne managériale résolue à la date');
  // Second manager chevauchant : EXCLUDE — un seul parent hiérarchique applicable.
  const err = psqlErr(`INSERT INTO org.position_managers (tenant_id, position_id, manager_position_id, effective_from)
    VALUES ('${tenantAId}','${posCpt1}','${posDaf}','2026-04-01')`);
  assert.ok(err.includes('exclusion') || err.includes('conflicting key'));
  // Cycle managérial : refusé par trigger.
  const err2 = psqlErr(`INSERT INTO org.position_managers (tenant_id, position_id, manager_position_id, effective_from)
    VALUES ('${tenantAId}','${posDaf}','${posCpt1}','2026-04-01')`);
  assert.ok(err2.includes('cycle'));
  // Détail : historiques complets présents.
  const det = (await (await api(`/org/positions/${posCpt1}`, adm, undefined, 'GET')).json()) as { assignmentHistory: unknown[]; managerHistory: unknown[] };
  assert.equal(det.assignmentHistory.length, 1);
  assert.equal(det.managerHistory.length, 1);
});

test('portée RBAC RÉELLE : un gestionnaire borné à son département ne déplace que lui', async () => {
  // Portée department de chef sur FIN — un id d'unité RÉEL, validé par trigger (0014).
  psql(`INSERT INTO admin.user_scopes (tenant_id, user_id, scope_type, scope_ref) VALUES ('${tenantAId}','${chefId}','department','${uFin}')`);
  psql(`INSERT INTO admin.user_scopes (tenant_id, user_id, scope_type, scope_ref) VALUES ('${tenantAId}','${deptUserId}','department','${uDir2}')`);
  const chef = await token(slugA, chefEmail);
  // Chef peut déplacer SON unité (FIN → DIR-B2, effet futur : réorganisation planifiée).
  const ok = await api(`/org/units/${uFin}/move`, chef, { newParentUnitId: uDir2, effectiveFrom: '2026-09-01' });
  assert.equal(ok.status, 200, await ok.text().catch(() => ''));
  // Chef NE peut PAS déplacer une unité hors de sa portée.
  assert.equal((await api(`/org/units/${uDir2}/move`, chef, { newParentUnitId: uDir, effectiveFrom: '2026-09-01' })).status, 403);
  // Un viewer (sans org.manage) est refusé aussi — même avec portée tenant.
  const view = await token(slugA, viewerEmail);
  assert.equal((await api(`/org/units/${uCpt}/move`, view, { newParentUnitId: uFin, effectiveFrom: '2026-12-01' })).status, 403);
  // La réorganisation FUTURE (2026-09-01) n'affecte pas l'organigramme d'AUJOURD'HUI (2026-08).
  const adm = await token(slugA, adminEmail);
  type Chart = { tree: Array<{ id: string; children: Array<{ id: string }> }> };
  const today = (await (await api('/org/chart?date=2026-08-02', adm, undefined, 'GET')).json()) as Chart;
  assert.ok(today.tree.find((n) => n.id === uDir)!.children.some((c) => c.id === uFin), 'FIN encore sous DIR aujourd’hui');
  const future = (await (await api('/org/chart?date=2026-09-15', adm, undefined, 'GET')).json()) as Chart;
  assert.ok(future.tree.find((n) => n.id === uDir2)!.children.some((c) => c.id === uFin), 'FIN sous DIR-B2 au 15/09');
});

test('notification E5 du déplacement : portée department réellement discriminante', async () => {
  const adm = await token(slugA, adminEmail);
  const c = await api('/admin/notify/templates', adm, {
    key: 'org.unit_moved', name: 'Réorganisation',
    subjectFr: 'Réorganisation — {{unite}}', subjectEn: 'Reorganisation — {{unite}}',
    bodyFr: 'L’unité {{unite}} change de rattachement au {{date_effet}}.',
    bodyEn: 'Unit {{unite}} is re-attached on {{date_effet}}.',
    variables: ['unite', 'date_effet'], channels: ['in_app'], mandatory: false,
  });
  assert.equal(c.status, 201);
  const { id } = (await c.json()) as { id: string };
  assert.equal((await api(`/admin/notify/templates/${id}/activate`, adm)).status, 200);
  // Chef re-déplace FIN (retour sous DIR au 2026-10-01) → notification aux porteurs de la portée FIN.
  const chef = await token(slugA, chefEmail);
  assert.equal((await api(`/org/units/${uFin}/move`, chef, { newParentUnitId: uDir, effectiveFrom: '2026-10-01' })).status, 200);
  const chefNotif = psql(`SELECT count(*) FROM notify.notifications WHERE tenant_id='${tenantAId}' AND user_id='${chefId}' AND template_key='org.unit_moved'`);
  assert.equal(chefNotif, '1', 'le porteur de la portée department FIN est notifié');
  const deptNotif = psql(`SELECT count(*) FROM notify.notifications WHERE tenant_id='${tenantAId}' AND user_id='${deptUserId}' AND template_key='org.unit_moved'`);
  assert.equal(deptNotif, '0', 'le porteur d’une portée sur une AUTRE unité n’est pas notifié');
});

test('changement sensible via workflow E3 : approuvé ⇒ appliqué, rejeté ⇒ intact', async () => {
  const adm = await token(slugA, adminEmail);
  const appr = await token(slugA, apprEmail);
  const key = `org_move_${rid}`;
  const def = await api('/workflow/definitions', adm, {
    key, name: 'Réorganisation contrôlée',
    steps: [{ index: 0, name: 'Validation', approverType: 'role', approverRef: `orgappr-${rid}` }],
  });
  assert.equal(def.status, 201);
  const { id: defId } = (await def.json()) as { id: string };
  assert.equal((await api(`/workflow/definitions/${defId}/activate`, adm)).status, 200);

  // 1) Move soumis au workflow — rien n'est appliqué avant l'approbation.
  const sub = await api(`/org/units/${uCpt}/move`, adm, { newParentUnitId: uDir2, effectiveFrom: '2026-11-01', workflowDefinitionKey: key });
  assert.equal(sub.status, 200);
  const { pendingChangeId, workflowInstanceId } = (await sub.json()) as { pendingChangeId: string; workflowInstanceId: string };
  let change = (await (await api(`/org/changes/${pendingChangeId}`, adm, undefined, 'GET')).json()) as { status: string };
  assert.equal(change.status, 'pending');
  const histBefore = psql(`SELECT count(*) FROM org.unit_parents WHERE unit_id='${uCpt}'`);
  // 2) Approbation → application datée.
  assert.equal((await api(`/workflow/instances/${workflowInstanceId}/approve`, appr)).status, 200);
  change = (await (await api(`/org/changes/${pendingChangeId}`, adm, undefined, 'GET')).json()) as { status: string };
  assert.equal(change.status, 'applied');
  assert.equal(psql(`SELECT count(*) FROM org.unit_parents WHERE unit_id='${uCpt}'`), String(Number(histBefore) + 1), 'nouvelle ligne datée ajoutée');
  // 3) Un second changement, REJETÉ : rien n'est appliqué.
  const sub2 = await api(`/org/units/${uCpt}/move`, adm, { newParentUnitId: uFin, effectiveFrom: '2026-12-01', workflowDefinitionKey: key });
  const s2 = (await sub2.json()) as { pendingChangeId: string; workflowInstanceId: string };
  assert.equal((await api(`/workflow/instances/${s2.workflowInstanceId}/reject`, appr, { comment: 'non' })).status, 200);
  const change2 = (await (await api(`/org/changes/${s2.pendingChangeId}`, adm, undefined, 'GET')).json()) as { status: string };
  assert.equal(change2.status, 'rejected');
  assert.equal(psql(`SELECT count(*) FROM org.unit_parents WHERE unit_id='${uCpt}'`), String(Number(histBefore) + 1), 'aucune ligne ajoutée après rejet');
});

test('import CSV : preview valide SANS écriture', async () => {
  const adm = await token(slugA, adminEmail);
  const csv = [
    'kind;code;label_fr;label_en;unit_type;parent_code;unit_code;company_code;site_code;job_code;cost_center_code;manager_position_code;effective_from',
    'company;IMP-CO;Société Import;Import Co;;;;;;;;;',
    'site;IMP-SITE;Site Import;Import site;;;;IMP-CO;;;;;',
    'cost_center;IMP-CC;CC Import;Import CC;;;;;;;;;',
    'job;IMP-JOB;Emploi Import;Import job;;;;;;;;;',
    'unit;IMP-DIR;Direction Imp;Imp Dir;direction;;;IMP-CO;;;;;',
    'unit;IMP-FIN;Finance Imp;Imp Fin;department;IMP-DIR;;;;;;;2026-01-01',
    'unit;IMP-CPT;Compta Imp;Imp Acc;service;IMP-FIN;;;;;;;2026-01-01',
    'position;IMP-DAF;DAF Imp;Imp CFO;;;IMP-FIN;IMP-CO;IMP-SITE;IMP-JOB;IMP-CC;;2026-01-01',
    'position;IMP-CPT1;Comptable Imp;Imp Acct;;;IMP-CPT;IMP-CO;;IMP-JOB;;IMP-DAF;2026-01-01',
  ].join('\r\n');
  const res = await api('/org/import', adm, { csv, mode: 'preview' });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { valid: boolean; counts: Record<string, number> };
  assert.equal(body.valid, true);
  assert.deepEqual(body.counts, { company: 1, site: 1, cost_center: 1, job: 1, unit: 3, position: 2 });
  assert.equal(psql(`SELECT count(*) FROM org.companies WHERE tenant_id='${tenantAId}' AND code='IMP-CO'`), '0', 'preview n’écrit rien');
  (globalThis as Record<string, unknown>)['__csv'] = csv;
});

test('import CSV : une seule ligne fautive ⇒ rapport détaillé et ZÉRO insertion', async () => {
  const adm = await token(slugA, adminEmail);
  const csv = [
    'kind;code;label_fr;label_en;unit_type;parent_code;unit_code;company_code;site_code;job_code;cost_center_code;manager_position_code;effective_from',
    'company;IMP2-CO;Société 2;Co 2;;;;;;;;;',
    'unit;IMP2-A;Unité A;Unit A;direction;;;IMP2-CO;;;;;',
    'unit;IMP2-B;Unité B;Unit B;department;PARENT-INCONNU;;;;;;;', // ← référence inconnue
  ].join('\n');
  const res = await api('/org/import', adm, { csv, mode: 'apply' });
  assert.equal(res.status, 422);
  const body = (await res.json()) as { errors: Array<{ line: number; error: string }> };
  assert.ok(body.errors.some((e) => e.line === 4 && e.error.includes('référence inconnue')));
  assert.equal(psql(`SELECT count(*) FROM org.companies WHERE tenant_id='${tenantAId}' AND code='IMP2-CO'`), '0', 'atomicité : rien n’est inséré');
  assert.equal(psql(`SELECT count(*) FROM org.units WHERE tenant_id='${tenantAId}' AND code LIKE 'IMP2-%'`), '0');
});

test('import CSV : apply atomique, rejeu = collision sans écriture, aucun croisement inter-tenant', async () => {
  const adm = await token(slugA, adminEmail);
  const csv = (globalThis as Record<string, unknown>)['__csv'] as string;
  const res = await api('/org/import', adm, { csv, mode: 'apply' });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { applied: boolean; counts: Record<string, number> };
  assert.equal(body.applied, true);
  assert.equal(psql(`SELECT count(*) FROM org.units WHERE tenant_id='${tenantAId}' AND code LIKE 'IMP-%'`), '3');
  // La hiérarchie importée est réelle et datée.
  const finId = psql(`SELECT id FROM org.units WHERE tenant_id='${tenantAId}' AND code='IMP-FIN'`);
  assert.equal(psql(`SELECT count(*) FROM org.unit_parents WHERE unit_id='${finId}'`), '1');
  // Rejouer le même fichier : collisions signalées, RIEN d'écrit en plus.
  const again = await api('/org/import', adm, { csv, mode: 'apply' });
  assert.equal(again.status, 422);
  assert.equal(psql(`SELECT count(*) FROM org.units WHERE tenant_id='${tenantAId}' AND code LIKE 'IMP-%'`), '3', 'aucune insertion partielle au rejeu');
  // Le MÊME fichier appliqué chez B crée les objets DE B — aucune référence croisée.
  const badm = await token(slugB, bAdminEmail);
  const resB = await api('/org/import', badm, { csv, mode: 'apply' });
  assert.equal(resB.status, 200);
  const aId = psql(`SELECT id FROM org.companies WHERE tenant_id='${tenantAId}' AND code='IMP-CO'`);
  const bId = psql(`SELECT id FROM org.companies WHERE tenant_id='${tenantBId}' AND code='IMP-CO'`);
  assert.notEqual(aId, bId);
  assert.equal(psql(`SELECT count(*) FROM org.unit_parents up JOIN org.units u ON u.id = up.unit_id WHERE up.tenant_id='${tenantBId}' AND u.tenant_id <> '${tenantBId}'`), '0');
});

test('suppression physique impossible ; désactivation d’un parent SANS orphelins', async () => {
  const adm = await token(slugA, adminEmail);
  // Aucune route DELETE n'existe sur /org.
  for (const p of [`/org/units/${uFin}`, `/org/companies/${coA}`, `/org/positions/${posDaf}`]) {
    const res = await fetch(`${base}${p}`, { method: 'DELETE', headers: { authorization: `Bearer ${adm}` } });
    assert.ok([404, 405].includes(res.status), `DELETE ${p} → ${res.status}`);
  }
  // Cycle de vie réel : les créations API naissent en DRAFT — on ACTIVE d'abord
  // (draft→active), condition pour que la protection anti-orphelins ait un sens.
  for (const [entity, id] of [['units', uDir], ['units', uFin], ['units', uCpt],
    ['positions', posDaf], ['positions', posCpt1]] as const) {
    assert.equal((await api(`/org/${entity}/${id}/status`, adm, { status: 'active' })).status, 200, `${entity}/${id} → active`);
  }
  // DIR a des enfants ACTIFS aujourd'hui (FIN et/ou CPT selon la date) : refusée — pas d'orphelins.
  const res = await api(`/org/units/${uDir}/status`, adm, { status: 'inactive' });
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { code: string }).code, 'children_active');
  // FIN porte un poste actif (POS-DAF) : refusée aussi, tant que le poste n'est pas traité.
  assert.equal((await api(`/org/units/${uFin}/status`, adm, { status: 'inactive' })).status, 409);
  assert.equal((await api(`/org/positions/${posDaf}/status`, adm, { status: 'inactive' })).status, 200);
  const after = await api(`/org/units/${uFin}/status`, adm, { status: 'inactive' });
  assert.equal(after.status, 200, 'une fois les dépendances traitées, la désactivation passe');
  // Réactivation propre (inactive → active) pour la suite.
  assert.equal((await api(`/org/units/${uFin}/status`, adm, { status: 'active' })).status, 200);
  assert.equal((await api(`/org/positions/${posDaf}/status`, adm, { status: 'active' })).status, 200);
  // archived est terminal : transition draft→inactive interdite aussi (garde SQL + service).
  const tmp = await created('/org/units', adm, { code: 'TMP-ARC', labelFr: 'Temp', labelEn: 'Temp', unitType: 'team' });
  assert.equal((await api(`/org/units/${tmp}/status`, adm, { status: 'archived' })).status, 200);
  assert.equal((await api(`/org/units/${tmp}/status`, adm, { status: 'active' })).status, 400);
});

test('recherche, filtres et pagination stables', async () => {
  const adm = await token(slugA, adminEmail);
  const byLabel = (await (await api('/org/units?query=Finance', adm, undefined, 'GET')).json()) as Array<{ code: string }>;
  assert.ok(byLabel.some((u) => u.code === 'DEP-FIN'));
  const byType = (await (await api('/org/units?type=direction', adm, undefined, 'GET')).json()) as Array<{ unitType: string }>;
  assert.ok(byType.length >= 2 && byType.every((u) => u.unitType === 'direction'));
  const p1 = (await (await api('/org/units?limit=2&offset=0', adm, undefined, 'GET')).json()) as Array<{ id: string }>;
  const p2 = (await (await api('/org/units?limit=2&offset=2', adm, undefined, 'GET')).json()) as Array<{ id: string }>;
  assert.equal(p1.length, 2);
  assert.ok(p2.every((u) => !p1.some((v) => v.id === u.id)), 'pages disjointes (ORDER BY code stable)');
});

test('NÉGATIF inter-tenant : B ne voit ni ne touche l’organisation de A', async () => {
  const badm = await token(slugB, bAdminEmail);
  const units = (await (await api('/org/units?limit=200', badm, undefined, 'GET')).json()) as Array<{ id: string }>;
  assert.ok(units.every((u) => u.id !== uDir && u.id !== uFin), 'aucune unité de A');
  assert.equal((await api(`/org/units/${uFin}`, badm, undefined, 'GET')).status, 404);
  assert.equal((await api(`/org/units/${uFin}/move`, badm, { newParentUnitId: null, effectiveFrom: '2026-12-01' })).status, 404);
  assert.equal((await api(`/org/positions/${posCpt1}`, badm, undefined, 'GET')).status, 404);
});

test('OpenAPI : endpoints organisation documentés', async () => {
  const spec = (await (await fetch(`${base}/openapi.json`)).json()) as { paths: Record<string, unknown> };
  for (const p of ['/org/companies', '/org/sites', '/org/units', '/org/units/{id}/move', '/org/positions',
    '/org/positions/{id}/manager-line', '/org/chart', '/org/{entity}/{id}/status', '/org/import', '/org/changes/{id}']) {
    assert.ok(spec.paths[p], `chemin ${p} documenté`);
  }
});
