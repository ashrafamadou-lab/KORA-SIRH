/**
 * E11.1 — Moteur PUR des droits à congés : acquisition déterministe à clés
 * d'idempotence, prorata d'embauche/cessation, report et expiration en mouvements
 * DISTINCTS, soldes = somme des mouvements (buckets), décompte calendrier
 * (ouvrés/ouvrables/calendaires/heures/demi-journées, fériés, rotations de nuit),
 * projection future.
 *
 * RÈGLES : zéro horloge, zéro dépendance, zéro valeur légale — les rythmes,
 * plafonds et reports viennent d'une VERSION de politique (valeur du tenant) ou
 * d'un paramètre E4 résolu à la date par l'appelant. Une source manquante est une
 * ERREUR explicite, jamais un défaut silencieux. Même entrée ⇒ même sortie.
 */

export const LEAVE_ENGINE_VERSION = 'kora-leave-1.0.0';

// ---------------------------------------------------------------------------
// Types partagés
// ---------------------------------------------------------------------------

export type LeaveUnit = 'open_days' | 'working_days' | 'calendar_days' | 'half_days' | 'hours';

export type LedgerKind =
  | 'opening_balance' | 'accrual' | 'grant' | 'reservation' | 'release'
  | 'consumption' | 'adjustment_credit' | 'adjustment_debit'
  | 'carry_over' | 'expiry' | 'reversal';

export interface LedgerEntryLike {
  entryKind: LedgerKind;
  quantity: number;            // TOUJOURS > 0 : le sens est porté par le type de mouvement
  referencePeriodStart: string; // AAAA-MM-JJ
  unit: LeaveUnit;
}

export interface LeaveBalances {
  accrued: number;      // acquis brut (ouverture + acquisitions + attributions + crédits + report entrant)
  adjustedOut: number;  // débits administratifs
  carriedIn: number;    // dont report entrant
  expired: number;      // expiré
  reserved: number;     // réservé (réservations − libérations)
  consumed: number;     // consommé (consommations − reversements)
  available: number;    // disponible = acquis − débits − expiré − réservé − consommé
}

