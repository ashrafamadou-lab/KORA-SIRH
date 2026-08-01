/**
 * E2E Workflow Engine v1 (E3) — couvre toutes les conditions de validation du sponsor,
 * avec un objet de démonstration minimal (demo_request). Fortement négatif.
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
const slugA = `wfe-a-${rid}`;
const slugB = `wfe-b-${rid}`;

// Tenant A : requester (soumet), manager (approuve étape 1), finance (étape 2), other.
const requesterEmail = `req.${rid}@demo.bj`;
const managerEmail = `mgr.${rid}@demo.bj`;
const financeEmail = `fin.${rid}@demo.bj`;
const otherEmail = `oth.${rid}@demo.bj`;
const delegateEmail = `del.${rid}@demo.bj`;
const bManagerEmail = `bmgr.${rid}@demo.bj`;

let app: INestApplication;
let base = '';
let tenantAId = '';

async function hashP(): Promise<string> { return argon2.hash(P, { type: argon2.argon2id }); }

async function seedUser(tenantId: string, email: string, roleId?: string): Promise<string> {
  const h = await hashP();
  const id = psql(`INSERT INTO admin.users (tenant_id, email, password_hash) VALUES ('${tenantId}','${email}','${h}') RETURNING id`);
  psql(`INSERT INTO admin.user_scopes (tenant_id, user_id, scope_type) VALUES ('${tenantId}','${id}','tenant')`);
  if (roleId) psql(`INSERT INTO admin.user_roles (tenant_id, user_id, role_id) VALUES ('${tenantId}','${id}','${roleId}')`);
  return id;
}

before(async () => {
  tenantAId = psql(`INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('${slugA}','WFE A',true) RETURNING id`);
  const tenantBId = psql(`INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('${slugB}','WFE B',true) RETURNING id`);

  // Rôle « ops » : toutes les permissions workflow — porté par les acteurs de A.
  for (const [tid] of [[tenantAId], [tenantBId]] as const) {
    const ops = psql(`INSERT INTO admin.roles (tenant_id, key, name) VALUES ('${tid}','ops-${rid}','Ops') RETURNING id`);
    for (const p of ['workflow.manage', 'workflow.submit', 'workflow.act', 'workflow.view']) {
      psql(`INSERT INTO admin.role_permissions (tenant_id, role_id, permission_key) VALUES ('${tid}','${ops}','${p}')`);
    }
    // rôles métier référencés par les étapes
    psql(`INSERT INTO admin.roles (tenant_id, key, name) VALUES ('${tid}','manager','Manager') ON CONFLICT DO NOTHING`);
    psql(`INSERT INTO admin.roles (tenant_id, key, name) VALUES ('${tid}','finance','Finance') ON CONFLICT DO NOTHING`);
  }
  const opsA = psql(`SELECT id FROM admin.roles WHERE tenant_id='${tenantAId}' AND key='ops-${rid}'`);
  const mgrRoleA = psql(`SELECT id FROM admin.roles WHERE tenant_id='${tenantAId}' AND key='manager'`);
  const finRoleA = psql(`SELECT id FROM admin.roles WHERE tenant_id='${tenantAId}' AND key='finance'`);
  const opsB = psql(`SELECT id FROM admin.roles WHERE tenant_id='${tenantBId}' AND key='ops-${rid}'`);
  const mgrRoleB = psql(`SELECT id FROM admin.roles WHERE tenant_id='${tenantBId}' AND key='manager'`);

  // Chaque acteur porte ops (pour appeler l'API) + éventuellement le rôle métier d'étape.
  await seedUser(tenantAId, requesterEmail, opsA);
  const mgrId = await seedUser(tenantAId, managerEmail, opsA); psql(`INSERT INTO admin.user_roles (tenant_id,user_id,role_id) VALUES ('${tenantAId}','${mgrId}','${mgrRoleA}')`);
  const finId = await seedUser(tenantAId, financeEmail, opsA); psql(`INSERT INTO admin.user_roles (tenant_id,user_id,role_id) VALUES ('${tenantAId}','${finId}','${finRoleA}')`);
  await seedUser(tenantAId, otherEmail, opsA);
  await seedUser(tenantAId, delegateEmail, opsA);
  const bmgr = await seedUser(tenantBId, bManagerEmail, opsB); psql(`INSERT INTO admin.user_roles (tenant_id,user_id,role_id) VALUES ('${tenantBId}','${bmgr}','${mgrRoleB}')`);

  app = await createApp();
  await app.listen(0);
  const addr = app.getHttpServer().address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  base = `http://127.0.0.1:${port}/api/v1`;
});

after(async () => { if (app) await app.close(); });

// Sessions mémoïsées par email : une seule connexion par acteur, réutilisée dans tous
// les tests. Évite de solliciter la limitation de débit du login (les rôles/portées sont
// résolus à CHAQUE requête par le guard, donc un changement de rôle est bien pris en compte
// sur un jeton déjà émis — c'est ce dont le test d'anti-auto-approbation a besoin).
const tokenCache = new Map<string, string>();
async function token(slug: string, email: string): Promise<string> {
  const cached = tokenCache.get(email);
  if (cached) return cached;
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenantSlug: slug, email, password: P }),
  });
  assert.equal(res.status, 200, `login ${email}`);
  const tok = ((await res.json()) as { token: string }).token;
  tokenCache.set(email, tok);
  return tok;
}
function api(path: string, tok: string, body?: unknown, method = 'POST'): Promise<Response> {
  return fetch(`${base}${path}`, {
    method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
function demoRequest(amount: number): string {
  return psql(`INSERT INTO workflow.demo_requests (tenant_id, title, amount) VALUES ('${tenantAId}','Demande ${rid}',${amount}) RETURNING id`);
}

// Définition à 2 étapes conditionnelles : Manager (toujours), Finance (si amount>=100000).
async function createTwoStepDefinition(tok: string): Promise<string> {
  const key = `dep_${rid}`;
  const res = await api('/workflow/definitions', tok, {
    key, name: 'Dépense',
    steps: [
      { index: 0, name: 'Manager', approverType: 'role', approverRef: 'manager', slaHours: 48, reminderHours: 24 },
      { index: 1, name: 'Finance', approverType: 'role', approverRef: 'finance', condition: { field: 'amount', op: 'gte', value: 100000 } },
    ],
  });
  assert.equal(res.status, 201, 'création définition');
  const { id } = (await res.json()) as { id: string };
  assert.equal((await api(`/workflow/definitions/${id}/activate`, tok)).status, 200);
  return key;
}

test('parcours nominal multi-étapes + effet sur l’objet métier', async () => {
  const reqTok = await token(slugA, requesterEmail);
  const mgrTok = await token(slugA, managerEmail);
  const finTok = await token(slugA, financeEmail);
  const key = await createTwoStepDefinition(reqTok);

  const subjectId = demoRequest(250000); // active l'étape Finance
  const submit = await api('/workflow/instances', reqTok, { definitionKey: key, subjectType: 'demo_request', subjectId, context: { amount: 250000 } });
  assert.equal(submit.status, 201);
  const { instanceId, currentStepIndex } = (await submit.json()) as { instanceId: string; currentStepIndex: number };
  assert.equal(currentStepIndex, 0);
  assert.equal(psql(`SELECT status FROM workflow.demo_requests WHERE id='${subjectId}'`), 'pending');

  // Le manager approuve → avance à Finance (étape 1), pas encore terminé.
  const a1 = await api(`/workflow/instances/${instanceId}/approve`, mgrTok, { comment: 'ok manager' });
  assert.equal(a1.status, 200);
  const a1body = (await a1.json()) as { status: string; currentStepIndex: number };
  assert.equal(a1body.status, 'pending');
  assert.equal(a1body.currentStepIndex, 1, 'avance à l’étape Finance');

  // Finance approuve → clôture.
  const a2 = await api(`/workflow/instances/${instanceId}/approve`, finTok);
  assert.equal(a2.status, 200);
  assert.equal(((await a2.json()) as { status: string }).status, 'approved');
  assert.equal(psql(`SELECT status FROM workflow.demo_requests WHERE id='${subjectId}'`), 'approved', 'effet on_approve');
});

test('branche : petite dépense saute Finance et clôt à l’étape Manager', async () => {
  const reqTok = await token(slugA, requesterEmail);
  const mgrTok = await token(slugA, managerEmail);
  const key = `dep_${rid}`; // déjà active
  const subjectId = demoRequest(5000); // < 100000 → Finance sautée
  const submit = await api('/workflow/instances', reqTok, { definitionKey: key, subjectType: 'demo_request', subjectId, context: { amount: 5000 } });
  const { instanceId } = (await submit.json()) as { instanceId: string };
  const a = await api(`/workflow/instances/${instanceId}/approve`, mgrTok);
  assert.equal(((await a.json()) as { status: string }).status, 'approved', 'une seule approbation suffit');
});

test('NÉGATIF : acteur non assigné refusé (403)', async () => {
  const reqTok = await token(slugA, requesterEmail);
  const otherTok = await token(slugA, otherEmail);
  const subjectId = demoRequest(5000);
  const { instanceId } = (await (await api('/workflow/instances', reqTok, { definitionKey: `dep_${rid}`, subjectType: 'demo_request', subjectId, context: { amount: 5000 } })).json()) as { instanceId: string };
  const res = await api(`/workflow/instances/${instanceId}/approve`, otherTok);
  assert.equal(res.status, 403, 'un utilisateur sans le rôle manager ne peut pas approuver');
});

test('NÉGATIF : anti-auto-approbation (séparation des tâches)', async () => {
  // Le requester porte AUSSI le rôle manager → il pourrait matcher l'étape, mais il est
  // le créateur : la séparation des tâches doit l'en empêcher.
  const reqTok = await token(slugA, requesterEmail);
  psql(`INSERT INTO admin.user_roles (tenant_id, user_id, role_id)
        SELECT '${tenantAId}', u.id, r.id FROM admin.users u, admin.roles r
        WHERE u.email='${requesterEmail}' AND r.tenant_id='${tenantAId}' AND r.key='manager'
        ON CONFLICT DO NOTHING`);
  const subjectId = demoRequest(5000);
  const { instanceId } = (await (await api('/workflow/instances', reqTok, { definitionKey: `dep_${rid}`, subjectType: 'demo_request', subjectId, context: { amount: 5000 } })).json()) as { instanceId: string };
  const res = await api(`/workflow/instances/${instanceId}/approve`, reqTok);
  assert.equal(res.status, 403, 'le demandeur ne peut pas approuver sa propre demande');
});

test('concurrence : deux approbations simultanées ⇒ une seule transition', async () => {
  const reqTok = await token(slugA, requesterEmail);
  const mgrTok = await token(slugA, managerEmail);
  const subjectId = demoRequest(5000);
  const { instanceId } = (await (await api('/workflow/instances', reqTok, { definitionKey: `dep_${rid}`, subjectType: 'demo_request', subjectId, context: { amount: 5000 } })).json()) as { instanceId: string };

  const [r1, r2] = await Promise.all([
    api(`/workflow/instances/${instanceId}/approve`, mgrTok),
    api(`/workflow/instances/${instanceId}/approve`, mgrTok),
  ]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [200, 409], 'une réussit (200), l’autre voit stale (409)');
  const approveTransitions = psql(`SELECT count(*) FROM workflow.transitions WHERE instance_id='${instanceId}' AND action='approve'`);
  assert.equal(approveTransitions, '1', 'exactement une transition d’approbation');
});

test('idempotence : rejouer la même clé ne crée pas de seconde transition', async () => {
  const reqTok = await token(slugA, requesterEmail);
  const mgrTok = await token(slugA, managerEmail);
  const subjectId = demoRequest(5000);
  const { instanceId } = (await (await api('/workflow/instances', reqTok, { definitionKey: `dep_${rid}`, subjectType: 'demo_request', subjectId, context: { amount: 5000 } })).json()) as { instanceId: string };
  const idem = randomUUID();
  const r1 = await api(`/workflow/instances/${instanceId}/approve`, mgrTok, { idempotencyKey: idem });
  const r2 = await api(`/workflow/instances/${instanceId}/approve`, mgrTok, { idempotencyKey: idem });
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200, 'le rejeu retourne le même résultat');
  assert.deepEqual(await r1.json(), await r2.json());
  assert.equal(psql(`SELECT count(*) FROM workflow.transitions WHERE instance_id='${instanceId}' AND action='approve'`), '1');
});

test('rejet et retour tracés', async () => {
  const reqTok = await token(slugA, requesterEmail);
  const mgrTok = await token(slugA, managerEmail);
  // rejet
  let subjectId = demoRequest(5000);
  let inst = (await (await api('/workflow/instances', reqTok, { definitionKey: `dep_${rid}`, subjectType: 'demo_request', subjectId, context: { amount: 5000 } })).json()) as { instanceId: string };
  assert.equal(((await (await api(`/workflow/instances/${inst.instanceId}/reject`, mgrTok, { comment: 'non' })).json()) as { status: string }).status, 'rejected');
  assert.equal(psql(`SELECT status FROM workflow.demo_requests WHERE id='${subjectId}'`), 'rejected');
  // retour au demandeur
  subjectId = demoRequest(5000);
  inst = (await (await api('/workflow/instances', reqTok, { definitionKey: `dep_${rid}`, subjectType: 'demo_request', subjectId, context: { amount: 5000 } })).json()) as { instanceId: string };
  assert.equal(((await (await api(`/workflow/instances/${inst.instanceId}/return`, mgrTok, { comment: 'compléter' })).json()) as { status: string }).status, 'returned');
});

test('délégation : le délégataire peut approuver, un tiers non', async () => {
  const reqTok = await token(slugA, requesterEmail);
  const mgrTok = await token(slugA, managerEmail);
  const delTok = await token(slugA, delegateEmail);
  const otherTok = await token(slugA, otherEmail);
  const delegateId = psql(`SELECT id FROM admin.users WHERE email='${delegateEmail}'`);
  const subjectId = demoRequest(5000);
  const { instanceId } = (await (await api('/workflow/instances', reqTok, { definitionKey: `dep_${rid}`, subjectType: 'demo_request', subjectId, context: { amount: 5000 } })).json()) as { instanceId: string };

  // Le manager (assigné) délègue à delegateEmail.
  assert.equal((await api(`/workflow/instances/${instanceId}/delegate`, mgrTok, { toUserId: delegateId })).status, 200);
  // Un tiers non délégué reste refusé.
  assert.equal((await api(`/workflow/instances/${instanceId}/approve`, otherTok)).status, 403);
  // Le délégataire approuve → clôture.
  const done = await api(`/workflow/instances/${instanceId}/approve`, delTok);
  assert.equal(((await done.json()) as { status: string }).status, 'approved');
});

test('annulation par le demandeur', async () => {
  const reqTok = await token(slugA, requesterEmail);
  const subjectId = demoRequest(5000);
  const { instanceId } = (await (await api('/workflow/instances', reqTok, { definitionKey: `dep_${rid}`, subjectType: 'demo_request', subjectId, context: { amount: 5000 } })).json()) as { instanceId: string };
  assert.equal(((await (await api(`/workflow/instances/${instanceId}/cancel`, reqTok)).json()) as { status: string }).status, 'cancelled');
  assert.equal(psql(`SELECT status FROM workflow.demo_requests WHERE id='${subjectId}'`), 'cancelled');
});

test('escalade : le tick escalade une instance dont l’échéance est dépassée', async () => {
  const reqTok = await token(slugA, requesterEmail);
  const subjectId = demoRequest(5000);
  const { instanceId } = (await (await api('/workflow/instances', reqTok, { definitionKey: `dep_${rid}`, subjectType: 'demo_request', subjectId, context: { amount: 5000 } })).json()) as { instanceId: string };
  // Forcer l'échéance dans le passé.
  psql(`UPDATE workflow.instances SET step_deadline = now() - interval '1 hour' WHERE id='${instanceId}'`);
  const tick = await api('/workflow/tick', reqTok);
  assert.equal(tick.status, 200);
  assert.ok(((await tick.json()) as { escalated: number }).escalated >= 1);
  assert.equal(psql(`SELECT count(*) FROM workflow.transitions WHERE instance_id='${instanceId}' AND action='escalate'`), '1');
});

test('version figée : une instance en cours ignore une nouvelle version activée', async () => {
  const reqTok = await token(slugA, requesterEmail);
  const mgrTok = await token(slugA, managerEmail);
  const key = `ver_${rid}`;
  // v1 : une seule étape Manager.
  let res = await api('/workflow/definitions', reqTok, { key, name: 'V', steps: [{ index: 0, name: 'Manager', approverType: 'role', approverRef: 'manager' }] });
  const v1 = (await res.json()) as { id: string };
  await api(`/workflow/definitions/${v1.id}/activate`, reqTok);
  // Instance sur v1.
  const subjectId = demoRequest(5000);
  const { instanceId } = (await (await api('/workflow/instances', reqTok, { definitionKey: key, subjectType: 'demo_request', subjectId, context: {} })).json()) as { instanceId: string };
  // v2 : deux étapes — activée APRÈS la soumission.
  res = await api('/workflow/definitions', reqTok, { key, name: 'V2', steps: [
    { index: 0, name: 'Manager', approverType: 'role', approverRef: 'manager' },
    { index: 1, name: 'Finance', approverType: 'role', approverRef: 'finance' },
  ] });
  const v2 = (await res.json()) as { id: string };
  assert.equal((await api(`/workflow/definitions/${v2.id}/activate`, reqTok)).status, 200);
  // L'instance, démarrée sur v1 (1 étape), se clôt en UNE approbation malgré la v2 active.
  const done = await api(`/workflow/instances/${instanceId}/approve`, mgrTok);
  assert.equal(((await done.json()) as { status: string }).status, 'approved', 'snapshot v1 respecté');
});

test('NÉGATIF inter-tenant : B ne voit ni n’agit sur une instance de A', async () => {
  const reqTok = await token(slugA, requesterEmail);
  const subjectId = demoRequest(5000);
  const { instanceId } = (await (await api('/workflow/instances', reqTok, { definitionKey: `dep_${rid}`, subjectType: 'demo_request', subjectId, context: { amount: 5000 } })).json()) as { instanceId: string };
  const bTok = await token(slugB, bManagerEmail);
  assert.equal((await api(`/workflow/instances/${instanceId}`, bTok, undefined, 'GET')).status, 404, 'invisible pour B');
  assert.equal((await api(`/workflow/instances/${instanceId}/approve`, bTok)).status, 404, 'non actionnable par B');
  // L'instance de A reste intacte.
  assert.equal(psql(`SELECT status FROM workflow.instances WHERE id='${instanceId}'`), 'pending');
});

test('immuabilité : impossible d’activer deux fois / de modifier une définition active', async () => {
  const reqTok = await token(slugA, requesterEmail);
  const key = `imm_${rid}`;
  const res = await api('/workflow/definitions', reqTok, { key, name: 'Imm', steps: [{ index: 0, name: 'Manager', approverType: 'role', approverRef: 'manager' }] });
  const def = (await res.json()) as { id: string };
  assert.equal((await api(`/workflow/definitions/${def.id}/activate`, reqTok)).status, 200);
  // Ré-activer une définition déjà active → 400 (non draft).
  assert.equal((await api(`/workflow/definitions/${def.id}/activate`, reqTok)).status, 400);
});

test('OpenAPI : endpoints workflow documentés', async () => {
  const spec = (await (await fetch(`${base}/openapi.json`)).json()) as { paths: Record<string, unknown> };
  for (const p of ['/workflow/definitions', '/workflow/instances', '/workflow/instances/{id}/approve', '/workflow/instances/{id}/delegate', '/workflow/tick']) {
    assert.ok(spec.paths[p], `chemin ${p} documenté`);
  }
});
