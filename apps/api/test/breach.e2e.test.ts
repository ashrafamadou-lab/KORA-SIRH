/**
 * E2E dédié : comportement documenté du service de compromission (mode 'hibp') quand
 * l'API distante est INDISPONIBLE — fail-open vs fail-closed. Le transport HTTP est
 * remplacé par une double (aucun appel réseau réel en CI). Prouve le mécanisme testable
 * exigé par le sponsor.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import type { INestApplication } from '@nestjs/common';

process.env.KORA_MFA_KEY ??=
  'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
process.env.KORA_BREACH_CHECK = 'hibp';
process.env.KORA_BREACH_FAIL = 'closed'; // posture durcie : indispo = refus (503)
import { createApp } from '../src/main';
import { BreachedPasswordService, type BreachHttp } from '../src/auth/breached-password.service';

const MIGRATOR_URL =
  process.env.DATABASE_URL_MIGRATOR ??
  'postgres://kora_migrator:kora_migrator_dev@127.0.0.1:5432/kora';
function psql(sql: string): string {
  const r = spawnSync('psql', [MIGRATOR_URL, '-qXtA', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

const rid = randomUUID().slice(0, 8);
const slug = `breach-${rid}`;
// Un utilisateur distinct par test : les changements de mot de passe persistent, donc
// pas d'état partagé entre tests (bug de couplage évité).
const emailUp = `up.${rid}@demo.bj`;
const emailDown = `down.${rid}@demo.bj`;
const emailWeak = `weak.${rid}@demo.bj`;
const P = 'Trajet-Manguier-2026!';
const SAFE = 'Nouveau-Baobab-2027#';

let app: INestApplication;
let base = '';
let breach: BreachedPasswordService;

// Réponse HIBP simulée : le suffixe SHA-1 de « SAFE » n'y figure pas (donc non compromis
// quand le service répond) ; on bascule ensuite en indisponibilité.
let mode: 'up' | 'down' = 'up';
const fakeHttp: BreachHttp = async () => {
  if (mode === 'down') throw new Error('ECONNREFUSED');
  return { ok: true, status: 200, text: async () => '0000000000000000000000000000000000A:3\r\n1111111111111111111111111111111111B:9' };
};

before(async () => {
  const tenantId = psql(`INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('${slug}','Breach (DEMO)',true) RETURNING id`);
  const hash = await argon2.hash(P, { type: argon2.argon2id });
  for (const email of [emailUp, emailDown, emailWeak]) {
    psql(`INSERT INTO admin.users (tenant_id, email, password_hash) VALUES ('${tenantId}','${email}','${hash}')`);
  }

  app = await createApp();
  breach = app.get(BreachedPasswordService);
  breach.setHttp(fakeHttp);
  await app.listen(0);
  const addr = app.getHttpServer().address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  base = `http://127.0.0.1:${port}/api/v1`;
});

after(async () => {
  if (app) await app.close();
});

async function token(email: string): Promise<string> {
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenantSlug: slug, email, password: P }),
  });
  assert.equal(res.status, 200);
  return ((await res.json()) as { token: string }).token;
}
function changePassword(tok: string, currentPassword: string, newPassword: string): Promise<Response> {
  return fetch(`${base}/auth/password`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

test('compromission activée : service disponible → mot de passe sain accepté', async () => {
  mode = 'up';
  const res = await changePassword(await token(emailUp), P, SAFE);
  assert.equal(res.status, 200, 'service up, mot de passe non listé → accepté');
});

test('fail-closed : service indisponible → changement refusé en 503 (documenté, testable)', async () => {
  mode = 'down';
  const res = await changePassword(await token(emailDown), P, `Encore-Un-Autre-${rid}!`);
  assert.equal(res.status, 503, 'indisponibilité + fail-closed = refus explicite');
  assert.equal(((await res.json()) as { code?: string }).code, 'breach_unavailable');
});

test('la politique locale s’applique AVANT le service distant (indépendante du réseau)', async () => {
  mode = 'down'; // même service down, un mot de passe faible est rejeté sans l’atteindre
  const res = await changePassword(await token(emailWeak), P, 'court');
  assert.equal(res.status, 400, 'politique locale → 400, jamais 503');
});
