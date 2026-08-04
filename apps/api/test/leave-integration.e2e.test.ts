/**
 * E2E Congés E11.3 — intégration Présence, clôture, préparation paie, reporting :
 * une absence APPLIQUÉE change le RÉSULTAT de présence sans toucher un seul
 * pointage brut, un ancien résultat ni une clôture ; rotation de nuit sur SA
 * journée ; demi-journée et heures bornées au planifié ; application rejouée
 * SANS double impact ; rejet sans effet E10 ; annulation ⇒ faits SUPERSÉDÉS +
 * recalcul (l'histoire demeure) ; rétroactif sur période E10 close ⇒ impact EN
 * ATTENTE, réouverture E10.3 réelle, reprise, re-clôture ; anomalies expliquées
 * résolues avec référence ; clôture congés (contrôles, gel, empreinte SHA-256
 * REPRODUCTIBLE, concurrence exclue, mouvements rétroactifs refusés PAR LA
 * BASE, réouverture versionnée) ; exports kora-conges-prep-1 idempotents,
 * immuables, SANS montant ni code de type confidentiel ; reporting agrégé borné
 * aux portées ; tenant B étanche.
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
const slugA = `lx-a-${rid}`;
const slugB = `lx-b-${rid}`;
const admEmail = `lxadm.${rid}@demo.bj`;    // administration complète (SANS sensitive_view)
const rhEmail = `lxrh.${rid}@demo.bj`;      // rôle rh-lx : approbateur des circuits E11.3
const selfEmail = `lxself.${rid}@demo.bj`;  // salarié e1 (ESS + rétroactif)
const self2Email = `lxself2.${rid}@demo.bj`;// salarié e2 (rotation de nuit)
const scopedEmail = `lxscope.${rid}@demo.bj`; // rapporteur À PORTÉE (unité RH seulement)
const nakedEmail = `lxnone.${rid}@demo.bj`;
const bAdmEmail = `lxbadm.${rid}@demo.bj`;

let app: INestApplication;
let base = '';
let tenantAId = '';
let tenantBId = '';
let coA = '', siteA = '', uRh = '', uIt = '';
let e1 = '', e2 = '', e3 = '';
let typeCap = '', typeHor = '', typeMal = '';
let reqSept = '';        // demande CAP e1 07–11/09 (application nominale)
let absSept = '';        // absence correspondante
let leavePeriodSept = '';
let closeId1 = '', closeId2 = '';
let fingerprint1 = '';

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
  tenantAId = psql(`INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('${slugA}','LX A',true) RETURNING id`);
  tenantBId = psql(`INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('${slugB}','LX B',true) RETURNING id`);
  await seedUser(tenantAId, admEmail, [
    'org.view', 'org.manage', 'employees.view', 'employees.manage', 'employees.assign',
    'time.schedules_view', 'time.schedules_manage', 'time.schedules_assign',
    'time.punches_import', 'time.punches_view', 'time.devices_manage',
    'time.calc_run', 'time.calc_recalc', 'time.calc_view', 'time.results_view', 'time.anomalies_view', 'time.anomalies_manage',
    'time.period_manage', 'time.period_close', 'time.period_reopen', 'time.preclose_view',
    'workflow.manage', 'workflow.view', 'notify.manage', 'audit.view', 'parameters.view',
    'leave.types_admin', 'leave.policies_admin', 'leave.accrual_run', 'leave.balance_view',
    'leave.ledger_view', 'leave.balance_adjust', 'leave.requests_admin', 'leave.request_for_others',
    'leave.period_manage', 'leave.close_run', 'leave.close_view', 'leave.reopen',
    'leave.export_create', 'leave.export_download', 'leave.reports_view', 'leave.integration_run',
  ], true);
  await seedUser(tenantAId, rhEmail, [
    'leave.requests_admin', 'workflow.view', 'workflow.act',
  ], true, 'rh-lx');
  await seedUser(tenantAId, selfEmail, [
    'leave.request_self', 'leave.requests_view_own', 'leave.balance_view_own', 'leave.request_retroactive',
    'leave.request_cancel_approved',
  ], true);
  await seedUser(tenantAId, self2Email, ['leave.request_self', 'leave.requests_view_own'], true);
  const scopedId = await seedUser(tenantAId, scopedEmail, ['leave.reports_view'], false);
  psql(`INSERT INTO admin.user_scopes (tenant_id, user_id, scope_type, scope_ref)
        SELECT '${tenantAId}', '${scopedId}', 'department', NULL`); // portée posée au test 01 (unité connue)
  await seedUser(tenantAId, nakedEmail, ['employees.view'], true);
  await seedUser(tenantBId, bAdmEmail, [
    'leave.close_view', 'leave.close_run', 'leave.period_manage', 'leave.export_download', 'leave.reports_view',
  ], true);

  for (const [key, value, from] of [
    ['conges.acquisition.taux_mensuel', '2', '2020-01-01'],
    ['conges.ouvrables.jours', '[1,2,3,4,5,6]', '2020-01-01'],
    ['temps.fuseau.defaut', '"Africa/Porto-Novo"', '2020-01-01'],
    ['temps.tolerance.retard', '10', '2020-01-01'],
  ] as const) {
    psql(`INSERT INTO compliance.legal_parameters
            (tenant_id, country_code, key, value, effective_from, status, is_legal_sensitive,
             confidence, source_text, verified_by, verified_at)
          VALUES ('${tenantAId}', 'BJ', '${key}', '${value}', '${from}', 'active', false,
                  'verified', 'fixture e2e E11.3', 'fixture-e2e', '2026-01-01')`);
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
async function punch(adm: string, employeeId: string, dateTime: string, eventType: string): Promise<void> {
  const r = await api('/time/punches/manual', adm, {
    employeeId, dateTime, eventType, siteId: siteA, note: 'fixture E11.3',
  });
  assert.equal(r.status, 201, `pointage ${dateTime} ${eventType} → ${r.status} ${await r.text().catch(() => '')}`);
}
/** Demande CAP créée + soumise + approuvée (circuit rh-lx à une étape) + appliquée. */
async function approvedRequest(tok: string, rh: string, body: Record<string, unknown>): Promise<{ requestId: string; absenceId: string }> {
  const id = (await postJson<{ id: string }>('/leave/requests', tok, body, 201)).id;
  await postJson(`/leave/requests/${id}/submit`, tok, undefined);
  const decided = await postJson<{ status: string; applied?: boolean }>(
    `/leave/requests/${id}/decide`, rh, { action: 'approve' });
  assert.equal(decided.status, 'approved');
  const absenceId = psql(`SELECT id FROM leave.absences WHERE request_id = '${id}' ORDER BY applied_at DESC LIMIT 1`);
  return { requestId: id, absenceId };
}
const factCount = (where: string): number =>
  Number(psql(`SELECT count(*) FROM time.absence_facts WHERE tenant_id = '${tenantAId}' AND ${where}`));

