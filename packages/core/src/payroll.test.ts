/**
 * E12.1 — Moteur de paie brut : ce que le domaine pur garantit.
 * Grammaire fermée (aucune exécution arbitraire), aucun repli sur un paramètre
 * légal absent, arrondi déterministe, brut et assiettes reproductibles,
 * explication ligne par ligne, empreinte d'entrées stable et sensible.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAYROLL_ENGINE_VERSION, PAYROLL_VARIABLES, computeGross, diffLines, evaluate,
  evaluateCondition, inputsFingerprint, isKnownVariable, referencedParams,
  referencedVariables, roundHalfUp, signOf, validateNode,
  type ParamProvenanceUsed, type RubricVersionSpec, type ValueNode,
} from './payroll.ts';

const param = (key: string, value: number, id = 'p-' + key): ParamProvenanceUsed =>
  ({ key, value, parameterId: id, effectiveFrom: '2026-01-01', source: 'parametre' });

const RESOLVER = (table: Record<string, number>) => (key: string): ParamProvenanceUsed | null =>
  Object.prototype.hasOwnProperty.call(table, key) ? param(key, table[key]!) : null;

const VARS = {
  'base.montant': 300000,
  'temps.heures_nuit': 12,
  'temps.jours_presents': 20,
  'temps.jours_attendus': 22,
  'periode.jours_calendaires': 30,
  'emp.anciennete_mois': 30,
};

// ---------------------------------------------------------------------------
// 1. Grammaire FERMÉE : aucune exécution arbitraire
// ---------------------------------------------------------------------------

test('grammaire : les nœuds légitimes sont admis', () => {
  assert.equal(validateNode({ k: 'num', v: 12 }, false), null);
  assert.equal(validateNode({ k: 'var', name: 'base.montant' }, false), null);
  assert.equal(validateNode({ k: 'param', key: 'paie.majoration.nuit' }, false), null);
  assert.equal(validateNode({
    k: 'mul', a: { k: 'var', name: 'temps.heures_nuit' }, b: { k: 'param', key: 'paie.majoration.nuit' },
  }, false), null);
  assert.equal(validateNode({ k: 'always' }, true), null);
});

test('grammaire : tout ce qui ressemble à du CODE est refusé', () => {
  for (const hostile of [
    { k: 'call', fn: 'process.exit' },
    { k: 'eval', src: '1+1' },
    { k: 'require', m: 'fs' },
    { k: 'num', v: 'NaN' },
    { k: 'num', v: Number.POSITIVE_INFINITY },
    { k: 'var', name: '__proto__' },
    { k: 'param', key: 'PAIE.TAUX' },
    { k: 'round', a: { k: 'num', v: 1 }, dp: 99 },
    'chaîne', 42, null, [], { pas_de_k: true },
    { k: 'add', a: { k: 'num', v: 1 }, b: { k: 'call' } },
  ]) {
    assert.notEqual(validateNode(hostile, false), null, `refus attendu : ${JSON.stringify(hostile)}`);
  }
  // Une profondeur pathologique est bornée.
  let deep: unknown = { k: 'num', v: 1 };
  for (let i = 0; i < 40; i += 1) deep = { k: 'add', a: deep, b: { k: 'num', v: 1 } };
  assert.notEqual(validateNode(deep, false), null, 'profondeur bornée');
});

test('un nom de variable « piégeux » ne mène nulle part : catalogue fermé ET lecture propre', () => {
  // « constructor » est un nom syntaxiquement valide : la défense n'est pas le
  // motif mais le CATALOGUE (admission) et la lecture par propriété PROPRE.
  assert.equal(isKnownVariable('constructor'), false, 'hors catalogue');
  assert.equal(isKnownVariable('toString'), false, 'hors catalogue');
  const out = evaluate({ k: 'var', name: 'constructor' }, VARS, RESOLVER({}));
  assert.equal(out.ok, false);
  assert.match(out.error!, /variable inconnue/);
});

test('grammaire : une propriété HÉRITÉE ne devient jamais un nœud', () => {
  const hostile = Object.create({ k: 'num', v: 999 }) as Record<string, unknown>;
  assert.notEqual(validateNode(hostile, false), null, 'k hérité du prototype refusé');
  const varsWithProto = Object.create({ 'base.montant': 42 }) as Record<string, number>;
  const out = evaluate({ k: 'var', name: 'base.montant' }, varsWithProto, RESOLVER({}));
  assert.equal(out.ok, false);
  assert.match(out.error!, /variable inconnue/);
});

test('une formule refusée n’est jamais évaluée', () => {
  const out = evaluate({ k: 'call', fn: 'x' } as unknown as ValueNode, VARS, RESOLVER({}));
  assert.equal(out.ok, false);
  assert.match(out.error!, /formule refusée/);
  assert.equal(out.trace.length, 0);
});

// ---------------------------------------------------------------------------
// 2. Aucun repli sur un paramètre légal absent
// ---------------------------------------------------------------------------

test('paramètre E4 absent : le calcul ÉCHOUE, il ne se rabat sur rien', () => {
  const out = evaluate({
    k: 'mul', a: { k: 'var', name: 'temps.heures_nuit' }, b: { k: 'param', key: 'paie.majoration.nuit' },
  }, VARS, RESOLVER({}));
  assert.equal(out.ok, false);
  assert.match(out.error!, /paramètre E4 non résolu/);
  assert.equal(out.value, 0);
});

test('paramètre E4 présent : sa PROVENANCE est conservée avec la valeur', () => {
  const out = evaluate({ k: 'param', key: 'paie.majoration.nuit' }, VARS, RESOLVER({ 'paie.majoration.nuit': 0.25 }));
  assert.equal(out.ok, true);
  assert.equal(out.value, 0.25);
  assert.equal(out.paramsUsed['paie.majoration.nuit']!.parameterId, 'p-paie.majoration.nuit');
  assert.equal(out.paramsUsed['paie.majoration.nuit']!.effectiveFrom, '2026-01-01');
});

test('variable inconnue et division par zéro : erreurs EXPLICITES', () => {
  assert.match(evaluate({ k: 'var', name: 'inexistante' }, VARS, RESOLVER({})).error!, /variable inconnue/);
  assert.match(evaluate({
    k: 'div', a: { k: 'num', v: 1 }, b: { k: 'num', v: 0 },
  }, VARS, RESOLVER({})).error!, /division par zéro/);
});

// ---------------------------------------------------------------------------
// 3. Arrondi déterministe et trace
// ---------------------------------------------------------------------------

test('arrondi : demi vers l’extérieur, y compris sur les binaires piégeux', () => {
  assert.equal(roundHalfUp(2.675, 2), 2.68);
  assert.equal(roundHalfUp(0.5, 0), 1);
  assert.equal(roundHalfUp(1.5, 0), 2);
  assert.equal(roundHalfUp(-0.5, 0), -1);
  assert.equal(roundHalfUp(-2.675, 2), -2.68);
  assert.equal(roundHalfUp(1234.4999, 0), 1234);
  assert.equal(roundHalfUp(1234.5, 0), 1235);
});

test('la trace explique CHAQUE étape, dans l’ordre', () => {
  const out = evaluate({
    k: 'round',
    a: { k: 'mul', a: { k: 'var', name: 'temps.heures_nuit' }, b: { k: 'param', key: 'paie.taux.nuit' } },
    dp: 0,
  }, VARS, RESOLVER({ 'paie.taux.nuit': 1250.4 }));
  assert.equal(out.ok, true);
  assert.equal(out.value, 15005);
  assert.deepEqual(out.trace.map((s) => s.op), ['variable', 'paramètre', 'multiplication', 'arrondi']);
  assert.equal(out.trace[0]!.value, 12);
  assert.equal(out.inputsUsed['temps.heures_nuit'], 12);
});

// ---------------------------------------------------------------------------
// 4. Moteur de brut
// ---------------------------------------------------------------------------

const rub = (o: Partial<RubricVersionSpec> & Pick<RubricVersionSpec, 'code' | 'valuation'>): RubricVersionSpec => ({
  rubricId: 'r-' + o.code, versionId: 'v-' + o.code, version: 1,
  labelFr: o.code, labelEn: o.code, kind: 'gain', taxable: true, cotisable: true, sequence: 100,
  fixedValue: null, rateValue: null, rateParamKey: null, rateBase: null, formula: null,
  eligibility: null, proration: 'none', capValue: null, capParamKey: null, floorValue: null,
  roundingDp: null, ...o,
} as RubricVersionSpec);

test('brut : gains ajoutés, retenues soustraites, assiettes séparées', () => {
  const out = computeGross({
    variables: VARS, roundingDp: 0, params: RESOLVER({ 'paie.majoration.nuit': 0.25 }),
    rubrics: [
      rub({ code: 'BASE', valuation: 'fixed', fixedValue: 300000, sequence: 10 }),
      rub({
        code: 'NUIT', valuation: 'formula', kind: 'prime', sequence: 20,
        formula: { k: 'mul', a: { k: 'var', name: 'temps.heures_nuit' }, b: { k: 'param', key: 'paie.majoration.nuit' } },
      }),
      rub({ code: 'TRANSP', valuation: 'fixed', fixedValue: 20000, kind: 'indemnite', taxable: false, cotisable: false, sequence: 30 }),
      rub({ code: 'AVANCE', valuation: 'fixed', fixedValue: 15000, kind: 'retenue', taxable: false, cotisable: false, sequence: 40 }),
    ],
  });
  assert.equal(out.errors.length, 0, JSON.stringify(out.errors));
  assert.equal(out.lines.length, 4);
  assert.equal(out.lines[1]!.amount, 3); // 12 h × 0,25 arrondi à 0 décimale
  assert.equal(out.gross, 300000 + 3 + 20000 - 15000);
  assert.equal(out.taxableBase, 300003);
  assert.equal(out.contributableBase, 300003);
  assert.equal(signOf('retenue'), -1);
  assert.equal(signOf('gain'), 1);
});

test('éligibilité : une rubrique non éligible est ÉCARTÉE et motivée', () => {
  const anciennete = rub({
    code: 'ANC', valuation: 'fixed', fixedValue: 10000, kind: 'prime',
    eligibility: { k: 'gte', a: { k: 'var', name: 'emp.anciennete_mois' }, b: { k: 'num', v: 36 } },
  });
  const out = computeGross({ variables: VARS, roundingDp: 0, params: RESOLVER({}), rubrics: [anciennete] });
  assert.equal(out.lines.length, 0);
  assert.deepEqual(out.skipped, [{ code: 'ANC', reason: 'non éligible sur la période' }]);
  const senior = computeGross({
    variables: { ...VARS, 'emp.anciennete_mois': 48 }, roundingDp: 0, params: RESOLVER({}), rubrics: [anciennete],
  });
  assert.equal(senior.lines.length, 1);
  assert.equal(senior.gross, 10000);
});

test('taux : base × taux, la clé E4 l’emporte et sa provenance est tracée', () => {
  const out = computeGross({
    variables: VARS, roundingDp: 0, params: RESOLVER({ 'paie.taux.prime': 0.1 }),
    rubrics: [rub({ code: 'PCT', valuation: 'rate', rateBase: 'base.montant', rateParamKey: 'paie.taux.prime', kind: 'prime' })],
  });
  assert.equal(out.lines[0]!.base, 300000);
  assert.equal(out.lines[0]!.rate, 0.1);
  assert.equal(out.lines[0]!.amount, 30000);
  assert.equal(out.paramsUsed['paie.taux.prime']!.value, 0.1);
  assert.deepEqual(out.lines[0]!.trace.map((s) => s.op), ['base', 'taux', 'multiplication']);
});

test('proratisation, plancher et plafond E4 s’enchaînent dans l’ordre et se tracent', () => {
  const out = computeGross({
    variables: VARS, roundingDp: 0, params: RESOLVER({ 'paie.plafond.transport': 25000 }),
    rubrics: [
      rub({ code: 'PRO', valuation: 'fixed', fixedValue: 110000, proration: 'worked_days', kind: 'prime', sequence: 10 }),
      rub({ code: 'CAP', valuation: 'fixed', fixedValue: 40000, capParamKey: 'paie.plafond.transport', kind: 'indemnite', sequence: 20 }),
      rub({ code: 'FLOOR', valuation: 'fixed', fixedValue: 100, floorValue: 5000, kind: 'prime', sequence: 30 }),
    ],
  });
  assert.equal(out.lines[0]!.amount, 100000); // 110000 × 20/22
  assert.equal(out.lines[0]!.quantity, 20 / 22);
  assert.equal(out.lines[1]!.amount, 25000);
  assert.ok(out.lines[1]!.trace.some((s) => s.op === 'plafond'));
  assert.equal(out.lines[2]!.amount, 5000);
  assert.ok(out.lines[2]!.trace.some((s) => s.op === 'plancher'));
});

test('plafond E4 introuvable : la ligne échoue, elle n’est jamais laissée sans plafond', () => {
  const out = computeGross({
    variables: VARS, roundingDp: 0, params: RESOLVER({}),
    rubrics: [rub({ code: 'CAP', valuation: 'fixed', fixedValue: 40000, capParamKey: 'paie.plafond.transport' })],
  });
  assert.equal(out.lines.length, 0);
  assert.match(out.errors[0]!.reason, /plafond E4 non résolu/);
});

test('déterminisme : deux exécutions des mêmes entrées donnent le même brut', () => {
  const build = (): ReturnType<typeof computeGross> => computeGross({
    variables: VARS, roundingDp: 0, params: RESOLVER({ 'paie.majoration.nuit': 0.25, 'paie.taux.prime': 0.075 }),
    rubrics: [
      rub({ code: 'BASE', valuation: 'fixed', fixedValue: 300000, sequence: 10 }),
      rub({ code: 'PCT', valuation: 'rate', rateBase: 'base.montant', rateParamKey: 'paie.taux.prime', sequence: 20 }),
      rub({
        code: 'NUIT', valuation: 'formula', sequence: 30,
        formula: {
          k: 'round',
          a: { k: 'mul', a: { k: 'var', name: 'temps.heures_nuit' }, b: { k: 'param', key: 'paie.majoration.nuit' } },
          dp: 2,
        },
      }),
    ],
  });
  const a = build();
  const b = build();
  assert.equal(a.gross, b.gross);
  assert.deepEqual(a.lines.map((l) => l.amount), b.lines.map((l) => l.amount));
});

test('l’ordre des rubriques est déterministe (séquence puis code)', () => {
  const out = computeGross({
    variables: VARS, roundingDp: 0, params: RESOLVER({}),
    rubrics: [
      rub({ code: 'ZZZ', valuation: 'fixed', fixedValue: 1, sequence: 10 }),
      rub({ code: 'AAA', valuation: 'fixed', fixedValue: 1, sequence: 10 }),
      rub({ code: 'MMM', valuation: 'fixed', fixedValue: 1, sequence: 5 }),
    ],
  });
  assert.deepEqual(out.lines.map((l) => l.code), ['MMM', 'AAA', 'ZZZ']);
});

// ---------------------------------------------------------------------------
// 5. Empreinte, catalogue de variables, comparaison
// ---------------------------------------------------------------------------

const FP = {
  employeeId: 'e1', periodId: 'p1', periodStart: '2026-09-01', periodEnd: '2026-09-30',
  payDate: '2026-09-30', compensationId: 'c1', structureId: 's1',
  timeCloseId: 'tc1', leaveCloseId: 'lc1', engineVersion: PAYROLL_ENGINE_VERSION,
  rubricVersionIds: ['v2', 'v1'],
  params: { 'paie.taux': param('paie.taux', 0.25) },
  variables: { 'base.montant': 300000 },
};

test('empreinte : reproductible, insensible à l’ordre, sensible à TOUT changement', () => {
  const base = inputsFingerprint(FP);
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(inputsFingerprint({ ...FP, rubricVersionIds: ['v1', 'v2'] }), base, 'ordre des versions indifférent');
  assert.notEqual(inputsFingerprint({ ...FP, compensationId: 'c2' }), base, 'rémunération');
  assert.notEqual(inputsFingerprint({ ...FP, timeCloseId: 'tc2' }), base, 'clôture temps');
  assert.notEqual(inputsFingerprint({ ...FP, leaveCloseId: 'lc2' }), base, 'clôture congés');
  assert.notEqual(inputsFingerprint({ ...FP, engineVersion: 'x' }), base, 'version de moteur');
  assert.notEqual(inputsFingerprint({ ...FP, rubricVersionIds: ['v1'] }), base, 'versions de rubriques');
  assert.notEqual(inputsFingerprint({ ...FP, params: { 'paie.taux': param('paie.taux', 0.3) } }), base, 'valeur de paramètre');
  assert.notEqual(inputsFingerprint({ ...FP, params: { 'paie.taux': param('paie.taux', 0.25, 'autre') } }), base, 'version de paramètre');
  assert.notEqual(inputsFingerprint({ ...FP, variables: { 'base.montant': 300001 } }), base, 'variable d’entrée');
  assert.notEqual(inputsFingerprint({ ...FP, payDate: '2026-10-05' }), base, 'date de paie');
});

test('catalogue de variables : fermé, et couvrant les deux clôtures', () => {
  assert.ok(isKnownVariable('base.montant'));
  assert.ok(isKnownVariable('temps.heures_sup_candidates'));
  assert.ok(isKnownVariable('conges.jours_conge_paye'));
  assert.ok(isKnownVariable('conges.heures_mission_formation'));
  assert.equal(isKnownVariable('paie.net'), false, 'aucune variable de net en E12.1');
  assert.equal(isKnownVariable('cnss.taux'), false, 'aucun taux en variable');
  assert.ok(PAYROLL_VARIABLES.length >= 30);
});

test('références : variables et paramètres d’un arbre sont énumérables (contrôle d’admissibilité)', () => {
  const f: ValueNode = {
    k: 'if',
    cond: { k: 'gt', a: { k: 'var', name: 'temps.heures_nuit' }, b: { k: 'num', v: 0 } },
    then: { k: 'mul', a: { k: 'var', name: 'base.montant' }, b: { k: 'param', key: 'paie.taux.nuit' } },
    else: { k: 'num', v: 0 },
  };
  assert.deepEqual([...referencedVariables(f)].sort(), ['base.montant', 'temps.heures_nuit']);
  assert.deepEqual([...referencedParams(f)], ['paie.taux.nuit']);
});

test('condition : évaluée par le même interpréteur, jamais par du code', () => {
  const ok = evaluateCondition({ k: 'and',
    a: { k: 'gte', a: { k: 'var', name: 'emp.anciennete_mois' }, b: { k: 'num', v: 12 } },
    b: { k: 'not', a: { k: 'eq', a: { k: 'var', name: 'temps.jours_presents' }, b: { k: 'num', v: 0 } } },
  }, VARS, RESOLVER({}));
  assert.equal(ok.ok, true);
  assert.equal(ok.result, true);
  const ko = evaluateCondition({ k: 'exec' } as never, VARS, RESOLVER({}));
  assert.equal(ko.ok, false);
  assert.match(ko.error!, /condition refusée/);
});

test('comparaison de deux calculs : ajout, retrait, modification, écart chiffré', () => {
  const d = diffLines(
    [{ code: 'BASE', amount: 300000 }, { code: 'NUIT', amount: 3000 }, { code: 'OLD', amount: 500 }],
    [{ code: 'BASE', amount: 310000 }, { code: 'NUIT', amount: 3000 }, { code: 'NEW', amount: 200 }],
  );
  assert.deepEqual(d.map((x) => `${x.code}:${x.change}:${x.delta}`),
    ['BASE:modifiee:10000', 'NEW:ajoutee:200', 'OLD:retiree:-500']);
});
