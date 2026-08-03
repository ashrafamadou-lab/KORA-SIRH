/**
 * E11.2 — Demandes de congés : domaine PUR (aucune E/S).
 *
 * Ici vivent : la machine à états des demandes (miroir exact du trigger SQL —
 * les deux bancs se testent mutuellement), les clés d'idempotence des mouvements
 * liés à une demande, les VÉRIFICATIONS de soumission (erreurs localisées FR/EN,
 * jamais un booléen muet), le choix du circuit E3, la capacité d'équipe et les
 * niveaux de visibilité du calendrier. Aucune valeur légale ici : préavis,
 * plafonds et seuils arrivent RÉSOLUS (politiques versionnées + paramètres E4
 * à la date du fait générateur) — ce module ne fait que les appliquer.
 */

export const LEAVE_REQUESTS_ENGINE_VERSION = 'kora-leave-req-1.0.0';

export type RequestStatus =
  | 'draft' | 'submitted' | 'in_review' | 'returned' | 'approved' | 'rejected'
  | 'cancelled' | 'approved_pending_application' | 'applied' | 'application_failed' | 'expired';

/** Miroir du trigger leave.guard_request_update — SEULES transitions permises. */
export const REQUEST_TRANSITIONS: Readonly<Record<RequestStatus, readonly RequestStatus[]>> = {
  draft: ['submitted', 'cancelled'],
  submitted: ['in_review', 'returned', 'approved', 'approved_pending_application', 'rejected', 'cancelled', 'expired'],
  in_review: ['returned', 'approved', 'approved_pending_application', 'rejected', 'cancelled', 'expired'],
  returned: ['submitted', 'cancelled', 'expired'],
  approved: ['applied', 'application_failed'],
  approved_pending_application: ['applied', 'application_failed'],
  application_failed: ['applied', 'cancelled'],
  applied: ['cancelled'],
  rejected: [],
  cancelled: [],
  expired: [],
};

export function canTransition(from: RequestStatus, to: RequestStatus): boolean {
  return (REQUEST_TRANSITIONS[from] ?? []).includes(to);
}

/** États où le contenu du brouillon reste éditable (avant gel par soumission). */
export function isEditable(status: RequestStatus): boolean {
  return status === 'draft' || status === 'returned';
}

/** États « vivants » côté approbation (une décision est attendue). */
export function isPendingDecision(status: RequestStatus): boolean {
  return status === 'submitted' || status === 'in_review';
}

// ---------------------------------------------------------------------------
// Clés d'idempotence : la base (UNIQUE tenant+clé) rend chaque mouvement unique.
// Une clé par (demande, version, nature) — le rejeu est inerte PAR CONSTRUCTION.
// ---------------------------------------------------------------------------
export function reservationKey(requestId: string, version: number): string {
  return `reserve:${requestId}:${version}`;
}
export function releaseKey(requestId: string, version: number): string {
  return `release:${requestId}:${version}`;
}
export function consumptionKey(requestId: string, version: number): string {
  return `consume:${requestId}:${version}`;
}
/** Annulation APRÈS application : reversement de la consommation. */
export function cancellationReversalKey(requestId: string, version: number): string {
  return `cancelrev:${requestId}:${version}`;
}

// ---------------------------------------------------------------------------
// Vérifications de soumission — catalogue FERMÉ, localisé FR/EN par le compilateur.
// ---------------------------------------------------------------------------
export type CheckCode =
  | 'employment_inactive'        // pas d'emploi actif sur la période
  | 'employment_suspended'       // suspension sur la période
  | 'policy_missing'             // aucune politique applicable
  | 'balance_insufficient'       // solde disponible < quantité (négatif interdit)
  | 'anticipation_bounded'       // négatif couvert par la projection (anticipation)
  | 'negative_used'              // solde négatif utilisé (permis par le type)
  | 'quantity_zero'              // décompte nul (aucun jour décompté)
  | 'min_block'                  // sous la consommation minimale
  | 'max_per_request'            // au-dessus du maximum par demande
  | 'notice_days'                // préavis insuffisant
  | 'retroactive_forbidden'      // rétroactif interdit pour ce type
  | 'retroactive_permission'     // permission rétroactive requise
  | 'retroactive_reason'         // motif rétroactif obligatoire
  | 'deposit_delay'              // délai de dépôt dépassé (rétroactif borné)
  | 'justification_required'     // justificatif exigé, absent
  | 'overlap_request'            // chevauche une autre demande vivante
  | 'overlap_absence'            // chevauche une absence approuvée
  | 'closed_period'              // période de présence verrouillée/close couverte
  | 'payroll_export_exists'      // un export paie couvre déjà la période
  | 'half_day_not_allowed'       // demi-journée hors politique
  | 'hours_bounds'               // volume d'heures hors bornes de la journée
  | 'confirmation_missing';      // confirmation du salarié requise (demande pour tiers)