// ---------------------------------------------------------------------------

test('01 fixtures : org, salariés, horaires jour/nuit, pointages BRUTS, droits, circuits E11.3', async () => {
  const adm = await token(slugA, admEmail);
  coA = await created('/org/companies', adm, { code: `LXCO-${RID}`, labelFr: 'Société LX', labelEn: 'LX Co' });
  psql(`UPDATE org.companies SET status = 'active' WHERE id = '${coA}'`);
  siteA = await created('/org/sites', adm, { code: `LXSITE-${RID}`, labelFr: 'Site LX', labelEn: 'LX Site', companyId: coA });
  psql(`UPDATE org.sites SET status = 'active', time_zone = 'Africa/Porto-Novo' WHERE id = '${siteA}'`);
  uRh = await created('/org/units', adm, { unitType: 'department', code: `LXRH-${RID}`, labelFr: 'RH', labelEn: 'HR', companyId: coA });
  uIt = await created('/org/units', adm, { unitType: 'department', code: `LXIT-${RID}`, labelFr: 'IT', labelEn: 'IT', companyId: coA });
  psql(`UPDATE org.units SET status = 'active' WHERE id IN ('${uRh}','${uIt}')`);
  psql(`UPDATE admin.user_scopes SET scope_ref = '${uRh}'
         WHERE user_id = (SELECT id FROM admin.users WHERE email = '${scopedEmail}') AND scope_type = 'department'`);

  const mk = async (mat: string, first: string, unit: string): Promise<string> => {
    const res = await api('/employees', adm, { matricule: mat, firstName: first, lastName: 'Integ', hireDate: '2025-01-01' });
    const text = await res.text();
    assert.equal(res.status, 201, text);
    const id = (JSON.parse(text) as { id: string }).id;
    psql(`UPDATE core.employees SET status = 'active' WHERE id = '${id}'`);
    assert.equal((await api(`/employees/${id}/assignments`, adm, {
      companyId: coA, siteId: siteA, unitId: unit, effectiveFrom: '2025-01-01', isPrimary: true,
    })).status, 201);
    return id;
  };
  e1 = await mk(`LX1-${RID}`, 'Awa', uRh);
  e2 = await mk(`LX2-${RID}`, 'Nuit', uIt);
  e3 = await mk(`LX3-${RID}`, 'Cira', uRh);
  for (const [em, emp] of [[selfEmail, e1], [self2Email, e2]] as const) {
    psql(`UPDATE core.employees SET user_id = (SELECT id FROM admin.users WHERE email = '${em}') WHERE id = '${emp}'`);
  }

  const dayModel = await created('/time/schedules/models', adm, { code: `LXJ-${RID}`, labelFr: 'Jour', labelEn: 'Day', kind: 'fixed' });
  await postJson(`/time/schedules/models/${dayModel}/versions`, adm, {
    effectiveFrom: '2025-01-06', cycleDays: 7,
    days: [0, 1, 2, 3, 4].map((i) => ({ dayIndex: i, isRest: false, startMinute: 480, endMinute: 1020, breakStartMinute: 720, breakEndMinute: 780 }))
      .concat([{ dayIndex: 5, isRest: true }, { dayIndex: 6, isRest: true }] as never[]),
  }, 201);
  for (const emp of [e1, e3]) {
    await postJson('/time/schedules/assignments', adm, { employeeId: emp, modelId: dayModel, anchorDate: '2026-01-05', effectiveFrom: '2025-01-06' }, 201);
  }
  const nightModel = await created('/time/schedules/models', adm, { code: `LXN-${RID}`, labelFr: 'Nuit', labelEn: 'Night', kind: 'rotation' });
  await postJson(`/time/schedules/models/${nightModel}/versions`, adm, {
    effectiveFrom: '2025-01-06', cycleDays: 4,
    days: [
      { dayIndex: 0, isRest: false, startMinute: 1320, endMinute: 1800 },
      { dayIndex: 1, isRest: false, startMinute: 1320, endMinute: 1800 },
      { dayIndex: 2, isRest: true }, { dayIndex: 3, isRest: true },
    ],
  }, 201);
  await postJson('/time/schedules/assignments', adm, { employeeId: e2, modelId: nightModel, anchorDate: '2026-08-31', effectiveFrom: '2025-01-06' }, 201);

  // Pointages BRUTS de e1 (semaine du 7/09) : lundi complet, mardi entrée SANS sortie.
  await punch(adm, e1, '2026-09-07 08:00', 'E');
  await punch(adm, e1, '2026-09-07 17:00', 'S');
  await punch(adm, e1, '2026-09-08 08:00', 'E');

  // Types : CAP (congé payé), HOR (heures, mission/formation), MAL (confidentiel, maladie).
  typeCap = await created('/leave/types', adm, {
    code: 'CAP', labelFr: 'Congé annuel payé', labelEn: 'Paid annual leave',
    category: 'legal', paid: true, unit: 'open_days', retroactiveAllowed: true, prepCategory: 'conge_paye',
  });
  typeHor = await created('/leave/types', adm, {
    code: 'HOR', labelFr: 'Absence en heures', labelEn: 'Hourly leave',
    category: 'internal', paid: false, unit: 'hours', negativeAllowed: true, prepCategory: 'mission_formation',
  });
  typeMal = await created('/leave/types', adm, {
    code: 'MAL', labelFr: 'Maladie', labelEn: 'Sickness', category: 'legal', paid: true,
    unit: 'calendar_days', confidential: true, negativeAllowed: true, prepCategory: 'maladie',
  });
  for (const t of [typeCap, typeHor, typeMal]) await postJson(`/leave/types/${t}`, adm, { status: 'active' });
  const polCap = await created('/leave/policies', adm, {
    absenceTypeId: typeCap, code: 'POL-CAP', labelFr: 'Politique CAP', labelEn: 'CAP policy', countryCode: 'BJ',
  });
  await postJson(`/leave/policies/${polCap}/versions`, adm, {
    effectiveFrom: '2025-01-01', accrualMode: 'monthly', accrualRateParam: 'conges.acquisition.taux_mensuel',
    referencePeriod: 'calendar_year', rounding: 'half_up_0_5',
  }, 201);
  await postJson(`/leave/policies/${polCap}/status`, adm, { status: 'active' });
  for (const [ty, code] of [[typeHor, 'POL-HOR'], [typeMal, 'POL-MAL']] as const) {
    const pol = await created('/leave/policies', adm, {
      absenceTypeId: ty, code, labelFr: code, labelEn: code,
    });
    await postJson(`/leave/policies/${pol}/versions`, adm, { effectiveFrom: '2025-01-01', accrualMode: 'none' }, 201);
    await postJson(`/leave/policies/${pol}/status`, adm, { status: 'active' });
  }
  const run = await postJson<{ run: { status: string } }>('/leave/accrual/run', adm, {
    periodStart: '2026-01-01', periodEnd: '2026-06-30', scopeKind: 'tenant', reason: 'droits S1 (fixture E11.3)',
  }, 201);
  assert.match(run.run.status, /^completed/);

  const mkCircuit = async (key: string): Promise<void> => {
    const def = await api('/workflow/definitions', adm, {
      key, name: `Circuit ${key}`,
      steps: [{ index: 0, name: 'RH', approverType: 'role', approverRef: 'rh-lx' }],
    });
    const defText = await def.text();
    assert.equal(def.status, 201, defText);
    assert.equal((await api(`/workflow/definitions/${(JSON.parse(defText) as { id: string }).id}/activate`, adm)).status, 200);
  };
  for (const key of ['conges_demande', 'conges_demande_retro', 'conges_demande_sensible',
    'conges_annulation', 'conges_periode_reouverture', 'temps_reouverture']) {
    await mkCircuit(key);
  }
  // Calcul E10 initial de la semaine du 7/09 (résultats AVANT absence).
  const calc = await postJson<{ run: { status: string } }>('/time/calc/run', adm, {
    periodStart: '2026-09-07', periodEnd: '2026-09-13', scopeKind: 'tenant', reason: 'base présence (fixture E11.3)',
  }, 201);
  assert.match(calc.run.status, /^completed/);
});

