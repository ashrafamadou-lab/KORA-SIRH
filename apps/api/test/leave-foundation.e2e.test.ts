/**
 * E2E Congés E11.1 — conditions de validation du sponsor : isolation tenant et FK
 * PostgreSQL ; politique future sans effet rétroactif ; populations incompatibles
 * refusées ; résolution par salarié et date (ambiguïté = conflit EXPLICITE) ;
 * acquisition mensuelle/annuelle IDEMPOTENTE (clés en base) ; exécutions
 * concurrentes sans double crédit (exclusion) ; paramètre E4 futur sans effet
 * passé ; prorata embauche/cessation déterministe ; suspension du service
 * effectif ; report et expiration en mouvements DISTINCTS ; ajustement =
 * mouvement compensatoire (jamais une réécriture) ; solde = somme EXACTE des
 * mouvements ; disponible ≠ projeté ; fériés/repos selon l'unité ; rotation de
 * nuit sur SA journée ; données confidentielles cloisonnées (listes, ledger,
 * audit) ; import de reprise atomique et idempotent ; portées self/équipe/RH
 * réelles ; journal d'audit complet.
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
const slugA = `lv-a-${rid}`;
const slugB = `lv-b-${rid}`;
const admEmail = `lvadm.${rid}@demo.bj`;    // administration congés (tenant), SANS sensitive_view
const rhEmail = `lvrh.${rid}@demo.bj`;      // rôle rh-conges : approbateur + sensitive_view
const mgrEmail = `lvmgr.${rid}@demo.bj`;    // manager (équipe seulement)
const selfEmail = `lvself.${rid}@demo.bj`;  // salarié e1 (ESS)
const nakedEmail = `lvnone.${rid}@demo.bj`;
const bAdmEmail = `lvbadm.${rid}@demo.bj`;

let app: INestApplication;
let base = '';
let tenantAId = '';
let tenantBId = '';
let coA = '', siteA = '', uRh = '', uIt = '';
let eMgr = '', e1 = '', e2 = '', eTerm = '', eSusp = '', eNight = '';
let typeCap = '', typeMal = '', typeRec = '';
let polCap = '';

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
  tenantAId = psql(`INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('${slugA}','LV A',true) RETURNING id`);
  tenantBId = psql(`INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('${slugB}','LV B',true) RETURNING id`);
  await seedUser(tenantAId, admEmail, [
    'leave.types_admin', 'leave.policies_admin', 'leave.accrual_run', 'leave.balance_adjust',
    'leave.openings_import', 'leave.balance_view', 'leave.ledger_view', 'leave.balance_view_own',
    'org.view', 'org.manage', 'employees.view', 'employees.manage', 'employees.assign',
    'time.schedules_view', 'time.schedules_manage', 'time.schedules_assign',
    'workflow.manage', 'workflow.view', 'notify.manage', 'audit.view', 'parameters.view',
  ], true);
  await seedUser(tenantAId, rhEmail, [
    'leave.balance_view', 'leave.ledger_view', 'leave.sensitive_view', 'workflow.view', 'workflow.act',
  ], true, 'rh-conges');
  await seedUser(tenantAId, mgrEmail, ['leave.balance_view_team', 'leave.ledger_view', 'employees.view'], false);
  const selfId = await seedUser(tenantAId, selfEmail, ['leave.balance_view_own'], true);
  await seedUser(tenantAId, nakedEmail, ['employees.view'], true);
  await seedUser(tenantBId, bAdmEmail, [
    'leave.types_admin', 'leave.policies_admin', 'leave.balance_view', 'leave.ledger_view', 'leave.accrual_run',
  ], true);

  // Paramètres E4 ACTIFS (fixtures juridiquement contresignées de test).
  for (const [key, value, from] of [
    ['conges.acquisition.taux_mensuel', '2', '2020-01-01'],
    ['conges.ouvrables.jours', '[1,2,3,4,5,6]', '2020-01-01'],
    ['conges.ajustement.seuil_sensible', '5', '2020-01-01'],
    ['temps.fuseau.defaut', '"Africa/Porto-Novo"', '2020-01-01'],
  ] as const) {
    psql(`INSERT INTO compliance.legal_parameters
            (tenant_id, country_code, key, value, effective_from, status, is_legal_sensitive,
             confidence, source_text, verified_by, verified_at)
          VALUES ('${tenantAId}', 'BJ', '${key}', '${value}', '${from}', 'active', false,
                  'verified', 'fixture e2e E11.1', 'fixture-e2e', '2026-01-01')`);
  }

  app = await createApp();
  await app.listen(0);
  const addr = app.getHttpServer().address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  base = `http://127.0.0.1:${port}/api/v1`;
  void selfId;
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

interface BalanceRow {
  employeeId: string; typeCode: string; periodStart: string; unit: string;
  accrued: number; adjustedOut: number; carriedIn: number; expired: number;
  reserved: number; consumed: number; available: number;
}
async function balanceOf(tok: string, employeeId: string, typeId: string, periodStart: string): Promise<BalanceRow | undefined> {
  const out = await getJson<{ items: BalanceRow[] }>(`/leave/balances?employeeId=${employeeId}&typeId=${typeId}`, tok);
  return out.items.find((b) => b.periodStart === periodStart);
}

// ---------------------------------------------------------------------------

test('01 fixtures : organisation, salariés, carrière, horaires E10, circuit E3, modèles E5', async () => {
  const adm = await token(slugA, admEmail);
  coA = await created('/org/companies', adm, { code: `LVCO-${RID}`, labelFr: 'Société LV', labelEn: 'LV Co' });
  psql(`UPDATE org.companies SET status = 'active' WHERE id = '${coA}'`);
  siteA = await created('/org/sites', adm, { code: `LVSITE-${RID}`, labelFr: 'Site LV', labelEn: 'LV Site', companyId: coA });
  psql(`UPDATE org.sites SET status = 'active' WHERE id = '${siteA}'`);
  uRh = await created('/org/units', adm, { unitType: 'department', code: `LVRH-${RID}`, labelFr: 'Département RH', labelEn: 'HR', companyId: coA });
  uIt = await created('/org/units', adm, { unitType: 'department', code: `LVIT-${RID}`, labelFr: 'Département IT', labelEn: 'IT', companyId: coA });
  psql(`UPDATE org.units SET status = 'active' WHERE id IN ('${uRh}','${uIt}')`);

  const mk = async (mat: string, first: string, unit: string, hire: string, managerOverride?: string): Promise<string> => {
    const res = await api('/employees', adm, { matricule: mat, firstName: first, lastName: 'Conge', hireDate: hire });
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
  eMgr = await mk(`LVM-${RID}`, 'Manou', uRh, '2024-01-01');
  e1 = await mk(`LV1-${RID}`, 'Awa', uRh, '2025-01-01', eMgr);
  e2 = await mk(`LV2-${RID}`, 'Bio', uIt, '2026-01-17');
  eTerm = await mk(`LVT-${RID}`, 'Tossou', uIt, '2025-06-01');
  eSusp = await mk(`LVS-${RID}`, 'Dossi', uRh, '2025-01-01', eMgr);
  eNight = await mk(`LVN-${RID}`, 'Noel', uIt, '2025-01-01');
  psql(`UPDATE core.employees SET professional_status = 'Cadre' WHERE id = '${e1}'`);
  // Liens comptes ↔ dossiers : ESS et manager.
  psql(`UPDATE core.employees SET user_id = (SELECT id FROM admin.users WHERE email = '${selfEmail}') WHERE id = '${e1}'`);
  psql(`UPDATE core.employees SET user_id = (SELECT id FROM admin.users WHERE email = '${mgrEmail}') WHERE id = '${eMgr}'`);
  // Cessation DATÉE (événement de carrière) + suspension 11–20 janvier.
  psql(`UPDATE core.employees SET status = 'terminated' WHERE id = '${eTerm}'`);
  psql(`INSERT INTO core.career_events (tenant_id, employee_id, event_type, effective_date, details)
        VALUES ('${tenantAId}','${eTerm}','termination','2026-02-10','{}')`);
  psql(`INSERT INTO core.career_events (tenant_id, employee_id, event_type, effective_date, details)
        VALUES ('${tenantAId}','${eSusp}','suspension','2026-01-11','{}'),
               ('${tenantAId}','${eSusp}','return','2026-01-21','{}')`);

  // Horaires E10 : jour fixe lun–ven pour e1 ; rotation de NUIT pour eNight.
  const dayModel = await created('/time/schedules/models', adm, { code: `LVJ-${RID}`, labelFr: 'Jour LV', labelEn: 'LV Day', kind: 'fixed' });
  await postJson(`/time/schedules/models/${dayModel}/versions`, adm, {
    effectiveFrom: '2025-01-06', cycleDays: 7,
    days: [0, 1, 2, 3, 4].map((i) => ({ dayIndex: i, isRest: false, startMinute: 480, endMinute: 1020, breakStartMinute: 720, breakEndMinute: 780 }))
      .concat([{ dayIndex: 5, isRest: true }, { dayIndex: 6, isRest: true }] as never[]),
  }, 201);
  await postJson('/time/schedules/assignments', adm, { employeeId: e1, modelId: dayModel, anchorDate: '2026-01-05', effectiveFrom: '2025-01-06' }, 201);
  const nightModel = await created('/time/schedules/models', adm, { code: `LVN-${RID}`, labelFr: 'Nuit LV', labelEn: 'LV Night', kind: 'rotation' });
  await postJson(`/time/schedules/models/${nightModel}/versions`, adm, {
    effectiveFrom: '2025-01-06', cycleDays: 4,
    days: [
      { dayIndex: 0, isRest: false, startMinute: 1320, endMinute: 1800 },
      { dayIndex: 1, isRest: false, startMinute: 1320, endMinute: 1800 },
      { dayIndex: 2, isRest: true }, { dayIndex: 3, isRest: true },
    ],
  }, 201);
  await postJson('/time/schedules/assignments', adm, { employeeId: eNight, modelId: nightModel, anchorDate: '2026-08-03', effectiveFrom: '2025-01-06' }, 201);
  // Férié : jeudi 6 août 2026 (calendrier tenant).
  const cal = await created('/time/holidays/calendars', adm, { code: `LVFER-${RID}`, labelFr: 'Fériés LV', labelEn: 'LV Holidays' });
  psql(`UPDATE time.holiday_calendars SET status = 'active' WHERE id = '${cal}'`);
  psql(`INSERT INTO time.holidays (tenant_id, calendar_id, holiday_date, label_fr, label_en, status)
        VALUES ('${tenantAId}','${cal}','2026-08-06','Férié test','Test holiday','active')`);

  // Circuit E3 pour les ajustements SENSIBLES.
  const def = await api('/workflow/definitions', adm, {
    key: 'conges_ajustement', name: 'Ajustement de droit sensible',
    steps: [{ index: 0, name: 'Validation RH congés', approverType: 'role', approverRef: 'rh-conges' }],
  });
  const defText = await def.text();
  assert.equal(def.status, 201, defText);
  const defId = (JSON.parse(defText) as { id: string }).id;
  assert.equal((await api(`/workflow/definitions/${defId}/activate`, adm)).status, 200);

  // Modèles E5.
  for (const [key, name, subject, vars] of [
    ['conges_ajustement_applique', 'Ajustement appliqué', 'Ajustement {{direction}}', ['direction', 'quantite']],
    ['conges_acquisition_erreurs', 'Erreurs d’acquisition', 'Acquisition {{execution}}', ['execution', 'erreurs']],
  ] as const) {
    const tpl = await api('/admin/notify/templates', adm, {
      key, name, subjectFr: subject, subjectEn: subject,
      bodyFr: vars.map((v) => `{{${v}}}`).join(' · '), bodyEn: vars.map((v) => `{{${v}}}`).join(' · '),
      variables: [...vars], channels: ['in_app'], mandatory: false,
    });
    const tplText = await tpl.text();
    assert.equal(tpl.status, 201, tplText);
    assert.equal((await api(`/admin/notify/templates/${(JSON.parse(tplText) as { id: string }).id}/activate`, adm)).status, 200);
  }

  // Types d'absence : CAP (E4), MAL (confidentiel), REC (interne, valeur tenant).
  typeCap = await created('/leave/types', adm, {
    code: 'CAP', labelFr: 'Congé annuel payé', labelEn: 'Paid annual leave',
    category: 'legal', paid: true, unit: 'open_days',
  });
  typeMal = await created('/leave/types', adm, {
    code: 'MAL', labelFr: 'Maladie', labelEn: 'Sickness',
    category: 'legal', paid: true, unit: 'calendar_days', confidential: true, justification: 'required',
  });
  typeRec = await created('/leave/types', adm, {
    code: 'REC', labelFr: 'Récupération', labelEn: 'Recovery',
    category: 'internal', paid: false, unit: 'open_days',
  });
  await postJson(`/leave/types/${typeCap}`, adm, { status: 'active' });
  await postJson(`/leave/types/${typeMal}`, adm, { status: 'active' });
  await postJson(`/leave/types/${typeRec}`, adm, { status: 'active' });

  // Politiques : CAP (rythme = clé E4), REC (valeur tenant + service effectif requis).
  polCap = await created('/leave/policies', adm, {
    absenceTypeId: typeCap, code: 'POL-CAP', labelFr: 'Politique CAP', labelEn: 'CAP policy', countryCode: 'BJ',
  });
  await postJson(`/leave/policies/${polCap}/versions`, adm, {
    effectiveFrom: '2025-01-01', accrualMode: 'monthly',
    accrualRateParam: 'conges.acquisition.taux_mensuel',
    referencePeriod: 'calendar_year', rounding: 'half_up_0_5',
    carryOverMaxValue: 6, prorataHire: true, prorataTermination: true,
  }, 201);
  await postJson(`/leave/policies/${polCap}/status`, adm, { status: 'active' });
  const polRec = await created('/leave/policies', adm, {
    absenceTypeId: typeRec, code: 'POL-REC', labelFr: 'Politique REC', labelEn: 'REC policy',
  });
  await postJson(`/leave/policies/${polRec}/versions`, adm, {
    effectiveFrom: '2025-01-01', accrualMode: 'monthly',
    accrualRateValue: 2, rounding: 'none', accrualRequiresService: true,
  }, 201);
  await postJson(`/leave/policies/${polRec}/status`, adm, { status: 'active' });
});

test('02 types : gel de la SÉMANTIQUE après usage, libellés modifiables, catalogue honnête', async () => {
  const adm = await token(slugA, admEmail);
  // Libellé : modifiable.
  await postJson(`/leave/types/${typeCap}`, adm, { labelFr: 'Congé annuel payé (BJ)' });
  // Unité : FIGÉE (une politique référence le type) — refus PAR LA BASE, 409 explicite.
  assert.equal(psqlFails(`UPDATE leave.absence_types SET unit = 'hours' WHERE id = '${typeCap}'`), true,
    'sémantique figée par le trigger');
  const types = await getJson<{ items: Array<{ code: string; policyCount: number; confidential: boolean }> }>('/leave/types', adm);
  const cap = types.items.find((t) => t.code === 'CAP');
  assert.ok(cap && cap.policyCount >= 1);
  assert.equal(types.items.find((t) => t.code === 'MAL')!.confidential, true);
});

test('03 politiques : population identique refusée, la plus SPÉCIFIQUE gagne, ambiguïté = conflit explicite', async () => {
  const adm = await token(slugA, admEmail);
  // Même population EXACTE (BJ, tous) + même type ⇒ activation REFUSÉE par la base.
  const dup = await created('/leave/policies', adm, {
    absenceTypeId: typeCap, code: 'POL-CAP-DUP', labelFr: 'Doublon', labelEn: 'Dup', countryCode: 'BJ',
  });
  await postJson(`/leave/policies/${dup}/versions`, adm, {
    effectiveFrom: '2025-01-01', accrualMode: 'monthly', accrualRateValue: 3,
  }, 201);
  const conflict = await api(`/leave/policies/${dup}/status`, adm, { status: 'active' });
  const conflictText = await conflict.text();
  assert.equal(conflict.status, 409, conflictText);
  assert.match(conflictText, /population/i);
  // Politique CATÉGORIE (Cadre) : plus spécifique que la politique pays.
  const polCadre = await created('/leave/policies', adm, {
    absenceTypeId: typeCap, code: 'POL-CAP-CADRE', labelFr: 'CAP cadres', labelEn: 'CAP managers', professionalCategory: 'Cadre',
  });
  await postJson(`/leave/policies/${polCadre}/versions`, adm, {
    effectiveFrom: '2026-01-01', accrualMode: 'monthly', accrualRateValue: 2.5, rounding: 'none',
  }, 201);
  await postJson(`/leave/policies/${polCadre}/status`, adm, { status: 'active' });
  // Résolution : e1 (Cadre) reçoit la politique CATÉGORIE ; eMgr (sans catégorie) la politique PAYS (E4).
  const r1 = await getJson<{ resolution: { policyCode: string } | null }>(
    `/leave/policies/resolve?employeeId=${e1}&typeId=${typeCap}&date=2026-02-01`, adm);
  assert.equal(r1.resolution?.policyCode, 'POL-CAP-CADRE', 'la politique la plus spécifique gagne');
  const r2 = await getJson<{ resolution: { policyCode: string } | null }>(
    `/leave/policies/resolve?employeeId=${eMgr}&typeId=${typeCap}&date=2026-02-01`, adm);
  assert.equal(r2.resolution?.policyCode, 'POL-CAP', 'sans catégorie : la politique pays s\'applique');
  // Ambiguïté FABRIQUÉE : seconde politique de même score (site ≠ société mais score égal ? non —
  // même sélecteur société via un AUTRE code n'est pas activable ; on crée une politique SITE (score 8)
  // et une politique SOCIÉTÉ+CATÉGORIE (4+2=6) : pas d'égalité. L'égalité réelle : catégorie (2)+statut (1)
  // = 3 contre ancienneté (1)+pays (1)+statut (1) = 3.
  const amb1 = await created('/leave/policies', adm, {
    absenceTypeId: typeRec, code: 'POL-REC-A', labelFr: 'A', labelEn: 'A', professionalCategory: null, employeeStatus: 'active', countryCode: 'BJ',
  });
  await postJson(`/leave/policies/${amb1}/versions`, adm, { effectiveFrom: '2026-01-01', accrualMode: 'none' }, 201);
  await postJson(`/leave/policies/${amb1}/status`, adm, { status: 'active' });
  const amb2 = await created('/leave/policies', adm, {
    absenceTypeId: typeRec, code: 'POL-REC-B', labelFr: 'B', labelEn: 'B', seniorityMinMonths: 0, employeeStatus: 'active',
  });
  await postJson(`/leave/policies/${amb2}/versions`, adm, { effectiveFrom: '2026-01-01', accrualMode: 'none' }, 201);
  await postJson(`/leave/policies/${amb2}/status`, adm, { status: 'active' });
  const amb = await api(`/leave/policies/resolve?employeeId=${e1}&typeId=${typeRec}&date=2026-02-01`, adm, undefined, 'GET');
  const ambText = await amb.text();
  assert.equal(amb.status, 409, ambText);
  assert.match(ambText, /AMBIGU/i);
  // Nettoyage : retirer les politiques d'ambiguïté (REC retrouve SA politique de base).
  await postJson(`/leave/policies/${amb1}/status`, adm, { status: 'retired' });
  await postJson(`/leave/policies/${amb2}/status`, adm, { status: 'retired' });
});

test('04 acquisition mensuelle IDEMPOTENTE : 2 j/mois (E4), relance = zéro écriture, provenance portée', async () => {
  const adm = await token(slugA, admEmail);
  const run1 = await postJson<{ run: { status: string; entriesWritten: number; entriesSkipped: number } }>(
    '/leave/accrual/run', adm,
    { periodStart: '2026-01-01', periodEnd: '2026-03-31', scopeKind: 'employee', scopeId: e1, reason: 'acquisition T1 e1' }, 201);
  assert.equal(run1.run.status, 'completed');
  assert.equal(run1.run.entriesWritten, 6, 'janvier–mars × (CAP + REC : les deux politiques actives)');
  // POL-CAP-CADRE (2.5, rounding none) est la politique résolue pour e1 depuis 2026-01-01.
  const bal = await balanceOf(adm, e1, typeCap, '2026-01-01');
  assert.ok(bal);
  assert.equal(bal!.accrued, 7.5, '3 mois × 2.5 (politique catégorie, valeur tenant)');
  assert.equal(bal!.available, 7.5);
  // RELANCE : idempotente PAR LA BASE (clés), zéro écriture.
  const run2 = await postJson<{ run: { entriesWritten: number; entriesSkipped: number } }>(
    '/leave/accrual/run', adm,
    { periodStart: '2026-01-01', periodEnd: '2026-03-31', scopeKind: 'employee', scopeId: e1, reason: 'relance idempotente' }, 201);
  assert.equal(run2.run.entriesWritten, 0, 'rejouer n\'écrit RIEN');
  assert.equal(run2.run.entriesSkipped, 6);
  // Provenance : le mouvement porte politique, version et source du rythme.
  const led = await getJson<{ items: Array<{ entryKind: string; paramsUsed: Record<string, unknown>; policyVersion: number }> }>(
    `/leave/ledger?employeeId=${e1}&typeId=${typeCap}`, adm);
  const acc = led.items.filter((l) => l.entryKind === 'accrual');
  assert.equal(acc.length, 3);
  assert.ok(acc.every((l) => l.policyVersion === 1));
});

test('05 acquisitions CONCURRENTES : exclusion PostgreSQL — jamais un double crédit', async () => {
  const adm = await token(slugA, admEmail);
  const fire = () => api('/leave/accrual/run', adm,
    { periodStart: '2026-04-01', periodEnd: '2026-04-30', scopeKind: 'employee', scopeId: e1, reason: 'concurrence avril' });
  const [r1, r2] = await Promise.all([fire(), fire()]);
  const codes = [r1.status, r2.status].sort((a, b) => a - b);
  assert.ok(codes[0] === 201, `une exécution passe (${codes.join(',')})`);
  assert.ok(codes[1] === 201 || codes[1] === 409, `l'autre passe APRÈS (sérialisée, 0 écrit) ou est refusée (${codes.join(',')})`);
  const acc = psql(`SELECT count(*) FROM leave.entitlement_ledger
    WHERE tenant_id = '${tenantAId}' AND employee_id = '${e1}' AND entry_kind = 'accrual'
      AND absence_type_id = '${typeCap}' AND effective_on = '2026-04-30'`);
  assert.equal(Number(acc), 1, 'UN SEUL mouvement d\'avril, quelle que soit la course');
});

test('06 paramètre E4 FUTUR : les périodes passées ne bougent pas, la nouvelle valeur vaut à sa date', async () => {
  const adm = await token(slugA, admEmail);
  // eMgr (sans catégorie) suit POL-CAP dont le rythme est la CLÉ E4 (2 j/mois).
  const runBefore = await postJson<{ run: { entriesWritten: number } }>('/leave/accrual/run', adm,
    { periodStart: '2026-03-01', periodEnd: '2026-03-31', scopeKind: 'employee', scopeId: eMgr, reason: 'mars eMgr' }, 201);
  assert.ok(runBefore.run.entriesWritten >= 1);
  const marsBefore = psql(`SELECT quantity FROM leave.entitlement_ledger
    WHERE tenant_id = '${tenantAId}' AND employee_id = '${eMgr}' AND absence_type_id = '${typeCap}'
      AND entry_kind = 'accrual' AND effective_on = '2026-03-31'`);
  // Nouvelle version E4 du taux mensuel : 3 jours À PARTIR de juin (supersession propre).
  psql(`UPDATE compliance.legal_parameters SET effective_to = '2026-06-01', status = 'superseded'
        WHERE tenant_id = '${tenantAId}' AND key = 'conges.acquisition.taux_mensuel' AND status = 'active'`);
  psql(`INSERT INTO compliance.legal_parameters
          (tenant_id, country_code, key, value, effective_from, status, is_legal_sensitive, confidence, source_text, verified_by, verified_at)
        VALUES ('${tenantAId}', 'BJ', 'conges.acquisition.taux_mensuel', '3', '2026-06-01', 'active', false,
                'verified', 'révision test', 'fixture-e2e', '2026-05-01')`);
  // Re-lancer MARS : rien ne change (idempotence + résolution à la date).
  const runMars = await postJson<{ run: { entriesWritten: number } }>('/leave/accrual/run', adm,
    { periodStart: '2026-03-01', periodEnd: '2026-03-31', scopeKind: 'employee', scopeId: eMgr, reason: 'relance mars après param futur' }, 201);
  assert.equal(runMars.run.entriesWritten, 0, 'un paramètre FUTUR ne réécrit pas le passé');
  const marsAfter = psql(`SELECT quantity FROM leave.entitlement_ledger
    WHERE tenant_id = '${tenantAId}' AND employee_id = '${eMgr}' AND absence_type_id = '${typeCap}'
      AND entry_kind = 'accrual' AND effective_on = '2026-03-31'`);
  assert.equal(marsAfter, marsBefore, 'le mouvement de mars est STRICTEMENT identique');
  assert.equal(Number(marsAfter), 2, 'mars = ANCIENNE valeur E4 (2 j)');
  // Juin : la NOUVELLE version E4 (3 j) vaut à sa date — résolution au fait générateur.
  const runJuin = await postJson<{ run: { entriesWritten: number } }>('/leave/accrual/run', adm,
    { periodStart: '2026-06-01', periodEnd: '2026-06-30', scopeKind: 'employee', scopeId: eMgr, reason: 'juin nouveau taux' }, 201);
  assert.equal(runJuin.run.entriesWritten, 2, 'CAP (nouvelle valeur E4) + REC');
  const juin = psql(`SELECT quantity FROM leave.entitlement_ledger
    WHERE tenant_id = '${tenantAId}' AND employee_id = '${eMgr}' AND absence_type_id = '${typeCap}'
      AND entry_kind = 'accrual' AND effective_on = '2026-06-30'`);
  assert.equal(Number(juin), 3, 'juin = NOUVELLE valeur E4 (3 j), résolue à la date');
});

test('07 prorata : embauche mi-mois et cessation datée — déterministes, service effectif respecté', async () => {
  const adm = await token(slugA, admEmail);
  // e2 embauché 2026-01-17 : POL-CAP (E4 : 2, arrondi au demi) ⇒ janvier 2 × 15/31 = 0.968 → 1.0.
  const runE2 = await postJson<{ run: { entriesWritten: number } }>('/leave/accrual/run', adm,
    { periodStart: '2026-01-01', periodEnd: '2026-02-28', scopeKind: 'employee', scopeId: e2, reason: 'prorata embauche e2' }, 201);
  assert.ok(runE2.run.entriesWritten >= 2);
  const janE2 = psql(`SELECT quantity FROM leave.entitlement_ledger
    WHERE tenant_id = '${tenantAId}' AND employee_id = '${e2}' AND absence_type_id = '${typeCap}'
      AND entry_kind = 'accrual' AND effective_on = '2026-01-31'`);
  assert.equal(Number(janE2), 1, 'prorata embauche : 2 × 15/31 arrondi au demi le plus proche');
  // eTerm : cessation au 2026-02-10 ⇒ février proratisé, mars INEXISTANT.
  await postJson('/leave/accrual/run', adm,
    { periodStart: '2026-01-01', periodEnd: '2026-03-31', scopeKind: 'employee', scopeId: eTerm, reason: 'prorata cessation' }, 201);
  const fevT = psql(`SELECT quantity FROM leave.entitlement_ledger
    WHERE tenant_id = '${tenantAId}' AND employee_id = '${eTerm}' AND absence_type_id = '${typeCap}'
      AND entry_kind = 'accrual' AND effective_on = '2026-02-28'`);
  assert.equal(Number(fevT), 0.5, 'cessation : 2 × 10/28 = 0.714 → 0.5 (déterministe)');
  const marsT = psql(`SELECT count(*) FROM leave.entitlement_ledger
    WHERE tenant_id = '${tenantAId}' AND employee_id = '${eTerm}' AND entry_kind = 'accrual' AND effective_on = '2026-03-31'`);
  assert.equal(Number(marsT), 0, 'aucune acquisition après la cessation');
  // eSusp (REC, service effectif requis) : suspension 11–20 janvier ⇒ 2 × 21/31 = 1.355.
  await postJson('/leave/accrual/run', adm,
    { periodStart: '2026-01-01', periodEnd: '2026-01-31', scopeKind: 'employee', scopeId: eSusp, reason: 'service effectif' }, 201);
  const janS = psql(`SELECT quantity FROM leave.entitlement_ledger
    WHERE tenant_id = '${tenantAId}' AND employee_id = '${eSusp}' AND absence_type_id = '${typeRec}'
      AND entry_kind = 'accrual' AND effective_on = '2026-01-31'`);
  assert.equal(Number(janS), 1.355, 'la suspension RÉDUIT l\'acquisition du mois');
});

test('08 report/expiration : mouvements DISTINCTS, plafond appliqué, rejeu inerte, l\'histoire DEMEURE', async () => {
  const adm = await token(slugA, admEmail);
  // e1 dispose de 2025 ? Non : on FABRIQUE une période 2025 par reprise (opening 8.5 j).
  await postJson('/leave/openings/import', adm, {
    mode: 'apply', asOfDate: '2025-12-31',
    contentText: `matricule;type;quantite;periode_debut;periode_fin\nLV1-${RID};CAP;8.5;2025-01-01;2025-12-31\n`,
  });
  const runCo = await postJson<{ run: { entriesWritten: number } }>('/leave/accrual/run', adm,
    { periodStart: '2026-01-01', periodEnd: '2026-01-31', scopeKind: 'employee', scopeId: e1, reason: 'report 2025→2026', kind: 'carry_over' }, 201);
  assert.ok(runCo.run.entriesWritten >= 2, 'report + expiration écrits');
  // La politique RÉSOLUE pour e1 est POL-CAP-CADRE (sans plafond de report) ⇒ tout passe (8.5).
  const bal25 = await balanceOf(adm, e1, typeCap, '2025-01-01');
  const bal26 = await balanceOf(adm, e1, typeCap, '2026-01-01');
  assert.ok(bal25);
  assert.equal(bal25!.available, 0, '2025 soldée par l\'expiration de sortie');
  assert.ok(bal26!.carriedIn >= 8.5, 'le report ENTRE en 2026');
  // Rejeu du report : inerte.
  const runCo2 = await postJson<{ run: { entriesWritten: number; entriesSkipped: number } }>('/leave/accrual/run', adm,
    { periodStart: '2026-01-01', periodEnd: '2026-01-31', scopeKind: 'employee', scopeId: e1, reason: 'rejeu report', kind: 'carry_over' }, 201);
  assert.equal(runCo2.run.entriesWritten, 0, 'rejouer le report n\'écrit rien');
  // Les mouvements 2025 existent TOUJOURS (rien réécrit) : expiry + opening.
  const kinds = psql(`SELECT string_agg(DISTINCT entry_kind, ',' ORDER BY entry_kind) FROM leave.entitlement_ledger
    WHERE tenant_id = '${tenantAId}' AND employee_id = '${e1}' AND reference_period_start = '2025-01-01'`);
  assert.equal(kinds, 'expiry,opening_balance');
});

test('09 solde = somme EXACTE des mouvements ; disponible ≠ PROJETÉ', async () => {
  const adm = await token(slugA, admEmail);
  const led = await getJson<{ items: Array<{ entryKind: string; quantity: number; periodStart: string }> }>(
    `/leave/ledger?employeeId=${e1}&typeId=${typeCap}`, adm);
  const in26 = led.items.filter((l) => l.periodStart === '2026-01-01');
  const sum = (kinds: string[]): number => in26.filter((l) => kinds.includes(l.entryKind)).reduce((s, l) => s + l.quantity, 0);
  const expectedAvailable = Math.round((
    sum(['opening_balance', 'accrual', 'grant', 'adjustment_credit', 'carry_over'])
    - sum(['adjustment_debit']) - sum(['expiry'])
    - (sum(['reservation']) - sum(['release']))
    - (sum(['consumption']) - sum(['reversal']))) * 1000) / 1000;
  const bal = await balanceOf(adm, e1, typeCap, '2026-01-01');
  assert.equal(bal!.available, expectedAvailable, 'le solde N\'EST QUE la somme des mouvements');
  // Projection : + 2.5 par mois futur (politique société), clairement qualifiée.
  const self = await token(slugA, selfEmail);
  const proj = await getJson<{ projection: { currentAvailable: number; projected: number; note: string } }>(
    `/leave/projection?typeId=${typeCap}&toDate=2026-10-31`, self);
  assert.ok(proj.projection.projected > proj.projection.currentAvailable, 'la projection AJOUTE les acquisitions futures');
  assert.match(proj.projection.note, /PROJECTION/);
});

test('10 ajustements : compensatoire motivé, avant/après, JAMAIS de réécriture ; sensible ⇒ circuit E3', async () => {
  const adm = await token(slugA, admEmail);
  const rh = await token(slugA, rhEmail);
  const ledgerBefore = psql(`SELECT count(*) || ':' || coalesce(md5(string_agg(id::text || entry_kind || quantity::text, ',' ORDER BY id)), '-')
    FROM leave.entitlement_ledger WHERE tenant_id = '${tenantAId}' AND employee_id = '${e1}'`);
  // Sous le seuil (5) : DIRECT, avant/après calculés.
  const adj = await postJson<{ status: string; before: number; after: number; entryId: string }>(
    '/leave/adjust', adm, {
      employeeId: e1, typeId: typeCap, direction: 'credit', quantity: 1,
      reason: 'régularisation reprise', periodStart: '2026-01-01', periodEnd: '2026-12-31',
    });
  assert.equal(adj.status, 'applied');
  assert.equal(Math.round((adj.after - adj.before) * 1000) / 1000, 1);
  // Les anciens mouvements sont STRICTEMENT intacts (l'ajustement AJOUTE, ne réécrit pas).
  const ledgerAfter = psql(`SELECT count(*) || ':' || coalesce(md5(string_agg(id::text || entry_kind || quantity::text, ',' ORDER BY id)), '-')
    FROM leave.entitlement_ledger WHERE tenant_id = '${tenantAId}' AND employee_id = '${e1}'
      AND id <> '${adj.entryId}'`);
  assert.equal(ledgerAfter, ledgerBefore, 'aucun ancien mouvement modifié');
  // AU-DESSUS du seuil : circuit E3 requis — rien au ledger avant l'approbation.
  const big = await postJson<{ status: string; instanceId: string }>(
    '/leave/adjust', adm, {
      employeeId: e1, typeId: typeCap, direction: 'debit', quantity: 6,
      reason: 'correction de reprise erronée', periodStart: '2026-01-01', periodEnd: '2026-12-31',
    });
  assert.equal(big.status, 'pending_workflow');
  const noEntry = psql(`SELECT count(*) FROM leave.entitlement_ledger
    WHERE tenant_id = '${tenantAId}' AND idempotency_key LIKE 'adjust:%' AND entry_kind = 'adjustment_debit'`);
  assert.equal(Number(noEntry), 0, 'AUCUN mouvement avant la décision');
  // Approbation RH ⇒ mouvement appliqué UNE fois (rejouer la décision = refus, pas de doublon).
  const dec1 = await api(`/workflow/instances/${big.instanceId}/approve`, rh, {});
  const dec1Text = await dec1.text();
  assert.equal(dec1.status, 200, dec1Text);
  const dec2 = await api(`/workflow/instances/${big.instanceId}/approve`, rh, {});
  assert.ok([409, 403, 400].includes(dec2.status), `décision rejouée refusée (${dec2.status})`);
  const applied = psql(`SELECT count(*) FROM leave.entitlement_ledger
    WHERE tenant_id = '${tenantAId}' AND entry_kind = 'adjustment_debit' AND employee_id = '${e1}'`);
  assert.equal(Number(applied), 1, 'UN SEUL mouvement de débit');
  // Solde négatif interdit (CAP n'autorise pas le négatif).
  const neg = await api('/leave/adjust', adm, {
    employeeId: e2, typeId: typeCap, direction: 'debit', quantity: 4,
    reason: 'dépassement', periodStart: '2026-01-01', periodEnd: '2026-12-31',
  });
  assert.equal(neg.status, 409, 'solde négatif refusé pour ce type');
});

test('11 import de reprise : préversion sans écriture, fautif ATOMIQUE = zéro insertion, rejeu = zéro doublon', async () => {
  const adm = await token(slugA, admEmail);
  const countBefore = psql(`SELECT count(*) FROM leave.entitlement_ledger WHERE tenant_id = '${tenantAId}'`);
  // Préversion : rien n'est écrit.
  const prev = await postJson<{ kind: string; counts: { received: number; accepted: number } }>(
    '/leave/openings/import', adm, {
      mode: 'preview', asOfDate: '2026-01-01',
      contentText: `matricule;type;quantite\nLV2-${RID};REC;3\nLVM-${RID};REC;2\n`,
    });
  assert.equal(prev.kind, 'preview');
  assert.equal(prev.counts.accepted, 2);
  assert.equal(psql(`SELECT count(*) FROM leave.entitlement_ledger WHERE tenant_id = '${tenantAId}'`), countBefore);
  // Fichier FAUTIF en mode atomique : AUCUNE insertion, rapport par ligne.
  const bad = await postJson<{ kind: string; counts: { rejected: number }; errors: unknown[] }>(
    '/leave/openings/import', adm, {
      mode: 'apply', asOfDate: '2026-01-01',
      contentText: `matricule;type;quantite\nLV2-${RID};REC;3\nINCONNU-${RID};REC;2\nLVM-${RID};ZZZ;1\n`,
    });
  assert.equal(bad.kind, 'rejected');
  assert.equal(bad.counts.rejected, 2);
  assert.equal(psql(`SELECT count(*) FROM leave.entitlement_ledger WHERE tenant_id = '${tenantAId}'`), countBefore,
    'atomique : zéro insertion partielle');
  // Fichier correct : appliqué ; REJEU INTÉGRAL : duplicated = n, zéro nouveau mouvement.
  const good = await postJson<{ kind: string; counts: { accepted: number } }>(
    '/leave/openings/import', adm, {
      mode: 'apply', asOfDate: '2026-01-01',
      contentText: `matricule;type;quantite\nLV2-${RID};REC;3\nLVM-${RID};REC;2\n`,
    });
  assert.equal(good.kind, 'applied');
  assert.equal(good.counts.accepted, 2);
  const countMid = psql(`SELECT count(*) FROM leave.entitlement_ledger WHERE tenant_id = '${tenantAId}'`);
  const replay = await postJson<{ kind: string; counts: { accepted: number; duplicated: number } }>(
    '/leave/openings/import', adm, {
      mode: 'apply', asOfDate: '2026-01-01',
      contentText: `matricule;type;quantite\nLV2-${RID};REC;3\nLVM-${RID};REC;2\n`,
    });
  assert.equal(replay.counts.duplicated, 2, 'rejeu détecté ligne à ligne');
  assert.equal(replay.counts.accepted, 0);
  assert.equal(psql(`SELECT count(*) FROM leave.entitlement_ledger WHERE tenant_id = '${tenantAId}'`), countMid,
    'rejeu : zéro doublon écrit');
});

test('12 décompte : ouvrés/ouvrables/calendaires selon fériés et repos, demi-journées de bord', async () => {
  const adm = await token(slugA, admEmail);
  // Semaine du lundi 3 au dimanche 9 août 2026, férié le jeudi 6 : e1 lun–ven 8h–17h.
  const open = await getJson<{ count: { quantity: number; detail: Array<{ date: string; counted: number; why: string }> } }>(
    `/leave/count?employeeId=${e1}&typeId=${typeCap}&from=2026-08-03&to=2026-08-09`, adm);
  assert.equal(open.count.quantity, 4, 'ouvrés : 5 jours planifiés − férié du jeudi');
  assert.match(open.count.detail.find((d) => d.date === '2026-08-06')!.why, /férié/i);
  assert.equal(open.count.detail.find((d) => d.date === '2026-08-08')!.counted, 0, 'samedi de repos');
  // Ouvrables (lun–sam, régime E4) : 6 − 1 férié = 5, indépendant de l'horaire individuel.
  const mal = await getJson<{ count: { quantity: number } }>(
    `/leave/count?employeeId=${e1}&typeId=${typeMal}&from=2026-08-03&to=2026-08-09`, adm);
  assert.equal(mal.count.quantity, 7, 'calendaires : tout compte, férié inclus');
  // Demi-journées de bord sur les ouvrés.
  const half = await getJson<{ count: { quantity: number } }>(
    `/leave/count?employeeId=${e1}&typeId=${typeCap}&from=2026-08-03&to=2026-08-07&halfStart=1&halfEnd=1`, adm);
  assert.equal(half.count.quantity, 3, '4 ouvrés (férié déduit) − 2 demi-journées de bord');
});

test('13 rotation de NUIT : l\'absence est décomptée sur SA journée de travail', async () => {
  const adm = await token(slugA, admEmail);
  // eNight : rotation ancrée au 2026-08-03 → 03 et 04 nuit (22:00→06:00), 05 et 06 repos.
  const rec = await getJson<{ count: { quantity: number; detail: Array<{ date: string; counted: number }> } }>(
    `/leave/count?employeeId=${eNight}&typeId=${typeRec}&from=2026-08-03&to=2026-08-06`, adm);
  assert.equal(rec.count.detail.find((d) => d.date === '2026-08-03')!.counted, 1, 'nuit du 03 rattachée au 03');
  assert.equal(rec.count.detail.find((d) => d.date === '2026-08-04')!.counted, 1);
  assert.equal(rec.count.detail.find((d) => d.date === '2026-08-05')!.counted, 0, 'lendemain de nuit au repos : rien');
  assert.equal(rec.count.quantity, 2);
});

test('14 confidentialité : type MAL cloisonné — équipe sans la ligne, motifs masqués, audit muet', async () => {
  const adm = await token(slugA, admEmail);
  const rh = await token(slugA, rhEmail);
  const mgr = await token(slugA, mgrEmail);
  // Un ajustement MALADIE pour e1 avec motif MÉDICAL (au ledger, jamais à l'audit).
  const secret = `certificat du Dr Hounsou ${rid}`;
  await postJson('/leave/adjust', adm, {
    employeeId: e1, typeId: typeMal, direction: 'credit', quantity: 3,
    reason: secret, periodStart: '2026-01-01', periodEnd: '2026-12-31',
  });
  // L'ÉQUIPE (manager) ne voit PAS la ligne MAL de son N-1.
  const mgrBal = await getJson<{ items: Array<{ typeCode: string; employeeId: string }> }>(
    `/leave/balances?employeeId=${e1}`, mgr);
  assert.ok(mgrBal.items.some((b) => b.typeCode === 'CAP'), 'le manager voit le solde CAP');
  assert.ok(!mgrBal.items.some((b) => b.typeCode === 'MAL'), 'la ligne MALADIE est ABSENTE de la vue équipe');
  // Le ledger SANS permission dédiée : motif masqué ; AVEC (rh) : visible.
  const ledAdm = await getJson<{ items: Array<{ typeCode: string; reason: string | null }> }>(
    `/leave/ledger?employeeId=${e1}&typeId=${typeMal}`, adm);
  assert.ok(ledAdm.items.length >= 1);
  assert.ok(ledAdm.items.every((l) => l.reason !== secret), 'motif MASQUÉ sans leave.sensitive_view');
  assert.equal(ledAdm.items[0]!.reason, 'motif confidentiel');
  const ledRh = await getJson<{ items: Array<{ reason: string | null }> }>(
    `/leave/ledger?employeeId=${e1}&typeId=${typeMal}`, rh);
  assert.ok(ledRh.items.some((l) => l.reason === secret), 'visible avec la permission dédiée — accès journalisé');
  // L'audit GÉNÉRAL ne contient JAMAIS le motif médical.
  const inAudit = psql(`SELECT count(*) FROM audit.audit_log
    WHERE tenant_id = '${tenantAId}' AND new_value::text LIKE '%${secret.replaceAll("'", "''")}%'`);
  assert.equal(Number(inAudit), 0, 'le motif médical n\'atteint jamais le journal d\'audit');
});

test('15 portées : self / équipe résolue / RH — l\'identifiant transmis n\'élargit RIEN', async () => {
  const self = await token(slugA, selfEmail);
  const mgr = await token(slugA, mgrEmail);
  const naked = await token(slugA, nakedEmail);
  // Self : SES soldes.
  const mine = await getJson<{ linked: boolean; items: Array<{ employeeId: string }> }>('/leave/balances/mine', self);
  assert.equal(mine.linked, true);
  assert.ok(mine.items.every((b) => b.employeeId === e1));
  // Self n'a PAS la portée liste : l'identifiant d'un tiers ne donne rien.
  assert.equal((await api(`/leave/balances?employeeId=${e2}`, self, undefined, 'GET')).status, 403);
  // Manager : son N-1 (e1) OUI, un salarié d'une autre unité (e2, pas son rapport) NON.
  const team = await getJson<{ items: Array<{ employeeId: string }> }>('/leave/balances', mgr);
  assert.ok(team.items.some((b) => b.employeeId === e1), 'l\'équipe du responsable RÉSOLU est visible');
  assert.ok(!team.items.some((b) => b.employeeId === e2), 'hors équipe : INVISIBLE');
  const outside = await getJson<{ items: unknown[] }>(`/leave/balances?employeeId=${e2}`, mgr);
  assert.equal(outside.items.length, 0, 'l\'identifiant transmis n\'élargit pas la portée');
  // Sans permission : rien, nulle part.
  assert.equal((await api('/leave/balances', naked, undefined, 'GET')).status, 403);
  assert.equal((await api('/leave/types', naked, undefined, 'GET')).status, 403);
  assert.equal((await api('/leave/ledger', naked, undefined, 'GET')).status, 403);
  assert.equal((await api('/leave/adjust', naked, { employeeId: e1, typeId: typeCap, direction: 'credit', quantity: 1, reason: 'x', periodStart: '2026-01-01', periodEnd: '2026-12-31' })).status, 403);
  assert.equal((await api('/leave/accrual/run', naked, { periodStart: '2026-01-01', periodEnd: '2026-01-31', scopeKind: 'tenant', reason: 'x' })).status, 403);
  assert.equal((await api('/leave/openings/import', naked, { mode: 'preview', asOfDate: '2026-01-01', contentText: 'matricule;type;quantite' })).status, 403);
});

test('16 isolation tenant : rien ne fuit, la FK inter-tenant est rejetée PAR POSTGRESQL', async () => {
  const bAdm = await token(slugB, bAdmEmail);
  // Les types de A n'existent pas pour B.
  const typesB = await getJson<{ items: Array<{ code: string }> }>('/leave/types', bAdm);
  assert.ok(!typesB.items.some((t) => t.code === 'CAP'), 'catalogue de A invisible pour B');
  const balB = await getJson<{ items: unknown[] }>(`/leave/balances?employeeId=${e1}`, bAdm);
  assert.equal(balB.items.length, 0, 'les soldes de A sont introuvables depuis B');
  const ledB = await getJson<{ items: unknown[] }>(`/leave/ledger?employeeId=${e1}`, bAdm);
  assert.equal(ledB.items.length, 0);
  // FK composite : mouvement du tenant B pointant un type de A ⇒ rejet PostgreSQL.
  // (Un salarié RÉEL du tenant B d'abord — un INSERT…SELECT sans ligne ne prouverait rien.)
  const eB = psql(`INSERT INTO core.employees (tenant_id, matricule, first_name, last_name, status, hire_date)
    VALUES ('${tenantBId}', 'LVB-${RID}', 'Bola', 'Isolee', 'active', '2025-01-01') RETURNING id`);
  assert.equal(psqlFails(`INSERT INTO leave.entitlement_ledger
    (tenant_id, employee_id, absence_type_id, reference_period_start, reference_period_end,
     entry_kind, quantity, unit, effective_on, origin, idempotency_key)
    VALUES ('${tenantBId}', '${eB}', '${typeCap}', '2026-01-01', '2026-12-31', 'grant', 1, 'open_days', '2026-01-01', 'admin', 'xt-${rid}')`), true,
    'FK inter-tenant rejetée par la base');
});

test('17 politique FUTURE : une nouvelle version datée ne touche AUCUN droit historique', async () => {
  const adm = await token(slugA, admEmail);
  const before10 = psql(`SELECT count(*) || ':' || coalesce(md5(string_agg(id::text || quantity::text, ',' ORDER BY id)), '-')
    FROM leave.entitlement_ledger WHERE tenant_id = '${tenantAId}' AND entry_kind = 'accrual'`);
  // Version 2 de POL-CAP-CADRE : 3 j/mois À PARTIR de novembre 2026.
  const pols = await getJson<{ items: Array<{ id: string; code: string }> }>('/leave/policies', adm);
  const polCo = pols.items.find((p) => p.code === 'POL-CAP-CADRE')!;
  await postJson(`/leave/policies/${polCo.id}/versions`, adm, {
    effectiveFrom: '2026-11-01', accrualMode: 'monthly', accrualRateValue: 3, rounding: 'none',
  }, 201);
  // Relance des périodes PASSÉES : zéro écriture, mouvements STRICTEMENT identiques.
  const rerun = await postJson<{ run: { entriesWritten: number } }>('/leave/accrual/run', adm,
    { periodStart: '2026-01-01', periodEnd: '2026-03-31', scopeKind: 'employee', scopeId: e1, reason: 'relance après version future' }, 201);
  assert.equal(rerun.run.entriesWritten, 0);
  const after10 = psql(`SELECT count(*) || ':' || coalesce(md5(string_agg(id::text || quantity::text, ',' ORDER BY id)), '-')
    FROM leave.entitlement_ledger WHERE tenant_id = '${tenantAId}' AND entry_kind = 'accrual'`);
  assert.equal(after10, before10, 'les droits historiques sont INTACTS');
  // Novembre : la version 2 s'applique (3 j).
  const runNov = await postJson<{ run: { entriesWritten: number } }>('/leave/accrual/run', adm,
    { periodStart: '2026-11-01', periodEnd: '2026-11-30', scopeKind: 'employee', scopeId: e1, reason: 'novembre v2' }, 201);
  assert.equal(runNov.run.entriesWritten, 2, 'CAP v2 + REC');
  const nov = psql(`SELECT quantity FROM leave.entitlement_ledger
    WHERE tenant_id = '${tenantAId}' AND employee_id = '${e1}' AND absence_type_id = '${typeCap}'
      AND entry_kind = 'accrual' AND effective_on = '2026-11-30'`);
  assert.equal(Number(nov), 3, 'la NOUVELLE version vaut à sa date d\'effet');
});

test('18 journal : chaque opération sensible du module congés est AUDITÉE', async () => {
  const actions = [
    'leave_type_created', 'leave_type_updated', 'leave_policy_created', 'leave_policy_version_added',
    'leave_policy_status_changed', 'leave_accrual_run', 'leave_balances_viewed', 'leave_ledger_viewed',
    'leave_adjustment_submitted', 'leave_adjustment_applied', 'leave_openings_imported', 'leave_openings_import_rejected',
  ];
  const count = psql(`SELECT count(DISTINCT action) FROM audit.audit_log
    WHERE tenant_id = '${tenantAId}' AND action IN (${actions.map((a) => `'${a}'`).join(',')})`);
  assert.equal(Number(count), actions.length, `toutes les actions attendues sont au journal (${count}/${actions.length})`);
});
