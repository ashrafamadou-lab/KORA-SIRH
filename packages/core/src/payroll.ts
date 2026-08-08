/**
 * E12.1 — Moteur de paie BRUT : domaine pur, sans dépendance.
 *
 * Trois garanties portées ici, jumelles de celles que tient PostgreSQL :
 *
 *  1. AUCUNE EXÉCUTION ARBITRAIRE. Une formule est un ARBRE à grammaire FERMÉE
 *     (littéral, variable du contexte, clé de paramètre E4, arithmétique, min,
 *     max, arrondi, condition). Elle est VALIDÉE puis INTERPRÉTÉE — jamais
 *     compilée, jamais évaluée par le moteur JavaScript. Aucun `eval`, aucun
 *     `new Function`, aucun accès à une propriété héritée.
 *
 *  2. AUCUNE VALEUR LÉGALE EN DUR. Un taux, un plafond, un barème, une
 *     majoration ne peuvent entrer QUE par un nœud `param` porteur d'une CLÉ E4,
 *     résolue à la DATE DE PAIE avec sa provenance. Une clé non résolue fait
 *     ÉCHOUER la ligne — il n'existe aucun repli, aucune valeur par défaut, pas
 *     même pour le nombre de décimales de l'arrondi.
 *
 *  3. TOUT MONTANT S'EXPLIQUE. Chaque évaluation produit une TRACE ordonnée :
 *     chaque étape porte son opération, ses entrées et son résultat. Le montant
 *     d'une ligne se relie donc à sa rubrique, sa version, sa formule, ses
 *     variables et ses paramètres — ligne par ligne, sans reconstitution.
 *
 * Reproductibilité : mêmes entrées et mêmes versions ⇒ même résultat. L'empreinte
 * des entrées le prouve (deux empreintes égales exigent deux bruts égaux).
 */
import { createHash } from 'node:crypto';

export const PAYROLL_ENGINE_VERSION = 'kora-payroll-gross-1.0.0';

// ---------------------------------------------------------------------------
// Grammaire fermée
// ---------------------------------------------------------------------------

export type ValueNode =
  | { k: 'num'; v: number }
  | { k: 'var'; name: string }
  | { k: 'param'; key: string }
  | { k: 'add' | 'sub' | 'mul' | 'div' | 'min' | 'max'; a: ValueNode; b: ValueNode }
  | { k: 'round'; a: ValueNode; dp: number }
  | { k: 'if'; cond: CondNode; then: ValueNode; else: ValueNode };

export type CondNode =
  | { k: 'always' }
  | { k: 'lt' | 'lte' | 'gt' | 'gte' | 'eq' | 'ne'; a: ValueNode; b: ValueNode }
  | { k: 'and' | 'or'; a: CondNode; b: CondNode }
  | { k: 'not'; a: CondNode };

const VALUE_BINARY = new Set(['add', 'sub', 'mul', 'div', 'min', 'max']);
const COND_COMPARE = new Set(['lt', 'lte', 'gt', 'gte', 'eq', 'ne']);
const VAR_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;
// Une clé E4 COMMENCE par une lettre. Sans cette exigence, « 0.036 » satisferait
// le motif et un taux écrit en dur passerait pour une clé de paramètre : la règle
// « aucune valeur légale dans le moteur » serait contournée par la forme.
const PARAM_KEY_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
const MAX_DEPTH = 24;

/** Lecture SÛRE d'une propriété : jamais une propriété héritée du prototype. */
function own(o: unknown, key: string): unknown {
  if (typeof o !== 'object' || o === null) return undefined;
  return Object.prototype.hasOwnProperty.call(o, key) ? (o as Record<string, unknown>)[key] : undefined;
}

/**
 * Validation STRUCTURELLE — miroir exact de `payroll.node_is_safe` en base.
 * Retourne null si l'arbre est admissible, sinon le motif du refus.
 */
