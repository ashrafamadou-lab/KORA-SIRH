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
import { hashSessionToken } from '../../../packages/core/src/session-token.ts';
import { totp } from '../../../packages/core/src/totp.ts';

// Clé MFA de test (la CI la fournit ; défaut local pour node --test hors CI).
process.env.KORA_MFA_KEY ??=
  'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
// Import APRÈS la clé : MfaService la lit à l'instanciation (fail-fast).
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
const email3 = `sarah.${rid}@demo.bj`;
const email4 = `ratelimit.${rid}@demo.bj`;
const email5 = `mireille.${rid}@demo.bj`;
const email6 = `christian.${rid}@demo.bj`;
const email7 = `ade.${rid}@demo.bj`;
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
  psql(
    `INSERT INTO admin.users (tenant_id, email, password_hash) VALUES ('${tenantId}', '${email3}', '${hash}')`,
  );
  for (const email of [email4, email5]) {
    psql(
      `INSERT INTO admin.users (tenant_id, email, password_hash) VALUES ('${tenantId}', '${email}', '${hash}')`,
    );
  }
  const user6 = psql(
    `INSERT INTO admin.users (tenant_id, email, password_hash) VALUES ('${tenantId}', '${email6}', '${hash}') RETURNING id`,
  );
  const user7 = psql(
    `INSERT INTO admin.users (tenant_id, email, password_hash) VALUES ('${tenantId}', '${email7}', '${hash}') RETURNING id`,
  );

  // Fixtures RBAC : permission au catalogue, rôle, liaison, portées (tenant vs site).
  psql(`INSERT INTO core.employees (tenant_id, matricule, first_name, last_name)
        VALUES ('${tenantId}', 'E2E-0001', 'Awa', 'Sossou')`);
  psql(`INSERT INTO admin.permissions (key, description)
        VALUES ('employees.view', 'e2e') ON CONFLICT (key) DO NOTHING`);
  const roleId = psql(
    `INSERT INTO admin.roles (tenant_id, key, name) VALUES ('${tenantId}', 'hr-e2e-${rid}', 'HR E2E') RETURNING id`,
  );
  psql(`INSERT INTO admin.role_permissions (tenant_id, role_id, permission_key)
        VALUES ('${tenantId}', '${roleId}', 'employees.view')`);
  psql(`INSERT INTO admin.user_roles (tenant_id, user_id, role_id) VALUES
        ('${tenantId}', '${user6}', '${roleId}'), ('${tenantId}', '${user7}', '${roleId}')`);
  psql(`INSERT INTO admin.user_scopes (tenant_id, user_id, scope_type) VALUES ('${tenantId}', '${user6}', 'tenant')`);
  // Depuis E8, scope_ref est VALIDÉ contre l'organisation (trigger 0014) : la portée
  // « site » doit référencer un site RÉEL du tenant — on le crée donc.
  const e2eCompany = psql(`INSERT INTO org.companies (tenant_id, code, label_fr, label_en, status)
        VALUES ('${tenantId}', 'E2E-CO-${rid.toUpperCase()}', 'Société e2e', 'E2e company', 'active') RETURNING id`);
  const e2eSite = psql(`INSERT INTO org.sites (tenant_id, company_id, code, label_fr, label_en, status)
        VALUES ('${tenantId}', '${e2eCompany}', 'E2E-SITE-${rid.toUpperCase()}', 'Site e2e', 'E2e site', 'active') RETURNING id`);
  psql(`INSERT INTO admin.user_scopes (tenant_id, user_id, scope_type, scope_ref)
        VALUES ('${tenantId}', '${user7}', 'site', '${e2eSite}')`);

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

