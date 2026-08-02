/**
 * TESTS NAVIGATEUR (clôture Phase 1) — Playwright + node:test, exécutés par le job
 * CI « browser » contre la CHAÎNE RÉELLE : serve.mjs (en-têtes de production, proxy
 * même origine) → API KORA compilée → PostgreSQL migré.
 *
 * Parcours exigés : connexion, MFA TOTP réel, navigation RBAC, consultation salarié,
 * révocation de session (rejet immédiat), bascule FR/EN persistée, installabilité
 * PWA, comportement de mise à jour du service worker, mode hors ligne — et la
 * garantie CENTRALE : aucun jeton accessible au JavaScript, AUCUNE donnée RH dans
 * Cache Storage / localStorage / sessionStorage / IndexedDB.
 *
 * Captures d'écran UNIQUEMENT en échec (test-results/, publié en artefact si échec).
 * Hors CI (API non compilée ou Playwright absent), la suite se saute proprement.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const API_DIST = join(repoRoot, 'apps', 'api', 'dist', 'apps', 'api', 'src', 'main.js');
const WEB_DIST = join(here, '..', 'dist');
const RESULTS = join(here, '..', 'test-results');
const MIGRATOR_URL = process.env.DATABASE_URL_MIGRATOR ?? '';

process.env.KORA_MFA_KEY ??= 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

let playwright = null;
try {
  playwright = await import('playwright');
} catch {
  playwright = null;
}
const RUNNABLE = playwright !== null && existsSync(API_DIST) && MIGRATOR_URL.length > 0 && existsSync(WEB_DIST);

function psql(sql) {
  const r = spawnSync('psql', [MIGRATOR_URL, '-qXtA', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

const rid = randomUUID().slice(0, 8);
const P = 'Falaise-Tanougou-2026!';
const slug = `pw-${rid}`;
const adminEmail = `pwa.adm.${rid}@demo.bj`;
const viewerEmail = `pwa.view.${rid}@demo.bj`;
const mfaEmail = `pwa.mfa.${rid}@demo.bj`;
// Compte DÉDIÉ aux parcours temps + mobile : le limiteur de connexion (10/min par
// identité — comportement de PRODUCTION, jamais assoupli pour les tests) est sinon
// atteint par l'accumulation des connexions admin de la suite (CI run 30714332862).
const timeAdmEmail = `pwa.tadm.${rid}@demo.bj`;

let app = null;
let webServer = null;
let browser = null;
let BASE = '';
let API_PORT = 0;
let tenantId = '';
let mfaSecret = '';
let hr = null;

async function seedUser(email, perms) {
  const require2 = createRequire(join(repoRoot, 'apps', 'api', 'package.json'));
  const argon2 = require2('argon2');
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

/** Fixtures RH : organisation ACTIVE + dossiers pour la consultation réelle. */
function seedHr() {
  const co = psql(`INSERT INTO org.companies (tenant_id, code, label_fr, label_en, status) VALUES ('${tenantId}','PW-CO','Société PW','PW Co','active') RETURNING id`);
  const unit = psql(`INSERT INTO org.units (tenant_id, unit_type, code, label_fr, label_en, company_id, status) VALUES ('${tenantId}','department','PW-RH','Département RH','HR Dept','${co}','active') RETURNING id`);
  const mk = (mat, fn, ln) => psql(`INSERT INTO core.employees (tenant_id, matricule, first_name, last_name, status, hire_date, employer_company_id)
    VALUES ('${tenantId}','${mat}','${fn}','${ln}','active','2025-01-06','${co}') RETURNING id`);
  const e1 = mk('PW-0001', 'Awa', 'Sossou');
  mk('PW-0002', 'Bio', 'Kassim');
  psql(`INSERT INTO core.employee_assignments (tenant_id, employee_id, company_id, unit_id, is_primary, effective_from)
    VALUES ('${tenantId}','${e1}','${co}','${unit}',true,'2025-01-06')`);
  psql(`INSERT INTO core.employee_identifiers (employee_id, tenant_id, cnss_number, tax_id) VALUES ('${e1}','${tenantId}','CNSS-PW-${rid}','IFU-PW-${rid}')`);
  return { e1 };
}

function waitReady(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = async () => {
      try {
        await fetch(url);
        resolve(undefined);
      } catch {
        if (Date.now() - started > timeoutMs) reject(new Error(`serveur indisponible : ${url}`));
        else setTimeout(tick, 250);
      }
    };
    void tick();
  });
}

