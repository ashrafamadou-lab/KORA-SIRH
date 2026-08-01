/**
 * Conditions d'étape et branches (E3) — pures.
 * Une étape peut porter une condition évaluée contre le contexte de l'instance ; une
 * étape dont la condition est fausse est SAUTÉE (branche non prise). Le calcul de la
 * « prochaine étape effective » est la clé de la robustesse : c'est lui qui détermine si
 * une approbation clôt le workflow ou l'avance.
 */
export type ConditionOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in';

export interface StepCondition {
  field: string;
  op: ConditionOp;
  value: unknown;
}

export interface WorkflowStepDef {
  index: number;
  name: string;
  approverType: 'role' | 'user' | 'manager' | 'scope';
  approverRef?: string | null;
  selfApprovalAllowed?: boolean;
  slaHours?: number | null;
  reminderHours?: number | null;
  escalation?: { afterHours: number; toType: 'role' | 'user'; toRef: string } | null;
  /** Condition d'activation de l'étape ; absente = toujours active. */
  condition?: StepCondition | null;
}

export type WorkflowContext = Record<string, unknown>;

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function evaluateCondition(cond: StepCondition | null | undefined, ctx: WorkflowContext): boolean {
  if (!cond) return true;
  const actual = ctx[cond.field];
  switch (cond.op) {
    case 'eq':
      return actual === cond.value;
    case 'ne':
      return actual !== cond.value;
    case 'in':
      return Array.isArray(cond.value) && cond.value.includes(actual);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = asNumber(actual);
      const b = asNumber(cond.value);
      if (a === null || b === null) return false;
      return cond.op === 'gt' ? a > b : cond.op === 'gte' ? a >= b : cond.op === 'lt' ? a < b : a <= b;
    }
    default:
      return false;
  }
}

export function isStepActive(step: WorkflowStepDef, ctx: WorkflowContext): boolean {
  return evaluateCondition(step.condition, ctx);
}

/**
 * Index de la première étape ACTIVE à partir de `fromIndex` (incluse), ou null si aucune
 * (⇒ le workflow est déjà terminé : plus rien à approuver).
 */
export function firstActiveStepFrom(
  steps: WorkflowStepDef[],
  ctx: WorkflowContext,
  fromIndex: number,
): number | null {
  for (let i = fromIndex; i < steps.length; i++) {
    if (isStepActive(steps[i]!, ctx)) return i;
  }
  return null;
}

/** L'étape `index` est-elle la dernière étape effective (aucune étape active au-delà) ? */
export function isLastEffectiveStep(
  steps: WorkflowStepDef[],
  ctx: WorkflowContext,
  index: number,
): boolean {
  return firstActiveStepFrom(steps, ctx, index + 1) === null;
}