export function validateNode(node: unknown, asCond: boolean, depth = 0): string | null {
  if (depth > MAX_DEPTH) return `profondeur > ${MAX_DEPTH}`;
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return 'nœud non objet';
  const k = own(node, 'k');
  if (typeof k !== 'string') return 'nœud sans genre « k »';

  if (asCond) {
    if (k === 'always') return null;
    if (COND_COMPARE.has(k)) {
      return validateNode(own(node, 'a'), false, depth + 1) ?? validateNode(own(node, 'b'), false, depth + 1);
    }
    if (k === 'and' || k === 'or') {
      return validateNode(own(node, 'a'), true, depth + 1) ?? validateNode(own(node, 'b'), true, depth + 1);
    }
    if (k === 'not') return validateNode(own(node, 'a'), true, depth + 1);
    return `condition inconnue « ${k} »`;
  }

  if (k === 'num') {
    const v = own(node, 'v');
    return typeof v === 'number' && Number.isFinite(v) ? null : 'littéral non numérique fini';
  }
  if (k === 'var') {
    const name = own(node, 'name');
    return typeof name === 'string' && VAR_RE.test(name) ? null : 'nom de variable hors motif';
  }
  if (k === 'param') {
    const key = own(node, 'key');
    return typeof key === 'string' && PARAM_KEY_RE.test(key) ? null : 'clé de paramètre hors motif';
  }
  if (VALUE_BINARY.has(k)) {
    return validateNode(own(node, 'a'), false, depth + 1) ?? validateNode(own(node, 'b'), false, depth + 1);
  }
  if (k === 'round') {
    const dp = own(node, 'dp');
    if (typeof dp !== 'number' || !Number.isInteger(dp) || dp < 0 || dp > 6) return 'décimales d’arrondi hors bornes';
    return validateNode(own(node, 'a'), false, depth + 1);
  }
  if (k === 'if') {
    return validateNode(own(node, 'cond'), true, depth + 1)
      ?? validateNode(own(node, 'then'), false, depth + 1)
      ?? validateNode(own(node, 'else'), false, depth + 1);
  }
  return `opération inconnue « ${k} »`;
}

// ---------------------------------------------------------------------------
// Arrondi monétaire DÉTERMINISTE : demi vers l'extérieur, correction binaire.
// ---------------------------------------------------------------------------

export function roundHalfUp(value: number, dp: number): number {
  if (!Number.isFinite(value)) return value;
  const f = 10 ** dp;
  const scaled = value * f;
  const eps = Math.abs(scaled) * Number.EPSILON * 8;
  const r = Math.round(Math.abs(scaled) + eps) / f;
  return value < 0 ? -r : r;
}

// ---------------------------------------------------------------------------
// Évaluation tracée
// ---------------------------------------------------------------------------

export interface ParamProvenanceUsed {
  key: string;
  value: number;
  parameterId: string;
  effectiveFrom: string | null;
  source: string | null;
}

/** Résout une clé E4 À LA DATE DE PAIE. `null` ⇒ la ligne ÉCHOUE (aucun repli). */
export type ParamResolver = (key: string) => ParamProvenanceUsed | null;

export interface TraceStep {
  step: number;
  op: string;
  detail: string;
  value: number;
}

export interface EvalOutcome {
  ok: boolean;
  value: number;
  trace: TraceStep[];
  inputsUsed: Record<string, number>;
  paramsUsed: Record<string, ParamProvenanceUsed>;
  error: string | null;
}

class EvalError extends Error {}