/** Capture d'écran UNIQUEMENT en cas d'échec. */
async function shot(page, name, fn) {
  try {
    await fn();
  } catch (e) {
    mkdirSync(RESULTS, { recursive: true });
    await page.screenshot({ path: join(RESULTS, `echec-${name}.png`), fullPage: true }).catch(() => undefined);
    throw e;
  }
}

async function login(page, email, code) {
  await page.goto(BASE + '/');
  await page.waitForSelector('input[autocomplete="organization"]');
  await page.fill('input[autocomplete="organization"]', slug);
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', P);
  await page.click('button[type="submit"]');
  if (code !== undefined) {
    await page.waitForSelector('input[autocomplete="one-time-code"]:visible');
    await page.fill('input[autocomplete="one-time-code"]', code);
    await page.click('button[type="submit"]');
  }
  await page.waitForSelector('.grid-cards', { timeout: 15000 });
}

/** Inventaire des stockages navigateur — la preuve de protection des données. */
async function storageReport(page) {
  return page.evaluate(async () => {
    const cacheEntries = [];
    for (const k of await caches.keys()) {
      const c = await caches.open(k);
      for (const req of await c.keys()) cacheEntries.push(new URL(req.url).pathname);
    }
    const dbs = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [];
    return {
      documentCookie: document.cookie,
      localStorageKeys: Object.keys(localStorage),
      sessionStorageKeys: Object.keys(sessionStorage),
      indexedDbNames: dbs.map((d) => d.name),
      cacheApiEntries: cacheEntries.filter((p) => p.startsWith('/api/')),
      cacheEntryCount: cacheEntries.length,
      bodyText: document.body.textContent ?? '',
    };
  });
}

before(async (tc) => {
  if (!RUNNABLE) {
    tc.skip('chaîne navigateur indisponible (API compilée / Playwright / dist / base) — exécutée par le job CI browser');
    return;
  }
  tenantId = psql(`INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('${slug}','PW Browser',true) RETURNING id`);
  await seedUser(adminEmail, ['employees.view', 'employees.view_private', 'employees.view_identifiers', 'employees.view_documents',
    'employees.view_history', 'workflow.view', 'org.view', 'users.view', 'audit.view', 'parameters.view', 'sessions.revoke',
    'time.schedules_view', 'time.punches_import', 'time.punches_view', 'time.punches_view_errors', 'time.devices_manage']);
  await seedUser(viewerEmail, ['employees.view']);
  await seedUser(timeAdmEmail, ['employees.view', 'workflow.view', 'org.view',
    'time.schedules_view', 'time.punches_import', 'time.punches_view', 'time.punches_view_errors', 'time.devices_manage',
    // E10.2 : déclenchement du moteur + consultation des résultats et anomalies.
    'time.schedules_manage', 'time.schedules_assign', 'time.calc_run', 'time.calc_view',
    'time.results_view', 'time.anomalies_view', 'time.anomalies_manage']);
  await seedUser(mfaEmail, ['employees.view']);
  hr = seedHr();

  const require2 = createRequire(join(here, 'browser.e2e.test.mjs'));
  const mainModule = require2(API_DIST);
  app = await mainModule.createApp();
  await app.listen(0);
  API_PORT = app.getHttpServer().address().port;

  // MFA : enrôlement + activation par l'API (le PARCOURS de connexion, lui, passera par l'UI).
  const { totp } = await import('../../../packages/core/src/totp.ts');
  const apiBase = `http://127.0.0.1:${API_PORT}/api/v1`;
  const loginRes = await fetch(`${apiBase}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenantSlug: slug, email: mfaEmail, password: P }),
  });
  const { token } = await loginRes.json();
  const enroll = await fetch(`${apiBase}/auth/mfa/enroll`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  mfaSecret = (await enroll.json()).secret;
  const activate = await fetch(`${apiBase}/auth/mfa/activate`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ code: totp(mfaSecret, Math.floor(Date.now() / 1000)) }),
  });
  assert.equal(activate.status, 200);

  // Serveur statique de PRODUCTION (en-têtes + proxy même origine vers l'API réelle).
  const webPort = 4600 + Math.floor(Math.random() * 400);
  webServer = spawn(process.execPath, [join(here, '..', 'scripts', 'serve.mjs'), String(webPort)], {
    env: { ...process.env, KORA_API_TARGET: `http://127.0.0.1:${API_PORT}` },
    stdio: 'ignore',
  });
  BASE = `http://127.0.0.1:${webPort}`;
  await waitReady(`${BASE}/index.html`);

  browser = await playwright.chromium.launch();
});

