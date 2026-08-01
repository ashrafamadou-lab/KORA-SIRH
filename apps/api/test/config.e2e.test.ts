/**
 * E2E Config Center (E4) — couvre les conditions de validation du sponsor : résolution
 * passé/présent/futur, draft jamais résolu, approuvé pas actif avant sa date d'effet,
 * supersession sans réécriture d'historique, activations concurrentes rejetées, surcharge
 * tenant vs global, activation impossible sans source/vérif/contreseing, séparation des
 * tâches (créateur ≠ vérificateur ≠ activateur), lien décision↔version, rejet+resoumission,
 * isolation inter-tenant. Le contreseing passe par le Workflow Engine (E3) validé.
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
const P = 'Trajet-Manguier-2026!';
const slugA = `cfg-a-${rid}`;
const slugB = `cfg-b-${rid}`;
const authorEmail = `author.${rid}@demo.bj`;
const verifierEmail = `verifier.${rid}@demo.bj`;
const activatorEmail = `activator.${rid}@demo.bj`;
const bUserEmail = `buser.${rid}@demo.bj`;

let app: INestApplication;
let base = '';
let csDefKey = '';

async function seedUser(tenantId: string, email: string, roleIds: string[]): Promise<string> {
  const h = await argon2.hash(P, { type: argon2.argon2id });
  const id = psql(`INSERT INTO admin.users (tenant_id, email, password_hash) VALUES ('${tenantId}','${email}','${h}') RETURNING id`);
  psql(`INSERT INTO admin.user_scopes (tenant_id, user_id, scope_type) VALUES ('${tenantId}','${id}','tenant')`);
  for (const r of roleIds) psql(`INSERT INTO admin.user_roles (tenant_id, user_id, role_id) VALUES ('${tenantId}','${id}','${r}')`);
  return id;
}
function role(tenantId: string, key: string, perms: string[]): string {
  const id = psql(`INSERT INTO admin.roles (tenant_id, key, name) VALUES ('${tenantId}','${key}','${key}') RETURNING id`);
  for (const p of perms) psql(`INSERT INTO admin.role_permissions (tenant_id, role_id, permission_key) VALUES ('${tenantId}','${id}','${p}')`);
  return id;
}

before(async () => {
  const tenantA = psql(`INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('${slugA}','CFG A',true) RETURNING id`);
  const tenantB = psql(`INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('${slugB}','CFG B',true) RETURNING id`);

  // Rôle métier « param_verifier » (assignation d'étape du workflow de contreseing).
  const verifierRoleA = role(tenantA, `param_verifier-${rid}`, []);
  // Rôles applicatifs.
  const authorRole = role(tenantA, `author-${rid}`, [
    'parameters.view', 'legal_parameters.create', 'legal_parameters.submit',
    'workflow.manage', 'workflow.submit', 'workflow.view',
  ]);
  const verifierRole = role(tenantA, `verifier-${rid}`, ['parameters.view', 'workflow.act', 'workflow.view']);
  const activatorRole = role(tenantA, `activator-${rid}`, ['parameters.view', 'legal_parameters.activate', 'parameters.activate', 'workflow.view']);

  await seedUser(tenantA, authorEmail, [authorRole]);
  await seedUser(tenantA, verifierEmail, [verifierRole, verifierRoleA]);
  await seedUser(tenantA, activatorEmail, [activatorRole]);

  const bRole = role(tenantB, `bview-${rid}`, ['parameters.view']);
  await seedUser(tenantB, bUserEmail, [bRole]);

  app = await createApp();
  await app.listen(0);
  const addr = app.getHttpServer().address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  base = `http://127.0.0.1:${port}/api/v1`;

  // Définition de workflow de contreseing (1 étape : param_verifier), créée + activée par l'author.
  csDefKey = `param_cs_${rid}`;
  const authorTok = await token(slugA, authorEmail);
  const def = (await (await api('/workflow/definitions', authorTok, {
    key: csDefKey, name: 'Contreseing paramètre',
    steps: [{ index: 0, name: 'Vérification', approverType: 'role', approverRef: `param_verifier-${rid}` }],
  })).json()) as { id: string };
  await api(`/workflow/definitions/${def.id}/activate`, authorTok);
});

after(async () => { if (app) await app.close(); });

const tokenCache = new Map<string, string>();
async function token(slug: string, email: string): Promise<string> {
  const c = tokenCache.get(email); if (c) return c;
  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenantSlug: slug, email, password: P }) });
  assert.equal(res.status, 200, `login ${email}`);
  const tok = ((await res.json()) as { token: string }).token;
  tokenCache.set(email, tok); return tok;
}
function api(path: string, tok: string, body?: unknown, method = 'POST'): Promise<Response> {
  return fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
}

/** Cycle complet create→submit→(verifier approve)→ retourne l'id du paramètre approuvé. */
async function makeApprovedParam(key: string, value: unknown, effectiveFrom: string): Promise<string> {
  const authorTok = await token(slugA, authorEmail);
  const verifierTok = await token(slugA, verifierEmail);
  const created = await api('/config/parameters', authorTok, { key, value, effectiveFrom, sourceText: 'Code, art. X', legalRef: 'TRV-XX' });
  assert.equal(created.status, 201, 'création draft');
  const id = ((await created.json()) as { id: string }).id;
  const submitted = await api(`/config/parameters/${id}/submit`, authorTok, { definitionKey: csDefKey });
  assert.equal(submitted.status, 200, 'soumission');
  const instanceId = ((await submitted.json()) as { instanceId: string }).instanceId;
  const approve = await api(`/workflow/instances/${instanceId}/approve`, verifierTok);
  assert.equal(approve.status, 200, 'approbation workflow');
  assert.equal(psql(`SELECT status FROM compliance.legal_parameters WHERE id='${id}'`), 'approved', 'param passe à approved via contreseing');
  return id;
}