export function evaluate(
  node: ValueNode, variables: Record<string, number>, params: ParamResolver,
): EvalOutcome {
  const trace: TraceStep[] = [];
  const inputsUsed: Record<string, number> = {};
  const paramsUsed: Record<string, ParamProvenanceUsed> = {};
  const push = (op: string, detail: string, value: number): number => {
    trace.push({ step: trace.length + 1, op, detail, value });
    return value;
  };

  const val = (n: ValueNode): number => {
    switch (n.k) {
      case 'num':
        return push('littéral', String(n.v), n.v);
      case 'var': {
        if (!Object.prototype.hasOwnProperty.call(variables, n.name)) {
          throw new EvalError(`variable inconnue « ${n.name} »`);
        }
        const v = variables[n.name]!;
        if (!Number.isFinite(v)) throw new EvalError(`variable « ${n.name} » non numérique`);
        inputsUsed[n.name] = v;
        return push('variable', n.name, v);
      }
      case 'param': {
        const p = params(n.key);
        if (p === null) {
          // AUCUN repli : un paramètre légal absent ARRÊTE le calcul.
          throw new EvalError(`paramètre E4 non résolu à la date de paie : « ${n.key} »`);
        }
        paramsUsed[n.key] = p;
        return push('paramètre', `${n.key} (${p.source ?? 'paramètre'}, effet ${p.effectiveFrom ?? '—'})`, p.value);
      }
      case 'add': return push('addition', '+', val(n.a) + val(n.b));
      case 'sub': return push('soustraction', '−', val(n.a) - val(n.b));
      case 'mul': return push('multiplication', '×', val(n.a) * val(n.b));
      case 'div': {
        const a = val(n.a);
        const b = val(n.b);
        if (b === 0) throw new EvalError('division par zéro');
        return push('division', '÷', a / b);
      }
      case 'min': return push('minimum', 'min', Math.min(val(n.a), val(n.b)));
      case 'max': return push('maximum', 'max', Math.max(val(n.a), val(n.b)));
      case 'round': return push('arrondi', `${n.dp} décimale(s)`, roundHalfUp(val(n.a), n.dp));
      case 'if': {
        const c = cond(n.cond);
        return push('condition', c ? 'vraie' : 'fausse', c ? val(n.then) : val(n.else));
      }
      default:
        throw new EvalError('opération inconnue');
    }
  };

  const cond = (c: CondNode): boolean => {
    switch (c.k) {
      case 'always': return true;
      case 'and': return cond(c.a) && cond(c.b);
      case 'or': return cond(c.a) || cond(c.b);
      case 'not': return !cond(c.a);
      case 'lt': return val(c.a) < val(c.b);
      case 'lte': return val(c.a) <= val(c.b);
      case 'gt': return val(c.a) > val(c.b);
      case 'gte': return val(c.a) >= val(c.b);
      case 'eq': return val(c.a) === val(c.b);
      case 'ne': return val(c.a) !== val(c.b);
      default: throw new EvalError('condition inconnue');
    }
  };

  const invalid = validateNode(node, false);
  if (invalid !== null) {
    return { ok: false, value: 0, trace, inputsUsed, paramsUsed, error: `formule refusée : ${invalid}` };
  }
  try {
    const value = val(node);
    return { ok: true, value, trace, inputsUsed, paramsUsed, error: null };
  } catch (e) {
    return { ok: false, value: 0, trace, inputsUsed, paramsUsed, error: (e as Error).message };
  }
}

export function evaluateCondition(
  node: CondNode, variables: Record<string, number>, params: ParamResolver,
): { ok: boolean; result: boolean; error: string | null } {
  const invalid = validateNode(node, true);
  if (invalid !== null) return { ok: false, result: false, error: `condition refusée : ${invalid}` };
  // Une condition se ramène à un choix 1 / 0 : même interpréteur, même trace.
  const out = evaluate({ k: 'if', cond: node, then: { k: 'num', v: 1 }, else: { k: 'num', v: 0 } }, variables, params);
  return { ok: out.ok, result: out.value === 1, error: out.error };
}

// ---------------------------------------------------------------------------
// Catalogue FERMÉ des variables de calcul (aucune n'est recalculée ici : elles
// viennent des CLÔTURES E10 et E11 et de la rémunération historisée).
// ---------------------------------------------------------------------------

export const PREP_CATEGORY_KEYS = [
  'conge_paye', 'absence_autorisee_payee', 'sans_solde', 'maladie',
  'maternite_paternite', 'accident_travail', 'mission_formation',
  'non_autorisee', 'repos_compensateur', 'autre',
] as const;

export const PAYROLL_VARIABLES: readonly string[] = [
  // Rémunération historisée
  'base.montant', 'base.periodicite_mensuelle',
  // Période
  'periode.jours_calendaires',
  // Clôture de présence E10 (jamais recalculée ici)
  'temps.jours_attendus', 'temps.jours_presents', 'temps.jours_absence_injustifiee',
  'temps.heures_travaillees', 'temps.heures_nuit', 'temps.heures_sup_candidates',
  'temps.heures_repos_travaille', 'temps.heures_ferie_travaille',
  'temps.minutes_retard', 'temps.minutes_depart_anticipe', 'temps.corrections',
  // Clôture de congés E11 (jamais recalculée ici)
  ...PREP_CATEGORY_KEYS.map((c) => `conges.jours_${c}`),
  ...PREP_CATEGORY_KEYS.map((c) => `conges.heures_${c}`),
  // Salarié (éligibilité)
  'emp.anciennete_mois',
];