test('02 application : FAITS posés par journée décomptée, recalcul AUTOMATIQUE, résultat justifié — bruts et anciennes versions INTACTS', async () => {
  const self = await token(slugA, selfEmail);
  const rh = await token(slugA, rhEmail);
  const rawBefore = psql(`SELECT md5(string_agg(id::text || '|' || coalesce(occurred_at::text,''), ',' ORDER BY id))
    FROM time.punch_events WHERE tenant_id = '${tenantAId}'`);
  // Mercredi–vendredi 09–11/09 : 3 jours ouvrés (aucun pointage ces jours-là).
  const out = await approvedRequest(self, rh, {
    typeId: typeCap, startDate: '2026-09-09', endDate: '2026-09-11', comment: 'septembre',
  });
  reqSept = out.requestId;
  absSept = out.absenceId;
  assert.equal(factCount(`absence_id = '${absSept}' AND status = 'active'`), 3, 'un fait par journée DÉCOMPTÉE');
  assert.equal(factCount(`absence_id = '${absSept}' AND work_date IN ('2026-09-12','2026-09-13')`), 0, 'jamais un fait sur un jour de repos');
  // Le recalcul automatique a couru : la journée est QUALIFIÉE sur la version courante.
  assert.equal(psql(`SELECT presence_impact FROM leave.absences WHERE id = '${absSept}'`), 'applied');
  const day = psql(`SELECT day_status || '|' || justified_category || '|' || justified_minutes || '|' || worked_minutes
    FROM time.day_results WHERE employee_id = '${e1}' AND work_date = '2026-09-09' AND is_current`);
  assert.equal(day, 'absent|conge_paye|480|0', 'absence JUSTIFIÉE : statut inchangé, catégorie posée, rien d’inventé');
  // L'ancienne version (absent NON justifié) DEMEURE.
  assert.equal(psql(`SELECT count(*) FROM time.day_results
    WHERE employee_id = '${e1}' AND work_date = '2026-09-09' AND is_current = false
      AND justified_category IS NULL`), '1', 'l’ancien résultat n’est jamais réécrit');
  // Les pointages BRUTS n'ont pas bougé d'un octet.
  const rawAfter = psql(`SELECT md5(string_agg(id::text || '|' || coalesce(occurred_at::text,''), ',' ORDER BY id))
    FROM time.punch_events WHERE tenant_id = '${tenantAId}'`);
  assert.equal(rawAfter, rawBefore, 'pointages bruts INTACTS');
});

