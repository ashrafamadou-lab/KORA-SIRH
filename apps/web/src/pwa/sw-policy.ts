/**
 * POLITIQUE de cache du service worker (E7) — fonction PURE, testée en CI.
 *
 * Règle de protection des données (non négociable) :
 *  - /api/*  ⇒ network-only : AUCUNE réponse API n'entre JAMAIS dans un cache —
 *    dossiers salariés, données personnelles, audit, paramètres juridiques, workflow,
 *    utilisateurs et notifications restent introuvables hors connexion.
 *  - navigations ⇒ coquille (index.html) depuis le cache, réseau en arrière-plan.
 *  - assets STATIQUES précachés (shell) ⇒ cache-first.
 *  - tout le reste ⇒ réseau, sans mise en cache.
 */
export type FetchStrategy = 'network-only' | 'shell' | 'static-cache' | 'network-pass';

export interface PolicyInput {
  url: string;             // URL absolue de la requête
  mode: string;            // Request.mode ('navigate' pour les navigations)
  origin: string;          // origine de l'application
  precached: readonly string[]; // chemins précachés ('/index.html', '/app/main.js', …)
}

export function decideStrategy(input: PolicyInput): FetchStrategy {
  let u: URL;
  try {
    u = new URL(input.url);
  } catch {
    return 'network-pass';
  }
  // Toute API — même origine ou non — reste STRICTEMENT réseau.
  if (u.pathname.startsWith('/api/')) return 'network-only';
  if (u.origin !== input.origin) return 'network-pass';
  if (input.mode === 'navigate') return 'shell';
  if (input.precached.includes(u.pathname)) return 'static-cache';
  return 'network-pass';
}

/** Une réponse est-elle CACHABLE par le shell ? (jamais une réponse d'API) */
export function cacheAllowed(pathname: string, precached: readonly string[]): boolean {
  if (pathname.startsWith('/api/')) return false;
  return pathname === '/index.html' || pathname === '/' || precached.includes(pathname);
}