test('création : un paramètre juridique sans source est refusé (400)', async () => {
  const authorTok = await token(slugA, authorEmail);
  const res = await api('/config/parameters', authorTok, { key: `x.${rid}_a`, value: 1, effectiveFrom: '2000-01-01' });
  assert.equal(res.status, 400, 'source requise pour un paramètre juridique');
});

test('draft jamais résolu ; approuvé pas actif avant activation', async () => {
  const key = `temps.${rid}_hebdo`;
  const id = await makeApprovedParam(key, 40, '2000-01-01');
  // Avant activation : aucune valeur résolue (le draft/submitted/approved n'est pas dans la timeline).
  const authorTok = await token(slugA, authorEmail);
  const r = await api(`/config/parameters/resolve?key=${key}&date=2010-01-01`, authorTok, undefined, 'GET');
  assert.equal(r.status, 404, 'un approuvé non activé ne résout rien');
  void id;
});

test('activation immédiate + résolution présent/passé', async () => {
  const key = `smig.${rid}`;
  const id = await makeApprovedParam(key, 52000, '2000-01-01');
  const activatorTok = await token(slugA, activatorEmail);
  const act = await api(`/config/parameters/${id}/activate`, activatorTok);
  assert.equal(act.status, 200);
  assert.equal(((await act.json()) as { status: string }).status, 'active');
  const r = await api(`/config/parameters/resolve?key=${key}&date=2010-01-01`, activatorTok, undefined, 'GET');
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { value: number }).value, 52000);
});

test('séparation des tâches : le créateur ne peut ni vérifier ni activer', async () => {
  // Donner au créateur le rôle param_verifier ET la permission d'activation : il doit
  // rester bloqué (anti-auto-approbation E3 + séparation E4).
  const authorId = psql(`SELECT id FROM admin.users WHERE email='${authorEmail}'`);
  psql(`INSERT INTO admin.user_roles (tenant_id, user_id, role_id)
        SELECT t.id, '${authorId}', r.id FROM admin.tenants t, admin.roles r
        WHERE t.slug='${slugA}' AND r.tenant_id=t.id AND r.key IN ('param_verifier-${rid}','activator-${rid}')
        ON CONFLICT DO NOTHING`);
  const authorTok = await token(slugA, authorEmail);
  const key = `sep.${rid}`;
  const created = await api('/config/parameters', authorTok, { key, value: 1, effectiveFrom: '2000-01-01', sourceText: 's' });
  const paramId = ((await created.json()) as { id: string }).id;
  const submitted = await api(`/config/parameters/${paramId}/submit`, authorTok, { definitionKey: csDefKey });
  const instanceId = ((await submitted.json()) as { instanceId: string }).instanceId;
  // Le créateur tente d'approuver SON contreseing → refusé (séparation E3).
  assert.equal((await api(`/workflow/instances/${instanceId}/approve`, authorTok)).status, 403, 'créateur ne peut pas vérifier');
  // Faire approuver par le vrai vérificateur, puis le créateur tente d'activer → refusé (séparation E4).
  const verifierTok = await token(slugA, verifierEmail);
  assert.equal((await api(`/workflow/instances/${instanceId}/approve`, verifierTok)).status, 200);
  assert.equal((await api(`/config/parameters/${paramId}/activate`, authorTok)).status, 403, 'créateur ne peut pas activer son paramètre juridique');
});

test('activation impossible sans contreseing approuvé', async () => {
  const authorTok = await token(slugA, authorEmail);
  const activatorTok = await token(slugA, activatorEmail);
  const key = `nocs.${rid}`;
  const created = await api('/config/parameters', authorTok, { key, value: 1, effectiveFrom: '2000-01-01', sourceText: 's' });
  const id = ((await created.json()) as { id: string }).id;
  await api(`/config/parameters/${id}/submit`, authorTok, { definitionKey: csDefKey });
  // param est 'submitted', workflow pas encore approuvé → activation refusée.
  assert.equal((await api(`/config/parameters/${id}/activate`, activatorTok)).status, 409, 'pas d’activation sans contreseing');
});

