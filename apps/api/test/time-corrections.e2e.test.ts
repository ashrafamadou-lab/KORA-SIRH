/**
 * E2E Corrections & clôture (E10.3) — conditions de validation du sponsor :
 * bruts STRICTEMENT inchangés après correction ; rejet sans AUCUN effet ;
 * approbation ⇒ surcouche append-only puis NOUVELLE version calculée ; décision
 * liée à la version exacte (contenu figé dès soumission) ; auto-approbation
 * IMPOSSIBLE ; manager borné à son périmètre ; pièce sensible cloisonnée et
 * consultations journalisées ; anomalie résoluble UNIQUEMENT par correction
 * appliquée ou classement motivé ; pré-clôture exhaustive à bloqueurs
 * configurables ; clôture idempotente, anti-concurrente, à EMPREINTE
 * reproductible ; période close refusant toute correction ordinaire (PAR LA
 * BASE) ; réouverture conservant la clôture précédente ; nouvel export marquant
 * l'ancien « remplacé » sans le supprimer ; exports idempotents SANS montant ;
 * isolation tenant + FK rejetées par PostgreSQL ; portées réelles ; audit et
 * notifications sur transitions committées ; parcours automatique anomalie
 * bloquante ⇒ brouillon de demande.
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
function psqlFails(sql: string): boolean {
  const r = spawnSync('psql', [MIGRATOR_URL, '-qXtA', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
  return r.status !== 0;
}

const rid = randomUUID().slice(0, 8);
const RID = rid.toUpperCase();
const P = 'Pendjari-Atacora-2026!';
const slugA = `cr-a-${rid}`;
const slugB = `cr-b-${rid}`;

const admEmail = `cradm.${rid}@demo.bj`;   // administration du temps, tenant
const mgrEmail = `crmgr.${rid}@demo.bj`;   // MANAGER de e1 (lié au salarié eMgr), portée UNITÉ RH
const selfEmail = `crself.${rid}@demo.bj`; // salarié e1 (ESS)
const rhEmail = `crrh.${rid}@demo.bj`;     // approbateur rôle « rh-temps »
const nakedEmail = `crnone.${rid}@demo.bj`;
const bAdmEmail = `crbadm.${rid}@demo.bj`;

let app: INestApplication;
let base = '';
let tenantAId = '';
let tenantBId = '';
let selfUserId = '';
let mgrUserId = '';

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
  tenantAId = psql(`INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('${slugA}','CR A',true) RETURNING id`);
  tenantBId = psql(`INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('${slugB}','CR B',true) RETURNING id`);
  await seedUser(tenantAId, admEmail, [
    'time.correction_request', 'time.correction_request_self', 'time.correction_view', 'time.correction_admin',
    'time.attachments_view', 'time.preclose_view', 'time.period_manage', 'time.period_close',
    'time.period_reopen', 'time.payroll_view', 'time.payroll_export', 'time.rules_admin',
    'time.calc_run', 'time.calc_recalc', 'time.calc_view', 'time.results_view', 'time.results_view_own',
    'time.anomalies_view', 'time.anomalies_manage',
    'time.schedules_view', 'time.schedules_manage', 'time.schedules_assign',
    'time.punches_import', 'time.punches_view', 'time.devices_manage',
    'org.view', 'org.manage', 'employees.view', 'employees.manage', 'employees.assign',
    'notify.manage', 'audit.view', 'workflow.manage', 'workflow.view',
  ], true);
  selfUserId = await seedUser(tenantAId, selfEmail, ['time.correction_request_self', 'time.results_view_own'], true);
  mgrUserId = await seedUser(tenantAId, mgrEmail, [
    'time.correction_request', 'time.correction_view', 'time.results_view',
    'time.anomalies_view', 'time.anomalies_manage', 'employees.view',
  ], false);
  await seedUser(tenantAId, rhEmail, [
    'time.correction_view', 'workflow.view', 'workflow.act',
  ], true, 'rh-temps');
  await seedUser(tenantAId, nakedEmail, ['employees.view'], true);
  await seedUser(tenantBId, bAdmEmail, [
    'time.correction_view', 'time.payroll_view', 'time.period_manage', 'time.results_view',
  ], true);

  psql(`INSERT INTO compliance.legal_parameters
          (tenant_id, country_code, key, value, effective_from, status, is_legal_sensitive,
           confidence, source_text, verified_by, verified_at)
        VALUES ('${tenantAId}', 'BJ', 'temps.fuseau.defaut', '"Africa/Porto-Novo"', '2020-01-01', 'active', false,
                'verified', 'Fuseau du siège (IANA)', 'fixture-e2e', '2026-01-01')`);

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
  if (res.status !== 201) assert.fail(`${path} → ${res.status} : ${await res.text().catch(() => '')}`);
  return ((await res.json()) as { id: string }).id;
}
async function getJson<T>(path: string, tok: string): Promise<T> {
  const res = await api(path, tok, undefined, 'GET');
  assert.equal(res.status, 200, `${path} → ${res.status}`);
  return (await res.json()) as T;
}
async function postJson<T>(path: string, tok: string, body: unknown, expected = 200): Promise<T> {
  const res = await api(path, tok, body);
  const text = await res.text();
  assert.equal(res.status, expected, `${path} → ${res.status} : ${text}`);
  return (text.length > 0 ? JSON.parse(text) : {}) as T;
}

// ---------------------------------------------------------------------------
// Fixtures : semaine du lundi 2026-07-06 (fuseau Porto-Novo, horaire 08-17).
// ---------------------------------------------------------------------------
let coA = ''; let siteA = ''; let uRh = ''; let uIt = '';
let e1 = ''; let eMgr = ''; let e2 = ''; let eSusp = '';
let dayModel = '';
let rawFp = ''; let evFp = '';
let reqAddOut = ''; let reqJustify = ''; let reqClosed = '';
let anomMissingOutId = ''; let periodJulyId = ''; let close1Id = ''; let close2Id = '';
let exportCsvId = '';
const MON = '2026-07-06'; const TUE = '2026-07-07'; const WED = '2026-07-08';
const THU = '2026-07-09'; const FRI = '2026-07-10';

const fingerprints = () => ({
  raw: psql(`SELECT md5(string_agg(id::text || '|' || coalesce(source_datetime_raw,''), ',' ORDER BY id))
    FROM time.raw_punches WHERE tenant_id = '${tenantAId}'`),
  ev: psql(`SELECT md5(string_agg(id::text || '|' || coalesce(occurred_at::text,'') || '|' || match_status || '|' || event_type, ',' ORDER BY id))
    FROM time.punch_events WHERE tenant_id = '${tenantAId}'`),
});

async function punch(adm: string, employeeId: string, dateTime: string, eventType: string): Promise<void> {
  const r = await api('/time/punches/manual', adm, { employeeId, dateTime, eventType, siteId: siteA, note: 'fixture E10.3' });
  assert.equal(r.status, 201, `pointage ${dateTime} → ${r.status}`);
}

interface DayDetail {
  result: Record<string, unknown> & { version: number; dayStatus: string };
  anomalies: Array<{ id: string; code: string; severity: string; state: string; resolutionKind?: string | null; resolutionEventId?: string | null }>;
  versionCount: number;
}
const dayOf = (tok: string, emp: string, date: string) =>
  getJson<DayDetail>(`/time/results/day?employeeId=${emp}&date=${date}`, tok);

test('01 fixtures : organisation, salariés (manager lié), horaire, circuits E3, modèles E5', async () => {
  const adm = await token(slugA, admEmail);
  coA = await created('/org/companies', adm, { code: 'CR-CO', labelFr: 'Société', labelEn: 'Company' });
  await api(`/org/companies/${coA}/status`, adm, { status: 'active' });
  siteA = await created('/org/sites', adm, { code: 'CR-SITE', labelFr: 'Site', labelEn: 'Site', companyId: coA });
  await api(`/org/sites/${siteA}/status`, adm, { status: 'active' });
  psql(`UPDATE org.sites SET time_zone = 'Africa/Porto-Novo' WHERE id = '${siteA}'`);
  uRh = await created('/org/units', adm, { code: 'CR-RH', labelFr: 'RH', labelEn: 'HR', unitType: 'direction', companyId: coA });
  await api(`/org/units/${uRh}/status`, adm, { status: 'active' });
  uIt = await created('/org/units', adm, { code: 'CR-IT', labelFr: 'IT', labelEn: 'IT', unitType: 'direction', companyId: coA });
  await api(`/org/units/${uIt}/status`, adm, { status: 'active' });
  const mgrScope = psql(`SELECT id FROM admin.users WHERE email = '${mgrEmail}'`);
  psql(`INSERT INTO admin.user_scopes (tenant_id, user_id, scope_type, scope_ref) VALUES ('${tenantAId}','${mgrScope}','department','${uRh}')`);

  const mk = async (mat: string, first: string, unit: string, managerOverride?: string): Promise<string> => {
    const id = ((await (await api('/employees', adm, {
      matricule: mat, firstName: first, lastName: 'Corr', hireDate: '2025-01-06',
    })).json()) as { id: string }).id;
    psql(`UPDATE core.employees SET status = 'active' WHERE id = '${id}'`);
    const asg = await api(`/employees/${id}/assignments`, adm, {
      companyId: coA, siteId: siteA, unitId: unit, effectiveFrom: '2025-01-06', isPrimary: true,
      ...(managerOverride ? { managerOverrideEmployeeId: managerOverride } : {}),
    });
    assert.equal(asg.status, 201, `affectation ${mat} : ${await asg.text().catch(() => '')}`);
    return id;
  };
  eMgr = await mk(`CRM-${RID}`, 'Manou', uRh);
  e1 = await mk(`CR1-${RID}`, 'Awa', uRh, eMgr);
  e2 = await mk(`CR2-${RID}`, 'Bio', uIt);
  eSusp = await mk(`CRS-${RID}`, 'Dossi', uRh);
  psql(`UPDATE core.employees SET user_id = '${selfUserId}' WHERE id = '${e1}'`);
  psql(`UPDATE core.employees SET user_id = '${mgrUserId}' WHERE id = '${eMgr}'`);

  dayModel = await created('/time/schedules/models', adm, { code: 'CR-JOUR', labelFr: 'Jour', labelEn: 'Day', kind: 'fixed' });
  assert.equal((await api(`/time/schedules/models/${dayModel}/versions`, adm, {
    effectiveFrom: '2026-01-05', cycleDays: 7,
    days: [0, 1, 2, 3, 4].map((i) => ({ dayIndex: i, isRest: false, startMinute: 480, endMinute: 1020, breakStartMinute: 720, breakEndMinute: 780 }))
      .concat([{ dayIndex: 5, isRest: true }, { dayIndex: 6, isRest: true }] as never[]),
  })).status, 201);
  for (const emp of [e1, e2, eSusp]) {
    assert.equal((await api('/time/schedules/assignments', adm, {
      employeeId: emp, modelId: dayModel, anchorDate: '2026-01-05', effectiveFrom: '2026-01-05',
    })).status, 201);
  }

  // Pointages : e1 lundi SANS sortie ; mardi rien ; mer/jeu/ven complets.
  await punch(adm, e1, `${MON} 08:00`, 'E');
  await punch(adm, e1, `${WED} 08:02`, 'E');
  await punch(adm, e1, `${WED} 17:00`, 'S');
  await punch(adm, e1, `${THU} 08:00`, 'E');
  await punch(adm, e1, `${THU} 17:00`, 'S');
  await punch(adm, e1, `${FRI} 08:00`, 'E');
  await punch(adm, e1, `${FRI} 17:00`, 'S');
  await punch(adm, e2, `${WED} 08:00`, 'E');
  await punch(adm, e2, `${WED} 17:00`, 'S');
  // eSusp pointe PUIS est suspendu (l'anomalie bloquante naîtra au calcul).
  await punch(adm, eSusp, `${WED} 08:00`, 'E');
  await punch(adm, eSusp, `${WED} 17:00`, 'S');
  psql(`UPDATE core.employees SET status = 'suspended' WHERE id = '${eSusp}'`);

  // Circuits E3 : manager (si présent) → rh-temps → rh-temps si PÉRIODE CLOSE.
  const defC = await api('/workflow/definitions', adm, {
    key: 'temps_correction', name: 'Correction de présence',
    steps: [
      { index: 0, name: 'Validation manager', approverType: 'manager', condition: { field: 'hasManager', op: 'eq', value: true } },
      { index: 1, name: 'Administration du temps', approverType: 'role', approverRef: 'rh-temps' },
      { index: 2, name: 'Supplément période close', approverType: 'role', approverRef: 'rh-temps', condition: { field: 'periodClosed', op: 'eq', value: true } },
    ],
  });
  assert.equal(defC.status, 201, await defC.text().catch(() => ''));
  const defCId = ((await defC.json()) as { id: string }).id;
  assert.equal((await api(`/workflow/definitions/${defCId}/activate`, adm)).status, 200);
  const defR = await api('/workflow/definitions', adm, {
    key: 'temps_reouverture', name: 'Réouverture de période',
    steps: [{ index: 0, name: 'Validation réouverture', approverType: 'role', approverRef: 'rh-temps' }],
  });
  assert.equal(defR.status, 201);
  const defRId = ((await defR.json()) as { id: string }).id;
  assert.equal((await api(`/workflow/definitions/${defRId}/activate`, adm)).status, 200);

  // Modèles E5 dont l'envoi sera PROUVÉ.
  for (const [key, name, subject, bodyVars] of [
    ['temps_correction_appliquee', 'Correction appliquée', 'Correction appliquée — {{journee}}', ['demande', 'journee']],
    ['temps_cloture_reussie', 'Clôture réussie', 'Clôture {{cloture}} — {{periode}}', ['periode', 'cloture', 'empreinte']],
  ] as const) {
    const tpl = await api('/admin/notify/templates', adm, {
      key, name,
      subjectFr: subject, subjectEn: subject,
      bodyFr: bodyVars.map((v) => `{{${v}}}`).join(' · '), bodyEn: bodyVars.map((v) => `{{${v}}}`).join(' · '),
      variables: [...bodyVars], channels: ['in_app'], mandatory: false,
    });
    const tplText = await tpl.text();
    assert.equal(tpl.status, 201, tplText);
    const tplId = (JSON.parse(tplText) as { id: string }).id;
    assert.equal((await api(`/admin/notify/templates/${tplId}/activate`, adm)).status, 200);
  }
});

test('02 calcul initial : base saine + anomalie BLOQUANTE ⇒ BROUILLON automatique de demande', async () => {
  const adm = await token(slugA, admEmail);
  const res = await api('/time/calc/run', adm, {
    periodStart: MON, periodEnd: '2026-07-12', scopeKind: 'tenant', reason: 'calcul initial E10.3',
  });
  const text = await res.text();
  assert.equal(res.status, 201, text);
  const fp = fingerprints();
  rawFp = fp.raw; evFp = fp.ev;
  const mon = await dayOf(adm, e1, MON);
  assert.equal(mon.result.dayStatus, 'incomplete_punches');
  anomMissingOutId = mon.anomalies.find((a) => a.code === 'missing_out')!.id;
  assert.ok(anomMissingOutId);
  // Anomalie bloquante (suspendu avec pointages) ⇒ demande AUTOMATIQUE en brouillon.
  const draft = psql(`SELECT count(*) FROM time.correction_requests
    WHERE tenant_id = '${tenantAId}' AND origin = 'auto_anomaly' AND status = 'draft' AND employee_id = '${eSusp}'`);
  assert.equal(Number(draft), 1, 'anomalie bloquante ⇒ UN brouillon lié, une seule fois');
});

test('03 ESS : demande add_out soumise — ni le demandeur ni un non-approbateur ne décident', async () => {
  const self = await token(slugA, selfEmail);
  const adm = await token(slugA, admEmail);
  reqAddOut = await created('/time/corrections', self, {
    workDate: MON, kind: 'add_out', motive: 'sortie oubliée à 17:00 (badge resté au vestiaire)',
    payload: { localTime: '17:00' }, anomalyId: anomMissingOutId,
  });
  const sub = await postJson<{ instanceId: string; version: number }>(`/time/corrections/${reqAddOut}/submit`, self, {});
  assert.equal(sub.version, 1);
  assert.ok(sub.instanceId);
  // Le demandeur ne peut PAS approuver sa propre demande (séparation des tâches E3).
  assert.equal((await api(`/time/corrections/${reqAddOut}/decide`, self, { action: 'approve' })).status, 403);
  // L'admin n'est PAS l'approbateur de l'étape manager : refusé aussi.
  assert.equal((await api(`/time/corrections/${reqAddOut}/decide`, adm, { action: 'approve' })).status, 403);
});

test('04 auto-approbation IMPOSSIBLE : le manager ne décide jamais sa propre demande', async () => {
  const mgr = await token(slugA, mgrEmail);
  const req = await created('/time/corrections', mgr, {
    employeeId: e1, workDate: WED, kind: 'justify_late', motive: 'retard transport en commun',
    payload: { category: 'transport' },
  });
  await postJson(`/time/corrections/${req}/submit`, mgr, {});
  const own = await api(`/time/corrections/${req}/decide`, mgr, { action: 'approve' });
  assert.equal(own.status, 403, 'demandeur = approbateur d\'étape ⇒ REFUS (selfApprovalAllowed=false)');
  assert.equal((await api(`/time/corrections/${req}/cancel`, mgr, {})).status, 200, 'retrait avant décision');
  const st = psql(`SELECT status FROM time.correction_requests WHERE id = '${req}'`);
  assert.equal(st, 'cancelled');
});

test('05 approbation manager → RH ⇒ surcouche append-only + NOUVELLE version + anomalie RÉSOLUE', async () => {
  const mgr = await token(slugA, mgrEmail);
  const rh = await token(slugA, rhEmail);
  const adm = await token(slugA, admEmail);
  const s1 = await postJson<{ status: string }>(`/time/corrections/${reqAddOut}/decide`, mgr, { action: 'approve' });
  assert.equal(s1.status, 'pending', 'étape manager franchie, étape RH en attente');
  const s2 = await postJson<{ status: string; applied?: boolean }>(`/time/corrections/${reqAddOut}/decide`, rh, { action: 'approve' });
  assert.equal(s2.status, 'approved');
  assert.equal(s2.applied, true, 'application AUTOMATIQUE après approbation finale');
  const req = psql(`SELECT status FROM time.correction_requests WHERE id = '${reqAddOut}'`);
  assert.equal(req, 'applied');
  // Nouvelle VERSION calculée : lundi devient présent, 480 min, correction comptée.
  const mon = await dayOf(adm, e1, MON);
  assert.equal(mon.result.version, 2);
  assert.equal(mon.result.dayStatus, 'present');
  assert.equal(mon.result['workedMinutes'], 480);
  assert.equal(mon.result['correctionsApplied'], 1);
  assert.equal(mon.versionCount, 2, 'l\'ancienne version DEMEURE');
  // L'anomalie liée est résolue par RÉFÉRENCE PROBANTE (l'événement correctif).
  const anom = psql(`SELECT state || '|' || resolution_kind || '|' || (resolution_event_id IS NOT NULL)
    FROM time.day_anomalies WHERE id = '${anomMissingOutId}'`);
  assert.equal(anom, 'resolved|correction_applied|t');
  // BRUTS et événements normalisés STRICTEMENT inchangés.
  const fp = fingerprints();
  assert.equal(fp.raw, rawFp, 'raw_punches intacts après correction');
  assert.equal(fp.ev, evFp, 'punch_events intacts après correction');
  // Notification E5 sur transition COMMITTÉE.
  const notif = psql(`SELECT count(*) FROM notify.notifications
    WHERE tenant_id = '${tenantAId}' AND template_key = 'temps_correction_appliquee'`);
  assert.ok(Number(notif) >= 1);
});

test('06 rejeu : approbation répétée ⇒ conflit ; application relancée ⇒ UN SEUL événement (PG)', async () => {
  const rh = await token(slugA, rhEmail);
  const adm = await token(slugA, admEmail);
  assert.equal((await api(`/time/corrections/${reqAddOut}/decide`, rh, { action: 'approve' })).status, 409,
    'décision déjà rendue : aucune double transition');
  const again = await postJson<{ eventId: string }>(`/time/corrections/${reqAddOut}/apply`, adm, {});
  assert.ok(again.eventId, 'relance idempotente : le MÊME événement est rendu');
  const events = psql(`SELECT count(*) FROM time.correction_events WHERE request_id = '${reqAddOut}'`);
  assert.equal(Number(events), 1, 'UNE demande = AU PLUS UN événement correctif (UNIQUE PostgreSQL)');
  const mon = await dayOf(adm, e1, MON);
  assert.equal(mon.result.version, 2, 'le rejeu n\'a créé AUCUNE nouvelle version (contenu identique)');
});

test('07 rejet : AUCUN effet sur les résultats, aucune surcouche', async () => {
  const self = await token(slugA, selfEmail);
  const mgr = await token(slugA, mgrEmail);
  const rh = await token(slugA, rhEmail);
  const adm = await token(slugA, admEmail);
  const outId = psql(`SELECT id FROM time.punch_events
    WHERE tenant_id = '${tenantAId}' AND employee_id = '${e1}' AND local_date = '${WED}' AND event_type = 'out'`);
  const req = await created('/time/corrections', self, {
    workDate: WED, kind: 'exclude_event', motive: 'je conteste cette sortie', payload: { eventId: outId },
  });
  await postJson(`/time/corrections/${req}/submit`, self, {});
  await postJson(`/time/corrections/${req}/decide`, mgr, { action: 'approve' });
  const rej = await postJson<{ status: string }>(`/time/corrections/${req}/decide`, rh, { action: 'reject', comment: 'sortie confirmée par le site' });
  assert.equal(rej.status, 'rejected');
  const wed = await dayOf(adm, e1, WED);
  assert.equal(wed.result.version, 1, 'un REJET ne modifie AUCUN résultat');
  assert.equal(Number(psql(`SELECT count(*) FROM time.correction_events WHERE request_id = '${req}'`)), 0);
});

test('08 retour → resoumission VERSIONNÉE → justification appliquée ; pièce SENSIBLE cloisonnée', async () => {
  const self = await token(slugA, selfEmail);
  const mgr = await token(slugA, mgrEmail);
  const rh = await token(slugA, rhEmail);
  const adm = await token(slugA, admEmail);
  reqJustify = await created('/time/corrections', self, {
    workDate: TUE, kind: 'justify_absence', motive: 'absence pour raison médicale', payload: { category: 'maladie' },
  });
  const pdf = Buffer.from('%PDF-1.4\n%%EOF\n').toString('base64');
  const att = await postJson<{ id: string; sha256: string }>(`/time/corrections/${reqJustify}/attachments`, self, {
    filename: 'certificat.pdf', mime: 'application/pdf', contentBase64: pdf, sensitive: true,
  }, 201);
  const v1 = await postJson<{ version: number }>(`/time/corrections/${reqJustify}/submit`, self, {});
  assert.equal(v1.version, 1);
  await postJson(`/time/corrections/${reqJustify}/decide`, mgr, { action: 'return', comment: 'préciser la durée' });
  assert.equal(psql(`SELECT status FROM time.correction_requests WHERE id = '${reqJustify}'`), 'returned');
  const v2 = await postJson<{ version: number }>(`/time/corrections/${reqJustify}/submit`, self, {});
  assert.equal(v2.version, 2, 'resoumission = version INCRÉMENTÉE (décision liée à la version exacte)');
  await postJson(`/time/corrections/${reqJustify}/decide`, mgr, { action: 'approve' });
  const fin = await postJson<{ applied?: boolean }>(`/time/corrections/${reqJustify}/decide`, rh, { action: 'approve' });
  assert.equal(fin.applied, true);
  const tue = await dayOf(adm, e1, TUE);
  assert.equal(tue.result.dayStatus, 'absent', 'le FAIT reste une absence');
  assert.equal(tue.result['justifiedCategory'], 'maladie');
  assert.equal(tue.result['justifiedMinutes'], 480);
  // Pièce SENSIBLE : nom masqué et téléchargement REFUSÉ hors cercle/permission.
  const asRh = await getJson<{ attachments: Array<{ filename: string }> }>(`/time/corrections/${reqJustify}`, rh);
  assert.equal(asRh.attachments[0]!.filename, 'pièce confidentielle', 'cloisonnement : nom masqué pour l\'approbateur');
  assert.equal((await api(`/time/corrections/attachments/${att.id}`, rh, undefined, 'GET')).status, 403);
  const dl = await getJson<{ sha256: string; filename: string }>(`/time/corrections/attachments/${att.id}`, adm);
  assert.equal(dl.sha256, att.sha256);
  assert.equal(dl.filename, 'certificat.pdf');
  assert.equal(Number(psql(`SELECT count(*) FROM time.attachment_access_log WHERE attachment_id = '${att.id}'`)), 1,
    'chaque consultation est JOURNALISÉE');
});

test('09 périmètres : le manager ne sort pas de son unité ; l\'autre tenant ne voit RIEN', async () => {
  const mgr = await token(slugA, mgrEmail);
  const bAdm = await token(slugB, bAdmEmail);
  assert.equal((await api('/time/corrections', mgr, {
    employeeId: e2, workDate: WED, kind: 'justify_late', motive: 'x', payload: { category: 'transport' },
  })).status, 404, 'salarié HORS périmètre : introuvable, pas interdit');
  const bList = await getJson<{ items: unknown[] }>('/time/corrections', bAdm);
  assert.equal(bList.items.length, 0);
  assert.equal((await api(`/time/corrections/${reqAddOut}`, bAdm, undefined, 'GET')).status, 404);
});

test('10 anomalies : affectation + échéance, classement MOTIVÉ, réouverture purgée', async () => {
  const adm = await token(slugA, admEmail);
  const suspAnom = psql(`SELECT a.id FROM time.day_anomalies a
    JOIN time.day_results r ON r.id = a.day_result_id
    WHERE a.tenant_id = '${tenantAId}' AND a.employee_id = '${eSusp}' AND a.severity = 'blocking' AND r.is_current LIMIT 1`);
  assert.ok(suspAnom);
  await postJson(`/time/anomalies/${suspAnom}/assign`, adm, { userId: null, dueAt: new Date(Date.now() + 3600_000).toISOString() });
  const swept = await postJson<{ notified: number }>('/time/anomalies/sweep', adm, {});
  assert.ok(swept.notified >= 1, 'échéance sous 24 h ⇒ notification');
  // Résolution SANS référence probante : refusée.
  assert.equal((await api(`/time/anomalies/${suspAnom}/state`, adm, { state: 'resolved' })).status, 409);
  assert.equal((await api(`/time/anomalies/${suspAnom}/state`, adm, { state: 'resolved', resolutionKind: 'classified' })).status, 400,
    'classement sans note motivée : refusé');
  await postJson(`/time/anomalies/${suspAnom}/state`, adm, {
    state: 'resolved', resolutionKind: 'classified', note: 'pointages d\'un salarié suspendu — confirmés hors présence, dossier RH informé',
  });
  assert.equal(psql(`SELECT state || '|' || resolution_kind FROM time.day_anomalies WHERE id = '${suspAnom}'`), 'resolved|classified');
  await postJson(`/time/anomalies/${suspAnom}/state`, adm, { state: 'open', note: 'réouverture de contrôle' });
  assert.equal(psql(`SELECT state || '|' || coalesce(resolution_kind, 'purgé') FROM time.day_anomalies WHERE id = '${suspAnom}'`), 'open|purgé');
  await postJson(`/time/anomalies/${suspAnom}/state`, adm, {
    state: 'resolved', resolutionKind: 'classified', note: 'classement définitif motivé',
  });
});

test('11 période + pré-clôture : contrôles exhaustifs, bloqueurs, avertissements CONFIRMÉS et tracés', async () => {
  const adm = await token(slugA, admEmail);
  periodJulyId = await created('/time/periods', adm, {
    scopeKind: 'tenant', label: 'Juillet 2026', periodStart: '2026-07-01', periodEnd: '2026-07-31',
  });
  // Chevauchement : refusé PAR LA BASE.
  assert.equal((await api('/time/periods', adm, {
    scopeKind: 'tenant', label: 'Chevauche', periodStart: '2026-07-15', periodEnd: '2026-08-15',
  })).status, 409);
  await postJson(`/time/periods/${periodJulyId}/status`, adm, { status: 'in_review' });
  const pre1 = await getJson<{ controls: Array<{ key: string; count: number; blocking: boolean }>; closable: boolean; blockers: number }>(
    `/time/periods/${periodJulyId}/preclose`, adm);
  const ctrl = (k: string) => pre1.controls.find((c) => c.key === k)!;
  assert.ok(ctrl('pending_requests').count >= 1, 'le brouillon automatique est VU par la pré-clôture');
  assert.ok(ctrl('pending_requests').blocking);
  assert.equal(pre1.closable, false, 'bloqueurs présents ⇒ pas de clôture');
  // Lever le bloqueur : annuler le brouillon automatique.
  const draftId = psql(`SELECT id FROM time.correction_requests
    WHERE tenant_id = '${tenantAId}' AND origin = 'auto_anomaly' AND status = 'draft'`);
  await postJson(`/time/corrections/${draftId}/cancel`, adm, {});
  // Clôture depuis in_review : refusée (verrouiller d'abord).
  assert.equal((await api(`/time/periods/${periodJulyId}/close`, adm, {})).status, 409);
  await postJson(`/time/periods/${periodJulyId}/status`, adm, { status: 'locked' });
  // Avertissements (salarié sans horaire…) : confirmation EXPLICITE exigée.
  assert.equal((await api(`/time/periods/${periodJulyId}/close`, adm, {})).status, 409);
  const closed = await postJson<{ close: { id: string; closeNo: number; datasetSha256: string; warnings: unknown[] } }>(
    `/time/periods/${periodJulyId}/close`, adm, { confirmWarnings: true }, 201);
  close1Id = closed.close.id;
  assert.equal(closed.close.closeNo, 1);
  assert.match(closed.close.datasetSha256, /^[0-9a-f]{64}$/);
  assert.ok((closed.close.warnings as unknown[]).length >= 1, 'les avertissements confirmés sont TRACÉS dans la clôture');
  assert.equal(psql(`SELECT status FROM time.periods WHERE id = '${periodJulyId}'`), 'closed');
  const notif = psql(`SELECT count(*) FROM notify.notifications
    WHERE tenant_id = '${tenantAId}' AND template_key = 'temps_cloture_reussie'`);
  assert.ok(Number(notif) >= 1);
});

test('12 période CLOSE : recalcul inerte, application de correction REFUSÉE par la base (état explicite)', async () => {
  const adm = await token(slugA, admEmail);
  const self = await token(slugA, selfEmail);
  const mgr = await token(slugA, mgrEmail);
  const rh = await token(slugA, rhEmail);
  const rec = await api('/time/calc/recalc', adm, {
    periodStart: MON, periodEnd: FRI, scopeKind: 'employee', scopeId: e1, reason: 'tentative sur période close',
  });
  const recText = await rec.text();
  assert.equal(rec.status, 201, recText);
  const run = (JSON.parse(recText) as { run: { resultsWritten: number } }).run;
  assert.equal(run.resultsWritten, 0, 'journées FIGÉES : aucune écriture');
  // Correction sur période close : le circuit ajoute l'étape dédiée, l'application ÉCHOUE explicitement.
  reqClosed = await created('/time/corrections', self, {
    workDate: THU, kind: 'justify_late', motive: 'justification tardive', payload: { category: 'transport' },
  });
  await postJson(`/time/corrections/${reqClosed}/submit`, self, {});
  await postJson(`/time/corrections/${reqClosed}/decide`, mgr, { action: 'approve' });
  const step2 = await postJson<{ status: string }>(`/time/corrections/${reqClosed}/decide`, rh, { action: 'approve' });
  assert.equal(step2.status, 'pending', 'période close ⇒ étape SUPPLÉMENTAIRE conditionnelle active');
  const fin = await postJson<{ status: string; applied?: boolean; applicationError?: string | null }>(
    `/time/corrections/${reqClosed}/decide`, rh, { action: 'approve' });
  assert.equal(fin.status, 'approved');
  assert.equal(fin.applied, false, 'application IMPOSSIBLE en période close');
  assert.equal(psql(`SELECT status FROM time.correction_requests WHERE id = '${reqClosed}'`), 'application_failed',
    'état EXPLICITE — jamais faussement appliquée');
});

test('13 empreinte : recalculée depuis les lignes FIGÉES, identique au sha256 stocké', async () => {
  const adm = await token(slugA, admEmail);
  const v = await getJson<{ stored: string; recomputed: string; match: boolean }>(`/time/closes/${close1Id}/verify`, adm);
  assert.equal(v.match, true);
  assert.equal(v.stored, v.recomputed);
});

test('14 exports paie : idempotents, SANS montant, téléchargement audité', async () => {
  const adm = await token(slugA, admEmail);
  const x1 = await postJson<{ export: { id: string; sha256: string; revision: number }; reused: boolean }>(
    `/time/closes/${close1Id}/exports`, adm, { format: 'csv' }, 201);
  assert.equal(x1.reused, false);
  assert.equal(x1.export.revision, 1);
  exportCsvId = x1.export.id;
  const x2 = await postJson<{ export: { id: string; sha256: string }; reused: boolean }>(
    `/time/closes/${close1Id}/exports`, adm, { format: 'csv' }, 201);
  assert.equal(x2.reused, true, 'MÊME export rejoué ⇒ l\'existant est rendu');
  assert.equal(x2.export.id, x1.export.id);
  assert.equal(x2.export.sha256, x1.export.sha256);
  await postJson(`/time/closes/${close1Id}/exports`, adm, { format: 'json' }, 201);
  const dl = await getJson<{ contentBase64: string; sha256: string }>(`/time/payroll-exports/${exportCsvId}/download`, adm);
  const csv = Buffer.from(dl.contentBase64, 'base64').toString('utf8');
  assert.ok(csv.startsWith('matricule;'), 'schéma CSV attendu');
  assert.ok(csv.includes(`CR1-${RID}`));
  for (const interdit of ['montant', 'taux', 'salaire', 'fcfa', '€']) {
    assert.ok(!csv.toLowerCase().includes(interdit), `AUCUN élément monétaire (« ${interdit} »)`);
  }
  assert.ok(Number(psql(`SELECT count(*) FROM audit.audit_log
    WHERE tenant_id = '${tenantAId}' AND action = 'time_payroll_export_downloaded'`)) >= 1);
});

test('15 réouverture par CIRCUIT dédié : motif obligatoire, clôture précédente CONSERVÉE', async () => {
  const adm = await token(slugA, admEmail);
  const rh = await token(slugA, rhEmail);
  assert.equal((await api(`/time/periods/${periodJulyId}/reopen`, adm, {})).status, 400, 'motif OBLIGATOIRE');
  const re = await postJson<{ mode: string; instanceId?: string }>(`/time/periods/${periodJulyId}/reopen`, adm, {
    motive: 'correction approuvée à appliquer (justification jeudi)',
  });
  assert.equal(re.mode, 'workflow', 'circuit temps_reouverture ACTIF ⇒ la réouverture attend l\'approbation');
  assert.equal(psql(`SELECT status FROM time.periods WHERE id = '${periodJulyId}'`), 'closed', 'rien ne bouge avant la décision');
  assert.equal((await api(`/workflow/instances/${re.instanceId}/approve`, rh, {})).status, 200);
  assert.equal(psql(`SELECT status || '|' || revision FROM time.periods WHERE id = '${periodJulyId}'`), 'reopened|2');
  assert.equal(psql(`SELECT status FROM time.period_closes WHERE id = '${close1Id}'`), 'superseded',
    'la clôture précédente DEMEURE, marquée remplacée');
  assert.equal(psql(`SELECT status FROM time.payroll_exports WHERE id = '${exportCsvId}'`), 'active',
    'l\'export reste actif jusqu\'à la clôture suivante');
});

test('16 application APRÈS réouverture : la demande échouée aboutit, nouvelle version calculée', async () => {
  const adm = await token(slugA, admEmail);
  const ap = await postJson<{ eventId: string }>(`/time/corrections/${reqClosed}/apply`, adm, {});
  assert.ok(ap.eventId);
  assert.equal(psql(`SELECT status FROM time.correction_requests WHERE id = '${reqClosed}'`), 'applied');
  const thu = await dayOf(adm, e1, THU);
  assert.equal(thu.result['lateJustified'], true);
  assert.ok(thu.result.version >= 2);
});

test('17 nouvelle clôture : version 2, nouvelle empreinte, ancien export REMPLACÉ mais intact', async () => {
  const adm = await token(slugA, admEmail);
  await postJson(`/time/periods/${periodJulyId}/status`, adm, { status: 'locked' });
  const closed = await postJson<{ close: { id: string; closeNo: number; datasetSha256: string } }>(
    `/time/periods/${periodJulyId}/close`, adm, { confirmWarnings: true }, 201);
  close2Id = closed.close.id;
  assert.equal(closed.close.closeNo, 2);
  const sha1 = psql(`SELECT dataset_sha256 FROM time.period_closes WHERE id = '${close1Id}'`);
  assert.notEqual(closed.close.datasetSha256, sha1, 'nouvelle clôture ⇒ NOUVELLE empreinte');
  assert.equal(psql(`SELECT status FROM time.payroll_exports WHERE id = '${exportCsvId}'`), 'superseded',
    'l\'ancien export est MARQUÉ remplacé à la nouvelle clôture');
  // … mais il reste TÉLÉCHARGEABLE, contenu STRICTEMENT intact.
  const dl = await getJson<{ contentBase64: string; sha256: string }>(`/time/payroll-exports/${exportCsvId}/download`, adm);
  assert.ok(dl.sha256.length === 64 && dl.contentBase64.length > 0);
  const cmp = await getJson<{ differences: Array<{ fields: unknown[] }> }>(
    `/time/closes/${close1Id}/compare?with=${close2Id}`, adm);
  assert.ok(cmp.differences.length >= 1, 'les DIFFÉRENCES entre clôtures sont consultables');
});

test('18 clôture CONCURRENTE : une seule passe (verrou PostgreSQL), une seule clôture active', async () => {
  const adm = await token(slugA, admEmail);
  const periodJune = await created('/time/periods', adm, {
    scopeKind: 'tenant', label: 'Juin 2026', periodStart: '2026-06-01', periodEnd: '2026-06-30',
  });
  assert.equal((await api('/time/calc/run', adm, {
    periodStart: '2026-06-01', periodEnd: '2026-06-30', scopeKind: 'tenant', reason: 'calcul de juin',
  })).status, 201);
  await postJson(`/time/periods/${periodJune}/status`, adm, { status: 'in_review' });
  await postJson(`/time/periods/${periodJune}/status`, adm, { status: 'locked' });
  const fire = () => api(`/time/periods/${periodJune}/close`, adm, { confirmWarnings: true });
  const [r1, r2] = await Promise.all([fire(), fire()]);
  const statuses = [r1.status, r2.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [201, 409], 'DEUX clôtures simultanées : une seule gagne');
  const actives = psql(`SELECT count(*) FROM time.period_closes c
    JOIN time.periods p ON p.id = c.period_id WHERE p.id = '${periodJune}' AND c.status = 'active'`);
  assert.equal(Number(actives), 1);
});

test('19 décisions CONCURRENTES : verrou d\'instance — une transition, jamais deux', async () => {
  const self = await token(slugA, selfEmail);
  const mgr = await token(slugA, mgrEmail);
  const reqA = await created('/time/corrections', self, {
    workDate: FRI, kind: 'justify_late', motive: 'concurrence A', payload: { category: 'transport' },
  });
  await postJson(`/time/corrections/${reqA}/submit`, self, {});
  const [a1, a2] = await Promise.all([
    api(`/time/corrections/${reqA}/decide`, mgr, { action: 'approve' }),
    api(`/time/corrections/${reqA}/decide`, mgr, { action: 'approve' }),
  ]);
  assert.deepEqual([a1.status, a2.status].sort((x, y) => x - y), [200, 409], 'double approbation : UNE transition');
  const reqB = await created('/time/corrections', self, {
    workDate: FRI, kind: 'justify_early_departure', motive: 'concurrence B', payload: { category: 'autorisation' },
  });
  await postJson(`/time/corrections/${reqB}/submit`, self, {});
  const [b1, b2] = await Promise.all([
    api(`/time/corrections/${reqB}/decide`, mgr, { action: 'approve' }),
    api(`/time/corrections/${reqB}/decide`, mgr, { action: 'reject' }),
  ]);
  assert.deepEqual([b1.status, b2.status].sort((x, y) => x - y), [200, 409], 'approbation et rejet simultanés : un seul gagne');
  // La décision d'une demande n'a JAMAIS touché l'autre (liaison sujet ↔ instance).
  const stA = psql(`SELECT status FROM time.correction_requests WHERE id = '${reqA}'`);
  const stB = psql(`SELECT status FROM time.correction_requests WHERE id = '${reqB}'`);
  assert.equal(stA, 'submitted', 'A : étape manager franchie, toujours en circuit');
  assert.ok(['submitted', 'rejected'].includes(stB), `B : état cohérent unique (${stB})`);
});

test('20 RBAC et isolation : sans permission rien ; l\'autre tenant : introuvable ; FK PostgreSQL', async () => {
  const naked = await token(slugA, nakedEmail);
  const bAdm = await token(slugB, bAdmEmail);
  assert.equal((await api('/time/corrections', naked, {
    workDate: WED, kind: 'add_in', motive: 'x', payload: { localTime: '08:00' },
  })).status, 403);
  assert.equal((await api('/time/periods', naked, undefined, 'GET')).status, 403);
  assert.equal((await api('/time/periods', naked, { scopeKind: 'tenant', label: 'x', periodStart: '2026-09-01', periodEnd: '2026-09-30' })).status, 403);
  assert.equal((await api(`/time/closes/${close2Id}/payroll`, bAdm, undefined, 'GET')).status, 404);
  assert.equal((await api(`/time/payroll-exports/${exportCsvId}/download`, bAdm, undefined, 'GET')).status, 403,
    'permission absente côté B : refus avant toute existence');
  assert.ok(psqlFails(`INSERT INTO time.correction_events
      (tenant_id, request_id, employee_id, work_date, kind, effect, created_by)
    VALUES ('${tenantBId}', '${reqAddOut}', '${e1}', '${MON}', 'add_out', '{}', '${selfUserId}')`),
  'FK inter-tenant rejetée PAR POSTGRESQL');
});

test('21 variables préparatoires paie : catégories justifiées, retenues, corrections — AUCUN montant', async () => {
  const adm = await token(slugA, admEmail);
  const pay = await getJson<{ close: Record<string, unknown>; rows: Array<Record<string, unknown>> }>(
    `/time/closes/${close2Id}/payroll`, adm);
  const e1Row = pay.rows.find((r) => r['matricule'] === `CR1-${RID}`)!;
  assert.ok(e1Row);
  assert.equal(e1Row['unjustifiedAbsenceDays'], 0, 'l\'absence de mardi est JUSTIFIÉE (maladie)');
  const justified = e1Row['justified'] as Record<string, { days: number; minutes: number }>;
  assert.equal(justified['maladie']!.days, 1);
  assert.equal(justified['maladie']!.minutes, 480);
  assert.ok((e1Row['correctionsApplied'] as number) >= 2, 'corrections appliquées après calcul initial : comptées');
  const serialized = JSON.stringify(pay).toLowerCase();
  for (const interdit of ['montant', 'taux', 'salaire']) {
    assert.ok(!serialized.includes(interdit), `variables temps SEULEMENT (« ${interdit} » absent)`);
  }
  assert.equal((pay.close as { status?: string }).status, 'active');
});

test('22 journal complet : chaque opération sensible est AUDITÉE', async () => {
  const actions = [
    'time_correction_created', 'time_correction_submitted', 'time_correction_approved',
    'time_correction_rejected', 'time_correction_applied', 'time_correction_event_created',
    'time_correction_application_failed', 'time_attachment_added', 'time_attachment_viewed',
    'time_anomaly_state_changed', 'time_anomaly_assigned', 'time_preclose_consulted',
    'time_period_created', 'time_period_closed', 'time_period_reopened',
    'time_payroll_export_generated', 'time_payroll_export_downloaded', 'time_payroll_consulted',
  ];
  const count = psql(`SELECT count(DISTINCT action) FROM audit.audit_log
    WHERE tenant_id = '${tenantAId}' AND action IN (${actions.map((a) => `'${a}'`).join(',')})`);
  assert.equal(Number(count), actions.length, `toutes les actions attendues sont au journal (${count}/${actions.length})`);
});
