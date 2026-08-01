/**
 * Client API et session (clôture Phase 1) : cookie HttpOnly côté serveur — le client
 * ne détient AUCUN jeton de session ; CSRF en mémoire posé sur chaque écriture ;
 * 401 centralisé ⇒ purge ; Retry-After 429/423 ; 409/503 typés ; hors-ligne détecté ;
 * AUCUNE écriture dans les stockages du navigateur.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiClient, ApiError } from '../src/core/api.ts';
import { Session } from '../src/core/session.ts';

interface SeenRequest { url: string; method?: string; headers: Record<string, string>; body?: string; credentials?: string }

type Responder = (url: string, init: SeenRequest) => {
  status: number; body?: unknown; headers?: Record<string, string>;
};

function fakeFetch(responder: Responder, seen: SeenRequest[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const req: SeenRequest = {
      url: String(input),
      method: init?.method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : undefined,
      credentials: init?.credentials as string | undefined,
    };
    seen.push(req);
    const r = responder(req.url, req);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
    });
  }) as typeof fetch;
}

/** Stockages factices ESPIONS : le flux de session ne doit JAMAIS y écrire. */
function installStorageSpies(): { writes: string[] } {
  const writes: string[] = [];
  const spy = (name: string) => ({
    getItem: () => null,
    setItem: (k: string) => void writes.push(`${name}:${k}`),
    removeItem: () => undefined,
  });
  (globalThis as Record<string, unknown>)['sessionStorage'] = spy('session');
  (globalThis as Record<string, unknown>)['localStorage'] = {
    ...spy('local'),
    // le miroir de langue est le SEUL écrit toléré (non sensible)
    setItem: (k: string) => void (k === 'kora.locale' ? undefined : writes.push(`local:${k}`)),
  };
  return { writes };
}

const ME_BODY = {
  tenantId: 't', userId: 'u', sessionId: 's', email: 'a@b', permissions: ['employees.view'],
  scopes: [], roles: [], locale: 'fr', mfaEnabled: false, tenant: { slug: 'acme', name: 'ACME' },
  csrfToken: 'csrf-abc',
};

test('401 hors connexion attendue ⇒ rappel onUnauthorized (déconnexion immédiate centralisée)', async () => {
  let purged = 0;
  const api = new ApiClient({
    baseUrl: 'http://x/api/v1',
    onUnauthorized: () => { purged += 1; },
    fetchImpl: fakeFetch(() => ({ status: 401, body: { message: 'session revoquee' } })),
  });
  await assert.rejects(api.call('sessions'), (e: unknown) => (e as ApiError).kind === 'unauthorized');
  assert.equal(purged, 1, 'le 401 declenche la purge globale');
  await assert.rejects(api.call('login', { body: {}, expectAuthErrors: true }), (e: unknown) => (e as ApiError).kind === 'unauthorized');
  assert.equal(purged, 1, 'un 401 ATTENDU (login) ne purge pas');
});

test('cookies : chaque appel part en same-origin, le CSRF n’accompagne QUE les écritures', async () => {
  const seen: SeenRequest[] = [];
  const api = new ApiClient({ baseUrl: '/api/v1', fetchImpl: fakeFetch(() => ({ status: 200, body: {} }), seen) });
  api.setCsrf('csrf-123');
  await api.call('sessions'); // GET
  await api.call('notifyPreferences', { body: { locale: 'fr' } }); // PUT
  await api.call('revokeOtherSessions', {}); // POST sans corps
  assert.ok(seen.every((r) => r.credentials === 'same-origin'), 'cookie HttpOnly embarque via same-origin');
  assert.equal(seen[0]!.headers['x-kora-csrf'], undefined, 'jamais de CSRF sur une lecture');
  assert.equal(seen[1]!.headers['x-kora-csrf'], 'csrf-123', 'CSRF sur PUT');
  assert.equal(seen[2]!.headers['x-kora-csrf'], 'csrf-123', 'CSRF sur POST');
  assert.ok(seen.every((r) => r.headers['authorization'] === undefined), 'AUCUN entete Authorization côté navigateur');
});

test('429 et 423 exposent Retry-After (entête prioritaire, corps en secours)', async () => {
  const api = new ApiClient({
    baseUrl: 'http://x/api/v1',
    fetchImpl: fakeFetch((url) => url.includes('/auth/login')
      ? { status: 429, body: { message: 'trop', retryAfterSeconds: 99 }, headers: { 'retry-after': '17' } }
      : { status: 423, body: { retryAfterSeconds: 42 } }),
  });
  const e429 = await api.call('login', { body: {}, expectAuthErrors: true }).catch((e: ApiError) => e);
  assert.equal((e429 as ApiError).kind, 'rate_limited');
  assert.equal((e429 as ApiError).retryAfterSeconds, 17, 'l’entête Retry-After prime');
  const e423 = await api.call('sessions').catch((e: ApiError) => e);
  assert.equal((e423 as ApiError).kind, 'locked');
  assert.equal((e423 as ApiError).retryAfterSeconds, 42, 'repli sur le corps');
});

