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
// Compte ESS (E10.3/E11.1) : relié au dossier salarié PW-0001 — demandes pour
// SOI et consultation de SES soldes de congés uniquement.
const essEmail = `pwa.ess.${rid}@demo.bj`;
// Compte administration des CONGÉS (E11.1) : référentiel, politiques, acquisitions,
// soldes, ledger, ajustements, reprise.
const leaveAdmEmail = `pwa.ladm.${rid}@demo.bj`;
// E11.2 — identités DÉDIÉES aux parcours de demandes (limiteur 10/min par identité) :
// salarié demandeur (PW-0003), manager approbateur (PW-0004), RH approbatrice/file.
const lrEssEmail = `pwa.lress.${rid}@demo.bj`;
const lrMgrEmail = `pwa.lrmgr.${rid}@demo.bj`;
const lrRhEmail = `pwa.lrrh.${rid}@demo.bj`;

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
    'time.results_view', 'time.anomalies_view', 'time.anomalies_manage',
    // E10.3 : circuit (configuration), file des demandes, périodes, clôture, paie.
    'workflow.manage', 'time.correction_view', 'time.correction_admin', 'time.attachments_view',
    'time.preclose_view', 'time.period_manage', 'time.period_close', 'time.period_reopen',
    'time.payroll_view', 'time.payroll_export']);
  await seedUser(mfaEmail, ['employees.view']);
  const essUserId = await seedUser(essEmail, ['time.correction_request_self', 'leave.balance_view_own']);
  await seedUser(leaveAdmEmail, ['employees.view',
    'leave.types_admin', 'leave.policies_admin', 'leave.accrual_run', 'leave.balance_adjust',
    'leave.openings_import', 'leave.balance_view', 'leave.ledger_view',
    // E11.2 : configuration des circuits de demandes + horaires du salarié de test.
    'workflow.manage', 'time.schedules_manage', 'time.schedules_assign']);
  const lrEssUserId = await seedUser(lrEssEmail, ['leave.request_self', 'leave.requests_view_own', 'leave.balance_view_own']);
  const lrMgrUserId = await seedUser(lrMgrEmail, ['leave.requests_view_team', 'workflow.view', 'workflow.act']);
  const lrRhRole = psql(`INSERT INTO admin.roles (tenant_id, key, name) VALUES ('${tenantId}','pw-rh-conges','RH congés PW') RETURNING id`);
  const lrRhUserId = psql(`INSERT INTO admin.users (tenant_id, email, password_hash) VALUES ('${tenantId}','${lrRhEmail}', (SELECT password_hash FROM admin.users WHERE email = '${lrEssEmail}')) RETURNING id`);
  psql(`INSERT INTO admin.user_scopes (tenant_id, user_id, scope_type) VALUES ('${tenantId}','${lrRhUserId}','tenant')`);
  for (const perm of ['leave.requests_admin', 'leave.calendar_view', 'leave.calendar_export', 'workflow.view', 'workflow.act']) {
    psql(`INSERT INTO admin.role_permissions (tenant_id, role_id, permission_key) VALUES ('${tenantId}','${lrRhRole}','${perm}')`);
  }
  psql(`INSERT INTO admin.user_roles (tenant_id, user_id, role_id) VALUES ('${tenantId}','${lrRhUserId}','${lrRhRole}')`);
  hr = seedHr();
  // Lien compte ↔ dossier salarié : la demande « pour soi » ne vise QUE ce dossier.
  psql(`UPDATE core.employees SET user_id = '${essUserId}' WHERE id = '${hr.e1}'`);
  // E11.2 : PW-0004 (manager) puis PW-0003 (demandeur, dérogation managériale → PW-0004).
  const co = psql(`SELECT id FROM org.companies WHERE tenant_id = '${tenantId}' AND code = 'PW-CO'`);
  const unit = psql(`SELECT id FROM org.units WHERE tenant_id = '${tenantId}' AND code = 'PW-RH'`);
  hr.e4 = psql(`INSERT INTO core.employees (tenant_id, matricule, first_name, last_name, status, hire_date, employer_company_id)
    VALUES ('${tenantId}','PW-0004','Manou','Gbaguidi','active','2025-01-06','${co}') RETURNING id`);
  psql(`INSERT INTO core.employee_assignments (tenant_id, employee_id, company_id, unit_id, is_primary, effective_from)
    VALUES ('${tenantId}','${hr.e4}','${co}','${unit}',true,'2025-01-06')`);
  hr.e3 = psql(`INSERT INTO core.employees (tenant_id, matricule, first_name, last_name, status, hire_date, employer_company_id)
    VALUES ('${tenantId}','PW-0003','Sika','Adjovi','active','2025-01-06','${co}') RETURNING id`);
  psql(`INSERT INTO core.employee_assignments (tenant_id, employee_id, company_id, unit_id, is_primary, effective_from, manager_override_employee_id)
    VALUES ('${tenantId}','${hr.e3}','${co}','${unit}',true,'2025-01-06','${hr.e4}')`);
  psql(`UPDATE core.employees SET user_id = '${lrEssUserId}' WHERE id = '${hr.e3}'`);
  psql(`UPDATE core.employees SET user_id = '${lrMgrUserId}' WHERE id = '${hr.e4}'`);

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
    // Le corps n'est lisible qu'UNE fois : texte, assert, puis parse (CI 30757393308).
    const text = await r.text();
    assert.ok(r.status === 200 || r.status === 201, `${path} → ${r.status} ${text}`);
    return JSON.parse(text);
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

