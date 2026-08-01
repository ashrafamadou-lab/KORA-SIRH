/**
 * INTÉGRATION RÉELLE PWA ↔ API (E7, durcie en clôture Phase 1) — exécutée par le
 * job CI « web » (PostgreSQL + API compilée). Prouve à travers les couches du
 * FRONTEND (ApiClient/Session) : connexion par COOKIE HttpOnly (fetch de node ne
 * rejouant pas les cookies, chaque session de test reçoit un pot à cookies dédié
 * via fetchImpl — l'équivalent d'un navigateur), profil enrichi → navigation par
 * permissions, MFA réel (TOTP), langue persistée serveur, sessions consultables/
 * révocables, révocation ⇒ déconnexion IMMÉDIATE, compte désactivé ⇒ déconnexion,
 * contrôles backend effectifs en appel direct (403 sans permission), CSRF exigé sur
 * les écritures par cookie, en-têtes de sécurité servis, purge locale à la
 * déconnexion. Hors CI (API non compilée), la suite se saute proprement.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { totp } from '../../../packages/core/src/totp.ts';
import { ApiClient, ApiError } from '../src/core/api.ts';
import { Session } from '../src/core/session.ts';
import { visibleNav } from '../src/core/permissions.ts';

const here = dirname(fileURLToPath(import.meta.url));
const API_DIST = join(here, '..', '..', 'api', 'dist', 'apps', 'api', 'src', 'main.js');
const HAS_API = existsSync(API_DIST);
const MIGRATOR_URL = process.env.DATABASE_URL_MIGRATOR ?? '';
const RUNNABLE = HAS_API && MIGRATOR_URL.length > 0;

process.env.KORA_MFA_KEY ??= 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

function psql(sql: string): string {
  const r = spawnSync('psql', [MIGRATOR_URL, '-qXtA', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

// localStorage factice (miroir de langue d'i18n) : le frontend s'exécute tel quel
// en node. AUCUN sessionStorage : le client durci n'y touche plus jamais.
(globalThis as Record<string, unknown>)['localStorage'] = {
  getItem: () => null, setItem: () => undefined, removeItem: () => undefined,
};

/**
 * Pot à cookies minimal par « navigateur » simulé : fetch de node NE rejoue PAS les
 * cookies (contrairement au navigateur, qui porte le cookie HttpOnly tout seul).
 * Chaque Session de test reçoit SON transport — deux sessions = deux navigateurs.
 * Le code de production, lui, ignore totalement le jeton : c'est bien le serveur
 * qui pose et lit kora_session.
 */
function navigateurFetch(): typeof fetch {
  let cookie: string | null = null;
  return (async (...args: Parameters<typeof fetch>) => {
    const [input, init] = args;
    const headers = new Headers(init?.headers);
    if (cookie) headers.set('cookie', cookie);
    const res = await fetch(input, { ...init, headers });
    for (const sc of res.headers.getSetCookie()) {
      if (!sc.startsWith('kora_session=')) continue;
      const maxAge = /max-age=(-?\d+)/i.exec(sc);
      cookie = maxAge && Number(maxAge[1]) <= 0 ? null : sc.split(';')[0]!;
    }
    return res;
  }) as typeof fetch;
}

const rid = randomUUID().slice(0, 8);
const P = 'Plateau-Zou-2026!';
const slug = `pwa-${rid}`;
const adminEmail = `pwadm.${rid}@demo.bj`;    // permissions larges (tenant)
const viewerEmail = `pwview.${rid}@demo.bj`;  // employees.view seul
const nakedEmail = `pwnone.${rid}@demo.bj`;   // aucune permission

let app: { listen(port: number): Promise<unknown>; getHttpServer(): { address(): unknown }; close(): Promise<unknown> } | null = null;
let base = '';
let tenantId = '';
let viewerId = '';

function makeSession(): { session: Session; purges: () => number } {
  let purgeCount = 0;
  const holder: { session: Session | null } = { session: null };
  const api = new ApiClient({
    baseUrl: base,
    fetchImpl: navigateurFetch(),
    onUnauthorized: () => {
      purgeCount += 1;
      holder.session?.purge();
    },
  });
  const session = new Session(api);
  holder.session = session;
  return { session, purges: () => purgeCount };
}