after(async () => {
  if (browser) await browser.close();
  if (webServer) webServer.kill();
  if (app) await app.close();
});

test('en-têtes de sécurité servis par le serveur RÉELLEMENT testé (statique ET API proxifiée)', { skip: !RUNNABLE }, async () => {
  const page = await fetch(`${BASE}/`);
  const csp = page.headers.get('content-security-policy') ?? '';
  for (const directive of ["default-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'self'"]) {
    assert.ok(csp.includes(directive), `CSP statique : ${directive}`);
  }
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.ok((page.headers.get('permissions-policy') ?? '').includes('camera=()'));
  // À travers le proxy, l'API applique SES en-têtes (dont l'anti-cache no-store).
  const api = await fetch(`${BASE}/api/v1/health`);
  assert.equal(api.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(api.headers.get('cache-control'), 'no-store');
  assert.ok((api.headers.get('content-security-policy') ?? '').includes("frame-ancestors 'none'"));
});

test('connexion réelle : cookie HttpOnly INVISIBLE du JavaScript, aucun stockage local', { skip: !RUNNABLE }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await shot(page, 'connexion', async () => {
    await login(page, adminEmail);
    const report = await storageReport(page);
    assert.ok(!report.documentCookie.includes('kora_session'), 'document.cookie ne montre JAMAIS le jeton (HttpOnly)');
    assert.deepEqual(report.sessionStorageKeys, [], 'sessionStorage vide (plus aucun jeton client)');
    assert.ok(report.localStorageKeys.every((k) => k === 'kora.locale'), `localStorage borné au miroir de langue : ${report.localStorageKeys}`);
    assert.deepEqual(report.indexedDbNames, [], 'aucune base IndexedDB');
    // NB : le cookie est borné à Path=/api — l'interroger sur une URL /api.
    const cookies = await ctx.cookies(`${BASE}/api/v1/health`);
    const sessionCookie = cookies.find((c) => c.name === 'kora_session');
    assert.ok(sessionCookie, 'le cookie de session existe côté navigateur');
    assert.equal(sessionCookie.httpOnly, true, 'HttpOnly');
    assert.equal(sessionCookie.sameSite, 'Strict', 'SameSite=Strict');
    assert.equal(sessionCookie.path, '/api', 'portée bornée à l’API');
  });
  await ctx.close();
});

test('identifiants invalides : message générique, on reste à la connexion', { skip: !RUNNABLE }, async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await shot(page, 'mauvais-mdp', async () => {
    await page.goto(BASE + '/');
    await page.waitForSelector('input[autocomplete="organization"]');
    await page.fill('input[autocomplete="organization"]', slug);
    await page.fill('input[type="email"]', adminEmail);
    await page.fill('input[type="password"]', 'Mauvais-2026!');
    await page.click('button[type="submit"]');
    await page.waitForSelector('p[role="alert"]:visible');
    assert.ok(await page.isVisible('input[type="password"]'), 'toujours sur l’écran de connexion');
  });
  await ctx.close();
});

test('parcours MFA RÉEL via l’interface : code exigé puis accepté', { skip: !RUNNABLE }, async () => {
  const { totp } = await import('../../../packages/core/src/totp.ts');
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await shot(page, 'mfa', async () => {
    await login(page, mfaEmail, totp(mfaSecret, Math.floor(Date.now() / 1000)));
    assert.ok(await page.isVisible('.grid-cards'), 'tableau de bord atteint après le second facteur');
  });
  await ctx.close();
});

test('RBAC : les menus suivent les permissions ET le serveur tranche en direct', { skip: !RUNNABLE }, async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await shot(page, 'rbac', async () => {
    await login(page, viewerEmail);
    const sidebar = await page.textContent('.sidebar');
    assert.ok(sidebar.includes('Salariés'), 'entrée RH visible');
    assert.ok(!sidebar.includes('Utilisateurs et rôles') && !sidebar.includes('Audit') && !sidebar.includes('Config Center'),
      'menus non permis absents');
    // Route directe : l'affichage refuse…
    await page.goto(`${BASE}/#/admin/users`);
    await page.waitForSelector('.state');
    assert.ok((await page.textContent('.state')).includes('Accès refusé'));
    // …et surtout le SERVEUR refuse (le masquage n'est pas la sécurité).
    const direct = await page.evaluate(async () => (await fetch('/api/v1/admin/users', { credentials: 'same-origin' })).status);
    assert.equal(direct, 403, 'appel direct : 403 serveur');
  });
  await ctx.close();
});