/** Somme des mouvements — SEULE définition du solde (miroir exact de leave.balances_v). */
export function computeBalances(entries: readonly LedgerEntryLike[]): LeaveBalances {
  let accrued = 0, adjustedOut = 0, carriedIn = 0, expired = 0;
  let reservedIn = 0, reservedOut = 0, consumedIn = 0, consumedOut = 0;
  for (const e of entries) {
    if (!(e.quantity > 0)) throw new Error('ledger : quantité strictement positive requise');
    switch (e.entryKind) {
      case 'opening_balance':
      case 'accrual':
      case 'grant':
      case 'adjustment_credit':
        accrued += e.quantity; break;
      case 'carry_over':
        accrued += e.quantity; carriedIn += e.quantity; break;
      case 'adjustment_debit': adjustedOut += e.quantity; break;
      case 'expiry': expired += e.quantity; break;
      case 'reservation': reservedIn += e.quantity; break;
      case 'release': reservedOut += e.quantity; break;
      case 'consumption': consumedIn += e.quantity; break;
      case 'reversal': consumedOut += e.quantity; break;
    }
  }
  const reserved = round3(reservedIn - reservedOut);
  const consumed = round3(consumedIn - consumedOut);
  const available = round3(accrued - adjustedOut - expired - reserved - consumed);
  return {
    accrued: round3(accrued), adjustedOut: round3(adjustedOut), carriedIn: round3(carriedIn),
    expired: round3(expired), reserved, consumed, available,
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Politique applicable (contenu d'une VERSION) — valeurs déjà résolues.
// ---------------------------------------------------------------------------

export type AccrualMode = 'monthly' | 'annual' | 'anniversary' | 'one_time' | 'none';
export type ReferencePeriodKind = 'calendar_year' | 'anniversary' | 'custom';
export type RoundingRule = 'none' | 'half_up_0_5' | 'up_0_5' | 'up_1';

export interface ResolvedPolicy {
  policyId: string;
  policyVersion: number;
  unit: LeaveUnit;
  accrualMode: AccrualMode;
  /** Rythme RÉSOLU (E4 à la date, ou valeur de la version) — null = source manquante. */
  accrualRate: number | null;
  /** Provenance exacte, conservée dans chaque mouvement (reproductibilité). */
  rateSource: { kind: 'parameter'; key: string; parameterId: string | null; effectiveFrom: string | null } | { kind: 'policy_value' };
  referencePeriod: ReferencePeriodKind;
  refStartMonth?: number; // custom
  refStartDay?: number;   // custom
  prorataHire: boolean;
  prorataTermination: boolean;
  rounding: RoundingRule;
  accrualRequiresService: boolean;
  capValue: number | null;           // plafond de cumul résolu (null = aucun)
  carryOverMax: number | null;       // report maximal résolu (null = illimité)
  carryOverExpiryMonths: number | null;
}

export interface EmploymentSpan {
  hireDate: string;              // AAAA-MM-JJ
  terminationDate: string | null;
  /** Périodes NON assimilées à du service effectif (suspensions), bornes incluses. */
  suspensions: ReadonlyArray<{ from: string; to: string }>;
}

// ---------------------------------------------------------------------------
// Petites dates pures (AAAA-MM-JJ) — aucune horloge.
// ---------------------------------------------------------------------------

export function isoAddDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const t = Date.UTC(y!, m! - 1, d! + days);
  return new Date(t).toISOString().slice(0, 10);
}

export function isoCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function monthEnd(year: number, month: number): string {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Période de référence CONTENANT une date, pour une politique donnée. */
export function referencePeriodOf(policy: ResolvedPolicy, date: string, hireDate: string): { start: string; end: string } {
  const [y] = date.split('-').map(Number);
  if (policy.referencePeriod === 'calendar_year') {
    return { start: `${y}-01-01`, end: `${y}-12-31` };
  }
  if (policy.referencePeriod === 'anniversary') {
    const [, hm, hd] = hireDate.split('-').map(Number);
    const annivThisYear = `${y}-${String(hm).padStart(2, '0')}-${String(hd).padStart(2, '0')}`;
    const start = date >= annivThisYear ? annivThisYear
      : `${y! - 1}-${String(hm).padStart(2, '0')}-${String(hd).padStart(2, '0')}`;
    const [sy] = start.split('-').map(Number);
    return { start, end: isoAddDays(`${sy! + 1}-${String(hm).padStart(2, '0')}-${String(hd).padStart(2, '0')}`, -1) };
  }
  const sm = policy.refStartMonth ?? 1;
  const sd = policy.refStartDay ?? 1;
  const startThisYear = `${y}-${String(sm).padStart(2, '0')}-${String(sd).padStart(2, '0')}`;
  const start = date >= startThisYear ? startThisYear
    : `${y! - 1}-${String(sm).padStart(2, '0')}-${String(sd).padStart(2, '0')}`;
  const [sy] = start.split('-').map(Number);
  return { start, end: isoAddDays(`${sy! + 1}-${String(sm).padStart(2, '0')}-${String(sd).padStart(2, '0')}`, -1) };
}

// ---------------------------------------------------------------------------
// Acquisition : mouvements ATTENDUS pour une période (déterministe, idempotent).
// ---------------------------------------------------------------------------

export interface ExpectedAccrual {
  idempotencyKey: string;   // stable : rejouer ne crée rien (UNIQUE en base)
  quantity: number;         // > 0, arrondi selon la règle
  effectiveOn: string;      // fin de mois / d'année / d'anniversaire
  referencePeriodStart: string;
  referencePeriodEnd: string;
  monthLabel: string;       // trace humaine (AAAA-MM ou AAAA)
  proratedFor: 'none' | 'hire' | 'termination' | 'hire_and_termination' | 'suspension';
  serviceRatio: number;     // 1 = mois entier de service effectif
}

export function applyRounding(qty: number, rule: RoundingRule): number {
  switch (rule) {
    case 'none': return round3(qty);
    case 'half_up_0_5': return Math.round(qty * 2) / 2;
    case 'up_0_5': return Math.ceil(qty * 2) / 2;
    case 'up_1': return Math.ceil(qty);
  }
}

function clampSpanDays(from: string, to: string, spanFrom: string, spanTo: string): number {
  const a = from > spanFrom ? from : spanFrom;
  const b = to < spanTo ? to : spanTo;
  if (a > b) return 0;
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by!, bm! - 1, bd!) - Date.UTC(ay!, am! - 1, ad!)) / 86_400_000) + 1;
}

/**
 * Mouvements d'acquisition attendus pour [periodStart..periodEnd] (bornes de mois
 * incluses pour le mode mensuel). Rythme ABSENT ⇒ erreur explicite listée, aucun
 * mouvement inventé. Le prorata est calculé en JOURS de service effectif du mois.
 */
