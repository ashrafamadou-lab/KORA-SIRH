/**
 * E12.1 — Accès partagés du module paie.
 *
 * La résolution E4 y est plus exigeante qu'ailleurs : une valeur de paie porte
 * sa PROVENANCE COMPLÈTE (identifiant de version, date d'effet, source, référence
 * légale, contreseing) parce qu'un bulletin doit rester juridiquement traçable.
 * Une clé introuvable ne renvoie AUCUNE valeur — le calcul s'arrête.
 */
import { Prisma } from '@prisma/client';
import type { ParamProvenanceUsed } from '../../../../packages/core/src/payroll.ts';

export { DATE_RE, UUID_RE, holdsPermission, type TimeOutcome } from '../time/time-access';
export { OPERATING_COUNTRY } from '../leave/leave-access';
export { pgCode } from '../leave/leave-access';

export interface PayrollParam extends ParamProvenanceUsed {
  unit: string | null;
  legalRef: string | null;
  sourceText: string | null;
  verified: boolean;
}

/**
 * Résout un lot de clés E4 À LA DATE DE PAIE, en une requête, avec provenance.
 * Une clé absente reste ABSENTE de la table : aucun défaut n'est inventé.
 */
export async function payrollParamsAt(
  tx: Prisma.TransactionClient, tenantId: string, country: string, payDate: string, keys: string[],
): Promise<Record<string, PayrollParam>> {
  const out: Record<string, PayrollParam> = {};
  if (keys.length === 0) return out;
  const rows = await tx.$queryRaw<Array<{
    key: string; parameter_id: string | null; value: unknown; unit: string | null;
    effective_from: string | null; source_text: string | null; legal_ref: string | null;
    verified_by: string | null;
  }>>`
    SELECT k.key, p.parameter_id, p.value, p.unit, p.effective_from::text, p.source_text, p.legal_ref,
           lp.verified_by::text
      FROM unnest(string_to_array(${[...new Set(keys)].join(',')}, ',')) AS k(key)
      LEFT JOIN LATERAL compliance.parameter_value_at(k.key, ${country}::char(2), ${tenantId}::uuid, ${payDate}::date) p ON true
      LEFT JOIN compliance.legal_parameters lp ON lp.id = p.parameter_id`;
  for (const r of rows) {
    if (!r.parameter_id) continue;                       // absente : jamais de repli
    const raw = r.value;
    const num = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    if (!Number.isFinite(num)) continue;                 // non numérique : inutilisable en paie
    out[r.key] = {
      key: r.key, value: num, parameterId: r.parameter_id,
      effectiveFrom: r.effective_from, source: r.source_text ? 'parametre' : 'parametre',
      unit: r.unit, legalRef: r.legal_ref, sourceText: r.source_text,
      verified: r.verified_by !== null,
    };
  }
  return out;
}

/** Décimales d'ARRONDI monétaire : un paramètre E4, jamais une constante du code. */
export const ROUNDING_PARAM_KEY = 'paie.arrondi.decimales';

/** Mois entiers révolus entre deux dates (ancienneté) — arithmétique pure. */
export function monthsBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number];
  let months = (ty - fy) * 12 + (tm - fm);
  if (td < fd) months -= 1;
  return Math.max(0, months);
}

/** Nombre de journées calendaires d'une période, bornes incluses. */
export function calendarDays(from: string, to: string): number {
  // Date.UTC attend un mois INDEXÉ À ZÉRO : sans le décalage, deux mois de
  // longueurs différentes fausseraient l'écart (31/01 → 01/02 donnerait −2).
  const utc = (d: string): number => {
    const [y, m, day] = d.split('-').map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, day);
  };
  return Math.round((utc(to) - utc(from)) / 86400000) + 1;
}