export type CheckLevel = 'error' | 'warning';

export interface CheckItem {
  code: CheckCode;
  level: CheckLevel;
  fr: string;
  en: string;
  detail?: Record<string, string | number | boolean>;
}

const CHECK_TEXTS: Readonly<Record<CheckCode, { fr: string; en: string }>> = {
  employment_inactive: { fr: 'aucun emploi actif sur toute la période demandée', en: 'no active employment over the requested period' },
  employment_suspended: { fr: 'contrat suspendu sur une partie de la période', en: 'contract suspended over part of the period' },
  policy_missing: { fr: 'aucune politique applicable à ce type à cette date', en: 'no applicable policy for this type at this date' },
  balance_insufficient: { fr: 'solde disponible insuffisant', en: 'insufficient available balance' },
  anticipation_bounded: { fr: 'anticipation : couverte par les acquisitions projetées (conditionnelles)', en: 'anticipation: covered by projected accruals (conditional)' },
  negative_used: { fr: 'solde négatif utilisé (permis pour ce type)', en: 'negative balance used (allowed for this type)' },
  quantity_zero: { fr: 'aucune unité décomptée sur la période (repos, fériés…)', en: 'no units counted over the period (rest days, holidays…)' },
  min_block: { fr: 'durée sous la consommation minimale de la politique', en: 'duration below the policy minimum block' },
  max_per_request: { fr: 'durée au-dessus du maximum par demande', en: 'duration above the per-request maximum' },
  notice_days: { fr: 'préavis insuffisant', en: 'insufficient notice' },
  retroactive_forbidden: { fr: 'demande rétroactive interdite pour ce type', en: 'retroactive request forbidden for this type' },
  retroactive_permission: { fr: 'permission requise pour une demande rétroactive', en: 'permission required for a retroactive request' },
  retroactive_reason: { fr: 'motif obligatoire pour une demande rétroactive', en: 'reason required for a retroactive request' },
  deposit_delay: { fr: 'délai de dépôt dépassé pour ce type', en: 'deposit delay exceeded for this type' },
  justification_required: { fr: 'justificatif exigé pour ce type — aucune pièce jointe', en: 'supporting document required for this type — none attached' },
  overlap_request: { fr: 'chevauche une autre demande en cours', en: 'overlaps another live request' },
  overlap_absence: { fr: 'chevauche une absence déjà approuvée', en: 'overlaps an already approved absence' },
  closed_period: { fr: 'la période de présence couverte est verrouillée ou close — circuit renforcé, aucun impact automatique', en: 'the covered presence period is locked or closed — reinforced circuit, no automatic impact' },
  payroll_export_exists: { fr: 'un export de préparation paie couvre déjà cette période', en: 'a payroll preparation export already covers this period' },
  half_day_not_allowed: { fr: 'demi-journée non permise par la politique applicable', en: 'half-day not allowed by the applicable policy' },
  hours_bounds: { fr: "volume d'heures hors des bornes de la journée planifiée", en: 'hour amount outside the planned day bounds' },
  confirmation_missing: { fr: 'confirmation du salarié requise avant soumission (demande pour un tiers)', en: 'employee confirmation required before submission (request on behalf)' },
};

export function makeCheck(code: CheckCode, level: CheckLevel, detail?: CheckItem['detail']): CheckItem {
  const t = CHECK_TEXTS[code];
  return detail ? { code, level, fr: t.fr, en: t.en, detail } : { code, level, fr: t.fr, en: t.en };
}

