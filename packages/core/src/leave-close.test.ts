/** Tests du domaine pur E11.3 — clôture congés, faits d'absence dans le moteur, préparation paie. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEAVE_CLOSE_ENGINE_VERSION, LEAVE_PREP_SCHEMA_VERSION, PREP_CATEGORIES, isPrepCategory,
  closeFingerprint, canonicalCloseLine, prepVariables, assertNoAmounts, utilizationRate,
  type CloseLine,
} from './leave-close.ts';
import { computeDay, type ComputeDayInput, type PlannedDay } from './presence.ts';

const LINE: CloseLine = {
  employeeId: 'e1', absenceTypeId: 't1', periodStart: '2026-01-01',
  accrued: 12, adjustedOut: 0, carriedIn: 6, expired: 2.5, reserved: 0,
  consumed: 4, available: 11.5, unit: 'open_days', movements: 9,
};

describe('empreinte de clôture', () => {
  it('REPRODUCTIBLE : mêmes lignes ⇒ même empreinte, quel que soit l\'ordre', () => {
    const l2: CloseLine = { ...LINE, employeeId: 'e2', consumed: 1, available: 14.5 };
    const a = closeFingerprint([LINE, l2]);
    const b = closeFingerprint([l2, LINE]);
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
  });
  it('SENSIBLE : un millième de jour change l\'empreinte ; la version du moteur est engagée', () => {
    const a = closeFingerprint([LINE]);
    const b = closeFingerprint([{ ...LINE, available: 11.501 }]);
    assert.notEqual(a, b);
    assert.ok(canonicalCloseLine(LINE).includes('11.500'));
    assert.equal(LEAVE_CLOSE_ENGINE_VERSION, 'kora-leave-close-1.0.0');
    assert.equal(LEAVE_PREP_SCHEMA_VERSION, 'kora-conges-prep-1');
  });
});

describe('faits d\'absence dans le moteur de présence', () => {
  const planned: PlannedDay = {
    isRest: false, startMinute: 480, endMinute: 1020, breakStartMinute: 720, breakEndMinute: 780,
  };
  const base: ComputeDayInput = {
    planned, holiday: false,
    employment: { active: true, notYetHired: false, terminated: false, suspended: false, hasAssignment: true },
    events: [], params: { toleranceLateMinutes: 0, toleranceEarlyMinutes: 0, roundingMinutes: 1, breakMinMinutes: 0, nightStartMinute: 1320, nightEndMinute: 360, maxDailyPresenceMinutes: 960 },
  };
  it('journée PLEINE : l\'absence approuvée qualifie la journée sans changer le statut ni inventer une minute', () => {
    const out = computeDay({
      ...base,
      absences: [{ category: 'conge_paye', code: 'CAP', paid: true, portion: 'full' }],
    });
    assert.equal(out.status, 'absent', 'une absence justifiée RESTE une absence');
    assert.equal(out.absenceMinutes, 480);
    assert.equal(out.justifiedCategory, 'conge_paye');
    assert.equal(out.justifiedMinutes, 480, 'bornées au manque mesuré = journée planifiée');
  });
  it('DEMI-journée : la moitié planifiée, bornée au manque mesuré', () => {
    const out = computeDay({
      ...base,
      absences: [{ category: 'conge_paye', code: 'CAP', paid: true, portion: 'half' }],
    });
    assert.equal(out.justifiedMinutes, 240);
  });
  it('HEURES : volume borné à la journée planifiée ET au manque mesuré', () => {
    const out = computeDay({
      ...base,
      absences: [{ category: 'mission_formation', code: 'HOR', paid: false, portion: 'hours', minutes: 600 }],
    });
    assert.equal(out.justifiedMinutes, 480, '600 min demandées, 480 planifiées : jamais plus que le jour');
  });
  it('journée TRAVAILLÉE : rien à justifier — l\'absence approuvée n\'écrase aucun fait', () => {
    const out = computeDay({
      ...base,
      events: [
        { id: 'i1', type: 'in', localMinute: 480, siteMatches: true, ambiguousTime: false },
        { id: 'o1', type: 'out', localMinute: 1020, siteMatches: true, ambiguousTime: false },
      ],
      absences: [{ category: 'conge_paye', code: 'CAP', paid: true, portion: 'full' }],
    });
    assert.equal(out.absenceMinutes, 0);
    assert.equal(out.justifiedCategory, null, 'aucune minute manquante ⇒ aucune justification');
  });
  it('la PREMIÈRE qualification gagne : le fait d\'absence prime, la correction ne l\'écrase pas', () => {
    const out = computeDay({
      ...base,
      absences: [{ category: 'maladie', code: 'MAL', paid: true, portion: 'full' }],
      corrections: { justifications: [{ target: 'absence', category: 'mission', minutes: null }], appliedCount: 1 },
    });
    assert.equal(out.justifiedCategory, 'maladie');
  });
  it('jour de REPOS : aucune minute planifiée, le fait est inerte', () => {
    const out = computeDay({
      ...base,
      planned: { isRest: true, startMinute: null, endMinute: null, breakStartMinute: null, breakEndMinute: null },
      absences: [{ category: 'conge_paye', code: 'CAP', paid: true, portion: 'full' }],
    });
    assert.equal(out.justifiedCategory, null);
    assert.equal(out.justifiedMinutes, 0);
  });
});

describe('variables préparatoires paie', () => {
  it('agrège par salarié et catégorie ; jours et heures séparés ; supersédés = corrections, jamais des volumes', () => {
    const vars = prepVariables([
      { employeeId: 'e1', category: 'conge_paye', paid: true, unit: 'open_days', counted: 4, minutes: null, superseded: false },
      { employeeId: 'e1', category: 'conge_paye', paid: true, unit: 'open_days', counted: 0.5, minutes: null, superseded: false },
      { employeeId: 'e1', category: 'mission_formation', paid: false, unit: 'hours', counted: 4, minutes: 240, superseded: false },
      { employeeId: 'e1', category: 'conge_paye', paid: true, unit: 'open_days', counted: 1, minutes: null, superseded: true },
      { employeeId: 'e2', category: 'maladie', paid: true, unit: 'calendar_days', counted: 3, minutes: null, superseded: false },
    ]);
    assert.equal(vars.length, 2);
    const e1 = vars[0]!;
    assert.equal(e1.categories['conge_paye']!.days, 4.5);
    assert.equal(e1.categories['mission_formation']!.hours, 4);
    assert.equal(e1.correctionsCount, 1);
    assert.equal(vars[1]!.categories['maladie']!.days, 3);
  });
  it('catégorie inconnue ⇒ « autre » (catalogue FERMÉ, jamais une invention)', () => {
    const vars = prepVariables([
      { employeeId: 'e1', category: 'fantaisie', paid: true, unit: 'open_days', counted: 1, minutes: null, superseded: false },
    ]);
    assert.ok(vars[0]!.categories['autre']);
    assert.equal(PREP_CATEGORIES.length, 10);
    assert.equal(isPrepCategory('maladie'), true);
    assert.equal(isPrepCategory('salaire'), false);
  });
});

describe('garde anti-montant', () => {
  it('refuse toute clé financière, à toute profondeur — FR et EN', () => {
    assert.equal(assertNoAmounts({ salaries: [{ jours: 4 }] }), null, 'salariés ≠ salaire… mais salaries EST suspect');
  });
  it('détecte montant/taux/salaire/net/brut/retenue/amount/rate', () => {
    for (const bad of [
      { montant: 1 }, { tauxHoraire: 2 }, { lignes: [{ salaireBase: 3 }] },
      { deep: { net: 1 } }, { brut: 2 }, { retenue: 1 }, { amountDue: 4 }, { hourlyRate: 5 },
    ]) {
      assert.notEqual(assertNoAmounts(bad), null, JSON.stringify(bad));
    }
    assert.equal(assertNoAmounts({ jours: 4, heures: 2, categorie: 'conge_paye' }), null);
  });
});

describe('taux d\'utilisation', () => {
  it('sûr : jamais une division par zéro maquillée', () => {
    assert.equal(utilizationRate(4, 12), 0.333);
    assert.equal(utilizationRate(0, 0), null);
    assert.equal(utilizationRate(5, 0), null);
  });
});
