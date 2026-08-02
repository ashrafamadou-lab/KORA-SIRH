/**
 * E10.2 — moteur de présence pur : appariement déterministe SANS invention,
 * nuits traversant minuit, tolérances/arrondis (bruts conservés), statuts dérivés
 * des faits, HS candidates sans montant, anomalies du catalogue.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANOMALY_CATALOG,
  computeDay,
  DEFAULT_PRESENCE_PARAMS,
  nightMinutesOf,
  pairEvents,
  PRESENCE_PARAM_KEYS,
  roundRetained,
  type ComputeDayInput,
  type PresenceEvent,
} from './presence.ts';

const P = DEFAULT_PRESENCE_PARAMS;
const EMPLOYED = { active: true, notYetHired: false, terminated: false, suspended: false, hasAssignment: true };
const DAY_8_17 = { isRest: false, startMinute: 480, endMinute: 1020, breakStartMinute: 720, breakEndMinute: 780 };
const NIGHT_22_06 = { isRest: false, startMinute: 1320, endMinute: 1800, breakStartMinute: null, breakEndMinute: null };

let seq = 0;
function ev(localMinute: number, type: 'in' | 'out' | 'unknown' = 'unknown', extra: Partial<PresenceEvent> = {}): PresenceEvent {
  seq += 1;
  return { id: `e${String(seq).padStart(3, '0')}`, localMinute, type, siteMatches: true, ambiguousTime: false, ...extra };
}
function day(input: Partial<ComputeDayInput>): ReturnType<typeof computeDay> {
  return computeDay({ planned: DAY_8_17, holiday: false, employment: EMPLOYED, events: [], params: P, ...input });
}

// ---------------------------------------------------------------------------
// Appariement
// ---------------------------------------------------------------------------

test('paire simple typée : une période, premiers/derniers retenus', () => {
  const r = pairEvents([ev(480, 'in'), ev(1020, 'out')]);
  assert.deepEqual(r.periods, [{ startMinute: 480, endMinute: 1020 }]);
  assert.equal(r.firstInMinute, 480);
  assert.equal(r.lastOutMinute, 1020);
  assert.equal(r.incomplete, false);
  assert.deepEqual(r.anomalies, []);
});

test('plusieurs entrées/sorties + pause pointée : DEUX périodes, ordre déterministe', () => {
  const r = pairEvents([ev(780, 'in'), ev(480, 'in'), ev(720, 'out'), ev(1020, 'out')]);
  assert.deepEqual(r.periods, [
    { startMinute: 480, endMinute: 720 },
    { startMinute: 780, endMinute: 1020 },
  ]);
  assert.equal(r.incomplete, false);
});

test('événements NON TYPÉS : alternance déterministe, jamais d’heure inventée', () => {
  const r = pairEvents([ev(480), ev(720), ev(780), ev(1020)]);
  assert.equal(r.periods.length, 2);
  const odd = pairEvents([ev(480), ev(720), ev(780)]);
  assert.equal(odd.periods.length, 1, 'seule la paire complète est comptée');
  assert.ok(odd.anomalies.some((a) => a.code === 'missing_out'));
  assert.ok(odd.anomalies.some((a) => a.code === 'odd_untyped_events'));
  assert.equal(odd.incomplete, true);
});

test('sortie manquante : anomalie, période NON comptée — rien n’est inventé', () => {
  const r = pairEvents([ev(480, 'in')]);
  assert.equal(r.periods.length, 0);
  assert.equal(r.firstInMinute, 480, 'la première entrée reste un FAIT retenu');
  assert.equal(r.lastOutMinute, null);
  assert.ok(r.anomalies.some((a) => a.code === 'missing_out'));
});

test('entrée manquante et séquences incohérentes : anomalies dédiées', () => {
  const noIn = pairEvents([ev(1020, 'out')]);
  assert.ok(noIn.anomalies.some((a) => a.code === 'missing_in'));
  const dblIn = pairEvents([ev(480, 'in'), ev(500, 'in'), ev(1020, 'out')]);
  assert.ok(dblIn.anomalies.some((a) => a.code === 'sequence_error'));
  assert.deepEqual(dblIn.periods, [{ startMinute: 480, endMinute: 1020 }], 'la PREMIÈRE entrée fait foi');
});

test('sortie typée ANTÉRIEURE à l’entrée : le tri TOTAL neutralise — anomalies franches, zéro période', () => {
  // Après ordre total, la « sortie à 08:20 / entrée à 10:00 » devient : OUT sans IN,
  // puis IN sans OUT — deux anomalies, aucune durée négative POSSIBLE, rien d'inventé.
  const r = pairEvents([ev(600, 'in'), ev(500, 'out')]);
  assert.equal(r.periods.length, 0);
  assert.ok(r.anomalies.some((a) => a.code === 'missing_in'));
  assert.ok(r.anomalies.some((a) => a.code === 'missing_out'));
  assert.equal(r.incomplete, true);
});

// ---------------------------------------------------------------------------
// Nuits
// ---------------------------------------------------------------------------

test('nuit 22:00→06:00 : période 1320→1800 entièrement nocturne (480 min)', () => {
  assert.equal(nightMinutesOf({ startMinute: 1320, endMinute: 1800 }, 1320, 360), 480);
});

test('période partiellement nocturne et bornes exactes', () => {
  assert.equal(nightMinutesOf({ startMinute: 1200, endMinute: 1440 }, 1320, 360), 120); // 20:00→24:00
  assert.equal(nightMinutesOf({ startMinute: 300, endMinute: 780 }, 1320, 360), 60);    // 05:00→13:00
  assert.equal(nightMinutesOf({ startMinute: 360, endMinute: 1320 }, 1320, 360), 0);    // pile diurne
});

test('sortie APRÈS minuit du lendemain : chaque jour civil porte sa plage nocturne', () => {
  // 21:00 → 07:30 le lendemain = 23:00-06:00... : nuit = [1320,1800] ∩ [1260,1890] = 480
  assert.equal(nightMinutesOf({ startMinute: 1260, endMinute: 1890 }, 1320, 360), 480);
  // Plage nocturne SANS traversée (0h-5h) : 23:00→02:00 → 120 min.
  assert.equal(nightMinutesOf({ startMinute: 1380, endMinute: 1560 }, 0, 300), 120);
});

// ---------------------------------------------------------------------------
// Journées complètes
// ---------------------------------------------------------------------------

test('journée nominale 8h-17h avec pause pointée : present, durées exactes', () => {
  const r = day({ events: [ev(480, 'in'), ev(720, 'out'), ev(780, 'in'), ev(1020, 'out')] });
  assert.equal(r.status, 'present');
  assert.equal(r.workedMinutes, 480);
  assert.equal(r.breakMinutes, 60);
  assert.equal(r.presenceMinutes, 540);
  assert.equal(r.absenceMinutes, 0);
  assert.equal(r.lateMinutes, 0);
  assert.equal(r.overtimeCandidateMinutes, 0);
});

test('pause planifiée NON pointée : déduite du travail (règle documentée)', () => {
  const r = day({ events: [ev(480, 'in'), ev(1020, 'out')] });
  assert.equal(r.workedMinutes, 480, '540 de présence - 60 de pause planifiée');
  assert.equal(r.breakMinutes, 60);
  assert.equal(r.status, 'present');
});

test('retard : brut MESURÉ conservé, tolérance ⇒ zéro minute retenue', () => {
  const tol = { ...P, lateToleranceMin: 10 };
  const inTol = day({ params: tol, events: [ev(488, 'in'), ev(720, 'out'), ev(780, 'in'), ev(1020, 'out')] });
  assert.equal(inTol.lateMinutesRaw, 8, 'le fait mesuré reste');
  assert.equal(inTol.lateMinutes, 0, 'dans la tolérance ⇒ rien de retenu');
  assert.equal(inTol.status, 'present');
  const outTol = day({ params: tol, events: [ev(495, 'in'), ev(720, 'out'), ev(780, 'in'), ev(1020, 'out')] });
  assert.equal(outTol.lateMinutesRaw, 15);
  assert.equal(outTol.lateMinutes, 15);
  assert.equal(outTol.status, 'late');
});

test('arrondi sur la valeur RETENUE seulement, brut intact', () => {
  const r5 = { ...P, roundingMin: 5 };
  const r = day({ params: r5, events: [ev(492, 'in'), ev(720, 'out'), ev(780, 'in'), ev(1020, 'out')] });
  assert.equal(r.lateMinutesRaw, 12);
  assert.equal(r.lateMinutes, 10, 'arrondi à 5 min au plus proche');
  assert.equal(roundRetained(13, 5), 15);
  assert.equal(roundRetained(12, 1), 12, 'granularité 1 = aucun arrondi');
});

test('départ anticipé et cumul retard+départ', () => {
  const r = day({ events: [ev(500, 'in'), ev(720, 'out'), ev(780, 'in'), ev(1000, 'out')] });
  assert.equal(r.status, 'late_and_early_departure');
  assert.equal(r.lateMinutes, 20);
  assert.equal(r.earlyDepartureMinutes, 20);
  assert.equal(r.absenceMinutes, 40);
});

test('journée sans événement : absent avec le dû complet — jamais « autorisé » tout seul', () => {
  const r = day({ events: [] });
  assert.equal(r.status, 'absent');
  assert.equal(r.absenceMinutes, 480);
});

test('non appariés en attente : unresolved plutôt qu’absent définitif', () => {
  const r = day({ events: [], hasPendingUnmatched: true });
  assert.equal(r.status, 'unresolved');
  assert.ok(r.anomalies.some((a) => a.code === 'unmatched_event_pending'));
});

test('présence partielle vs absence : le TROU INTÉRIEUR fait la partialité, pas les bornes', () => {
  const params = { ...P, partialPresenceMin: 120, fullDayDeficitMin: 30 };
  // Deux périodes pointées avec un grand trou au milieu : 08:00–10:00 puis 15:00–17:00.
  // Travaillé 240 ≥ 120 ; retard 0, départ anticipé 0 ; déficit intérieur 240 > 30.
  const partial = day({
    params,
    events: [ev(480, 'in'), ev(600, 'out'), ev(900, 'in'), ev(1020, 'out')],
  });
  assert.equal(partial.status, 'partial_presence');
  assert.equal(partial.lateMinutes, 0);
  assert.equal(partial.earlyDepartureMinutes, 0);
  assert.equal(partial.workedMinutes, 240);
  // Sous le seuil de présence partielle (60 < 120) : la journée reste une ABSENCE.
  const tooShort = day({ params, events: [ev(480, 'in'), ev(540, 'out')] });
  assert.equal(tooShort.status, 'absent');
  // Un simple départ anticipé massif (aucun trou intérieur) reste un départ anticipé,
  // JAMAIS une présence partielle : le retenu dit ce qui s'est passé.
  const earlyOnly = day({ params, events: [ev(480, 'in'), ev(660, 'out')] });
  assert.equal(earlyOnly.status, 'early_departure');
  assert.equal(earlyOnly.earlyDepartureMinutesRaw, 360);
});

test('pointages incomplets : statut dédié, l’absence n’est PAS chiffrée sur des faits troués', () => {
  const r = day({ events: [ev(480, 'in')] });
  assert.equal(r.status, 'incomplete_punches');
  assert.equal(r.absenceMinutes, 0);
  assert.equal(r.workedMinutes, 0);
});

// ---------------------------------------------------------------------------
// Rotation de nuit, repos, fériés
// ---------------------------------------------------------------------------

test('rotation 22:00→06:00 : rattachée à SA journée, périodes avant/après minuit exactes', () => {
  const r = day({ planned: NIGHT_22_06, events: [ev(1315, 'in'), ev(1800, 'out')] });
  assert.equal(r.status, 'present');
  assert.equal(r.workedMinutes, 485, '5 min avant le début + 480 planifiées');
  assert.equal(r.nightMinutes, 480, '22:00→06:00 nocturne intégral (l’avance 21:55 est diurne)');
  assert.equal(r.lateMinutes, 0);
  const late = day({ planned: NIGHT_22_06, events: [ev(1350, 'in'), ev(1810, 'out')] });
  assert.equal(late.status, 'late');
  assert.equal(late.lateMinutes, 30);
  assert.equal(late.nightMinutes, 450, 'entrée 22:30 ⇒ 450 min nocturnes');
});

test('repos et férié : distinction stricte, travail ⇒ statuts et compteurs dédiés', () => {
  const rest = day({ planned: { ...DAY_8_17, isRest: true, startMinute: null, endMinute: null, breakStartMinute: null, breakEndMinute: null }, events: [] });
  assert.equal(rest.status, 'rest_day');
  const holiday = day({ holiday: true, events: [] });
  assert.equal(holiday.status, 'public_holiday');
  const workedRest = day({
    planned: { isRest: true, startMinute: null, endMinute: null, breakStartMinute: null, breakEndMinute: null },
    events: [ev(540, 'in'), ev(780, 'out')],
  });
  assert.equal(workedRest.status, 'worked_rest_day');
  assert.equal(workedRest.restDayMinutes, 240);
  assert.equal(workedRest.overtimeCandidateMinutes, 240, 'tout travail non planifié est CANDIDAT — sans taux ni montant');
  const workedHoliday = day({ holiday: true, events: [ev(540, 'in'), ev(780, 'out')] });
  assert.equal(workedHoliday.status, 'worked_public_holiday');
  assert.equal(workedHoliday.holidayMinutes, 240);
});

test('sans horaire applicable : not_scheduled + anomalie si pointages', () => {
  const quiet = day({ planned: null, events: [] });
  assert.equal(quiet.status, 'not_scheduled');
  const punched = day({ planned: null, events: [ev(480, 'in'), ev(600, 'out')] });
  assert.equal(punched.status, 'not_scheduled');
  assert.ok(punched.anomalies.some((a) => a.code === 'no_schedule'));
  assert.equal(punched.workedMinutes, 120, 'le fait travaillé reste mesuré');
});

test('contexte d’emploi : non embauché / cessé / suspendu priment, pointage = anomalie bloquante', () => {
  const notHired = day({ employment: { ...EMPLOYED, active: false, notYetHired: true }, events: [ev(480, 'in')] });
  assert.equal(notHired.status, 'not_employed');
  assert.ok(notHired.anomalies.some((a) => a.code === 'not_yet_hired' && a.severity === 'blocking'));
  const susp = day({ employment: { ...EMPLOYED, active: false, suspended: true }, events: [] });
  assert.equal(susp.status, 'suspended');
});

// ---------------------------------------------------------------------------
// HS candidates, plafonds, divers
// ---------------------------------------------------------------------------

test('HS candidates : au-delà du seuil (paramètre sinon durée planifiée), jamais de montant', () => {
  const r = day({ events: [ev(480, 'in'), ev(720, 'out'), ev(780, 'in'), ev(1140, 'out')] }); // 17h→19h en plus
  assert.equal(r.workedMinutes, 600);
  assert.equal(r.overtimeCandidateMinutes, 120);
  const withThreshold = day({
    params: { ...P, overtimeDailyThresholdMin: 570 },
    events: [ev(480, 'in'), ev(720, 'out'), ev(780, 'in'), ev(1140, 'out')],
  });
  assert.equal(withThreshold.overtimeCandidateMinutes, 30);
});

test('présence excessive : anomalie de plausibilité', () => {
  const r = day({ events: [ev(300, 'in'), ev(1330, 'out')] }); // 17 h 10
  assert.ok(r.anomalies.some((a) => a.code === 'excessive_presence'));
});

test('heure ambiguë et autre site : signalés sans casser le calcul', () => {
  const r = day({ events: [ev(480, 'in', { ambiguousTime: true }), ev(1020, 'out', { siteMatches: false })] });
  assert.ok(r.anomalies.some((a) => a.code === 'ambiguous_local_time'));
  assert.ok(r.anomalies.some((a) => a.code === 'punch_other_site'));
  assert.equal(r.status, 'present');
});

test('catalogue : chaque code porte FR, EN et sévérité par défaut ; clés E4 fermées', () => {
  for (const [code, entry] of Object.entries(ANOMALY_CATALOG)) {
    assert.ok(entry.fr.length > 3 && entry.en.length > 3, code);
    assert.ok(['info', 'warning', 'blocking'].includes(entry.defaultSeverity));
  }
  assert.equal(Object.keys(ANOMALY_CATALOG).length, 18);
  for (const key of Object.keys(PRESENCE_PARAM_KEYS)) {
    assert.match(key, /^temps\.[a-z0-9_.]+$/, 'clés au format du référentiel E4');
  }
});

test('reproductibilité : mêmes entrées + mêmes paramètres ⇒ résultat STRICTEMENT identique', () => {
  const input: ComputeDayInput = {
    planned: NIGHT_22_06, holiday: false, employment: EMPLOYED, params: { ...P, lateToleranceMin: 5 },
    events: [ev(1321, 'in'), ev(1500, 'out'), ev(1530, 'in'), ev(1805, 'out')],
  };
  const a = computeDay(input);
  const b = computeDay({ ...input, events: [...input.events].reverse() });
  assert.deepEqual(a, b, 'l’ordre d’arrivée des événements est sans effet (tri total interne)');
});