export interface SubmissionFacts {
  /** Quantité décomptée côté SERVEUR (jamais celle du client). */
  quantity: number;
  unit: 'open_days' | 'working_days' | 'calendar_days' | 'half_days' | 'hours';
  startDate: string;               // AAAA-MM-JJ
  submittedOn: string;             // date du jour côté serveur
  employmentActive: boolean;
  suspendedDays: number;
  policyFound: boolean;
  available: number | null;        // solde disponible (null = politique absente)
  projectedAtStart: number | null; // disponible + acquisitions projetées à la date de début
  negativeAllowed: boolean;
  anticipationAllowed: boolean;
  minBlock: number | null;
  maxPerRequest: number | null;
  noticeDays: number | null;
  retroactiveAllowed: boolean;
  actorHasRetroPermission: boolean;
  retroReason: string | null;
  depositDelayDays: number | null;
  justificationRequired: boolean;
  attachmentCount: number;
  overlappingRequests: number;
  overlappingAbsences: number;
  closedPeriodsCovered: number;
  payrollExportsCovered: number;
  halfDayAsked: boolean;
  hoursAsked: number | null;
  plannedHoursOnDay: number | null;
  confirmationRequired: boolean;
  confirmed: boolean;
}

/**
 * Vérifications de soumission (§5) : TOUT est explicite, localisé, niveau par
 * niveau. Les erreurs bloquent ; les avertissements accompagnent la demande
 * (figés dans la version soumise) et orientent le circuit.
 */
export function verifySubmission(f: SubmissionFacts): CheckItem[] {
  const out: CheckItem[] = [];
  if (!f.employmentActive) out.push(makeCheck('employment_inactive', 'error'));
  if (f.suspendedDays > 0) out.push(makeCheck('employment_suspended', 'error', { jours: f.suspendedDays }));
  if (!f.policyFound) out.push(makeCheck('policy_missing', 'error'));
  if (f.quantity === 0) out.push(makeCheck('quantity_zero', 'error'));

  if (f.policyFound && f.available !== null && f.quantity > f.available) {
    const deficit = round3(f.quantity - f.available);
    if (f.negativeAllowed) {
      out.push(makeCheck('negative_used', 'warning', { deficit }));
    } else if (f.anticipationAllowed && f.projectedAtStart !== null && f.quantity <= f.projectedAtStart) {
      out.push(makeCheck('anticipation_bounded', 'warning', { deficit, projete: f.projectedAtStart }));
    } else {
      out.push(makeCheck('balance_insufficient', 'error', { disponible: f.available ?? 0, demande: f.quantity }));
    }
  }
  if (f.minBlock !== null && f.quantity > 0 && f.quantity < f.minBlock) {
    out.push(makeCheck('min_block', 'error', { minimum: f.minBlock }));
  }
  if (f.maxPerRequest !== null && f.quantity > f.maxPerRequest) {
    out.push(makeCheck('max_per_request', 'error', { maximum: f.maxPerRequest }));
  }

  const retro = f.startDate < f.submittedOn;
  if (!retro && f.noticeDays !== null && f.noticeDays > 0) {
    const given = daysBetween(f.submittedOn, f.startDate);
    if (given < f.noticeDays) out.push(makeCheck('notice_days', 'error', { exige: f.noticeDays, donne: given }));
  }
  if (retro) {
    if (!f.retroactiveAllowed) out.push(makeCheck('retroactive_forbidden', 'error'));
    if (!f.actorHasRetroPermission) out.push(makeCheck('retroactive_permission', 'error'));
    if (!f.retroReason || f.retroReason.trim().length < 3) out.push(makeCheck('retroactive_reason', 'error'));
    if (f.depositDelayDays !== null && daysBetween(f.startDate, f.submittedOn) > f.depositDelayDays) {
      out.push(makeCheck('deposit_delay', 'error', { delai: f.depositDelayDays }));
    }
    if (f.closedPeriodsCovered > 0) out.push(makeCheck('closed_period', 'warning', { periodes: f.closedPeriodsCovered }));
    if (f.payrollExportsCovered > 0) out.push(makeCheck('payroll_export_exists', 'warning', { exports: f.payrollExportsCovered }));
  }

  if (f.justificationRequired && f.attachmentCount === 0) {
    out.push(makeCheck('justification_required', 'error'));
  }
  if (f.overlappingRequests > 0) out.push(makeCheck('overlap_request', 'error', { demandes: f.overlappingRequests }));
  if (f.overlappingAbsences > 0) out.push(makeCheck('overlap_absence', 'error', { absences: f.overlappingAbsences }));

  if (f.halfDayAsked && f.unit !== 'half_days' && (f.minBlock === null || f.minBlock > 0.5)) {
    out.push(makeCheck('half_day_not_allowed', 'error'));
  }
  if (f.hoursAsked !== null) {
    if (f.plannedHoursOnDay === null || f.hoursAsked > f.plannedHoursOnDay || f.hoursAsked <= 0) {
      out.push(makeCheck('hours_bounds', 'error', { planifie: f.plannedHoursOnDay ?? 0 }));
    }
  }
  if (f.confirmationRequired && !f.confirmed) out.push(makeCheck('confirmation_missing', 'error'));
  return out;
}

