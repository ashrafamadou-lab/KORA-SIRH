/**
 * Limitation de débit à fenêtre glissante — pur et déterministe (horloge fournie).
 * v1 : état en mémoire du processus (monolithe mono-instance) ; le passage multi-
 * instances déplacera l'état vers Redis derrière la même interface (Blueprint §11.3).
 */
export interface RateLimitPolicy {
  windowMs: number;
  max: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** Secondes avant la prochaine tentative admise (0 si allowed). */
  retryAfterSeconds: number;
  remaining: number;
}

export type RateLimitState = Map<string, number[]>;

export function hit(
  state: RateLimitState,
  key: string,
  nowMs: number,
  policy: RateLimitPolicy,
): RateLimitVerdict {
  const cutoff = nowMs - policy.windowMs;
  const kept = (state.get(key) ?? []).filter((t) => t > cutoff);
  if (kept.length >= policy.max) {
    state.set(key, kept);
    const oldest = kept[0]!;
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + policy.windowMs - nowMs) / 1000)),
      remaining: 0,
    };
  }
  kept.push(nowMs);
  state.set(key, kept);
  return { allowed: true, retryAfterSeconds: 0, remaining: policy.max - kept.length };
}

/** Purge périodique des clés inactives (évite la croissance mémoire sans borne). */
export function prune(state: RateLimitState, nowMs: number, policy: RateLimitPolicy): void {
  const cutoff = nowMs - policy.windowMs;
  for (const [key, times] of state) {
    const kept = times.filter((t) => t > cutoff);
    if (kept.length === 0) state.delete(key);
    else state.set(key, kept);
  }
}