test('TEMPS (E10.3) : demande ESS via l’UI, décision SÉPARÉE, clôture, variables de paie SANS montant, HORS LIGNE rien ne survit', { skip: !RUNNABLE }, async () => {
  // 1. Circuit d'approbation E3 — CONFIGURATION du tenant (jamais du code) : un
  // pas, approbateur = rôle du gestionnaire temps. Séparation native : le
  // demandeur ne peut PAS approuver sa propre demande.
  const apiBase = `http://127.0.0.1:${API_PORT}/api/v1`;
  const bearer = async (email) => {
    const r = await fetch(`${apiBase}/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenantSlug: slug, email, password: P }),
    });
    return (await r.json()).token;
  };
  const call = async (token, method, path, body) => {
    const r = await fetch(`${apiBase}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : {} };
  };
  const adm = await bearer(timeAdmEmail);
  const def = await call(adm, 'POST', '/workflow/definitions', {
    key: 'temps_correction', name: 'Correction de présence',
    steps: [{ index: 0, name: 'Administration du temps', approverType: 'role', approverRef: `r-pwa.tadm.${rid}` }],
  });
  assert.equal(def.status, 201, JSON.stringify(def.body));
  assert.equal((await call(adm, 'POST', `/workflow/definitions/${def.body.id}/activate`)).status, 200);
  // Empreinte du BRUT avant toute correction — il devra être inchangé au bit près.
  const rawDigest = () => psql(`SELECT count(*) || ':' || coalesce(md5(string_agg(fingerprint, ',' ORDER BY fingerprint)), '-')
    FROM time.raw_punches WHERE tenant_id = '${tenantId}'`);
  const rawBefore = rawDigest();

  // 2. ESS : déclarer un retard justifié via l'UI (2 min de retard le 2026-07-01).
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await shot(page, 'e103-ess', async () => {
    await login(page, essEmail);
    const nav = await page.evaluate(() => ({
      mine: document.querySelector('a[href="#/time/requests-mine"]') !== null,
      queue: document.querySelector('a[href="#/time/requests"]') !== null,
      periods: document.querySelector('a[href="#/time/periods"]') !== null,
    }));
    assert.equal(nav.mine, true, 'l’ESS voit « Mes demandes »');
    assert.equal(nav.queue, false, 'l’ESS ne voit PAS la file de décision');
    assert.equal(nav.periods, false, 'l’ESS ne voit PAS les périodes');
    await page.click('a[href="#/time/requests-mine"]');
    await page.waitForSelector('form select');
    await page.selectOption('form select', 'justify_late');
    await page.fill('input[type="date"]', '2026-07-01');
    await page.getByLabel('Motif').fill('Panne du bus interurbain — attestation du transporteur');
    await page.getByLabel('Catégorie').fill('transport');
    await page.click('form button[type="submit"]');
    await page.waitForFunction(() => (document.body.textContent ?? '').includes('Soumise'));
    const bodyEss = await page.evaluate(() => document.body.textContent ?? '');
    assert.ok(bodyEss.includes('v1'), 'la version soumise (v1) est visible — la décision portera sur ELLE');
    assert.ok(!bodyEss.includes('Approuver'), 'aucun bouton de décision côté ESS (et le serveur tranche)');
  });
  await ctx.close();

  // 3. Séparation demandeur/approbateur PROUVÉE PAR LE SERVEUR : l'ESS tente
  // d'approuver et d'appliquer SA demande — refus, même en appel direct.
  const ess = await bearer(essEmail);
  const mine = await call(ess, 'GET', '/time/corrections/mine');
  assert.equal(mine.status, 200);
  const reqId = mine.body.items[0].id;
  assert.equal(mine.body.items[0].status, 'submitted');
  assert.equal((await call(ess, 'POST', `/time/corrections/${reqId}/decide`, { action: 'approve' })).status, 403,
    'auto-approbation IMPOSSIBLE : le demandeur n’est jamais son approbateur');
  assert.equal((await call(ess, 'POST', `/time/corrections/${reqId}/apply`)).status, 403,
    'application réservée à l’administration du temps');

  // 4. Gestionnaire temps : approbation via l'UI → application idempotente,
  // NOUVELLE version calculée, l'ancienne DEMEURE, le brut ne bouge pas.
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page2 = await ctx2.newPage();
  await shot(page2, 'e103-decision-cloture', async () => {
    await login(page2, timeAdmEmail);
    await page2.click('a[href="#/time/requests"]');
    await page2.waitForSelector('tbody tr');
    const queueBody = await page2.evaluate(() => document.body.textContent ?? '');
    assert.ok(queueBody.includes('Justifier un retard') && queueBody.includes('PW-0001'), 'la demande soumise est dans la file');
    await page2.click('tbody button:has-text("Approuver")');
    await page2.waitForFunction(() => (document.body.textContent ?? '').includes('Correction appliquée'));
    assert.equal(rawDigest(), rawBefore, 'pointages BRUTS inchangés au bit près après application');
    const hist = await page2.evaluate(async (empId) => {
      const r = await fetch(`/api/v1/time/results/history?employeeId=${empId}&date=2026-07-01`);
      return { status: r.status, body: await r.json() };
    }, hr.e1);
    assert.equal(hist.status, 200);
    assert.equal(hist.body.versions.length, 2, 'ancienne version CONSERVÉE + nouvelle version courante');
    const current = hist.body.versions.find((v) => v.isCurrent);
    assert.equal(current.version, 2);
    assert.equal(current.lateJustified, true, 'retard JUSTIFIÉ — aucune heure inventée, la mesure demeure');

    // 5. Période → revue → verrou → PRÉ-CLÔTURE → CLÔTURE (avertissements confirmés, tracés).
    await page2.click('a[href="#/time/periods"]');
    await page2.waitForSelector('form input[type="date"]');
    await page2.getByLabel('Libellé').fill('PAIE-2026-07');
    await page2.locator('form input[type="date"]').nth(0).fill('2026-07-01');
    await page2.locator('form input[type="date"]').nth(1).fill('2026-07-31');
    await page2.click('form button[type="submit"]');
    await page2.waitForSelector('tbody tr');
    await page2.click('button:has-text("Passer en revue")');
    await page2.waitForSelector('button:has-text("Verrouiller")');
    await page2.click('button:has-text("Verrouiller")');
    await page2.waitForFunction(() => (document.body.textContent ?? '').includes('Verrouillée'));
    await page2.click('button:has-text("Contrôle de pré-clôture")');
    await page2.waitForFunction(() => (document.body.textContent ?? '').includes('Salariés attendus'));
    const preBody = await page2.evaluate(() => document.body.textContent ?? '');
    assert.ok(preBody.includes('Demandes en attente'), 'le contrôle des demandes en attente est affiché');
    await page2.check('input[type="checkbox"]');
    await page2.click('button:has-text("Clôturer")');
    await page2.waitForFunction(() => (document.body.textContent ?? '').includes('Clôturée'));

    // 6. Préparation paie : variables TEMPS uniquement, empreinte vérifiée, export téléchargeable.
    await page2.click('a[href="#/time/payroll"]');
    await page2.waitForFunction(() => (document.body.textContent ?? '').includes('PW-0001'));
    const payBody = await page2.evaluate(() => document.body.textContent ?? '');
    for (const banned of ['FCFA', 'fcfa', 'XOF', 'salaire', 'Salaire']) {
      assert.ok(!payBody.includes(banned), `préparation paie SANS montant : « ${banned} » absent de l'écran`);
    }
    // Les DONNÉES (tableaux de variables et d'exports) ne portent aucun montant —
    // le texte d'aide, lui, a le droit de DIRE « aucun montant ».
    const tablesText = await page2.evaluate(() =>
      Array.from(document.querySelectorAll('table')).map((el) => el.textContent ?? '').join(' '));
    for (const banned of ['montant', 'Montant', 'FCFA', 'XOF']) {
      assert.ok(!tablesText.includes(banned), `variables de paie SANS montant : « ${banned} » absent des tableaux`);
    }
    assert.ok(payBody.includes('kora-presence-'), 'la version du moteur FIGÉE à la clôture est affichée');
    await page2.click('button:has-text("empreinte")');
    await page2.waitForFunction(() => (document.body.textContent ?? '').includes('Empreinte VÉRIFIÉE'));
    await page2.click('button:has-text("Exporter CSV")');
    await page2.waitForFunction(() => (document.body.textContent ?? '').includes('kora-paie-prep-1 · csv · r1'));

    // 7. Idempotence de l'export PROUVÉE par l'API : même contenu ⇒ RÉUTILISÉ, pas de révision fantôme.
    const periods = await call(adm, 'GET', '/time/periods');
    const periodId = periods.body.items.find((p) => p.label === 'PAIE-2026-07').id;
    const closes = await call(adm, 'GET', `/time/periods/${periodId}/closes`);
    assert.equal(closes.body.items.length, 1);
    const closeId = closes.body.items[0].id;
    const again = await call(adm, 'POST', `/time/closes/${closeId}/exports`, { format: 'csv' });
    assert.ok(again.status === 200 || again.status === 201, JSON.stringify(again.body));
    assert.equal(again.body.reused, true, 'même contenu ⇒ export RÉUTILISÉ');
    assert.equal(again.body.export.revision, 1);
    const exports = await call(adm, 'GET', `/time/closes/${closeId}/exports`);
    const dl = await call(adm, 'GET', `/time/payroll-exports/${exports.body.items[0].id}/download`);
    assert.equal(dl.status, 200);
    const csv = Buffer.from(dl.body.contentBase64, 'base64').toString('utf8');
    assert.ok(csv.includes('matricule'), 'l’export contient les variables préparatoires');
    for (const banned of ['salaire', 'montant', 'fcfa', 'taux_horaire']) {
      assert.ok(!csv.toLowerCase().includes(banned), `export paie SANS montant : « ${banned} » absent du fichier`);
    }

    // 8. HORS LIGNE : AUCUNE donnée de correction, clôture ou paie ne survit.
    await ctx2.setOffline(true);
    await page2.reload({ waitUntil: 'domcontentloaded' });
    await page2.waitForSelector('#app');
    const report = await storageReport(page2);
    assert.deepEqual(report.cacheApiEntries, [], 'AUCUNE réponse /api en Cache Storage');
    assert.deepEqual(report.sessionStorageKeys, [], 'sessionStorage vide');
    assert.ok(!report.bodyText.includes('PAIE-2026-07'), 'aucune période lisible hors ligne');
    assert.ok(!report.bodyText.includes('PW-0001'), 'aucune variable de paie lisible hors ligne');
    const offline = await page2.evaluate(async () => {
      try {
        const r = await fetch('/api/v1/time/corrections');
        return `status:${r.status}`;
      } catch {
        return 'network-error';
      }
    });
    assert.equal(offline, 'network-error', 'les corrections ne répondent JAMAIS depuis un cache');
    await ctx2.setOffline(false);
  });
  await ctx2.close();
});