test('03 application REJOUÉE : aucun double impact — faits, mouvements et versions inchangés', async () => {
  const self = await token(slugA, selfEmail);
  const factsBefore = factCount(`absence_id = '${absSept}'`);
  const versionsBefore = psql(`SELECT count(*) FROM time.day_results WHERE employee_id = '${e1}' AND work_date = '2026-09-09'`);
  await postJson(`/leave/requests/${reqSept}/apply`, self, undefined);
  assert.equal(factCount(`absence_id = '${absSept}'`), factsBefore, 'rejeu : AUCUN fait supplémentaire');
  assert.equal(Number(psql(`SELECT count(*) FROM leave.entitlement_ledger
    WHERE request_id = '${reqSept}' AND entry_kind = 'consumption'`)), 1, 'UNE consommation, toujours');
  assert.equal(psql(`SELECT count(*) FROM time.day_results WHERE employee_id = '${e1}' AND work_date = '2026-09-09'`),
    versionsBefore, 'recalcul idempotent : aucune nouvelle version sans changement');
});

test('04 rotation de NUIT : les faits vivent sur les journées TRAVAILLÉES de la rotation', async () => {
  const self2 = await token(slugA, self2Email);
  const rh = await token(slugA, rhEmail);
  // Rotation ancrée 31/08 (cycle 4) : 31/08 et 01/09 travaillés, 02–03/09 repos.
  const { absenceId } = await approvedRequest(self2, rh, {
    typeId: typeCap, startDate: '2026-08-31', endDate: '2026-09-01',
  });
  assert.equal(factCount(`absence_id = '${absenceId}'`), 2);
  assert.equal(factCount(`absence_id = '${absenceId}' AND work_date IN ('2026-08-31','2026-09-01') AND status = 'active'`), 2,
    'chaque nuit sur SA journée de travail');
  const night = psql(`SELECT justified_category FROM time.day_results
    WHERE employee_id = '${e2}' AND work_date = '2026-08-31' AND is_current`);
  assert.equal(night, 'conge_paye');
});

test('05 demi-journée et HEURES : décomptées, bornées au planifié, catégorisées', async () => {
  const self = await token(slugA, selfEmail);
  const rh = await token(slugA, rhEmail);
  // Demi-journée CAP le lundi 14/09 (aucun pointage ce jour).
  const half = await approvedRequest(self, rh, {
    typeId: typeCap, startDate: '2026-09-14', endDate: '2026-09-14', halfDayStart: true,
  });
  const halfFact = psql(`SELECT portion || '|' || counted FROM time.absence_facts WHERE absence_id = '${half.absenceId}'`);
  assert.equal(halfFact, 'half|0.500');
  assert.equal(psql(`SELECT justified_minutes FROM time.day_results
    WHERE employee_id = '${e1}' AND work_date = '2026-09-14' AND is_current`), '240', 'demi-journée = moitié du planifié');
  // Heures : 4 h le mardi 15/09 (HOR) — portion « hours », 240 minutes.
  const hourly = await approvedRequest(self, rh, {
    typeId: typeHor, startDate: '2026-09-15', endDate: '2026-09-15', hours: 4,
  });
  const hourFact = psql(`SELECT portion || '|' || minutes FROM time.absence_facts WHERE absence_id = '${hourly.absenceId}'`);
  assert.equal(hourFact, 'hours|240');
  assert.equal(psql(`SELECT justified_category || '|' || justified_minutes FROM time.day_results
    WHERE employee_id = '${e1}' AND work_date = '2026-09-15' AND is_current`), 'mission_formation|240');
});

test('06 anomalie EXPLIQUÉE : la sortie manquante d’une demi-journée autorisée se résout avec référence — pointages intacts', async () => {
  const self = await token(slugA, selfEmail);
  const rh = await token(slugA, rhEmail);
  // Mardi 08/09 : entrée 08:00 SANS sortie (fixture 01) ⇒ anomalie missing_out OUVERTE.
  const anomaly = psql(`SELECT count(*) FROM time.day_anomalies
    WHERE employee_id = '${e1}' AND work_date = '2026-09-08' AND code = 'missing_out' AND state = 'open'`);
  assert.equal(anomaly, '1', 'la sortie manquante est bien ouverte avant l’absence');
  // Demi-journée d'après-midi APPROUVÉE : elle explique la sortie manquante.
  const { absenceId } = await approvedRequest(self, rh, {
    typeId: typeCap, startDate: '2026-09-08', endDate: '2026-09-08', halfDayEnd: true,
  });
  const resolved = psql(`SELECT state || '|' || resolution_kind FROM time.day_anomalies
    WHERE employee_id = '${e1}' AND work_date = '2026-09-08' AND code = 'missing_out'
    ORDER BY id DESC LIMIT 1`);
  assert.equal(resolved, 'resolved|absence_applied', 'résolue par APPLICATION D’ABSENCE, référence probante');
  assert.ok(psql(`SELECT state_note FROM time.day_anomalies
    WHERE employee_id = '${e1}' AND work_date = '2026-09-08' AND code = 'missing_out'
    ORDER BY id DESC LIMIT 1`).includes(absenceId), 'la note référence l’absence');
  // Les pointages du jour n'ont pas bougé (aucune sortie inventée).
  assert.equal(psql(`SELECT count(*) FROM time.punch_events
    WHERE employee_id = '${e1}' AND local_date = '2026-09-08'`), '1');
});