async function seedUser(email: string, perms: string[]): Promise<string> {
  const argon2 = createRequire(join(here, '..', '..', 'api', 'package.json'))('argon2') as {
    hash(p: string, o: { type: number }): Promise<string>; argon2id: number;
  };
  const hash = await argon2.hash(P, { type: argon2.argon2id });
  const id = psql(`INSERT INTO admin.users (tenant_id, email, password_hash) VALUES ('${tenantId}','${email}','${hash}') RETURNING id`);
  psql(`INSERT INTO admin.user_scopes (tenant_id, user_id, scope_type) VALUES ('${tenantId}','${id}','tenant')`);
  if (perms.length > 0) {
    const role = psql(`INSERT INTO admin.roles (tenant_id, key, name) VALUES ('${tenantId}','r-${email.split('@')[0]}','R') RETURNING id`);
    for (const p of perms) psql(`INSERT INTO admin.role_permissions (tenant_id, role_id, permission_key) VALUES ('${tenantId}','${role}','${p}')`);
    psql(`INSERT INTO admin.user_roles (tenant_id, user_id, role_id) VALUES ('${tenantId}','${id}','${role}')`);
  }
  return id;
}

before(async (tc) => {
  if (!RUNNABLE) {
    tc.skip('API compilée ou base indisponible — suite exécutée par le job CI web');
    return;
  }
  tenantId = psql(`INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('${slug}','PWA Demo',true) RETURNING id`);
  await seedUser(adminEmail, ['employees.view', 'workflow.view', 'users.view', 'org.view', 'audit.view', 'parameters.view']);
  viewerId = await seedUser(viewerEmail, ['employees.view']);
  await seedUser(nakedEmail, []);
  const require2 = createRequire(join(here, 'integration.e2e.test.ts'));
  const mainModule = require2(API_DIST) as { createApp(): Promise<typeof app> };
  app = await mainModule.createApp();
  await app!.listen(0);
  const addr = app!.getHttpServer().address() as { port: number };
  base = `http://127.0.0.1:${addr.port}/api/v1`;
});

after(async () => {
  if (app) await app.close();
});

test('connexion réelle → profil enrichi → la navigation reflète les PERMISSIONS servies', { skip: !RUNNABLE }, async () => {
  const { session } = makeSession();
  const res = await session.login(slug, adminEmail, P);
  assert.equal(res.kind, 'ok');
  assert.equal(session.me!.tenant!.slug, slug, 'identité du tenant résolue par le SERVEUR');
  assert.ok(session.me!.permissions.includes('employees.view'));
  const nav = visibleNav(session.me!.permissions);
  const routes = nav.flatMap((s) => s.items.map((i) => i.route));
  assert.ok(routes.includes('/employees') && routes.includes('/admin/users') && routes.includes('/audit'));
  await session.logout();
  assert.equal(session.isAuthenticated(), false, 'déconnexion ⇒ purge (plus AUCUN stockage d’onglet)');
});

test('identifiants invalides : refus GÉNÉRIQUE, pas de session', { skip: !RUNNABLE }, async () => {
  const { session } = makeSession();
  const res = await session.login(slug, adminEmail, 'Mauvais-2026!');
  assert.equal(res.kind, 'invalid');
  assert.equal(session.isAuthenticated(), false);
});

test('navigation d’un utilisateur borné : sections absentes ET contrôle backend effectif en direct', { skip: !RUNNABLE }, async () => {
  const { session } = makeSession();
  assert.equal((await session.login(slug, viewerEmail, P)).kind, 'ok');
  const routes = visibleNav(session.me!.permissions).flatMap((s) => s.items.map((i) => i.route));
  assert.ok(routes.includes('/employees'));
  assert.ok(!routes.includes('/admin/users') && !routes.includes('/audit') && !routes.includes('/config'),
    'les menus non permis disparaissent');
  // …mais le MASQUAGE n'est pas la sécurité : l'appel direct est refusé par le serveur.
  const denied = await session.api.call('adminUsers').catch((e: ApiError) => e);
  assert.equal((denied as ApiError).kind, 'forbidden', 'appel direct ⇒ 403 serveur');
  const deniedAudit = await session.api.call('auditEvents').catch((e: ApiError) => e);
  assert.equal((deniedAudit as ApiError).kind, 'forbidden');
  await session.logout();
});