export function expectedAccruals(input: {
  policy: ResolvedPolicy;
  employment: EmploymentSpan;
  periodStart: string;  // AAAA-MM-JJ (typiquement 1er du mois)
  periodEnd: string;
}): { entries: ExpectedAccrual[]; errors: string[] } {
  const { policy, employment } = input;
  const errors: string[] = [];
  const entries: ExpectedAccrual[] = [];
  if (policy.accrualMode === 'none') return { entries, errors };
  if (policy.accrualRate === null) {
    return { entries, errors: ['rythme d\'acquisition introuvable (paramètre E4 inactif à la date ou valeur absente) — aucun mouvement créé'] };
  }
  if (policy.accrualMode === 'monthly') {
    const [sy, sm] = input.periodStart.split('-').map(Number);
    const [ey, em] = input.periodEnd.split('-').map(Number);
    let y = sy!, m = sm!;
    while (y < ey! || (y === ey! && m <= em!)) {
      const mStart = `${y}-${String(m).padStart(2, '0')}-01`;
      const mEnd = monthEnd(y, m);
      const entry = monthlyAccrualFor(policy, employment, y, m, mStart, mEnd);
      if (entry) entries.push(entry);
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
    return { entries, errors };
  }
  if (policy.accrualMode === 'annual' || policy.accrualMode === 'anniversary' || policy.accrualMode === 'one_time') {
    // Attribution en UNE fois au début de la période de référence contenant periodStart.
    const ref = referencePeriodOf(policy, input.periodStart, employment.hireDate);
    if (employment.terminationDate && employment.terminationDate < ref.start) return { entries, errors };
    if (employment.hireDate > ref.end) return { entries, errors };
    let qty = policy.accrualRate;
    let prorated: ExpectedAccrual['proratedFor'] = 'none';
    let ratio = 1;
    const spanFrom = employment.hireDate > ref.start ? employment.hireDate : ref.start;
    const spanTo = employment.terminationDate && employment.terminationDate < ref.end ? employment.terminationDate : ref.end;
    const total = clampSpanDays(ref.start, ref.end, ref.start, ref.end);
    const served = clampSpanDays(ref.start, ref.end, spanFrom, spanTo);
    if (served < total && (policy.prorataHire || policy.prorataTermination)) {
      ratio = served / total;
      qty = policy.accrualRate * ratio;
      prorated = employment.hireDate > ref.start
        ? (employment.terminationDate && employment.terminationDate < ref.end ? 'hire_and_termination' : 'hire')
        : 'termination';
    }
    const rounded = applyRounding(qty, policy.rounding);
    if (rounded > 0) {
      entries.push({
        idempotencyKey: `accrual:${policy.policyId}:${policy.policyVersion}:${ref.start}:annual`,
        quantity: rounded, effectiveOn: ref.start,
        referencePeriodStart: ref.start, referencePeriodEnd: ref.end,
        monthLabel: ref.start.slice(0, 4), proratedFor: prorated, serviceRatio: round3(ratio),
      });
    }
    return { entries, errors };
  }
  return { entries, errors };
}

function monthlyAccrualFor(
  policy: ResolvedPolicy, employment: EmploymentSpan,
  y: number, m: number, mStart: string, mEnd: string,
): ExpectedAccrual | null {
  if (employment.hireDate > mEnd) return null;
  if (employment.terminationDate && employment.terminationDate < mStart) return null;
  const spanFrom = employment.hireDate > mStart ? employment.hireDate : mStart;
  const spanTo = employment.terminationDate && employment.terminationDate < mEnd ? employment.terminationDate : mEnd;
  const totalDays = daysInMonth(y, m);
  let servedDays = clampSpanDays(mStart, mEnd, spanFrom, spanTo);
  let suspended = false;
  if (policy.accrualRequiresService) {
    for (const s of employment.suspensions) {
      const overlap = clampSpanDays(spanFrom, spanTo, s.from, s.to);
      if (overlap > 0) { servedDays -= overlap; suspended = true; }
    }
    if (servedDays < 0) servedDays = 0;
  }
  if (servedDays === 0) return null;
  const hireProrata = employment.hireDate > mStart && policy.prorataHire;
  const termProrata = employment.terminationDate !== null && employment.terminationDate < mEnd && policy.prorataTermination;
  const fullMonth = servedDays >= totalDays;
  let qty = policy.accrualRate!;
  let prorated: ExpectedAccrual['proratedFor'] = 'none';
  if (!fullMonth) {
    if (!hireProrata && !termProrata && !suspended) {
      // Mois incomplet mais prorata désactivé pour cette cause : mois plein.
      qty = policy.accrualRate!;
    } else {
      qty = policy.accrualRate! * (servedDays / totalDays);
      prorated = suspended ? 'suspension'
        : hireProrata && termProrata ? 'hire_and_termination'
          : hireProrata ? 'hire' : 'termination';
    }
  }
  const rounded = applyRounding(qty, policy.rounding);
  if (rounded <= 0) return null;
  const ref = referencePeriodOf(policy, mStart, employment.hireDate);
  return {
    idempotencyKey: `accrual:${policy.policyId}:${policy.policyVersion}:${y}-${String(m).padStart(2, '0')}`,
    quantity: rounded, effectiveOn: mEnd,
    referencePeriodStart: ref.start, referencePeriodEnd: ref.end,
    monthLabel: `${y}-${String(m).padStart(2, '0')}`,
    proratedFor: prorated, serviceRatio: round3(servedDays / totalDays),
  };
}

// ---------------------------------------------------------------------------
// Report / expiration au passage de période — mouvements DISTINCTS.
// ---------------------------------------------------------------------------

export interface RolloverPlan {
  expire: { quantity: number; idempotencyKey: string } | null;
  carryOver: { quantity: number; idempotencyKey: string; toPeriodStart: string; toPeriodEnd: string } | null;
}

/**
 * À la clôture d'une période de référence : reporter jusqu'au plafond de report,
 * expirer le reste. disponible ≤ 0 ⇒ rien. carryOverMax null ⇒ tout est reporté.
 */
export function planRollover(input: {
  policy: ResolvedPolicy;
  fromPeriod: { start: string; end: string };
  toPeriod: { start: string; end: string };
  available: number;
}): RolloverPlan {
  const avail = round3(input.available);
  if (avail <= 0) return { expire: null, carryOver: null };
  const max = input.policy.carryOverMax;
  const carried = max === null ? avail : Math.min(avail, max);
  const expired = round3(avail - carried);
  const base = `${input.policy.policyId}:${input.policy.policyVersion}:${input.fromPeriod.start}`;
  return {
    carryOver: carried > 0 ? {
      quantity: round3(carried),
      idempotencyKey: `carryover:${base}`,
      toPeriodStart: input.toPeriod.start, toPeriodEnd: input.toPeriod.end,
    } : null,
    expire: expired > 0 ? { quantity: expired, idempotencyKey: `expiry:${base}` } : null,
  };
}

// ---------------------------------------------------------------------------
// Décompte calendrier d'une absence — fériés, repos, rotations, demi-journées.
// ---------------------------------------------------------------------------

export interface CountingDay {
  date: string;            // journée de TRAVAIL (une rotation de nuit reste rattachée à SA journée)
  scheduled: boolean;      // une plage est planifiée ce jour (horaire E10)
  plannedMinutes: number;  // minutes planifiées (0 si repos)
  isRest: boolean;
  isHoliday: boolean;
  weekday: number;         // 0 = dimanche … 6 = samedi (calendrier local)
}

export interface LeaveCountInput {
  unit: LeaveUnit;
  days: readonly CountingDay[];
  /** Jours OUVRABLES du régime (E4 `conges.ouvrables.jours`, ex. [1,2,3,4,5,6]) — requis pour unit='working_days'. */
  workableWeekdays?: readonly number[];
  /** Demi-journée au premier / dernier jour (unités jours uniquement). */
  halfStart?: boolean;
  halfEnd?: boolean;
}

export interface LeaveCountResult {
  quantity: number;
  unit: LeaveUnit;
  detail: Array<{ date: string; counted: number; why: string }>;
  errors: string[];
}

/** Décompte PUR : chaque journée explique pourquoi elle compte (ou pas). */
export function countLeave(input: LeaveCountInput): LeaveCountResult {
  const detail: LeaveCountResult['detail'] = [];
  const errors: string[] = [];
  let qty = 0;
  const daysSorted = [...input.days].sort((a, b) => isoCompare(a.date, b.date));
  const lastIdx = daysSorted.length - 1;
  for (let i = 0; i <= lastIdx; i++) {
    const d = daysSorted[i]!;
    let counted = 0;
    let why = '';
    switch (input.unit) {
      case 'calendar_days':
        counted = 1; why = 'jour calendaire';
        break;
      case 'open_days': // jours OUVRÉS : selon l'horaire du salarié
        if (d.isHoliday) { why = 'férié — non décompté'; }
        else if (d.isRest || !d.scheduled) { why = 'repos/non planifié — non décompté'; }
        else { counted = 1; why = 'jour ouvré planifié'; }
        break;
      case 'working_days': { // jours OUVRABLES : régime E4, indépendant de l'horaire individuel
        const workable = input.workableWeekdays;
        if (!workable) { errors.push('working_days : liste des jours ouvrables (E4) requise'); why = 'régime ouvrable manquant'; break; }
        if (d.isHoliday) { why = 'férié — non décompté'; }
        else if (!workable.includes(d.weekday)) { why = 'jour non ouvrable — non décompté'; }
        else { counted = 1; why = 'jour ouvrable'; }
        break;
      }
      case 'half_days':
        if (d.isHoliday) { why = 'férié — non décompté'; }
        else if (d.isRest || !d.scheduled) { why = 'repos/non planifié — non décompté'; }
        else { counted = 2; why = 'journée planifiée = 2 demi-journées'; }
        break;
      case 'hours':
        if (d.isHoliday) { why = 'férié — non décompté'; }
        else if (d.isRest || !d.scheduled) { why = 'repos/non planifié — non décompté'; }
        else { counted = round3(d.plannedMinutes / 60); why = `${d.plannedMinutes} minutes planifiées`; }
        break;
    }
    // Demi-journées de bord (unités « jours » entiers uniquement).
    if (counted > 0 && (input.unit === 'open_days' || input.unit === 'working_days' || input.unit === 'calendar_days')) {
      if (input.halfStart && i === 0) { counted = counted / 2; why += ' (demi-journée de début)'; }
      if (input.halfEnd && i === lastIdx && daysSorted.length > 1) { counted = counted / 2; why += ' (demi-journée de fin)'; }
      if (input.halfStart && input.halfEnd && daysSorted.length === 1) { /* déjà réduit une fois : une seule journée à moitié */ }
    }
    qty += counted;
    detail.push({ date: d.date, counted: round3(counted), why });
  }
  return { quantity: round3(qty), unit: input.unit, detail, errors };
}

// ---------------------------------------------------------------------------
// Projection : solde ATTENDU à une date future = disponible + acquisitions planifiées.
// ---------------------------------------------------------------------------

export function projectBalance(input: {
  policy: ResolvedPolicy;
  employment: EmploymentSpan;
  currentAvailable: number;
  fromDateExclusive: string; // dernier mouvement pris en compte (souvent : fin du mois courant déjà acquis)
  toDate: string;
}): { projected: number; plannedAccruals: ExpectedAccrual[]; note: string } {
  if (input.toDate <= input.fromDateExclusive) {
    return { projected: round3(input.currentAvailable), plannedAccruals: [], note: 'aucune acquisition future dans l\'intervalle' };
  }
  const start = isoAddDays(input.fromDateExclusive, 1);
  const { entries } = expectedAccruals({
    policy: input.policy, employment: input.employment,
    periodStart: start, periodEnd: input.toDate,
  });
  const planned = entries.filter((e) => e.effectiveOn > input.fromDateExclusive && e.effectiveOn <= input.toDate);
  const sum = planned.reduce((s, e) => s + e.quantity, 0);
  return {
    projected: round3(input.currentAvailable + sum),
    plannedAccruals: planned,
    note: 'PROJECTION : distincte du droit définitivement acquis — les acquisitions futures restent conditionnelles',
  };
}

// ---------------------------------------------------------------------------
// Clés E4 consommées par E11.1 (résolues à la date par l'appelant, jamais ici).
// ---------------------------------------------------------------------------

export const LEAVE_PARAM_KEYS = [
  'conges.acquisition.taux_mensuel',     // rythme légal d'acquisition (jours ouvrés/mois)
  'conges.acquisition.anciennete_min_mois',
  'conges.report.max_jours',
  'conges.report.expiration_mois',
  'conges.plafond.cumul',
  'conges.ouvrables.jours',              // jours ouvrables du régime (tableau 0–6)
  'conges.ajustement.seuil_sensible',    // au-delà : circuit E3 requis pour l'ajustement
] as const;