test('07 demande REJETÉE : aucun fait, aucun effet E10', async () => {
  const self = await token(slugA, selfEmail);
  const rh = await token(slugA, rhEmail);
  const id = (await postJson<{ id: string }>('/leave/requests', self, {
    typeId: typeCap, startDate: '2026-09-21', endDate: '2026-09-22',
  }, 201)).id;
  await postJson(`/leave/requests/${id}/submit`, self, undefined);
  await postJson(`/leave/requests/${id}/decide`, rh, { action: 'reject', comment: 'refus test' });
  assert.equal(factCount(`request_id = '${id}'`), 0, 'aucun fait pour une demande rejetée');
  assert.equal(psql(`SELECT count(*) FROM time.day_results
    WHERE employee_id = '${e1}' AND work_date = '2026-09-21' AND justified_category IS NOT NULL`), '0');
});

test('08 ANNULATION d’une absence appliquée : faits SUPERSÉDÉS motivés, recalcul retire la qualification, l’histoire DEMEURE', async () => {
  const self = await token(slugA, selfEmail);
  const rh = await token(slugA, rhEmail);
  const adm = await token(slugA, admEmail);
  const out = await postJson<{ instanceId: string }>(`/leave/requests/${reqSept}/cancel-approved`, self,
    { reason: 'annulation septembre' });
  await postJson(`/workflow/instances/${out.instanceId}/approve`, rh, {});
  assert.equal(factCount(`absence_id = '${absSept}' AND status = 'superseded'`), 3, 'faits SUPERSÉDÉS, jamais supprimés');
  assert.equal(psql(`SELECT supersede_reason IS NOT NULL FROM time.absence_facts
    WHERE absence_id = '${absSept}' LIMIT 1`), 'true', 'supersession MOTIVÉE');
  assert.equal(psql(`SELECT presence_impact FROM leave.absences WHERE id = '${absSept}'`), 'superseded');
  // Reprise d'intégration : le recalcul retire la qualification sur une NOUVELLE version.
  const integ = await postJson<{ recalculated: number }>('/leave/integration/run', adm, {
    from: '2026-09-07', to: '2026-09-13',
  });
  assert.ok(integ.recalculated >= 1, 'recalcul de retrait effectué');
  assert.equal(psql(`SELECT justified_category IS NULL FROM time.day_results
    WHERE employee_id = '${e1}' AND work_date = '2026-09-09' AND is_current`), 'true', 'qualification retirée');
  assert.ok(Number(psql(`SELECT count(*) FROM time.day_results
    WHERE employee_id = '${e1}' AND work_date = '2026-09-09'`)) >= 3, 'toutes les versions DEMEURENT');
  // Le ledger porte le reversement (E11.2) — rien n'a été réécrit.
  assert.equal(psql(`SELECT count(*) FROM leave.entitlement_ledger
    WHERE request_id = '${reqSept}' AND entry_kind = 'reversal'`), '1');
});

test('09 RÉTROACTIF sur période E10 close : impact EN ATTENTE, réouverture E10.3 RÉELLE, reprise, re-clôture', async () => {
  const adm = await token(slugA, admEmail);
  const self = await token(slugA, selfEmail);
  const rh = await token(slugA, rhEmail);
  // Période de présence de JUILLET close (créée close : la clôture E10.3 elle-même est prouvée en E10.3).
  const timePeriod = psql(`INSERT INTO time.periods (tenant_id, scope_kind, label, period_start, period_end, status, created_by)
    VALUES ('${tenantAId}','tenant','LX-JUIL-2026','2026-07-01','2026-07-31','closed',
            (SELECT id FROM admin.users WHERE email = '${admEmail}')) RETURNING id`);
  // Demande rétroactive 06–07/07 (permission + circuit renforcé E11.2).
  const { requestId, absenceId } = await approvedRequest(self, rh, {
    typeId: typeCap, startDate: '2026-07-06', endDate: '2026-07-07', comment: 'régularisation juillet',
  });
  assert.equal(factCount(`absence_id = '${absenceId}' AND status = 'pending_closed_period'`), 2,
    'faits EN ATTENTE : aucune clôture modifiée automatiquement');
  assert.equal(psql(`SELECT presence_impact FROM leave.absences WHERE id = '${absenceId}'`), 'pending_closed_period');
  assert.equal(psql(`SELECT count(*) FROM time.day_results WHERE employee_id = '${e1}' AND work_date = '2026-07-06'`), '0',
    'aucun résultat créé derrière une clôture');
  // La reprise SANS réouverture ne fait rien (constat honnête).
  const still = await postJson<{ activated: number; stillPending: number }>('/leave/integration/run', adm, {
    from: '2026-07-01', to: '2026-07-31',
  });
  assert.equal(still.activated, 0);
  assert.ok(still.stillPending >= 2);
  // Réouverture E10.3 RÉELLE : circuit temps_reouverture, motif, approbation.
  await postJson(`/time/periods/${timePeriod}/reopen`, adm, { reason: 'absence rétroactive approuvée à intégrer' });
  const reopenInstance = psql(`SELECT id FROM workflow.instances
    WHERE subject_type = 'time_period_reopen' AND subject_id = '${timePeriod}' ORDER BY created_at DESC LIMIT 1`);
  await postJson(`/workflow/instances/${reopenInstance}/approve`, rh, {});
  assert.equal(psql(`SELECT status || '|' || revision FROM time.periods WHERE id = '${timePeriod}'`), 'reopened|2');
  // Reprise : faits ACTIVÉS, recalcul, qualification posée, impact APPLIQUÉ.
  const integ = await postJson<{ activated: number; integrated: number }>('/leave/integration/run', adm, {
    from: '2026-07-01', to: '2026-07-31',
  });
  assert.equal(integ.activated, 2);
  assert.equal(integ.integrated, 1);
  assert.equal(psql(`SELECT presence_impact FROM leave.absences WHERE id = '${absenceId}'`), 'applied');
  assert.equal(psql(`SELECT justified_category FROM time.day_results
    WHERE employee_id = '${e1}' AND work_date = '2026-07-06' AND is_current`), 'conge_paye');
  // Re-clôture E10.3 : recalcul de TOUTE la période (les salariés attendus ont
  // leurs résultats), verrouillage (cycle contrôlé), clôture — NOUVELLE empreinte.
  const julyCalc = await postJson<{ run: { status: string } }>('/time/calc/recalc', adm, {
    periodStart: '2026-07-01', periodEnd: '2026-07-31', scopeKind: 'tenant', reason: 'reprise juillet avant re-clôture',
  }, 201);
  assert.match(julyCalc.run.status, /^completed/);
  const preclose = await getJson<{ preclose: Record<string, unknown> }>(`/time/periods/${timePeriod}/preclose`, adm);
  assert.ok(preclose.preclose, 'contrôle de pré-clôture disponible');
  await postJson(`/time/periods/${timePeriod}/status`, adm, { status: 'locked' });
  const reclose = await postJson<{ close: { closeNo?: number; datasetSha256?: string } }>(
    `/time/periods/${timePeriod}/close`, adm, { confirmWarnings: true });
  assert.ok(reclose.close, 're-clôture effectuée — nouvelle empreinte produite');
  assert.equal(psql(`SELECT count(*) FROM time.period_closes WHERE period_id = '${timePeriod}'`), '1',
    'clôture E10 de révision 2 (la période créée close par fixture n’en portait aucune)');
  void requestId;
});