test('409/503/panne réseau typés proprement, sans fuite technique', async () => {
  const api = new ApiClient({
    baseUrl: 'http://x/api/v1',
    fetchImpl: fakeFetch((url) => url.includes('sessions') ? { status: 409, body: { code: 'stale' } } : { status: 503 }),
  });
  const e409 = await api.call('sessions').catch((e: ApiError) => e);
  assert.equal((e409 as ApiError).kind, 'conflict');
  assert.equal((e409 as ApiError).code, 'stale');
  const e503 = await api.call('me').catch((e: ApiError) => e);
  assert.equal((e503 as ApiError).kind, 'unavailable');
  const offline = new ApiClient({
    baseUrl: 'http://x/api/v1',
    fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch,
  });
  const eOff = await offline.call('me').catch((e: ApiError) => e);
  assert.equal((eOff as ApiError).kind, 'offline');
  assert.ok(!(eOff as ApiError).message.includes('fetch failed'), 'aucun détail technique exposé');
});

test('session : login cookie ⇒ AUCUN jeton reçu ni stocké, CSRF en mémoire, purge totale', async () => {
  const spies = installStorageSpies();
  const seen: SeenRequest[] = [];
  const api = new ApiClient({
    baseUrl: '/api/v1',
    fetchImpl: fakeFetch((url, init) => {
      if (url.endsWith('/auth/login')) {
        const body = JSON.parse(init.body ?? '{}') as { tokenTransport?: string };
        assert.equal(body.tokenTransport, 'cookie', 'la PWA demande TOUJOURS le transport cookie');
        return { status: 200, body: { expiresAt: 'x', user: { id: 'u', email: 'a@b' }, csrfToken: 'csrf-abc' } };
      }
      if (url.endsWith('/auth/me')) return { status: 200, body: ME_BODY };
      if (url.endsWith('/auth/logout')) return { status: 204 };
      return { status: 404, body: {} };
    }, seen),
  });
  const session = new Session(api);
  const res = await session.login('acme', 'a@b', 'motdepasse');
  assert.equal(res.kind, 'ok');
  assert.equal(session.isAuthenticated(), true);
  assert.equal(api.hasCsrf(), true);
  assert.equal(spies.writes.length, 0, 'RIEN n’est écrit dans les stockages du navigateur');
  const raw = JSON.stringify(seen);
  assert.ok(!raw.includes('k1.'), 'aucun jeton de session ne transite côté client');
  await session.logout();
  assert.equal(session.isAuthenticated(), false);
  assert.equal(api.hasCsrf(), false, 'purge : CSRF mémoire effacé');
  // le logout est bien parti AVEC le CSRF (écriture protégée)
  const logoutReq = seen.find((r) => r.url.endsWith('/auth/logout'))!;
  assert.equal(logoutReq.headers['x-kora-csrf'], 'csrf-abc');
});

test('reprise d’onglet : /auth/me recharge profil ET CSRF depuis le cookie serveur', async () => {
  installStorageSpies();
  const api = new ApiClient({
    baseUrl: '/api/v1',
    fetchImpl: fakeFetch((url) => url.endsWith('/auth/me') ? { status: 200, body: ME_BODY } : { status: 404 }),
  });
  const session = new Session(api);
  assert.equal(await session.resume(), true);
  assert.equal(session.me!.email, 'a@b');
  assert.equal(api.hasCsrf(), true, 'CSRF rechargé en mémoire au démarrage');
  // cookie absent/expiré ⇒ reprise refusée proprement
  const api2 = new ApiClient({
    baseUrl: '/api/v1',
    fetchImpl: fakeFetch(() => ({ status: 401, body: {} })),
  });
  const s2 = new Session(api2);
  assert.equal(await s2.resume(), false);
  assert.equal(s2.isAuthenticated(), false);
});

test('session : mfa_required puis code accepté (parcours MFA du frontend)', async () => {
  installStorageSpies();
  let sawMfaCode: string | null = null;
  const api = new ApiClient({
    baseUrl: '/api/v1',
    fetchImpl: fakeFetch((url, init) => {
      if (url.endsWith('/auth/login')) {
        const body = JSON.parse(init.body ?? '{}') as { mfaCode?: string };
        if (!body.mfaCode) return { status: 401, body: { code: 'mfa_required', message: 'second facteur requis' } };
        sawMfaCode = body.mfaCode;
        return { status: 200, body: { expiresAt: 'x', user: { id: 'u', email: 'a@b' }, csrfToken: 'c2' } };
      }
      if (url.endsWith('/auth/me')) return { status: 200, body: { ...ME_BODY, csrfToken: 'c2', locale: 'en', mfaEnabled: true } };
      return { status: 404 };
    }),
  });
  const session = new Session(api);
  const first = await session.login('acme', 'a@b', 'pw');
  assert.equal(first.kind, 'mfa_required');
  const second = await session.login('acme', 'a@b', 'pw', '123456');
  assert.equal(second.kind, 'ok');
  assert.equal(sawMfaCode, '123456');
});

test('verrouillage et limitation au login : délais remontés à l’écran', async () => {
  installStorageSpies();
  const api = new ApiClient({
    baseUrl: '/api/v1',
    fetchImpl: fakeFetch(() => ({ status: 423, body: { retryAfterSeconds: 120 } })),
  });
  const session = new Session(api);
  const locked = await session.login('acme', 'a@b', 'pw');
  assert.deepEqual(locked, { kind: 'locked', retryAfterSeconds: 120 });
});

test('url() encode les segments et la requête ; le contrat interdit les chemins libres', () => {
  const api = new ApiClient({ baseUrl: '/api/v1' });
  assert.equal(api.url('employee', { id: 'a b/../c' }, { date: '2026-08-15' }),
    '/api/v1/employees/a%20b%2F..%2Fc?date=2026-08-15');
});
