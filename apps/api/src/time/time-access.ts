/**
 * E10.1 — portées réelles du module temps (E2 × E8/E9), partagées entre services.
 * Même philosophie que le dossier salarié : la permission SANS portée ne donne rien,
 * la portée tenant donne tout, les portées fines (société/site/unité) FILTRENT les
 * données de pointage par l'affectation PRINCIPALE du salarié à la date de l'événement.
 */
import type { Prisma } from '@prisma/client';

export interface ScopeSet {
  kind: 'none' | 'all' | 'scoped';
  companies: string[];
  sites: string[];
  units: string[];
}

export async function scopeSetFor(
  tx: Prisma.TransactionClient, userId: string, permission: string,
): Promise<ScopeSet> {
  const perms = await tx.$queryRaw<Array<{ permission_key: string }>>`
    SELECT rp.permission_key FROM admin.user_roles ur
      JOIN admin.role_permissions rp ON rp.role_id = ur.role_id
     WHERE ur.user_id = ${userId}::uuid`;
  if (!perms.some((p) => p.permission_key === permission)) {
    return { kind: 'none', companies: [], sites: [], units: [] };
  }
  const scopes = await tx.$queryRaw<Array<{ scope_type: string; scope_ref: string | null }>>`
    SELECT scope_type, scope_ref FROM admin.user_scopes WHERE user_id = ${userId}::uuid`;
  if (scopes.some((s) => s.scope_type === 'tenant')) {
    return { kind: 'all', companies: [], sites: [], units: [] };
  }
  const companies = scopes.filter((s) => s.scope_type === 'legal_entity' && s.scope_ref).map((s) => s.scope_ref!);
  const sites = scopes.filter((s) => s.scope_type === 'site' && s.scope_ref).map((s) => s.scope_ref!);
  const units = scopes.filter((s) => (s.scope_type === 'department' || s.scope_type === 'team') && s.scope_ref).map((s) => s.scope_ref!);
  if (companies.length + sites.length + units.length === 0) {
    return { kind: 'none', companies: [], sites: [], units: [] };
  }
  return { kind: 'scoped', companies, sites, units };
}

/** Détention SIMPLE d'une permission (référentiels non sensibles : toute portée suffit). */
export async function holdsPermission(
  tx: Prisma.TransactionClient, userId: string, ...permissions: string[]
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ permission_key: string }>>`
    SELECT rp.permission_key FROM admin.user_roles ur
      JOIN admin.role_permissions rp ON rp.role_id = ur.role_id
     WHERE ur.user_id = ${userId}::uuid`;
  return permissions.some((p) => rows.some((r) => r.permission_key === p));
}

/** Fragment de filtre : le salarié (à la date) appartient-il au périmètre ? */
export function scopeCsv(set: ScopeSet): { companies: string; sites: string; units: string } {
  return { companies: set.companies.join(','), sites: set.sites.join(','), units: set.units.join(',') };
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{0,29}$/;

export type TimeOutcome<T> =
  | ({ kind: 'ok' } & T)
  | { kind: 'forbidden'; reason: string }
  | { kind: 'not_found' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'conflict'; reason: string };
