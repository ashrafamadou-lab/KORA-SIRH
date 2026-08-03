/**
 * Moteur de PRÉSENCE (E10.2) — domaine pur, zéro dépendance, zéro horloge.
 *
 * Transforme les FAITS d'une journée (plage planifiée effective, événements
 * normalisés en minutes locales, contexte d'emploi, paramètres E4 résolus À LA
 * DATE) en un résultat journalier ENTIÈREMENT déterministe :
 *  - appariement des pointages SANS AUCUNE invention : une sortie manquante est
 *    une ANOMALIE, jamais une heure fabriquée ;
 *  - minutes ENTIÈRES ; les valeurs BRUTES (avant tolérance/arrondi) sont
 *    toujours retournées à côté des valeurs retenues ;
 *  - heures de nuit découpées sur les périodes RÉELLEMENT travaillées, plage
 *    nocturne pouvant traverser minuit, journées locales de plus de 24 h gérées
 *    (minutes relatives au jour de travail, au-delà de 1440 = le lendemain) ;
 *  - heures supplémentaires CANDIDATES uniquement — aucun taux, aucun montant ;
 *  - statut dérivé des faits : jamais d'absence « autorisée » sans justification
 *    (les justifications sont des modules ultérieurs).
 */

export const PRESENCE_ENGINE_VERSION = 'kora-presence-1.1.0';

export type DayStatus =
  | 'present' | 'late' | 'early_departure' | 'late_and_early_departure'
  | 'absent' | 'partial_presence' | 'incomplete_punches'
  | 'rest_day' | 'public_holiday' | 'worked_rest_day' | 'worked_public_holiday'
  | 'not_scheduled' | 'not_employed' | 'suspended' | 'unresolved';

export type AnomalyCode =
  | 'missing_in' | 'missing_out' | 'sequence_error' | 'odd_untyped_events'
  | 'impossible_duration' | 'excessive_presence' | 'punch_outside_schedule'
  | 'punch_other_site' | 'no_schedule' | 'no_assignment' | 'not_yet_hired'
  | 'terminated' | 'suspended' | 'overlapping_periods' | 'break_too_short'
  | 'ambiguous_local_time' | 'unmatched_event_pending' | 'calc_failed';

export type AnomalySeverity = 'info' | 'warning' | 'blocking';

export interface PresenceAnomaly {
  code: AnomalyCode;
  severity: AnomalySeverity;
  detail?: string;
  refs?: Record<string, unknown>;
}

/** Plage planifiée EFFECTIVE du jour (exceptions déjà superposées par l'appelant). */
export interface PlannedDay {
  isRest: boolean;
  startMinute: number | null;
  endMinute: number | null;             // > start, ≤ start + 1440 (lendemain si > 1440)
  breakStartMinute: number | null;
  breakEndMinute: number | null;
}

export interface PresenceParams {
  lateToleranceMin: number;
  earlyToleranceMin: number;
  matchWindowBeforeMin: number;
  matchWindowAfterMin: number;
  minBreakMin: number;                  // 0 = pause minimale non contrôlée
  fullDayDeficitMin: number;            // manque toléré pour rester « journée complète »
  partialPresenceMin: number;           // minutes travaillées minimales pour « partielle »
  nightStartMin: number;                // ex. 1320 (22:00)
  nightEndMin: number;                  // ex. 360 (06:00) — traverse minuit si début > fin
  roundingMin: number;                  // granularité d'arrondi des valeurs RETENUES (≤ 1 = aucun)
  overtimeDailyThresholdMin: number | null; // null ⇒ seuil = durée planifiée du jour
  maxPresenceMin: number;               // plafond de plausibilité (présence continue)
}

export interface PresenceEvent {
  id: string;
  /** Minutes locales relatives à 00:00 du JOUR DE TRAVAIL (négatif = veille, > 1440 = lendemain). */
  localMinute: number;
  type: 'in' | 'out' | 'unknown';
  /** false = pointé sur un AUTRE site que celui de l'affectation ; null = indéterminé. */
  siteMatches: boolean | null;
  ambiguousTime: boolean;
}

export interface EmploymentContext {
  active: boolean;
  notYetHired: boolean;
  terminated: boolean;
  suspended: boolean;
  hasAssignment: boolean;
}

