/**
 * E2E Moteur de présence (E10.2) — conditions de validation du sponsor :
 * bruts STRICTEMENT inchangés par le calcul ; reproductibilité (relance = zéro
 * écriture, instantané complet : horaire, fuseau, paramètres E4 avec provenance,
 * version du moteur) ; changement de paramètre FUTUR sans effet sur les jours
 * passés ; rotation 22:00–06:00 rattachée à la bonne journée (sortie après minuit,
 * y compris vers un jour de repos) ; sortie manquante ⇒ anomalie SANS heure
 * inventée ; tolérance appliquée à la date (retard dans la tolérance = fait mesuré,
 * zéro retenu) ; fériés distingués des repos (travaillés ou non) ; heures de nuit
 * découpées sur les périodes réelles ; HS CANDIDATES sans montant ; jour sans
 * événement ≠ absence automatique (non-appariés en attente ⇒ unresolved) ; un jour
 * en ERREUR n'en cache pas d'autres ; deux exécutions concurrentes ⇒ une seule
 * gagne (contrainte PostgreSQL, 409) ; recalcul motivé = nouvelle version +
 * historique + comparaison, la prévisualisation n'écrit rien ; isolation tenant +
 * FK inter-tenant rejetée par la base ; portées self/unité effectives ; recalcul
 * sans permission refusé ; agrégats = somme retraçable des journaliers ; volume
 * documenté ; E5 (anomalies bloquantes) et E6 (exécutions, consultations, états).
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
const slugA = `tc-a-${rid}`;
const slugB = `tc-b-${rid}`;

const admEmail = `tcadm.${rid}@demo.bj`;    // exécutions + résultats + anomalies + fixtures (tenant)
const chefEmail = `tcchef.${rid}@demo.bj`;  // results/anomalies portée UNITÉ RH — PAS de calc_recalc
const selfEmail = `tcself.${rid}@demo.bj`;  // results_view_own, lié au salarié E1
const nakedEmail = `tcnone.${rid}@demo.bj`; // aucune permission time.*
const bAdmEmail = `tcbadm.${rid}@demo.bj`;

let app: INestApplication;
let base = '';
let tenantAId = '';
let tenantBId = '';
let selfUserId = '';
let admUserId = '';

async function seedUser(tenantId: string, email: string, perms: string[], tenantScope: boolean): Promise<string> {
  const h = await argon2.hash(P, { type: argon2.argon2id });
  const id = psql(`INSERT INTO admin.users (tenant_id, email, password_hash) VALUES ('${tenantId}','${email}','${h}') RETURNING id`);
  if (tenantScope) psql(`INSERT INTO admin.user_scopes (tenant_id, user_id, scope_type) VALUES ('${tenantId}','${id}','tenant')`);
  if (perms.length > 0) {
    const role = psql(`INSERT INTO admin.roles (tenant_id, key, name) VALUES ('${tenantId}','r-${email.split('@')[0]}','R') RETURNING id`);
    for (const p of perms) psql(`INSERT INTO admin.role_permissions (tenant_id, role_id, permission_key) VALUES ('${tenantId}','${role}','${p}')`);
    psql(`INSERT INTO admin.user_roles (tenant_id, user_id, role_id) VALUES ('${tenantId}','${id}','${role}')`);
  }
  return id;
}

before(async () => {
  tenantAId = psql(`INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('${slugA}','TC A',true) RETURNING id`);
  tenantBId = psql(`INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('${slugB}','TC B',true) RETURNING id`);
  admUserId = await seedUser(tenantAId, admEmail, [
    'time.calc_run', 'time.calc_recalc', 'time.calc_view',
    'time.results_view', 'time.results_view_own', 'time.anomalies_view', 'time.anomalies_manage',
    'time.schedules_view', 'time.schedules_manage', 'time.schedules_assign',
    'time.punches_import', 'time.punches_view', 'time.devices_manage',
    'org.view', 'org.manage', 'employees.view', 'employees.manage', 'employees.assign',
    'notify.manage', 'audit.view',
  ], true);
  selfUserId = await seedUser(tenantAId, selfEmail, ['time.results_view_own'], true);
  await seedUser(tenantAId, nakedEmail, ['employees.view'], true);
  await seedUser(tenantBId, bAdmEmail, [
    'time.calc_run', 'time.calc_view', 'time.results_view', 'time.anomalies_view',
  ], true);
  // chef : portée UNITÉ posée après création de l'organisation.
  await seedUser(tenantAId, chefEmail, ['time.results_view', 'time.anomalies_view', 'time.anomalies_manage', 'time.calc_view'], false);

  // Paramètres E4 (famille temps.*) : fuseau par défaut + tolérance de retard.
  // La tolérance v1 est BORNÉE au 2026-08-01 pour que le test « paramètre futur »
  // insère une v2 SANS chevauchement (contrainte d'exclusion E4).
  psql(`INSERT INTO compliance.legal_parameters
          (tenant_id, country_code, key, value, effective_from, status, is_legal_sensitive,
           confidence, source_text, verified_by, verified_at)
        VALUES ('${tenantAId}', 'BJ', 'temps.fuseau.defaut', '"Africa/Porto-Novo"', '2020-01-01', 'active', false,
                'verified', 'Fuseau du siège (IANA) — paramètre opérationnel', 'fixture-e2e', '2026-01-01')`);
  psql(`INSERT INTO compliance.legal_parameters
          (tenant_id, country_code, key, value, effective_from, effective_to, status, is_legal_sensitive,
           confidence, source_text, verified_by, verified_at)
        VALUES ('${tenantAId}', 'BJ', 'temps.tolerance.retard', '10', '2020-01-01', '2026-08-01', 'active', false,
                'verified', 'Tolérance opérationnelle de retard (minutes)', 'fixture-e2e', '2026-01-01')`);

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

// ---------------------------------------------------------------------------
// Fixtures : organisation, salariés, horaires, férié, pointages de la semaine
// du lundi 2026-07-06 au dimanche 2026-07-12 (fuseau Africa/Porto-Novo, UTC+1).
// ---------------------------------------------------------------------------
let coA = ''; let siteA = ''; let uRh = ''; let uIt = '';
let e1 = ''; let e2 = ''; let e3 = ''; let e4 = ''; let e5 = ''; let e6 = ''; let e7 = '';
let dayModel = ''; let nightModel = '';
let rawFingerprint = '';
let eventsFingerprint = '';
const MON = '2026-07-06'; const TUE = '2026-07-07'; const WED = '2026-07-08';
const THU = '2026-07-09'; const FRI = '2026-07-10'; const SAT = '2026-07-11'; const SUN = '2026-07-12';

interface DayResult {
  id: string; workDate: string; version: number; dayStatus: string; calcState: string;
  presenceMinutes: number; workedMinutes: number; breakMinutes: number;
  lateMinutesRaw: number; lateMinutes: number;
  earlyDepartureMinutesRaw: number; earlyDepartureMinutes: number;
  absenceMinutes: number; nightMinutes: number; restDayMinutes: number; holidayMinutes: number;
  overtimeCandidateMinutes: number; firstIn: string | null; lastOut: string | null;
  workPeriods: Array<{ startMinute: number; endMinute: number }>;
  engineVersion: string; openAnomalies: number; tz: string;
}
interface DayDetail {
  result: DayResult & { paramsUsed: Record<string, { value: unknown; parameterId: string | null; effectiveFrom: string | null; source: string }>; usedEventIds: string[] };
  anomalies: Array<{ id: string; code: string; severity: string; state: string }>;
  events: unknown[]; versionCount: number; self: boolean;
}
interface RunOut {
  run: { id: string; status: string; employeesCount: number; daysCount: number; resultsWritten: number;
    resultsUnchanged: number; resultsError: number; anomaliesCount: number; durationMs: number;
    engineVersion: string; isRecalc: boolean; reason: string };
}

async function dayOf(tok: string, emp: string, date: string): Promise<DayDetail> {
  return getJson<DayDetail>(`/time/results/day?employeeId=${emp}&date=${date}`, tok);
}

async function activate(adm: string, entity: string, id: string): Promise<void> {
  const r = await api(`/org/${entity}/${id}/status`, adm, { status: 'active' });
  assert.equal(r.status, 200, `activation ${entity}`);
}

async function punch(adm: string, employeeId: string, dateTime: string, eventType: string, withSite = true): Promise<void> {
  const r = await api('/time/punches/manual', adm, {
    employeeId, dateTime, eventType, ...(withSite ? { siteId: siteA } : {}), note: 'fixture E10.2',
  });
  assert.equal(r.status, 201, `pointage ${dateTime} ${eventType} → ${r.status} ${await r.text().catch(() => '')}`);
}

test('01 fixtures : organisation, salariés, horaires jour/nuit, férié, modèle E5', async () => {
  const adm = await token(slugA, admEmail);
  coA = await created('/org/companies', adm, { code: 'TC-CO', labelFr: 'Société', labelEn: 'Company' });
  await activate(adm, 'companies', coA);
  siteA = await created('/org/sites', adm, { code: 'TC-SITE', labelFr: 'Site Cotonou', labelEn: 'Cotonou', companyId: coA });
  await activate(adm, 'sites', siteA);
  psql(`UPDATE org.sites SET time_zone = 'Africa/Porto-Novo' WHERE id = '${siteA}'`);
  uRh = await created('/org/units', adm, { code: 'TC-RH', labelFr: 'RH', labelEn: 'HR', unitType: 'direction', companyId: coA });
  await activate(adm, 'units', uRh);
  uIt = await created('/org/units', adm, { code: 'TC-IT', labelFr: 'IT', labelEn: 'IT', unitType: 'direction', companyId: coA });
  await activate(adm, 'units', uIt);
  const chefId = psql(`SELECT id FROM admin.users WHERE email = '${chefEmail}'`);
  psql(`INSERT INTO admin.user_scopes (tenant_id, user_id, scope_type, scope_ref) VALUES ('${tenantAId}','${chefId}','department','${uRh}')`);

  const mk = async (mat: string, first: string, unit: string | null, hire: string): Promise<string> => {
    const id = ((await (await api('/employees', adm, {
      matricule: mat, firstName: first, lastName: 'Calc', hireDate: hire,
    })).json()) as { id: string }).id;
    psql(`UPDATE core.employees SET status = 'active' WHERE id = '${id}'`);
    if (unit !== null) {
      const asg = await api(`/employees/${id}/assignments`, adm, {
        companyId: coA, siteId: siteA, unitId: unit, effectiveFrom: hire, isPrimary: true,
      });
      assert.equal(asg.status, 201, 'affectation');
    }
    return id;
  };
  e1 = await mk(`TC1-${RID}`, 'Awa', uRh, '2025-01-06');
  e2 = await mk(`TC2-${RID}`, 'Bio', uIt, '2025-01-06');
  e3 = await mk(`TC3-${RID}`, 'Chris', uRh, '2026-12-01'); // embauche FUTURE
  e4 = await mk(`TC4-${RID}`, 'Dossi', uRh, '2025-01-06'); // suspendu APRÈS ses pointages
  e5 = await mk(`TC5-${RID}`, 'Fifa', uRh, '2025-01-06');  // AUCUN horaire affecté
  e6 = await mk(`TC6-${RID}`, 'Gado', null, '2025-01-06'); // AUCUNE affectation E9
  psql(`UPDATE core.employees SET user_id = '${selfUserId}' WHERE id = '${e1}'`);

  // Horaire de JOUR : lun–ven 08:00–17:00, pause 12:00–13:00 ; sam/dim repos.
  dayModel = await created('/time/schedules/models', adm, { code: 'TC-JOUR', labelFr: 'Jour', labelEn: 'Day', kind: 'fixed' });
  const dayDays = [0, 1, 2, 3, 4].map((i) => ({
    dayIndex: i, isRest: false, startMinute: 480, endMinute: 1020, breakStartMinute: 720, breakEndMinute: 780,
  })).concat([{ dayIndex: 5, isRest: true }, { dayIndex: 6, isRest: true }] as never[]);
  assert.equal((await api(`/time/schedules/models/${dayModel}/versions`, adm, {
    effectiveFrom: '2026-01-05', cycleDays: 7, days: dayDays,
  })).status, 201);
  // Rotation de NUIT : lun–ven 22:00–06:00 (le lendemain), sam/dim repos.
  nightModel = await created('/time/schedules/models', adm, { code: 'TC-NUIT', labelFr: 'Nuit', labelEn: 'Night', kind: 'rotation' });
  const nightDays = [0, 1, 2, 3, 4].map((i) => ({
    dayIndex: i, isRest: false, startMinute: 1320, endMinute: 1800,
  })).concat([{ dayIndex: 5, isRest: true }, { dayIndex: 6, isRest: true }] as never[]);
  assert.equal((await api(`/time/schedules/models/${nightModel}/versions`, adm, {
    effectiveFrom: '2026-01-05', cycleDays: 7, days: nightDays,
  })).status, 201);
  // Affectations (ancre = lundi 2026-01-05 → lundi 06/07 = jour 0 du cycle).
  for (const [emp, model] of [[e1, dayModel], [e3, dayModel], [e4, dayModel], [e6, dayModel]] as const) {
    assert.equal((await api('/time/schedules/assignments', adm, {
      employeeId: emp, modelId: model, anchorDate: '2026-01-05', effectiveFrom: '2026-01-05',
    })).status, 201);
  }
  assert.equal((await api('/time/schedules/assignments', adm, {
    employeeId: e2, modelId: nightModel, anchorDate: '2026-01-05', effectiveFrom: '2026-01-05',
  })).status, 201);
  // Férié : vendredi 2026-07-10 (calendrier GLOBAL).
  const cal = await created('/time/holidays/calendars', adm, { code: 'TC-CAL', labelFr: 'National', labelEn: 'National' });
  assert.equal((await api('/time/holidays', adm, {
    calendarId: cal, date: FRI, labelFr: 'Fête test', labelEn: 'Test holiday',
  })).status, 201);
  // Modèle E5 pour les anomalies BLOQUANTES (créé puis ACTIVÉ — sinon rien ne part).
  const tpl = await api('/admin/notify/templates', adm, {
    key: 'temps_anomalies_bloquantes', name: 'Anomalies bloquantes de présence',
    subjectFr: 'Présence : {{bloquantes}} anomalie(s) bloquante(s)', subjectEn: 'Attendance: {{bloquantes}} blocking anomaly(ies)',
    bodyFr: 'Exécution {{executionId}} ({{periode}}) : {{bloquantes}} anomalie(s) bloquante(s) à traiter.',
    bodyEn: 'Run {{executionId}} ({{periode}}): {{bloquantes}} blocking anomaly(ies) to handle.',
    variables: ['executionId', 'bloquantes', 'periode'], channels: ['in_app'], mandatory: false,
  });
  assert.equal(tpl.status, 201, await tpl.text().catch(() => ''));
  const tplId = ((await tpl.json()) as { id: string }).id;
  assert.equal((await api(`/admin/notify/templates/${tplId}/activate`, adm)).status, 200);
});

test('02 fixtures : pointages de la semaine (saisie manuelle) + empreinte des BRUTS', async () => {
  const adm = await token(slugA, admEmail);
  // E1 — lundi : pauses POINTÉES ; mardi : retard 8 min DANS la tolérance, pause
  // couverte non pointée ; mercredi : sortie manquante ; jeudi : rien (absent) ;
  // vendredi FÉRIÉ travaillé ; dimanche REPOS travaillé.
  await punch(adm, e1, `${MON} 07:58`, 'E');
  await punch(adm, e1, `${MON} 12:00`, 'PAUSE');
  await punch(adm, e1, `${MON} 13:00`, 'REPRISE');
  await punch(adm, e1, `${MON} 17:05`, 'S');
  await punch(adm, e1, `${TUE} 08:08`, 'E');
  await punch(adm, e1, `${TUE} 17:00`, 'S');
  await punch(adm, e1, `${WED} 08:00`, 'E');
  await punch(adm, e1, `${FRI} 09:00`, 'E');
  await punch(adm, e1, `${FRI} 12:00`, 'S');
  await punch(adm, e1, `${SUN} 10:00`, 'E');
  await punch(adm, e1, `${SUN} 12:00`, 'S');
  // E2 — nuits 22:00–06:00 : nominale, en retard (30), sortie manquante, nominale,
  // vendredi→samedi (sortie après minuit vers un jour de REPOS).
  await punch(adm, e2, `${MON} 21:55`, 'E');
  await punch(adm, e2, `${TUE} 06:00`, 'S');
  await punch(adm, e2, `${TUE} 22:30`, 'E');
  await punch(adm, e2, `${WED} 06:10`, 'S');
  await punch(adm, e2, `${WED} 22:00`, 'E');
  await punch(adm, e2, `${THU} 22:00`, 'E');
  await punch(adm, e2, `${FRI} 06:00`, 'S');
  await punch(adm, e2, `${FRI} 22:00`, 'E');
  await punch(adm, e2, `${SAT} 06:00`, 'S');
  // E3 (embauche future) : pointage → non apparié (not_yet_hired) → EN ATTENTE.
  await punch(adm, e3, `${TUE} 08:00`, 'E');
  // E4 : pointage apparié PUIS suspension (l'inactivité doit ressortir au calcul).
  await punch(adm, e4, `${TUE} 08:00`, 'E');
  await punch(adm, e4, `${TUE} 17:00`, 'S');
  psql(`UPDATE core.employees SET status = 'suspended' WHERE id = '${e4}'`);
  // E5 : pointages SANS horaire applicable.
  await punch(adm, e5, `${TUE} 09:00`, 'E');
  await punch(adm, e5, `${TUE} 10:00`, 'S');
  // E6 : aucune affectation E9 → non apparié (no_assignment) → EN ATTENTE.
  await punch(adm, e6, `${TUE} 08:00`, 'E', false);

  // Empreintes AVANT tout calcul : bruts et événements normalisés.
  rawFingerprint = psql(`SELECT md5(string_agg(id::text || '|' || coalesce(source_datetime_raw,''), ',' ORDER BY id))
    FROM time.raw_punches WHERE tenant_id = '${tenantAId}'`);
  eventsFingerprint = psql(`SELECT md5(string_agg(id::text || '|' || coalesce(occurred_at::text,'') || '|' || match_status || '|' || event_type, ',' ORDER BY id))
    FROM time.punch_events WHERE tenant_id = '${tenantAId}'`);
  assert.ok(rawFingerprint.length === 32 && eventsFingerprint.length === 32);
});

let run1Id = '';

test('03 exécution initiale : compteurs exacts, durée mesurée, notification E5 des bloquantes', async () => {
  const adm = await token(slugA, admEmail);
  const res = await api('/time/calc/run', adm, {
    periodStart: MON, periodEnd: SUN, scopeKind: 'tenant', reason: 'calcul initial de la semaine',
  });
  assert.equal(res.status, 201, await res.text().catch(() => ''));
  const { run } = (await res.json()) as RunOut;
  run1Id = run.id;
  assert.equal(run.status, 'completed');
  assert.equal(run.employeesCount, 6);
  assert.equal(run.daysCount, 7);
  assert.equal(run.resultsWritten, 42, 'première exécution : 6 salariés × 7 jours écrits');
  assert.equal(run.resultsUnchanged, 0);
  assert.equal(run.resultsError, 0);
  assert.equal(run.anomaliesCount, 16, 'anomalies : e1×3, e2×2, e3×1, e4×1, e5×1, e6×8');
  assert.equal(run.isRecalc, false);
  assert.ok(typeof run.durationMs === 'number' && run.durationMs >= 0, 'durée MESURÉE');
  assert.ok(run.engineVersion.startsWith('kora-presence-'));
  // E5 : anomalie BLOQUANTE (e4 suspendu avec pointages) ⇒ notification aux
  // porteurs de time.anomalies_manage via le modèle ACTIF.
  const notifCount = psql(`SELECT count(*) FROM notify.notifications n
    WHERE n.tenant_id = '${tenantAId}' AND n.template_key = 'temps_anomalies_bloquantes'`);
  assert.ok(Number(notifCount) >= 1, `notification bloquantes attendue (${notifCount})`);
  // E6 : début ET fin d'exécution audités.
  const audits = psql(`SELECT count(*) FROM audit.audit_log
    WHERE tenant_id = '${tenantAId}' AND action IN ('time_calc_run_started','time_calc_run_finished')`);
  assert.equal(Number(audits), 2);
});

test('04 journée nominale : pauses pointées, instantané complet, provenance des paramètres', async () => {
  const adm = await token(slugA, admEmail);
  const d = await dayOf(adm, e1, MON);
  assert.equal(d.result.dayStatus, 'present');
  assert.equal(d.result.workedMinutes, 487);      // (07:58→12:00) + (13:00→17:05)
  assert.equal(d.result.breakMinutes, 60);
  assert.equal(d.result.presenceMinutes, 547);
  assert.equal(d.result.lateMinutesRaw, 0);
  assert.equal(d.result.overtimeCandidateMinutes, 7, 'HS CANDIDATES = travail au-delà du planifié (487−480) — aucun montant nulle part');
  assert.equal(d.result.firstIn, '2026-07-06T06:58:00.000Z', 'UTC exact (Porto-Novo = UTC+1)');
  assert.equal(d.result.lastOut, '2026-07-06T16:05:00.000Z');
  assert.equal(d.result.workPeriods.length, 2);
  assert.equal(d.result.usedEventIds.length, 4);
  assert.equal(d.result.openAnomalies, 0);
  assert.equal(d.result.tz, 'Africa/Porto-Novo');
  // Reproductibilité : paramètres E4 AVEC provenance et identifiant de version.
  const tol = d.result.paramsUsed['temps.tolerance.retard']!;
  assert.equal(tol.value, 10);
  assert.equal(tol.source, 'parametre');
  assert.ok(typeof tol.parameterId === 'string' && tol.parameterId.length === 36);
  assert.equal(tol.effectiveFrom, '2020-01-01');
  const pause = d.result.paramsUsed['temps.pause.minimale']!;
  assert.equal(pause.source, 'defaut');
  assert.equal(pause.parameterId, null);
  assert.ok(d.result.engineVersion.startsWith('kora-presence-'));
});

test('05 tolérance À LA DATE : retard 8 min mesuré, ZÉRO retenu ; pause couverte déduite', async () => {
  const adm = await token(slugA, admEmail);
  const d = await dayOf(adm, e1, TUE);
  assert.equal(d.result.dayStatus, 'present', 'dans la tolérance = présent');
  assert.equal(d.result.lateMinutesRaw, 8, 'le fait MESURÉ est conservé');
  assert.equal(d.result.lateMinutes, 0, 'le retenu est nul (tolérance 10)');
  assert.equal(d.result.workedMinutes, 472, '(08:08→17:00) − pause planifiée couverte 60');
  assert.equal(d.result.breakMinutes, 60);
  assert.equal(d.result.absenceMinutes, 8);
});

test('06 sortie manquante : anomalie SANS heure inventée, manque non chiffré', async () => {
  const adm = await token(slugA, admEmail);
  const d = await dayOf(adm, e1, WED);
  assert.equal(d.result.dayStatus, 'incomplete_punches');
  assert.equal(d.result.workedMinutes, 0, 'AUCUNE période comptée');
  assert.equal(d.result.absenceMinutes, 0, 'absence NON chiffrée sur des faits troués');
  assert.notEqual(d.result.firstIn, null, 'l\'entrée reste un FAIT retenu');
  assert.equal(d.result.lastOut, null, 'aucune sortie inventée');
  const codes = d.anomalies.map((a) => a.code);
  assert.ok(codes.includes('missing_out'));
  assert.equal(d.anomalies.find((a) => a.code === 'missing_out')!.state, 'open');
});

test('07 jour sans événement : absent si les faits le disent, UNRESOLVED si des non-appariés attendent', async () => {
  const adm = await token(slugA, admEmail);
  const abs = await dayOf(adm, e1, THU);
  assert.equal(abs.result.dayStatus, 'absent');
  assert.equal(abs.result.absenceMinutes, 480, 'le dû planifié (9 h − 1 h de pause)');
  // e6 : pointage NON APPARIÉ (aucune affectation E9) → la journée n'est PAS déclarée
  // absente : elle reste à résoudre.
  const unres = await dayOf(adm, e6, TUE);
  assert.equal(unres.result.dayStatus, 'unresolved');
  const codes6 = unres.anomalies.map((a) => a.code);
  assert.ok(codes6.includes('unmatched_event_pending'));
  assert.ok(codes6.includes('no_assignment'));
  // e5 : pointages APPARIÉS mais aucun horaire → not_scheduled + anomalie, travail compté.
  const ns = await dayOf(adm, e5, TUE);
  assert.equal(ns.result.dayStatus, 'not_scheduled');
  assert.equal(ns.result.workedMinutes, 60);
  assert.ok(ns.anomalies.map((a) => a.code).includes('no_schedule'));
});

test('08 rotations de nuit : rattachement au bon jour, heures de nuit découpées, repos préservé', async () => {
  const adm = await token(slugA, admEmail);
  const mon = await dayOf(adm, e2, MON);
  assert.equal(mon.result.dayStatus, 'present');
  assert.equal(mon.result.workedMinutes, 485);
  assert.equal(mon.result.nightMinutes, 480, 'seule la fenêtre 22:00–06:00 compte');
  assert.equal(mon.result.firstIn, '2026-07-06T20:55:00.000Z');
  assert.equal(mon.result.lastOut, '2026-07-07T05:00:00.000Z', 'sortie APRÈS minuit rattachée au lundi');
  assert.equal(mon.result.overtimeCandidateMinutes, 5);
  const tue = await dayOf(adm, e2, TUE);
  assert.equal(tue.result.dayStatus, 'late');
  assert.equal(tue.result.lateMinutesRaw, 30);
  assert.equal(tue.result.lateMinutes, 30, 'au-delà de la tolérance : retenu = mesuré (arrondi 1)');
  assert.equal(tue.result.nightMinutes, 450);
  const wed = await dayOf(adm, e2, WED);
  assert.equal(wed.result.dayStatus, 'incomplete_punches');
  assert.ok(wed.anomalies.map((a) => a.code).includes('missing_out'));
  // Vendredi est FÉRIÉ : la nuit de vendredi est un férié TRAVAILLÉ de 480 min
  // (la sortie de 06:00 SAMEDI lui est rattachée), le samedi de repos reste intact.
  const fri = await dayOf(adm, e2, FRI);
  assert.equal(fri.result.dayStatus, 'worked_public_holiday');
  assert.equal(fri.result.workedMinutes, 480);
  assert.equal(fri.result.holidayMinutes, 480);
  assert.equal(fri.result.nightMinutes, 480);
  assert.equal(fri.result.usedEventIds.length, 2);
  const sat = await dayOf(adm, e2, SAT);
  assert.equal(sat.result.dayStatus, 'rest_day', 'la sortie de 06:00 samedi appartient au VENDREDI');
  assert.equal(sat.result.workedMinutes, 0);
  assert.equal(sat.result.usedEventIds.length, 0);
});

test('09 fériés ≠ repos : travaillés ou non, quatre statuts distincts, HS candidates', async () => {
  const adm = await token(slugA, admEmail);
  const fri = await dayOf(adm, e1, FRI); // férié TRAVAILLÉ
  assert.equal(fri.result.dayStatus, 'worked_public_holiday');
  assert.equal(fri.result.holidayMinutes, 180);
  assert.equal(fri.result.restDayMinutes, 0);
  assert.equal(fri.result.overtimeCandidateMinutes, 180, 'tout travail d\'un jour non dû est CANDIDAT');
  const sun = await dayOf(adm, e1, SUN); // repos TRAVAILLÉ
  assert.equal(sun.result.dayStatus, 'worked_rest_day');
  assert.equal(sun.result.restDayMinutes, 120);
  assert.equal(sun.result.holidayMinutes, 0);
  const sat = await dayOf(adm, e1, SAT); // repos simple
  assert.equal(sat.result.dayStatus, 'rest_day');
  const friNight = await dayOf(adm, e2, THU); // veille du férié : nuit ordinaire complète
  assert.equal(friNight.result.dayStatus, 'present');
});

test('10 hors emploi : suspendu avec pointages = anomalie BLOQUANTE ; embauche future = journée à résoudre', async () => {
  const adm = await token(slugA, admEmail);
  const susp = await dayOf(adm, e4, TUE);
  assert.equal(susp.result.dayStatus, 'suspended');
  assert.equal(susp.result.workedMinutes, 0, 'aucune heure comptée hors emploi');
  const anom = susp.anomalies.find((a) => a.code === 'suspended');
  assert.ok(anom, 'anomalie « suspended » présente');
  assert.equal(anom!.severity, 'blocking');
  const fut = await dayOf(adm, e3, TUE);
  assert.equal(fut.result.dayStatus, 'not_employed');
  assert.ok(fut.anomalies.map((a) => a.code).includes('unmatched_event_pending'),
    'le pointage refusé en amont (not_yet_hired) reste signalé comme NON APPARIÉ');
});

test('11 idempotence et bruts intacts : relance = ZÉRO écriture, empreintes inchangées', async () => {
  const adm = await token(slugA, admEmail);
  const res = await api('/time/calc/run', adm, {
    periodStart: MON, periodEnd: SUN, scopeKind: 'tenant', reason: 'relance de contrôle (idempotence)',
  });
  assert.equal(res.status, 201);
  const { run } = (await res.json()) as RunOut;
  assert.equal(run.status, 'completed');
  assert.equal(run.resultsWritten, 0, 'contenu identique ⇒ AUCUNE nouvelle version');
  assert.equal(run.resultsUnchanged, 42);
  const d = await dayOf(adm, e1, MON);
  assert.equal(d.result.version, 1, 'la version n\'a PAS bougé');
  assert.equal(d.versionCount, 1);
  // Les BRUTS et les événements normalisés sont STRICTEMENT inchangés.
  const raw2 = psql(`SELECT md5(string_agg(id::text || '|' || coalesce(source_datetime_raw,''), ',' ORDER BY id))
    FROM time.raw_punches WHERE tenant_id = '${tenantAId}'`);
  const ev2 = psql(`SELECT md5(string_agg(id::text || '|' || coalesce(occurred_at::text,'') || '|' || match_status || '|' || event_type, ',' ORDER BY id))
    FROM time.punch_events WHERE tenant_id = '${tenantAId}'`);
  assert.equal(raw2, rawFingerprint, 'raw_punches intacts');
  assert.equal(ev2, eventsFingerprint, 'punch_events intacts');
});

test('12 paramètre FUTUR : la version à venir ne change RIEN aux jours passés', async () => {
  const adm = await token(slugA, admEmail);
  // Tolérance v2 (3 min) à effet du 2026-08-01 — POSTÉRIEURE à la semaine calculée.
  psql(`INSERT INTO compliance.legal_parameters
          (tenant_id, country_code, key, value, effective_from, status, is_legal_sensitive,
           confidence, source_text, verified_by, verified_at)
        VALUES ('${tenantAId}', 'BJ', 'temps.tolerance.retard', '3', '2026-08-01', 'active', false,
                'verified', 'Resserrement à venir de la tolérance', 'fixture-e2e', '2026-07-01')`);
  const res = await api('/time/calc/recalc', adm, {
    periodStart: MON, periodEnd: SUN, scopeKind: 'tenant', reason: 'contrôle après publication d\'un paramètre à effet futur',
  });
  assert.equal(res.status, 201);
  const { run } = (await res.json()) as RunOut;
  assert.equal(run.resultsWritten, 0, 'les jours passés se résolvent avec la version EN VIGUEUR À LEUR DATE');
  assert.equal(run.resultsUnchanged, 42);
  const d = await dayOf(adm, e1, TUE);
  assert.equal(d.result.version, 1);
  assert.equal(d.result.lateMinutes, 0, 'toujours dans la tolérance de JUILLET (10 min)');
});

test('13 un jour en ERREUR n\'en cache pas d\'autres : fuseau invalide isolé, exécution completed_with_errors', async () => {
  const adm = await token(slugA, admEmail);
  const badSite = await created('/org/sites', adm, { code: 'TC-BAD', labelFr: 'Site fuseau cassé', labelEn: 'Broken tz', companyId: coA });
  await activate(adm, 'sites', badSite);
  psql(`UPDATE org.sites SET time_zone = 'Etc/Nonexistent' WHERE id = '${badSite}'`);
  e7 = ((await (await api('/employees', adm, {
    matricule: `TC7-${RID}`, firstName: 'Hama', lastName: 'Calc', hireDate: '2025-01-06',
  })).json()) as { id: string }).id;
  psql(`UPDATE core.employees SET status = 'active' WHERE id = '${e7}'`);
  assert.equal((await api(`/employees/${e7}/assignments`, adm, {
    companyId: coA, siteId: badSite, unitId: uIt, effectiveFrom: '2025-01-06', isPrimary: true,
  })).status, 201);
  assert.equal((await api('/time/schedules/assignments', adm, {
    employeeId: e7, modelId: dayModel, anchorDate: '2026-01-05', effectiveFrom: '2026-01-05',
  })).status, 201);
  await punch(adm, e7, `${MON} 08:00`, 'E', false);
  await punch(adm, e7, `${MON} 16:00`, 'S', false);
  await punch(adm, e7, `${TUE} 08:00`, 'E', false);
  await punch(adm, e7, `${TUE} 16:00`, 'S', false);
  const res = await api('/time/calc/run', adm, {
    periodStart: MON, periodEnd: WED, scopeKind: 'employee', scopeId: e7, reason: 'calcul salarié au fuseau cassé',
  });
  assert.equal(res.status, 201);
  const { run } = (await res.json()) as RunOut;
  assert.equal(run.status, 'completed_with_errors');
  assert.equal(run.resultsError, 2, 'lundi et mardi en erreur (pointages + fuseau invalide)');
  assert.equal(run.resultsWritten, 3, 'le MERCREDI (absent, sans conversion) est calculé normalement');
  const err = await dayOf(adm, e7, MON);
  assert.equal(err.result.calcState, 'error');
  assert.equal(err.result.dayStatus, 'unresolved');
  const cf = err.anomalies.find((a) => a.code === 'calc_failed');
  assert.ok(cf && cf.severity === 'blocking');
  const okDay = await dayOf(adm, e7, WED);
  assert.equal(okDay.result.calcState, 'ok');
  assert.equal(okDay.result.dayStatus, 'absent');
});

test('14 recalcul MOTIVÉ : prévisualisation sans écriture, nouvelle version, historique, comparaison', async () => {
  const adm = await token(slugA, admEmail);
  // Motif réel : pointages du jeudi arrivés APRÈS le calcul initial.
  await punch(adm, e1, `${THU} 08:00`, 'E');
  await punch(adm, e1, `${THU} 16:00`, 'S');
  // 1. PRÉVISUALISATION : l'écart est annoncé, RIEN n'est écrit.
  const prev = await api('/time/calc/preview', adm, {
    periodStart: THU, periodEnd: THU, scopeKind: 'employee', scopeId: e1, reason: 'pointages reçus après coup',
  });
  assert.equal(prev.status, 200);
  const p = (await prev.json()) as { evaluated: number; wouldWrite: number; unchanged: number; diffs: Array<Record<string, unknown>> };
  assert.equal(p.evaluated, 1);
  assert.equal(p.wouldWrite, 1);
  assert.equal(p.diffs[0]!['currentStatus'], 'absent');
  assert.equal(p.diffs[0]!['nextStatus'], 'early_departure');
  const before = await dayOf(adm, e1, THU);
  assert.equal(before.result.version, 1, 'la prévisualisation N\'A RIEN écrit');
  assert.equal(before.result.dayStatus, 'absent');
  // 2. RECALCUL : nouvelle version, l'ancienne demeure.
  const rec = await api('/time/calc/recalc', adm, {
    periodStart: THU, periodEnd: THU, scopeKind: 'employee', scopeId: e1, reason: 'pointages reçus après coup',
  });
  assert.equal(rec.status, 201);
  const { run } = (await rec.json()) as RunOut;
  assert.equal(run.isRecalc, true);
  assert.equal(run.resultsWritten, 1);
  const after = await dayOf(adm, e1, THU);
  assert.equal(after.result.version, 2);
  assert.equal(after.result.dayStatus, 'early_departure');
  assert.equal(after.result.earlyDepartureMinutesRaw, 60);
  assert.equal(after.result.workedMinutes, 420, '(08:00→16:00) − pause couverte 60');
  assert.equal(after.versionCount, 2);
  // 3. HISTORIQUE : les deux versions, avec le MOTIF de chaque exécution.
  const hist = await getJson<{ versions: Array<Record<string, unknown>> }>(
    `/time/results/history?employeeId=${e1}&date=${THU}`, adm);
  assert.equal(hist.versions.length, 2);
  assert.equal(hist.versions[0]!['version'], 1);
  assert.equal(hist.versions[0]!['isCurrent'], false);
  assert.equal(hist.versions[0]!['dayStatus'], 'absent');
  assert.equal(hist.versions[1]!['isCurrent'], true);
  assert.equal(hist.versions[1]!['runIsRecalc'], true);
  assert.equal(hist.versions[1]!['runReason'], 'pointages reçus après coup');
  // 4. COMPARAISON : l'écart est EXPLIQUÉ champ par champ.
  const cmp = await getJson<{ fields: Array<{ field: string; a: unknown; b: unknown }> }>(
    `/time/results/compare?employeeId=${e1}&date=${THU}&v1=1&v2=2`, adm);
  const changedNames = cmp.fields.map((f) => f.field);
  assert.ok(changedNames.includes('dayStatus'));
  assert.ok(changedNames.includes('workedMinutes'));
  assert.ok(changedNames.includes('absenceMinutes'));
  const st = cmp.fields.find((f) => f.field === 'dayStatus')!;
  assert.equal(st.a, 'absent');
  assert.equal(st.b, 'early_departure');
});

test('15 anomalies : catalogue fermé FR/EN, file à portée réelle, états contrôlés, resolved = E10.3', async () => {
  const adm = await token(slugA, admEmail);
  const chef = await token(slugA, chefEmail);
  const naked = await token(slugA, nakedEmail);
  // Catalogue : 18 codes STABLES, libellés bilingues, sévérité par défaut.
  const cat = await getJson<{ items: Array<{ code: string; labelFr: string; labelEn: string; defaultSeverity: string }> }>(
    '/time/anomalies/catalog', adm);
  assert.equal(cat.items.length, 18);
  assert.ok(cat.items.every((i) => i.labelFr.length > 0 && i.labelEn.length > 0));
  // File du chef (unité RH) : e1/e4/e6 visibles, e2 (IT) INVISIBLE.
  const mine = await getJson<{ items: Array<{ employeeId: string; code: string; id: string }> }>(
    `/time/anomalies?from=${MON}&to=${SUN}`, chef);
  assert.ok(mine.items.length > 0);
  assert.ok(mine.items.every((i) => i.employeeId !== e2), 'l\'IT n\'apparaît JAMAIS dans la portée RH');
  assert.ok(mine.items.some((i) => i.employeeId === e1));
  // e6 n'a AUCUNE affectation E9 → hors de toute portée fine : réservé au tenant.
  assert.ok(mine.items.every((i) => i.employeeId !== e6));
  const all = await getJson<{ items: Array<{ employeeId: string; code: string; id: string; state: string }> }>(
    `/time/anomalies?from=${MON}&to=${SUN}`, adm);
  assert.ok(all.items.some((i) => i.employeeId === e6));
  // États : open → acknowledged → dismissed → open ; resolved REFUSÉ explicitement.
  const target = all.items.find((i) => i.employeeId === e6 && i.code === 'unmatched_event_pending')!;
  assert.ok(target);
  const ack = await api(`/time/anomalies/${target.id}/state`, adm, { state: 'acknowledged', note: 'vu, affectation à créer' });
  assert.equal(ack.status, 200);
  const dis = await api(`/time/anomalies/${target.id}/state`, adm, { state: 'dismissed', note: 'doublon' });
  assert.equal(dis.status, 200);
  const reopen = await api(`/time/anomalies/${target.id}/state`, adm, { state: 'open' });
  assert.equal(reopen.status, 200);
  const resolved = await api(`/time/anomalies/${target.id}/state`, adm, { state: 'resolved' });
  assert.equal(resolved.status, 409, '« resolved » est réservé au circuit de correction E10.3');
  const audits = psql(`SELECT count(*) FROM audit.audit_log
    WHERE tenant_id = '${tenantAId}' AND action = 'time_anomaly_state_changed'`);
  assert.equal(Number(audits), 3, 'chaque changement d\'état est AUDITÉ');
  // Sans permission : ni file, ni changement d'état.
  assert.equal((await api(`/time/anomalies?from=${MON}&to=${SUN}`, naked, undefined, 'GET')).status, 403);
  assert.equal((await api(`/time/anomalies/${target.id}/state`, naked, { state: 'acknowledged' })).status, 403);
  assert.equal((await api(`/time/anomalies/${target.id}/state`, chef, { state: 'acknowledged' })).status, 404,
    'anomalie d\'un salarié HORS portée : introuvable, pas interdite (aucune fuite d\'existence)');
});

test('16 portées des RÉSULTATS : registre d\'unité, détail hors portée introuvable, agrégats filtrés', async () => {
  const adm = await token(slugA, admEmail);
  const chef = await token(slugA, chefEmail);
  const naked = await token(slugA, nakedEmail);
  const reg = await getJson<{ items: Array<{ employeeId: string; matricule: string; dayStatus: string }> }>(
    `/time/results?date=${TUE}`, chef);
  const emps = new Set(reg.items.map((i) => i.employeeId));
  assert.ok(emps.has(e1) && emps.has(e4) && emps.has(e5), 'les salariés RH sont là');
  assert.ok(!emps.has(e2), 'l\'IT est INVISIBLE pour la portée RH');
  assert.ok(!emps.has(e6), 'sans affectation E9, hors des portées fines');
  const admReg = await getJson<{ items: Array<{ employeeId: string }> }>(`/time/results?date=${TUE}`, adm);
  assert.ok(new Set(admReg.items.map((i) => i.employeeId)).has(e2), 'la portée TENANT voit tout');
  assert.equal((await api(`/time/results/day?employeeId=${e2}&date=${TUE}`, chef, undefined, 'GET')).status, 404,
    'détail hors portée : introuvable');
  assert.equal((await api(`/time/results?date=${TUE}`, naked, undefined, 'GET')).status, 403);
  // Agrégats du chef : uniquement l'unité RH.
  const agg = await getJson<{ perEmployee: Array<{ employeeId: string }> }>(
    `/time/results/aggregates?from=${MON}&to=${SUN}`, chef);
  assert.ok(agg.perEmployee.every((r) => r.employeeId !== e2));
  // Consultation d'un TIERS par le chef : auditée (E6).
  const cal = await getJson<{ items: unknown[]; self: boolean }>(
    `/time/results/employee/${e1}?from=${MON}&to=${SUN}`, chef);
  assert.equal(cal.self, false);
  assert.equal(cal.items.length, 7);
  const audited = psql(`SELECT count(*) FROM audit.audit_log
    WHERE tenant_id = '${tenantAId}' AND action = 'time_results_consulted'`);
  assert.ok(Number(audited) >= 1);
});

test('17 self : « Mes présences » bornées à SOI ; déclencher un calcul exige la permission', async () => {
  const self = await token(slugA, selfEmail);
  const chef = await token(slugA, chefEmail);
  const mine = await getJson<{ linked: boolean; items: Array<{ workDate: string }> }>(
    `/time/results/mine?from=${MON}&to=${SUN}`, self);
  assert.equal(mine.linked, true);
  assert.equal(mine.items.length, 7);
  const own = await dayOf(self, e1, MON);
  assert.equal(own.self, true);
  assert.equal(own.result.dayStatus, 'present');
  assert.equal((await api(`/time/results/day?employeeId=${e2}&date=${MON}`, self, undefined, 'GET')).status, 403,
    'le self ne voit PAS les autres');
  assert.equal((await api('/time/calc/run', self, {
    periodStart: MON, periodEnd: MON, scopeKind: 'tenant', reason: 'tentative sans permission',
  })).status, 403);
  assert.equal((await api('/time/calc/recalc', chef, {
    periodStart: MON, periodEnd: MON, scopeKind: 'tenant', reason: 'tentative sans permission',
  })).status, 403, 'recalcul SANS time.calc_recalc : refusé');
});

test('18 isolation tenant : rien ne fuit, la FK inter-tenant est rejetée PAR POSTGRESQL', async () => {
  const bAdm = await token(slugB, bAdmEmail);
  const reg = await getJson<{ items: unknown[] }>(`/time/results?date=${TUE}`, bAdm);
  assert.equal(reg.items.length, 0);
  const runs = await getJson<{ items: unknown[] }>('/time/calc/runs', bAdm);
  assert.equal(runs.items.length, 0);
  assert.equal((await api(`/time/calc/runs/${run1Id}`, bAdm, undefined, 'GET')).status, 404);
  assert.equal((await api(`/time/results/day?employeeId=${e1}&date=${MON}`, bAdm, undefined, 'GET')).status, 404);
  // FK composite : un résultat du tenant B ne peut PAS viser un salarié du tenant A.
  assert.ok(psqlFails(`INSERT INTO time.day_results
      (tenant_id, employee_id, work_date, version, calc_run_id, engine_version, tz, day_status)
    SELECT '${tenantBId}', '${e1}', '${MON}', 99, cr.id, 'x', 'UTC', 'absent'
      FROM time.calc_runs cr LIMIT 1`), 'FK inter-tenant rejetée');
});

test('19 agrégats RETRAÇABLES : chaque somme = somme des résultats journaliers affichés', async () => {
  const adm = await token(slugA, admEmail);
  const agg = await getJson<{ perEmployee: Array<Record<string, unknown>>; totals: Record<string, number> }>(
    `/time/results/aggregates?from=${MON}&to=${SUN}&employeeId=${e1}`, adm);
  const row = agg.perEmployee.find((r) => r['employeeId'] === e1)!;
  assert.ok(row);
  // Recoupement PROGRAMMATIQUE avec le calendrier (mêmes lignes que l'écran).
  const cal = await getJson<{ items: DayResult[] }>(
    `/time/results/employee/${e1}?from=${MON}&to=${SUN}`, adm);
  const sum = (f: (d: DayResult) => number) => cal.items.reduce((s, d) => s + f(d), 0);
  assert.equal(row['workedMinutes'], sum((d) => d.workedMinutes));
  assert.equal(row['workedMinutes'], 1679, '487+472+0+420+180+0+120');
  assert.equal(row['nightMinutes'], sum((d) => d.nightMinutes));
  assert.equal(row['overtimeCandidateMinutes'], sum((d) => d.overtimeCandidateMinutes));
  assert.equal(row['overtimeCandidateMinutes'], 307, '7 (lundi) + 180 (férié) + 120 (repos)');
  assert.equal(row['lateCount'], 0, 'le retard de mardi est DANS la tolérance');
  assert.equal(row['earlyCount'], 1, 'jeudi v2 : départ anticipé 60');
  assert.equal(row['presentDays'], cal.items.filter((d) => d.workedMinutes > 0).length);
  assert.equal(row['expectedDays'], 4, 'lun–jeu (vendredi férié exclu du dû)');
  assert.equal(row['absentDays'], 0, 'jeudi est passé de absent à early_departure (v2)');
  assert.equal(row['openAnomalies'], cal.items.reduce((s, d) => s + d.openAnomalies, 0));
});

test('20 volume documenté : 26 salariés × 31 jours, durée mesurée et bornes tenues', async () => {
  const adm = await token(slugA, admEmail);
  // 20 salariés supplémentaires avec horaire de jour (sans affectation E9 : le but
  // est le VOLUME de calcul, pas les portées).
  psql(`INSERT INTO core.employees (tenant_id, matricule, first_name, last_name, status, hire_date)
    SELECT '${tenantAId}', 'PERF-${RID}-' || n, 'Perf' || n, 'Calc', 'active', '2025-01-06'
      FROM generate_series(1, 20) n`);
  psql(`INSERT INTO time.employee_schedules (tenant_id, employee_id, model_id, anchor_date, effective_from)
    SELECT '${tenantAId}', e.id, '${dayModel}', '2026-01-05', '2026-01-05'
      FROM core.employees e WHERE e.tenant_id = '${tenantAId}' AND e.matricule LIKE 'PERF-${RID}-%'`);
  const t0 = Date.now();
  const res = await api('/time/calc/run', adm, {
    periodStart: '2026-07-01', periodEnd: '2026-07-31', scopeKind: 'tenant', reason: 'volume : mois complet, tout le tenant',
  });
  const httpMs = Date.now() - t0;
  assert.equal(res.status, 201, await res.text().catch(() => ''));
  const { run } = (await res.json()) as RunOut;
  assert.ok(run.status === 'completed' || run.status === 'completed_with_errors');
  assert.equal(run.employeesCount, 27, '7 salariés du scénario + 20 de volume');
  assert.equal(run.daysCount, 31);
  assert.ok(run.durationMs < 60_000, `durée ${run.durationMs} ms — bornée et DOCUMENTÉE`);
  console.log(`  → volume : ${run.employeesCount * run.daysCount} évaluations en ${run.durationMs} ms (HTTP ${httpMs} ms)`);
  // Bornes explicites : période > 366 jours refusée ; prévisualisation trop large refusée.
  assert.equal((await api('/time/calc/run', adm, {
    periodStart: '2026-01-01', periodEnd: '2027-06-30', scopeKind: 'tenant', reason: 'trop long',
  })).status, 400);
  assert.equal((await api('/time/calc/preview', adm, {
    periodStart: '2026-01-01', periodEnd: '2026-12-31', scopeKind: 'tenant', reason: 'prévisualisation trop large',
  })).status, 400);
});

test('21 concurrence : deux exécutions actives chevauchantes — UNE seule gagne (409 PostgreSQL)', async () => {
  const adm = await token(slugA, admEmail);
  const fire = () => api('/time/calc/run', adm, {
    periodStart: '2026-06-01', periodEnd: '2026-06-30', scopeKind: 'tenant', reason: 'course concurrente',
  });
  const [r1, r2] = await Promise.all([fire(), fire()]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [201, 409], `attendu une victoire nette, obtenu ${statuses.join(',')}`);
  const winner = r1.status === 201 ? r1 : r2;
  const { run } = (await winner.json()) as RunOut;
  assert.ok(run.status.startsWith('completed'));
  const loser = r1.status === 409 ? r1 : r2;
  const msg = await loser.text();
  assert.ok(msg.includes('chevauche'), 'le refus EXPLIQUE le chevauchement');
  // Une seule version COURANTE par (salarié, jour) — garantie par l'index partiel.
  const dupCurrent = psql(`SELECT count(*) FROM (
      SELECT employee_id, work_date FROM time.day_results
       WHERE tenant_id = '${tenantAId}' AND is_current
       GROUP BY employee_id, work_date HAVING count(*) > 1) d`);
  assert.equal(Number(dupCurrent), 0, 'JAMAIS deux versions courantes');
});

test('22 exécutions : liste, détail, permissions et journal complet', async () => {
  const adm = await token(slugA, admEmail);
  const naked = await token(slugA, nakedEmail);
  const runs = await getJson<{ items: Array<{ id: string; status: string; reason: string; durationMs: number | null; engineVersion: string }> }>(
    '/time/calc/runs', adm);
  assert.ok(runs.items.length >= 6, 'toutes les exécutions du scénario sont tracées');
  assert.ok(runs.items.every((r) => r.reason.length > 0), 'JAMAIS d\'exécution sans motif');
  const detail = await getJson<{ run: { id: string; resultsWritten: number } }>(`/time/calc/runs/${run1Id}`, adm);
  assert.equal(detail.run.id, run1Id);
  assert.equal(detail.run.resultsWritten, 42);
  assert.equal((await api('/time/calc/runs', naked, undefined, 'GET')).status, 403);
  // E6 : préviualisation et recalculs audités eux aussi.
  const acts = psql(`SELECT count(DISTINCT action) FROM audit.audit_log
    WHERE tenant_id = '${tenantAId}' AND action IN
      ('time_calc_run_started','time_calc_run_finished','time_calc_recalc_started','time_calc_preview')`);
  assert.equal(Number(acts), 4, 'démarrages, fins, recalculs et prévisualisations audités');
});
