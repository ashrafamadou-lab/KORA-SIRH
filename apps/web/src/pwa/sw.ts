/**
 * Service worker KORA (module ES) — shell UNIQUEMENT.
 * La liste précachée et la version sont injectées au build (sw-precache.js).
 * Les réponses /api ne sont JAMAIS mises en cache ni servies hors connexion.
 */
import { decideStrategy, cacheAllowed } from './sw-policy.js';
import { SW_VERSION, PRECACHE } from './sw-precache.js';

interface SWGlobal {
  addEventListener(type: string, listener: (event: never) => void): void;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  location: { origin: string };
}
declare const self: SWGlobal;

const CACHE_NAME = `kora-shell-${SW_VERSION}`;

interface InstallEvent { waitUntil(p: Promise<unknown>): void }
interface FetchLikeEvent {
  request: { url: string; mode: string; method: string };
  respondWith(r: Promise<Response> | Response): void;
  waitUntil(p: Promise<unknown>): void;
}
interface MessageLikeEvent { data?: { type?: string } }

self.addEventListener('install', (event: never) => {
  const e = event as InstallEvent;
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)),
  );
});

self.addEventListener('activate', (event: never) => {
  const e = event as InstallEvent;
  e.waitUntil(
    (async () => {
      // Purge des versions précédentes du shell (aucune donnée applicative dedans).
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event: never) => {
  const e = event as MessageLikeEvent;
  if (e.data?.type === 'SKIP_WAITING') void self.skipWaiting();
});

self.addEventListener('fetch', (event: never) => {
  const e = event as FetchLikeEvent;
  if (e.request.method !== 'GET') return; // jamais d'interception des écritures
  const strategy = decideStrategy({
    url: e.request.url,
    mode: e.request.mode,
    origin: self.location.origin,
    precached: PRECACHE,
  });
  if (strategy === 'network-only' || strategy === 'network-pass') {
    return; // le réseau tranche ; hors connexion, l'échec remonte à l'application
  }
  if (strategy === 'shell') {
    e.respondWith(
      (async () => {
        try {
          return await fetch(e.request.url);
        } catch {
          const cached = await caches.match('/index.html');
          if (cached) return cached;
          return new Response('offline', { status: 503, headers: { 'content-type': 'text/plain' } });
        }
      })(),
    );
    return;
  }
  // static-cache : cache d'abord, réseau en secours, re-remplissage contrôlé.
  e.respondWith(
    (async () => {
      const cached = await caches.match(e.request.url);
      if (cached) return cached;
      const res = await fetch(e.request.url);
      const path = new URL(e.request.url).pathname;
      if (res.ok && cacheAllowed(path, PRECACHE)) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(e.request.url, res.clone());
      }
      return res;
    })(),
  );
});