test('consultation salarié RÉELLE : liste du périmètre, fiche, zone identifiants auditée', { skip: !RUNNABLE }, async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await shot(page, 'salaries', async () => {
    await login(page, adminEmail);
    await page.click('a[href="#/employees"]');
    await page.waitForSelector('tbody tr');
    assert.ok((await page.textContent('tbody')).includes('PW-0001'), 'dossiers seedés servis par l’API');
    await page.click('tbody tr');
    await page.waitForSelector('.tabs');
    await page.click('.tab >> text=Identifiants');
    await page.waitForSelector(`text=CNSS-PW-${rid}`);
    const auditCount = psql(`SELECT count(*) FROM audit.audit_log WHERE tenant_id='${tenantId}' AND action='employee_identifiers_viewed'`);
    assert.ok(Number(auditCount) >= 1, 'la consultation de la zone administrative est JOURNALISÉE');
  });
  await ctx.close();
});

test('révocation : les autres sessions meurent IMMÉDIATEMENT (retour connexion)', { skip: !RUNNABLE }, async () => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  await shot(pageB, 'revocation', async () => {
    await login(pageA, adminEmail);
    await login(pageB, adminEmail);
    await pageA.click('a[href="#/me/sessions"]');
    await pageA.waitForSelector('tbody tr');
    pageA.once('dialog', () => undefined); // aucun dialog natif attendu (modal maison)
    await pageA.click('.page-title button.btn-danger');
    await pageA.waitForSelector('.overlay');
    await pageA.click('.overlay .btn-primary, .overlay .btn-danger');
    await pageA.waitForSelector('.toast-ok');
    // B agit → 401 → purge → écran de connexion, sans intervention.
    await pageB.click('a[href="#/employees"]');
    await pageB.waitForSelector('input[type="password"]', { timeout: 10000 });
    assert.ok(true, 'B est revenu à la connexion immédiatement');
  });
  await ctxA.close();
  await ctxB.close();
});

test('bascule FR/EN à chaud, persistée côté serveur au rechargement', { skip: !RUNNABLE }, async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await shot(page, 'langue', async () => {
    await login(page, adminEmail);
    await page.click('.header button:has-text("FR")');
    await page.waitForSelector('.sidebar >> text=Employees');
    await page.reload();
    await page.waitForSelector('.grid-cards');
    assert.ok((await page.textContent('.sidebar')).includes('Employees'), 'l’anglais persiste après rechargement (users.locale)');
    await page.click('.header button:has-text("EN")');
    await page.waitForSelector('.sidebar >> text=Salariés');
  });
  await ctx.close();
});

test('PWA : installabilité Chromium (manifeste + SW actif + icônes) et MISE À JOUR proposée', { skip: !RUNNABLE }, async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await shot(page, 'pwa', async () => {
    await login(page, adminEmail);
    const mf = await page.evaluate(async () => (await (await fetch('/manifest.webmanifest')).json()));
    assert.equal(mf.short_name, 'KORA');
    assert.equal(mf.display, 'standalone');
    for (const icon of mf.icons) {
      const status = await page.evaluate(async (src) => (await fetch(src)).status, icon.src);
      assert.equal(status, 200, `icône ${icon.src}`);
    }
    await page.waitForFunction(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return reg?.active?.state === 'activated';
    });
    // MISE À JOUR : le sw.js change sur le disque → update() → bandeau → rechargement.
    appendFileSync(join(WEB_DIST, 'sw.js'), `\n/* maj-test-${rid} */\n`);
    await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      await reg.update();
    });
    await page.waitForSelector('.banner-update', { timeout: 15000 });
    await page.click('.banner-update button');
    await page.waitForLoadState('load');
    await page.waitForSelector('.grid-cards', { timeout: 15000 });
    assert.ok(true, 'nouvelle version appliquée, session cookie intacte');
  });
  await ctx.close();
});