test('TEMPS (E10.3) : RBAC — sans permission, ni menus, ni écrans, ni API (corrections, périodes, paie)', { skip: !RUNNABLE }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await shot(page, 'e103-rbac', async () => {
    await login(page, viewerEmail); // employees.view SEUL
    for (const href of ['#/time/requests-mine', '#/time/requests', '#/time/periods', '#/time/payroll']) {
      const has = await page.evaluate((s) => document.querySelector(`a[href="${s}"]`) !== null, href);
      assert.equal(has, false, `menu ${href} absent sans permission`);
    }
    await page.goto(`${BASE}/#/time/periods`);
    await page.waitForFunction(() =>
      (document.body.textContent ?? '').includes('Accès refusé')
      || (document.body.textContent ?? '').includes('Access denied'));
    // Le MASQUAGE n'est pas la sécurité : les appels directs sont refusés par le SERVEUR.
    const statuses = await page.evaluate(async () => ({
      corrections: (await fetch('/api/v1/time/corrections')).status,
      mine: (await fetch('/api/v1/time/corrections/mine')).status,
      periods: (await fetch('/api/v1/time/periods')).status,
    }));
    assert.equal(statuses.corrections, 403, 'file des demandes : 403 sans permission');
    assert.equal(statuses.mine, 403, 'demandes « pour soi » : 403 sans time.correction_request_self');
    assert.equal(statuses.periods, 403, 'périodes : 403 sans permission');
  });
  await ctx.close();
});

