/**
 * Jetons de session opaques (US-E1-03).
 * Format : k1.<tenant-uuid>.<aléa base64url 256 bits>
 * - le tenant voyage dans le jeton (identifiant non secret) pour poser le contexte RLS
 *   AVANT la recherche en base — la base ne stocke que l'empreinte SHA-256 du jeton ;
 * - expiration absolue + inactivité + révocation : sessionStatus() est la seule règle.
 */
import { createHash, randomBytes } from 'node:crypto';

export const TOKEN_PREFIX = 'k1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_SECRET_LENGTH = 32; // 256 bits → 43 caractères base64url ; garde large

export interface MintedToken {
  token: string;
  tokenHash: string;
}

export function mintSessionToken(
  tenantId: string,
  rand: (n: number) => Buffer = randomBytes,
): MintedToken {
  if (!UUID_RE.test(tenantId)) throw new Error('mintSessionToken : tenantId invalide');
  const secret = rand(32).toString('base64url');
  const token = `${TOKEN_PREFIX}.${tenantId.toLowerCase()}.${secret}`;
  return { token, tokenHash: hashSessionToken(token) };
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function parseSessionToken(token: string): { tenantId: string } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [prefix, tenantId, secret] = parts as [string, string, string];
  if (prefix !== TOKEN_PREFIX) return null;
  if (!UUID_RE.test(tenantId)) return null;
  if (secret.length < MIN_SECRET_LENGTH) return null;
  return { tenantId: tenantId.toLowerCase() };
}

export interface SessionState {
  createdAtMs: number;
  lastSeenAtMs: number;
  expiresAtMs: number;
  revokedAtMs?: number | null;
}

export type SessionStatus = 'active' | 'revoked' | 'expired' | 'idle_timeout';

export function sessionStatus(
  s: SessionState,
  nowMs: number,
  idleMaxSeconds: number,
): SessionStatus {
  if (typeof s.revokedAtMs === 'number') return 'revoked';
  if (nowMs >= s.expiresAtMs) return 'expired';
  if (nowMs - s.lastSeenAtMs > idleMaxSeconds * 1000) return 'idle_timeout';
  return 'active';
}
