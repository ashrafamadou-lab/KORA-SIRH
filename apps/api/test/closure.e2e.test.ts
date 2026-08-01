/**
 * E2E clôture E1/E2 — sessions, changement de mot de passe, admin utilisateurs.
 * Fortement axé tests NÉGATIFS (conditions de validation du sponsor) :
 * inter-tenant, escalade de privilèges, réutilisation de session révoquée, mdp non
 * autorisé, désactivation ⇒ révocation. Auto-seedé, exécuté contre PostgreSQL réel.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import type { INestApplication } from '@nestjs/common';

process.env.KORA_MFA_KEY ??=
  'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
import { createApp } from '../src/main';

const MIGRATOR_URL =
  process.env.DATABASE_URL_MIGRATOR ??
  'postgres://kora_migrator:kora_migrator_dev@127.0.0.1:5432/kora';

function psql(sql: string): string {
  const r = spawnSync('psql', [MIGRATOR_URL, '-qXtA', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr}`);
  return r.stdout.trim();
}

const rid = randomUUID().slice(0, 8);
const P = 'Trajet-Manguier-2026!';
const P2 = 'Nouveau-Baobab-2027#';

// Deux tenants pour les tests inter-tenant.
const slugA = `clo-a-${rid}`;
const slugB = `clo-b-${rid}`;
const adminEmail = `admin.${rid}@demo.bj`;   // users.* + sessions.revoke + employees.view
const officerEmail = `officer.${rid}@demo.bj`; // users.view seulement (acteur limité)
const targetEmail = `cible.${rid}@demo.bj`;
const bEmail = `b.${rid}@demo.bj`;

let app: INestApplication;
let baseA = '';
let baseB = '';
let adminId = '';
let officerId = '';
let targetId = '';

function seedTenant(slug: string): { tenantId: string; hash: Promise<string> } {
  const tenantId = psql(`INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('${slug}', 'Clo (DEMO)', true) RETURNING id`);
  return { tenantId, hash: argon2.hash(P, { type: argon2.argon2id }) };
}

before(async () => {
  const a = seedTenant(slugA);
  const b = seedTenant(slugB);
  const hashA = await a.hash;
  const hashB = await b.hash;

  adminId = psql(`INSERT INTO admin.users (tenant_id, email, password_hash) VALUES ('${a.tenantId}','${adminEmail}','${hashA}') RETURNING id`);
  officerId = psql(`INSERT INTO admin.users (tenant_id, email, password_hash) VALUES ('${a.tenantId}','${officerEmail}','${hashA}') RETURNING id`);
  targetId = psql(`INSERT INTO admin.users (tenant_id, email, password_hash) VALUES ('${a.tenantId}','${targetEmail}','${hashA}') RETURNING id`);
  psql(`INSERT INTO admin.users (tenant_id, email, password_hash) VALUES ('${b.tenantId}','${bEmail}','${hashB}')`);

  // Rôles tenant A. admin : toutes les permissions admin + employees.view. officer : users.view seul.
  const adminRole = psql(`INSERT INTO admin.roles (tenant_id, key, name) VALUES ('${a.tenantId}','admin-${rid}','Admin') RETURNING id`);
  const officerRole = psql(`INSERT INTO admin.roles (tenant_id, key, name) VALUES ('${a.tenantId}','officer-${rid}','Officer') RETURNING id`);
  // rôle "privilégié" que l'officer NE possède pas — sert au test d'escalade.
  const privRole = psql(`INSERT INTO admin.roles (tenant_id, key, name) VALUES ('${a.tenantId}','priv-${rid}','Privilégié') RETURNING id`);

  const adminPerms = ['users.view', 'users.create', 'users.edit', 'users.manage_roles', 'sessions.revoke', 'employees.view'];
  for (const p of adminPerms) psql(`INSERT INTO admin.role_permissions (tenant_id, role_id, permission_key) VALUES ('${a.tenantId}','${adminRole}','${p}')`);
  psql(`INSERT INTO admin.role_permissions (tenant_id, role_id, permission_key) VALUES ('${a.tenantId}','${officerRole}','users.view')`);
  psql(`INSERT INTO admin.role_permissions (tenant_id, role_id, permission_key) VALUES ('${a.tenantId}','${officerRole}','users.manage_roles')`);
  // privRole apporte employees.view (permission que l'officer n'a pas).
  psql(`INSERT INTO admin.role_permissions (tenant_id, role_id, permission_key) VALUES ('${a.tenantId}','${privRole}','employees.view')`);

  psql(`INSERT INTO admin.user_roles (tenant_id, user_id, role_id) VALUES ('${a.tenantId}','${adminId}','${adminRole}')`);
  psql(`INSERT INTO admin.user_roles (tenant_id, user_id, role_id) VALUES ('${a.tenantId}','${officerId}','${officerRole}')`);
  psql(`INSERT INTO admin.user_scopes (tenant_id, user_id, scope_type) VALUES ('${a.tenantId}','${adminId}','tenant')`);
  psql(`INSERT INTO admin.user_scopes (tenant_id, user_id, scope_type) VALUES ('${a.tenantId}','${officerId}','tenant')`);

  app = await createApp();
  await app.listen(0);
  const addr = app.getHttpServer().address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  baseA = `http://127.0.0.1:${port}/api/v1`;
  baseB = baseA; // même app, tenant discriminé par le slug au login
});

after(async () => {
  if (app) await app.close();
});

async function login(base: string, slug: string, email: string, password: string): Promise<Response> {
  return fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenantSlug: slug, email, password }),
  });
}
async function tokenFor(base: string, slug: string, email: string, password = P): Promise<string> {
  const res = await login(base, slug, email, password);
  assert.equal(res.status, 200, `login ${email}`);
  return ((await res.json()) as { token: string }).token;
}
function authed(base: string, path: string, token: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });
}

// ---------- Sessions : consultation, révocation, isolation ----------

test('sessions : liste sans jeton, révocation ciblée, effet immédiat', async () => {
  const t1 = await tokenFor(baseA, slugA, targetEmail);
  const t2 = await tokenFor(baseA, slugA, targetEmail);

  const list = await authed(baseA, '/auth/sessions', t1);
  assert.equal(list.status, 200);
  const sessions = (await list.json()) as Array<Record<string, unknown>>;
  assert.equal(sessions.length, 2);
  assert.ok(!JSON.stringify(sessions).includes('k1.'), 'aucun jeton dans la réponse');
  for (const s of sessions) assert.equal('token' in s, false);
  const current = sessions.find((s) => s['current'] === true);
  const other = sessions.find((s) => s['current'] === false)!;
  assert.ok(current, 'la session courante est marquée');

  // Révoquer l'autre session → son jeton ne fonctionne plus immédiatement.
  const del = await authed(baseA, `/auth/sessions/${other['id']}`, t1, { method: 'DELETE' });
  assert.equal(del.status, 204);
  const reuse = await authed(baseA, '/auth/me', t2);
  assert.equal(reuse.status, 401, 'session révoquée = réutilisation refusée immédiatement');
});

test('sessions : revoke-others garde la courante', async () => {
  const keep = await tokenFor(baseA, slugA, targetEmail);
  const drop = await tokenFor(baseA, slugA, targetEmail);
  const res = await authed(baseA, '/auth/sessions/revoke-others', keep, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.ok(((await res.json()) as { revoked: number }).revoked >= 1);
  assert.equal((await authed(baseA, '/auth/me', keep)).status, 200, 'la courante survit');
  assert.equal((await authed(baseA, '/auth/me', drop)).status, 401, 'les autres tombent');
});

test('NÉGATIF inter-tenant : impossible de révoquer la session d’un autre tenant', async () => {
  const tokenB = await tokenFor(baseB, slugB, bEmail);
  const sessionB = ((await (await authed(baseB, '/auth/sessions', tokenB)).json()) as Array<{ id: string }>)[0]!.id;
  const tokenA = await tokenFor(baseA, slugA, adminEmail);
  // L'admin de A tente de révoquer la session de B via son propre endpoint self-service.
  const cross = await authed(baseA, `/auth/sessions/${sessionB}`, tokenA, { method: 'DELETE' });
  assert.equal(cross.status, 404, 'session d’un autre tenant : invisible (404), jamais révocable');
  assert.equal((await authed(baseB, '/auth/me', tokenB)).status, 200, 'la session de B est intacte');
});

// ---------- Changement de mot de passe ----------

test('mot de passe : ancien vérifié, politique appliquée, autres sessions révoquées', async () => {
  const email = `pwd.${rid}@demo.bj`;
  const h = await argon2.hash(P, { type: argon2.argon2id });
  psql(`INSERT INTO admin.users (tenant_id, email, password_hash) SELECT id, '${email}', '${h}' FROM admin.tenants WHERE slug='${slugA}'`);
  const sessionToChange = await tokenFor(baseA, slugA, email);
  const otherSession = await tokenFor(baseA, slugA, email);

  // Mauvais ancien mot de passe → 401.
  const wrong = await authed(baseA, '/auth/password', sessionToChange, {
    method: 'POST',
    body: JSON.stringify({ currentPassword: 'faux', newPassword: P2 }),
  });
  assert.equal(wrong.status, 401);

  // Nouveau mot de passe faible → 400 avec issues.
  const weak = await authed(baseA, '/auth/password', sessionToChange, {
    method: 'POST',
    body: JSON.stringify({ currentPassword: P, newPassword: 'court' }),
  });
  assert.equal(weak.status, 400);
  assert.ok(Array.isArray(((await weak.json()) as { issues: string[] }).issues));

  // Changement valide → 200, autres sessions révoquées, ancien mot de passe inutilisable.
  const ok = await authed(baseA, '/auth/password', sessionToChange, {
    method: 'POST',
    body: JSON.stringify({ currentPassword: P, newPassword: P2 }),
  });
  assert.equal(ok.status, 200);
  assert.equal((await authed(baseA, '/auth/me', otherSession)).status, 401, 'autres sessions révoquées');
  assert.equal((await authed(baseA, '/auth/me', sessionToChange)).status, 200, 'la session courante survit');
  assert.equal((await login(baseA, slugA, email, P)).status, 401, 'ancien mot de passe refusé');
  assert.equal((await login(baseA, slugA, email, P2)).status, 200, 'nouveau mot de passe accepté');
});

// ---------- Admin utilisateurs : RBAC réel, anti-élévation, audit ----------

test('admin : création, désactivation ⇒ révocation, réactivation — tracées', async () => {
  const admin = await tokenFor(baseA, slugA, adminEmail);
  const newEmail = `cree.${rid}@demo.bj`;

  const created = await authed(baseA, '/admin/users', admin, {
    method: 'POST',
    body: JSON.stringify({ email: newEmail, password: P2 }),
  });
  assert.equal(created.status, 201);
  const newId = ((await created.json()) as { id: string }).id;

  // Le nouveau compte peut se connecter, a une session…
  const newUserToken = await tokenFor(baseA, slugA, newEmail, P2);
  assert.equal((await authed(baseA, '/auth/me', newUserToken)).status, 200);

  // …puis l'admin le désactive → toutes ses sessions tombent immédiatement.
  const deact = await authed(baseA, `/admin/users/${newId}/deactivate`, admin, { method: 'POST' });
  assert.equal(deact.status, 200);
  assert.ok(((await deact.json()) as { sessionsRevoked: number }).sessionsRevoked >= 1);
  assert.equal((await authed(baseA, '/auth/me', newUserToken)).status, 401, 'désactivation = sessions révoquées');
  assert.equal((await login(baseA, slugA, newEmail, P2)).status, 401, 'compte désactivé = login refusé');

  // Réactivation → login de nouveau possible.
  assert.equal((await authed(baseA, `/admin/users/${newId}/activate`, admin, { method: 'POST' })).status, 200);
  assert.equal((await login(baseA, slugA, newEmail, P2)).status, 200);

  // Audit : les opérations sensibles sont tracées dans le module admin_users.
  const audits = Number(psql(
    `SELECT count(*) FROM audit.audit_log WHERE module='admin_users' AND record_id='${newId}' AND action IN ('user_created','user_deactivated','user_activated')`,
  ));
  assert.ok(audits >= 3, `création+désactivation+réactivation tracées (${audits})`);
});

test('NÉGATIF RBAC : sans la permission, l’administration est refusée (403)', async () => {
  const officer = await tokenFor(baseA, slugA, officerEmail); // a users.view, pas users.create/edit
  assert.equal((await authed(baseA, '/admin/users', officer)).status, 200, 'users.view autorisé');
  const create = await authed(baseA, '/admin/users', officer, {
    method: 'POST',
    body: JSON.stringify({ email: `x.${rid}@demo.bj`, password: P2 }),
  });
  assert.equal(create.status, 403, 'users.create absent → 403');
  const deact = await authed(baseA, `/admin/users/${targetId}/deactivate`, officer, { method: 'POST' });
  assert.equal(deact.status, 403, 'users.edit absent → 403');
});

test('NÉGATIF escalade : un acteur ne peut affecter un rôle apportant une permission qu’il n’a pas', async () => {
  const officer = await tokenFor(baseA, slugA, officerEmail); // users.manage_roles mais PAS employees.view
  const attempt = await authed(baseA, `/admin/users/${targetId}/roles`, officer, {
    method: 'POST',
    body: JSON.stringify({ roles: [`priv-${rid}`] }), // priv apporte employees.view
  });
  assert.equal(attempt.status, 403, 'délégation d’une permission non détenue = refus');
  const body = (await attempt.json()) as { permissions?: string[] };
  assert.ok(body.permissions?.includes('employees.view'));
  // Et rien n'a été écrit : la cible n'a pas gagné employees.view.
  const has = psql(
    `SELECT count(*) FROM admin.user_roles ur JOIN admin.roles r ON r.id=ur.role_id WHERE ur.user_id='${targetId}' AND r.key='priv-${rid}'`,
  );
  assert.equal(has, '0', 'aucune écriture de rôle sur refus d’escalade');
  // Trace de refus présente.
  assert.ok(Number(psql(`SELECT count(*) FROM audit.audit_log WHERE action='role_assign_denied' AND record_id='${targetId}'`)) >= 1);
});

test('escalade : affectation d’un rôle DANS le périmètre de l’acteur → acceptée', async () => {
  const admin = await tokenFor(baseA, slugA, adminEmail); // possède employees.view
  const ok = await authed(baseA, `/admin/users/${targetId}/roles`, admin, {
    method: 'POST',
    body: JSON.stringify({ roles: [`priv-${rid}`] }),
  });
  assert.equal(ok.status, 200, 'l’admin, qui détient employees.view, peut l’accorder');
});

test('admin : révocation administrative des sessions d’un utilisateur', async () => {
  const victimToken = await tokenFor(baseA, slugA, targetEmail);
  assert.equal((await authed(baseA, '/auth/me', victimToken)).status, 200);
  const admin = await tokenFor(baseA, slugA, adminEmail);
  const res = await authed(baseA, `/admin/users/${targetId}/revoke-sessions`, admin, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.ok(((await res.json()) as { revoked: number }).revoked >= 1);
  assert.equal((await authed(baseA, '/auth/me', victimToken)).status, 401, 'sessions révoquées par l’admin');
});

test('OpenAPI : les endpoints de clôture sont documentés', async () => {
  const spec = (await (await fetch(`${baseA}/openapi.json`)).json()) as { paths: Record<string, unknown> };
  for (const p of [
    '/auth/sessions', '/auth/sessions/{id}', '/auth/password',
    '/admin/users', '/admin/users/{id}/deactivate', '/admin/users/{id}/roles',
    '/admin/users/{id}/revoke-sessions',
  ]) {
    assert.ok(spec.paths[p], `chemin ${p} documenté`);
  }
});
