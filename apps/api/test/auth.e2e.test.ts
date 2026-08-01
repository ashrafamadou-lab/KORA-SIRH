/**
 * E2E auth (US-E1-01/03/06 — tranche incrément 2) : exécuté en CI contre PostgreSQL réel,
 * schéma posé par les migrations SQL. Auto-seedé (tenant + comptes jetables), aucun état
 * partagé entre runs.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/main';

const MIGRATOR_URL =
  process.env.DATABASE_URL_MIGRATOR ??
  'postgres://kora_migrator:kora_migrator_dev@127.0.0.1:5432/kora';

function psql(sql: string): string {
  const r = spawnSync('psql', [MIGRATOR_URL, '-qXtA', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Error(`psql a échoué : ${r.stderr}`);
  }
  return r.stdout.trim();
}

const rid = randomUUID().slice(0, 8);
const slug = `e2e-${rid}`;
const email1 = `nadia.${rid}@demo.bj`;
const email2 = `firmin.${rid}@demo.bj`;
const GOOD_PASSWORD = 'Trajet-Manguier-2026!';

let app: INestApplication;
let base = '';

before(async () => {
  const tenantId = psql(
    `INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('${slug}', 'E2E (DEMO DATA)', true) RETURNING id`,
  );
  const hash = await argon2.hash(GOOD_PASSWORD, { type: argon2.argon2id });
  psql(
    `INSERT INTO admin.users (tenant_id, email, password_hash) VALUES ('${tenantId}', '${email1}', '${hash}')`,
  );
  psql(
    `INSERT INTO admin.users (tenant_id, email, password_hash) VALUES ('${tenantId}', '${email2}', '${hash}')`,
  );

  app = await createApp();
  await app.listen(0);
  const addr = app.getHttpServer().address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  base = `http://127.0.0.1:${port}/api/v1`;
});

after(async () => {
  if (app) await app.close();
});

async function login(body: Record<string, string>): Promise<Response> {
  return fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('health : API et base de données répondent', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  const json = (await res.json()) as { status: string; database: string };
  assert.equal(json.status, 'ok');
  assert.equal(json.database, 'up');
});

test('login : tenant inconnu → 401 générique (anti-énumération)', async () => {
  const res = await login({ tenantSlug: 'inexistant-xyz', email: email1, password: GOOD_PASSWORD });
  assert.equal(res.status, 401);
});

test('login : corps invalide → 400', async () => {
  const res = await login({ tenantSlug: slug, email: email1 });
  assert.equal(res.status, 400);
});

test('parcours nominal : login → me → logout → me refusé', async () => {
  const res = await login({ tenantSlug: slug, email: email1, password: GOOD_PASSWORD });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { token: string; expiresAt: string; user: { email: string } };
  assert.match(body.token, /^k1\./);
  assert.equal(body.user.email, email1);
  assert.ok(new Date(body.expiresAt).getTime() > Date.now());

  const me = await fetch(`${base}/auth/me`, { headers: { authorization: `Bearer ${body.token}` } });
  assert.equal(me.status, 200);
  const ctx = (await me.json()) as { email: string; tenantId: string; userId: string };
  assert.equal(ctx.email, email1);

  const out = await fetch(`${base}/auth/logout`, {
    method: 'POST',
    headers: { authorization: `Bearer ${body.token}` },
  });
  assert.equal(out.status, 204);

  const meAfter = await fetch(`${base}/auth/me`, {
    headers: { authorization: `Bearer ${body.token}` },
  });
  assert.equal(meAfter.status, 401, 'session révoquée = accès refusé');
});

test('me : jeton de pacotille → 401', async () => {
  for (const bad of ['n-importe-quoi', `k1.${randomUUID()}.${'a'.repeat(43)}`]) {
    const res = await fetch(`${base}/auth/me`, { headers: { authorization: `Bearer ${bad}` } });
    assert.equal(res.status, 401);
  }
});

test('verrouillage progressif : 5 échecs → 423 au 6e essai, journalisé', async () => {
  for (let i = 1; i <= 5; i++) {
    const res = await login({ tenantSlug: slug, email: email2, password: 'Mauvais-2026!' });
    assert.equal(res.status, 401, `échec n° ${i} attendu en 401`);
  }
  const locked = await login({ tenantSlug: slug, email: email2, password: GOOD_PASSWORD });
  assert.equal(locked.status, 423, 'compte verrouillé même avec le bon mot de passe');
  const body = (await locked.json()) as { retryAfterSeconds?: number };
  assert.ok((body.retryAfterSeconds ?? 0) > 0);

  const audits = Number(
    psql(
      `SELECT count(*) FROM audit.audit_log WHERE action = 'login_failed' AND record_id = '${email2}'`,
    ),
  );
  assert.ok(audits >= 5, `audit trail : ${audits} échecs journalisés (≥ 5 attendus)`);
});
