/**
 * Verrouillage progressif après échecs de connexion (US-E1-01).
 * Pur et déterministe : l'état (compteur, échéance) vit en base (admin.users),
 * la politique vit ici.
 */
export interface LockoutPolicy {
  /** Nombre d'échecs tolérés avant le premier verrouillage. */
  threshold: number;
  baseSeconds: number;
  factor: number;
  maxSeconds: number;
}

export const DEFAULT_LOCKOUT_POLICY: LockoutPolicy = {
  threshold: 5,
  baseSeconds: 30,
  factor: 2,
  maxSeconds: 900,
};

/** Durée de verrouillage (s) après `failedCount` échecs consécutifs — 0 sous le seuil. */
export function lockDelaySeconds(
  failedCount: number,
  policy: LockoutPolicy = DEFAULT_LOCKOUT_POLICY,
): number {
  if (!Number.isFinite(failedCount) || failedCount < policy.threshold) return 0;
  const exponent = failedCount - policy.threshold;
  return Math.min(policy.baseSeconds * policy.factor ** exponent, policy.maxSeconds);
}

/** Échéance de verrouillage (epoch ms) après un nouvel échec, ou null si pas de verrou. */
export function lockedUntilMs(
  failedCount: number,
  nowMs: number,
  policy: LockoutPolicy = DEFAULT_LOCKOUT_POLICY,
): number | null {
  const delay = lockDelaySeconds(failedCount, policy);
  return delay === 0 ? null : nowMs + delay * 1000;
}

export function isLocked(lockedUntil: number | null | undefined, nowMs: number): boolean {
  return typeof lockedUntil === 'number' && lockedUntil > nowMs;
}
