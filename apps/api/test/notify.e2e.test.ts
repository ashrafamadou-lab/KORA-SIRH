/**
 * E2E Notification Engine (E5) — couvre les conditions de validation du sponsor :
 * périmètre self-service strict, isolation tenant, idempotence d'événement, retry à
 * backoff, dead_letter à épuisement, notifications obligatoires vs préférences,
 * variables contrôlées (inconnues/manquantes rejetées AVANT envoi), filtre anti-secrets
 * (contenu ET journaux), déclenchement par le Workflow Engine (approbateur, demandeur,
 * escalade, délégataire). Transport SIMULÉ — aucun fournisseur payant.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import type { INestApplication } from '@nestjs/common';

process.env.KORA_MFA_KEY ??=
  'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
// File testable rapidement : 2 tentatives max, backoff nul (dû immédiatement).
process.env.KORA_NOTIFY_MAX_ATTEMPTS ??= '2';
process.env.KORA_NOTIFY_BACKOFF_BASE_MS ??= '0';
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
const slugA = `ntf-a-${rid}`;
const slugB = `ntf-b-${rid}`;

const adminEmail = `adm.${rid}@demo.bj`;
const aliceEmail = `ali.${rid}@demo.bj`;
const bobEmail = `bob.${rid}@demo.bj`;
const managerEmail = `mgr.${rid}@demo.bj`;   // locale EN
const delegateEmail = `del.${rid}@demo.bj`;
const financeEmail = `fin.${rid}@demo.bj`;   // cible d'escalade
const bAdminEmail = `badm.${rid}@demo.bj`;

let app: INestApplication;
let base = '';
let tenantAId = '';
let aliceId = '';
let bobId = '';
let managerId = '';
let delegateId = '';

async function seedUser(tenantId: string, email: string, roleIds: string[]): Promise<string> {
  const h = await argon2.hash(P, { type: argon2.argon2id });
  const id = psql(`INSERT INTO admin.users (tenant_id, email, password_hash) VALUES ('${tenantId}','${email}','${h}') RETURNING id`);
  psql(`INSERT INTO admin.user_scopes (tenant_id, user_id, scope_type) VALUES ('${tenantId}','${id}','tenant')`);
  for (const r of roleIds) {
    psql(`INSERT INTO admin.user_roles (tenant_id, user_id, role_id) VALUES ('${tenantId}','${id}','${r}')`);
  }
  return id;
}

before(async () => {
  tenantAId = psql(`INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('${slugA}','NTF A',true) RETURNING id`);
  const tenantBId = psql(`INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('${slugB}','NTF B',true) RETURNING id`);

  // Rôle « ops » : notify.manage + toutes les permissions workflow (pour le pont E3→E5).
  const perms = ['notify.manage', 'workflow.manage', 'workflow.submit', 'workflow.act', 'workflow.view'];
  const roles = new Map<string, string>();
  for (const tid of [tenantAId, tenantBId]) {
    const ops = psql(`INSERT INTO admin.roles (tenant_id, key, name) VALUES ('${tid}','ops-${rid}','Ops') RETURNING id`);
    for (const p of perms) {
      psql(`INSERT INTO admin.role_permissions (tenant_id, role_id, permission_key) VALUES ('${tid}','${ops}','${p}')`);
    }
    roles.set(`ops:${tid}`, ops);
    for (const key of ['manager', 'finance']) {
      const r = psql(`INSERT INTO admin.roles (tenant_id, key, name) VALUES ('${tid}','${key}','${key}') RETURNING id`);
      roles.set(`${key}:${tid}`, r);
    }
  }
  const opsA = roles.get(`ops:${tenantAId}`)!;
  const submitOnly = psql(`INSERT INTO admin.roles (tenant_id, key, name) VALUES ('${tenantAId}','emp-${rid}','Employé') RETURNING id`);
  for (const p of ['workflow.submit', 'workflow.view', 'workflow.act']) {
    psql(`INSERT INTO admin.role_permissions (tenant_id, role_id, permission_key) VALUES ('${tenantAId}','${submitOnly}','${p}')`);
  }

  await seedUser(tenantAId, adminEmail, [opsA]);
  aliceId = await seedUser(tenantAId, aliceEmail, [submitOnly]);
  bobId = await seedUser(tenantAId, bobEmail, [submitOnly]);
  managerId = await seedUser(tenantAId, managerEmail, [submitOnly, roles.get(`manager:${tenantAId}`)!]);
  delegateId = await seedUser(tenantAId, delegateEmail, [submitOnly]);
  await seedUser(tenantAId, financeEmail, [submitOnly, roles.get(`finance:${tenantAId}`)!]);
  await seedUser(tenantBId, bAdminEmail, [roles.get(`ops:${tenantBId}`)!]);

  // Le manager lit en anglais : le rendu doit suivre SA langue.
  psql(`UPDATE admin.users SET locale='en' WHERE id='${managerId}'`);

  app = await createApp();
  await app.listen(0);
  const addr = app.getHttpServer().address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  base = `http://127.0.0.1:${port}/api/v1`;
});

after(async () => { if (app) await app.close(); });

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

const TPL = {
  key: `conges.approuve.${rid}`,
  name: 'Congés approuvés',
  subjectFr: 'Congés approuvés — {{periode}}',
  subjectEn: 'Leave approved — {{periode}}',
  bodyFr: 'Bonjour {{prenom}}, vos congés ({{periode}}) sont approuvés.',
  bodyEn: 'Hello {{prenom}}, your leave ({{periode}}) is approved.',
  variables: ['prenom', 'periode'],
  channels: ['in_app', 'email'],
  mandatory: false,
};

async function publish(tok: string, eventKey: string, payload: unknown, recipients: unknown, templateKey = TPL.key) {
  return api('/admin/notify/events', tok, { eventKey, templateKey, payload, recipients });
}
function notifIdOf(eventId: string, userId: string): string {
  return psql(`SELECT id FROM notify.notifications WHERE event_id='${eventId}' AND user_id='${userId}'`);
}
function deliveryOf(notificationId: string, channel: string): string {
  return psql(`SELECT id FROM notify.deliveries WHERE notification_id='${notificationId}' AND channel='${channel}'`);
}

let templateV2Id = '';

test('modèles : création, activation, version supersédée, contenu figé, audité', async () => {
  const adm = await token(slugA, adminEmail);
  const c1 = await api('/admin/notify/templates', adm, TPL);
  assert.equal(c1.status, 201);
  const v1 = (await c1.json()) as { id: string; version: number };
  assert.equal(v1.version, 1);
  assert.equal((await api(`/admin/notify/templates/${v1.id}/activate`, adm)).status, 200);

  // v2 de la même clé, puis activation : v1 devient superseded.
  const c2 = await api('/admin/notify/templates', adm, { ...TPL, bodyFr: TPL.bodyFr + ' Bon repos.' });
  const v2 = (await c2.json()) as { id: string; version: number };
  assert.equal(v2.version, 2);
  assert.equal((await api(`/admin/notify/templates/${v2.id}/activate`, adm)).status, 200);
  templateV2Id = v2.id;
  assert.equal(psql(`SELECT status FROM notify.templates WHERE id='${v1.id}'`), 'superseded');
  assert.equal(psql(`SELECT status FROM notify.templates WHERE id='${v2.id}'`), 'active');

  // Un modèle actif est FIGÉ : la modification passe par une nouvelle version.
  assert.equal((await api(`/admin/notify/templates/${v2.id}`, adm, TPL, 'PATCH')).status, 400);

  // Opérations d'administration auditées.
  const audits = psql(`SELECT count(*) FROM audit.audit_log WHERE tenant_id='${tenantAId}' AND module='notify' AND action IN ('notify_template_created','notify_template_activated')`);
  assert.ok(Number(audits) >= 4, `audit des modèles (${audits})`);
});

test('NÉGATIF modèles : variable interdite, placeholder hors liste, secret embarqué', async () => {
  const adm = await token(slugA, adminEmail);
  // Nom de variable interdit (secret / médical).
  for (const v of ['password', 'jeton_reset', 'code_mfa', 'diagnostic_medical']) {
    const r = await api('/admin/notify/templates', adm, { ...TPL, key: `bad.${rid}`, variables: [...TPL.variables, v] });
    assert.equal(r.status, 400, `variable « ${v} » refusée`);
  }
  // Placeholder non déclaré.
  const r2 = await api('/admin/notify/templates', adm, { ...TPL, key: `bad.${rid}`, bodyFr: 'Bonjour {{inconnu}}' });
  assert.equal(r2.status, 400);
  // Secret embarqué dans le corps du modèle.
  const r3 = await api('/admin/notify/templates', adm, { ...TPL, key: `bad.${rid}`, bodyFr: 'code: a1b2c3d4e5f60718293a4b5c6d7e8f90' });
  assert.equal(r3.status, 400);
});

test('RBAC : l’administration des notifications exige notify.manage', async () => {
  const ali = await token(slugA, aliceEmail);
  assert.equal((await api('/admin/notify/templates', ali, TPL)).status, 403);
  assert.equal((await api('/admin/notify/queue', ali, undefined, 'GET')).status, 403);
  assert.equal((await api('/admin/notify/queue/process', ali, {})).status, 403);
});

let event1Id = '';
let aliceNotif1 = '';

test('publication : notification logique par destinataire, rendue dans SA langue, in_app immédiat + email en file', async () => {
  const adm = await token(slugA, adminEmail);
  const res = await publish(adm, `evt1.${rid}`, { prenom: 'Awa', periode: '12-26/08' },
    [{ userId: aliceId }, { userId: managerId }]);
  assert.equal(res.status, 201);
  const body = (await res.json()) as { eventId: string; duplicate: boolean; recipients: number; inApp: number; queued: number };
  assert.equal(body.duplicate, false);
  assert.equal(body.recipients, 2);
  assert.equal(body.inApp, 2, 'in_app livré immédiatement');
  assert.equal(body.queued, 2, 'email en file pour chacun');
  event1Id = body.eventId;

  const ali = await token(slugA, aliceEmail);
  const list = (await (await api('/notifications', ali, undefined, 'GET')).json()) as { items: Array<{ id: string; subject: string; locale: string }>; unreadCount: number };
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0]!.subject, 'Congés approuvés — 12-26/08', 'rendu FR');
  assert.equal(list.unreadCount, 1);
  aliceNotif1 = list.items[0]!.id;

  const mgr = await token(slugA, managerEmail);
  const mlist = (await (await api('/notifications', mgr, undefined, 'GET')).json()) as { items: Array<{ subject: string; locale: string }> };
  assert.equal(mlist.items[0]!.subject, 'Leave approved — 12-26/08', 'rendu EN (langue du destinataire)');
});

test('idempotence : livrer deux fois le même événement ⇒ UNE notification logique', async () => {
  const adm = await token(slugA, adminEmail);
  const res = await publish(adm, `evt1.${rid}`, { prenom: 'Awa', periode: '12-26/08' }, [{ userId: aliceId }]);
  assert.equal(res.status, 201);
  assert.equal(((await res.json()) as { duplicate: boolean }).duplicate, true, 'rejeu = duplicate');
  assert.equal(psql(`SELECT count(*) FROM notify.notifications WHERE event_id='${event1Id}' AND user_id='${aliceId}'`), '1');
  assert.equal(psql(`SELECT count(*) FROM notify.events WHERE tenant_id='${tenantAId}' AND event_key='evt1.${rid}'`), '1');
});

test('variables : inconnues ou manquantes rejetées AVANT tout envoi', async () => {
  const adm = await token(slugA, adminEmail);
  const missing = await publish(adm, `evt-miss.${rid}`, { prenom: 'Awa' }, [{ userId: aliceId }]);
  assert.equal(missing.status, 400, 'variable manquante refusée');
  const unknown = await publish(adm, `evt-unk.${rid}`, { prenom: 'Awa', periode: 'x', extra: 'y' }, [{ userId: aliceId }]);
  assert.equal(unknown.status, 400, 'variable inconnue refusée');
  // Rien n'a été consommé ni écrit : les clés restent publiables après correction.
  assert.equal(psql(`SELECT count(*) FROM notify.events WHERE tenant_id='${tenantAId}' AND event_key IN ('evt-miss.${rid}','evt-unk.${rid}')`), '0');
});

test('sécurité : aucun mot de passe, jeton ou secret MFA ne passe (contenu refusé, rien d’écrit)', async () => {
  const adm = await token(slugA, adminEmail);
  // Valeur à forme de secret (JWT).
  const jwt = await publish(adm, `evt-jwt.${rid}`,
    { prenom: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVPmB92K27uhb', periode: 'x' }, [{ userId: aliceId }]);
  assert.equal(jwt.status, 400);
  // Nom de variable interdit dans le payload.
  const named = await publish(adm, `evt-pwd.${rid}`, { prenom: 'Awa', periode: 'x', mot_de_passe: 'abc' }, [{ userId: aliceId }]);
  assert.equal(named.status, 400);
  assert.equal(psql(`SELECT count(*) FROM notify.events WHERE tenant_id='${tenantAId}' AND event_key IN ('evt-jwt.${rid}','evt-pwd.${rid}')`), '0', 'aucune écriture');
});

test('périmètre : un utilisateur ne voit et ne modifie QUE ses notifications (404, jamais 403)', async () => {
  const bob = await token(slugA, bobEmail);
  const list = (await (await api('/notifications', bob, undefined, 'GET')).json()) as { items: Array<{ id: string }> };
  assert.ok(!list.items.some((i) => i.id === aliceNotif1), 'la notification d’Alice n’apparaît pas chez Bob');
  assert.equal((await api(`/notifications/${aliceNotif1}`, bob, undefined, 'GET')).status, 404);
  assert.equal((await api(`/notifications/${aliceNotif1}/read`, bob)).status, 404);
  assert.equal((await api(`/notifications/${aliceNotif1}/archive`, bob)).status, 404);

  // Alice, elle, gère les siennes : lu → filtre non-lues ; archivé → hors liste par défaut.
  const ali = await token(slugA, aliceEmail);
  assert.equal((await api(`/notifications/${aliceNotif1}/read`, ali)).status, 200);
  const unread = (await (await api('/notifications?unread=1', ali, undefined, 'GET')).json()) as { items: unknown[] };
  assert.ok(!(unread.items as Array<{ id: string }>).some((i) => i.id === aliceNotif1));
  assert.equal((await api(`/notifications/${aliceNotif1}/archive`, ali)).status, 200);
  const def = (await (await api('/notifications', ali, undefined, 'GET')).json()) as { items: Array<{ id: string }> };
  assert.ok(!def.items.some((i) => i.id === aliceNotif1), 'archivée = hors liste par défaut');
});

test('préférences : désactiver email supprime la livraison email (notification ordinaire)', async () => {
  const bob = await token(slugA, bobEmail);
  const put = await api('/notifications/preferences', bob, { channels: { email: false } }, 'PUT');
  assert.equal(put.status, 200);
  assert.equal(((await put.json()) as { channels: { email: boolean } }).channels.email, false);
  // in_app n'est PAS désactivable (socle).
  assert.equal((await api('/notifications/preferences', bob, { channels: { in_app: false } }, 'PUT')).status, 400);

  const adm = await token(slugA, adminEmail);
  const res = await publish(adm, `evt-pref.${rid}`, { prenom: 'Bob', periode: '01-05/09' }, [{ userId: bobId }]);
  const { eventId } = (await res.json()) as { eventId: string };
  const nid = notifIdOf(eventId, bobId);
  assert.notEqual(nid, '', 'la notification logique existe (in_app)');
  assert.equal(psql(`SELECT count(*) FROM notify.deliveries WHERE notification_id='${nid}' AND channel='email'`), '0', 'pas de livraison email');
  assert.equal(psql(`SELECT status FROM notify.deliveries WHERE notification_id='${nid}' AND channel='in_app'`), 'sent');
});

test('obligatoire : une notification OBLIGATOIRE ignore la préférence utilisateur', async () => {
  const adm = await token(slugA, adminEmail);
  const c = await api('/admin/notify/templates', adm, {
    ...TPL, key: `paie.bulletin.${rid}`, name: 'Bulletin de paie', mandatory: true,
    subjectFr: 'Bulletin disponible — {{periode}}', subjectEn: 'Payslip ready — {{periode}}',
    bodyFr: 'Bonjour {{prenom}}, votre bulletin ({{periode}}) est disponible.',
    bodyEn: 'Hello {{prenom}}, your payslip ({{periode}}) is ready.',
  });
  const { id } = (await c.json()) as { id: string };
  assert.equal((await api(`/admin/notify/templates/${id}/activate`, adm)).status, 200);

  // Bob a désactivé email — la notification obligatoire passe quand même.
  const res = await publish(adm, `evt-mand.${rid}`, { prenom: 'Bob', periode: '2026-08' }, [{ userId: bobId }], `paie.bulletin.${rid}`);
  const { eventId } = (await res.json()) as { eventId: string };
  const nid = notifIdOf(eventId, bobId);
  assert.equal(psql(`SELECT count(*) FROM notify.deliveries WHERE notification_id='${nid}' AND channel='email'`), '1',
    'livraison email créée malgré la préférence');
});

test('destinataires : rôle, portée et dédoublonnage (jamais deux notifications pour le même événement)', async () => {
  const adm = await token(slugA, adminEmail);
  const res = await publish(adm, `evt-dedup.${rid}`, { prenom: 'Équipe', periode: 'S35' },
    [{ userId: aliceId }, { roleKey: 'manager' }, { scopeType: 'tenant' }]);
  assert.equal(res.status, 201);
  const body = (await res.json()) as { eventId: string; recipients: number };
  // 6 utilisateurs actifs chez A, tous à portée tenant → union {alice} ∪ rôle ∪ portée = 6.
  assert.equal(body.recipients, 6, `dédoublonnage (${body.recipients})`);
  assert.equal(psql(`SELECT count(*) FROM notify.notifications WHERE event_id='${body.eventId}' AND user_id='${aliceId}'`), '1');
});

test('file : une panne transitoire déclenche un retry, puis la livraison part', async () => {
  const adm = await token(slugA, adminEmail);
  const res = await publish(adm, `evt-retry.${rid}`, { prenom: 'Awa', periode: '[ECHEC-SIMULE-1]' }, [{ userId: aliceId }]);
  const { eventId } = (await res.json()) as { eventId: string };
  const nid = notifIdOf(eventId, aliceId);
  const did = deliveryOf(nid, 'email');

  assert.equal((await api('/admin/notify/queue/process', adm, {})).status, 200);
  assert.equal(psql(`SELECT status FROM notify.deliveries WHERE id='${did}'`), 'failed', '1re tentative échouée → failed (réessai planifié)');
  assert.equal(psql(`SELECT attempt_count FROM notify.deliveries WHERE id='${did}'`), '1');

  assert.equal((await api('/admin/notify/queue/process', adm, {})).status, 200);
  assert.equal(psql(`SELECT status FROM notify.deliveries WHERE id='${did}'`), 'sent', '2e tentative réussie');
  assert.equal(psql(`SELECT string_agg(outcome, ',' ORDER BY attempt_no) FROM notify.delivery_attempts WHERE delivery_id='${did}'`), 'failed,sent');
});

test('file : à épuisement des tentatives, la livraison passe en dead_letter — journal SANS contenu', async () => {
  const adm = await token(slugA, adminEmail);
  const res = await publish(adm, `evt-dead.${rid}`, { prenom: 'Awa', periode: '[ECHEC-SIMULE-TOUJOURS] projet Alpha' }, [{ userId: aliceId }]);
  const { eventId } = (await res.json()) as { eventId: string };
  const nid = notifIdOf(eventId, aliceId);
  const did = deliveryOf(nid, 'email');

  await api('/admin/notify/queue/process', adm, {});
  await api('/admin/notify/queue/process', adm, {});
  assert.equal(psql(`SELECT status FROM notify.deliveries WHERE id='${did}'`), 'dead_letter', 'max 2 tentatives → dead_letter');
  assert.equal(psql(`SELECT count(*) FROM notify.delivery_attempts WHERE delivery_id='${did}'`), '2');

  // CONTRAINTE E5 : le journal ne contient NI le contenu du message NI de secret.
  const logged = psql(`SELECT COALESCE(string_agg(COALESCE(error_message,'') || COALESCE(error_code,''), '|'), '') FROM notify.delivery_attempts WHERE delivery_id='${did}'`);
  assert.ok(!logged.includes('Alpha'), 'le contenu rendu n’apparaît pas dans les journaux');
  assert.ok(!logged.includes('ECHEC-SIMULE'), 'le corps du message n’est pas recopié');

  // L'admin consulte les tentatives, puis requeue : compteur remis à zéro.
  const attempts = (await (await api(`/admin/notify/deliveries/${did}/attempts`, adm, undefined, 'GET')).json()) as Array<{ outcome: string }>;
  assert.equal(attempts.length, 2);
  const rq = await api(`/admin/notify/deliveries/${did}/requeue`, adm);
  assert.equal(rq.status, 200);
  assert.equal(psql(`SELECT status || '/' || attempt_count FROM notify.deliveries WHERE id='${did}'`), 'pending/0');
  // Annulation possible d'une livraison en attente.
  assert.equal((await api(`/admin/notify/deliveries/${did}/cancel`, adm)).status, 200);
  assert.equal(psql(`SELECT status FROM notify.deliveries WHERE id='${did}'`), 'cancelled');
});

test('NÉGATIF inter-tenant : B ne voit ni modèles, ni file, ni notifications de A', async () => {
  const badm = await token(slugB, bAdminEmail);
  const tpls = (await (await api('/admin/notify/templates', badm, undefined, 'GET')).json()) as unknown[];
  assert.equal(tpls.length, 0, 'aucun modèle de A visible chez B');
  const queue = (await (await api('/admin/notify/queue', badm, undefined, 'GET')).json()) as unknown[];
  assert.equal(queue.length, 0, 'aucune livraison de A visible chez B');
  assert.equal((await api(`/admin/notify/templates/${templateV2Id}`, badm, undefined, 'GET')).status, 404);
  assert.equal((await api(`/notifications/${aliceNotif1}`, badm, undefined, 'GET')).status, 404);
  // Publier chez B avec la clé de modèle de A : le modèle n'existe pas chez B.
  assert.equal((await publish(badm, `evt-b.${rid}`, { prenom: 'X', periode: 'Y' }, [{ roleKey: 'manager' }])).status, 404);
  // Le tick de B ne traite RIEN de la file de A.
  const proc = (await (await api('/admin/notify/queue/process', badm, {})).json()) as { processed: number };
  assert.equal(proc.processed, 0);
});

test('workflow : approbateur, demandeur, escalade et délégataire notifiés via le moteur E3', async () => {
  const adm = await token(slugA, adminEmail);
  // Modèles workflow.* (variables = sous-ensemble du catalogue {workflow, etape, action, reference}).
  for (const [kind, fr, en] of [
    ['step_pending', 'Étape à approuver — {{workflow}}', 'Step to approve — {{workflow}}'],
    ['approved', 'Demande approuvée — {{workflow}}', 'Request approved — {{workflow}}'],
    ['escalated', 'Échéance dépassée — {{workflow}}', 'Deadline breached — {{workflow}}'],
    ['delegated', 'Étape déléguée — {{workflow}}', 'Step delegated — {{workflow}}'],
  ] as const) {
    const c = await api('/admin/notify/templates', adm, {
      key: `workflow.${kind}`, name: `Workflow ${kind}`,
      subjectFr: fr, subjectEn: en, bodyFr: fr, bodyEn: en,
      variables: ['workflow'], channels: ['in_app'], mandatory: false,
    });
    assert.equal(c.status, 201, `modèle workflow.${kind}`);
    const { id } = (await c.json()) as { id: string };
    assert.equal((await api(`/admin/notify/templates/${id}/activate`, adm)).status, 200);
  }

  // Définition : 1 étape Manager (SLA 1 h, escalade vers le rôle finance).
  const key = `dep_${rid}`;
  const cd = await api('/workflow/definitions', adm, {
    key, name: 'Dépense',
    steps: [{ index: 0, name: 'Manager', approverType: 'role', approverRef: 'manager', slaHours: 1,
              escalation: { afterHours: 1, toType: 'role', toRef: 'finance' } }],
  });
  assert.equal(cd.status, 201);
  const { id: defId } = (await cd.json()) as { id: string };
  assert.equal((await api(`/workflow/definitions/${defId}/activate`, adm)).status, 200);

  const ali = await token(slugA, aliceEmail);
  const mgr = await token(slugA, managerEmail);

  // 1) Soumission → l'APPROBATEUR (rôle manager) est notifié, dans SA langue (EN).
  const subj1 = psql(`INSERT INTO workflow.demo_requests (tenant_id, title, amount) VALUES ('${tenantAId}','NTF ${rid}',1000) RETURNING id`);
  const s1 = await api('/workflow/instances', ali, { definitionKey: key, subjectType: 'demo_request', subjectId: subj1, context: {} });
  assert.equal(s1.status, 201);
  const { instanceId: inst1 } = (await s1.json()) as { instanceId: string };
  const mgrPending = psql(`SELECT count(*) FROM notify.notifications n JOIN notify.events e ON e.id=n.event_id
    WHERE n.user_id='${managerId}' AND n.template_key='workflow.step_pending' AND e.event_key LIKE 'wf.${inst1}.%'`);
  assert.equal(mgrPending, '1', 'approbateur notifié à la soumission');
  assert.equal(psql(`SELECT subject FROM notify.notifications n JOIN notify.events e ON e.id=n.event_id
    WHERE n.user_id='${managerId}' AND e.event_key LIKE 'wf.${inst1}.%'`), `Step to approve — ${key}`, 'rendu EN pour le manager');

  // 2) Délégation → le DÉLÉGATAIRE est notifié.
  assert.equal((await api(`/workflow/instances/${inst1}/delegate`, mgr, { toUserId: delegateId })).status, 200);
  assert.equal(psql(`SELECT count(*) FROM notify.notifications n JOIN notify.events e ON e.id=n.event_id
    WHERE n.user_id='${delegateId}' AND n.template_key='workflow.delegated' AND e.event_key LIKE 'wf.${inst1}.%'`), '1');

  // 3) Approbation finale (par le délégataire) → le DEMANDEUR est notifié.
  const del = await token(slugA, delegateEmail);
  const ap = await api(`/workflow/instances/${inst1}/approve`, del);
  assert.equal(ap.status, 200);
  assert.equal(psql(`SELECT count(*) FROM notify.notifications n JOIN notify.events e ON e.id=n.event_id
    WHERE n.user_id='${aliceId}' AND n.template_key='workflow.approved' AND e.event_key LIKE 'wf.${inst1}.%'`), '1', 'demandeur notifié');

  // 4) Escalade (tick) → acteurs d'escalade (rôle finance) ET demandeur notifiés.
  const subj2 = psql(`INSERT INTO workflow.demo_requests (tenant_id, title, amount) VALUES ('${tenantAId}','NTF2 ${rid}',1000) RETURNING id`);
  const s2 = await api('/workflow/instances', ali, { definitionKey: key, subjectType: 'demo_request', subjectId: subj2, context: {} });
  const { instanceId: inst2 } = (await s2.json()) as { instanceId: string };
  psql(`UPDATE workflow.instances SET step_deadline = now() - interval '1 hour' WHERE id='${inst2}'`);
  assert.equal((await api('/workflow/tick', adm)).status, 200);
  const financeId = psql(`SELECT id FROM admin.users WHERE email='${financeEmail}'`);
  assert.equal(psql(`SELECT count(*) FROM notify.notifications n JOIN notify.events e ON e.id=n.event_id
    WHERE n.user_id='${financeId}' AND n.template_key='workflow.escalated' AND e.event_key LIKE 'wf.${inst2}.%'`), '1', 'acteur d’escalade notifié');
  assert.equal(psql(`SELECT count(*) FROM notify.notifications n JOIN notify.events e ON e.id=n.event_id
    WHERE n.user_id='${aliceId}' AND n.template_key='workflow.escalated' AND e.event_key LIKE 'wf.${inst2}.%'`), '1', 'demandeur notifié de l’escalade');

  // Les événements de workflow sont marqués source='workflow'.
  assert.equal(psql(`SELECT DISTINCT source FROM notify.events WHERE tenant_id='${tenantAId}' AND event_key LIKE 'wf.${inst1}.%'`), 'workflow');
});

test('OpenAPI : endpoints notifications documentés', async () => {
  const spec = (await (await fetch(`${base}/openapi.json`)).json()) as { paths: Record<string, unknown> };
  for (const p of [
    '/notifications', '/notifications/{id}', '/notifications/{id}/read', '/notifications/{id}/archive',
    '/notifications/preferences', '/admin/notify/templates', '/admin/notify/templates/{id}/activate',
    '/admin/notify/events', '/admin/notify/queue', '/admin/notify/queue/process',
    '/admin/notify/deliveries/{id}/requeue',
  ]) {
    assert.ok(spec.paths[p], `chemin ${p} documenté`);
  }
});
