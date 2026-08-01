/**
 * Client API (E7) : gestion centralisée des erreurs (401 ⇒ purge, Retry-After 429/423,
 * 409/503 typés), jeton jamais posé sans session, hors-ligne détecté, purge complète.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiClient, ApiError } from '../src/core/api.ts';
import { Session } from '../src/core/session.ts';

type Responder = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
  status: number; body?: unknown; headers?: Record<string, string>;
};

function fakeFetch(responder: Responder): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const r = responder(url, {
      method: init?.method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
    });
  }) as typeof fetch;
}

/** sessionStorage factice injecté dans globalThis pour les tests de purge. */
function installFakeTabStorage(): Map<string, string> {
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>)['sessionStorage'] = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  (globalThis as Record<string, unknown>)['localStorage'] = {
    getItem: () => null, setItem: () => undefined, removeItem: () => undefined,
  };
  return store;
}

test('401 hors connexion attendue ⇒ rappel onUnauthorized (déconnexion immédiate centralisée)', async () => {
  let purged = 0;
  const api = new ApiClient({
    baseUrl: 'http://x/api/v1',
    onUnauthorized: () => { purged += 1; },
    fetchImpl: fakeFetch(() => ({ status: 401, body: { message: 'session révoquée' } })),
  });
  api.setToken('k1.t.abc');
  await assert.rejects(api.call('sessions'), (e: unknown) => (e as ApiError).kind === 'unauthorized');
  assert.equal(purged, 1, 'le 401 déclenche la purge globale');
  // en revanche, un 401 ATTENDU (login) ne purge pas :
  await assert.rejects(api.call('login', { body: {}, expectAuthErrors: true }), (e: unknown) => (e as ApiError).kind === 'unauthorized');
  assert.equal(purged, 1);
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
  api.setToken('k1.t.x');
  const e423 = await api.call('sessions').catch((e: ApiError) => e);
  assert.equal((e423 as ApiError).kind, 'locked');
  assert.equal((e423 as ApiError).retryAfterSeconds, 42, 'repli sur le corps');
});

test('409/503/panne réseau typés proprement, sans fuite technique', async () => {
  const api = new ApiClient({
    baseUrl: 'http://x/api/v1',
    fetchImpl: fakeFetch((url) => url.includes('sessions') ? { status: 409, body: { code: 'stale' } } : { status: 503 }),
  });
  api.setToken('k1.t.x');
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

test('session : login pose le jeton d’ONGLET, purge efface tout (jeton + profil + miroir)', async () => {
  const store = installFakeTabStorage();
  const api = new ApiClient({
    baseUrl: 'http://x/api/v1',
    fetchImpl: fakeFetch((url, init) => {
      if (url.endsWith('/auth/login')) return { status: 200, body: { token: 'k1.tt.zz', expiresAt: 'x', user: { id: 'u', email: 'a@b' } } };
      if (url.endsWith('/auth/me')) {
        assert.equal(init.headers?.['authorization'], 'Bearer k1.tt.zz', 'le jeton accompagne les appels');
        return {
          status: 200,
          body: {
            tenantId: 't', userId: 'u', sessionId: 's', email: 'a@b', permissions: ['employees.view'],
            scopes: [], roles: [], locale: 'fr', mfaEnabled: false, tenant: { slug: 'acme', name: 'ACME' },
          },
        };
      }
      if (url.endsWith('/auth/logout')) return { status: 204 };
      return { status: 404, body: {} };
    }),
  });
  const session = new Session(api);
  const res = await session.login('acme', 'a@b', 'motdepasse');
  assert.equal(res.kind, 'ok');
  assert.equal(session.isAuthenticated(), true);
  assert.equal(session.hasPermission('employees.view'), true);
  assert.equal(session.hasPermission('employees.view_private'), false, 'aucune permission inventée');
  assert.equal(store.get('kora.session'), 'k1.tt.zz', 'jeton d’onglet posé (jamais localStorage)');
  await session.logout();
  assert.equal(session.isAuthenticated(), false);
  assert.equal(store.has('kora.session'), false, 'purge complète à la déconnexion');
  assert.equal(api.hasToken(), false);
});

test('session : mfa_required puis code accepté (parcours MFA du frontend)', async () => {
  installFakeTabStorage();
  let sawMfaCode: string | null = null;
  const api = new ApiClient({
    baseUrl: 'http://x/api/v1',
    fetchImpl: fakeFetch((url, init) => {
      if (url.endsWith('/auth/login')) {
        const body = JSON.parse(init.body ?? '{}') as { mfaCode?: string };
        if (!body.mfaCode) return { status: 401, body: { code: 'mfa_required', message: 'second facteur requis' } };
        sawMfaCode = body.mfaCode;
        return { status: 200, body: { token: 'k1.t.mfa', expiresAt: 'x', user: { id: 'u', email: 'a@b' } } };
      }
      if (url.endsWith('/auth/me')) {
        return { status: 200, body: { tenantId: 't', userId: 'u', sessionId: 's', email: 'a@b', permissions: [], scopes: [], roles: [], locale: 'en', mfaEnabled: true, tenant: null } };
      }
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
  installFakeTabStorage();
  const api = new ApiClient({
    baseUrl: 'http://x/api/v1',
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