const VARIABLE_SET = new Set(PAYROLL_VARIABLES);
export function isKnownVariable(name: string): boolean {
  return VARIABLE_SET.has(name);
}

/** Variables référencées par un arbre — sert au contrôle d'admissibilité. */
export function referencedVariables(node: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof node !== 'object' || node === null) return out;
  const k = own(node, 'k');
  if (k === 'var') {
    const name = own(node, 'name');
    if (typeof name === 'string') out.add(name);
    return out;
  }
  for (const field of ['a', 'b', 'cond', 'then', 'else']) {
    const child = own(node, field);
    if (child !== undefined) referencedVariables(child, out);
  }
  return out;
}

export function referencedParams(node: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof node !== 'object' || node === null) return out;
  const k = own(node, 'k');
  if (k === 'param') {
    const key = own(node, 'key');
    if (typeof key === 'string') out.add(key);
    return out;
  }
  for (const field of ['a', 'b', 'cond', 'then', 'else']) {
    const child = own(node, field);
    if (child !== undefined) referencedParams(child, out);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Moteur de calcul BRUT
// ---------------------------------------------------------------------------

export interface RubricVersionSpec {
  rubricId: string;
  versionId: string;
  version: number;
  code: string;
  labelFr: string;
  labelEn: string;
  kind: 'gain' | 'prime' | 'indemnite' | 'avantage' | 'retenue';
  taxable: boolean;
  cotisable: boolean;
  sequence: number;
  valuation: 'fixed' | 'rate' | 'formula';
  fixedValue: number | null;
  rateValue: number | null;
  rateParamKey: string | null;
  rateBase: string | null;
  formula: ValueNode | null;
  eligibility: CondNode | null;
  proration: 'none' | 'worked_days' | 'calendar_days';
  capValue: number | null;
  capParamKey: string | null;
  floorValue: number | null;
  roundingDp: number | null;
}

export interface GrossLine {
  sequence: number;
  rubricId: string;
  rubricVersionId: string;
  code: string;
  labelFr: string;
  labelEn: string;
  kind: RubricVersionSpec['kind'];
  taxable: boolean;
  cotisable: boolean;
  valuation: RubricVersionSpec['valuation'];
  base: number | null;
  rate: number | null;
  quantity: number | null;
  amount: number;
  trace: TraceStep[];
  inputsUsed: Record<string, number>;
  paramsUsed: Record<string, ParamProvenanceUsed>;
}

export interface GrossInput {
  variables: Record<string, number>;
  rubrics: RubricVersionSpec[];
  params: ParamResolver;
  /** Décimales d'arrondi monétaire — PARAMÈTRE E4, jamais une constante. */
  roundingDp: number;
}

export interface GrossOutcome {
  lines: GrossLine[];
  skipped: Array<{ code: string; reason: string }>;
  errors: Array<{ code: string; reason: string }>;
  gross: number;
  taxableBase: number;
  contributableBase: number;
  paramsUsed: Record<string, ParamProvenanceUsed>;
}

/** Le SIGNE d'une rubrique : une retenue diminue le brut, les autres l'augmentent. */
export function signOf(kind: RubricVersionSpec['kind']): 1 | -1 {
  return kind === 'retenue' ? -1 : 1;
}

export function computeGross(input: GrossInput): GrossOutcome {
  const lines: GrossLine[] = [];
  const skipped: Array<{ code: string; reason: string }> = [];
  const errors: Array<{ code: string; reason: string }> = [];
  const paramsUsed: Record<string, ParamProvenanceUsed> = {};
  const record = (p: Record<string, ParamProvenanceUsed>): void => {
    for (const [k, v] of Object.entries(p)) paramsUsed[k] = v;
  };
  const ordered = [...input.rubrics].sort((a, b) =>
    a.sequence !== b.sequence ? a.sequence - b.sequence : (a.code < b.code ? -1 : 1));

  for (const r of ordered) {
    // 1. Éligibilité (condition à grammaire fermée) — un refus est EXPLIQUÉ.
    if (r.eligibility !== null) {
      const el = evaluateCondition(r.eligibility, input.variables, input.params);
      if (!el.ok) { errors.push({ code: r.code, reason: `éligibilité : ${el.error}` }); continue; }
      if (!el.result) { skipped.push({ code: r.code, reason: 'non éligible sur la période' }); continue; }
    }

    // 2. Valorisation.
    let amount = 0;
    let base: number | null = null;
    let rate: number | null = null;
    let trace: TraceStep[] = [];
    let inputsUsed: Record<string, number> = {};
    let localParams: Record<string, ParamProvenanceUsed> = {};

    if (r.valuation === 'fixed') {
      if (r.fixedValue === null) { errors.push({ code: r.code, reason: 'montant fixe absent' }); continue; }
      amount = r.fixedValue;
      trace = [{ step: 1, op: 'montant fixe', detail: 'valeur de la version de rubrique', value: amount }];
    } else if (r.valuation === 'rate') {
      if (r.rateBase === null) { errors.push({ code: r.code, reason: 'base du taux absente' }); continue; }
      if (!Object.prototype.hasOwnProperty.call(input.variables, r.rateBase)) {
        errors.push({ code: r.code, reason: `variable de base inconnue « ${r.rateBase} »` });
        continue;
      }
      base = input.variables[r.rateBase]!;
      if (r.rateParamKey !== null) {
        const p = input.params(r.rateParamKey);
        if (p === null) {
          errors.push({ code: r.code, reason: `paramètre E4 non résolu à la date de paie : « ${r.rateParamKey} »` });
          continue;
        }
        rate = p.value;
        localParams[r.rateParamKey] = p;
      } else if (r.rateValue !== null) {
        rate = r.rateValue;
      } else {
        errors.push({ code: r.code, reason: 'taux absent (ni valeur interne, ni clé E4)' });
        continue;
      }
      amount = base * rate;
      inputsUsed = { [r.rateBase]: base };
      trace = [
        { step: 1, op: 'base', detail: r.rateBase, value: base },
        { step: 2, op: 'taux', detail: r.rateParamKey ?? 'valeur interne assumée', value: rate },
        { step: 3, op: 'multiplication', detail: 'base × taux', value: amount },
      ];
    } else {
      if (r.formula === null) { errors.push({ code: r.code, reason: 'formule absente' }); continue; }
      const out = evaluate(r.formula, input.variables, input.params);
      if (!out.ok) { errors.push({ code: r.code, reason: out.error ?? 'formule invalide' }); continue; }
      amount = out.value;
      trace = out.trace;
      inputsUsed = out.inputsUsed;
      localParams = out.paramsUsed;
    }

    // 3. Proratisation (jamais une règle légale : une politique de rubrique).
    let quantity: number | null = null;
    if (r.proration !== 'none') {
      const num = r.proration === 'worked_days' ? input.variables['temps.jours_presents'] : input.variables['periode.jours_calendaires'];
      const den = r.proration === 'worked_days' ? input.variables['temps.jours_attendus'] : input.variables['periode.jours_calendaires'];
      if (num === undefined || den === undefined) {
        errors.push({ code: r.code, reason: 'proratisation : variables de période absentes' });
        continue;
      }
      if (den === 0) { errors.push({ code: r.code, reason: 'proratisation : diviseur nul' }); continue; }
      quantity = num / den;
      const before = amount;
      amount = amount * quantity;
      trace = [...trace,
        { step: trace.length + 1, op: 'proratisation', detail: `${r.proration} (${num}/${den})`, value: quantity },
        { step: trace.length + 2, op: 'montant proratisé', detail: `${before} × ${quantity}`, value: amount }];
    }

    // 4. Plancher puis plafond (le plafond peut venir d'une clé E4).
    if (r.floorValue !== null && amount < r.floorValue) {
      amount = r.floorValue;
      trace = [...trace, { step: trace.length + 1, op: 'plancher', detail: 'valeur minimale de la rubrique', value: amount }];
    }
    if (r.capParamKey !== null) {
      const p = input.params(r.capParamKey);
      if (p === null) {
        errors.push({ code: r.code, reason: `plafond E4 non résolu à la date de paie : « ${r.capParamKey} »` });
        continue;
      }
      localParams[r.capParamKey] = p;
      if (amount > p.value) {
        amount = p.value;
        trace = [...trace, { step: trace.length + 1, op: 'plafond', detail: `${r.capParamKey} (${p.source ?? 'paramètre'})`, value: amount }];
      }
    } else if (r.capValue !== null && amount > r.capValue) {
      amount = r.capValue;
      trace = [...trace, { step: trace.length + 1, op: 'plafond', detail: 'valeur maximale de la rubrique', value: amount }];
    }

    // 5. Arrondi monétaire — décimales de la rubrique, sinon du moteur (E4).
    const dp = r.roundingDp ?? input.roundingDp;
    const rounded = roundHalfUp(amount, dp);
    if (rounded !== amount) {
      trace = [...trace, { step: trace.length + 1, op: 'arrondi monétaire', detail: `${dp} décimale(s)`, value: rounded }];
    }
    amount = rounded;

    record(localParams);
    lines.push({
      sequence: lines.length + 1,
      rubricId: r.rubricId, rubricVersionId: r.versionId, code: r.code,
      labelFr: r.labelFr, labelEn: r.labelEn, kind: r.kind,
      taxable: r.taxable, cotisable: r.cotisable, valuation: r.valuation,
      base, rate, quantity, amount, trace, inputsUsed, paramsUsed: localParams,
    });
  }

  let gross = 0;
  let taxableBase = 0;
  let contributableBase = 0;
  for (const l of lines) {
    const signed = signOf(l.kind) * l.amount;
    gross += signed;
    if (l.taxable) taxableBase += signed;
    if (l.cotisable) contributableBase += signed;
  }
  const dp = input.roundingDp;
  return {
    lines, skipped, errors,
    gross: roundHalfUp(gross, dp),
    taxableBase: roundHalfUp(taxableBase, dp),
    contributableBase: roundHalfUp(contributableBase, dp),
    paramsUsed,
  };
}

// ---------------------------------------------------------------------------
// Empreinte des ENTRÉES : mêmes entrées et mêmes versions ⇒ même résultat.
// ---------------------------------------------------------------------------

export interface FingerprintInput {
  employeeId: string;
  periodId: string;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  compensationId: string;
  structureId: string;
  timeCloseId: string | null;
  leaveCloseId: string | null;
  engineVersion: string;
  rubricVersionIds: string[];
  params: Record<string, ParamProvenanceUsed>;
  variables: Record<string, number>;
}

const q4 = (n: number): string => (Math.round(n * 10000) / 10000).toFixed(4);

/** Sérialisation CANONIQUE des entrées, puis SHA-256 — reproductible. */
export function inputsFingerprint(i: FingerprintInput): string {
  const parts: string[] = [
    `employe=${i.employeeId}`,
    `periode=${i.periodId}|${i.periodStart}|${i.periodEnd}|paie=${i.payDate}`,
    `remuneration=${i.compensationId}`,
    `structure=${i.structureId}`,
    `cloture_temps=${i.timeCloseId ?? '—'}`,
    `cloture_conges=${i.leaveCloseId ?? '—'}`,
    `moteur=${i.engineVersion}`,
    `rubriques=${[...i.rubricVersionIds].sort().join(',')}`,
  ];
  for (const key of Object.keys(i.params).sort()) {
    const p = i.params[key]!;
    parts.push(`param:${key}=${p.parameterId}|${q4(p.value)}|${p.effectiveFrom ?? '—'}`);
  }
  for (const name of Object.keys(i.variables).sort()) {
    parts.push(`var:${name}=${q4(i.variables[name]!)}`);
  }
  return createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Comparaison de deux calculs — la différence est LISIBLE, jamais devinée.
// ---------------------------------------------------------------------------

export interface LineLike { code: string; amount: number }

export interface ResultDiff {
  code: string;
  before: number | null;
  after: number | null;
  delta: number;
  change: 'ajoutee' | 'retiree' | 'modifiee';
}

export function diffLines(before: LineLike[], after: LineLike[]): ResultDiff[] {
  const a = new Map(before.map((l) => [l.code, l.amount]));
  const b = new Map(after.map((l) => [l.code, l.amount]));
  const out: ResultDiff[] = [];
  for (const code of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const x = a.has(code) ? a.get(code)! : null;
    const y = b.has(code) ? b.get(code)! : null;
    if (x === y) continue;
    out.push({
      code, before: x, after: y,
      delta: (y ?? 0) - (x ?? 0),
      change: x === null ? 'ajoutee' : y === null ? 'retiree' : 'modifiee',
    });
  }
  return out;
}