test('parcours MFA RÉEL : enrôlement TOTP, login exige le code, code accepté via le frontend', { skip: !RUNNABLE }, async () => {
  const { session } = makeSession();
  assert.equal((await session.login(slug, viewerEmail, P)).kind, 'ok');
  // Enrôlement + activation par la surface API en transport 'body' (client d'API,
  // non CSRF-able) : le jeton n'existe plus NULLE PART côté frontend, par conception.
  const apiLogin = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenantSlug: slug, email: viewerEmail, password: P }),
  });
  assert.equal(apiLogin.status, 200);
  const apiTok = ((await apiLogin.json()) as { token: string }).token;
  const enroll = await fetch(`${base}/auth/mfa/enroll`, {
    method: 'POST', headers: { authorization: `Bearer ${apiTok}` },
  });
  assert.equal(enroll.status, 200);
  const { secret } = (await enroll.json()) as { secret: string };
  const code = totp(secret, Math.floor(Date.now() / 1000));
  const activate = await fetch(`${base}/auth/mfa/activate`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiTok}`, 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  assert.equal(activate.status, 200);
  await session.logout();
  // Le FRONTEND vit le parcours : mot de passe seul ⇒ mfa_required ; avec code ⇒ ok.
  const first = await session.login(slug, viewerEmail, P);
  assert.equal(first.kind, 'mfa_required');
  const second = await session.login(slug, viewerEmail, P, totp(secret, Math.floor(Date.now() / 1000)));
  assert.equal(second.kind, 'ok');
  assert.equal(session.me!.mfaEnabled, true);
  // Nettoyage : MFA désactivé pour rendre le compte aux tests suivants
  // (sinon « compte désactivé » recevrait mfa_required au lieu d'un login franc).
  const disable = await fetch(`${base}/auth/mfa/disable`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiTok}`, 'content-type': 'application/json' },
    body: JSON.stringify({ code: totp(secret, Math.floor(Date.now() / 1000)) }),
  });
  assert.equal(disable.status, 200);
  await session.logout();
});

test('langue : préférence persistée CÔTÉ SERVEUR via le frontend', { skip: !RUNNABLE }, async () => {
  const { session } = makeSession();
  assert.equal((await session.login(slug, adminEmail, P)).kind, 'ok');
  await session.persistLocale('en');
  await session.refreshProfile();
  assert.equal(session.me!.locale, 'en', 'users.locale mis à jour par PUT /notifications/preferences');
  await session.persistLocale('fr');
  await session.logout();
});

test('sessions : consultables, révocation des AUTRES ⇒ leur prochaine requête déconnecte IMMÉDIATEMENT', { skip: !RUNNABLE }, async () => {
  const s1 = makeSession();
  const s2 = makeSession();
  assert.equal((await s1.session.login(slug, adminEmail, P)).kind, 'ok');
  // NB : chaque session a SON pot à cookies (navigateurFetch) — deux navigateurs
  // distincts, comme deux postes de travail.
  assert.equal((await s2.session.login(slug, adminEmail, P)).kind, 'ok');
  const list = await s1.session.api.call<Array<{ id: string; current: boolean }>>('sessions');
  assert.ok(list.length >= 2, 'les deux sessions apparaissent');
  assert.equal(list.filter((s) => s.current).length, 1, 'la session courante est identifiée, jamais de jeton exposé');
  await s1.session.api.call('revokeOtherSessions', {});
  const failed = await s2.session.api.call('sessions').catch((e: ApiError) => e);
  assert.equal((failed as ApiError).kind, 'unauthorized');
  assert.equal(s2.purges() >= 1, true, 'le 401 a déclenché la purge centralisée');
  assert.equal(s2.session.isAuthenticated(), false, 'déconnexion IMMÉDIATE côté frontend');
  await s1.session.logout();
});

test('compte DÉSACTIVÉ : la session en cours meurt à la requête suivante', { skip: !RUNNABLE }, async () => {
  const { session, purges } = makeSession();
  assert.equal((await session.login(slug, viewerEmail, P)).kind, 'ok');
  psql(`UPDATE admin.users SET is_active = false WHERE id = '${viewerId}'`);
  const res = await session.api.call('employees', { query: { limit: 1 } }).catch((e: ApiError) => e);
  assert.equal((res as ApiError).kind, 'unauthorized');
  assert.equal(purges() >= 1, true);
  assert.equal(session.isAuthenticated(), false);
  psql(`UPDATE admin.users SET is_active = true WHERE id = '${viewerId}'`);
});