test('activation planifiée : pas active avant la date d’effet, résolue à sa date future', async () => {
  const key = `future.${rid}`;
  const id = await makeApprovedParam(key, 100, '2099-01-01');
  const activatorTok = await token(slugA, activatorEmail);
  const act = await api(`/config/parameters/${id}/activate`, activatorTok);
  assert.equal(((await act.json()) as { status: string }).status, 'scheduled', 'date d’effet future → scheduled');
  // Aujourd'hui : rien (fenêtre commence en 2099).
  assert.equal((await api(`/config/parameters/resolve?key=${key}&date=2030-01-01`, activatorTok, undefined, 'GET')).status, 404);
  // En 2099 : la valeur planifiée s'applique.
  const r = await api(`/config/parameters/resolve?key=${key}&date=2099-06-01`, activatorTok, undefined, 'GET');
  assert.equal(((await r.json()) as { value: number }).value, 100);
});

test('supersession : la nouvelle version remplace l’ancienne sans réécrire son historique', async () => {
  const key = `super.${rid}`;
  const activatorTok = await token(slugA, activatorEmail);
  const id1 = await makeApprovedParam(key, 'ancienne', '2000-01-01');
  await api(`/config/parameters/${id1}/activate`, activatorTok);
  const id2 = await makeApprovedParam(key, 'nouvelle', '2020-01-01');
  assert.equal((await api(`/config/parameters/${id2}/activate`, activatorTok)).status, 200);
  // Résolution : 2010 → ancienne (superseded, fenêtre [2000,2020)), 2021 → nouvelle.
  assert.equal(((await (await api(`/config/parameters/resolve?key=${key}&date=2010-01-01`, activatorTok, undefined, 'GET')).json()) as { value: string }).value, 'ancienne');
  assert.equal(((await (await api(`/config/parameters/resolve?key=${key}&date=2021-01-01`, activatorTok, undefined, 'GET')).json()) as { value: string }).value, 'nouvelle');
  // L'ancienne version conserve sa valeur (historique non réécrit).
  assert.equal(psql(`SELECT value FROM compliance.legal_parameters WHERE id='${id1}'`), '"ancienne"');
  assert.equal(psql(`SELECT status FROM compliance.legal_parameters WHERE id='${id1}'`), 'superseded');
});

test('activations concurrentes de la même version : une seule réussit', async () => {
  const key = `conc.${rid}`;
  const id = await makeApprovedParam(key, 7, '2000-01-01');
  const activatorTok = await token(slugA, activatorEmail);
  const [r1, r2] = await Promise.all([
    api(`/config/parameters/${id}/activate`, activatorTok),
    api(`/config/parameters/${id}/activate`, activatorTok),
  ]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409], 'une activation réussit, l’autre est rejetée');
  assert.equal(psql(`SELECT count(*) FROM compliance.legal_parameters WHERE key='${key}' AND status='active'`), '1');
});

test('chevauchement : une date d’effet antérieure à la version en vigueur est rejetée', async () => {
  const key = `overlap.${rid}`;
  const activatorTok = await token(slugA, activatorEmail);
  const id1 = await makeApprovedParam(key, 'v-2010', '2010-01-01');
  await api(`/config/parameters/${id1}/activate`, activatorTok);
  const id2 = await makeApprovedParam(key, 'v-2005', '2005-01-01'); // antérieure à l'active
  const res = await api(`/config/parameters/${id2}/activate`, activatorTok);
  assert.equal(res.status, 409, 'chevauchement de périodes rejeté');
  assert.equal(((await res.json()) as { code?: string }).code, 'overlap');
});

test('rejet puis resoumission', async () => {
  const authorTok = await token(slugA, authorEmail);
  const verifierTok = await token(slugA, verifierEmail);
  const key = `reject.${rid}`;
  const created = await api('/config/parameters', authorTok, { key, value: 1, effectiveFrom: '2000-01-01', sourceText: 's' });
  const id = ((await created.json()) as { id: string }).id;
  const instanceId = ((await (await api(`/config/parameters/${id}/submit`, authorTok, { definitionKey: csDefKey })).json()) as { instanceId: string }).instanceId;
  assert.equal((await api(`/workflow/instances/${instanceId}/reject`, verifierTok, { comment: 'source insuffisante' })).status, 200);
  assert.equal(psql(`SELECT status FROM compliance.legal_parameters WHERE id='${id}'`), 'rejected', 'rejet du contreseing');
  // Resoumission : repartir d'un draft.
  assert.equal((await api(`/config/parameters/${id}/reset-draft`, authorTok)).status, 200);
  assert.equal(psql(`SELECT status FROM compliance.legal_parameters WHERE id='${id}'`), 'draft');
  assert.equal((await api(`/config/parameters/${id}/submit`, authorTok, { definitionKey: csDefKey })).status, 200, 'resoumission possible');
});

