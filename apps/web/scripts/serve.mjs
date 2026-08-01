/**
 * Serveur statique de RÉFÉRENCE de la PWA KORA (clôture Phase 1) — celui que les
 * tests navigateur exercent RÉELLEMENT, et le modèle documenté pour la production
 * (l'équivalent nginx figure au README).
 *
 *  - EN-TÊTES DE SÉCURITÉ appliqués côté serveur : CSP complète (frame-ancestors,
 *    object-src, base-uri…), anti-sniffing, anti-clickjacking, politique de référent,
 *    Permissions-Policy ; HSTS activable derrière TLS (KORA_HSTS=1).
 *  - PROXY /api → API KORA (KORA_API_TARGET), même origine : cookies HttpOnly
 *    SameSite=Strict et CSP connect-src 'self' fonctionnent sans exception.
 *  - Profils : développement (Secure/HSTS off) vs production (KORA_COOKIE_SECURE=1
 *    côté API + KORA_HSTS=1 ici, derrière TLS).
 *
 * Lancement : node apps/web/scripts/serve.mjs [port]
 *   KORA_API_TARGET=http://127.0.0.1:3000  (défaut)
 */
import { createServer, request as httpRequest } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(dirname(fileURLToPath(import.meta.url))), 'dist');
const port = Number(process.argv[2] ?? process.env.KORA_WEB_PORT ?? 8080);
const apiTarget = new URL(process.env.KORA_API_TARGET ?? 'http://127.0.0.1:3000');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

/** CSP de PRODUCTION servie par en-tête (la meta de la coquille est un simple filet). */
export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; " +
  "form-action 'self'; frame-ancestors 'none'; manifest-src 'self'; worker-src 'self'";

function securityHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (process.env.KORA_HSTS === '1') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

  // ---------- proxy même origine vers l'API ----------
  if (url.pathname.startsWith('/api/')) {
    const upstream = httpRequest({
      hostname: apiTarget.hostname,
      port: apiTarget.port,
      path: url.pathname + url.search,
      method: req.method,
      headers: { ...req.headers, host: apiTarget.host },
    }, (up) => {
      // Les en-têtes de l'API (Set-Cookie, CSP API, no-store…) passent tels quels.
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on('error', () => {
      securityHeaders(res);
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ statusCode: 503, message: 'API indisponible' }));
    });
    req.pipe(upstream);
    return;
  }

  // ---------- statique + coquille SPA ----------
  securityHeaders(res);
  let file = normalize(join(dist, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(dist)) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (!existsSync(file)) file = join(dist, 'index.html');
  const ext = extname(file);
  // index.html et sw.js toujours revalidés (détection de nouvelle version fiable) ;
  // les assets du shell sont gérés par le service worker lui-même.
  const cache = file.endsWith('index.html') || file.endsWith('sw.js') ? 'no-cache' : 'public, max-age=300';
  res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': cache });
  res.end(readFileSync(file));
});

server.listen(port, () => {
  console.log(`KORA PWA (production-ready) → http://127.0.0.1:${port}  |  proxy /api → ${apiTarget.origin}`);
});
