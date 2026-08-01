/**
 * Cycle de vie d'une version de paramètre (E4) — pur et déterministe.
 * États : draft → submitted → approved → (active | scheduled) → superseded ;
 *         submitted/approved → rejected ; toute version non active → retired ;
 *         scheduled → active (à l'arrivée de la date d'effet).
 * La résolution officielle (SQL) ne considère que active / scheduled / superseded.
 */
export type ParameterStatus =
  | 'draft'
  | 'submitted'
  | 'approved'
  | 'scheduled'
  | 'active'
  | 'superseded'
  | 'rejected'
  | 'retired';

/** Statuts « dans la ligne de temps » : les seuls que le moteur de résolution regarde. */
export const RESOLVABLE_STATUSES: ReadonlySet<ParameterStatus> = new Set([
  'active',
  'scheduled',
  'superseded',
]);

const ALLOWED: Record<ParameterStatus, ParameterStatus[]> = {
  draft: ['submitted', 'retired'],
  submitted: ['approved', 'rejected', 'draft'], // draft = retour au demandeur / resoumission
  approved: ['active', 'scheduled', 'rejected'],
  scheduled: ['active', 'retired'],
  active: ['superseded', 'retired'],
  superseded: ['retired'],
  rejected: ['draft'], // resoumission : repart d'un draft
  retired: [],
};

export function canTransition(from: ParameterStatus, to: ParameterStatus): boolean {
  return ALLOWED[from]?.includes(to) ?? false;
}

/** Le contenu (valeur, dates, source) est modifiable uniquement en draft. */
export function isContentEditable(status: ParameterStatus): boolean {
  return status === 'draft';
}

/**
 * À l'activation d'une version approuvée : « active » si sa date d'effet est atteinte,
 * « scheduled » si elle est dans le futur (ne devient pas active avant sa date d'effet).
 */
export function activationStatusFor(effectiveFrom: string, today: string): 'active' | 'scheduled' {
  return effectiveFrom <= today ? 'active' : 'scheduled';
}

export interface SeparationContext {
  createdBy: string;
  actorUserId: string;
  isLegalSensitive: boolean;
}

/**
 * Séparation des tâches à l'activation : pour un paramètre juridique sensible, le créateur
 * ne peut pas activer seul son propre paramètre (le contreseing via workflow a déjà exigé
 * un approbateur distinct ; l'activation exige encore un acteur ≠ créateur).
 */
export function activationAllowed(ctx: SeparationContext): { allowed: boolean; reason?: string } {
  if (ctx.isLegalSensitive && ctx.actorUserId === ctx.createdBy) {
    return { allowed: false, reason: 'séparation des tâches : le créateur ne peut pas activer son paramètre juridique' };
  }
  return { allowed: true };
}
