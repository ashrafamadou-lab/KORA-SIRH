/**
 * E2E Consultation d'audit (E6) — conditions de validation du sponsor :
 * surface 100 % lecture, vues différenciées par permission (globale / module / soi),
 * filtres qui n'élargissent jamais, curseur stable sous insertions concurrentes,
 * masquage systématique (API + exports), intégrité valid/broken/unverified avec reprise
 * cryptographique et falsification DÉTECTÉE, exports bornés à la visibilité et audités,
 * isolation tenant, sanité de performance sur volume significatif (3000+ lignes).
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
const slugA = `aud-a-${rid}`;
const slugB = `aud-b-${rid}`;

const auditorEmail = `audit.${rid}@demo.bj`;      // audit.view + audit.export
const modAuditorEmail = `mod.${rid}@demo.bj`;      // audit.view_notify seulement
const modExporterEmail = `modx.${rid}@demo.bj`;    // audit.view_notify + audit.export
const ownEmail = `own.${rid}@demo.bj`;             // audit.view_own
const plainEmail = `plain.${rid}@demo.bj`;         // aucune permission d'audit
const bAuditorEmail = `baud.${rid}@demo.bj`;       // tenant B : audit.view + audit.export

let app: INestApplication;
let base = '';
let tenantAId = '';
let ownId = '';
let auditorId = '';
const CORR = randomUUID();

async function seedUser(tenantId: string, email: string, perms: string[]): Promise<string> {
  const h = await argon2.hash(P, { type: argon2.argon2id });
  const id = psql(`INSERT INTO admin.users (tenant_id, email, password_hash) VALUES ('${tenantId}','${email}','${h}') RETURNING id`);
  psql(`INSERT INTO admin.user_scopes (tenant_id, user_id, scope_type) VALUES ('${tenantId}','${id}','tenant')`);
  if (perms.length > 0) {
    const role = psql(`INSERT INTO admin.roles (tenant_id, key, name) VALUES ('${tenantId}','r-${email.split('@')[0]}','R') RETURNING id`);
    for (const p of perms) {
      psql(`INSERT INTO admin.role_permissions (tenant_id, role_id, permission_key) VALUES ('${tenantId}','${role}','${p}')`);
    }
    psql(`INSERT INTO admin.user_roles (tenant_id, user_id, role_id) VALUES ('${tenantId}','${id}','${role}')`);
  }
  return id;
}

function auditRow(tenantId: string, opts: {
  action: string; module: string; actor?: string | null; reason?: string;
  result?: string; corr?: string; newValue?: string;
}): string {
  const reason = opts.reason ? `'${opts.reason.replace(/'/g, "''")}'` : 'NULL';
  const nv = opts.newValue ? `'${opts.newValue.replace(/'/g, "''")}'::jsonb` : 'NULL';
  return psql(`INSERT INTO audit.audit_log (tenant_id, actor_user_id, action, module, record_type, reason, result, correlation_id, new_value)
    VALUES ('${tenantId}', ${opts.actor ? `'${opts.actor}'` : 'NULL'}, '${opts.action}', '${opts.module}', 'user',
            ${reason}, ${opts.result ? `'${opts.result}'` : 'NULL'}, ${opts.corr ? `'${opts.corr}'` : 'NULL'}, ${nv})
    RETURNING id`);
}

let secretRowId = '';
let authRowId = '';
let tamperTargetId = '';

before(async () => {
  tenantAId = psql(`INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('${slugA}','AUD A',true) RETURNING id`);
  const tenantBId = psql(`INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('${slugB}','AUD B',true) RETURNING id`);

  auditorId = await seedUser(tenantAId, auditorEmail, ['audit.view', 'audit.export']);
  await seedUser(tenantAId, modAuditorEmail, ['audit.view_notify']);
  await seedUser(tenantAId, modExporterEmail, ['audit.view_notify', 'audit.export']);
  ownId = await seedUser(tenantAId, ownEmail, ['audit.view_own']);
  // Permission NON-audit portée par MIGRATION (0010) — le job CI api migre sans seeder :
  // une clé issue du seed (ex. employees.view) violerait la FK du catalogue.
  await seedUser(tenantAId, plainEmail, ['workflow.view']);
  await seedUser(tenantBId, bAuditorEmail, ['audit.view', 'audit.export']);

  // Événements de référence (le trigger de chaînage s'applique à CHAQUE insertion).
  authRowId = auditRow(tenantAId, { action: 'login_ok', module: 'auth', actor: ownId, reason: 'ras' });
  auditRow(tenantAId, { action: 'login_fail', module: 'auth', actor: ownId, result: 'denied', corr: CORR });
  secretRowId = auditRow(tenantAId, {
    action: 'template_updated', module: 'notify', actor: auditorId,
    reason: 'rotation Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVPmB92K27uhb effectuée',
    newValue: '{"password_hash":"$argon2id$v=19$m=65536","token":"abc123","note":"clé a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90","montant":125000}',
  });
  auditRow(tenantAId, { action: 'template_created', module: 'notify', actor: auditorId, result: 'success' });
  auditRow(tenantAId, { action: 'workflow_approve', module: 'workflow', actor: auditorId });

  // Volume significatif : 3000 lignes chaînées (module 'bulk').
  psql(`INSERT INTO audit.audit_log (tenant_id, action, module, record_type, reason)
        SELECT '${tenantAId}', 'bulk_' || g, 'bulk', 'user', 'volume'
          FROM generate_series(1, 3000) g`);
  tamperTargetId = psql(`SELECT id FROM audit.audit_log WHERE tenant_id='${tenantAId}' AND action='bulk_1500'`);

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
function get(path: string, tok: string): Promise<Response> {
  return fetch(`${base}${path}`, { headers: { authorization: `Bearer ${tok}` } });
}
type Item = { id: string; module: string; action: string; actorUserId: string | null; reason: string | null; result: string | null };
async function items(path: string, tok: string): Promise<Item[]> {
  const res = await get(path, tok);
  assert.equal(res.status, 200, `GET ${path}`);
  return ((await res.json()) as { items: Item[] }).items;
}

test('surface : aucune méthode d’écriture n’existe sur /audit', async () => {
  const tok = await token(slugA, auditorEmail);
  for (const [method, path] of [
    ['POST', '/audit/events'], ['PUT', '/audit/events/1'], ['PATCH', '/audit/events/1'],
    ['DELETE', '/audit/events/1'], ['POST', '/audit/integrity'], ['DELETE', '/audit/export/csv'],
  ] as const) {
    const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${tok}` } });
    assert.ok([404, 405].includes(res.status), `${method} ${path} → ${res.status} (aucune écriture possible)`);
  }
});

test('NÉGATIF : sans permission d’audit, tout est refusé (403)', async () => {
  const tok = await token(slugA, plainEmail);
  assert.equal((await get('/audit/events', tok)).status, 403);
  assert.equal((await get(`/audit/events/${authRowId}`, tok)).status, 403);
  assert.equal((await get('/audit/integrity', tok)).status, 403);
  assert.equal((await get('/audit/export/csv', tok)).status, 403);
  assert.equal((await get('/audit/export/json', tok)).status, 403);
});

test('vue globale : filtres période / acteur / action / module / résultat / corrélation', async () => {
  const tok = await token(slugA, auditorEmail);
  const auth = await items('/audit/events?module=auth', tok);
  assert.ok(auth.length >= 2 && auth.every((i) => i.module === 'auth'));
  const byAction = await items('/audit/events?action=login_fail', tok);
  assert.ok(byAction.length >= 1 && byAction.every((i) => i.action === 'login_fail'));
  const byActor = await items(`/audit/events?actorUserId=${ownId}`, tok);
  assert.ok(byActor.length >= 2 && byActor.every((i) => i.actorUserId === ownId));
  const byResult = await items('/audit/events?result=denied', tok);
  assert.ok(byResult.some((i) => i.action === 'login_fail'));
  const byCorr = await items(`/audit/events?correlationId=${CORR}`, tok);
  assert.equal(byCorr.length, 1, 'corrélation exacte');
  const windowed = await items(`/audit/events?from=2000-01-01T00:00:00Z&to=2000-01-02T00:00:00Z`, tok);
  assert.equal(windowed.length, 0, 'fenêtre passée vide');
  const badCursor = await get('/audit/events?cursor=abc', tok);
  assert.equal(badCursor.status, 400);
});

test('vue module : les filtres n’élargissent JAMAIS le périmètre', async () => {
  const tok = await token(slugA, modAuditorEmail);
  const all = await items('/audit/events?limit=200', tok);
  assert.ok(all.length >= 2 && all.every((i) => i.module === 'notify'), 'uniquement le module notify');
  const tryAuth = await items('/audit/events?module=auth', tok);
  assert.equal(tryAuth.length, 0, 'filtrer module=auth ne révèle rien hors périmètre');
  const tryBulk = await items('/audit/events?module=bulk&limit=200', tok);
  assert.equal(tryBulk.length, 0);
  assert.equal((await get(`/audit/events/${authRowId}`, tok)).status, 404, 'détail hors module : introuvable, pas interdit');
});

test('vue own : uniquement ses propres événements, même en filtrant autrui', async () => {
  const tok = await token(slugA, ownEmail);
  const mine = await items('/audit/events?limit=200', tok);
  assert.ok(mine.length >= 2 && mine.every((i) => i.actorUserId === ownId), 'seulement ses événements');
  const others = await items(`/audit/events?actorUserId=${auditorId}`, tok);
  assert.equal(others.length, 0, 'cibler un autre acteur ne donne rien');
  assert.equal((await get(`/audit/events/${secretRowId}`, tok)).status, 404);
});

test('pagination : curseur STABLE par id — insensible aux insertions concurrentes', async () => {
  const tok = await token(slugA, auditorEmail);
  const p1 = (await (await get('/audit/events?module=bulk&limit=100', tok)).json()) as { items: Item[]; nextCursor: string };
  assert.equal(p1.items.length, 100);
  assert.ok(p1.nextCursor);
  // Insertions concurrentes PENDANT la pagination : elles ne décalent pas les pages suivantes.
  psql(`INSERT INTO audit.audit_log (tenant_id, action, module, record_type)
        SELECT '${tenantAId}', 'bulk_new_' || g, 'bulk', 'user' FROM generate_series(1, 50) g`);
  const p2 = (await (await get(`/audit/events?module=bulk&limit=100&cursor=${p1.nextCursor}`, tok)).json()) as { items: Item[]; nextCursor: string };
  assert.equal(p2.items.length, 100);
  const ids1 = new Set(p1.items.map((i) => i.id));
  assert.ok(p2.items.every((i) => !ids1.has(i.id)), 'aucun doublon entre pages');
  assert.ok(p2.items.every((i) => BigInt(i.id) < BigInt(p1.nextCursor)), 'strictement avant le curseur');
  assert.ok(p2.items.every((i) => !i.action.startsWith('bulk_new_')), 'les nouvelles lignes n’altèrent pas la page suivante');
  // Ordre strictement décroissant à l'intérieur d'une page.
  for (let i = 1; i < p2.items.length; i++) {
    assert.ok(BigInt(p2.items[i]!.id) < BigInt(p2.items[i - 1]!.id));
  }
});

test('masquage : secrets invisibles dans le détail (old/new, raison) — structure préservée', async () => {
  const tok = await token(slugA, auditorEmail);
  const res = await get(`/audit/events/${secretRowId}`, tok);
  assert.equal(res.status, 200);
  const ev = (await res.json()) as { reason: string; newValue: Record<string, unknown> };
  assert.ok(!ev.reason.includes('eyJ'), 'le JWT de la raison est masqué');
  assert.ok(ev.reason.includes('rotation'), 'le contexte de la raison survit');
  assert.equal(ev.newValue['password_hash'], '‹masqué›');
  assert.equal(ev.newValue['token'], '‹masqué›');
  assert.ok(!(String(ev.newValue['note'])).includes('a1b2c3d4e5f607'), 'le blob hex de la note est masqué');
  assert.equal(ev.newValue['montant'], 125000, 'les valeurs métier restent lisibles');
  // Le brut en base contient bien le secret : le masquage est fait par l'API, pas par la fixture.
  const raw = psql(`SELECT new_value->>'token' FROM audit.audit_log WHERE id='${secretRowId}'`);
  assert.equal(raw, 'abc123');
});

test('intégrité : valid en une passe, unverified + reprise cryptographique en passes bornées', async () => {
  const tok = await token(slugA, auditorEmail);
  const full = (await (await get('/audit/integrity?maxRows=50000', tok)).json()) as { status: string; checked: number };
  assert.equal(full.status, 'valid', 'chaîne intacte');
  assert.ok(full.checked >= 3000, `volume vérifié (${full.checked})`);

  const part = (await (await get('/audit/integrity?maxRows=200', tok)).json()) as {
    status: string; checked: number; nextAfterId?: string; nextSeed?: string;
  };
  assert.equal(part.status, 'unverified', 'plafond atteint avant la fin');
  assert.equal(part.checked, 200);
  assert.ok(part.nextAfterId && part.nextSeed, 'reprise fournie');
  const resume = (await (await get(`/audit/integrity?maxRows=50000&afterId=${part.nextAfterId}&seed=${part.nextSeed}`, tok)).json()) as { status: string };
  assert.equal(resume.status, 'valid', 'la reprise aboutit');
  // Une reprise avec un seed falsifié est détectée, pas acceptée.
  const forged = (await (await get(`/audit/integrity?maxRows=1000&afterId=${part.nextAfterId}&seed=${'ab'.repeat(32)}`, tok)).json()) as { status: string };
  assert.equal(forged.status, 'broken', 'seed falsifié ⇒ rupture signalée');
});

test('exports : bornés à la visibilité, masqués, plafonnés — et audités', async () => {
  const audTok = await token(slugA, auditorEmail);
  // CSV global : BOM + en-tête + N lignes.
  const csvRes = await get('/audit/export/csv?module=bulk&limit=10', audTok);
  assert.equal(csvRes.status, 200);
  assert.ok((csvRes.headers.get('content-type') ?? '').includes('text/csv'));
  // BOM vérifié sur les OCTETS BRUTS : fetch().text() supprime un BOM UTF-8 de tête
  // par spécification WHATWG — le fil, lui, doit le porter (Excel).
  const raw = Buffer.from(await csvRes.arrayBuffer());
  assert.deepEqual([raw[0], raw[1], raw[2]], [0xef, 0xbb, 0xbf], 'BOM UTF-8 sur le fil');
  const csv = raw.subarray(3).toString('utf8');
  const lines = csv.split('\r\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 11, 'en-tête + 10 lignes');
  assert.ok(lines[0]!.startsWith('id;occurredAt;'));
  // JSON : le secret est masqué dans l'export aussi.
  const js = (await (await get('/audit/export/json?module=notify', audTok)).json()) as { count: number; items: Array<{ newValue: Record<string, unknown> | null }> };
  const withValue = js.items.find((i) => i.newValue && 'password_hash' in i.newValue);
  assert.ok(withValue, 'la ligne à secret est exportée');
  assert.equal(withValue!.newValue!['password_hash'], '‹masqué›');
  // Sans audit.export : 403 même avec un droit de vue.
  const modTok = await token(slugA, modAuditorEmail);
  assert.equal((await get('/audit/export/csv', modTok)).status, 403);
  // Avec export mais vue module : l'export ne contient QUE le module visible.
  const modxTok = await token(slugA, modExporterEmail);
  const modx = (await (await get('/audit/export/json?limit=10000', modxTok)).json()) as { items: Array<{ module: string }> };
  assert.ok(modx.items.length >= 2 && modx.items.every((i) => i.module === 'notify'), 'export borné à la visibilité');
});

test('traçabilité : consultations sensibles, intégrité et exports laissent des traces distinctes', async () => {
  const n = (a: string) => Number(psql(`SELECT count(*) FROM audit.audit_log WHERE tenant_id='${tenantAId}' AND module='audit' AND action='${a}'`));
  assert.ok(n('audit_consulted') >= 1, 'consultation tracée');
  assert.ok(n('audit_event_viewed') >= 1, 'détail tracé');
  assert.ok(n('audit_integrity_checked') >= 3, 'vérifications tracées');
  assert.ok(n('audit_exported') >= 3, 'exports tracés');
  // Ces traces sont elles-mêmes consultables par l'auditeur (module=audit).
  const tok = await token(slugA, auditorEmail);
  const traces = await items('/audit/events?module=audit&limit=200', tok);
  assert.ok(traces.some((i) => i.action === 'audit_exported'));
});

test('falsification : la vérification d’intégrité signale broken à la ligne exacte', async () => {
  // Le propriétaire (migrator) désactive temporairement le trigger — l'API, elle, ne
  // dispose d'AUCUNE voie d'écriture ni de réparation.
  psql(`ALTER TABLE audit.audit_log DISABLE TRIGGER trg_audit_immutable`);
  psql(`UPDATE audit.audit_log SET reason='falsifié discrètement' WHERE id='${tamperTargetId}'`);
  psql(`ALTER TABLE audit.audit_log ENABLE TRIGGER trg_audit_immutable`);
  const tok = await token(slugA, auditorEmail);
  const res = (await (await get('/audit/integrity?maxRows=50000', tok)).json()) as { status: string; brokenAtId?: string };
  assert.equal(res.status, 'broken', 'falsification détectée');
  assert.equal(res.brokenAtId, tamperTargetId, 'rupture localisée à la ligne falsifiée');
});

test('NÉGATIF inter-tenant : B ne voit rien de A — liste, détail, intégrité, export', async () => {
  const bTok = await token(slugB, bAuditorEmail);
  const aIds = new Set([secretRowId, authRowId, tamperTargetId]);
  const list = await items('/audit/events?limit=200', bTok);
  assert.ok(list.every((i) => !aIds.has(i.id) && !i.action.startsWith('bulk_')), 'aucun événement de A');
  assert.equal((await get(`/audit/events/${secretRowId}`, bTok)).status, 404);
  const integ = (await (await get('/audit/integrity?maxRows=50000', bTok)).json()) as { status: string; checked: number };
  assert.equal(integ.status, 'valid', 'B vérifie SA chaîne (vide ou presque), pas celle de A');
  assert.ok(integ.checked < 100, `B ne vérifie que sa propre chaîne (${integ.checked})`);
  const exp = (await (await get('/audit/export/json?limit=10000', bTok)).json()) as { items: Array<{ action: string }> };
  assert.ok(exp.items.every((i) => !i.action.startsWith('bulk_')), 'export de B sans lignes de A');
});

test('performance : liste, filtre et export restent stables sur 3000+ lignes', async () => {
  const tok = await token(slugA, auditorEmail);
  const t1 = Date.now();
  await items('/audit/events?limit=200', tok);
  const dList = Date.now() - t1;
  const t2 = Date.now();
  await items('/audit/events?module=bulk&action=bulk_2000&limit=200', tok);
  const dFilter = Date.now() - t2;
  const t3 = Date.now();
  await get('/audit/export/csv?module=bulk&limit=1000', tok);
  const dExport = Date.now() - t3;
  console.log(`perf audit : liste=${dList}ms filtre=${dFilter}ms export1000=${dExport}ms`);
  assert.ok(dList < 2500, `liste ${dList}ms`);
  assert.ok(dFilter < 2500, `filtre ${dFilter}ms`);
  assert.ok(dExport < 5000, `export ${dExport}ms`);
});

test('OpenAPI : endpoints audit documentés', async () => {
  const spec = (await (await fetch(`${base}/openapi.json`)).json()) as { paths: Record<string, unknown> };
  for (const p of ['/audit/events', '/audit/events/{id}', '/audit/integrity', '/audit/export/csv', '/audit/export/json']) {
    assert.ok(spec.paths[p], `chemin ${p} documenté`);
  }
});