test('10 clôture CONGÉS : contrôles exhaustifs, gel des lignes, empreinte SHA-256, mouvements rétroactifs REFUSÉS par la base', async () => {
  const adm = await token(slugA, admEmail);
  leavePeriodSept = (await postJson<{ id: string }>('/leave/periods', adm, {
    label: `LXC-SEPT-${RID}`, periodStart: '2026-09-01', periodEnd: '2026-09-30',
  }, 201)).id;
  // Chevauchement refusé PAR LA BASE.
  assert.equal((await api('/leave/periods', adm, {
    label: 'CHEVAUCHE', periodStart: '2026-09-15', periodEnd: '2026-10-15',
  })).status, 409);
  // Une demande encore soumise ⇒ AVERTISSEMENT ; sans confirmation, la clôture refuse.
  const self2 = await token(slugA, self2Email);
  const pendingReq = (await postJson<{ id: string }>('/leave/requests', self2, {
    typeId: typeCap, startDate: '2026-09-28', endDate: '2026-09-29',
  }, 201)).id;
  await postJson(`/leave/requests/${pendingReq}/submit`, self2, undefined);
  const pre = await getJson<{ preclose: { blocking: unknown[]; warnings: Array<{ code: string }> } }>(
    `/leave/periods/${leavePeriodSept}/preclose`, adm);
  assert.equal(pre.preclose.blocking.length, 0, JSON.stringify(pre.preclose.blocking));
  assert.ok(pre.preclose.warnings.some((w) => w.code === 'pending_requests'));
  assert.ok(pre.preclose.warnings.some((w) => w.code === 'time_periods_open'));
  const refuse = await api(`/leave/periods/${leavePeriodSept}/close`, adm, {});
  assert.equal(refuse.status, 400, await refuse.text());
  const closed = await postJson<{ closeId: string; closeNo: number; fingerprint: string; linesCount: number }>(
    `/leave/periods/${leavePeriodSept}/close`, adm, { confirmWarnings: true });
  closeId1 = closed.closeId;
  fingerprint1 = closed.fingerprint;
  assert.equal(closed.closeNo, 1);
  assert.match(closed.fingerprint, /^[0-9a-f]{64}$/);
  assert.ok(closed.linesCount >= 3, 'lignes photographiées');
  // L'empreinte se RECALCULE depuis les lignes FIGÉES — identique.
  const verify = await getJson<{ stored: string; recomputed: string; match: boolean }>(
    `/leave/closes/${closeId1}/verify`, adm);
  assert.equal(verify.match, true);
  assert.equal(verify.stored, fingerprint1);
  // Les lignes correspondent EXACTEMENT au ledger (solde de clôture = somme des mouvements).
  const lineAvail = psql(`SELECT available FROM leave.close_lines
    WHERE close_id = '${closeId1}' AND employee_id = '${e1}' AND absence_type_id = '${typeCap}'`);
  const viewAvail = psql(`SELECT available FROM leave.balances_v
    WHERE employee_id = '${e1}' AND absence_type_id = '${typeCap}'`);
  assert.equal(lineAvail, viewAvail);
  // Mouvement ordinaire RÉTROACTIF dans la période close : REFUSÉ PAR LA BASE.
  assert.equal(psqlFails(`INSERT INTO leave.entitlement_ledger (tenant_id, employee_id, absence_type_id,
      reference_period_start, reference_period_end, entry_kind, quantity, unit, effective_on, origin, idempotency_key)
    VALUES ('${tenantAId}', '${e1}', '${typeCap}', '2026-01-01', '2026-12-31', 'adjustment_credit', 1,
            'open_days', '2026-09-10', 'admin', 'lx-retro-${rid}')`), true,
  'période congés close = mouvements rétroactifs interdits');
});