/**
 * Justifications APPROUVÉES du jour (E10.3) — issues d'événements correctifs,
 * jamais d'une saisie directe. Elles QUALIFIENT les faits (catégorie, minutes
 * justifiées) sans JAMAIS inventer d'heure travaillée ni effacer une mesure :
 * un retard justifié reste mesuré et retenu ; une absence justifiée reste une
 * absence — la paie (module ultérieur) décidera de l'effet financier.
 */
export interface DayJustification {
  target: 'absence' | 'late' | 'early_departure' | 'offsite';
  category: string;
  minutes?: number | null;
}

export interface DayCorrections {
  justifications: DayJustification[];
  /** Nombre TOTAL d'événements correctifs consommés pour la journée (traçabilité). */
  appliedCount: number;
}

export interface ComputeDayInput {
  planned: PlannedDay | null;           // null = aucun horaire applicable
  holiday: boolean;
  employment: EmploymentContext;
  events: PresenceEvent[];
  params: PresenceParams;
  /** Des événements NON APPARIÉS du jour existent encore (résolution incertaine). */
  hasPendingUnmatched?: boolean;
  corrections?: DayCorrections;
}

export interface WorkPeriod { startMinute: number; endMinute: number }

export interface DayComputation {
  status: DayStatus;
  periods: WorkPeriod[];
  firstInMinute: number | null;
  lastOutMinute: number | null;
  presenceMinutes: number;
  workedMinutes: number;
  breakMinutes: number;
  lateMinutesRaw: number;
  lateMinutes: number;
  earlyDepartureMinutesRaw: number;
  earlyDepartureMinutes: number;
  absenceMinutes: number;
  nightMinutes: number;
  restDayMinutes: number;
  holidayMinutes: number;
  overtimeCandidateMinutes: number;
  usedEventIds: string[];
  anomalies: PresenceAnomaly[];
  /** Qualification E10.3 (corrections approuvées) — jamais une heure inventée. */
  justifiedCategory: string | null;
  justifiedMinutes: number;
  lateJustified: boolean;
  earlyJustified: boolean;
  correctionsApplied: number;
}

// ---------------------------------------------------------------------------
// Outils purs
// ---------------------------------------------------------------------------

/** Arrondi à la granularité (au plus proche, .5 vers le haut) — jamais sur les bruts. */
export function roundRetained(minutes: number, granularity: number): number {
  if (granularity <= 1) return minutes;
  return Math.round(minutes / granularity) * granularity;
}

function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/**
 * Minutes NOCTURNES d'une période [start, end) exprimée en minutes relatives au jour
 * de travail (bornes possibles hors [0,1440)). La plage nocturne est une propriété
 * du JOUR CIVIL : elle se répète chaque 1440 minutes.
 */
