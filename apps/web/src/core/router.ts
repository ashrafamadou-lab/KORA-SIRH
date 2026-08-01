/**
 * Routeur à fragments (#/chemin) — aucun besoin de réécriture serveur, compatible CSP
 * stricte et hébergement statique. Garde d'affichage : non authentifié ⇒ connexion ;
 * permission d'affichage manquante ⇒ écran « accès refusé » (le serveur reste seul juge).
 */
export interface RouteMatch {
  pattern: string;
  params: Record<string, string>;
  query: URLSearchParams;
}

export type RouteRender = (match: RouteMatch) => HTMLElement | Promise<HTMLElement>;

export interface RouteDef {
  pattern: string;          // '/employees/:id'
  render: RouteRender;
  public?: boolean;         // accessible sans session (connexion)
  anyOf?: string[];         // permissions d'AFFICHAGE
}

export function parseHash(hash: string): { path: string; query: URLSearchParams } {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const [path = '/', qs = ''] = raw.split('?');
  return { path: path === '' ? '/' : path, query: new URLSearchParams(qs) };
}

export function matchRoute(defs: readonly RouteDef[], path: string): { def: RouteDef; params: Record<string, string> } | null {
  const segments = path.split('/').filter((s) => s.length > 0);
  for (const def of defs) {
    const patternSegments = def.pattern.split('/').filter((s) => s.length > 0);
    if (patternSegments.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < patternSegments.length; i++) {
      const p = patternSegments[i]!;
      const s = segments[i]!;
      if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(s);
      else if (p !== s) { ok = false; break; }
    }
    if (ok) return { def, params };
  }
  return null;
}

export function navigate(path: string): void {
  location.hash = `#${path}`;
}