test('11 clôtures CONCURRENTES : une seule passe (verrou + cycle contrôlé)', async () => {
  const adm = await token(slugA, admEmail);
  // Période ÉLOIGNÉE (mars 2027) : sa clôture ne doit jamais pouvoir bloquer un
  // mouvement daté du jour d'exécution de la suite (effective_on = CURRENT_DATE).
  const octId = (await postJson<{ id: string }>('/leave/periods', adm, {
    label: `LXC-MARS27-${RID}`, periodStart: '2027-03-01', periodEnd: '2027-03-31',
  }, 201)).id;
  const race = await Promise.all([
    api(`/leave/periods/${octId}/close`, adm, { confirmWarnings: true }),
    api(`/leave/periods/${octId}/close`, adm, { confirmWarnings: true }),
  ]);
  const codes = race.map((r) => r.status).sort();
  assert.equal(codes.filter((s) => s === 200).length, 1, `une seule clôture : ${codes.join(',')}`);
  assert.equal(psql(`SELECT count(*) FROM leave.period_closes WHERE period_id = '${octId}'`), '1');
});

test('12 RÉOUVERTURE congés versionnée : l’ancienne clôture DEMEURE, la re-clôture produit une NOUVELLE empreinte', async () => {
  const adm = await token(slugA, admEmail);
  const rh = await token(slugA, rhEmail);
  const out = await postJson<{ instanceId: string }>(`/leave/periods/${leavePeriodSept}/reopen`, adm,
    { reason: 'ajustement de septembre à passer' });
  await postJson(`/workflow/instances/${out.instanceId}/approve`, rh, {});
  assert.equal(psql(`SELECT status || '|' || revision FROM leave.periods WHERE id = '${leavePeriodSept}'`), 'reopened|2');
  // Le mouvement passe MAINTENANT (période rouverte) — ajustement motivé E11.1.
  const adj = await postJson<{ status: string }>('/leave/adjust', adm, {
    employeeId: e1, typeId: typeCap, direction: 'credit', quantity: 1,
    reason: 'reajustement apres reouverture', periodStart: '2026-01-01', periodEnd: '2026-12-31',
  });
  assert.equal(adj.status, 'applied', 'ajustement DIRECT (aucun seuil E4 configuré)');
  const closed2 = await postJson<{ closeId: string; closeNo: number; fingerprint: string }>(
    `/leave/periods/${leavePeriodSept}/close`, adm, { confirmWarnings: true });
  closeId2 = closed2.closeId;
  assert.equal(closed2.closeNo, 2);
  assert.notEqual(closed2.fingerprint, fingerprint1, 'le ledger a changé ⇒ l’empreinte change');
  // L'ancienne clôture DEMEURE (supersédée), son empreinte se revérifie toujours.
  const closes = await getJson<{ items: Array<{ id: string; status: string }> }>(
    `/leave/periods/${leavePeriodSept}/closes`, adm);
  assert.equal(closes.items.length, 2);
  assert.equal(closes.items.find((c) => c.id === closeId1)!.status, 'superseded');
  const verify1 = await getJson<{ match: boolean }>(`/leave/closes/${closeId1}/verify`, adm);
  assert.equal(verify1.match, true, 'les lignes figées de la clôture 1 se revérifient à l’identique');
});

test('13 exports préparatoires : SANS montant ni code confidentiel, idempotents, immuables, téléchargement audité', async () => {
  const adm = await token(slugA, admEmail);
  const naked = await token(slugA, nakedEmail);
  // Export refusé sur la clôture SUPERSÉDÉE.
  assert.equal((await api(`/leave/closes/${closeId1}/exports`, adm, { format: 'json' })).status, 409);
  const first = await postJson<{ exportId: string; revision: number; sha256: string; reused: boolean }>(
    `/leave/closes/${closeId2}/exports`, adm, { format: 'json' }, 201);
  assert.equal(first.reused, false);
  // IDEMPOTENT : même contenu ⇒ même export, AUCUNE nouvelle révision.
  const again = await postJson<{ exportId: string; reused: boolean }>(
    `/leave/closes/${closeId2}/exports`, adm, { format: 'json' }, 201);
  assert.equal(again.reused, true);
  assert.equal(again.exportId, first.exportId);
  const csv = await postJson<{ exportId: string }>(`/leave/closes/${closeId2}/exports`, adm, { format: 'csv' }, 201);
  // Téléchargement : permission + audit ; contenu conforme au contrat.
  assert.equal((await api(`/leave/prep-exports/${first.exportId}/download`, naked, undefined, 'GET')).status, 403);
  const dl = await getJson<{ contentBase64: string; sha256: string }>(
    `/leave/prep-exports/${first.exportId}/download`, adm);
  const content = Buffer.from(dl.contentBase64, 'base64').toString('utf8');
  const parsed = JSON.parse(content) as Record<string, unknown>;
  assert.equal(parsed['schema'], 'kora-conges-prep-1');
  assert.ok(Array.isArray(parsed['salaries']));
  assert.ok(content.includes('conge_paye'), 'catégories préparatoires présentes');
  for (const forbidden of ['montant', 'salaire', 'taux', 'retenue', 'MAL']) {
    assert.equal(content.includes(forbidden), false, `jamais « ${forbidden} » dans un export préparatoire`);
  }
  const csvContent = Buffer.from((await getJson<{ contentBase64: string }>(
    `/leave/prep-exports/${csv.exportId}/download`, adm)).contentBase64, 'base64').toString('utf8');
  assert.match(csvContent, /^module;origine;matricule;categorie;jours;heures;corrections/);
  assert.ok(csvContent.includes('conges;absence_appliquee;'));
  assert.equal(Number(psql(`SELECT count(*) FROM audit.audit_log WHERE tenant_id = '${tenantAId}'
    AND action = 'leave_export_downloaded'`)) >= 2, true);
  // Immuable PAR LA BASE.
  assert.equal(psqlFails(`UPDATE leave.prep_exports SET content = '\\x00' WHERE id = '${first.exportId}'`), true);
});