export function nightMinutesOf(period: WorkPeriod, nightStartMin: number, nightEndMin: number): number {
  if (period.endMinute <= period.startMinute) return 0;
  // Segments nocturnes du jour civil k : traversante (début > fin) → [k·1440 + début,
  // (k+1)·1440 + fin] ; sinon [k·1440 + début, k·1440 + fin].
  const crosses = nightStartMin > nightEndMin;
  let total = 0;
  const firstDay = Math.floor(period.startMinute / 1440) - 1;
  const lastDay = Math.floor((period.endMinute - 1) / 1440) + 1;
  for (let k = firstDay; k <= lastDay; k += 1) {
    const base = k * 1440;
    if (crosses) {
      total += overlap(period.startMinute, period.endMinute, base + nightStartMin, base + 1440 + nightEndMin);
    } else {
      total += overlap(period.startMinute, period.endMinute, base + nightStartMin, base + nightEndMin);
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Appariement DÉTERMINISTE — aucune heure inventée.
// ---------------------------------------------------------------------------

export interface PairingResult {
  periods: WorkPeriod[];
  firstInMinute: number | null;
  lastOutMinute: number | null;
  usedEventIds: string[];
  anomalies: PresenceAnomaly[];
  incomplete: boolean;
}

export function pairEvents(events: PresenceEvent[]): PairingResult {
  // Ordre TOTAL et stable : minute, puis type (in < unknown < out), puis id.
  const typeOrder: Record<PresenceEvent['type'], number> = { in: 0, unknown: 1, out: 2 };
  const sorted = [...events].sort((a, b) =>
    a.localMinute - b.localMinute
    || typeOrder[a.type] - typeOrder[b.type]
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const anomalies: PresenceAnomaly[] = [];
  const periods: WorkPeriod[] = [];
  const used: string[] = [];
  let open: PresenceEvent | null = null;
  let firstIn: number | null = null;
  let lastOut: number | null = null;
  const untypedCount = sorted.filter((e) => e.type === 'unknown').length;

  for (const e of sorted) {
    // Un événement non typé JOUE le rôle qu'impose l'alternance — c'est une règle
    // déterministe, pas une invention : l'heure reste la sienne.
    const actsAsIn = e.type === 'in' || (e.type === 'unknown' && open === null);
    if (actsAsIn) {
      if (open !== null) {
        anomalies.push({
          code: 'sequence_error', severity: 'warning',
          detail: 'deux entrées consécutives — la seconde est ignorée, rien n’est inventé',
          refs: { eventId: e.id, openEventId: open.id },
        });
        continue;
      }
      open = e;
      if (firstIn === null) firstIn = e.localMinute;
      continue;
    }
    // Sortie (typée ou par alternance).
    if (open === null) {
      anomalies.push({
        code: 'missing_in', severity: 'warning',
        detail: 'sortie sans entrée correspondante', refs: { eventId: e.id },
      });
      continue;
    }
    if (e.localMinute < open.localMinute) {
      anomalies.push({
        code: 'impossible_duration', severity: 'blocking',
        detail: 'sortie antérieure à l’entrée', refs: { inEventId: open.id, outEventId: e.id },
      });
      open = null;
      continue;
    }
    periods.push({ startMinute: open.localMinute, endMinute: e.localMinute });
    used.push(open.id, e.id);
    lastOut = e.localMinute;
    open = null;
  }
  if (open !== null) {
    anomalies.push({
      code: 'missing_out', severity: 'warning',
      detail: 'entrée sans sortie — la période n’est PAS comptée, aucune heure n’est inventée',
      refs: { eventId: open.id },
    });
    if (untypedCount % 2 === 1 && untypedCount === events.length) {
      anomalies.push({ code: 'odd_untyped_events', severity: 'warning', detail: `${untypedCount} événements non typés` });
    }
  }
  return {
    periods, firstInMinute: firstIn, lastOutMinute: lastOut, usedEventIds: used, anomalies,
    incomplete: anomalies.some((a) => a.code === 'missing_in' || a.code === 'missing_out'
      || a.code === 'sequence_error' || a.code === 'impossible_duration'),
  };
}

// ---------------------------------------------------------------------------
// Calcul de la journée
// ---------------------------------------------------------------------------

function zeroComputation(status: DayStatus): DayComputation {
  return {
    status, periods: [], firstInMinute: null, lastOutMinute: null,
    presenceMinutes: 0, workedMinutes: 0, breakMinutes: 0,
    lateMinutesRaw: 0, lateMinutes: 0, earlyDepartureMinutesRaw: 0, earlyDepartureMinutes: 0,
    absenceMinutes: 0, nightMinutes: 0, restDayMinutes: 0, holidayMinutes: 0,
    overtimeCandidateMinutes: 0, usedEventIds: [], anomalies: [],
    justifiedCategory: null, justifiedMinutes: 0, lateJustified: false, earlyJustified: false,
    correctionsApplied: 0,
  };
}

/**
 * Superpose les JUSTIFICATIONS approuvées sur le résultat calculé — après coup,
 * de façon déterministe (la première justification d'absence gagne, documenté) :
 *  - absence/hors-site : catégorie + minutes justifiées (bornées au manque mesuré,
 *    sauf minutes EXPLICITES de la correction) — le statut factuel ne change pas ;
 *  - retard / départ anticipé : marqués justifiés, la MESURE et le RETENU restent.
 */
function applyJustifications(out: DayComputation, corrections: DayCorrections | undefined): DayComputation {
  if (!corrections) return out;
  out.correctionsApplied = corrections.appliedCount;
  for (const j of corrections.justifications) {
    if (j.target === 'late') out.lateJustified = true;
    else if (j.target === 'early_departure') out.earlyJustified = true;
    else if ((j.target === 'absence' || j.target === 'offsite') && out.justifiedCategory === null) {
      out.justifiedCategory = j.category;
      out.justifiedMinutes = j.minutes !== undefined && j.minutes !== null
        ? Math.max(0, Math.round(j.minutes))
        : out.absenceMinutes;
    }
  }
  return out;
}

export function computeDay(input: ComputeDayInput): DayComputation {
  return applyJustifications(computeDayFacts(input), input.corrections);
}

function computeDayFacts(input: ComputeDayInput): DayComputation {
  const { planned, holiday, employment, events, params } = input;
  const anomalies: PresenceAnomaly[] = [];

  for (const e of events) {
    if (e.ambiguousTime) {
      anomalies.push({ code: 'ambiguous_local_time', severity: 'warning', refs: { eventId: e.id } });
    }
    if (e.siteMatches === false) {
      anomalies.push({ code: 'punch_other_site', severity: 'info', refs: { eventId: e.id } });
    }
  }
  if (input.hasPendingUnmatched === true) {
    anomalies.push({ code: 'unmatched_event_pending', severity: 'warning',
      detail: 'des événements non appariés pourraient concerner cette journée' });
  }

  // ---------- 1. Contexte d'emploi : prime sur tout ----------
  if (employment.notYetHired || employment.terminated || !employment.active) {
    const out = zeroComputation(employment.suspended ? 'suspended' : 'not_employed');
    out.anomalies = anomalies;
    if (events.length > 0) {
      out.anomalies.push({
        code: employment.notYetHired ? 'not_yet_hired' : employment.suspended ? 'suspended' : 'terminated',
        severity: 'blocking',
        detail: 'pointages présents alors que le salarié n’est pas en activité à cette date',
        refs: { eventIds: events.map((e) => e.id) },
      });
      out.status = employment.suspended ? 'suspended' : 'not_employed';
    }
    return out;
  }
  if (!employment.hasAssignment) {
    anomalies.push({ code: 'no_assignment', severity: 'warning' });
  }

  const pairing = pairEvents(events);
  anomalies.push(...pairing.anomalies);
  const worked = pairing.periods.reduce((s, p) => s + (p.endMinute - p.startMinute), 0);
  const night = pairing.periods.reduce((s, p) => s + nightMinutesOf(p, params.nightStartMin, params.nightEndMin), 0);
  const presence = pairing.firstInMinute !== null && pairing.lastOutMinute !== null
    ? Math.max(0, pairing.lastOutMinute - pairing.firstInMinute) : worked;
  if (presence > params.maxPresenceMin) {
    anomalies.push({ code: 'excessive_presence', severity: 'warning', detail: `${presence} minutes de présence continue` });
  }

  const base: DayComputation = {
    ...zeroComputation('present'),
    periods: pairing.periods,
    firstInMinute: pairing.firstInMinute,
    lastOutMinute: pairing.lastOutMinute,
    presenceMinutes: presence,
    workedMinutes: worked,
    nightMinutes: night,
    usedEventIds: pairing.usedEventIds,
    anomalies,
  };

  // ---------- 2. Aucun horaire applicable ----------
  if (planned === null) {
    base.status = 'not_scheduled';
    if (events.length > 0) anomalies.push({ code: 'no_schedule', severity: 'warning' });
    if (input.hasPendingUnmatched === true && events.length === 0) base.status = 'unresolved';
    return base;
  }

  // ---------- 3. Repos et fériés ----------
  const isRest = planned.isRest;
  if (isRest || holiday) {
    if (events.length > 0) {
      anomalies.push({ code: 'punch_outside_schedule', severity: 'info',
        detail: holiday ? 'pointage un jour férié' : 'pointage un jour de repos' });
    }
    if (worked > 0 || pairing.incomplete) {
      base.status = pairing.incomplete ? 'incomplete_punches' : holiday ? 'worked_public_holiday' : 'worked_rest_day';
      if (holiday) base.holidayMinutes = worked;
      else base.restDayMinutes = worked;
      // Les HS candidates d'un jour non planifié = tout le travail effectué.
      base.overtimeCandidateMinutes = roundRetained(worked, params.roundingMin);
      return base;
    }
    base.status = holiday ? 'public_holiday' : 'rest_day';
    return base;
  }

  // ---------- 4. Journée planifiée travaillée ----------
  const pStart = planned.startMinute!;
  const pEnd = planned.endMinute!;
  const plannedBreak = planned.breakStartMinute !== null && planned.breakEndMinute !== null
    ? planned.breakEndMinute - planned.breakStartMinute : 0;
  const plannedWork = (pEnd - pStart) - plannedBreak;

  if (events.length === 0) {
    base.status = input.hasPendingUnmatched === true ? 'unresolved' : 'absent';
    base.absenceMinutes = plannedWork;
    return base;
  }

  // Pauses : trous entre périodes appariées, bornés à la fenêtre de présence.
  let gaps = 0;
  for (let i = 1; i < pairing.periods.length; i += 1) {
    gaps += Math.max(0, pairing.periods[i]!.startMinute - pairing.periods[i - 1]!.endMinute);
  }
  base.breakMinutes = gaps;

  // Pause planifiée NON pointée : une période unique couvrant la pause l'inclut à
  // tort dans le travail — elle est déduite (règle documentée, paramétrable E10.3+).
  let workedAdjusted = worked;
  if (plannedBreak > 0 && gaps === 0) {
    const covering = pairing.periods.some((p) =>
      p.startMinute <= planned.breakStartMinute! && p.endMinute >= planned.breakEndMinute!);
    if (covering) {
      workedAdjusted = Math.max(0, worked - plannedBreak);
      base.breakMinutes = plannedBreak;
    }
  } else if (plannedBreak > 0 && gaps > 0 && params.minBreakMin > 0 && gaps < params.minBreakMin) {
    anomalies.push({ code: 'break_too_short', severity: 'warning',
      detail: `pause constatée ${gaps} min < minimum ${params.minBreakMin} min` });
  }
  base.workedMinutes = workedAdjusted;
  base.nightMinutes = night; // découpe sur périodes réelles (la pause déduite est diurne par convention documentée)

  if (pairing.incomplete) {
    base.status = 'incomplete_punches';
    // Le manque n'est PAS chiffré en absence : les faits sont incomplets, rien n'est inventé.
    return base;
  }

  // Retard / départ anticipé : brut mesuré, tolérance, arrondi — tout est conservé.
  const lateRaw = Math.max(0, pairing.firstInMinute! - pStart);
  const earlyRaw = Math.max(0, pEnd - pairing.lastOutMinute!);
  base.lateMinutesRaw = lateRaw;
  base.earlyDepartureMinutesRaw = earlyRaw;
  base.lateMinutes = lateRaw <= params.lateToleranceMin ? 0 : roundRetained(lateRaw, params.roundingMin);
  base.earlyDepartureMinutes = earlyRaw <= params.earlyToleranceMin ? 0 : roundRetained(earlyRaw, params.roundingMin);

  // Absence sur la plage planifiée : travail effectué DANS [début, fin] rapporté au dû.
  // C'est la mesure TOTALE du manque ; le STATUT « partielle », lui, ne se fonde que
  // sur le TROU INTÉRIEUR — la part du manque NON expliquée par le retard et le
  // départ anticipé (qui ont leurs propres statuts).
  const workedInPlanned = pairing.periods.reduce((s, p) => s + overlap(p.startMinute, p.endMinute, pStart, pEnd), 0);
  // La pause planifiée n'est déduite du travail en plage QUE dans le cas « couvrant »
  // (période unique enjambant la pause sans la pointer) — même règle que workedAdjusted.
  const workedInPlannedNet = workedAdjusted < worked
    ? Math.max(0, workedInPlanned - plannedBreak)
    : workedInPlanned;
  base.absenceMinutes = Math.max(0, plannedWork - workedInPlannedNet);
  const interiorDeficit = Math.max(0, base.absenceMinutes - Math.min(lateRaw, plannedWork) - Math.min(earlyRaw, plannedWork));

  // HS candidates : au-delà du seuil (paramètre, sinon durée planifiée) — JAMAIS un montant.
  const otThreshold = params.overtimeDailyThresholdMin ?? plannedWork;
  base.overtimeCandidateMinutes = roundRetained(Math.max(0, workedAdjusted - otThreshold), params.roundingMin);

  // Statut final.
  if (workedAdjusted < params.partialPresenceMin) {
    base.status = 'absent';
    return base;
  }
  if (interiorDeficit > params.fullDayDeficitMin) {
    base.status = 'partial_presence';
    return base;
  }
  if (base.lateMinutes > 0 && base.earlyDepartureMinutes > 0) base.status = 'late_and_early_departure';
  else if (base.lateMinutes > 0) base.status = 'late';
  else if (base.earlyDepartureMinutes > 0) base.status = 'early_departure';
  else base.status = 'present';
  return base;
}

// ---------------------------------------------------------------------------
// Catalogue des anomalies — libellés FR/EN (source unique, servie par l'API).
// ---------------------------------------------------------------------------

export const ANOMALY_CATALOG: Readonly<Record<AnomalyCode, { fr: string; en: string; defaultSeverity: AnomalySeverity }>> = {
  missing_in: { fr: 'Sortie sans entrée correspondante', en: 'Out punch without matching in', defaultSeverity: 'warning' },
  missing_out: { fr: 'Entrée sans sortie — aucune heure inventée', en: 'In punch without out — no time invented', defaultSeverity: 'warning' },
  sequence_error: { fr: 'Séquence entrée/sortie incohérente', en: 'Inconsistent in/out sequence', defaultSeverity: 'warning' },
  odd_untyped_events: { fr: 'Nombre impair d’événements non typés', en: 'Odd number of untyped events', defaultSeverity: 'warning' },
  impossible_duration: { fr: 'Durée négative ou impossible', en: 'Negative or impossible duration', defaultSeverity: 'blocking' },
  excessive_presence: { fr: 'Présence continue anormalement longue', en: 'Abnormally long continuous presence', defaultSeverity: 'warning' },
  punch_outside_schedule: { fr: 'Pointage hors journée planifiée', en: 'Punch outside planned day', defaultSeverity: 'info' },
  punch_other_site: { fr: 'Pointage sur un autre site que l’affectation', en: 'Punch on a different site than assignment', defaultSeverity: 'info' },
  no_schedule: { fr: 'Pointage sans horaire applicable', en: 'Punch without applicable schedule', defaultSeverity: 'warning' },
  no_assignment: { fr: 'Aucune affectation organisationnelle active', en: 'No active organizational assignment', defaultSeverity: 'warning' },
  not_yet_hired: { fr: 'Salarié non encore embauché à cette date', en: 'Employee not yet hired at this date', defaultSeverity: 'blocking' },
  terminated: { fr: 'Salarié ayant cessé son activité', en: 'Employee no longer active', defaultSeverity: 'blocking' },
  suspended: { fr: 'Salarié suspendu à cette date', en: 'Employee suspended at this date', defaultSeverity: 'blocking' },
  overlapping_periods: { fr: 'Chevauchement de périodes de travail', en: 'Overlapping work periods', defaultSeverity: 'warning' },
  break_too_short: { fr: 'Pause minimale non respectée', en: 'Minimum break not respected', defaultSeverity: 'warning' },
  ambiguous_local_time: { fr: 'Heure locale ambiguë (fuseau)', en: 'Ambiguous local time (timezone)', defaultSeverity: 'warning' },
  unmatched_event_pending: { fr: 'Événement non apparié en attente', en: 'Unmatched event pending', defaultSeverity: 'warning' },
  calc_failed: { fr: 'Résultat impossible à calculer', en: 'Result could not be computed', defaultSeverity: 'blocking' },
};

/** Paramètres par DÉFAUT — opérationnels et NEUTRES (aucune règle légale) : chaque
 * valeur est remplaçable par un paramètre E4 résolu à la date ; la provenance
 * (paramètre ou défaut) est consignée dans params_used du résultat. */
export const DEFAULT_PRESENCE_PARAMS: PresenceParams = {
  lateToleranceMin: 0,
  earlyToleranceMin: 0,
  matchWindowBeforeMin: 240,
  matchWindowAfterMin: 240,
  minBreakMin: 0,
  fullDayDeficitMin: 0,
  partialPresenceMin: 1,
  nightStartMin: 1320,
  nightEndMin: 360,
  roundingMin: 1,
  overtimeDailyThresholdMin: null,
  maxPresenceMin: 960,
};

/** Clés E4 (famille temps.*) consommées par le moteur — résolues À LA DATE. */
export const PRESENCE_PARAM_KEYS: Readonly<Record<string, keyof PresenceParams>> = {
  'temps.tolerance.retard': 'lateToleranceMin',
  'temps.tolerance.depart_anticipe': 'earlyToleranceMin',
  'temps.appariement.fenetre_avant': 'matchWindowBeforeMin',
  'temps.appariement.fenetre_apres': 'matchWindowAfterMin',
  'temps.pause.minimale': 'minBreakMin',
  'temps.seuil.journee_complete': 'fullDayDeficitMin',
  'temps.seuil.presence_partielle': 'partialPresenceMin',
  'temps.nuit.debut': 'nightStartMin',
  'temps.nuit.fin': 'nightEndMin',
  'temps.arrondi.minutes': 'roundingMin',
  'temps.heures_sup.seuil_jour': 'overtimeDailyThresholdMin',
  'temps.presence.maximale': 'maxPresenceMin',
};
