/**
 * E11.1 — Accès partagés du module congés : portées réelles (réutilise le socle
 * temps E10), équipe du responsable RÉSOLU (E9 : dérogation explicite ou structure
 * des postes), salarié lié, résolution E4 à une date avec PROVENANCE.
 */
import { Prisma } from '@prisma/client';

export { DATE_RE, UUID_RE, holdsPermission, scopeSetFor, type ScopeSet, type TimeOutcome } from '../time/time-access';

/** Pays d'exploitation v1 — même convention que la résolution E4 du module temps (documentée au README). */
export const OPERATING_COUNTRY = 'BJ';

/** Salarié lié au compte (ESS). */
export async function linkedEmployee(tx: Prisma.TransactionClient, userId: string): Promise<string | null> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM core.employees WHERE user_id = ${userId}::uuid AND deleted_at IS NULL`;
  return rows[0]?.id ?? null;
}

/**
 * Salariés dont l'acteur est le RESPONSABLE résolu à la date : dérogation
 * managériale explicite OU occupation du poste responsable (structure E8/E9).
 */
export async function teamEmployeeIds(
  tx: Prisma.TransactionClient, actorUserId: string, date: string,
): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    WITH me AS (
      SELECT id FROM core.employees WHERE user_id = ${actorUserId}::uuid AND deleted_at IS NULL
    ), my_positions AS (
      SELECT a.position_id FROM core.employee_assignments a JOIN me ON a.employee_id = me.id
       WHERE a.is_primary AND a.position_id IS NOT NULL
         AND daterange(a.effective_from, a.effective_to, '[)') @> ${date}::date
    )
    SELECT DISTINCT e.id
      FROM core.employees e
      JOIN core.employee_assignments a ON a.employee_id = e.id AND a.is_primary
       AND daterange(a.effective_from, a.effective_to, '[)') @> ${date}::date
     WHERE e.deleted_at IS NULL
       AND (a.manager_override_employee_id IN (SELECT id FROM me)
         OR (a.position_id IS NOT NULL
             AND org.position_manager_at(a.position_id, ${date}::date) IN (SELECT position_id FROM my_positions)))`;
  return rows.map((r) => r.id);
}

export interface ParamProvenance {
  value: unknown;
  parameterId: string | null;
  effectiveFrom: string | null;
  source: 'parametre' | 'absent';
}

/** Résolution E4 d'un lot de clés À UNE DATE — provenance exacte, jamais de défaut. */
export async function paramsAt(
  tx: Prisma.TransactionClient, tenantId: string, date: string, keys: string[],
): Promise<Record<string, ParamProvenance>> {
  if (keys.length === 0) return {};
  const rows = await tx.$queryRaw<Array<{ key: string; parameter_id: string | null; value: unknown; effective_from: string | null }>>`
    SELECT k.key, p.parameter_id, p.value, p.effective_from::text
      FROM unnest(string_to_array(${keys.join(',')}, ',')) AS k(key)
      LEFT JOIN LATERAL compliance.parameter_value_at(k.key, ${OPERATING_COUNTRY}::char(2), ${tenantId}::uuid, ${date}::date) p ON true`;
  const out: Record<string, ParamProvenance> = {};
  for (const r of rows) {
    out[r.key] = r.parameter_id
      ? { value: r.value, parameterId: r.parameter_id, effectiveFrom: r.effective_from, source: 'parametre' }
      : { value: null, parameterId: null, effectiveFrom: null, source: 'absent' };
  }
  return out;
}

export function numericParam(p: ParamProvenance | undefined): number | null {
  if (!p || p.source !== 'parametre') return null;
  const v = p.value;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}