test('désactivation : la session d’un utilisateur désactivé est refusée ET révoquée', async () => {
  const res = await login({ tenantSlug: slug, email: email1, password: GOOD_PASSWORD });
  assert.equal(res.status, 200);
  const { token } = (await res.json()) as { token: string };

  psql(`UPDATE admin.users SET is_active = false WHERE email = '${email1}'`);
  const me = await fetch(`${base}/auth/me`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(me.status, 401, 'compte désactivé = session inutilisable immédiatement');

  const revoked = psql(
    `SELECT (revoked_at IS NOT NULL)::text FROM admin.sessions WHERE token_hash = '${hashSessionToken(token)}'`,
  );
  assert.equal(revoked, 'true', 'la session présentée a été révoquée');

  psql(`UPDATE admin.users SET is_active = true WHERE email = '${email1}'`);
  const meAfterReactivation = await fetch(`${base}/auth/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(meAfterReactivation.status, 401, 'la révocation est définitive, pas suspendue');
});

test('concurrence : deux échecs simultanés incrémentent le compteur de 2 (atomicité)', async () => {
  const [a, b] = await Promise.all([
    login({ tenantSlug: slug, email: email3, password: 'Mauvais-2026!' }),
    login({ tenantSlug: slug, email: email3, password: 'Mauvais-2026!' }),
  ]);
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  const count = Number(
    psql(`SELECT failed_login_count FROM admin.users WHERE email = '${email3}'`),
  );
  assert.equal(count, 2, 'aucun incrément perdu sous concurrence');
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

// ---------- Tranche 2 : MFA de bout en bout, RBAC, OpenAPI, rate limiting ----------

const nowSec = () => Math.floor(Date.now() / 1000);
let mfaSecret = '';
let mfaToken = '';
let recoveryCodes: string[] = [];

async function authed(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
  });
}

test('MFA : enrôlement puis activation avec preuve de possession', async () => {
  const res = await login({ tenantSlug: slug, email: email5, password: GOOD_PASSWORD });
  assert.equal(res.status, 200);
  mfaToken = ((await res.json()) as { token: string }).token;

  const enroll = await authed('/auth/mfa/enroll', mfaToken, { method: 'POST' });
  assert.equal(enroll.status, 200);
  const enrollBody = (await enroll.json()) as { secret: string; otpauthUri: string };
  mfaSecret = enrollBody.secret;
  assert.match(mfaSecret, /^[A-Z2-7]{32}$/);
  assert.ok(enrollBody.otpauthUri.startsWith('otpauth://totp/'));

  const badActivate = await authed('/auth/mfa/activate', mfaToken, {
    method: 'POST',
    body: JSON.stringify({ code: '000000' }),
  });
  assert.equal(badActivate.status, 401, 'activation sans preuve de possession refusée');

  const activate = await authed('/auth/mfa/activate', mfaToken, {
    method: 'POST',
    body: JSON.stringify({ code: totp(mfaSecret, nowSec()) }),
  });
  assert.equal(activate.status, 200);
  recoveryCodes = ((await activate.json()) as { recoveryCodes: string[] }).recoveryCodes;
  assert.equal(recoveryCodes.length, 8);
  for (const c of recoveryCodes) assert.match(c, /^[A-Z2-7]{4}-[A-Z2-7]{4}$/);

  const reEnroll = await authed('/auth/mfa/enroll', mfaToken, { method: 'POST' });
  assert.equal(reEnroll.status, 409, 'ré-enrôlement refusé tant que le MFA est actif');
});

test('MFA : le login exige le second facteur', async () => {
  const sans = await login({ tenantSlug: slug, email: email5, password: GOOD_PASSWORD });
  assert.equal(sans.status, 401);
  assert.equal(((await sans.json()) as { code?: string }).code, 'mfa_required');

  const mauvais = await login({
    tenantSlug: slug,
    email: email5,
    password: GOOD_PASSWORD,
    mfaCode: '000000',
  });
  assert.equal(mauvais.status, 401, 'mauvais TOTP = identifiants invalides (générique)');

  const bon = await login({
    tenantSlug: slug,
    email: email5,
    password: GOOD_PASSWORD,
    mfaCode: totp(mfaSecret, nowSec()),
  });
  assert.equal(bon.status, 200);
  mfaToken = ((await bon.json()) as { token: string }).token;
});

test('MFA : code de récupération à usage strictement unique', async () => {
  const premiere = await login({
    tenantSlug: slug,
    email: email5,
    password: GOOD_PASSWORD,
    mfaCode: recoveryCodes[0]!,
  });
  assert.equal(premiere.status, 200, 'un code de récupération permet de se connecter');
  mfaToken = ((await premiere.json()) as { token: string }).token;

  const rejouee = await login({
    tenantSlug: slug,
    email: email5,
    password: GOOD_PASSWORD,
    mfaCode: recoveryCodes[0]!,
  });
  assert.equal(rejouee.status, 401, 'le même code rejoué est refusé');
});

test('MFA : rotation des codes (TOTP exigé) puis désactivation complète', async () => {
  const rotate = await authed('/auth/mfa/recovery-codes', mfaToken, {
    method: 'POST',
    body: JSON.stringify({ code: totp(mfaSecret, nowSec()) }),
  });
  assert.equal(rotate.status, 200);
  const nouveaux = ((await rotate.json()) as { recoveryCodes: string[] }).recoveryCodes;
  assert.equal(nouveaux.length, 8);

  const ancienInvalide = await login({
    tenantSlug: slug,
    email: email5,
    password: GOOD_PASSWORD,
    mfaCode: recoveryCodes[1]!,
  });
  assert.equal(ancienInvalide.status, 401, 'la rotation invalide les anciens codes');

  const disable = await authed('/auth/mfa/disable', mfaToken, {
    method: 'POST',
    body: JSON.stringify({ code: totp(mfaSecret, nowSec()) }),
  });
  assert.equal(disable.status, 200);

  const apres = await login({ tenantSlug: slug, email: email5, password: GOOD_PASSWORD });
  assert.equal(apres.status, 200, 'après désactivation, le mot de passe seul suffit');
});

test('RBAC : permission chargée en base, anti-élévation par portée', async () => {
  const t6 = ((await (await login({ tenantSlug: slug, email: email6, password: GOOD_PASSWORD })).json()) as { token: string }).token;
  const ok = await authed('/employees', t6);
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as { items: Array<{ matricule: string }>; count: number };
  assert.ok(body.items.some((e) => e.matricule === 'E2E-0001'), 'le salarié seedé est visible');

  // Depuis E9, les PORTÉES RÉELLES s'appliquent : la portée site n'est plus un refus
  // sec (v1) mais un PÉRIMÈTRE — l'utilisateur voit uniquement les salariés dont
  // l'affectation principale tombe sur son site. Le salarié seedé n'a AUCUNE
  // affectation : il reste invisible pour cette portée (anti-élévation conservée).
  const t7 = ((await (await login({ tenantSlug: slug, email: email7, password: GOOD_PASSWORD })).json()) as { token: string }).token;
  const portee = await authed('/employees', t7);
  assert.equal(portee.status, 200, 'portée site = liste bornée au périmètre, pas un refus');
  const borne = (await portee.json()) as { items: Array<{ matricule: string }> };
  assert.ok(!borne.items.some((e) => e.matricule === 'E2E-0001'),
    'un salarié sans affectation dans le périmètre du site reste invisible');

  const t1 = ((await (await login({ tenantSlug: slug, email: email1, password: GOOD_PASSWORD })).json()) as { token: string }).token;
  const aucunRole = await authed('/employees', t1);
  assert.equal(aucunRole.status, 403, 'aucun rôle = refus');
});

test('OpenAPI : spécification servie, fidèle aux endpoints vivants', async () => {
  const res = await fetch(`${base}/openapi.json`);
  assert.equal(res.status, 200);
  const spec = (await res.json()) as {
    openapi: string;
    paths: Record<string, unknown>;
    components: { securitySchemes: Record<string, unknown> };
  };
  assert.equal(spec.openapi, '3.0.3');
  for (const p of ['/auth/login', '/auth/mfa/activate', '/auth/mfa/disable', '/employees']) {
    assert.ok(spec.paths[p], `chemin ${p} documenté`);
  }
  assert.ok(spec.components.securitySchemes['bearerAuth']);
});

test('Rate limiting : la salve déclenche 401 → 423 → 429, avec Retry-After', async () => {
  const statuts: number[] = [];
  for (let i = 1; i <= 11; i++) {
    const res = await login({ tenantSlug: slug, email: email4, password: 'Mauvais-2026!' });
    statuts.push(res.status);
    if (i === 11) {
      const body = (await res.json()) as { retryAfterSeconds?: number };
      assert.ok((body.retryAfterSeconds ?? 0) >= 1, 'Retry-After présent sur 429');
    }
  }
  assert.deepEqual(statuts.slice(0, 5), [401, 401, 401, 401, 401], '5 échecs de mot de passe');
  assert.deepEqual(statuts.slice(5, 10), [423, 423, 423, 423, 423], 'puis verrouillage progressif');
  assert.equal(statuts[10], 429, 'puis limitation de débit avant toute transaction');
});