test('HORS LIGNE : coquille servie, API en échec, AUCUNE donnée RH dans les stockages', { skip: !RUNNABLE }, async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await shot(page, 'hors-ligne', async () => {
    await login(page, adminEmail);
    await page.click('a[href="#/employees"]');
    await page.waitForSelector('tbody tr'); // des données RH ONT été consultées
    await ctx.setOffline(true);
    await page.reload().catch(() => undefined);
    await page.waitForTimeout(1200);
    const report = await storageReport(page);
    assert.ok(report.cacheEntryCount >= 3, 'la coquille est bien précachée');
    assert.deepEqual(report.cacheApiEntries, [], 'AUCUNE réponse /api dans Cache Storage');
    assert.deepEqual(report.sessionStorageKeys, [], 'sessionStorage vide');
    assert.ok(report.localStorageKeys.every((k) => k === 'kora.locale'), 'localStorage sans donnée RH');
    assert.deepEqual(report.indexedDbNames, [], 'IndexedDB vide');
    assert.ok(!report.bodyText.includes('PW-0001') && !report.bodyText.includes(`CNSS-PW-${rid}`),
      'les données RH consultées ne SURVIVENT PAS hors ligne');
    const apiStatus = await page.evaluate(async () => {
      try {
        return (await fetch('/api/v1/employees', { credentials: 'same-origin' })).status;
      } catch {
        return 'network-error';
      }
    });
    assert.equal(apiStatus, 'network-error', 'l’API n’est jamais servie depuis un cache');
    await ctx.setOffline(false);
  });
  await ctx.close();
});

test('déconnexion : cookie détruit, stockages propres, retour arrière sans données', { skip: !RUNNABLE }, async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await shot(page, 'deconnexion', async () => {
    await login(page, adminEmail);
    await page.click('.sidebar button:has-text("Se déconnecter")');
    await page.waitForSelector('input[type="password"]');
    const cookies = await ctx.cookies(`${BASE}/api/v1/health`);
    assert.equal(cookies.find((c) => c.name === 'kora_session'), undefined, 'cookie de session détruit');
    const report = await storageReport(page);
    assert.deepEqual(report.sessionStorageKeys, []);
    assert.ok(report.localStorageKeys.every((k) => k === 'kora.locale'));
    await page.goto(`${BASE}/#/employees`);
    await page.waitForSelector('input[type="password"]');
    assert.ok(true, 'aucune donnée RH accessible après déconnexion');
  });
  await ctx.close();
});

