/**
 * E2E des additions API pour la PWA (E7) : boîtes de travail workflow (inbox décidable
 * par l'acteur — séparation des tâches incluse — et outbox du demandeur) et catalogue
 * des rôles. Suite ISOLÉE : fixtures propres, permissions issues des MIGRATIONS.
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
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

const rid = randomUUID().slice(0, 8);
const P = 'Colline-Ganvie-2026!';
const slug = `web-${rid}`;
const demandeurEmail = `wdem.${rid}@demo.bj`;   // workflow.manage/submit/view (portée tenant)
const apprEmail = `wappr.${rid}@demo.bj`;       // workflow.act/view + rôle approbateur
const adminEmail = `wadm.${rid}@demo.bj`;       // users.view

let app: INestApplication;
let base = '';
let tenantId = '';

async function seedUser(email: string, perms: string[], roleKeys: string[]): Promise<string> {
  const h = await argon2.hash(P, { type: argon2.argon2id });
  const id = psql(`INSERT INTO admin.users (tenant_id, email, password_hash) VALUES ('${tenantId}','${email}','${h}') RETURNING id`);
  psql(`INSERT INTO admin.user_scopes (tenant_id, user_id, scope_type) VALUES ('${tenantId}','${id}','tenant')`);
  if (perms.length > 0) {
    const role = psql(`INSERT INTO admin.roles (tenant_id, key, name) VALUES ('${tenantId}','r-${email.split('@')[0]}','R') RETURNING id`);
    for (const p of perms) psql(`INSERT INTO admin.role_permissions (tenant_id, role_id, permission_key) VALUES ('${tenantId}','${role}','${p}')`);
    psql(`INSERT INTO admin.user_roles (tenant_id, user_id, role_id) VALUES ('${tenantId}','${id}','${role}')`);
  }
  for (const rk of roleKeys) {
    const role = psql(`INSERT INTO admin.roles (tenant_id, key, name) VALUES ('${tenantId}','${rk}','${rk}') ON CONFLICT (tenant_id, key) DO UPDATE SET name = EXCLUDED.name RETURNING id`);
    psql(`INSERT INTO admin.user_roles (tenant_id, user_id, role_id) VALUES ('${tenantId}','${id}','${role}') ON CONFLICT DO NOTHING`);
  }
  return id;
}

before(async () => {
  tenantId = psql(`INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('${slug}','WEB',true) RETURNING id`);
  await seedUser(demandeurEmail, ['workflow.manage', 'workflow.submit', 'workflow.view'], []);
  await seedUser(apprEmail, ['workflow.act', 'workflow.view'], [`webappr-${rid}`]);
  await seedUser(adminEmail, ['users.view'], []);
  app = await createApp();
  await app.listen(0);
  const addr = app.getHttpServer().address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr !== null ? addr.port : 0}/api/v1`;
});
after(async () => { if (app) await app.close(); });

async function token(email: string): Promise<string> {
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenantSlug: slug, email, password: P }),
  });
  assert.equal(res.status, 200, `login ${email}`);
  return ((await res.json()) as { token: string }).token;
}
function api(path: string, tok: string, body?: unknown, method = 'POST'): Promise<Response> {
  return fetch(`${base}${path}`, {
    method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('boîtes de travail : inbox = décidable par MOI (jamais mes propres demandes), outbox = mes demandes', async () => {
  const dem = await token(demandeurEmail);
  const appr = await token(apprEmail);
  const key = `web_flow_${rid}`;
  const def = await api('/workflow/definitions', dem, {
    key, name: 'Circuit PWA',
    steps: [{ index: 0, name: 'Validation', approverType: 'role', approverRef: `webappr-${rid}` }],
  });
  assert.equal(def.status, 201);
  const { id: defId } = (await def.json()) as { id: string };
  assert.equal((await api(`/workflow/definitions/${defId}/activate`, dem)).status, 200);

  const sub = await api('/workflow/instances', dem, { definitionKey: key, subjectType: 'demo_subject', subjectId: randomUUID() });
  assert.equal(sub.status, 201);
  const { instanceId } = (await sub.json()) as { instanceId: string };

  // L'approbateur voit la tâche dans SA boîte de réception.
  const inboxAppr = (await (await api('/workflow/instances?box=inbox', appr, undefined, 'GET')).json()) as { items: Array<{ id: string; stepName: string }> };
  assert.ok(inboxAppr.items.some((i) => i.id === instanceId), 'l’instance est décidable par l’approbateur');
  assert.equal(inboxAppr.items.find((i) => i.id === instanceId)!.stepName, 'Validation');
  // Le demandeur ne voit PAS sa propre demande comme décidable (séparation des tâches)…
  const inboxDem = (await (await api('/workflow/instances?box=inbox', dem, undefined, 'GET')).json()) as { items: Array<{ id: string }> };
  assert.ok(!inboxDem.items.some((i) => i.id === instanceId), 'jamais sa propre demande en inbox');
  // …mais la retrouve dans sa boîte d'envoi.
  const outbox = (await (await api('/workflow/instances?box=outbox', dem, undefined, 'GET')).json()) as { items: Array<{ id: string; status: string }> };
  assert.ok(outbox.items.some((i) => i.id === instanceId && i.status === 'pending'));

  // Après décision, la tâche disparaît de l'inbox et l'outbox reflète le statut final.
  assert.equal((await api(`/workflow/instances/${instanceId}/approve`, appr)).status, 200);
  const inboxAfter = (await (await api('/workflow/instances?box=inbox', appr, undefined, 'GET')).json()) as { items: Array<{ id: string }> };
  assert.ok(!inboxAfter.items.some((i) => i.id === instanceId), 'plus rien à décider après approbation');
  const outboxAfter = (await (await api('/workflow/instances?box=outbox&status=approved', dem, undefined, 'GET')).json()) as { items: Array<{ id: string }> };
  assert.ok(outboxAfter.items.some((i) => i.id === instanceId));
  // Paramètre invalide refusé explicitement.
  assert.equal((await api('/workflow/instances?box=corbeille', dem, undefined, 'GET')).status, 400);
});

test('profil de session enrichi : /auth/me expose permissions, portées, rôles, langue et tenant', async () => {
  const dem = await token(demandeurEmail);
  const me = await api('/auth/me', dem, undefined, 'GET');
  assert.equal(me.status, 200);
  const body = (await me.json()) as {
    email: string; permissions: string[]; scopes: Array<{ type: string }>;
    roles: Array<{ key: string }>; locale: string; mfaEnabled: boolean;
    tenant: { slug: string; name: string };
  };
  assert.equal(body.email, demandeurEmail);
  assert.ok(body.permissions.includes('workflow.submit'), 'les permissions réelles alimentent la navigation PWA');
  assert.ok(!body.permissions.includes('users.view'), 'aucune permission inventée');
  assert.ok(body.scopes.some((s) => s.type === 'tenant'));
  assert.equal(body.locale, 'fr');
  assert.equal(body.mfaEnabled, false);
  assert.equal(body.tenant.slug, slug, 'l’identité du tenant vient du SERVEUR, jamais du client');
});

test('catalogue des rôles : lecture users.view, permissions agrégées, jamais d’écriture', async () => {
  const adm = await token(adminEmail);
  const res = await api('/admin/roles', adm, undefined, 'GET');
  assert.equal(res.status, 200);
  const roles = (await res.json()) as Array<{ key: string; name: string; isSystem: boolean; permissions: string[] }>;
  const appr = roles.find((r) => r.key === `webappr-${rid}`);
  assert.ok(appr, 'le rôle approbateur figure au catalogue');
  const demRole = roles.find((r) => r.key === `r-wdem.${rid}`);
  assert.ok(demRole && demRole.permissions.includes('workflow.submit'), 'les permissions sont agrégées par rôle');
  // Sans users.view : refus.
  const dem = await token(demandeurEmail);
  assert.equal((await api('/admin/roles', dem, undefined, 'GET')).status, 403);
  // Aucune méthode d'écriture n'existe sur ce chemin.
  assert.equal((await api('/admin/roles', adm, { key: 'x' })).status, 404);
});