test('CONGÉS (E11.1) : acquisition IDEMPOTENTE par l’API, soldes/ledger/Mes soldes via l’UI, HORS LIGNE rien ne survit', { skip: !RUNNABLE }, async () => {
  const apiBase = `http://127.0.0.1:${API_PORT}/api/v1`;
  // Paramètre E4 ACTIF : rythme légal d'acquisition (fixture contresignée de test).
  psql(`INSERT INTO compliance.legal_parameters
          (tenant_id, country_code, key, value, effective_from, status, is_legal_sensitive, confidence, source_text, verified_by, verified_at)
        VALUES ('${tenantId}', 'BJ', 'conges.acquisition.taux_mensuel', '2', '2020-01-01', 'active', false,
                'verified', 'fixture navigateur E11.1', 'fixture-pw', '2026-01-01')`);
  const login2 = await fetch(`${apiBase}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenantSlug: slug, email: leaveAdmEmail, password: P }),
  });
  const { token } = await login2.json();
  const call = async (method, path, body) => {
    const r = await fetch(`${apiBase}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : {} };
  };
  // Référentiel : type CAP + politique versionnée dont le rythme est la CLÉ E4.
  const ty = await call('POST', '/leave/types', {
    code: 'CAP', labelFr: 'Congé annuel payé', labelEn: 'Paid annual leave',
    category: 'legal', paid: true, unit: 'open_days',
  });
  assert.equal(ty.status, 201, JSON.stringify(ty.body));
  assert.equal((await call('POST', `/leave/types/${ty.body.id}`, { status: 'active' })).status, 200);
  const pol = await call('POST', '/leave/policies', {
    absenceTypeId: ty.body.id, code: 'POL-CAP', labelFr: 'Politique CAP', labelEn: 'CAP policy', countryCode: 'BJ',
  });
  assert.equal(pol.status, 201, JSON.stringify(pol.body));
  assert.equal((await call('POST', `/leave/policies/${pol.body.id}/versions`, {
    effectiveFrom: '2025-01-01', accrualMode: 'monthly',
    accrualRateParam: 'conges.acquisition.taux_mensuel', rounding: 'half_up_0_5',
  })).status, 201);
  assert.equal((await call('POST', `/leave/policies/${pol.body.id}/status`, { status: 'active' })).status, 200);
  // Acquisition T1 pour PW-0001 : 3 mouvements ; RELANCE : zéro écriture (clés UNIQUES en base).
  const run1 = await call('POST', '/leave/accrual/run', {
    periodStart: '2026-01-01', periodEnd: '2026-03-31', scopeKind: 'employee', scopeId: hr.e1, reason: 'acquisition T1 (navigateur)',
  });
  assert.equal(run1.status, 201, JSON.stringify(run1.body));
  assert.equal(run1.body.run.entriesWritten, 3, 'janvier, février, mars');
  const run2 = await call('POST', '/leave/accrual/run', {
    periodStart: '2026-01-01', periodEnd: '2026-03-31', scopeKind: 'employee', scopeId: hr.e1, reason: 'relance idempotente (navigateur)',
  });
  assert.equal(run2.body.run.entriesWritten, 0, 'rejouer n’écrit RIEN');
  assert.equal(run2.body.run.entriesSkipped, 3);

  // 1. Administration : soldes + ledger + exécutions via l'UI.
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await shot(page, 'conges-admin', async () => {
    await login(page, leaveAdmEmail);
    // Les attentes visent un TEXTE propre à la page cible : un sélecteur générique
    // (tbody tr) serait satisfait par le tableau de la page PRÉCÉDENTE pendant que
    // le routeur bascule (course constatée au run CI 30820501899).
    await page.click('a[href="#/leave/balances"]');
    await page.waitForFunction(() => (document.body.textContent ?? '').includes('PW-0001'));
    let body = await page.evaluate(() => document.body.textContent ?? '');
    assert.ok(body.includes('6 Jours ouvrés'), 'disponible = somme des mouvements (3 × 2 j)');
    assert.ok(body.includes('Moteur d’acquisition'), 'le ledger append-only est visible (origine des mouvements)');
    await page.click('a[href="#/leave/runs"]');
    await page.waitForFunction(() => (document.body.textContent ?? '').includes('relance idempotente (navigateur)'));
    body = await page.evaluate(() => document.body.textContent ?? '');
    assert.ok(body.includes('acquisition T1 (navigateur)'), 'l’historique des exécutions est complet');
    await page.click('a[href="#/leave/catalog"]');
    await page.waitForFunction(() => (document.body.textContent ?? '').includes('POL-CAP'));
    body = await page.evaluate(() => document.body.textContent ?? '');
    assert.ok(body.includes('conges.acquisition.taux_mensuel'), 'le rythme AFFICHE sa clé E4 — aucun défaut du moteur');
  });
  await ctx.close();

  // 2. ESS : « Mes soldes » + PROJECTION conditionnelle ; HORS LIGNE, rien ne survit.
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page2 = await ctx2.newPage();
  await shot(page2, 'conges-ess', async () => {
    await login(page2, essEmail);
    await page2.click('a[href="#/leave/mine"]');
    await page2.waitForSelector('tbody tr');
    let body2 = await page2.evaluate(() => document.body.textContent ?? '');
    assert.ok(body2.includes('Congé annuel payé'), 'mes soldes affichent le type');
    // Projection au 31 décembre : disponible + acquisitions futures, clairement qualifiée.
    await page2.click('button:has-text("Projeter")');
    await page2.waitForFunction(() => (document.body.textContent ?? '').includes('Projection conditionnelle'));
    body2 = await page2.evaluate(() => document.body.textContent ?? '');
    assert.ok(body2.includes('Projeté au'), 'le solde projeté est DISTINGUÉ du disponible');
    // HORS LIGNE : aucune donnée individuelle de congé ne survit.
    await ctx2.setOffline(true);
    await page2.reload({ waitUntil: 'domcontentloaded' });
    await page2.waitForSelector('#app');
    const report = await storageReport(page2);
    assert.deepEqual(report.cacheApiEntries, [], 'AUCUNE réponse /api en Cache Storage');
    assert.deepEqual(report.sessionStorageKeys, [], 'sessionStorage vide');
    assert.ok(!report.bodyText.includes('Congé annuel payé'), 'aucun solde lisible hors ligne');
    assert.ok(!report.bodyText.includes('PW-0001'), 'aucun matricule lisible hors ligne');
    const offline = await page2.evaluate(async () => {
      try {
        const r = await fetch('/api/v1/leave/balances/mine');
        return `status:${r.status}`;
      } catch {
        return 'network-error';
      }
    });
    assert.equal(offline, 'network-error', 'les soldes ne répondent JAMAIS depuis un cache');
    await ctx2.setOffline(false);
  });
  await ctx2.close();
});

