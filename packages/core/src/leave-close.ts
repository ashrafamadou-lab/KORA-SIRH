/**
 * E11.3 — Clôture des congés et préparation paie : domaine PUR (aucune E/S).
 *
 * Ici vivent : l'empreinte SHA-256 REPRODUCTIBLE d'une clôture (forme canonique
 * des lignes figées — deux calculs sur les mêmes lignes donnent la même
 * empreinte), le catalogue FERMÉ des catégories préparatoires paie, l'agrégat
 * des variables préparatoires depuis les faits d'absence appliqués, et le garde
 * ANTI-MONTANT : un export préparatoire ne porte JAMAIS un salaire, un taux,
 * un montant ou une retenue — le contrat le refuse par construction.
 */
import { createHash } from 'node:crypto';

export const LEAVE_CLOSE_ENGINE_VERSION = 'kora-leave-close-1.0.0';
export const LEAVE_PREP_SCHEMA_VERSION = 'kora-conges-prep-1';

// ---------------------------------------------------------------------------
// Catégories préparatoires paie — catalogue FERMÉ (configuré sur le type).
// ---------------------------------------------------------------------------
export const PREP_CATEGORIES = [
  'conge_paye', 'absence_autorisee_payee', 'sans_solde', 'maladie',
  'maternite_paternite', 'accident_travail', 'mission_formation',
  'non_autorisee', 'repos_compensateur', 'autre',
] as const;
export type PrepCategory = typeof PREP_CATEGORIES[number];

export function isPrepCategory(v: unknown): v is PrepCategory {
  return typeof v === 'string' && (PREP_CATEGORIES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Empreinte de clôture : forme canonique des lignes FIGÉES, triée, hachée.
// ---------------------------------------------------------------------------
export interface CloseLine {
  employeeId: string;
  absenceTypeId: string;
  periodStart: string;      // AAAA-MM-JJ (période de référence du droit)
  accrued: number;
  adjustedOut: number;
  carriedIn: number;
  expired: number;
  reserved: number;
  consumed: number;
  available: number;
  unit: string;
  movements: number;
}

const q3 = (n: number): string => (Math.round(n * 1000) / 1000).toFixed(3);

/** Forme canonique d'UNE ligne — stable quel que soit l'ordre d'arrivée. */
export function canonicalCloseLine(l: CloseLine): string {
  return [
    l.employeeId, l.absenceTypeId, l.periodStart,
    q3(l.accrued), q3(l.adjustedOut), q3(l.carriedIn), q3(l.expired),
    q3(l.reserved), q3(l.consumed), q3(l.available), l.unit, String(l.movements),
  ].join('|');
}

/**
 * Empreinte SHA-256 de la clôture : lignes triées par (salarié, type, période),
 * jointes par saut de ligne, préfixées de la version du moteur. REPRODUCTIBLE :
 * recalculer depuis les lignes figées redonne EXACTEMENT l'empreinte stockée.
 */
export function closeFingerprint(lines: readonly CloseLine[]): string {
  const sorted = [...lines].sort((a, b) =>
    a.employeeId.localeCompare(b.employeeId)
    || a.absenceTypeId.localeCompare(b.absenceTypeId)
    || a.periodStart.localeCompare(b.periodStart));
  const body = [LEAVE_CLOSE_ENGINE_VERSION, ...sorted.map(canonicalCloseLine)].join('\n');
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Variables préparatoires paie : agrégat des FAITS D'ABSENCE appliqués.
// ---------------------------------------------------------------------------
export interface AppliedFactLike {
  employeeId: string;
  category: string;         // catégorie préparatoire (catalogue fermé)
  paid: boolean;
  unit: string;             // unité du décompte d'origine
  counted: number;          // quantité décomptée pour la journée
  minutes: number | null;   // portion « heures » uniquement
  superseded: boolean;      // un fait supersédé compte en correction, jamais en volume
}

export interface PrepEmployeeVariables {
  employeeId: string;
  /** category → { jours, heures } — volumes des faits ACTIFS uniquement. */
  categories: Record<string, { days: number; hours: number }>;
  correctionsCount: number; // faits supersédés (annulations/corrections appliquées)
}

export function prepVariables(facts: readonly AppliedFactLike[]): PrepEmployeeVariables[] {
  const byEmp = new Map<string, PrepEmployeeVariables>();
  for (const f of facts) {
    let e = byEmp.get(f.employeeId);
    if (!e) {
      e = { employeeId: f.employeeId, categories: {}, correctionsCount: 0 };
      byEmp.set(f.employeeId, e);
    }
    if (f.superseded) {
      e.correctionsCount += 1;
      continue;
    }
    const cat = isPrepCategory(f.category) ? f.category : 'autre';
    const slot = e.categories[cat] ?? { days: 0, hours: 0 };
    if (f.unit === 'hours') slot.hours = round3(slot.hours + f.counted);
    else if (f.minutes !== null) slot.hours = round3(slot.hours + f.minutes / 60);
    else slot.days = round3(slot.days + f.counted);
    e.categories[cat] = slot;
  }
  return [...byEmp.values()].sort((a, b) => a.employeeId.localeCompare(b.employeeId));
}

// ---------------------------------------------------------------------------
// Garde ANTI-MONTANT : le contrat préparatoire refuse toute clé financière.
// ---------------------------------------------------------------------------
const FORBIDDEN_KEY = /(montant|salaire|taux|net|brut|retenue|majoration|amount|rate|salary|wage|deduction)/i;

/** Balaye récursivement les CLÉS d'un objet : une clé financière = refus explicite. */
export function assertNoAmounts(value: unknown, path = ''): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const err = assertNoAmounts(value[i], `${path}[${i}]`);
      if (err) return err;
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEY.test(k)) return `clé financière interdite dans un export préparatoire : ${path}.${k}`;
      const err = assertNoAmounts(v, `${path}.${k}`);
      if (err) return err;
    }
  }
  return null;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Taux d'utilisation SÛRE (jamais une division par zéro maquillée). */
export function utilizationRate(consumed: number, accrued: number): number | null {
  if (accrued <= 0) return null;
  return Math.round((consumed / accrued) * 1000) / 1000;
}