test('cookie HttpOnly (mode PWA) : jeton invisible du client, CSRF exigé, révocation intacte', { skip: !RUNNABLE }, async () => {
  // Connexion en transport cookie — la réponse ne porte JAMAIS le jeton.
  const loginRes = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenantSlug: slug, email: adminEmail, password: P, tokenTransport: 'cookie' }),
  });
  assert.equal(loginRes.status, 200);
  const setCookies = loginRes.headers.getSetCookie();
  const sessionCookie = setCookies.find((c) => c.startsWith('kora_session='));
  assert.ok(sessionCookie, 'cookie de session posé');
  for (const attr of ['HttpOnly', 'SameSite=Strict', 'Path=/api', 'Max-Age=']) {
    assert.ok(sessionCookie!.includes(attr), `attribut ${attr} attendu : ${sessionCookie}`);
  }
  const loginBody = (await loginRes.json()) as Record<string, unknown>;
  assert.equal('token' in loginBody, false, 'le corps de réponse ne contient PAS le jeton');
  assert.equal(typeof loginBody['csrfToken'], 'string', 'le jeton CSRF (dérivé) est remis');
  const cookiePair = sessionCookie!.split(';')[0]!;
  const csrf = loginBody['csrfToken'] as string;

  // Lecture par cookie : OK, et /auth/me re-fournit le CSRF (rechargement d'onglet).
  const me = await fetch(`${base}/auth/me`, { headers: { cookie: cookiePair } });
  assert.equal(me.status, 200);
  const meBody = (await me.json()) as { email: string; csrfToken?: string };
  assert.equal(meBody.email, adminEmail);
  assert.equal(meBody.csrfToken, csrf, 'même dérivation CSRF au rechargement');

  // ÉCRITURE par cookie SANS entête CSRF : refusée (tentative CSRF simulée)…
  const forged = await fetch(`${base}/notifications/preferences`, {
    method: 'PUT', headers: { cookie: cookiePair, 'content-type': 'application/json' },
    body: JSON.stringify({ locale: 'en' }),
  });
  assert.equal(forged.status, 403, 'écriture par cookie sans X-KORA-CSRF = 403');
  // …avec un entête FAUX : refusée aussi…
  const wrong = await fetch(`${base}/notifications/preferences`, {
    method: 'PUT', headers: { cookie: cookiePair, 'content-type': 'application/json', 'x-kora-csrf': 'a'.repeat(48) },
    body: JSON.stringify({ locale: 'en' }),
  });
  assert.equal(wrong.status, 403);
  // …avec le bon entête : acceptée.
  const legit = await fetch(`${base}/notifications/preferences`, {
    method: 'PUT', headers: { cookie: cookiePair, 'content-type': 'application/json', 'x-kora-csrf': csrf },
    body: JSON.stringify({ locale: 'fr' }),
  });
  assert.equal(legit.status, 200, 'écriture légitime (entête CSRF correct) acceptée');
  // Le flux Bearer, non CSRF-able, reste inchangé (compatibilité E1→E9).
  const { session } = makeSession();
  assert.equal((await session.login(slug, adminEmail, P)).kind, 'ok');
  await session.persistLocale('fr');
  await session.logout();

  // En-têtes de sécurité servis par l'API réellement testée.
  for (const [name, expected] of [
    ['x-content-type-options', 'nosniff'],
    ['x-frame-options', 'DENY'],
    ['referrer-policy', 'no-referrer'],
    ['cache-control', 'no-store'],
  ] as const) {
    assert.equal(me.headers.get(name), expected, `entête ${name}`);
  }
  assert.ok(me.headers.get('content-security-policy')!.includes("frame-ancestors 'none'"));

  // Déconnexion par cookie : le cookie est effacé ET la session révoquée — la
  // réutilisation du cookie est IMMÉDIATEMENT rejetée.
  const out = await fetch(`${base}/auth/logout`, {
    method: 'POST', headers: { cookie: cookiePair, 'x-kora-csrf': csrf },
  });
  assert.equal(out.status, 204);
  const cleared = out.headers.getSetCookie().find((c) => c.startsWith('kora_session='));
  assert.ok(cleared && cleared.includes('Max-Age=0'), 'cookie effacé à la déconnexion');
  assert.equal((await fetch(`${base}/auth/me`, { headers: { cookie: cookiePair } })).status, 401,
    'session révoquée : le cookie volé ne sert plus à rien');
});

test('routes inexistantes et erreurs typées à travers le client', { skip: !RUNNABLE }, async () => {
  const { session } = makeSession();
  assert.equal((await session.login(slug, adminEmail, P)).kind, 'ok');
  const nf = await session.api.call('employee', { params: { id: randomUUID() } }).catch((e: ApiError) => e);
  assert.equal((nf as ApiError).kind, 'not_found', '404 typé (dossier inconnu ou hors périmètre)');
  await session.logout();
});