export function hasBlocking(checks: readonly CheckItem[]): boolean {
  return checks.some((c) => c.level === 'error');
}

// ---------------------------------------------------------------------------
// Circuit E3 : précédence FERMÉE et documentée — rétroactif > confidentiel > standard.
// La configurabilité fine (durée, société, population…) vit dans les CONDITIONS
// d'étapes E3, alimentées par le contexte d'instance.
// ---------------------------------------------------------------------------
export const LEAVE_REQUEST_CIRCUITS = {
  standard: 'conges_demande',
  sensitive: 'conges_demande_sensible',
  retroactive: 'conges_demande_retro',
  cancellation: 'conges_annulation',
} as const;

export function circuitFor(input: { retroactive: boolean; confidential: boolean }): string {
  if (input.retroactive) return LEAVE_REQUEST_CIRCUITS.retroactive;
  if (input.confidential) return LEAVE_REQUEST_CIRCUITS.sensitive;
  return LEAVE_REQUEST_CIRCUITS.standard;
}

// ---------------------------------------------------------------------------
// Capacité d'équipe (§9) : un CALCUL, jamais une règle légale — le seuil vient
// d'un paramètre E4 versionné ; absent, aucune alerte n'est inventée.
// ---------------------------------------------------------------------------
export interface CapacityDay {
  date: string;
  headcount: number;        // effectif planifié du périmètre ce jour
  approvedAbsent: number;   // absences approuvées
  pendingAbsent: number;    // demandes en attente (si visibles)
}

export interface CapacityAlert {
  date: string;
  present: number;          // effectif restant si tout est approuvé
  minPresence: number;
  level: 'alert' | 'risk';  // alert = approuvées seules ; risk = avec les en-attente
}

export function capacityAlerts(days: readonly CapacityDay[], minPresence: number | null): CapacityAlert[] {
  if (minPresence === null || minPresence <= 0) return [];
  const out: CapacityAlert[] = [];
  for (const d of days) {
    const afterApproved = d.headcount - d.approvedAbsent;
    const afterAll = afterApproved - d.pendingAbsent;
    if (afterApproved < minPresence) {
      out.push({ date: d.date, present: afterApproved, minPresence, level: 'alert' });
    } else if (afterAll < minPresence) {
      out.push({ date: d.date, present: afterAll, minPresence, level: 'risk' });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Visibilité calendrier (§10) : le type ne se montre qu'aux vues autorisées ;
// un type CONFIDENTIEL n'est jamais plus précis qu'« indisponible » sans la
// permission sensible. Niveaux : detail (code+libellé) > generic > unavailable.
// ---------------------------------------------------------------------------
export type CalendarLabelMode = 'detail' | 'generic' | 'unavailable';

export function calendarLabelMode(input: {
  confidential: boolean;
  viewerHasSensitive: boolean;
  viewerHasTypedView: boolean;   // leave.calendar_view (types non confidentiels visibles)
}): CalendarLabelMode {
  if (input.confidential) {
    return input.viewerHasSensitive ? 'detail' : 'unavailable';
  }
  return input.viewerHasTypedView ? 'detail' : 'generic';
}

// ---------------------------------------------------------------------------
// Utilitaires locaux
// ---------------------------------------------------------------------------
function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000);
}
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Paramètres E4 propres aux demandes (résolus à la date du fait générateur). */
export const LEAVE_REQUEST_PARAM_KEYS = [
  'conges.demande.delai_traitement_jours',   // suivi des délais d'instruction (RH)
  'conges.demande.confirmation_salarie',     // 1 = une demande pour tiers exige la confirmation du salarié
  'conges.equipe.presence_minimale',         // seuil interne d'alerte de capacité (jamais une règle légale)
] as const;