test('lien décision ↔ version exacte : approuver un contreseing n’affecte que sa version', async () => {
  const authorTok = await token(slugA, authorEmail);
  const verifierTok = await token(slugA, verifierEmail);
  const mk = async (k: string) => {
    const id = ((await (await api('/config/parameters', authorTok, { key: k, value: 1, effectiveFrom: '2000-01-01', sourceText: 's' })).json()) as { id: string }).id;
    const inst = ((await (await api(`/config/parameters/${id}/submit`, authorTok, { definitionKey: csDefKey })).json()) as { instanceId: string }).instanceId;
    return { id, inst };
  };
  const p1 = await mk(`link1.${rid}`);
  const p2 = await mk(`link2.${rid}`);
  await api(`/workflow/instances/${p1.inst}/approve`, verifierTok);
  assert.equal(psql(`SELECT status FROM compliance.legal_parameters WHERE id='${p1.id}'`), 'approved');
  assert.equal(psql(`SELECT status FROM compliance.legal_parameters WHERE id='${p2.id}'`), 'submitted', 'la 2e version reste soumise');
});

test('surcharge tenant vs global + isolation inter-tenant', async () => {
  const key = `global.${rid}`;
  // Paramètre GLOBAL (tenant_id NULL) — seedé par la plateforme (kora_app ne peut pas écrire de global).
  psql(`INSERT INTO compliance.legal_parameters (country_code, key, value, effective_from, source_text, verified_by, verified_at, status)
        VALUES ('BJ','${key}','"global"'::jsonb, DATE '2000-01-01', 's','J', DATE '2000-01-01','active')`);
  // Surcharge du tenant A via le cycle complet.
  const activatorTok = await token(slugA, activatorEmail);
  const idA = await makeApprovedParam(key, 'tenant-a', '2000-01-01');
  assert.equal((await api(`/config/parameters/${idA}/activate`, activatorTok)).status, 200);

  // A résout SA surcharge ; B (aucune surcharge) résout le global.
  const bTok = await token(slugB, bUserEmail);
  const rA = (await (await api(`/config/parameters/resolve?key=${key}&date=2010-01-01`, activatorTok, undefined, 'GET')).json()) as { value: string; scope: string };
  const rB = (await (await api(`/config/parameters/resolve?key=${key}&date=2010-01-01`, bTok, undefined, 'GET')).json()) as { value: string; scope: string };
  assert.equal(rA.value, 'tenant-a'); assert.equal(rA.scope, 'tenant');
  assert.equal(rB.value, 'global'); assert.equal(rB.scope, 'country');
  // Le global reste intact.
  assert.equal(psql(`SELECT value FROM compliance.legal_parameters WHERE key='${key}' AND tenant_id IS NULL`), '"global"');
  // B ne voit pas la surcharge de A dans l'historique.
  const histB = (await (await api(`/config/parameters/history?key=${key}`, bTok, undefined, 'GET')).json()) as Array<{ value: string }>;
  assert.ok(!histB.some((h) => h.value === 'tenant-a'), 'la surcharge de A est invisible pour B');
});

test('preview : montre la valeur candidate et celle actuellement applicable', async () => {
  const key = `preview.${rid}`;
  const activatorTok = await token(slugA, activatorEmail);
  const id1 = await makeApprovedParam(key, 'v1', '2000-01-01');
  await api(`/config/parameters/${id1}/activate`, activatorTok);
  const authorTok = await token(slugA, authorEmail);
  const id2 = ((await (await api('/config/parameters', authorTok, { key, value: 'v2', effectiveFrom: '2020-01-01', sourceText: 's' })).json()) as { id: string }).id;
  const pv = (await (await api(`/config/parameters/${id2}/preview`, authorTok, undefined, 'GET')).json()) as { candidateValue: string; currentlyApplicableAtThatDate: { value: string } };
  assert.equal(pv.candidateValue, 'v2');
  assert.equal(pv.currentlyApplicableAtThatDate.value, 'v1', 'à 2020, v1 s’applique encore avant activation de v2');
});

test('OpenAPI : endpoints config documentés', async () => {
  const spec = (await (await fetch(`${base}/openapi.json`)).json()) as { paths: Record<string, unknown> };
  for (const p of ['/config/parameters', '/config/parameters/{id}/submit', '/config/parameters/{id}/activate', '/config/parameters/resolve', '/config/parameters/history']) {
    assert.ok(spec.paths[p], `chemin ${p} documenté`);
  }
});
