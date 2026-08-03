/** Tests du domaine pur E11.2 — demandes de congés (node:test, zéro dépendance). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  REQUEST_TRANSITIONS, canTransition, isEditable, isPendingDecision,
  reservationKey, releaseKey, consumptionKey, cancellationReversalKey,
  verifySubmission, hasBlocking, makeCheck, circuitFor, LEAVE_REQUEST_CIRCUITS,
  capacityAlerts, calendarLabelMode, LEAVE_REQUEST_PARAM_KEYS,
  type SubmissionFacts, type RequestStatus,
} from './leave-requests.ts';
import { canDecide } from './workflow-authz.ts';

const FACTS: SubmissionFacts = {
  quantity: 5, unit: 'open_days', startDate: '2026-09-07', submittedOn: '2026-08-20',
  employmentActive: true, suspendedDays: 0, policyFound: true,
  available: 10, projectedAtStart: 12, negativeAllowed: false, anticipationAllowed: false,
  minBlock: null, maxPerRequest: null, noticeDays: null,
  retroactiveAllowed: false, actorHasRetroPermission: false, retroReason: null, depositDelayDays: null,
  justificationRequired: false, attachmentCount: 0,
  overlappingRequests: 0, overlappingAbsences: 0, closedPeriodsCovered: 0, payrollExportsCovered: 0,
  halfDayAsked: false, hoursAsked: null, plannedHoursOnDay: null,
  confirmationRequired: false, confirmed: false,
};

describe('machine à états des demandes', () => {
  it('draft ne saute jamais à applied ; le chemin nominal passe par la soumission', () => {
    assert.equal(canTransition('draft', 'applied' as RequestStatus), false);
    assert.equal(canTransition('draft', 'submitted'), true);
    assert.equal(canTransition('submitted', 'in_review'), true);
    assert.equal(canTransition('in_review', 'approved_pending_application'), true);
    assert.equal(canTransition('approved_pending_application', 'applied'), true);
  });
  it('un échec d\'application CONSERVE l\'approbation et permet la reprise', () => {
    assert.equal(canTransition('approved_pending_application', 'application_failed'), true);
    assert.equal(canTransition('application_failed', 'applied'), true);
    assert.equal(canTransition('application_failed', 'rejected' as RequestStatus), false);
  });
  it('états terminaux : rejeté, annulé, expiré ne bougent plus ; applied ne bouge que vers cancelled (circuit dédié)', () => {
    assert.deepEqual(REQUEST_TRANSITIONS.rejected, []);
    assert.deepEqual(REQUEST_TRANSITIONS.cancelled, []);
    assert.deepEqual(REQUEST_TRANSITIONS.expired, []);
    assert.deepEqual(REQUEST_TRANSITIONS.applied, ['cancelled']);
  });
  it('éditable UNIQUEMENT avant gel (draft, returned) ; décision attendue en submitted/in_review', () => {
    assert.equal(isEditable('draft'), true);
    assert.equal(isEditable('returned'), true);
    assert.equal(isEditable('submitted'), false);
    assert.equal(isPendingDecision('submitted'), true);
    assert.equal(isPendingDecision('in_review'), true);
    assert.equal(isPendingDecision('approved'), false);
  });
});

describe('clés d\'idempotence', () => {
  it('une clé par (demande, version, nature) — stable et distincte', () => {
    assert.equal(reservationKey('r1', 1), 'reserve:r1:1');
    assert.equal(releaseKey('r1', 1), 'release:r1:1');
    assert.equal(consumptionKey('r1', 1), 'consume:r1:1');
    assert.equal(cancellationReversalKey('r1', 1), 'cancelrev:r1:1');
    const all = new Set([reservationKey('r1', 1), releaseKey('r1', 1), consumptionKey('r1', 1),
      cancellationReversalKey('r1', 1), reservationKey('r1', 2)]);
    assert.equal(all.size, 5);
  });
});

describe('vérifications de soumission', () => {
  it('cas nominal : aucune erreur, aucun avertissement', () => {
    assert.deepEqual(verifySubmission(FACTS), []);
  });
  it('solde insuffisant sans négatif ⇒ ERREUR chiffrée', () => {
    const checks = verifySubmission({ ...FACTS, quantity: 12 });
    assert.equal(checks.length, 1);
    assert.equal(checks[0]!.code, 'balance_insufficient');
    assert.equal(checks[0]!.level, 'error');
    assert.equal(checks[0]!.detail!['disponible'], 10);
    assert.ok(hasBlocking(checks));
  });
  it('négatif PERMIS par le type ⇒ avertissement, jamais silencieux', () => {
    const checks = verifySubmission({ ...FACTS, quantity: 12, negativeAllowed: true });
    assert.deepEqual(checks.map((c) => [c.code, c.level]), [['negative_used', 'warning']]);
  });
  it('anticipation bornée par la PROJECTION ; au-delà, erreur', () => {
    const ok = verifySubmission({ ...FACTS, quantity: 12, anticipationAllowed: true });
    assert.deepEqual(ok.map((c) => c.code), ['anticipation_bounded']);
    const ko = verifySubmission({ ...FACTS, quantity: 13, anticipationAllowed: true });
    assert.deepEqual(ko.map((c) => c.code), ['balance_insufficient']);
  });
  it('préavis : compté en jours francs contre la date de soumission', () => {
    const ko = verifySubmission({ ...FACTS, noticeDays: 30 });
    assert.deepEqual(ko.map((c) => c.code), ['notice_days']);
    assert.equal(ko[0]!.detail!['donne'], 18);
    const ok = verifySubmission({ ...FACTS, noticeDays: 15 });
    assert.deepEqual(ok, []);
  });
  it('rétroactif : type + permission + motif exigés ensemble ; délai de dépôt borné', () => {
    const past = { ...FACTS, startDate: '2026-08-01' };
    const codes = verifySubmission(past).map((c) => c.code).sort();
    assert.deepEqual(codes, ['retroactive_forbidden', 'retroactive_permission', 'retroactive_reason']);
    const armed = verifySubmission({
      ...past, retroactiveAllowed: true, actorHasRetroPermission: true, retroReason: 'certificat reçu tard',
    });
    assert.deepEqual(armed, []);
    const late = verifySubmission({
      ...past, retroactiveAllowed: true, actorHasRetroPermission: true, retroReason: 'x'.repeat(5),
      depositDelayDays: 10,
    });
    assert.deepEqual(late.map((c) => c.code), ['deposit_delay']);
  });
  it('période close couverte ⇒ AVERTISSEMENT explicite (jamais un impact silencieux) + export paie signalé', () => {
    const checks = verifySubmission({
      ...FACTS, startDate: '2026-07-06', retroactiveAllowed: true, actorHasRetroPermission: true,
      retroReason: 'régularisation', closedPeriodsCovered: 1, payrollExportsCovered: 1,
    });
    assert.deepEqual(checks.map((c) => [c.code, c.level]),
      [['closed_period', 'warning'], ['payroll_export_exists', 'warning']]);
    assert.equal(hasBlocking(checks), false);
  });
  it('justificatif requis sans pièce, chevauchements, décompte nul : erreurs distinctes', () => {
    const checks = verifySubmission({
      ...FACTS, quantity: 0, justificationRequired: true,
      overlappingRequests: 1, overlappingAbsences: 2,
    });
    assert.deepEqual(checks.map((c) => c.code).sort(),
      ['justification_required', 'overlap_absence', 'overlap_request', 'quantity_zero']);
  });
  it('bornes : min_block, max_per_request, demi-journée, volume d\'heures', () => {
    assert.deepEqual(verifySubmission({ ...FACTS, quantity: 0.5, minBlock: 1 }).map((c) => c.code), ['min_block']);
    assert.deepEqual(verifySubmission({ ...FACTS, quantity: 20, available: 30, maxPerRequest: 15 }).map((c) => c.code), ['max_per_request']);
    assert.deepEqual(verifySubmission({ ...FACTS, halfDayAsked: true, minBlock: 1 }).map((c) => c.code), ['half_day_not_allowed']);
    assert.deepEqual(verifySubmission({ ...FACTS, halfDayAsked: true, minBlock: 0.5 }), []);
    assert.deepEqual(verifySubmission({ ...FACTS, unit: 'hours', hoursAsked: 9, plannedHoursOnDay: 8 }).map((c) => c.code), ['hours_bounds']);
    assert.deepEqual(verifySubmission({ ...FACTS, unit: 'hours', hoursAsked: 4, plannedHoursOnDay: 8 }), []);
  });
  it('demande pour tiers : la confirmation exigée bloque tant qu\'elle manque', () => {
    assert.deepEqual(verifySubmission({ ...FACTS, confirmationRequired: true }).map((c) => c.code), ['confirmation_missing']);
    assert.deepEqual(verifySubmission({ ...FACTS, confirmationRequired: true, confirmed: true }), []);
  });
  it('chaque contrôle est localisé FR et EN', () => {
    const c = makeCheck('closed_period', 'warning');
    assert.ok(c.fr.length > 10 && c.en.length > 10 && c.fr !== c.en);
  });
});

describe('circuits E3', () => {
  it('précédence fermée : rétroactif > confidentiel > standard ; annulation distincte', () => {
    assert.equal(circuitFor({ retroactive: false, confidential: false }), 'conges_demande');
    assert.equal(circuitFor({ retroactive: false, confidential: true }), 'conges_demande_sensible');
    assert.equal(circuitFor({ retroactive: true, confidential: true }), 'conges_demande_retro');
    assert.equal(LEAVE_REQUEST_CIRCUITS.cancellation, 'conges_annulation');
  });
});

describe('séparation des tâches (E3 — exclusion de contexte)', () => {
  const step = { index: 0, name: 'Manager', approverType: 'role' as const, approverRef: 'mgr' };
  it('le bénéficiaire listé dans excludedDeciderUserIds ne décide pas, même assigné', () => {
    const d = canDecide(
      { userId: 'u-benef', roleKeys: ['mgr'], scopes: [] },
      { step, instanceContext: { excludedDeciderUserIds: ['u-benef'] }, createdBy: 'u-mgr' },
    );
    assert.equal(d.allowed, false);
    if (!d.allowed) assert.match(d.reason, /séparation des tâches/);
  });
  it('un tiers assigné hors liste décide normalement ; contexte absent = comportement inchangé', () => {
    const ok = canDecide(
      { userId: 'u-rh', roleKeys: ['mgr'], scopes: [] },
      { step, instanceContext: { excludedDeciderUserIds: ['u-benef'] }, createdBy: 'u-mgr' },
    );
    assert.equal(ok.allowed, true);
    const legacy = canDecide(
      { userId: 'u-rh', roleKeys: ['mgr'], scopes: [] },
      { step, instanceContext: {}, createdBy: 'u-mgr' },
    );
    assert.equal(legacy.allowed, true);
  });
});

describe('capacité d\'équipe', () => {
  const days = [
    { date: '2026-09-07', headcount: 10, approvedAbsent: 3, pendingAbsent: 0 },
    { date: '2026-09-08', headcount: 10, approvedAbsent: 2, pendingAbsent: 3 },
    { date: '2026-09-09', headcount: 10, approvedAbsent: 0, pendingAbsent: 0 },
  ];
  it('sous le seuil avec les approuvées = alerte ; seulement avec les en-attente = risque', () => {
    const alerts = capacityAlerts(days, 8);
    assert.deepEqual(alerts, [
      { date: '2026-09-07', present: 7, minPresence: 8, level: 'alert' },
      { date: '2026-09-08', present: 5, minPresence: 8, level: 'risk' },
    ]);
  });
  it('seuil absent (paramètre E4 non posé) ⇒ AUCUNE alerte inventée', () => {
    assert.deepEqual(capacityAlerts(days, null), []);
    assert.deepEqual(capacityAlerts(days, 0), []);
  });
});

describe('visibilité calendrier', () => {
  it('confidentiel : « indisponible » sans permission sensible, détail avec', () => {
    assert.equal(calendarLabelMode({ confidential: true, viewerHasSensitive: false, viewerHasTypedView: true }), 'unavailable');
    assert.equal(calendarLabelMode({ confidential: true, viewerHasSensitive: true, viewerHasTypedView: true }), 'detail');
  });
  it('non confidentiel : détail avec la vue typée, générique sinon', () => {
    assert.equal(calendarLabelMode({ confidential: false, viewerHasSensitive: false, viewerHasTypedView: true }), 'detail');
    assert.equal(calendarLabelMode({ confidential: false, viewerHasSensitive: false, viewerHasTypedView: false }), 'generic');
  });
});

describe('paramètres E4 du module demandes', () => {
  it('clés dottées minuscules, catalogue fermé', () => {
    for (const k of LEAVE_REQUEST_PARAM_KEYS) assert.match(k, /^[a-z0-9]+(\.[a-z0-9_]+)+$/);
    assert.equal(new Set(LEAVE_REQUEST_PARAM_KEYS).size, LEAVE_REQUEST_PARAM_KEYS.length);
  });
});