test('CONGÉS (E11.1) : RBAC — sans permission, ni menus, ni écrans, ni API', { skip: !RUNNABLE }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await shot(page, 'conges-rbac', async () => {
    await login(page, viewerEmail); // employees.view SEUL
    for (const href of ['#/leave/mine', '#/leave/balances', '#/leave/catalog', '#/leave/runs']) {
      const has = await page.evaluate((s) => document.querySelector(`a[href="${s}"]`) !== null, href);
      assert.equal(has, false, `menu ${href} absent sans permission`);
    }
    await page.goto(`${BASE}/#/leave/balances`);
    await page.waitForFunction(() =>
      (document.body.textContent ?? '').includes('Accès refusé')
      || (document.body.textContent ?? '').includes('Access denied'));
    // Le MASQUAGE n'est pas la sécurité : le serveur refuse les appels directs.
    const statuses = await page.evaluate(async () => ({
      balances: (await fetch('/api/v1/leave/balances')).status,
      mine: (await fetch('/api/v1/leave/balances/mine')).status,
      types: (await fetch('/api/v1/leave/types')).status,
      ledger: (await fetch('/api/v1/leave/ledger')).status,
    }));
    assert.equal(statuses.balances, 403, 'soldes : 403 sans permission');
    assert.equal(statuses.mine, 403, 'mes soldes : 403 sans leave.balance_view_own');
    assert.equal(statuses.types, 403, 'référentiel : 403 sans permission congés');
    assert.equal(statuses.ledger, 403, 'ledger : 403 sans permission');
  });
  await ctx.close();
});