test('TEMPS (E10.1) : import réel par l’API, registre visible, et HORS LIGNE aucune donnée de pointage ne survit', { skip: !RUNNABLE }, async () => {
  // Import CSV RÉEL par la surface API (Bearer) : 2 pointages du salarié PW-0001.
  const apiBase = `http://127.0.0.1:${API_PORT}/api/v1`;
  const loginRes = await fetch(`${apiBase}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenantSlug: slug, email: timeAdmEmail, password: P }),
  });
  const { token } = await loginRes.json();
  const imp = await fetch(`${apiBase}/time/punches/import`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      source: 'csv', mode: 'apply', filename: 'nav.csv',
      contentText: `matricule;dateheure;sens\nPW-0001;2026-07-01 08:02;E\nPW-0001;2026-07-01 17:31;S\n`,
    }),
  });
  assert.equal(imp.status, 200);
  assert.equal((await imp.json()).kind, 'applied');

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await shot(page, 'temps-pointages', async () => {
    await login(page, timeAdmEmail);
    // Registre brut : le pointage importé est là, statut apparié.
    await page.click('a[href="#/time/punches"]');
    await page.waitForSelector('tbody tr');
    const body = await page.evaluate(() => document.body.textContent ?? '');
    assert.ok(body.includes('PW-0001'), 'le pointage importé apparaît');
    assert.ok(body.includes('08:02') || body.includes('2026-07-01 08:02'), 'horodatage source affiché');
    // Lots : compteurs visibles.
    await page.click('a[href="#/time/batches"]');
    await page.waitForSelector('tbody tr');
    // HORS LIGNE : la coquille tient, AUCUNE donnée de pointage ne reste lisible.
    await ctx.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#app');
    const report = await storageReport(page);
    assert.deepEqual(report.cacheApiEntries, [], 'AUCUNE réponse /api en Cache Storage');
    assert.deepEqual(report.sessionStorageKeys, [], 'sessionStorage vide');
    assert.ok(report.localStorageKeys.every((k) => k === 'kora.locale'), 'localStorage borné à la langue');
    assert.ok(!report.bodyText.includes('PW-0001'), 'aucun matricule pointé lisible hors ligne');
    assert.ok(!report.bodyText.includes('08:02'), 'aucun horodatage de pointage lisible hors ligne');
    const apiOffline = await page.evaluate(async () => {
      try {
        const r = await fetch('/api/v1/time/punches/raw');
        return `status:${r.status}`;
      } catch {
        return 'network-error';
      }
    });
    assert.equal(apiOffline, 'network-error', 'l’API de pointage ne répond JAMAIS depuis un cache');
    await ctx.setOffline(false);
  });
  await ctx.close();
});

test('TEMPS (E10.1) : RBAC — sans permission, ni menu, ni écran, ni API (le serveur tranche)', { skip: !RUNNABLE }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await shot(page, 'temps-rbac', async () => {
    await login(page, viewerEmail); // employees.view SEUL
    const hasTimeLink = await page.evaluate(() => document.querySelector('a[href="#/time/punches"]') !== null);
    assert.equal(hasTimeLink, false, 'menu Temps absent sans permission');
    await page.goto(`${BASE}/#/time/punches`);
    await page.waitForFunction(() =>
      (document.body.textContent ?? '').includes('Accès refusé')
      || (document.body.textContent ?? '').includes('Access denied'));
    const body = await page.evaluate(() => document.body.textContent ?? '');
    assert.ok(!body.includes('PW-0001'), 'aucun matricule de pointage rendu');
    assert.ok(!body.includes('08:02'), 'aucun horodatage de pointage rendu');
    // Le MASQUAGE n'est pas la sécurité : l'appel direct est refusé par le SERVEUR.
    const direct = await page.evaluate(async () => (await fetch('/api/v1/time/punches/raw')).status);
    assert.equal(direct, 403, 'API : 403 sans permission');
    const importDirect = await page.evaluate(async () => (await fetch('/api/v1/time/punches/import', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'csv', mode: 'preview', contentText: 'x' }),
    })).status);
    assert.equal(importDirect, 403, 'API import : 403 sans permission (et CSRF géré par le client)');
  });
  await ctx.close();
});

