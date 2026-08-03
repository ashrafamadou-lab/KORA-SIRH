/**
 * E2E Congés E11.2 — demandes ESS : une demande ne modifie JAMAIS un solde
 * (réservation/libération/consommation = mouvements append-only idempotents) ;
 * soumission FIGÉE et versionnée ; décision E3 liée à la version exacte ;
 * séparation des tâches (auto-approbation ET bénéficiaire exclus) ; double
 * soumission/réservation/approbation sans double effet ; deux demandes
 * concurrentes ne surconsomment jamais le même droit (verrou + contrôle sous
 * verrou) ; décompte E10 réel (fériés, repos, rotations de NUIT, demi-journées,
 * heures) ; politique future sans effet historique ; rétroactif sur période
 * close = constat explicite, JAMAIS un impact automatique ; échec d'application
 * = approbation conservée + reprise idempotente ; annulation par circuit
 * distinct (reversement référencé) ; justificatifs médicaux cloisonnés
 * (listes, pièces, audit, calendrier) ; portées self/équipe/RH réelles ;
 * notifications après commit réel ; journal complet.
 * RÈGLE DE LECTURE : un corps HTTP se lit UNE fois (texte → assert → parse).
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
function psqlFails(sql: string): boolean {
  const r = spawnSync('psql', [MIGRATOR_URL, '-qXtA', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
  return r.status !== 0;
}

const rid = randomUUID().slice(0, 8);
const RID = rid.toUpperCase();
const P = 'Kandi-Alibori-2026!';
const slugA = `lr-a-${rid}`;
const slugB = `lr-b-${rid}`;
const admEmail = `lradm.${rid}@demo.bj`;     // administration (SANS sensitive_view)
const rhqEmail = `lrrhq.${rid}@demo.bj`;     // rôle rh-conges-q, sensitive_view, LIÉ à eRh (bénéficiaire exclu)
const rhq2Email = `lrrhq2.${rid}@demo.bj`;   // rôle rh-conges-q NEUTRE (vérificateur/approbateur)
const mgrEmail = `lrmgr.${rid}@demo.bj`;     // manager résolu (approbateur étape 0)
const selfEmail = `lrself.${rid}@demo.bj`;   // salarié e1 (ESS, + rétroactif)
const self2Email = `lrself2.${rid}@demo.bj`; // salarié e2 (ESS)
const selfAppEmail = `lrsapp.${rid}@demo.bj`;// salarié eSelfApp DÉTENTEUR du rôle approbateur (auto-approbation)
const nightEmail = `lrnight.${rid}@demo.bj`; // salarié eNight (rotation de nuit)
const nakedEmail = `lrnone.${rid}@demo.bj`;
const bAdmEmail = `lrbadm.${rid}@demo.bj`;

let app: INestApplication;
let base = '';
let tenantAId = '';
let tenantBId = '';
let coA = '', siteA = '', uRh = '', uIt = '';
let eMgr = '', e1 = '', e2 = '', eRh = '', eSelfApp = '', eNight = '', eOut = '';
let typeCap = '', typeMal = '', typeRec = '', typeHor = '';
let polCap = '';
let mgrUserId = '', rhqUserId = '', rhq2UserId = '';
// Identifiants partagés entre tests.
let reqE1Sept = '';        // demande CAP e1 (07–11/09), appliquée puis annulée par circuit
let reqMal = '';           // demande MAL confidentielle (justificatif sensible)
let malAttachment = '';
let reqRetro = '';         // demande rétroactive sur période close

async function seedUser(
  tenantId: string, email: string, perms: string[], tenantScope: boolean, roleKey?: string,
): Promise<string> {
  const h = await argon2.hash(P, { type: argon2.argon2id });
  const id = psql(`INSERT INTO admin.users (tenant_id, email, password_hash) VALUES ('${tenantId}','${email}','${h}') RETURNING id`);
  if (tenantScope) psql(`INSERT INTO admin.user_scopes (tenant_id, user_id, scope_type) VALUES ('${tenantId}','${id}','tenant')`);
  const role = psql(`INSERT INTO admin.roles (tenant_id, key, name) VALUES ('${tenantId}','${roleKey ?? `r-${email.split('@')[0]}`}','R') RETURNING id`);
  for (const p of perms) psql(`INSERT INTO admin.role_permissions (tenant_id, role_id, permission_key) VALUES ('${tenantId}','${role}','${p}')`);
  psql(`INSERT INTO admin.user_roles (tenant_id, user_id, role_id) VALUES ('${tenantId}','${id}','${role}')`);
  return id;
}

before(async () => {
  tenantAId = psql(`INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('${slugA}','LR A',true) RETURNING id`);
  tenantBId = psql(`INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('${slugB}','LR B',true) RETURNING id`);
  await seedUser(tenantAId, admEmail, [
    'leave.types_admin', 'leave.policies_admin', 'leave.accrual_run', 'leave.openings_import',
    'leave.balance_view', 'leave.ledger_view', 'leave.requests_admin', 'leave.request_for_others',
    'leave.calendar_view', 'leave.calendar_export',
    'org.view', 'org.manage', 'employees.view', 'employees.manage', 'employees.assign',
    'time.schedules_view', 'time.schedules_manage', 'time.schedules_assign',
    'workflow.manage', 'workflow.view', 'notify.manage', 'audit.view', 'parameters.view',
  ], true);
  rhqUserId = await seedUser(tenantAId, rhqEmail, [
    'leave.sensitive_view', 'leave.requests_admin', 'leave.calendar_view', 'leave.balance_view',
    'leave.request_self', 'leave.requests_view_own', 'workflow.view', 'workflow.act',
  ], true, 'rh-conges-q');
  rhq2UserId = await seedUser(tenantAId, rhq2Email, [
    'leave.attachments_verify', 'leave.requests_admin', 'workflow.view', 'workflow.act',
  ], true, 'rh-conges-q2');
  // rhq2 porte AUSSI le rôle approbateur rh-conges-q (multi-rôles).
  const roleQ = psql(`SELECT id FROM admin.roles WHERE tenant_id = '${tenantAId}' AND key = 'rh-conges-q'`);
  psql(`INSERT INTO admin.user_roles (tenant_id, user_id, role_id) VALUES ('${tenantAId}','${rhq2UserId}','${roleQ}')`);
  mgrUserId = await seedUser(tenantAId, mgrEmail, [
    'leave.requests_view_team', 'leave.request_for_others', 'leave.balance_view_team',
    'employees.view', 'workflow.view', 'workflow.act',
  ], false);
  await seedUser(tenantAId, selfEmail, [
    'leave.request_self', 'leave.requests_view_own', 'leave.balance_view_own', 'leave.request_retroactive',
  ], true);
  await seedUser(tenantAId, self2Email, ['leave.request_self', 'leave.requests_view_own', 'leave.balance_view_own'], true);
  await seedUser(tenantAId, selfAppEmail, [
    'leave.request_self', 'leave.requests_view_own', 'workflow.view', 'workflow.act',
  ], true, 'rh-conges-q-bis');
  // eSelfApp porte le rôle APPROBATEUR (test d'auto-approbation).
  psql(`INSERT INTO admin.user_roles (tenant_id, user_id, role_id)
        SELECT '${tenantAId}', u.id, '${roleQ}' FROM admin.users u WHERE u.email = '${selfAppEmail}'`);
  await seedUser(tenantAId, nightEmail, ['leave.request_self', 'leave.requests_view_own'], true);
  await seedUser(tenantAId, nakedEmail, ['employees.view'], true);
  await seedUser(tenantBId, bAdmEmail, ['leave.requests_admin', 'leave.request_self', 'leave.requests_view_own', 'leave.calendar_view'], true);

  // Paramètres E4 ACTIFS (fixtures contresignées de test) — résolus à la date du fait générateur.
  for (const [key, value, from] of [
    ['conges.acquisition.taux_mensuel', '2', '2020-01-01'],
    ['conges.ouvrables.jours', '[1,2,3,4,5,6]', '2020-01-01'],
    ['temps.fuseau.defaut', '"Africa/Porto-Novo"', '2020-01-01'],
    ['conges.demande.confirmation_salarie', '1', '2020-01-01'],
    ['conges.demande.delai_traitement_jours', '3', '2020-01-01'],
    ['conges.equipe.presence_minimale', '99', '2020-01-01'],
  ] as const) {
    psql(`INSERT INTO compliance.legal_parameters
            (tenant_id, country_code, key, value, effective_from, status, is_legal_sensitive,
             confidence, source_text, verified_by, verified_at)
          VALUES ('${tenantAId}', 'BJ', '${key}', '${value}', '${from}', 'active', false,
                  'verified', 'fixture e2e E11.2', 'fixture-e2e', '2026-01-01')`);
  }

  app = await createApp();
  await app.listen(0);
  const addr = app.getHttpServer().address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr !== null ? addr.port : 0}/api/v1`;
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
  if (res.status !== 201) assert.fail(`${path} → ${res.status} : ${await res.text().catch(() => '')}`);
  return ((await res.json()) as { id: string }).id;
}
async function getJson<T>(path: string, tok: string): Promise<T> {
  const res = await api(path, tok, undefined, 'GET');
  const text = await res.text();
  assert.equal(res.status, 200, `${path} → ${res.status} : ${text}`);
  return JSON.parse(text) as T;
}
async function postJson<T>(path: string, tok: string, body: unknown, expected = 200): Promise<T> {
  const res = await api(path, tok, body);
  const text = await res.text();
  assert.equal(res.status, expected, `${path} → ${res.status} : ${text}`);
  return (text.length > 0 ? JSON.parse(text) : {}) as T;
}
function ledgerCount(where: string): number {
  return Number(psql(`SELECT count(*) FROM leave.entitlement_ledger WHERE tenant_id = '${tenantAId}' AND ${where}`));
}
interface Preview {
  preview: {
    quantity: number; unit: string; blocking: boolean; available: number | null; afterAvailable: number | null;
    checks: Array<{ code: string; level: string; fr: string; en: string }>;
    circuit: string; detail: Array<{ date: string; counted: number; why: string }>;
  };
}
async function newDraft(tok: string, body: Record<string, unknown>): Promise<string> {
  const out = await postJson<{ id: string }>('/leave/requests', tok, body, 201);
  return out.id;
}

// ---------------------------------------------------------------------------

test('01 fixtures : organisation, salariés, horaires E10, circuits E3, modèles E5, droits acquis', async () => {
  const adm = await token(slugA, admEmail);
  coA = await created('/org/companies', adm, { code: `LRCO-${RID}`, labelFr: 'Société LR', labelEn: 'LR Co' });
  psql(`UPDATE org.companies SET status = 'active' WHERE id = '${coA}'`);
  siteA = await created('/org/sites', adm, { code: `LRSITE-${RID}`, labelFr: 'Site LR', labelEn: 'LR Site', companyId: coA });
  psql(`UPDATE org.sites SET status = 'active' WHERE id = '${siteA}'`);
  uRh = await created('/org/units', adm, { unitType: 'department', code: `LRRH-${RID}`, labelFr: 'Département RH', labelEn: 'HR', companyId: coA });
  uIt = await created('/org/units', adm, { unitType: 'department', code: `LRIT-${RID}`, labelFr: 'Département IT', labelEn: 'IT', companyId: coA });
  psql(`UPDATE org.units SET status = 'active' WHERE id IN ('${uRh}','${uIt}')`);

  const mk = async (mat: string, first: string, unit: string, hire: string, managerOverride?: string): Promise<string> => {
    const res = await api('/employees', adm, { matricule: mat, firstName: first, lastName: 'Demande', hireDate: hire });
    const text = await res.text();
    assert.equal(res.status, 201, text);
    const id = (JSON.parse(text) as { id: string }).id;
    psql(`UPDATE core.employees SET status = 'active' WHERE id = '${id}'`);
    const asg = await api(`/employees/${id}/assignments`, adm, {
      companyId: coA, siteId: siteA, unitId: unit, effectiveFrom: hire, isPrimary: true,
      ...(managerOverride ? { managerOverrideEmployeeId: managerOverride } : {}),
    });
    assert.equal(asg.status, 201, `affectation ${mat}`);
    return id;
  };
  eMgr = await mk(`LRM-${RID}`, 'Manou', uRh, '2024-01-01');
  e1 = await mk(`LR1-${RID}`, 'Awa', uRh, '2025-01-01', eMgr);
  e2 = await mk(`LR2-${RID}`, 'Bio', uIt, '2025-01-01', eMgr);
  eRh = await mk(`LRR-${RID}`, 'Reine', uRh, '2025-01-01', eMgr);
  eSelfApp = await mk(`LRA-${RID}`, 'Ayo', uRh, '2025-01-01', eMgr);
  eNight = await mk(`LRN-${RID}`, 'Noel', uIt, '2025-01-01', eMgr);
  eOut = await mk(`LRO-${RID}`, 'Ori', uIt, '2025-01-01');
  for (const [em, emp] of [
    [selfEmail, e1], [self2Email, e2], [rhqEmail, eRh], [selfAppEmail, eSelfApp],
    [nightEmail, eNight], [mgrEmail, eMgr],
  ] as const) {
    psql(`UPDATE core.employees SET user_id = (SELECT id FROM admin.users WHERE email = '${em}') WHERE id = '${emp}'`);
  }

  // Horaires : jour fixe lun–ven (08h–17h, pause 12–13) pour tous SAUF eNight (rotation nuit 22h–06h).
  const dayModel = await created('/time/schedules/models', adm, { code: `LRJ-${RID}`, labelFr: 'Jour LR', labelEn: 'LR Day', kind: 'fixed' });
  await postJson(`/time/schedules/models/${dayModel}/versions`, adm, {
    effectiveFrom: '2025-01-06', cycleDays: 7,
    days: [0, 1, 2, 3, 4].map((i) => ({ dayIndex: i, isRest: false, startMinute: 480, endMinute: 1020, breakStartMinute: 720, breakEndMinute: 780 }))
      .concat([{ dayIndex: 5, isRest: true }, { dayIndex: 6, isRest: true }] as never[]),
  }, 201);
  for (const emp of [e1, e2, eRh, eSelfApp, eOut, eMgr]) {
    await postJson('/time/schedules/assignments', adm, { employeeId: emp, modelId: dayModel, anchorDate: '2026-01-05', effectiveFrom: '2025-01-06' }, 201);
  }
  const nightModel = await created('/time/schedules/models', adm, { code: `LRNU-${RID}`, labelFr: 'Nuit LR', labelEn: 'LR Night', kind: 'rotation' });
  await postJson(`/time/schedules/models/${nightModel}/versions`, adm, {
    effectiveFrom: '2025-01-06', cycleDays: 4,
    days: [
      { dayIndex: 0, isRest: false, startMinute: 1320, endMinute: 1800 },
      { dayIndex: 1, isRest: false, startMinute: 1320, endMinute: 1800 },
      { dayIndex: 2, isRest: true }, { dayIndex: 3, isRest: true },
    ],
  }, 201);
  await postJson('/time/schedules/assignments', adm, { employeeId: eNight, modelId: nightModel, anchorDate: '2026-08-03', effectiveFrom: '2025-01-06' }, 201);
  // Férié : jeudi 10 septembre 2026.
  const cal = await created('/time/holidays/calendars', adm, { code: `LRFER-${RID}`, labelFr: 'Fériés LR', labelEn: 'LR Holidays' });
  psql(`UPDATE time.holiday_calendars SET status = 'active' WHERE id = '${cal}'`);
  psql(`INSERT INTO time.holidays (tenant_id, calendar_id, holiday_date, label_fr, label_en, status)
        VALUES ('${tenantAId}','${cal}','2026-09-10','Férié LR','LR holiday','active')`);

  // Circuits E3 : standard (manager → RH), sensible (RH seul), rétro (RH seul), annulation (RH seul).
  const mkCircuit = async (key: string, steps: unknown[]): Promise<void> => {
    const def = await api('/workflow/definitions', adm, { key, name: `Circuit ${key}`, steps });
    const defText = await def.text();
    assert.equal(def.status, 201, defText);
    assert.equal((await api(`/workflow/definitions/${(JSON.parse(defText) as { id: string }).id}/activate`, adm)).status, 200);
  };
  await mkCircuit('conges_demande', [
    // Étape manager CONDITIONNELLE : sautée proprement quand aucun responsable n'est résolu.
    { index: 0, name: 'Manager', approverType: 'manager', condition: { field: 'hasManager', op: 'eq', value: true } },
    { index: 1, name: 'RH congés', approverType: 'role', approverRef: 'rh-conges-q' },
  ]);
  await mkCircuit('conges_demande_sensible', [
    { index: 0, name: 'RH congés (sensible)', approverType: 'role', approverRef: 'rh-conges-q' },
  ]);
  await mkCircuit('conges_demande_retro', [
    { index: 0, name: 'RH congés (rétroactif)', approverType: 'role', approverRef: 'rh-conges-q' },
  ]);
  await mkCircuit('conges_annulation', [
    { index: 0, name: 'RH congés (annulation)', approverType: 'role', approverRef: 'rh-conges-q' },
  ]);

  // Modèles E5 (langue du destinataire ; AUCUNE donnée sensible dans les variables).
  for (const [key, vars] of [
    ['conges_demande_soumise', ['demande', 'version', 'type', 'debut', 'fin', 'quantite']],
    ['conges_demande_retour', ['demande', 'commentaire']],
    ['conges_demande_rejetee', ['demande']],
    ['conges_demande_annulee', ['demande']],
    ['conges_demande_appliquee', ['demande', 'quantite']],
    ['conges_demande_echec_application', ['demande', 'erreur']],
    ['conges_demande_expiree', ['demande', 'motif']],
    ['conges_annulation_decidee', ['demande', 'decision']],
  ] as const) {
    const tpl = await api('/admin/notify/templates', adm, {
      key, name: key, subjectFr: `${key} {{demande}}`, subjectEn: `${key} {{demande}}`,
      bodyFr: vars.map((v) => `{{${v}}}`).join(' · '), bodyEn: vars.map((v) => `{{${v}}}`).join(' · '),
      variables: [...vars], channels: ['in_app'], mandatory: false,
    });
    const tplText = await tpl.text();
    assert.equal(tpl.status, 201, tplText);
    assert.equal((await api(`/admin/notify/templates/${(JSON.parse(tplText) as { id: string }).id}/activate`, adm)).status, 200);
  }

  // Types : CAP (E4), MAL (confidentiel, justificatif requis, négatif permis, PAS de rétro),
  // REC (préavis/bornes), HOR (heures, négatif permis).
  typeCap = await created('/leave/types', adm, {
    code: 'CAP', labelFr: 'Congé annuel payé', labelEn: 'Paid annual leave',
    category: 'legal', paid: true, unit: 'open_days', retroactiveAllowed: true,
  });
  typeMal = await created('/leave/types', adm, {
    code: 'MAL', labelFr: 'Maladie', labelEn: 'Sickness', category: 'legal', paid: true,
    unit: 'calendar_days', confidential: true, justification: 'required', negativeAllowed: true,
  });
  typeRec = await created('/leave/types', adm, {
    code: 'REC', labelFr: 'Récupération', labelEn: 'Recovery', category: 'internal', paid: false, unit: 'open_days',
  });
  typeHor = await created('/leave/types', adm, {
    code: 'HOR', labelFr: 'Absence en heures', labelEn: 'Hourly leave', category: 'internal', paid: false,
    unit: 'hours', negativeAllowed: true,
  });
  for (const t of [typeCap, typeMal, typeRec, typeHor]) await postJson(`/leave/types/${t}`, adm, { status: 'active' });

  // Politiques : CAP (rythme E4, report 6) ; MAL (aucune acquisition) ; REC (préavis 10 j,
  // bloc min 1, max 3 par demande, valeur tenant) ; HOR (aucune acquisition).
  polCap = await created('/leave/policies', adm, {
    absenceTypeId: typeCap, code: 'POL-CAP', labelFr: 'Politique CAP', labelEn: 'CAP policy', countryCode: 'BJ',
  });
  await postJson(`/leave/policies/${polCap}/versions`, adm, {
    effectiveFrom: '2025-01-01', accrualMode: 'monthly', accrualRateParam: 'conges.acquisition.taux_mensuel',
    referencePeriod: 'calendar_year', rounding: 'half_up_0_5', carryOverMaxValue: 6,
  }, 201);
  await postJson(`/leave/policies/${polCap}/status`, adm, { status: 'active' });
  const polMal = await created('/leave/policies', adm, {
    absenceTypeId: typeMal, code: 'POL-MAL', labelFr: 'Politique MAL', labelEn: 'MAL policy', countryCode: 'BJ',
  });
  await postJson(`/leave/policies/${polMal}/versions`, adm, { effectiveFrom: '2025-01-01', accrualMode: 'none' }, 201);
  await postJson(`/leave/policies/${polMal}/status`, adm, { status: 'active' });
  const polRec = await created('/leave/policies', adm, {
    absenceTypeId: typeRec, code: 'POL-REC', labelFr: 'Politique REC', labelEn: 'REC policy',
  });
  await postJson(`/leave/policies/${polRec}/versions`, adm, {
    effectiveFrom: '2025-01-01', accrualMode: 'monthly', accrualRateValue: 2,
    noticeDays: 10, minBlock: 1, maxPerRequest: 3,
  }, 201);
  await postJson(`/leave/policies/${polRec}/status`, adm, { status: 'active' });
  const polHor = await created('/leave/policies', adm, {
    absenceTypeId: typeHor, code: 'POL-HOR', labelFr: 'Politique HOR', labelEn: 'HOR policy',
  });
  await postJson(`/leave/policies/${polHor}/versions`, adm, { effectiveFrom: '2025-01-01', accrualMode: 'none' }, 201);
  await postJson(`/leave/policies/${polHor}/status`, adm, { status: 'active' });

  // Droits acquis janvier–juin 2026 : CAP 12 j (6 × 2 j E4) et REC 12 j par salarié actif.
  const run = await postJson<{ run: { status: string } }>('/leave/accrual/run', adm, {
    periodStart: '2026-01-01', periodEnd: '2026-06-30', scopeKind: 'tenant',
    reason: 'acquisition S1 (fixture E11.2)',
  }, 201);
  assert.match(run.run.status, /^completed/);
  const bal = await getJson<{ items: Array<{ typeCode: string; available: number | string }> }>(
    `/leave/balances?employeeId=${e1}&typeId=${typeCap}`, adm);
  assert.equal(Number(bal.items[0]?.available), 12, 'e1 dispose de 12 j CAP acquis');
});

test('02 brouillon + prévisualisation : décompte E10 réel (férié exclu), solde avant/après, rien n\'est écrit au ledger', async () => {
  const self = await token(slugA, selfEmail);
  reqE1Sept = await newDraft(self, {
    typeId: typeCap, startDate: '2026-09-07', endDate: '2026-09-11', comment: 'congés de septembre',
  });
  const p1 = await getJson<Preview>(`/leave/requests/preview/${reqE1Sept}`, self);
  assert.equal(p1.preview.quantity, 4, 'lun–ven avec férié le jeudi 10/09 ⇒ 4 jours ouvrés');
  assert.equal(p1.preview.blocking, false);
  assert.equal(p1.preview.available, 12);
  assert.equal(p1.preview.afterAvailable, 8);
  assert.equal(p1.preview.circuit, 'conges_demande');
  const holidayDay = p1.preview.detail.find((d) => d.date === '2026-09-10');
  assert.ok(holidayDay && holidayDay.counted === 0 && /férié/i.test(holidayDay.why), 'le férié s\'explique');
  // Modification du brouillon : recalcul immédiat.
  await postJson(`/leave/requests/${reqE1Sept}`, self, { endDate: '2026-09-09' });
  const p2 = await getJson<Preview>(`/leave/requests/preview/${reqE1Sept}`, self);
  assert.equal(p2.preview.quantity, 3);
  await postJson(`/leave/requests/${reqE1Sept}`, self, { endDate: '2026-09-11' });
  // AUCUNE écriture au ledger tant que rien n'est soumis.
  assert.equal(ledgerCount(`request_id = '${reqE1Sept}'`), 0);
  // Brouillon visible dans « mes demandes » ; audité.
  const mine = await getJson<{ items: Array<{ id: string; status: string }> }>('/leave/requests/mine', self);
  assert.ok(mine.items.some((i) => i.id === reqE1Sept && i.status === 'draft'));
  assert.equal(Number(psql(`SELECT count(*) FROM audit.audit_log WHERE tenant_id = '${tenantAId}'
    AND action = 'leave_request_draft_updated' AND record_id = '${reqE1Sept}'`)) >= 2, true);
});

test('03 contrôles de soumission : préavis, bornes, demi-journée, justificatif — erreurs LOCALISÉES FR/EN', async () => {
  const self = await token(slugA, selfEmail);
  const today = new Date();
  const soon = new Date(today.getTime() + 2 * 86_400_000).toISOString().slice(0, 10);
  // Préavis REC = 10 jours : demande à J+2 refusée, erreur exacte et localisée.
  const recSoon = await newDraft(self, { typeId: typeRec, startDate: soon, endDate: soon });
  const pv = await getJson<Preview>(`/leave/requests/preview/${recSoon}`, self);
  const notice = pv.preview.checks.find((c) => c.code === 'notice_days');
  assert.ok(notice && notice.level === 'error');
  assert.match(notice!.fr, /préavis/i);
  assert.match(notice!.en, /notice/i);
  const refuse = await api(`/leave/requests/${recSoon}/submit`, self);
  const refuseText = await refuse.text();
  assert.equal(refuse.status, 400, refuseText);
  assert.match(refuseText, /notice_days/);
  // Bornes : 4 jours ouvrés > max 3 par demande ; demi-journée interdite (bloc min 1).
  const recLong = await newDraft(self, { typeId: typeRec, startDate: '2026-10-19', endDate: '2026-10-22' });
  const pvLong = await getJson<Preview>(`/leave/requests/preview/${recLong}`, self);
  assert.ok(pvLong.preview.checks.some((c) => c.code === 'max_per_request' && c.level === 'error'));
  const recHalf = await newDraft(self, { typeId: typeRec, startDate: '2026-10-19', endDate: '2026-10-19', halfDayStart: true });
  const pvHalf = await getJson<Preview>(`/leave/requests/preview/${recHalf}`, self);
  const codes = pvHalf.preview.checks.map((c) => c.code);
  assert.ok(codes.includes('half_day_not_allowed') && codes.includes('min_block'), String(codes));
  // Justificatif MAL requis : refus sans pièce, accepté avec (circuit SENSIBLE).
  reqMal = await newDraft(self, { typeId: typeMal, startDate: '2026-09-21', endDate: '2026-09-23', comment: 'détail médical PRIVÉ' });
  const pvMal = await getJson<Preview>(`/leave/requests/preview/${reqMal}`, self);
  assert.ok(pvMal.preview.checks.some((c) => c.code === 'justification_required' && c.level === 'error'));
  assert.equal(pvMal.preview.circuit, 'conges_demande_sensible');
  const att = await postJson<{ id: string }>(`/leave/requests/${reqMal}/attachments`, self, {
    filename: 'certificat.pdf', mime: 'application/pdf',
    contentBase64: Buffer.from(`%PDF-certificat-${rid}`).toString('base64'),
  }, 201);
  malAttachment = att.id;
  assert.equal(psql(`SELECT sensitive FROM leave.request_attachments WHERE id = '${malAttachment}'`), 't',
    'pièce d\'un type confidentiel : SENSIBLE d\'office');
  const sub = await postJson<{ version: number }>(`/leave/requests/${reqMal}/submit`, self, undefined);
  assert.equal(sub.version, 1);
});

test('04 soumission : version FIGÉE par la base, réservation idempotente, solde acquis INCHANGÉ', async () => {
  const self = await token(slugA, selfEmail);
  const out = await postJson<{ instanceId: string; version: number; quantity: number }>(
    `/leave/requests/${reqE1Sept}/submit`, self, undefined);
  assert.equal(out.version, 1);
  assert.equal(out.quantity, 4);
  // Réservation : UN mouvement, lié à la demande et à la version.
  assert.equal(ledgerCount(`request_id = '${reqE1Sept}' AND entry_kind = 'reservation'`), 1);
  const adm = await token(slugA, admEmail);
  const bal = await getJson<{ items: Array<{ accrued: unknown; reserved: unknown; available: unknown }> }>(
    `/leave/balances?employeeId=${e1}&typeId=${typeCap}`, adm);
  assert.equal(Number(bal.items[0]!.accrued), 12, 'le droit ACQUIS ne bouge jamais à la soumission');
  assert.equal(Number(bal.items[0]!.reserved), 4);
  assert.equal(Number(bal.items[0]!.available), 8);
  // Contenu FIGÉ : brouillon verrouillé (API 409) ET version immuable (base).
  const locked = await api(`/leave/requests/${reqE1Sept}`, self, { endDate: '2026-09-25' });
  assert.equal(locked.status, 409);
  assert.equal(psqlFails(`UPDATE leave.request_versions SET quantity = 99
    WHERE request_id = '${reqE1Sept}' AND version = 1`), true, 'version soumise IMMUABLE par la base');
  // La décision est liée à la version : l'instance E3 porte version 1.
  assert.equal(psql(`SELECT context->>'requestVersion' FROM workflow.instances WHERE id =
    (SELECT workflow_instance_id FROM leave.requests WHERE id = '${reqE1Sept}')`), '1');
});

test('05 concurrence : double soumission INERTE ; deux demandes SIMULTANÉES sur le même solde ne surconsomment JAMAIS', async () => {
  const self2 = await token(slugA, self2Email);
  const night = await token(slugA, nightEmail);
  // (a) Double soumission de la MÊME demande : une seule passe, UNE seule réservation.
  const rA = await newDraft(self2, { typeId: typeCap, startDate: '2026-09-28', endDate: '2026-10-02' }); // 5 j ouvrés
  const twice = await Promise.all([
    api(`/leave/requests/${rA}/submit`, self2),
    api(`/leave/requests/${rA}/submit`, self2),
  ]);
  const statuses = twice.map((r) => r.status).sort();
  assert.equal(statuses.filter((s) => s === 200).length, 1, `double soumission : ${statuses.join(',')}`);
  assert.equal(ledgerCount(`request_id = '${rA}' AND entry_kind = 'reservation'`), 1, 'UNE réservation');
  // (b) Deux demandes de 8 nuits chacune, soumises EN MÊME TEMPS, pour 12 j disponibles (eNight) :
  // le verrou par (salarié, type) sérialise, la seconde CONSTATE le disponible déjà réservé.
  const rB = await newDraft(night, { typeId: typeCap, startDate: '2026-10-05', endDate: '2026-10-20' }); // 8 nuits
  const rC = await newDraft(night, { typeId: typeCap, startDate: '2026-11-02', endDate: '2026-11-17' }); // 8 nuits
  const race = await Promise.all([
    api(`/leave/requests/${rB}/submit`, night),
    api(`/leave/requests/${rC}/submit`, night),
  ]);
  const texts = await Promise.all(race.map((r) => r.text()));
  const oks = race.filter((r) => r.status === 200).length;
  assert.equal(oks, 1, `une SEULE des deux passe : ${race.map((r) => r.status).join(',')} — ${texts.join(' | ')}`);
  const refusedText = texts[race[0]!.status === 200 ? 1 : 0]!;
  assert.match(refusedText, /balance_insufficient/, 'refus EXPLICITE et chiffré, sous verrou');
  assert.equal(
    ledgerCount(`request_id IN ('${rB}','${rC}') AND entry_kind = 'reservation'`), 1,
    'jamais deux réservations sur le même droit');
  // La demande refusée n'a produit AUCUN mouvement ni AUCUNE notification (rien avant commit réel).
  const refusedId = race[0]!.status === 200 ? rC : rB;
  assert.equal(ledgerCount(`request_id = '${refusedId}'`), 0);
  assert.equal(psql(`SELECT count(*) FROM notify.events WHERE tenant_id = '${tenantAId}'
    AND event_key LIKE 'conges-demande-soumise-${refusedId}%'`), '0');
  // Nettoyage : retraits (libération DISTINCTE, jamais une suppression).
  await postJson(`/leave/requests/${rA}/withdraw`, self2, undefined);
  const winnerId = refusedId === rB ? rC : rB;
  await postJson(`/leave/requests/${winnerId}/withdraw`, night, undefined);
  assert.equal(ledgerCount(`request_id = '${rA}' AND entry_kind = 'release'`), 1, 'retrait ⇒ libération');
});

test('06 circuit manager → RH : instruction, approbation liée à la version, application (consommation + libération)', async () => {
  const mgr = await token(slugA, mgrEmail);
  const rhq2 = await token(slugA, rhq2Email);
  // Étape 0 (manager) : approbation ⇒ la demande passe en INSTRUCTION.
  const step0 = await postJson<{ status: string }>(`/leave/requests/${reqE1Sept}/decide`, mgr, { action: 'approve' });
  assert.equal(step0.status, 'in_review');
  // Étape 1 (RH) : approbation FINALE ⇒ application immédiate hors décision.
  const step1 = await postJson<{ status: string; applied?: boolean }>(
    `/leave/requests/${reqE1Sept}/decide`, rhq2, { action: 'approve' });
  assert.equal(step1.status, 'approved');
  assert.equal(step1.applied, true);
  assert.equal(psql(`SELECT status FROM leave.requests WHERE id = '${reqE1Sept}'`), 'applied');
  // Absence opposable : UNE par version, impact présence DIFFÉRÉ (E11.3), politique et paramètres CONSERVÉS.
  const abs = psql(`SELECT status || '|' || presence_impact || '|' || quantity || '|' || (policy_version IS NOT NULL)
    FROM leave.absences WHERE request_id = '${reqE1Sept}' AND request_version = 1`);
  assert.equal(abs, 'approved|deferred|4.000|t');
  // Ledger : consommation 4 + libération de la réservation — le solde est une SOMME, jamais une retouche.
  assert.equal(ledgerCount(`request_id = '${reqE1Sept}' AND entry_kind = 'consumption'`), 1);
  assert.equal(ledgerCount(`request_id = '${reqE1Sept}' AND entry_kind = 'release'`), 1);
  const adm = await token(slugA, admEmail);
  const bal = await getJson<{ items: Array<{ accrued: unknown; reserved: unknown; consumed: unknown; available: unknown }> }>(
    `/leave/balances?employeeId=${e1}&typeId=${typeCap}`, adm);
  assert.equal(Number(bal.items[0]!.accrued), 12);
  assert.equal(Number(bal.items[0]!.reserved), 0, 'réservation neutralisée');
  assert.equal(Number(bal.items[0]!.consumed), 4);
  assert.equal(Number(bal.items[0]!.available), 8);
});

test('07 séparation des tâches : auto-approbation interdite, bénéficiaire EXCLU, délégation E3, confirmation du salarié', async () => {
  const selfApp = await token(slugA, selfAppEmail);
  const mgr = await token(slugA, mgrEmail);
  const rhq = await token(slugA, rhqEmail);
  const rhq2 = await token(slugA, rhq2Email);
  // (a) Un salarié DÉTENTEUR du rôle approbateur ne s'auto-approuve pas.
  const own = await newDraft(selfApp, { typeId: typeCap, startDate: '2026-10-12', endDate: '2026-10-13' });
  await postJson(`/leave/requests/${own}/submit`, selfApp, undefined);
  await postJson(`/leave/requests/${own}/decide`, mgr, { action: 'approve' }); // étape manager franchie
  const selfDecide = await api(`/leave/requests/${own}/decide`, selfApp, { action: 'approve' });
  const selfDecideText = await selfDecide.text();
  assert.equal(selfDecide.status, 403, selfDecideText);
  assert.match(selfDecideText, /auto-approbation|séparation/i);
  await postJson(`/leave/requests/${own}/decide`, rhq2, { action: 'approve' }); // un TIERS décide
  // (b) Demande POUR UN TIERS : motif obligatoire, confirmation exigée (E4=1), auteur exclu, BÉNÉFICIAIRE exclu.
  const noReason = await api('/leave/requests', mgr, {
    employeeId: eRh, typeId: typeCap, startDate: '2026-10-19', endDate: '2026-10-20',
  });
  assert.equal(noReason.status, 400, 'motif obligatoire pour un tiers');
  const forRh = await postJson<{ id: string; onBehalf: boolean }>('/leave/requests', mgr, {
    employeeId: eRh, typeId: typeCap, startDate: '2026-10-19', endDate: '2026-10-20',
    onBehalfReason: 'salarié sans poste de travail',
  }, 201);
  assert.equal(forRh.onBehalf, true);
  // Sans confirmation du salarié : soumission BLOQUÉE (contrôle explicite).
  const unconfirmed = await api(`/leave/requests/${forRh.id}/submit`, mgr);
  const unconfirmedText = await unconfirmed.text();
  assert.equal(unconfirmed.status, 400, unconfirmedText);
  assert.match(unconfirmedText, /confirmation_missing/);
  // Seul le BÉNÉFICIAIRE confirme.
  assert.equal((await api(`/leave/requests/${forRh.id}/confirm`, mgr)).status, 403);
  await postJson(`/leave/requests/${forRh.id}/confirm`, rhq, undefined);
  await postJson(`/leave/requests/${forRh.id}/submit`, mgr, undefined);
  // Étape 0 = manager… qui est aussi l'AUTEUR : séparation des tâches ⇒ 403 ; il DÉLÈGUE (E3).
  const creatorDecide = await api(`/leave/requests/${forRh.id}/decide`, mgr, { action: 'approve' });
  assert.equal(creatorDecide.status, 403);
  const instanceId = psql(`SELECT workflow_instance_id FROM leave.requests WHERE id = '${forRh.id}'`);
  await postJson(`/workflow/instances/${instanceId}/delegate`, mgr, { toUserId: rhq2UserId });
  await postJson(`/leave/requests/${forRh.id}/decide`, rhq2, { action: 'approve' }); // étape 0 déléguée
  // Étape 1 (rôle RH) : le BÉNÉFICIAIRE détient le rôle… et reste exclu de SA décision.
  const benefDecide = await api(`/leave/requests/${forRh.id}/decide`, rhq, { action: 'approve' });
  const benefText = await benefDecide.text();
  assert.equal(benefDecide.status, 403, benefText);
  assert.match(benefText, /bénéficiaire|séparation/i);
  await postJson(`/leave/requests/${forRh.id}/decide`, rhq2, { action: 'approve' });
  // Traçabilité de la demande pour tiers : auteur, motif, permission, source, confirmation.
  const trace = psql(`SELECT on_behalf || '|' || on_behalf_permission || '|' || source || '|' || (employee_confirmed_at IS NOT NULL)
    FROM leave.requests WHERE id = '${forRh.id}'`);
  assert.equal(trace, 't|leave.request_for_others|manager|t');
});

test('08 rejet, retrait et RETOUR : libérations distinctes, resoumission versionnée, décision sur la version EXACTE', async () => {
  const self2 = await token(slugA, self2Email);
  const mgr = await token(slugA, mgrEmail);
  const rhq2 = await token(slugA, rhq2Email);
  // (a) Rejet : mouvement release, aucun débit.
  const rej = await newDraft(self2, { typeId: typeCap, startDate: '2026-11-16', endDate: '2026-11-17' });
  await postJson(`/leave/requests/${rej}/submit`, self2, undefined);
  await postJson(`/leave/requests/${rej}/decide`, mgr, { action: 'approve' });
  await postJson(`/leave/requests/${rej}/decide`, rhq2, { action: 'reject', comment: 'planning chargé' });
  assert.equal(psql(`SELECT status FROM leave.requests WHERE id = '${rej}'`), 'rejected');
  assert.equal(ledgerCount(`request_id = '${rej}' AND entry_kind = 'release'`), 1);
  assert.equal(ledgerCount(`request_id = '${rej}' AND entry_kind = 'consumption'`), 0);
  // (b) Retour pour complément ⇒ resoumission = VERSION 2 ; l'histoire v1 DEMEURE.
  const ret = await newDraft(self2, { typeId: typeCap, startDate: '2026-11-23', endDate: '2026-11-24' });
  await postJson(`/leave/requests/${ret}/submit`, self2, undefined);
  const returned = await postJson<{ status: string }>(`/leave/requests/${ret}/decide`, mgr,
    { action: 'return', comment: 'préciser le motif' });
  assert.equal(returned.status, 'returned');
  assert.equal(psql(`SELECT status FROM leave.requests WHERE id = '${ret}'`), 'returned');
  await postJson(`/leave/requests/${ret}`, self2, { endDate: '2026-11-25', comment: 'précision apportée' });
  const resub = await postJson<{ version: number }>(`/leave/requests/${ret}/submit`, self2, undefined);
  assert.equal(resub.version, 2);
  assert.equal(psql(`SELECT count(*) FROM leave.request_versions WHERE request_id = '${ret}'`), '2');
  // Réservations : v1 LIBÉRÉE (supplantée), v2 posée — l'une n'écrase jamais l'autre.
  assert.equal(ledgerCount(`request_id = '${ret}' AND entry_kind = 'reservation'`), 2);
  assert.equal(ledgerCount(`request_id = '${ret}' AND entry_kind = 'release' AND reason LIKE '%superseded%'`), 1);
  // La décision porte la version 2.
  assert.equal(psql(`SELECT context->>'requestVersion' FROM workflow.instances WHERE id =
    (SELECT workflow_instance_id FROM leave.requests WHERE id = '${ret}')`), '2');
  await postJson(`/leave/requests/${ret}/decide`, mgr, { action: 'approve' });
  await postJson(`/leave/requests/${ret}/decide`, rhq2, { action: 'approve' });
  assert.equal(psql(`SELECT request_version FROM leave.absences WHERE request_id = '${ret}'`), '2');
});

test('09 décisions simultanées : approbation/rejet et double approbation — UNE seule transition, UNE seule consommation', async () => {
  const self2 = await token(slugA, self2Email);
  const mgr = await token(slugA, mgrEmail);
  const rhq2 = await token(slugA, rhq2Email);
  const r = await newDraft(self2, { typeId: typeCap, startDate: '2026-12-07', endDate: '2026-12-08' });
  await postJson(`/leave/requests/${r}/submit`, self2, undefined);
  // approve et reject SIMULTANÉS à l'étape manager : un seul passe (garde optimiste E3).
  const race1 = await Promise.all([
    api(`/leave/requests/${r}/decide`, mgr, { action: 'approve' }),
    api(`/leave/requests/${r}/decide`, mgr, { action: 'reject' }),
  ]);
  const s1 = race1.map((x) => x.status).sort();
  assert.equal(s1.filter((s) => s === 200).length, 1, `une seule transition : ${s1.join(',')}`);
  // Si l'approbation a gagné : double approbation FINALE simultanée ⇒ une seule application.
  const st = psql(`SELECT status FROM leave.requests WHERE id = '${r}'`);
  if (st === 'in_review') {
    const race2 = await Promise.all([
      api(`/leave/requests/${r}/decide`, rhq2, { action: 'approve' }),
      api(`/leave/requests/${r}/decide`, rhq2, { action: 'approve' }),
    ]);
    const s2 = race2.map((x) => x.status).sort();
    assert.equal(s2.filter((s) => s === 200).length, 1, `double approbation : ${s2.join(',')}`);
    assert.equal(ledgerCount(`request_id = '${r}' AND entry_kind = 'consumption'`), 1, 'UNE consommation');
    assert.equal(psql(`SELECT count(*) FROM leave.absences WHERE request_id = '${r}'`), '1');
  } else {
    // Le rejet a gagné : libération unique, aucun débit — invariant équivalent.
    assert.equal(st, 'rejected');
    assert.equal(ledgerCount(`request_id = '${r}' AND entry_kind = 'consumption'`), 0);
    assert.equal(ledgerCount(`request_id = '${r}' AND entry_kind = 'release'`), 1);
  }
});

test('10 décompte : rotation de NUIT sur SA journée, décompte nul bloquant, demi-journée CAP, volume d\'heures borné', async () => {
  const night = await token(slugA, nightEmail);
  const self = await token(slugA, selfEmail);
  // Rotation 4 j ancrée 03/08/2026 : 03–04 travaillés (nuit), 05–06 repos.
  const rn = await newDraft(night, { typeId: typeCap, startDate: '2026-08-31', endDate: '2026-09-01' });
  const pn = await getJson<Preview>(`/leave/requests/preview/${rn}`, night);
  assert.equal(pn.preview.quantity, 2, 'deux nuits travaillées = 2 jours ouvrés décomptés');
  const rr = await newDraft(night, { typeId: typeCap, startDate: '2026-09-02', endDate: '2026-09-03' });
  const pr = await getJson<Preview>(`/leave/requests/preview/${rr}`, night);
  assert.equal(pr.preview.quantity, 0, 'jours de repos de la rotation : rien à décompter');
  assert.ok(pr.preview.checks.some((c) => c.code === 'quantity_zero' && c.level === 'error'));
  // Demi-journée CAP (bloc min non contraint) : 0,5 j.
  const half = await newDraft(self, { typeId: typeCap, startDate: '2026-09-14', endDate: '2026-09-14', halfDayStart: true });
  const ph = await getJson<Preview>(`/leave/requests/preview/${half}`, self);
  assert.equal(ph.preview.quantity, 0.5);
  // Heures : bornées par la journée PLANIFIÉE (8 h planifiées ce lundi).
  const hOk = await newDraft(self, { typeId: typeHor, startDate: '2026-09-14', endDate: '2026-09-14', hours: 4 });
  const pOk = await getJson<Preview>(`/leave/requests/preview/${hOk}`, self);
  assert.equal(pOk.preview.quantity, 4);
  assert.equal(pOk.preview.blocking, false);
  const hKo = await newDraft(self, { typeId: typeHor, startDate: '2026-09-14', endDate: '2026-09-14', hours: 9 });
  const pKo = await getJson<Preview>(`/leave/requests/preview/${hKo}`, self);
  assert.ok(pKo.preview.checks.some((c) => c.code === 'hours_bounds' && c.level === 'error'));
});

test('11 politique FUTURE : une nouvelle version datée ne touche NI l\'absence appliquée NI sa version soumise', async () => {
  const adm = await token(slugA, admEmail);
  const before11 = psql(`SELECT quantity || '|' || policy_version FROM leave.absences WHERE request_id = '${reqE1Sept}'`);
  await postJson(`/leave/policies/${polCap}/versions`, adm, {
    effectiveFrom: '2026-11-01', accrualMode: 'monthly', accrualRateValue: 3,
    referencePeriod: 'calendar_year', rounding: 'half_up_0_5', carryOverMaxValue: 6,
  }, 201);
  // L'histoire ne bouge pas : absence et version soumise INCHANGÉES.
  assert.equal(psql(`SELECT quantity || '|' || policy_version FROM leave.absences WHERE request_id = '${reqE1Sept}'`), before11);
  // Une NOUVELLE demande postérieure au 01/11 résout la version 2.
  const self = await token(slugA, selfEmail);
  const dec = await newDraft(self, { typeId: typeCap, startDate: '2026-12-14', endDate: '2026-12-15' });
  await postJson(`/leave/requests/${dec}/submit`, self, undefined);
  assert.equal(psql(`SELECT policy_version FROM leave.request_versions WHERE request_id = '${dec}' AND version = 1`), '2');
  await postJson(`/leave/requests/${dec}/withdraw`, self, undefined);
});

test('12 rétroactif sur période CLOSE : constat EXPLICITE, circuit dédié, AUCUN impact automatique sur la clôture E10', async () => {
  const self = await token(slugA, selfEmail);
  const self2 = await token(slugA, self2Email);
  const rhq2 = await token(slugA, rhq2Email);
  // Période de présence de juillet 2026 CLOSE (périmètre tenant).
  psql(`INSERT INTO time.periods (tenant_id, scope_kind, label, period_start, period_end, status, created_by)
        VALUES ('${tenantAId}','tenant','Juillet 2026','2026-07-01','2026-07-31','closed',
                (SELECT id FROM admin.users WHERE email = '${admEmail}'))`);
  // MAL n'autorise pas le rétroactif : erreur DÉDIÉE.
  const malRetro = await newDraft(self2, { typeId: typeMal, startDate: '2026-07-06', endDate: '2026-07-07', comment: 'x' });
  const pvMalRetro = await getJson<Preview>(`/leave/requests/preview/${malRetro}`, self2);
  assert.ok(pvMalRetro.preview.checks.some((c) => c.code === 'retroactive_forbidden'));
  // e2 n'a PAS la permission rétroactive : erreur explicite.
  const noPerm = await newDraft(self2, { typeId: typeCap, startDate: '2026-07-06', endDate: '2026-07-07', comment: 'motif' });
  const pvNoPerm = await getJson<Preview>(`/leave/requests/preview/${noPerm}`, self2);
  assert.ok(pvNoPerm.preview.checks.some((c) => c.code === 'retroactive_permission' && c.level === 'error'));
  // e1 (permission dédiée) : avertissement période close + circuit RENFORCÉ + motif obligatoire.
  reqRetro = await newDraft(self, { typeId: typeCap, startDate: '2026-07-06', endDate: '2026-07-07', comment: 'régularisation constatée' });
  const pv = await getJson<Preview>(`/leave/requests/preview/${reqRetro}`, self);
  assert.equal(pv.preview.circuit, 'conges_demande_retro');
  const closedCheck = pv.preview.checks.find((c) => c.code === 'closed_period');
  assert.ok(closedCheck && closedCheck.level === 'warning', 'période close = CONSTAT, pas un blocage silencieux');
  const dayResultsBefore = psql(`SELECT count(*) FROM time.day_results WHERE tenant_id = '${tenantAId}'`);
  await postJson(`/leave/requests/${reqRetro}/submit`, self, undefined);
  await postJson(`/leave/requests/${reqRetro}/decide`, rhq2, { action: 'approve' });
  // L'absence EXISTE (impact présence DIFFÉRÉ) ; la clôture E10 n'a pas bougé d'un octet.
  assert.equal(psql(`SELECT status || '|' || presence_impact FROM leave.absences WHERE request_id = '${reqRetro}'`), 'approved|deferred');
  assert.equal(psql(`SELECT status FROM time.periods WHERE tenant_id = '${tenantAId}' AND label = 'Juillet 2026'`), 'closed');
  assert.equal(psql(`SELECT count(*) FROM time.day_results WHERE tenant_id = '${tenantAId}'`), dayResultsBefore);
  // La version soumise CONSERVE le constat (opposable).
  assert.equal(psql(`SELECT checks::text LIKE '%closed_period%' FROM leave.request_versions
    WHERE request_id = '${reqRetro}' AND version = 1`), 't');
});

test('13 échec d\'application : approbation CONSERVÉE, aucun débit partiel, reprise IDEMPOTENTE', async () => {
  const self2 = await token(slugA, self2Email);
  const mgr = await token(slugA, mgrEmail);
  const rhq2 = await token(slugA, rhq2Email);
  const r = await newDraft(self2, { typeId: typeCap, startDate: '2026-12-21', endDate: '2026-12-22' });
  await postJson(`/leave/requests/${r}/submit`, self2, undefined);
  await postJson(`/leave/requests/${r}/decide`, mgr, { action: 'approve' });
  // Obstacle RÉEL : une absence approuvée existante chevauche (héritage hors circuit).
  psql(`INSERT INTO leave.absences (tenant_id, employee_id, absence_type_id, request_id, request_version,
          start_date, end_date, quantity, unit, applied_by)
        SELECT '${tenantAId}', '${e2}', '${typeRec}', r2.id, 99, '2026-12-22', '2026-12-23', 2, 'open_days',
               (SELECT id FROM admin.users WHERE email = '${admEmail}')
          FROM leave.requests r2 WHERE r2.id = '${r}'`);
  const decided = await postJson<{ status: string; applied?: boolean; applicationError?: string | null }>(
    `/leave/requests/${r}/decide`, rhq2, { action: 'approve' });
  assert.equal(decided.status, 'approved');
  assert.equal(decided.applied, false, 'application en échec, décision CONSERVÉE');
  assert.equal(psql(`SELECT status FROM leave.requests WHERE id = '${r}'`), 'application_failed');
  assert.equal(ledgerCount(`request_id = '${r}' AND entry_kind = 'consumption'`), 0, 'AUCUNE consommation partielle');
  // Rejeu de la reprise SANS lever l'obstacle : même constat, toujours zéro débit.
  const retry1 = await api(`/leave/requests/${r}/apply`, self2);
  assert.equal(retry1.status, 409);
  assert.equal(ledgerCount(`request_id = '${r}' AND entry_kind = 'consumption'`), 0);
  // Obstacle levé (annulation MOTIVÉE de l'absence héritée) ⇒ reprise APPLIQUE, une seule fois.
  psql(`UPDATE leave.absences SET status = 'cancelled', cancelled_at = now(),
         cancel_reason = 'héritage corrigé (test)' WHERE request_id = '${r}' AND request_version = 99`);
  await postJson(`/leave/requests/${r}/apply`, self2, undefined);
  await postJson(`/leave/requests/${r}/apply`, self2, undefined); // rejeu : inerte
  assert.equal(psql(`SELECT status FROM leave.requests WHERE id = '${r}'`), 'applied');
  assert.equal(ledgerCount(`request_id = '${r}' AND entry_kind = 'consumption'`), 1, 'UNE consommation après reprise');
  assert.equal(psql(`SELECT count(*) FROM leave.absences WHERE request_id = '${r}' AND request_version <> 99`), '1');
});

test('14 annulation APRÈS application : circuit distinct, reversement RÉFÉRENCÉ, solde restauré, histoire intacte', async () => {
  const self = await token(slugA, selfEmail);
  const rhq2 = await token(slugA, rhq2Email);
  const adm = await token(slugA, admEmail);
  const balBefore = await getJson<{ items: Array<{ available: unknown; consumed: unknown }> }>(
    `/leave/balances?employeeId=${e1}&typeId=${typeCap}`, adm);
  const availBefore = Number(balBefore.items[0]!.available);
  const out = await postJson<{ instanceId: string }>(`/leave/requests/${reqE1Sept}/cancel-approved`, self,
    { reason: 'projet annulé' });
  assert.ok(out.instanceId);
  // Double ouverture du circuit : refusée.
  assert.equal((await api(`/leave/requests/${reqE1Sept}/cancel-approved`, self, { reason: 'bis' })).status, 409);
  // La décision du circuit d'annulation passe par la route E3 générique (subject leave_request_cancel).
  const res = await api(`/workflow/instances/${out.instanceId}/approve`, rhq2, {});
  const resText = await res.text();
  assert.equal(res.status, 200, resText);
  assert.equal(psql(`SELECT status FROM leave.requests WHERE id = '${reqE1Sept}'`), 'cancelled');
  assert.equal(psql(`SELECT status FROM leave.absences WHERE request_id = '${reqE1Sept}' AND request_version = 1`), 'cancelled');
  // Reversement : mouvement RÉFÉRENCÉ vers la consommation — jamais une suppression.
  assert.equal(ledgerCount(`request_id = '${reqE1Sept}' AND entry_kind = 'reversal' AND reversal_of IS NOT NULL`), 1);
  assert.equal(ledgerCount(`request_id = '${reqE1Sept}' AND entry_kind = 'consumption'`), 1, 'la consommation DEMEURE');
  const balAfter = await getJson<{ items: Array<{ available: unknown }> }>(
    `/leave/balances?employeeId=${e1}&typeId=${typeCap}`, adm);
  assert.equal(Number(balAfter.items[0]!.available), availBefore + 4, 'solde restauré par MOUVEMENT');
});

test('15 confidentialité : type générique en équipe, motifs masqués, pièce sensible cloisonnée, secret ABSENT de l\'audit', async () => {
  const mgr = await token(slugA, mgrEmail);
  const rhq = await token(slugA, rhqEmail);
  const rhq2 = await token(slugA, rhq2Email);
  const self = await token(slugA, selfEmail);
  // File d'équipe du manager : la demande MAL apparaît SANS code ni motif.
  const team = await getJson<{ items: Array<Record<string, unknown>> }>('/leave/requests/team', mgr);
  const malRow = team.items.find((i) => i['id'] === reqMal);
  assert.ok(malRow, 'le manager VOIT la demande (période, durée, statut)');
  assert.equal(malRow!['typeCode'], null, 'jamais le code du type confidentiel');
  assert.equal(malRow!['labelFr'], 'Absence');
  assert.equal(malRow!['comment'], 'motif confidentiel');
  assert.ok(Number(malRow!['attachmentCount']) >= 1, 'présence du justificatif visible, contenu NON');
  // Détail côté manager : motif masqué ; côté RH sensible : visible.
  const detMgr = await getJson<{ request: { versions: Array<{ comment: string }>; attachments: Array<{ filename: string }> } }>(
    `/leave/requests/${reqMal}`, mgr);
  assert.equal(detMgr.request.versions[0]!.comment, 'motif confidentiel');
  assert.equal(detMgr.request.attachments[0]!.filename, 'justificatif confidentiel');
  const detRhq = await getJson<{ request: { versions: Array<{ comment: string }> } }>(`/leave/requests/${reqMal}`, rhq);
  assert.equal(detRhq.request.versions[0]!.comment, 'détail médical PRIVÉ');
  // Pièce SENSIBLE : manager 403 ; vérificateur OK (journalisé) ; salarié OK.
  assert.equal((await api(`/leave/requests/attachments/${malAttachment}`, mgr, undefined, 'GET')).status, 403);
  const dl = await getJson<{ filename: string }>(`/leave/requests/attachments/${malAttachment}`, rhq2);
  assert.equal(dl.filename, 'certificat.pdf');
  await getJson(`/leave/requests/attachments/${malAttachment}`, self);
  assert.equal(Number(psql(`SELECT count(*) FROM leave.attachment_access_log WHERE attachment_id = '${malAttachment}'`)) >= 2, true,
    'CHAQUE consultation est journalisée');
  // Vérification : un STATUT — et jamais par le salarié lui-même.
  assert.equal((await api(`/leave/requests/attachments/${malAttachment}/verify`, self, { status: 'accepted' })).status, 403);
  await postJson(`/leave/requests/attachments/${malAttachment}/verify`, rhq2, { status: 'accepted' });
  assert.equal(psql(`SELECT verified_status FROM leave.request_attachments WHERE id = '${malAttachment}'`), 'accepted');
  // Le secret médical n'atteint JAMAIS le journal d'audit ni les notifications.
  assert.equal(psql(`SELECT count(*) FROM audit.audit_log WHERE tenant_id = '${tenantAId}'
    AND (old_value::text LIKE '%détail médical PRIVÉ%' OR new_value::text LIKE '%détail médical PRIVÉ%'
         OR reason LIKE '%détail médical PRIVÉ%')`), '0');
  assert.equal(psql(`SELECT count(*) FROM notify.events WHERE tenant_id = '${tenantAId}'
    AND payload::text LIKE '%MAL%'`), '0', 'les notifications ne portent jamais le code du type confidentiel');
  // Décision du circuit sensible par la RH (le manager n'y a PAS d'étape).
  await postJson(`/leave/requests/${reqMal}/decide`, rhq2, { action: 'approve' });
  assert.equal(psql(`SELECT status FROM leave.requests WHERE id = '${reqMal}'`), 'applied');
});

test('16 calendrier d\'équipe : niveaux de visibilité, fériés, capacité (paramètre E4), export AUDITÉ', async () => {
  const mgr = await token(slugA, mgrEmail);
  const rhq = await token(slugA, rhqEmail);
  const adm = await token(slugA, admEmail);
  const naked = await token(slugA, nakedEmail);
  type Cal = { calendar: {
    entries: Array<{ employeeId: string; labelMode: string; typeCode: string | null; labelFr: string; status: string }>;
    holidays: Array<{ date: string }>; alerts: Array<{ date: string; level: string; minPresence: number }>;
  } };
  // Manager (équipe résolue, PAS de portée calendar_view) : types en libellé GÉNÉRIQUE, MAL = « Indisponible ».
  const calMgr = await getJson<Cal>(`/leave/calendar?from=2026-09-21&to=2026-09-25`, mgr);
  const malEntry = calMgr.calendar.entries.find((e) => e.employeeId === e1 && e.status === 'approved');
  assert.ok(malEntry, 'l\'absence MAL appliquée (21–23/09) apparaît');
  assert.equal(malEntry!.labelMode, 'unavailable');
  assert.equal(malEntry!.typeCode, null);
  assert.equal(malEntry!.labelFr, 'Indisponible');
  // RH sensible + portée : détail complet, y compris le type confidentiel.
  const calRhq = await getJson<Cal>(`/leave/calendar?from=2026-09-21&to=2026-09-25`, rhq);
  const malRhq = calRhq.calendar.entries.find((e) => e.employeeId === e1 && e.status === 'approved');
  assert.equal(malRhq!.labelMode, 'detail');
  assert.equal(malRhq!.typeCode, 'MAL');
  // Fériés visibles ; capacité : seuil E4 (99) ⇒ alerte dès la première absence.
  const calSept = await getJson<Cal>(`/leave/calendar?from=2026-09-07&to=2026-09-11`, rhq);
  assert.ok(calSept.calendar.holidays.some((h) => h.date === '2026-09-10'));
  assert.ok(calSept.calendar.alerts.length >= 1 && calSept.calendar.alerts[0]!.minPresence === 99,
    'seuil interne E4 versionné, jamais codé en dur');
  // Export : permission dédiée + audit ; le CSV ne dit JAMAIS plus que l'écran (MAL → Indisponible).
  assert.equal((await api('/leave/calendar/export?from=2026-09-21&to=2026-09-25', naked, undefined, 'GET')).status, 403);
  const exp = await getJson<{ csv: string }>(`/leave/calendar/export?from=2026-09-21&to=2026-09-25`, adm);
  assert.ok(exp.csv.includes('Indisponible'), 'export masqué');
  assert.equal(exp.csv.includes('MAL'), false);
  assert.equal(psql(`SELECT count(*) FROM audit.audit_log WHERE tenant_id = '${tenantAId}'
    AND action = 'leave_calendar_exported'`), '1');
});

test('17 portées réelles : self borné à SOI, équipe RÉSOLUE, l\'identifiant transmis n\'élargit JAMAIS, expiration contrôlée', async () => {
  const self = await token(slugA, selfEmail);
  const self2 = await token(slugA, self2Email);
  const mgr = await token(slugA, mgrEmail);
  const adm = await token(slugA, admEmail);
  const naked = await token(slugA, nakedEmail);
  // adm crée une demande pour eOut (HORS équipe du manager).
  const forOut = await postJson<{ id: string }>('/leave/requests', adm, {
    employeeId: eOut, typeId: typeCap, startDate: '2026-12-28', endDate: '2026-12-29',
    onBehalfReason: 'salarié sans compte',
  }, 201);
  // eOut n'a pas de compte ⇒ pas de confirmation exigible ⇒ soumission directe.
  await postJson(`/leave/requests/${forOut.id}/submit`, adm, undefined);
  // self : « mes demandes » ne contient QUE les siennes ; le détail d'autrui = introuvable.
  const mine = await getJson<{ items: Array<{ id: string }> }>('/leave/requests/mine', self);
  assert.equal(mine.items.some((i) => i.id === forOut.id), false);
  assert.equal((await api(`/leave/requests/${forOut.id}`, self, undefined, 'GET')).status, 404);
  assert.equal((await api(`/leave/requests/preview/${forOut.id}`, self2, undefined, 'GET')).status, 403);
  // mgr : équipe résolue — eOut n'y est PAS, quoi que dise l'URL.
  const team = await getJson<{ items: Array<{ id: string }> }>('/leave/requests/team', mgr);
  assert.equal(team.items.some((i) => i.id === forOut.id), false);
  assert.equal((await api(`/leave/requests/${forOut.id}`, mgr, undefined, 'GET')).status, 404);
  // naked : tout est fermé.
  for (const [path, method] of [
    ['/leave/requests/mine', 'GET'], ['/leave/requests/team', 'GET'],
    ['/leave/requests/queue', 'GET'], ['/leave/calendar?from=2026-09-01&to=2026-09-05', 'GET'],
  ] as const) {
    assert.equal((await api(path, naked, undefined, method)).status, 403, path);
  }
  assert.equal((await api('/leave/requests', naked, {
    typeId: typeCap, startDate: '2026-12-01', endDate: '2026-12-02',
  })).status, 403, 'création sans permission');
  // Expiration : JAMAIS sur une demande en circuit (elle se DÉCIDE) —
  assert.equal((await api(`/leave/requests/${forOut.id}/expire`, adm, { reason: 'test' })).status, 409);
  // eOut n'a AUCUN manager résolu : l'étape manager (conditionnelle) est sautée,
  // l'instance commence à l'étape RH — la RH retourne la demande pour complément.
  const rhq2 = await token(slugA, rhq2Email);
  await postJson(`/leave/requests/${forOut.id}/decide`, rhq2, { action: 'return', comment: 'préciser la source' });
  assert.equal(psql(`SELECT status FROM leave.requests WHERE id = '${forOut.id}'`), 'returned');
  // — mais OUI sur une demande retournée jamais resoumise (abandon constaté, motivé, notifié).
  await postJson(`/leave/requests/${forOut.id}/expire`, adm, { reason: 'non resoumise (délai dépassé)' });
  assert.equal(psql(`SELECT status FROM leave.requests WHERE id = '${forOut.id}'`), 'expired');
  assert.equal(ledgerCount(`request_id = '${forOut.id}' AND entry_kind = 'release'`), 1, 'expiration ⇒ libération');
});

test('18 isolation tenant : invisible ET inactionnable, FK PostgreSQL rejetées', async () => {
  const bAdm = await token(slugB, bAdmEmail);
  // Rien à voir : files vides, détail d'une demande du tenant A introuvable, décision impossible.
  const queue = await getJson<{ items: unknown[] }>('/leave/requests/queue', bAdm);
  assert.equal(queue.items.length, 0);
  assert.equal((await api(`/leave/requests/${reqE1Sept}`, bAdm, undefined, 'GET')).status, 404);
  assert.equal((await api(`/leave/requests/${reqE1Sept}/decide`, bAdm, { action: 'approve' })).status, 404);
  assert.equal((await api(`/leave/requests/attachments/${malAttachment}`, bAdm, undefined, 'GET')).status, 404);
  // FK composites : une demande du tenant B ne référence JAMAIS un salarié du tenant A.
  assert.equal(psqlFails(`INSERT INTO leave.requests (tenant_id, employee_id, absence_type_id, created_by)
    VALUES ('${tenantBId}', '${e1}', '${typeCap}', (SELECT id FROM admin.users WHERE email = '${bAdmEmail}'))`), true);
  // Ni un mouvement lié à la demande d'un autre tenant.
  assert.equal(psqlFails(`INSERT INTO leave.entitlement_ledger (tenant_id, employee_id, absence_type_id,
      reference_period_start, reference_period_end, entry_kind, quantity, unit, effective_on, origin,
      idempotency_key, request_id, request_version)
    SELECT '${tenantBId}', e.id, t.id, '2026-01-01', '2026-12-31', 'reservation', 1, 'open_days',
           '2026-09-01', 'workflow', 'xt-${rid}', '${reqE1Sept}', 1
      FROM core.employees e, leave.absence_types t
     WHERE e.tenant_id = '${tenantBId}' AND t.tenant_id = '${tenantBId}' LIMIT 1`), true);
});

test('19 file RH : filtres sensibles/rétroactives/échecs, suivi des délais (paramètre E4), masquage conservé', async () => {
  const rhq2 = await token(slugA, rhq2Email);
  const all = await getJson<{ items: Array<Record<string, unknown>>; delayDays: number | null }>('/leave/requests/queue', rhq2);
  assert.equal(all.delayDays, 3, 'délai d\'instruction = paramètre E4, jamais codé en dur');
  assert.ok(all.items.length >= 5);
  // rhq2 n'a PAS sensitive_view : la ligne MAL reste générique même dans la file RH.
  const malRow = all.items.find((i) => i['id'] === reqMal);
  assert.ok(malRow && malRow['typeCode'] === null && malRow['labelFr'] === 'Absence');
  const sensitiveOnly = await getJson<{ items: Array<Record<string, unknown>> }>('/leave/requests/queue?sensitive=1', rhq2);
  assert.ok(sensitiveOnly.items.every((i) => i['confidential'] === true));
  assert.ok(sensitiveOnly.items.some((i) => i['id'] === reqMal));
  const retroOnly = await getJson<{ items: Array<Record<string, unknown>> }>('/leave/requests/queue?retro=1', rhq2);
  assert.ok(retroOnly.items.some((i) => i['id'] === reqRetro));
  assert.ok(retroOnly.items.every((i) => i['retroactive'] === true));
});

test('20 journal : chaque opération sensible du cycle de vie est AUDITÉE ; notifications seulement après commit', async () => {
  const actions = psql(`SELECT string_agg(DISTINCT action, ',') FROM audit.audit_log
    WHERE tenant_id = '${tenantAId}' AND action LIKE 'leave_request%' OR
          (tenant_id = '${tenantAId}' AND action IN ('leave_attachment_added','leave_attachment_viewed',
           'leave_attachment_verified','leave_calendar_exported','leave_requests_list_accessed'))`).split(',');
  for (const expected of [
    'leave_request_created', 'leave_request_created_for_other', 'leave_request_draft_updated',
    'leave_request_submitted', 'leave_request_review_started', 'leave_request_returned',
    'leave_request_approved', 'leave_request_rejected', 'leave_request_applied',
    'leave_request_application_failed', 'leave_request_withdrawn', 'leave_request_cancel_requested',
    'leave_request_cancel_approved', 'leave_request_confirmed', 'leave_request_expired',
    'leave_attachment_added', 'leave_attachment_viewed', 'leave_attachment_verified',
    'leave_calendar_exported',
  ]) {
    assert.ok(actions.includes(expected), `action auditée manquante : ${expected}`);
  }
  // Notifications : émises UNIQUEMENT pour des faits committés (leçon : rien avant commit).
  const submittedCount = Number(psql(`SELECT count(*) FROM notify.events
    WHERE tenant_id = '${tenantAId}' AND event_key LIKE 'conges-demande-soumise-%'`));
  assert.ok(submittedCount >= 5, `soumissions notifiées : ${submittedCount}`);
  assert.ok(Number(psql(`SELECT count(*) FROM notify.events WHERE tenant_id = '${tenantAId}'
    AND event_key LIKE 'conges-demande-appliquee-%'`)) >= 1, 'application notifiée après commit');
  assert.ok(Number(psql(`SELECT count(*) FROM notify.events WHERE tenant_id = '${tenantAId}'
    AND event_key LIKE 'conges-demande-echec-%'`)) >= 1, 'échec d\'application notifié');
});
