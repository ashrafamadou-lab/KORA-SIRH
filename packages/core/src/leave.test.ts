/**
 * E11.1 — Tests du moteur PUR des droits à congés : soldes = somme des mouvements,
 * acquisition mensuelle/annuelle idempotente par CLÉ, prorata embauche/cessation
 * déterministe, suspension du service effectif, report/expiration en mouvements
 * distincts, décompte ouvrés/ouvrables/calendaires/heures/demi-journées avec
 * fériés et rotations de nuit, projection ≠ acquis, reproductibilité stricte.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyRounding, computeBalances, countLeave, expectedAccruals,
  isoAddDays, planRollover, projectBalance, referencePeriodOf,
  type CountingDay, type EmploymentSpan, type LedgerEntryLike, type ResolvedPolicy,
} from './leave.ts';

const POLICY: ResolvedPolicy = {
  policyId: 'pol-1', policyVersion: 1, unit: 'open_days',
  accrualMode: 'monthly', accrualRate: 2, rateSource: { kind: 'parameter', key: 'conges.acquisition.taux_mensuel', parameterId: 'p-1', effectiveFrom: '2025-01-01' },
  referencePeriod: 'calendar_year',
  prorataHire: true, prorataTermination: true, rounding: 'half_up_0_5',
  accrualRequiresService: false, capValue: null, carryOverMax: null, carryOverExpiryMonths: null,
};

const EMP: EmploymentSpan = { hireDate: '2025-01-01', terminationDate: null, suspensions: [] };

function led(kind: LedgerEntryLike['entryKind'], q: number): LedgerEntryLike {
  return { entryKind: kind, quantity: q, referencePeriodStart: '2026-01-01', unit: 'open_days' };
}

// ---------------------------------------------------------------------------
// Soldes (buckets)
// ---------------------------------------------------------------------------

test('soldes : chaque bucket est la somme de ses mouvements, disponible dérivé', () => {
  const b = computeBalances([
    led('opening_balance', 5.5), led('accrual', 2), led('accrual', 2), led('adjustment_credit', 1),
    led('adjustment_debit', 0.5), led('reservation', 3), led('release', 1), led('consumption', 2),
  ]);
  assert.equal(b.accrued, 10.5);
  assert.equal(b.adjustedOut, 0.5);
  assert.equal(b.reserved, 2);
  assert.equal(b.consumed, 2);
  assert.equal(b.available, 6);
});

test('soldes : reversement diminue le consommé, report entrant tracé à part', () => {
  const b = computeBalances([
    led('carry_over', 6), led('consumption', 4), led('reversal', 1),
  ]);
  assert.equal(b.carriedIn, 6);
  assert.equal(b.accrued, 6);
  assert.equal(b.consumed, 3);
  assert.equal(b.available, 3);
});

test('soldes : quantité non positive REFUSÉE (le sens vient du type de mouvement)', () => {
  assert.throws(() => computeBalances([led('grant', 0)]));
  assert.throws(() => computeBalances([led('grant', -1)]));
});

// ---------------------------------------------------------------------------
// Acquisition mensuelle
// ---------------------------------------------------------------------------

test('acquisition mensuelle : un mouvement par mois, clé STABLE, effet en fin de mois', () => {
  const { entries, errors } = expectedAccruals({
    policy: POLICY, employment: EMP, periodStart: '2026-01-01', periodEnd: '2026-03-31',
  });
  assert.equal(errors.length, 0);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((e) => e.quantity), [2, 2, 2]);
  assert.deepEqual(entries.map((e) => e.effectiveOn), ['2026-01-31', '2026-02-28', '2026-03-31']);
  assert.equal(entries[0]!.idempotencyKey, 'accrual:pol-1:1:2026-01');
  // Reproductibilité stricte : même entrée ⇒ même sortie.
  assert.deepEqual(expectedAccruals({ policy: POLICY, employment: EMP, periodStart: '2026-01-01', periodEnd: '2026-03-31' }).entries, entries);
});

test('acquisition : rythme ABSENT ⇒ erreur explicite, AUCUN mouvement inventé', () => {
  const { entries, errors } = expectedAccruals({
    policy: { ...POLICY, accrualRate: null }, employment: EMP,
    periodStart: '2026-01-01', periodEnd: '2026-01-31',
  });
  assert.equal(entries.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /E4|paramètre|absente/);
});

test('prorata d\'embauche : jours de service / jours du mois, arrondi au demi SUPÉRIEUR au plus proche', () => {
  const { entries } = expectedAccruals({
    policy: POLICY, employment: { ...EMP, hireDate: '2026-01-17' },
    periodStart: '2026-01-01', periodEnd: '2026-02-28',
  });
  // Janvier : 15 jours servis / 31 ⇒ 2 × 15/31 = 0.9677 ⇒ arrondi 1.0 ; février plein.
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.quantity, 1);
  assert.equal(entries[0]!.proratedFor, 'hire');
  assert.equal(entries[1]!.quantity, 2);
  assert.equal(entries[1]!.proratedFor, 'none');
});

test('prorata de cessation : le mois de sortie est proratisé, les suivants n\'existent pas', () => {
  const { entries } = expectedAccruals({
    policy: POLICY, employment: { ...EMP, terminationDate: '2026-02-10' },
    periodStart: '2026-01-01', periodEnd: '2026-03-31',
  });
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.quantity, 2);
  // Février : 10/28 ⇒ 2 × 0.357 = 0.714 ⇒ 0.5 (au demi le plus proche).
  assert.equal(entries[1]!.quantity, 0.5);
  assert.equal(entries[1]!.proratedFor, 'termination');
});

test('service effectif exigé : la suspension RÉDUIT l\'acquisition du mois, sans l\'inventer ailleurs', () => {
  const { entries } = expectedAccruals({
    policy: { ...POLICY, accrualRequiresService: true, rounding: 'none' },
    employment: { ...EMP, suspensions: [{ from: '2026-01-11', to: '2026-01-20' }] },
    periodStart: '2026-01-01', periodEnd: '2026-01-31',
  });
  assert.equal(entries.length, 1);
  // 21 jours servis / 31 : 2 × 21/31 = 1.355
  assert.equal(entries[0]!.quantity, 1.355);
  assert.equal(entries[0]!.proratedFor, 'suspension');
});

test('service effectif NON exigé : la suspension ne change rien (politique du tenant)', () => {
  const { entries } = expectedAccruals({
    policy: POLICY,
    employment: { ...EMP, suspensions: [{ from: '2026-01-01', to: '2026-01-31' }] },
    periodStart: '2026-01-01', periodEnd: '2026-01-31',
  });
  assert.equal(entries[0]!.quantity, 2);
});

test('mois entièrement suspendu avec service exigé : AUCUN mouvement', () => {
  const { entries } = expectedAccruals({
    policy: { ...POLICY, accrualRequiresService: true },
    employment: { ...EMP, suspensions: [{ from: '2025-12-01', to: '2026-02-28' }] },
    periodStart: '2026-01-01', periodEnd: '2026-01-31',
  });
  assert.equal(entries.length, 0);
});

test('avant l\'embauche / après la cessation : AUCUN mouvement', () => {
  const a = expectedAccruals({
    policy: POLICY, employment: { ...EMP, hireDate: '2026-05-01' },
    periodStart: '2026-01-01', periodEnd: '2026-03-31',
  });
  assert.equal(a.entries.length, 0);
  const b = expectedAccruals({
    policy: POLICY, employment: { ...EMP, terminationDate: '2025-12-31' },
    periodStart: '2026-01-01', periodEnd: '2026-03-31',
  });
  assert.equal(b.entries.length, 0);
});

// ---------------------------------------------------------------------------
// Attribution annuelle / anniversaire
// ---------------------------------------------------------------------------

test('attribution annuelle : une seule fois par période de référence, proratisée à l\'embauche', () => {
  const pol: ResolvedPolicy = { ...POLICY, accrualMode: 'annual', accrualRate: 24, rounding: 'none' };
  const full = expectedAccruals({ policy: pol, employment: EMP, periodStart: '2026-03-01', periodEnd: '2026-03-31' });
  assert.equal(full.entries.length, 1);
  assert.equal(full.entries[0]!.quantity, 24);
  assert.equal(full.entries[0]!.effectiveOn, '2026-01-01');
  assert.equal(full.entries[0]!.idempotencyKey, 'accrual:pol-1:1:2026-01-01:annual');
  const hired = expectedAccruals({
    policy: pol, employment: { ...EMP, hireDate: '2026-07-01' },
    periodStart: '2026-08-01', periodEnd: '2026-08-31',
  });
  // 184 jours servis / 365 ⇒ 24 × 0.5041 = 12.099
  assert.equal(hired.entries.length, 1);
  assert.ok(Math.abs(hired.entries[0]!.quantity - 12.099) < 0.001);
});

test('période de référence anniversaire : bornée sur la date d\'embauche', () => {
  const pol: ResolvedPolicy = { ...POLICY, referencePeriod: 'anniversary' };
  const emp = { ...EMP, hireDate: '2024-05-15' };
  assert.deepEqual(referencePeriodOf(pol, '2026-06-01', emp.hireDate), { start: '2026-05-15', end: '2027-05-14' });
  assert.deepEqual(referencePeriodOf(pol, '2026-05-01', emp.hireDate), { start: '2025-05-15', end: '2026-05-14' });
});

test('période personnalisée (custom) : départ au mois/jour configuré', () => {
  const pol: ResolvedPolicy = { ...POLICY, referencePeriod: 'custom', refStartMonth: 10, refStartDay: 1 };
  assert.deepEqual(referencePeriodOf(pol, '2026-11-02', EMP.hireDate), { start: '2026-10-01', end: '2027-09-30' });
  assert.deepEqual(referencePeriodOf(pol, '2026-02-02', EMP.hireDate), { start: '2025-10-01', end: '2026-09-30' });
});

// ---------------------------------------------------------------------------
// Report / expiration
// ---------------------------------------------------------------------------

test('report borné : l\'excédent EXPIRE — deux mouvements distincts, clés stables', () => {
  const plan = planRollover({
    policy: { ...POLICY, carryOverMax: 6 },
    fromPeriod: { start: '2026-01-01', end: '2026-12-31' },
    toPeriod: { start: '2027-01-01', end: '2027-12-31' },
    available: 9.5,
  });
  assert.equal(plan.carryOver!.quantity, 6);
  assert.equal(plan.expire!.quantity, 3.5);
  assert.equal(plan.carryOver!.idempotencyKey, 'carryover:pol-1:1:2026-01-01');
  assert.equal(plan.expire!.idempotencyKey, 'expiry:pol-1:1:2026-01-01');
});

test('report illimité : tout passe, rien n\'expire ; solde nul : rien du tout', () => {
  const all = planRollover({
    policy: POLICY, fromPeriod: { start: '2026-01-01', end: '2026-12-31' },
    toPeriod: { start: '2027-01-01', end: '2027-12-31' }, available: 4,
  });
  assert.equal(all.carryOver!.quantity, 4);
  assert.equal(all.expire, null);
  const none = planRollover({
    policy: POLICY, fromPeriod: { start: '2026-01-01', end: '2026-12-31' },
    toPeriod: { start: '2027-01-01', end: '2027-12-31' }, available: 0,
  });
  assert.equal(none.carryOver, null);
  assert.equal(none.expire, null);
});

// ---------------------------------------------------------------------------
// Décompte calendrier
// ---------------------------------------------------------------------------

function day(date: string, opts: Partial<CountingDay> = {}): CountingDay {
  const wd = new Date(`${date}T00:00:00Z`).getUTCDay();
  return { date, scheduled: true, plannedMinutes: 480, isRest: false, isHoliday: false, weekday: wd, ...opts };
}

test('jours OUVRÉS : fériés et repos exclus, chaque journée explique son sort', () => {
  const r = countLeave({
    unit: 'open_days',
    days: [
      day('2026-08-03'), day('2026-08-04', { isHoliday: true }),
      day('2026-08-05'), day('2026-08-06', { isRest: true, scheduled: false, plannedMinutes: 0 }),
    ],
  });
  assert.equal(r.quantity, 2);
  assert.match(r.detail[1]!.why, /férié/);
  assert.match(r.detail[3]!.why, /repos/);
});

test('jours OUVRABLES : régime E4 (lun–sam), indépendant de l\'horaire individuel', () => {
  const r = countLeave({
    unit: 'working_days', workableWeekdays: [1, 2, 3, 4, 5, 6],
    days: [
      day('2026-08-07'),                                       // vendredi ouvrable
      day('2026-08-08', { isRest: true, scheduled: false }),   // samedi : repos INDIVIDUEL mais OUVRABLE
      day('2026-08-09', { isRest: true, scheduled: false }),   // dimanche : non ouvrable
      day('2026-08-10'),                                       // lundi
    ],
  });
  assert.equal(r.quantity, 3, 'le samedi compte en ouvrable même si l\'individu est de repos');
});

test('jours OUVRABLES sans régime E4 : erreur explicite, jamais un défaut silencieux', () => {
  const r = countLeave({ unit: 'working_days', days: [day('2026-08-03')] });
  assert.equal(r.quantity, 0);
  assert.equal(r.errors.length, 1);
});

test('jours calendaires : tout compte, fériés inclus', () => {
  const r = countLeave({
    unit: 'calendar_days',
    days: [day('2026-08-01'), day('2026-08-02', { isRest: true }), day('2026-08-03', { isHoliday: true })],
  });
  assert.equal(r.quantity, 3);
});

test('heures : minutes PLANIFIÉES de l\'horaire E10 — une rotation de nuit compte sur SA journée', () => {
  const r = countLeave({
    unit: 'hours',
    days: [
      day('2026-08-03', { plannedMinutes: 480 }),  // nuit 22:00→06:00 rattachée au 03 (journée de travail E10)
      day('2026-08-04', { plannedMinutes: 450 }),
      day('2026-08-05', { isRest: true, scheduled: false, plannedMinutes: 0 }),
    ],
  });
  assert.equal(r.quantity, 15.5);
  assert.equal(r.detail[2]!.counted, 0, 'le lendemain de nuit au repos ne compte pas une seconde fois');
});

test('demi-journées de bord : première et dernière réduites, journée unique = une moitié', () => {
  const three = countLeave({
    unit: 'open_days', halfStart: true, halfEnd: true,
    days: [day('2026-08-03'), day('2026-08-04'), day('2026-08-05')],
  });
  assert.equal(three.quantity, 2);
  const single = countLeave({ unit: 'open_days', halfStart: true, days: [day('2026-08-03')] });
  assert.equal(single.quantity, 0.5);
});

test('unité demi-journées : une journée planifiée = 2 demi-journées', () => {
  const r = countLeave({ unit: 'half_days', days: [day('2026-08-03'), day('2026-08-04', { isHoliday: true })] });
  assert.equal(r.quantity, 2);
});

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

test('projection : disponible + acquisitions FUTURES planifiées, clairement qualifiée', () => {
  const p = projectBalance({
    policy: POLICY, employment: EMP, currentAvailable: 6,
    fromDateExclusive: '2026-03-31', toDate: '2026-06-30',
  });
  assert.equal(p.plannedAccruals.length, 3);
  assert.equal(p.projected, 12);
  assert.match(p.note, /PROJECTION/);
  const nothing = projectBalance({
    policy: POLICY, employment: EMP, currentAvailable: 6,
    fromDateExclusive: '2026-06-30', toDate: '2026-06-30',
  });
  assert.equal(nothing.projected, 6);
});

// ---------------------------------------------------------------------------
// Divers
// ---------------------------------------------------------------------------

test('arrondis : none / demi le plus proche / demi supérieur / entier supérieur', () => {
  assert.equal(applyRounding(1.355, 'none'), 1.355);
  assert.equal(applyRounding(0.714, 'half_up_0_5'), 0.5);
  assert.equal(applyRounding(0.75, 'half_up_0_5'), 1);
  assert.equal(applyRounding(0.1, 'up_0_5'), 0.5);
  assert.equal(applyRounding(1.01, 'up_1'), 2);
});

test('isoAddDays : bornes de mois et d\'années franchies proprement', () => {
  assert.equal(isoAddDays('2026-01-31', 1), '2026-02-01');
  assert.equal(isoAddDays('2026-01-01', -1), '2025-12-31');
  assert.equal(isoAddDays('2024-02-28', 1), '2024-02-29');
});
