/**
 * Autorisation d'un acteur sur l'étape courante d'une instance (E3) — pure.
 * Réutilise la couverture de portée de rbac.ts. Trois garanties portées ici :
 *  - l'acteur doit correspondre à l'assignation de l'étape (rôle / utilisateur / manager
 *    / portée organisationnelle), OU être le délégataire explicite de l'étape ;
 *  - séparation des tâches : le demandeur ne peut pas approuver sa propre demande quand
 *    l'étape l'exige (selfApprovalAllowed=false, défaut) ;
 *  - la délégation (action delegate) réassigne l'étape courante à un utilisateur précis.
 */
import { scopeCovers, type Scope, type ScopeType } from './rbac.ts';
import type { WorkflowStepDef, WorkflowContext } from './workflow-conditions.ts';

export interface ActorContext {
  userId: string;
  roleKeys: string[];
  scopes: Scope[];
}

export interface StepAssignmentContext {
  step: WorkflowStepDef;
  instanceContext: WorkflowContext;
  createdBy: string;
  /** Réassignation explicite de l'étape courante (action delegate) — prioritaire si posée. */
  delegatedToUserId?: string | null;
}

export type AuthzDecision = { allowed: true } | { allowed: false; reason: string };

/** L'acteur satisfait-il l'ASSIGNATION de l'étape (avant règle de séparation des tâches) ? */
export function matchesAssignment(actor: ActorContext, ctx: StepAssignmentContext): boolean {
  if (ctx.delegatedToUserId) {
    return actor.userId === ctx.delegatedToUserId;
  }
  const { step, instanceContext } = ctx;
  switch (step.approverType) {
    case 'user':
      return !!step.approverRef && actor.userId === step.approverRef;
    case 'role':
      return !!step.approverRef && actor.roleKeys.includes(step.approverRef);
    case 'manager': {
      const mgr = instanceContext['managerUserId'];
      return typeof mgr === 'string' && actor.userId === mgr;
    }
    case 'scope': {
      // approverRef = type de portée exigé ; la cible provient du contexte d'instance.
      const scopeType = (step.approverRef ?? '') as ScopeType;
      const ref = instanceContext['scopeRef'];
      const target =
        scopeType === 'tenant'
          ? undefined
          : typeof ref === 'string'
            ? { type: scopeType as Exclude<ScopeType, 'tenant'>, ref }
            : null;
      if (target === null) return false;
      return actor.scopes.some((s) => scopeCovers(s, target));
    }
    default:
      return false;
  }
}

/**
 * Décision complète pour une action DÉCISIONNELLE (approve/reject/return). L'anti-auto-
 * approbation s'applique à toutes : un demandeur ne statue pas sur sa propre demande
 * quand la séparation des tâches est exigée.
 */
export function canDecide(actor: ActorContext, ctx: StepAssignmentContext): AuthzDecision {
  if (!matchesAssignment(actor, ctx)) {
    return { allowed: false, reason: 'acteur non assigné à cette étape' };
  }
  const selfAllowed = ctx.step.selfApprovalAllowed === true;
  if (!selfAllowed && actor.userId === ctx.createdBy) {
    return { allowed: false, reason: 'séparation des tâches : auto-approbation interdite' };
  }
  // Exclusion EXPLICITE portée par le contexte d'instance (E11.2) : le
  // BÉNÉFICIAIRE d'une demande déposée pour lui par un tiers ne statue pas
  // dessus, même s'il tient le rôle approbateur. Opt-in : absente du contexte,
  // la règle ne change rien aux circuits existants.
  const excluded = ctx.instanceContext['excludedDeciderUserIds'];
  if (Array.isArray(excluded) && excluded.some((u) => u === actor.userId)) {
    return { allowed: false, reason: 'séparation des tâches : demandeur ou bénéficiaire exclu de la décision' };
  }
  return { allowed: true };
}

/** Seul un acteur assigné à l'étape courante peut la déléguer. */
export function canDelegate(actor: ActorContext, ctx: StepAssignmentContext): AuthzDecision {
  return matchesAssignment(actor, ctx)
    ? { allowed: true }
    : { allowed: false, reason: 'seul un acteur assigné peut déléguer' };
}
