/**
 * Politique du service worker (E7) — la garantie CENTRALE de protection des données :
 * AUCUNE réponse /api (dossiers salariés, zones personnelles, audit, workflow,
 * notifications, utilisateurs, paramètres) n'entre jamais dans un cache, et rien de
 * tout cela n'est disponible hors connexion. Vérifie aussi le sw.js ASSEMBLÉ.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cacheAllowed, decideStrategy } from '../src/pwa/sw-policy.ts';

const ORIGIN = 'https://kora.example';
const PRECACHE = ['/', '/index.html', '/theme.css', '/app/main.js', '/icons/icon-192.png'];

const SENSITIVE_API_PATHS = [
  '/api/v1/employees',
  '/api/v1/employees/123/private',
  '/api/v1/employees/123/identifiers',
  '/api/v1/employees/123/documents',
  '/api/v1/employees/123/career',
  '/api/v1/audit/events',
  '/api/v1/audit/export/csv',
  '/api/v1/config/parameters/resolve',
  '/api/v1/workflow/instances',
  '/api/v1/admin/users',
  '/api/v1/notifications',
  '/api/v1/auth/sessions',
];

test('toute URL /api est STRICTEMENT réseau — jamais de cache, jamais de repli hors-ligne', () => {
  for (const path of SENSITIVE_API_PATHS) {
    const strategy = decideStrategy({ url: `${ORIGIN}${path}`, mode: 'cors', origin: ORIGIN, precached: PRECACHE });
    assert.equal(strategy, 'network-only', `${path} doit être network-only`);
    assert.equal(cacheAllowed(path, PRECACHE), false, `${path} ne doit JAMAIS être cachable`);
  }
  // même une navigation forcée vers /api reste réseau
  assert.equal(decideStrategy({ url: `${ORIGIN}/api/v1/employees`, mode: 'navigate', origin: ORIGIN, precached: PRECACHE }), 'network-only');
});

test('navigations → coquille ; assets précachés → cache ; le reste → réseau', () => {
  assert.equal(decideStrategy({ url: `${ORIGIN}/`, mode: 'navigate', origin: ORIGIN, precached: PRECACHE }), 'shell');
  assert.equal(decideStrategy({ url: `${ORIGIN}/app/main.js`, mode: 'no-cors', origin: ORIGIN, precached: PRECACHE }), 'static-cache');
  assert.equal(decideStrategy({ url: `${ORIGIN}/inconnu.bin`, mode: 'no-cors', origin: ORIGIN, precached: PRECACHE }), 'network-pass');
  assert.equal(decideStrategy({ url: 'https://autre-origine.example/x.js', mode: 'no-cors', origin: ORIGIN, precached: PRECACHE }), 'network-pass');
});

test('le sw.js ASSEMBLÉ ne précache aucune URL /api et reste un fichier classique autonome', (tc) => {
  const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
  if (!existsSync(join(dist, 'sw.js'))) {
    tc.skip('dist/sw.js absent — lancer scripts/build.mjs d’abord (fait en CI)');
    return;
  }
  const sw = readFileSync(join(dist, 'sw.js'), 'utf8');
  const precacheMatch = /const PRECACHE = (\[[^\]]*\]);/.exec(sw);
  assert.ok(precacheMatch, 'liste PRECACHE présente');
  const list = JSON.parse(precacheMatch![1]!) as string[];
  assert.ok(list.length >= 3, 'le shell est précaché');
  for (const entry of list) {
    assert.ok(!entry.startsWith('/api'), `entrée précachée interdite : ${entry}`);
    // Seuls des ASSETS de coquille sont cachables — jamais un chemin de données.
    assert.ok(entry === '/' || /\.(js|css|html|png|webmanifest)$/.test(entry),
      `entrée précachée d'un type inattendu : ${entry}`);
  }
  assert.ok(!/^import /m.test(sw), 'aucun import résiduel (fichier classique)');
  assert.ok(!/localStorage|indexedDB|sessionStorage/i.test(sw), 'le SW ne touche à aucun stockage applicatif');
  assert.ok(sw.includes('network-only'), 'politique réseau embarquée');
});

test('le manifeste construit est valide et les icônes existent en PNG', (tc) => {
  const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
  if (!existsSync(join(dist, 'manifest.webmanifest'))) {
    tc.skip('dist absent — build requis (fait en CI)');
    return;
  }
  const mf = JSON.parse(readFileSync(join(dist, 'manifest.webmanifest'), 'utf8')) as {
    name: string; short_name: string; start_url: string; scope: string; display: string;
    icons: Array<{ src: string; sizes: string; type: string; purpose?: string }>;
  };
  assert.equal(mf.short_name, 'KORA');
  assert.equal(mf.display, 'standalone');
  assert.ok(mf.start_url.length > 0 && mf.scope.length > 0);
  const purposes = new Set(mf.icons.map((i) => i.purpose ?? 'any'));
  assert.ok(purposes.has('any') && purposes.has('maskable'), 'icônes any + maskable requises');
  for (const icon of mf.icons) {
    const file = join(dist, icon.src.replace('./', ''));
    assert.ok(existsSync(file), `icône manquante : ${icon.src}`);
    const png = readFileSync(file);
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${icon.src} n'est pas un PNG valide`);
  }
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  assert.ok(html.includes('Content-Security-Policy'), 'CSP présente dans la coquille');
  assert.ok(html.includes("default-src 'self'"), 'CSP restrictive');
  assert.ok(!/<script(?![^>]*src=)/.test(html), 'aucun script inline (CSP)');
});
