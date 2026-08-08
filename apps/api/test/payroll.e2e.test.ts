/**
 * E2E Paie E12.1 — moteur de calcul BRUT contre PostgreSQL réel.
 *
 * Ce que la suite prouve : salaire de base À DATE et changement futur SANS effet
 * rétroactif ; intégration EXACTE des clôtures E10 et E11 (les variables du
 * calcul sont, au chiffre près, celles des clôtures — jamais un recalcul) ;
 * déterminisme (même empreinte d'entrées ⇒ même brut) ; simulation SANS aucune
 * écriture de paie ; recalcul VERSIONNÉ (l'ancienne version demeure) ;
 * concurrence maîtrisée (un seul résultat courant) ; aucun taux légal en dur
 * (même les décimales d'arrondi viennent d'E4 — sans le paramètre, le calcul
 * s'arrête) ; aucune exécution arbitraire (formule hostile refusée) ; paie
 * validée intouchable ; comparaison de deux calculs ; isolation tenant, RBAC,
 * audit.
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
const num = (sql: string): number => Number(psql(sql) || '0');

const rid = randomUUID().slice(0, 8);
const RID = rid.toUpperCase();
const P = 'Ouidah-Atlantique-2026!';
const slugA = `py-a-${rid}`;
const slugB = `py-b-${rid}`;
const admEmail = `pyadm.${rid}@demo.bj`;     // paie + temps + congés (fixtures)
const rhEmail = `pyrh.${rid}@demo.bj`;       // rôle py-rh : décideur des circuits
const viewEmail = `pyview.${rid}@demo.bj`;   // consultation des résultats SEULE
const nakedEmail = `pynone.${rid}@demo.bj`;  // aucune permission paie
const bAdmEmail = `pybadm.${rid}@demo.bj`;

let app: INestApplication;
let base = '';
let tenantAId = '';
let tenantBId = '';
let coA = '', siteA = '', unitA = '';
let e1 = '', e2 = '';
let timeCloseId = '', leaveCloseId = '';
let calId = '', perSept = '', perVieux = '';
let strA = '';
let rubBase = '', rubAnc = '', rubNuit = '', rubTransp = '', rubSansSolde = '';
let compE1 = '';
let resultV1 = '', resultV2 = '';

async function seedUser(tenantId: string, email: string, perms: string[], roleKey?: string): Promise<string> {
  const h = await argon2.hash(P, { type: argon2.argon2id });
  const id = psql(`INSERT INTO admin.users (tenant_id, email, password_hash) VALUES ('${tenantId}','${email}','${h}') RETURNING id`);
  psql(`INSERT INTO admin.user_scopes (tenant_id, user_id, scope_type) VALUES ('${tenantId}','${id}','tenant')`);
  const role = psql(`INSERT INTO admin.roles (tenant_id, key, name) VALUES ('${tenantId}','${roleKey ?? `r-${email.split('@')[0]}`}','R') RETURNING id`);
  for (const p of perms) psql(`INSERT INTO admin.role_permissions (tenant_id, role_id, permission_key) VALUES ('${tenantId}','${role}','${p}')`);
  psql(`INSERT INTO admin.user_roles (tenant_id, user_id, role_id) VALUES ('${tenantId}','${id}','${role}')`);
  return id;
}

before(async () => {
  tenantAId = psql(`INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('${slugA}','PY A',true) RETURNING id`);
  tenantBId = psql(`INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('${slugB}','PY B',true) RETURNING id`);
  await seedUser(tenantAId, admEmail, [
    'org.view', 'org.manage', 'employees.view', 'employees.manage', 'employees.assign',
    'time.schedules_manage', 'time.schedules_assign', 'time.punches_import',
    'time.calc_run', 'time.calc_recalc', 'time.calc_view', 'time.results_view',
    'time.period_manage', 'time.period_close', 'time.preclose_view', 'time.payroll_view',
    'leave.types_admin', 'leave.policies_admin', 'leave.accrual_run', 'leave.requests_admin',
    'leave.request_for_others', 'leave.period_manage', 'leave.close_run', 'leave.close_view',
    'workflow.manage', 'workflow.view', 'audit.view', 'parameters.view',
    'payroll.calendar_manage', 'payroll.structures_manage', 'payroll.rubrics_manage',
    'payroll.compensation_view', 'payroll.compensation_manage', 'payroll.simulate',
    'payroll.run', 'payroll.results_view', 'payroll.levies_manage',
  ]);
  await seedUser(tenantAId, rhEmail, ['leave.requests_admin', 'workflow.view', 'workflow.act'], 'py-rh');
  await seedUser(tenantAId, viewEmail, ['payroll.results_view']);
  await seedUser(tenantAId, nakedEmail, ['employees.view']);
  await seedUser(tenantBId, bAdmEmail, [
    'payroll.calendar_manage', 'payroll.results_view', 'payroll.run', 'payroll.compensation_view',
  ]);

  for (const [key, value, from] of [
    // Paramètres de PAIE : c'est E4 qui les porte, jamais le moteur.
    ['paie.arrondi.decimales', '0', '2020-01-01'],
    ['paie.prime.anciennete', '0.05', '2020-01-01'],
    ['paie.majoration.nuit', '1250', '2020-01-01'],
    ['paie.plafond.transport', '25000', '2020-01-01'],
    ['paie.duree.jours_mensuels', '30', '2020-01-01'],
    // Paramètres des modules amont (identiques aux tranches précédentes).
    ['conges.acquisition.taux_mensuel', '2', '2020-01-01'],
    ['conges.ouvrables.jours', '[1,2,3,4,5,6]', '2020-01-01'],
    ['temps.fuseau.defaut', '"Africa/Porto-Novo"', '2020-01-01'],
  ] as const) {
    psql(`INSERT INTO compliance.legal_parameters
            (tenant_id, country_code, key, value, effective_from, status, is_legal_sensitive,
             confidence, source_text, verified_by, verified_at)
          VALUES ('${tenantAId}', 'BJ', '${key}', '${value}', '${from}', 'active', true,
                  'verified', 'fixture e2e E12.1', 'fixture-e2e', '2026-01-01')`);
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

interface SimulationOut {
  simulation: {
    gross: number; taxableBase: number; contributableBase: number; roundingDp: number;
    inputsSha256: string; persisted: boolean; timeCloseId: string | null; leaveCloseId: string | null;
    lines: Array<{ code: string; amount: number; trace: Array<{ op: string; detail: string; value: number }>;
      inputsUsed: Record<string, number>; paramsUsed: Record<string, { value: number; parameterId: string }> }>;
    skipped: Array<{ code: string; reason: string }>;
    errors: Array<{ code: string; reason: string }>;
    variables: Record<string, number>;
  };
}

// ---------------------------------------------------------------------------

test('01 fixtures : organisation, présence CLÔTURÉE (E10), congés CLÔTURÉS (E11), référentiel de paie', async () => {
  const adm = await token(slugA, admEmail);
  const rh = await token(slugA, rhEmail);

  coA = await created('/org/companies', adm, { code: `PYCO-${RID}`, labelFr: 'Société PY', labelEn: 'PY Co' });
  psql(`UPDATE org.companies SET status = 'active' WHERE id = '${coA}'`);
  siteA = await created('/org/sites', adm, { code: `PYSITE-${RID}`, labelFr: 'Site PY', labelEn: 'PY Site', companyId: coA });
  psql(`UPDATE org.sites SET status = 'active', time_zone = 'Africa/Porto-Novo' WHERE id = '${siteA}'`);
  unitA = await created('/org/units', adm, { unitType: 'department', code: `PYU-${RID}`, labelFr: 'Prod', labelEn: 'Prod', companyId: coA });
  psql(`UPDATE org.units SET status = 'active' WHERE id = '${unitA}'`);

  const mk = async (mat: string, first: string, hire: string): Promise<string> => {
    const res = await api('/employees', adm, { matricule: mat, firstName: first, lastName: 'Paie', hireDate: hire });
    const text = await res.text();
    assert.equal(res.status, 201, text);
    const id = (JSON.parse(text) as { id: string }).id;
    psql(`UPDATE core.employees SET status = 'active' WHERE id = '${id}'`);
    assert.equal((await api(`/employees/${id}/assignments`, adm, {
      companyId: coA, siteId: siteA, unitId: unitA, effectiveFrom: hire, isPrimary: true,
    })).status, 201);
    return id;
  };
  e1 = await mk(`PY1-${RID}`, 'Awa', '2023-01-01');   // ancienneté > 24 mois au 30/09/2026
  e2 = await mk(`PY2-${RID}`, 'Bio', '2026-06-01');   // ancienneté < 24 mois

  // Horaire de nuit pour e1 (la majoration de nuit vient de la CLÔTURE E10).
  const nightModel = await created('/time/schedules/models', adm, { code: `PYN-${RID}`, labelFr: 'Nuit', labelEn: 'Night', kind: 'rotation' });
  await postJson(`/time/schedules/models/${nightModel}/versions`, adm, {
    effectiveFrom: '2025-01-06', cycleDays: 4,
    days: [
      { dayIndex: 0, isRest: false, startMinute: 1320, endMinute: 1800 },
      { dayIndex: 1, isRest: false, startMinute: 1320, endMinute: 1800 },
      { dayIndex: 2, isRest: true }, { dayIndex: 3, isRest: true },
    ],
  }, 201);
  await postJson('/time/schedules/assignments', adm, { employeeId: e1, modelId: nightModel, anchorDate: '2026-08-31', effectiveFrom: '2025-01-06' }, 201);
  const dayModel = await created('/time/schedules/models', adm, { code: `PYJ-${RID}`, labelFr: 'Jour', labelEn: 'Day', kind: 'fixed' });
  await postJson(`/time/schedules/models/${dayModel}/versions`, adm, {
    effectiveFrom: '2025-01-06', cycleDays: 7,
    days: [0, 1, 2, 3, 4].map((i) => ({ dayIndex: i, isRest: false, startMinute: 480, endMinute: 1020, breakStartMinute: 720, breakEndMinute: 780 }))
      .concat([{ dayIndex: 5, isRest: true }, { dayIndex: 6, isRest: true }] as never[]),
  }, 201);
  await postJson('/time/schedules/assignments', adm, { employeeId: e2, modelId: dayModel, anchorDate: '2026-01-05', effectiveFrom: '2025-01-06' }, 201);

  // Pointages RÉELS de e1 sur deux nuits : la présence de nuit est CONSTATÉE.
  for (const [dt, ev] of [
    ['2026-09-01 22:00', 'E'], ['2026-09-02 06:00', 'S'],
    ['2026-09-05 22:00', 'E'], ['2026-09-06 06:00', 'S'],
  ] as const) {
    assert.equal((await api('/time/punches/manual', adm, {
      employeeId: e1, dateTime: dt, eventType: ev, siteId: siteA, note: 'fixture E12.1',
    })).status, 201, `pointage ${dt}`);
  }

  // Congé SANS SOLDE de e2 : la retenue viendra de la CLÔTURE E11.
  const typeSs = await created('/leave/types', adm, {
    code: 'SSOLDE', labelFr: 'Congé sans solde', labelEn: 'Unpaid leave', category: 'internal',
    paid: false, unit: 'open_days', negativeAllowed: true, prepCategory: 'sans_solde',
  });
  await postJson(`/leave/types/${typeSs}`, adm, { status: 'active' });
  const pol = await created('/leave/policies', adm, {
    absenceTypeId: typeSs, code: 'POL-SS', labelFr: 'Politique SS', labelEn: 'SS policy',
  });
  await postJson(`/leave/policies/${pol}/versions`, adm, { effectiveFrom: '2025-01-01', accrualMode: 'none' }, 201);
  await postJson(`/leave/policies/${pol}/status`, adm, { status: 'active' });
  for (const key of ['conges_demande', 'paie_periode_reouverture']) {
    const def = await api('/workflow/definitions', adm, {
      key, name: `Circuit ${key}`, steps: [{ index: 0, name: 'RH', approverType: 'role', approverRef: 'py-rh' }],
    });
    const defText = await def.text();
    assert.equal(def.status, 201, defText);
    assert.equal((await api(`/workflow/definitions/${(JSON.parse(defText) as { id: string }).id}/activate`, adm)).status, 200);
  }
  const req = await postJson<{ id: string }>('/leave/requests', adm, {
    employeeId: e2, typeId: typeSs, startDate: '2026-09-14', endDate: '2026-09-15',
    onBehalfReason: 'absence sans solde constatée',
  }, 201);
  await postJson(`/leave/requests/${req.id}/submit`, adm, undefined);
  await postJson(`/leave/requests/${req.id}/decide`, rh, { action: 'approve' });
  assert.equal(psql(`SELECT presence_impact FROM leave.absences WHERE request_id = '${req.id}'`), 'applied');

  // Calcul E10 de tout septembre PUIS clôture (l'absence est déjà intégrée).
  const calc = await postJson<{ run: { status: string } }>('/time/calc/run', adm, {
    periodStart: '2026-09-01', periodEnd: '2026-09-30', scopeKind: 'tenant', reason: 'base paie (fixture E12.1)',
  }, 201);
  assert.match(calc.run.status, /^completed/);
  const timePeriod = await created('/time/periods', adm, {
    scopeKind: 'tenant', label: `PY-SEPT-${RID}`, periodStart: '2026-09-01', periodEnd: '2026-09-30',
  });
  // Cycle E10 : open → in_review → locked (le raccourci open → locked est
  // refusé PAR LA BASE — run CI 31267337209).
  await postJson(`/time/periods/${timePeriod}/status`, adm, { status: 'in_review' });
  await postJson(`/time/periods/${timePeriod}/status`, adm, { status: 'locked' });
  const tclose = await postJson<{ close: { id: string } }>(`/time/periods/${timePeriod}/close`, adm, { confirmWarnings: true }, 201);
  timeCloseId = tclose.close.id;

  // Clôture CONGÉS de septembre.
  const leavePeriod = await postJson<{ id: string }>('/leave/periods', adm, {
    label: `PYC-SEPT-${RID}`, periodStart: '2026-09-01', periodEnd: '2026-09-30',
  }, 201);
  const lclose = await postJson<{ closeId: string }>(`/leave/periods/${leavePeriod.id}/close`, adm, { confirmWarnings: true });
  leaveCloseId = lclose.closeId;

  // ---- Référentiel de PAIE ----
  calId = await created('/payroll/calendars', adm, { code: 'MENS', labelFr: 'Mensuel', labelEn: 'Monthly', frequency: 'monthly' });
  perSept = await created('/payroll/periods', adm, {
    calendarId: calId, label: `Paie septembre ${RID}`, periodStart: '2026-09-01', periodEnd: '2026-09-30', payDate: '2026-09-30',
  });
  strA = await created('/payroll/structures', adm, { code: 'CADRE', labelFr: 'Cadre', labelEn: 'Staff' });
  await postJson(`/payroll/structures/${strA}/status`, adm, { status: 'active' });

  const mkRubric = async (
    code: string, kind: string, taxable: boolean, cotisable: boolean, sequence: number, version: Record<string, unknown>,
  ): Promise<string> => {
    const id = await created('/payroll/rubrics', adm, {
      code, labelFr: code, labelEn: code, kind, taxable, cotisable, sequence,
    });
    await postJson(`/payroll/rubrics/${id}/versions`, adm, { effectiveFrom: '2025-01-01', ...version }, 201);
    await postJson(`/payroll/rubrics/${id}/status`, adm, { status: 'active' });
    await postJson(`/payroll/structures/${strA}/rubrics`, adm, { rubricId: id, sequence });
    return id;
  };
  rubBase = await mkRubric('BASE', 'gain', true, true, 10, {
    valuation: 'rate', rateBase: 'base.montant', rateValue: 1,
  });
  rubAnc = await mkRubric('ANC', 'prime', true, true, 20, {
    valuation: 'formula',
    formula: {
      k: 'if',
      cond: { k: 'gte', a: { k: 'var', name: 'emp.anciennete_mois' }, b: { k: 'num', v: 24 } },
      then: { k: 'mul', a: { k: 'var', name: 'base.montant' }, b: { k: 'param', key: 'paie.prime.anciennete' } },
      else: { k: 'num', v: 0 },
    },
  });
  rubNuit = await mkRubric('NUIT', 'prime', true, true, 30, {
    valuation: 'formula',
    formula: { k: 'mul', a: { k: 'var', name: 'temps.heures_nuit' }, b: { k: 'param', key: 'paie.majoration.nuit' } },
  });
  rubTransp = await mkRubric('TRANSP', 'indemnite', false, false, 40, {
    valuation: 'fixed', fixedValue: 40000, capParamKey: 'paie.plafond.transport',
  });
  rubSansSolde = await mkRubric('SSOLDE', 'retenue', false, false, 50, {
    valuation: 'formula',
    formula: {
      k: 'mul',
      a: { k: 'var', name: 'conges.jours_sans_solde' },
      b: { k: 'div', a: { k: 'var', name: 'base.montant' }, b: { k: 'param', key: 'paie.duree.jours_mensuels' } },
    },
  });

  compE1 = await created('/payroll/compensations', adm, {
    employeeId: e1, structureId: strA, effectiveFrom: '2025-01-01',
    baseAmount: 300000, currency: 'XOF', periodicity: 'monthly', reason: 'embauche',
  });
  await created('/payroll/compensations', adm, {
    employeeId: e2, structureId: strA, effectiveFrom: '2026-06-01',
    baseAmount: 180000, currency: 'XOF', periodicity: 'monthly', reason: 'embauche',
  });
  assert.ok(timeCloseId.length > 0 && leaveCloseId.length > 0, 'les deux clôtures existent');
  void rubBase; void rubAnc; void rubNuit; void rubTransp; void rubSansSolde;
});

test('02 salaire de base À DATE : la version applicable est la dernière DATÉE, jamais la dernière saisie', async () => {
  const adm = await token(slugA, admEmail);
  const sim = await postJson<SimulationOut>('/payroll/simulate', adm, { periodId: perSept, employeeId: e1 });
  const baseLine = sim.simulation.lines.find((l) => l.code === 'BASE')!;
  assert.equal(baseLine.amount, 300000, 'la rémunération au 30/09/2026 est celle de 2025-01-01');
  assert.equal(sim.simulation.variables['base.montant'], 300000);
});

test('03 intégration EXACTE des clôtures E10 et E11 : les variables SONT les chiffres des clôtures', async () => {
  const adm = await token(slugA, admEmail);
  const sim = await postJson<SimulationOut>('/payroll/simulate', adm, { periodId: perSept, employeeId: e1 });
  const v = sim.simulation.variables;
  assert.equal(sim.simulation.timeCloseId, timeCloseId, 'la clôture E10 consommée est la clôture ACTIVE');
  assert.equal(sim.simulation.leaveCloseId, leaveCloseId, 'la clôture E11 consommée est la clôture ACTIVE');
  // Les totaux figés de la clôture E10, au chiffre près — aucun recalcul de présence.
  const closeNight = num(`SELECT night_minutes FROM time.period_close_totals
    WHERE close_id = '${timeCloseId}' AND employee_id = '${e1}'`);
  const closeExpected = num(`SELECT expected_days FROM time.period_close_totals
    WHERE close_id = '${timeCloseId}' AND employee_id = '${e1}'`);
  assert.equal(v['temps.heures_nuit'], Math.round((closeNight / 60) * 1000) / 1000, 'heures de nuit = minutes figées ÷ 60');
  assert.equal(v['temps.jours_attendus'], closeExpected);
  assert.ok(closeNight > 0, 'la clôture porte bien des minutes de nuit');
  // Congés : e1 n'a aucune absence, e2 en a deux journées sans solde.
  assert.equal(v['conges.jours_sans_solde'], 0);
  const sim2 = await postJson<SimulationOut>('/payroll/simulate', adm, { periodId: perSept, employeeId: e2 });
  const factDays = num(`SELECT COALESCE(sum(counted), 0) FROM time.absence_facts
    WHERE employee_id = '${e2}' AND status = 'active' AND prep_category = 'sans_solde'
      AND work_date BETWEEN '2026-09-01' AND '2026-09-30'`);
  assert.equal(sim2.simulation.variables['conges.jours_sans_solde'], factDays);
  assert.ok(factDays > 0, 'la clôture congés porte bien des journées sans solde');
});

test('04 calcul BRUT expliqué : chaque montant se relie à sa rubrique, sa formule, ses entrées, ses paramètres', async () => {
  const adm = await token(slugA, admEmail);
  const sim = await postJson<SimulationOut>('/payroll/simulate', adm, { periodId: perSept, employeeId: e1 });
  const s = sim.simulation;
  assert.equal(s.errors.length, 0, JSON.stringify(s.errors));
  const byCode = Object.fromEntries(s.lines.map((l) => [l.code, l]));

  // BASE : taux 1 sur la rémunération.
  assert.equal(byCode['BASE']!.amount, 300000);
  // ANC : 45 mois ≥ 24 ⇒ 5 % (PARAMÈTRE E4) de 300 000.
  assert.equal(byCode['ANC']!.amount, 15000);
  assert.equal(byCode['ANC']!.paramsUsed['paie.prime.anciennete']!.value, 0.05);
  // NUIT : heures de la CLÔTURE × majoration E4.
  const heuresNuit = s.variables['temps.heures_nuit']!;
  assert.equal(byCode['NUIT']!.amount, Math.round(heuresNuit * 1250));
  assert.equal(byCode['NUIT']!.inputsUsed['temps.heures_nuit'], heuresNuit);
  // TRANSP : 40 000 PLAFONNÉ par le paramètre E4 à 25 000.
  assert.equal(byCode['TRANSP']!.amount, 25000);
  assert.ok(byCode['TRANSP']!.trace.some((t) => t.op === 'plafond'));
  // Brut = gains + primes + indemnités − retenues ; assiettes séparées.
  const attendu = 300000 + 15000 + Math.round(heuresNuit * 1250) + 25000;
  assert.equal(s.gross, attendu);
  assert.equal(s.taxableBase, 300000 + 15000 + Math.round(heuresNuit * 1250), 'le transport n’est ni imposable ni cotisable');
  assert.equal(s.contributableBase, s.taxableBase);
  // La TRACE est ordonnée et lisible ligne par ligne.
  assert.deepEqual(byCode['NUIT']!.trace.map((t) => t.op), ['variable', 'paramètre', 'multiplication']);
});

test('05 condition d’ancienneté : la branche prise est EXPLIQUÉE, pas devinée', async () => {
  const adm = await token(slugA, admEmail);
  const sim = await postJson<SimulationOut>('/payroll/simulate', adm, { periodId: perSept, employeeId: e2 });
  // e2 est embauché en juin 2026 : moins de 24 mois au 30/09/2026 ⇒ branche « sinon ».
  assert.ok(sim.simulation.variables['emp.anciennete_mois']! < 24);
  const anc = sim.simulation.lines.find((l) => l.code === 'ANC')!;
  assert.equal(anc.amount, 0, 'la prime d’ancienneté ne s’ouvre pas');
  const cond = anc.trace.find((t) => t.op === 'condition')!;
  assert.equal(cond.detail, 'fausse', 'la trace dit QUELLE branche a été prise');
  // La retenue sans solde, elle, provient de la clôture E11 : deux journées.
  const ss = sim.simulation.lines.find((l) => l.code === 'SSOLDE')!;
  const jours = sim.simulation.variables['conges.jours_sans_solde']!;
  assert.equal(ss.amount, Math.round(jours * (180000 / 30)));
  assert.ok(ss.amount > 0, 'la retenue est effective');
  // Une retenue DIMINUE le brut.
  assert.equal(sim.simulation.gross, 180000 + 25000 - ss.amount);
});

test('06 SIMULATION : aucune écriture de paie, jamais', async () => {
  const adm = await token(slugA, admEmail);
  const before = {
    runs: num(`SELECT count(*) FROM payroll.runs WHERE tenant_id = '${tenantAId}'`),
    results: num(`SELECT count(*) FROM payroll.results WHERE tenant_id = '${tenantAId}'`),
    lines: num(`SELECT count(*) FROM payroll.result_lines WHERE tenant_id = '${tenantAId}'`),
  };
  const sim = await postJson<SimulationOut>('/payroll/simulate', adm, { periodId: perSept, employeeId: e1 });
  assert.equal(sim.simulation.persisted, false);
  assert.equal(num(`SELECT count(*) FROM payroll.runs WHERE tenant_id = '${tenantAId}'`), before.runs);
  assert.equal(num(`SELECT count(*) FROM payroll.results WHERE tenant_id = '${tenantAId}'`), before.results);
  assert.equal(num(`SELECT count(*) FROM payroll.result_lines WHERE tenant_id = '${tenantAId}'`), before.lines);
  // La consultation, elle, est AUDITÉE (une simulation lit des salaires).
  assert.ok(num(`SELECT count(*) FROM audit.audit_log WHERE tenant_id = '${tenantAId}' AND action = 'payroll_simulated'`) >= 1);
});

test('07 exécution : résultats versionnés, empreinte d’entrées, brut identique à la simulation', async () => {
  const adm = await token(slugA, admEmail);
  const sim = await postJson<SimulationOut>('/payroll/simulate', adm, { periodId: perSept, employeeId: e1 });
  const run = await postJson<{ runId: string; status: string; resultsCount: number; fingerprint: string }>(
    '/payroll/runs', adm, { periodId: perSept, reason: 'paie de septembre' }, 201);
  assert.equal(run.status, 'completed', JSON.stringify(run));
  assert.equal(run.resultsCount, 2, 'les deux salariés rémunérés sont calculés');
  assert.match(run.fingerprint, /^[0-9a-f]{64}$/);

  const results = await getJson<{ items: Array<{ id: string; employeeId: string; version: number; isCurrent: boolean; grossAmount: string; inputsSha256: string }> }>(
    `/payroll/periods/${perSept}/results`, adm);
  const mine = results.items.find((r) => r.employeeId === e1)!;
  resultV1 = mine.id;
  assert.equal(mine.version, 1);
  assert.equal(mine.isCurrent, true);
  // Le brut PERSISTÉ est celui qu'annonçait la simulation, à l'unité près.
  assert.equal(Number(mine.grossAmount), sim.simulation.gross);
  assert.equal(mine.inputsSha256, sim.simulation.inputsSha256, 'même empreinte d’entrées : simulation et exécution');
});

test('08 déterminisme : rejouer le calcul redonne la MÊME empreinte et le MÊME brut', async () => {
  const adm = await token(slugA, admEmail);
  const before = psql(`SELECT gross_amount::text || '|' || inputs_sha256 FROM payroll.results
    WHERE id = '${resultV1}'`);
  const run = await postJson<{ status: string; resultsCount: number }>(
    '/payroll/runs', adm, { periodId: perSept, employeeId: e1, reason: 'rejeu à l’identique' }, 201);
  assert.equal(run.status, 'completed');
  const v2 = psql(`SELECT gross_amount::text || '|' || inputs_sha256 FROM payroll.results
    WHERE period_id = '${perSept}' AND employee_id = '${e1}' AND version = 2`);
  assert.equal(v2, before, 'mêmes entrées, mêmes versions ⇒ même brut et même empreinte');
  // Un recalcul crée une VERSION : l'ancienne DEMEURE, une seule est courante.
  assert.equal(num(`SELECT count(*) FROM payroll.results WHERE period_id = '${perSept}' AND employee_id = '${e1}'`), 2);
  assert.equal(num(`SELECT count(*) FROM payroll.results
    WHERE period_id = '${perSept}' AND employee_id = '${e1}' AND is_current`), 1);
  resultV2 = psql(`SELECT id FROM payroll.results WHERE period_id = '${perSept}' AND employee_id = '${e1}' AND version = 2`);
});

test('09 changement salarial FUTUR : aucun effet rétroactif sur la paie déjà calculée', async () => {
  const adm = await token(slugA, admEmail);
  const grossAvant = num(`SELECT gross_amount FROM payroll.results WHERE id = '${resultV2}'`);
  await created('/payroll/compensations', adm, {
    employeeId: e1, structureId: strA, effectiveFrom: '2026-11-01',
    baseAmount: 400000, currency: 'XOF', periodicity: 'monthly', reason: 'augmentation au 1er novembre',
  });
  // La paie de SEPTEMBRE ne bouge pas d'un franc : la version reste figée.
  assert.equal(num(`SELECT gross_amount FROM payroll.results WHERE id = '${resultV2}'`), grossAvant);
  // Et un RECALCUL de septembre choisit toujours la version applicable à septembre.
  const sim = await postJson<SimulationOut>('/payroll/simulate', adm, { periodId: perSept, employeeId: e1 });
  assert.equal(sim.simulation.variables['base.montant'], 300000, 'septembre ignore l’augmentation de novembre');
  assert.equal(sim.simulation.gross, grossAvant);
  // L'HISTORIQUE est consultable — et cette consultation de salaires est AUDITÉE.
  const hist = await getJson<{ items: Array<{ effectiveFrom: string; baseAmount: string }> }>(
    `/payroll/compensations?employeeId=${e1}`, adm);
  assert.deepEqual(hist.items.map((c) => c.effectiveFrom), ['2026-11-01', '2025-01-01'],
    'les deux versions coexistent, la plus récente en tête — rien n’a été réécrit');
  assert.equal(num(`SELECT count(*) FROM audit.audit_log WHERE tenant_id = '${tenantAId}'
    AND action = 'payroll_compensation_accessed'`), 1, 'consulter des salaires laisse une trace');
});

test('10 changement de PARAMÈTRE E4 : la nouvelle valeur ne s’applique qu’aux périodes qu’elle DATE', async () => {
  const adm = await token(slugA, admEmail);
  // Le taux de prime d'ancienneté passe à 8 % au 1er décembre 2026. E4 refuse
  // deux versions chevauchantes d'une même clé (exclusion « parameter_no_overlap ») :
  // la version en vigueur se FERME à la date d'effet de la suivante — exactement
  // ce que fait l'activation d'un paramètre (config.service) ; son contenu n'est
  // jamais réécrit (run CI 31268510665).
  psql(`UPDATE compliance.legal_parameters SET effective_to = '2026-12-01'
         WHERE tenant_id = '${tenantAId}' AND key = 'paie.prime.anciennete' AND effective_to IS NULL`);
  psql(`INSERT INTO compliance.legal_parameters
          (tenant_id, country_code, key, value, effective_from, status, is_legal_sensitive,
           confidence, source_text, verified_by, verified_at)
        VALUES ('${tenantAId}', 'BJ', 'paie.prime.anciennete', '0.08', '2026-12-01', 'active', true,
                'verified', 'revalorisation', 'fixture-e2e', '2026-11-01')`);
  const sim = await postJson<SimulationOut>('/payroll/simulate', adm, { periodId: perSept, employeeId: e1 });
  const anc = sim.simulation.lines.find((l) => l.code === 'ANC')!;
  assert.equal(anc.amount, 15000, 'septembre garde 5 % — le taux de décembre ne rétroagit pas');
  assert.equal(anc.paramsUsed['paie.prime.anciennete']!.value, 0.05);
});

test('11 AUCUN taux légal en dur : sans le paramètre E4, le calcul S’ARRÊTE (jusqu’aux décimales d’arrondi)', async () => {
  const adm = await token(slugA, admEmail);
  // Période de paie ANTÉRIEURE à l'existence des paramètres de paie.
  perVieux = await created('/payroll/periods', adm, {
    calendarId: calId, label: `Paie ancienne ${RID}`, periodStart: '2019-01-01', periodEnd: '2019-01-31', payDate: '2019-01-31',
  });
  const res = await api('/payroll/simulate', adm, { periodId: perVieux, employeeId: e1 });
  const text = await res.text();
  assert.equal(res.status, 400, text);
  assert.match(text, /paie\.arrondi\.decimales/, 'même l’arrondi vient d’E4 : aucun défaut n’est inventé');
  assert.match(text, /non r.solu/, 'le refus nomme la clé non résolue');
  // L'exécution refuse pour la même raison — et n'écrit aucun résultat.
  const runRes = await api('/payroll/runs', adm, { periodId: perVieux, reason: 'tentative' });
  assert.equal(runRes.status, 400, await runRes.text());
  assert.equal(num(`SELECT count(*) FROM payroll.results WHERE period_id = '${perVieux}'`), 0);
});

test('12 AUCUNE exécution arbitraire : une formule hors grammaire est refusée par l’API ET par la base', async () => {
  const adm = await token(slugA, admEmail);
  const rub = await created('/payroll/rubrics', adm, {
    code: 'HOSTILE', labelFr: 'Hostile', labelEn: 'Hostile', kind: 'prime', taxable: true, cotisable: true, sequence: 99,
  });
  for (const formula of [
    { k: 'call', fn: 'process.exit' },
    { k: 'eval', src: '1+1' },
    { k: 'mul', a: { k: 'var', name: 'base.montant' }, b: { k: 'call', fn: 'x' } },
  ]) {
    const res = await api(`/payroll/rubrics/${rub}/versions`, adm, { effectiveFrom: '2025-01-01', valuation: 'formula', formula });
    assert.equal(res.status, 400, `formule hostile acceptée : ${JSON.stringify(formula)}`);
  }
  // Une variable HORS CATALOGUE est refusée elle aussi (rien n'entre par surprise).
  const outOfCatalog = await api(`/payroll/rubrics/${rub}/versions`, adm, {
    effectiveFrom: '2025-01-01', valuation: 'formula',
    formula: { k: 'var', name: 'cnss.taux_salarial' },
  });
  assert.equal(outOfCatalog.status, 400);
  assert.match(await outOfCatalog.text(), /hors catalogue/);
  // La BASE refuse la même chose, indépendamment de l'API.
  assert.equal(psql(`SELECT payroll.node_is_safe('{"k":"call","fn":"rm"}'::jsonb, false, 0)::text`), 'false');
  assert.equal(num(`SELECT count(*) FROM payroll.rubric_versions WHERE rubric_id = '${rub}'`), 0);
});

test('13 concurrence : deux calculs simultanés ne produisent JAMAIS deux paies vivantes', async () => {
  const adm = await token(slugA, admEmail);
  const race = await Promise.all([
    api('/payroll/runs', adm, { periodId: perSept, employeeId: e2, reason: 'concurrent A' }),
    api('/payroll/runs', adm, { periodId: perSept, employeeId: e2, reason: 'concurrent B' }),
  ]);
  const codes = race.map((r) => r.status).sort();
  assert.deepEqual(codes, [201, 201], `les deux exécutions aboutissent, sérialisées : ${codes.join(',')}`);
  assert.equal(num(`SELECT count(*) FROM payroll.results
    WHERE period_id = '${perSept}' AND employee_id = '${e2}' AND is_current`), 1,
  'UN SEUL résultat courant — le verrou et l’index partiel le garantissent');
  const versions = num(`SELECT count(*) FROM payroll.results WHERE period_id = '${perSept}' AND employee_id = '${e2}'`);
  assert.ok(versions >= 2, 'chaque exécution a produit sa VERSION, aucune n’a écrasé l’autre');
});

test('14 comparaison de deux calculs : écart LISIBLE ligne par ligne', async () => {
  const adm = await token(slugA, admEmail);
  const cmp = await getJson<{ comparison: { grossDelta: number; sameInputs: boolean; differences: unknown[]; from: { version: number }; to: { version: number } } }>(
    `/payroll/results/${resultV1}/compare?with=${resultV2}`, adm);
  assert.equal(cmp.comparison.from.version, 1);
  assert.equal(cmp.comparison.to.version, 2);
  assert.equal(cmp.comparison.grossDelta, 0, 'rejeu à l’identique : aucun écart');
  assert.equal(cmp.comparison.sameInputs, true);
  assert.deepEqual(cmp.comparison.differences, []);
  // Comparer deux salariés DIFFÉRENTS n'a pas de sens : refus explicite.
  const other = psql(`SELECT id FROM payroll.results WHERE period_id = '${perSept}' AND employee_id = '${e2}' AND is_current`);
  const res = await api(`/payroll/results/${resultV1}/compare?with=${other}`, adm, undefined, 'GET');
  assert.equal(res.status, 400, await res.text());
});

test('15 détail EXPLIQUÉ persisté : la trace de chaque ligne est conservée avec ses paramètres', async () => {
  const adm = await token(slugA, admEmail);
  const det = await getJson<{ result: { grossAmount: string; engineVersion: string; timeCloseId: string; leaveCloseId: string;
    paramsUsed: Record<string, { value: number; parameterId: string; effectiveFrom: string }>;
    lines: Array<{ code: string; amount: string; trace: Array<{ op: string }>; paramsUsed: Record<string, unknown> }> } }>(
    `/payroll/results/${resultV2}`, adm);
  assert.equal(det.result.engineVersion, 'kora-payroll-gross-1.0.0');
  assert.equal(det.result.timeCloseId, timeCloseId);
  assert.equal(det.result.leaveCloseId, leaveCloseId);
  const nuit = det.result.lines.find((l) => l.code === 'NUIT')!;
  assert.ok(nuit.trace.length >= 3, 'la trace persistée explique la ligne');
  assert.ok(Object.keys(nuit.paramsUsed).includes('paie.majoration.nuit'));
  assert.equal(det.result.paramsUsed['paie.majoration.nuit']!.effectiveFrom, '2020-01-01',
    'la DATE D’EFFET du paramètre est conservée avec le résultat');
});

test('16 cycle de période : validation contrôlée, paie validée INTOUCHABLE, réouverture par circuit', async () => {
  const adm = await token(slugA, admEmail);
  const rh = await token(slugA, rhEmail);
  await postJson(`/payroll/periods/${perSept}/status`, adm, { status: 'locked' });
  await postJson(`/payroll/periods/${perSept}/status`, adm, { status: 'validated' });
  assert.equal(psql(`SELECT status FROM payroll.pay_periods WHERE id = '${perSept}'`), 'validated');
  // Plus aucun calcul tant que la paie n'est pas rouverte.
  const refus = await api('/payroll/runs', adm, { periodId: perSept, reason: 'après validation' });
  assert.equal(refus.status, 409, await refus.text());
  // Réouverture par CIRCUIT E3 dédié, motivée.
  const out = await postJson<{ instanceId: string }>(`/payroll/periods/${perSept}/reopen`, adm, { reason: 'régularisation de la prime de nuit' });
  await postJson(`/workflow/instances/${out.instanceId}/approve`, rh, {});
  assert.equal(psql(`SELECT status || '|' || revision FROM payroll.pay_periods WHERE id = '${perSept}'`), 'reopened|2');
  // Le recalcul redevient possible et crée de NOUVELLES versions.
  const run = await postJson<{ status: string }>('/payroll/runs', adm, { periodId: perSept, employeeId: e1, reason: 'recalcul après réouverture' }, 201);
  assert.equal(run.status, 'completed');
  assert.ok(num(`SELECT max(version) FROM payroll.results WHERE period_id = '${perSept}' AND employee_id = '${e1}'`) >= 3);
});

test('17 RBAC réel : sans permission, ni référentiel, ni simulation, ni résultat', async () => {
  const naked = await token(slugA, nakedEmail);
  const viewer = await token(slugA, viewEmail);
  for (const [path, body, method] of [
    ['/payroll/calendars', { code: 'X', labelFr: 'x', labelEn: 'x', frequency: 'monthly' }, 'POST'],
    ['/payroll/rubrics', { code: 'X', labelFr: 'x', labelEn: 'x', kind: 'gain', taxable: true, cotisable: true }, 'POST'],
    ['/payroll/compensations', { employeeId: e1, structureId: strA, effectiveFrom: '2026-01-01', baseAmount: 1, currency: 'XOF', periodicity: 'monthly', reason: 'x' }, 'POST'],
    ['/payroll/simulate', { periodId: perSept, employeeId: e1 }, 'POST'],
    ['/payroll/runs', { periodId: perSept, reason: 'x' }, 'POST'],
  ] as const) {
    const res = await api(path, naked, body, method);
    assert.equal(res.status, 403, `${path} doit refuser : ${res.status}`);
  }
  assert.equal((await api('/payroll/compensations', naked, undefined, 'GET')).status, 403, 'les salaires ne se consultent pas sans permission');
  // Le consultant voit les résultats mais ne calcule ni ne modifie rien.
  assert.equal((await api(`/payroll/periods/${perSept}/results`, viewer, undefined, 'GET')).status, 200);
  assert.equal((await api('/payroll/runs', viewer, { periodId: perSept, reason: 'x' })).status, 403);
  assert.equal((await api('/payroll/compensations', viewer, undefined, 'GET')).status, 403);
});

test('18 isolation tenant : la paie d’un tenant est invisible ET inactionnable depuis l’autre', async () => {
  const bAdm = await token(slugB, bAdmEmail);
  assert.deepEqual((await getJson<{ items: unknown[] }>('/payroll/periods', bAdm)).items, []);
  assert.deepEqual((await getJson<{ items: unknown[] }>('/payroll/calendars', bAdm)).items, []);
  assert.equal((await api(`/payroll/periods/${perSept}/results`, bAdm, undefined, 'GET')).status, 200);
  assert.deepEqual((await getJson<{ items: unknown[] }>(`/payroll/periods/${perSept}/results`, bAdm)).items, []);
  assert.equal((await api(`/payroll/results/${resultV2}`, bAdm, undefined, 'GET')).status, 404);
  assert.equal((await api('/payroll/runs', bAdm, { periodId: perSept, reason: 'intrusion' })).status, 404);
  assert.equal((await api('/payroll/compensations?employeeId=' + e1, bAdm, undefined, 'GET')).status, 200);
  assert.deepEqual((await getJson<{ items: unknown[] }>('/payroll/compensations?employeeId=' + e1, bAdm)).items, []);
});

test('19 prélèvements CNSS/ITS/VPS : DÉCLARÉS et versionnés par clés E4, JAMAIS calculés en E12.1', async () => {
  const adm = await token(slugA, admEmail);
  const cnss = await created('/payroll/levies', adm, {
    code: 'CNSS-SAL', labelFr: 'CNSS part salariale', labelEn: 'Employee social contribution',
    kind: 'salarial', baseKind: 'cotisable',
  });
  await postJson(`/payroll/levies/${cnss}/versions`, adm, {
    effectiveFrom: '2026-01-01', rateParamKey: 'cnss.taux.salarial', ceilingParamKey: 'cnss.plafond.mensuel',
  }, 201);
  // Un TAUX écrit en dur au lieu d'une clé E4 : refusé.
  const enDur = await api(`/payroll/levies/${cnss}/versions`, adm, { effectiveFrom: '2027-01-01', rateParamKey: '0.036' });
  assert.equal(enDur.status, 400, await enDur.text());
  const list = await getJson<{ items: Array<{ code: string; versions: unknown[] }>; note: string }>('/payroll/levies', adm);
  assert.equal(list.items[0]!.code, 'CNSS-SAL');
  assert.match(list.note, /AUCUN n’est calculé/);
  // Aucune ligne de paie ne porte de cotisation : E12.1 s'arrête au brut.
  assert.equal(num(`SELECT count(*) FROM payroll.result_lines l
    WHERE l.tenant_id = '${tenantAId}' AND l.rubric_code LIKE 'CNSS%'`), 0);
  // Les ASSIETTES, elles, sont produites — l'interface est prête.
  assert.ok(num(`SELECT contributable_base FROM payroll.results WHERE id = '${resultV2}'`) > 0);
});

test('20 audit : chaque opération sensible de paie est journalisée', async () => {
  const actions = psql(`SELECT string_agg(DISTINCT action, ',') FROM audit.audit_log
    WHERE tenant_id = '${tenantAId}' AND action LIKE 'payroll_%'`).split(',');
  for (const expected of [
    'payroll_calendar_created', 'payroll_period_created', 'payroll_structure_created',
    'payroll_rubric_created', 'payroll_rubric_version_added', 'payroll_compensation_added',
    'payroll_compensation_accessed', 'payroll_simulated', 'payroll_run_executed',
    'payroll_results_accessed', 'payroll_result_explained', 'payroll_results_compared',
    'payroll_period_status', 'payroll_reopen_requested', 'payroll_period_reopened',
    'payroll_levy_created', 'payroll_levy_version_added',
  ]) {
    assert.ok(actions.includes(expected), `action auditée manquante : ${expected}`);
  }
  // Le MONTANT d'une rémunération n'entre jamais au journal général.
  assert.equal(num(`SELECT count(*) FROM audit.audit_log
    WHERE tenant_id = '${tenantAId}' AND action = 'payroll_compensation_added'
      AND new_value::text LIKE '%300000%'`), 0, 'aucun salaire en clair dans l’audit');
});