test('CONGÉS (E11.2) : demande ESS de bout en bout — prévisualisation serveur, circuit manager→RH, application, calendrier, HORS LIGNE rien ne survit', { skip: !RUNNABLE }, async () => {
  const apiBase = `http://127.0.0.1:${API_PORT}/api/v1`;
  const login2 = await fetch(`${apiBase}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenantSlug: slug, email: leaveAdmEmail, password: P }),
  });
  const { token } = await login2.json();
  const call = async (method, path, body) => {
    const r = await fetch(`${apiBase}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : {} };
  };
  // Horaire E10 du demandeur : lun–ven 08h–17h (pause 12–13) — le décompte est RÉEL.
  const model = await call('POST', '/time/schedules/models', { code: 'PW-LR-J', labelFr: 'Jour LR', labelEn: 'LR Day', kind: 'fixed' });
  assert.equal(model.status, 201, JSON.stringify(model.body));
  assert.equal((await call('POST', `/time/schedules/models/${model.body.id}/versions`, {
    effectiveFrom: '2025-01-06', cycleDays: 7,
    days: [0, 1, 2, 3, 4].map((i) => ({ dayIndex: i, isRest: false, startMinute: 480, endMinute: 1020, breakStartMinute: 720, breakEndMinute: 780 }))
      .concat([{ dayIndex: 5, isRest: true }, { dayIndex: 6, isRest: true }]),
  })).status, 201);
  assert.equal((await call('POST', '/time/schedules/assignments', {
    employeeId: hr.e3, modelId: model.body.id, anchorDate: '2026-01-05', effectiveFrom: '2025-01-06',
  })).status, 201);
  // Type + politique (valeur tenant 2 j/mois) + droits janvier–juin = 12 j.
  const ty = await call('POST', '/leave/types', {
    code: 'REQ', labelFr: 'Congé de demande', labelEn: 'Request leave', category: 'internal', paid: true, unit: 'open_days',
  });
  assert.equal(ty.status, 201, JSON.stringify(ty.body));
  assert.equal((await call('POST', `/leave/types/${ty.body.id}`, { status: 'active' })).status, 200);
  const pol = await call('POST', '/leave/policies', {
    absenceTypeId: ty.body.id, code: 'POL-REQ', labelFr: 'Politique REQ', labelEn: 'REQ policy',
  });
  assert.equal((await call('POST', `/leave/policies/${pol.body.id}/versions`, {
    effectiveFrom: '2025-01-01', accrualMode: 'monthly', accrualRateValue: 2,
  })).status, 201);
  assert.equal((await call('POST', `/leave/policies/${pol.body.id}/status`, { status: 'active' })).status, 200);
  const run = await call('POST', '/leave/accrual/run', {
    periodStart: '2026-01-01', periodEnd: '2026-06-30', scopeKind: 'employee', scopeId: hr.e3, reason: 'droits E11.2 (navigateur)',
  });
  assert.equal(run.status, 201, JSON.stringify(run.body));
  // Circuit : manager (conditionnel) → RH congés. Séparation des tâches par DÉFAUT.
  const def = await call('POST', '/workflow/definitions', {
    key: 'conges_demande', name: 'Demande de congés PW',
    steps: [
      { index: 0, name: 'Manager', approverType: 'manager', condition: { field: 'hasManager', op: 'eq', value: true } },
      { index: 1, name: 'RH congés', approverType: 'role', approverRef: 'pw-rh-conges' },
    ],
  });
  assert.equal(def.status, 201, JSON.stringify(def.body));
  assert.equal((await call('POST', `/workflow/definitions/${def.body.id}/activate`)).status, 200);

  // 1. ESS : brouillon → PRÉVISUALISATION serveur → soumission (réservation posée).
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await shot(page, 'lr-ess', async () => {
    await login(page, lrEssEmail);
    await page.click('a[href="#/leave/requests/new"]');
    await page.waitForFunction(() => (document.body.textContent ?? '').includes('Nouvelle demande d’absence'));
    await page.selectOption('select', { label: 'REQ — Congé de demande' });
    await page.locator('input[type="date"]').nth(0).fill('2026-09-07');
    await page.locator('input[type="date"]').nth(1).fill('2026-09-11');
    await page.click('button:has-text("Enregistrer le brouillon")');
    // La prévisualisation est calculée CÔTÉ SERVEUR : décompte E10 + solde avant/après.
    await page.waitForFunction(() => (document.body.textContent ?? '').includes('Décompte jour par jour'));
    const body = await page.evaluate(() => document.body.textContent ?? '');
    assert.ok(body.includes('5 Jours ouvrés'), 'lun–ven planifiés = 5 jours ouvrés décomptés');
    assert.ok(body.includes('conges_demande'), 'le circuit se montre AVANT la soumission');
    assert.ok(body.includes('Projection conditionnelle'), 'le projeté est qualifié, jamais confondu avec un droit');
    await page.click('button:has-text("Soumettre")');
    await page.waitForFunction(() => (document.body.textContent ?? '').includes('Mes demandes')
      && (document.body.textContent ?? '').includes('Soumise'));
  });
  // La RÉSERVATION est un mouvement append-only lié à la demande — la base fait foi.
  const reqId = psql(`SELECT id FROM leave.requests WHERE tenant_id = '${tenantId}' AND employee_id = '${hr.e3}'`);
  assert.equal(psql(`SELECT count(*) FROM leave.entitlement_ledger
    WHERE tenant_id = '${tenantId}' AND request_id = '${reqId}' AND entry_kind = 'reservation'`), '1');

  // 2. Manager : file d'équipe, avant/après, approbation (étape 0).
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page2 = await ctx2.newPage();
  await shot(page2, 'lr-mgr', async () => {
    await login(page2, lrMgrEmail);
    await page2.click('a[href="#/leave/requests/team"]');
    await page2.waitForFunction(() => (document.body.textContent ?? '').includes('PW-0003'));
    await page2.click('button:has-text("Détails")');
    await page2.waitForFunction(() => (document.body.textContent ?? '').includes('Solde avant / après'));
    const b2 = await page2.evaluate(() => document.body.textContent ?? '');
    assert.ok(b2.includes('12 → 7'), `avant/après : 12 → 7 (reçu : ${b2.slice(0, 400)})`);
    await page2.click('button:has-text("Approuver")');
    await page2.waitForFunction(() => (document.body.textContent ?? '').includes('En instruction'));
  });
  await ctx2.close();

  // 3. RH : file globale, approbation FINALE (application immédiate), calendrier TYPÉ.
  const ctx3 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page3 = await ctx3.newPage();
  await shot(page3, 'lr-rh', async () => {
    await login(page3, lrRhEmail);
    await page3.click('a[href="#/leave/requests/queue"]');
    await page3.waitForFunction(() => (document.body.textContent ?? '').includes('PW-0003'));
    await page3.click('button:has-text("Détails")');
    await page3.waitForFunction(() => (document.body.textContent ?? '').includes('Solde avant / après'));
    await page3.click('button:has-text("Approuver")');
    await page3.waitForFunction(() => (document.body.textContent ?? '').includes('Appliquée'));
    // Calendrier d'équipe : l'absence APPROUVÉE apparaît, typée pour la RH autorisée.
    await page3.click('a[href="#/leave/calendar"]');
    // Attente PAR STRUCTURE propre à la page cible (deux champs de dates) — le titre
    // apparaît aussi dans la navigation (course d'affichage, leçon run 30820501899).
    await page3.waitForFunction(() => document.querySelectorAll('input[type="date"]').length >= 2);
    await page3.locator('input[type="date"]').nth(0).fill('2026-09-01');
    await page3.locator('input[type="date"]').nth(1).fill('2026-09-30');
    await page3.click('button:has-text("Afficher")');
    await page3.waitForFunction(() => (document.body.textContent ?? '').includes('PW-0003')
      && (document.body.textContent ?? '').includes('REQ'));
  });
  await ctx3.close();
  // Application : UNE consommation + UNE libération, l'absence est opposable, impact présence DIFFÉRÉ.
  assert.equal(psql(`SELECT count(*) FROM leave.entitlement_ledger
    WHERE tenant_id = '${tenantId}' AND request_id = '${reqId}' AND entry_kind = 'consumption'`), '1');
  assert.equal(psql(`SELECT count(*) FROM leave.entitlement_ledger
    WHERE tenant_id = '${tenantId}' AND request_id = '${reqId}' AND entry_kind = 'release'`), '1');
  assert.equal(psql(`SELECT status || '|' || presence_impact FROM leave.absences
    WHERE tenant_id = '${tenantId}' AND request_id = '${reqId}'`), 'approved|deferred');

  // 4. HORS LIGNE (contexte ESS conservé) : AUCUNE demande ni donnée individuelle ne survit.
  await shot(page, 'lr-offline', async () => {
    await ctx.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#app');
    const report = await storageReport(page);
    assert.deepEqual(report.cacheApiEntries, [], 'AUCUNE réponse /api en Cache Storage');
    assert.ok(!report.bodyText.includes('Congé de demande'), 'aucun intitulé de demande hors ligne');
    assert.ok(!report.bodyText.includes('PW-0003'), 'aucun matricule hors ligne');
    const offline = await page.evaluate(async () => {
      try {
        const r = await fetch('/api/v1/leave/requests/mine');
        return `status:${r.status}`;
      } catch {
        return 'network-error';
      }
    });
    assert.equal(offline, 'network-error', 'les demandes ne répondent JAMAIS depuis un cache');
    await ctx.setOffline(false);
  });
  await ctx.close();
});

