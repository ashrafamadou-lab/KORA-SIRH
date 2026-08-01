/**
 * Machine à états du Workflow Engine (E3) — pure et déterministe.
 * Le service SQL orchestre (verrous, RLS, persistance) ; ici vit la seule vérité sur
 * « quelle action est permise depuis quel état, et vers quel état elle mène ».
 */
export type WorkflowStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'returned'
  | 'cancelled'
  | 'expired';

export type WorkflowAction =
  | 'approve'
  | 'reject'
  | 'return'
  | 'cancel'
  | 'delegate'
  | 'escalate'
  | 'remind';

export const TERMINAL_STATUSES: ReadonlySet<WorkflowStatus> = new Set([
  'approved',
  'rejected',
  'cancelled',
  'expired',
]);

export function isTerminal(status: WorkflowStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export interface TransitionInput {
  status: WorkflowStatus;
  action: WorkflowAction;
  /** Vrai si l'étape courante est la dernière étape EFFECTIVE (branches sautées exclues). */
  isLastEffectiveStep: boolean;
}

export type TransitionResult =
  | { ok: true; nextStatus: WorkflowStatus; advancesStep: boolean }
  | { ok: false; reason: string };

/**
 * Résout une action. Règles :
 * - approve sur la dernière étape effective → approved ; sinon reste pending et avance.
 * - reject → rejected ; return → returned (renvoi au demandeur) ; cancel → cancelled.
 * - delegate / remind / escalate ne changent pas le statut ni l'étape (effets latéraux
 *   gérés par le service : réassignation, notification, réassignation d'approbateur).
 * - Aucune action (hors rien) n'est permise sur un état terminal.
 */
export function resolveTransition(input: TransitionInput): TransitionResult {
  const { status, action, isLastEffectiveStep } = input;

  if (isTerminal(status)) {
    return { ok: false, reason: `état terminal ${status} : aucune action possible` };
  }

  // 'returned' est un état non terminal : seules la re-soumission (hors machine, via submit)
  // ou l'annulation s'y appliquent.
  if (status === 'returned') {
    if (action === 'cancel') return { ok: true, nextStatus: 'cancelled', advancesStep: false };
    return { ok: false, reason: `action ${action} interdite sur un dossier retourné` };
  }

  // status === 'pending'
  switch (action) {
    case 'approve':
      return isLastEffectiveStep
        ? { ok: true, nextStatus: 'approved', advancesStep: false }
        : { ok: true, nextStatus: 'pending', advancesStep: true };
    case 'reject':
      return { ok: true, nextStatus: 'rejected', advancesStep: false };
    case 'return':
      return { ok: true, nextStatus: 'returned', advancesStep: false };
    case 'cancel':
      return { ok: true, nextStatus: 'cancelled', advancesStep: false };
    case 'delegate':
    case 'remind':
    case 'escalate':
      return { ok: true, nextStatus: 'pending', advancesStep: false };
    default:
      return { ok: false, reason: `action inconnue ${action as string}` };
  }
}