test('14 reporting : agrégats réels, bornés à la PORTÉE, jamais un motif ni un code confidentiel', async () => {
  const adm = await token(slugA, admEmail);
  const scoped = await token(slugA, scopedEmail);
  const naked = await token(slugA, nakedEmail);
  const rep = await getJson<{ report: Record<string, unknown> }>(
    '/leave/reports?from=2026-07-01&to=2026-09-30', adm);
  const r = rep.report;
  const byCategory = r['byCategory'] as Array<{ category: string; days: number; hours: number }>;
  assert.ok(byCategory.some((c) => c.category === 'conge_paye' && c.days >= 3), JSON.stringify(byCategory));
  assert.ok(byCategory.some((c) => c.category === 'mission_formation' && c.hours >= 4));
  assert.ok((r['requests'] as unknown[]).length >= 2, 'entonnoir des demandes présent');
  assert.ok(Number(r['retroRequests']) >= 1, 'les rétroactives se comptent');
  assert.equal(JSON.stringify(r).includes('MAL'), false, 'jamais un code de type confidentiel');
  assert.equal(JSON.stringify(r).includes('régularisation'), false, 'jamais un motif');
  // Portée : le rapporteur borné à l'unité RH voit MOINS (e2/IT exclu).
  const repScoped = await getJson<{ report: Record<string, unknown> }>(
    '/leave/reports?from=2026-07-01&to=2026-09-30', scoped);
  const scopedCap = (repScoped.report['byCategory'] as Array<{ category: string; days: number }>)
    .find((c) => c.category === 'conge_paye')?.days ?? 0;
  const admCap = byCategory.find((c) => c.category === 'conge_paye')?.days ?? 0;
  assert.ok(scopedCap < admCap, `portée réelle : ${scopedCap} < ${admCap}`);
  assert.equal((await api('/leave/reports?from=2026-07-01&to=2026-09-30', naked, undefined, 'GET')).status, 403);
});

test('15 isolation tenant + suivi d’intégration + inventaire d’audit', async () => {
  const adm = await token(slugA, admEmail);
  const bAdm = await token(slugB, bAdmEmail);
  // Tenant B : rien à voir, rien à actionner.
  const periodsB = await getJson<{ items: unknown[] }>('/leave/periods', bAdm);
  assert.equal(periodsB.items.length, 0);
  assert.equal((await api(`/leave/closes/${closeId2}/verify`, bAdm, undefined, 'GET')).status, 404);
  assert.equal((await api(`/leave/prep-exports/${closeId2}/download`, bAdm, undefined, 'GET')).status, 404);
  assert.equal((await api(`/leave/periods/${leavePeriodSept}/close`, bAdm, { confirmWarnings: true })).status, 404);
  // FK inter-tenant : une clôture B ne fige JAMAIS une ligne du tenant A.
  const bPeriod = psql(`INSERT INTO leave.periods (tenant_id, label, period_start, period_end, created_by)
    VALUES ('${tenantBId}', 'LXB-SEPT', '2026-09-01', '2026-09-30',
            (SELECT id FROM admin.users WHERE email = '${bAdmEmail}')) RETURNING id`);
  const bClose = psql(`INSERT INTO leave.period_closes (tenant_id, period_id, close_no, period_revision,
      engine_version, dataset_sha256, closed_by)
    VALUES ('${tenantBId}', '${bPeriod}', 1, 1, 'kora-leave-close-1.0.0', repeat('f', 64),
            (SELECT id FROM admin.users WHERE email = '${bAdmEmail}')) RETURNING id`);
  assert.equal(psqlFails(`INSERT INTO leave.close_lines (tenant_id, close_id, employee_id, absence_type_id,
      period_start, accrued, available, unit, movements)
    VALUES ('${tenantBId}', '${bClose}', '${e1}', '${typeCap}', '2026-01-01', 1, 1, 'open_days', 1)`), true,
  'ligne B → salarié A : FK composite refusée');
  // Suivi d'intégration : compteurs par statut et par impact.
  const status = await getJson<{ integration: { facts: Array<{ status: string; count: number }> } }>(
    '/leave/integration?from=2026-07-01&to=2026-09-30', adm);
  const statuses = Object.fromEntries(status.integration.facts.map((f) => [f.status, f.count]));
  assert.ok(Number(statuses['active'] ?? 0) >= 6, JSON.stringify(statuses));
  assert.ok(Number(statuses['superseded'] ?? 0) >= 3, 'les faits annulés restent visibles');
  // Inventaire d'audit E11.3.
  const actions = psql(`SELECT string_agg(DISTINCT action, ',') FROM audit.audit_log
    WHERE tenant_id = '${tenantAId}' AND (action LIKE 'leave_period%' OR action LIKE 'leave_export%'
       OR action LIKE 'leave_preclose%' OR action IN ('leave_absence_integrated', 'leave_facts_activated', 'leave_report_accessed', 'leave_reopen_requested'))`).split(',');
  for (const expected of [
    'leave_period_created', 'leave_preclose_run', 'leave_period_closed', 'leave_period_reopened',
    'leave_reopen_requested', 'leave_export_created', 'leave_export_downloaded',
    'leave_absence_integrated', 'leave_facts_activated', 'leave_report_accessed',
  ]) {
    assert.ok(actions.includes(expected), `action auditée manquante : ${expected}`);
  }
});
