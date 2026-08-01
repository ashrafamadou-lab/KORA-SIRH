/**
 * Résolution RBAC bornée par portées (US-E2-02/03, Blueprint §6-7).
 * Règles : cumul de rôles = union des permissions ; AUCUNE permission n'outrepasse la
 * portée ; sans portée couvrante, la permission ne s'applique pas (anti-élévation).
 * v1 : couverture = portée « tenant » (tout) ou correspondance exacte type+réf ; la
 * couverture hiérarchique (site ⊃ département ⊃ équipe) arrive avec le module
 * Organisation, derrière la même interface.
 */
export type ScopeType = 'tenant' | 'legal_entity' | 'site' | 'department' | 'team';

export interface Scope {
  type: ScopeType;
  /** Obligatoire sauf pour la portée « tenant ». */
  ref?: string | null;
}

export interface ScopeTarget {
  type: Exclude<ScopeType, 'tenant'>;
  ref: string;
}

export interface RoleGrant {
  roleKey: string;
  permissions: Iterable<string>;
}

export interface PrincipalAccess {
  roles: RoleGrant[];
  scopes: Scope[];
}

/** Cumul de rôles : union simple des permissions (chaque usage reste borné par portée). */
export function unionPermissions(roles: RoleGrant[]): Set<string> {
  const out = new Set<string>();
  for (const role of roles) for (const p of role.permissions) out.add(p);
  return out;
}

export function scopeCovers(scope: Scope, target?: ScopeTarget): boolean {
  if (scope.type === 'tenant') return true;
  if (!target) return false; // une action de niveau tenant exige la portée tenant
  if (scope.ref == null) return false;
  return scope.type === target.type && scope.ref === target.ref;
}

/**
 * Le principal peut-il exercer `permission` sur `target` ?
 * target absent = action de niveau tenant (ex. gérer la configuration).
 */
export function can(
  access: PrincipalAccess,
  permission: string,
  target?: ScopeTarget,
): boolean {
  if (!unionPermissions(access.roles).has(permission)) return false;
  return access.scopes.some((scope) => scopeCovers(scope, target));
}