test('TEMPS (E10.2) : calcul RÉEL par l’API, registre + détail de journée, et HORS LIGNE aucun résultat ne survit', { skip: !RUNNABLE }, async () => {
  // 1. Horaire + affectation + exécution du MOTEUR par la surface API (Bearer).
  const apiBase = `http://127.0.0.1:${API_PORT}/api/v1`;
  const loginRes = await fetch(`${apiBase}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenantSlug: slug, email: timeAdmEmail, password: P }),
  });
  const { token } = await loginRes.json();
  const post = async (path, body) => {
    const r = await fetch(`${apiBase}${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.ok(r.status === 200 || r.status === 201, `${path} → ${r.status} ${await r.text().catch(() => '')}`);
    return r.json();
  };
  const model = await post('/time/schedules/models', { code: 'PW-JOUR', labelFr: 'Jour PW', labelEn: 'PW Day', kind: 'fixed' });
  await post(`/time/schedules/models/${model.id}/versions`, {
    effectiveFrom: '2026-01-05', cycleDays: 7,
    days: [0, 1, 2, 3, 4].map((i) => ({ dayIndex: i, isRest: false, startMinute: 480, endMinute: 1020, breakStartMinute: 720, breakEndMinute: 780 }))
      .concat([{ dayIndex: 5, isRest: true }, { dayIndex: 6, isRest: true }]),
  });
  await post('/time/schedules/assignments', {
    employeeId: hr.e1, modelId: model.id, anchorDate: '2026-01-05', effectiveFrom: '2026-01-05',
  });
  const { run } = await post('/time/calc/run', {
    periodStart: '2026-07-01', periodEnd: '2026-07-01', scopeKind: 'employee', scopeId: hr.e1,
    reason: 'calcul du parcours navigateur',
  });
  assert.equal(run.status, 'completed');
  assert.equal(run.resultsWritten, 1);

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await shot(page, 'temps-resultats', async () => {
    await login(page, timeAdmEmail);
    // 2. Registre de présence : la journée calculée du 2026-07-01 est là.
    await page.click('a[href="#/time/results"]');
    await page.waitForSelector('input[type="date"]');
    await page.fill('input[type="date"]', '2026-07-01');
    await page.click('form button[type="submit"]');
    await page.waitForSelector('tbody tr');
    let body = await page.evaluate(() => document.body.textContent ?? '');
    assert.ok(body.includes('PW-0001'), 'le salarié calculé apparaît au registre');
    assert.ok(body.includes('En retard') || body.includes('Late'), 'statut dérivé des faits (08:02 pour 08:00)');
    // 3. Détail de la journée : chronologie + retenu vs BRUT + paramètres à la date.
    await page.click(`a[href="#/time/results/${hr.e1}/2026-07-01"]`);
    await page.waitForFunction(() => (document.body.textContent ?? '').includes('08:02'));
    body = await page.evaluate(() => document.body.textContent ?? '');
    assert.ok(body.includes('temps.tolerance.retard'), 'les paramètres appliqués À LA DATE sont montrés');
    assert.ok(body.includes('kora-presence-'), 'la version du MOTEUR est affichée (reproductibilité)');
    // 4. HORS LIGNE : la coquille tient, AUCUN résultat de présence ne reste lisible.
    await ctx.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#app');
    const report = await storageReport(page);
    assert.deepEqual(report.cacheApiEntries, [], 'AUCUNE réponse /api en Cache Storage');
    assert.deepEqual(report.sessionStorageKeys, [], 'sessionStorage vide');
    assert.ok(!report.bodyText.includes('PW-0001'), 'aucun matricule de résultat lisible hors ligne');
    assert.ok(!report.bodyText.includes('En retard'), 'aucun statut de présence lisible hors ligne');
    const apiOffline = await page.evaluate(async () => {
      try {
        const r = await fetch('/api/v1/time/results?date=2026-07-01');
        return `status:${r.status}`;
      } catch {
        return 'network-error';
      }
    });
    assert.equal(apiOffline, 'network-error', 'les résultats de présence ne répondent JAMAIS depuis un cache');
    await ctx.setOffline(false);
  });
  await ctx.close();
});

test('TEMPS (E10.2) : RBAC — sans permission, ni registre, ni calcul (le serveur tranche)', { skip: !RUNNABLE }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await shot(page, 'temps-calc-rbac', async () => {
    await login(page, viewerEmail); // employees.view SEUL
    const hasLink = await page.evaluate(() => document.querySelector('a[href="#/time/results"]') !== null);
    assert.equal(hasLink, false, 'menu Registre absent sans permission');
    await page.goto(`${BASE}/#/time/results`);
    await page.waitForFunction(() =>
      (document.body.textContent ?? '').includes('Accès refusé')
      || (document.body.textContent ?? '').includes('Access denied'));
    const body = await page.evaluate(() => document.body.textContent ?? '');
    assert.ok(!body.includes('PW-0001'), 'aucun résultat rendu');
    // Le MASQUAGE n'est pas la sécurité : les appels directs sont refusés par le SERVEUR.
    const direct = await page.evaluate(async () => (await fetch('/api/v1/time/results?date=2026-07-01')).status);
    assert.equal(direct, 403, 'API résultats : 403 sans permission');
    const runDirect = await page.evaluate(async () => (await fetch('/api/v1/time/calc/run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ periodStart: '2026-07-01', periodEnd: '2026-07-01', scopeKind: 'tenant', reason: 'x' }),
    })).status);
    assert.equal(runDirect, 403, 'API calcul : 403 sans permission');
    const anomDirect = await page.evaluate(async () => (await fetch('/api/v1/time/anomalies')).status);
    assert.equal(anomDirect, 403, 'API anomalies : 403 sans permission');
  });
  await ctx.close();
});

test('mobile : connexion, tableau de bord, menu tiroir et liste en cartes', { skip: !RUNNABLE }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await shot(page, 'mobile', async () => {
    await login(page, timeAdmEmail);
    await page.click('.header button');
    await page.waitForSelector('.shell.nav-open');
    await page.click('a[href="#/employees"]');
    await page.waitForSelector('tbody tr');
    const label = await page.getAttribute('tbody tr td', 'data-label');
    assert.ok(label && label.length > 0, 'les cellules portent leur libellé (vue cartes mobile)');
  });
  await ctx.close();
});
