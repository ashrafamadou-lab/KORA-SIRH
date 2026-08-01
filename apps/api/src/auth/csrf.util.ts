import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Anti-CSRF (clôture Phase 1) — pour l'authentification PAR COOKIE uniquement.
 *
 * Le jeton CSRF est DÉRIVÉ du jeton de session par HMAC-SHA256 (clé serveur) :
 * aucun état supplémentaire, aucune colonne, rotation automatique avec la session.
 * Il est remis au client par /auth/login (mode cookie) et /auth/me, gardé EN MÉMOIRE
 * par la PWA (jamais stocké), et exigé en entête X-KORA-CSRF sur toute écriture.
 * Un site tiers ne peut ni lire ce jeton (même origine requise pour lire la réponse),
 * ni poser l'entête (formulaires cross-site sans entêtes personnalisés ; XHR bloquée
 * par CORS). L'authentification Bearer n'est pas concernée : un entête Authorization
 * ne peut pas être forgé par un site tiers.
 */

export const CSRF_HEADER = 'x-kora-csrf';
export const SESSION_COOKIE = 'kora_session';

function key(): Buffer {
  const hex = process.env.KORA_MFA_KEY;
  if (!hex || hex.length < 32) {
    // Même exigence que le chiffrement MFA : la clé serveur est obligatoire.
    throw new Error('KORA_MFA_KEY absente : impossible de dériver les jetons CSRF');
  }
  return Buffer.from(hex, 'hex');
}

export function csrfTokenFor(sessionToken: string): string {
  return createHmac('sha256', key()).update(`kora-csrf-v1|${sessionToken}`).digest('hex').slice(0, 48);
}

export function csrfTokenValid(sessionToken: string, presented: string | undefined): boolean {
  if (!presented) return false;
  const expected = Buffer.from(csrfTokenFor(sessionToken));
  const given = Buffer.from(presented);
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

/** Extraction SANS dépendance du cookie de session depuis l'entête Cookie. */
export function sessionTokenFromCookieHeader(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      const value = part.slice(eq + 1).trim();
      return value.length > 0 ? decodeURIComponent(value) : null;
    }
  }
  return null;
}

/** Attributs du cookie de session — Secure activable en production. */
export function sessionCookie(token: string, maxAgeSeconds: number): string {
  const secure = process.env.KORA_COOKIE_SECURE === '1' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Max-Age=${Math.max(1, Math.floor(maxAgeSeconds))}; Path=/api; HttpOnly; SameSite=Strict${secure}`;
}

export function clearedSessionCookie(): string {
  const secure = process.env.KORA_COOKIE_SECURE === '1' ? '; Secure' : '';
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/api; HttpOnly; SameSite=Strict${secure}`;
}