test('CONGÉS (E11.2) : RBAC — sans permission, ni menus de demandes, ni API (le serveur tranche)', { skip: !RUNNABLE }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await shot(page, 'lr-rbac', async () => {
    await login(page, viewerEmail); // employees.view SEUL
    for (const href of ['#/leave/requests/new', '#/leave/requests/mine', '#/leave/requests/team', '#/leave/requests/queue', '#/leave/calendar']) {
      const has = await page.evaluate((s) => document.querySelector(`a[href="${s}"]`) !== null, href);
      assert.equal(has, false, `menu ${href} absent sans permission`);
    }
    await page.goto(`${BASE}/#/leave/requests/queue`);
    await page.waitForFunction(() =>
      (document.body.textContent ?? '').includes('Accès refusé')
      || (document.body.textContent ?? '').includes('Access denied'));
    // Le masquage n'est PAS la sécurité : refus serveur sur chaque route.
    const statuses = await page.evaluate(async () => ({
      create: (await fetch('/api/v1/leave/requests', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ typeId: '00000000-0000-0000-0000-000000000001', startDate: '2026-09-07', endDate: '2026-09-08' }),
      })).status,
      mine: (await fetch('/api/v1/leave/requests/mine')).status,
      team: (await fetch('/api/v1/leave/requests/team')).status,
      queue: (await fetch('/api/v1/leave/requests/queue')).status,
      calendar: (await fetch('/api/v1/leave/calendar?from=2026-09-01&to=2026-09-05')).status,
    }));
    assert.ok([400, 403].includes(statuses.create), `création refusée (CSRF/permission), jamais 2xx : ${statuses.create}`);
    assert.equal(statuses.mine, 403, 'mes demandes : 403');
    assert.equal(statuses.team, 403, 'équipe : 403');
    assert.equal(statuses.queue, 403, 'file RH : 403');
    assert.equal(statuses.calendar, 403, 'calendrier : 403');
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
