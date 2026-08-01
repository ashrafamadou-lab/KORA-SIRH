/**
 * Composants UI (E7) sur faux DOM — accessibilité STATIQUE (labels associés, rôles,
 * en-têtes de colonnes, alternative mobile), anti double-soumission, masquage,
 * navigation par permissions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom, type FakeElement } from './helpers/fake-dom.ts';

installFakeDom(); // AVANT l'import des composants

const { h } = await import('../src/core/dom.ts');
const { setLocale, t } = await import('../src/core/i18n.ts');
const kit = await import('../src/ui/kit.ts');
const { visibleNav, allowed, NAV_MAP } = await import('../src/core/permissions.ts');
const { matchRoute, parseHash } = await import('../src/core/router.ts');

setLocale('fr');

test('dom.h : le texte passe en nœud TEXTE — jamais interprété comme HTML', () => {
  const el = h('div', {}, '<img src=x onerror=alert(1)>') as unknown as FakeElement;
  assert.equal(el.children.length, 1);
  assert.equal((el.children[0] as { nodeType: number }).nodeType, 3, 'nœud texte');
  assert.equal(el.text, '<img src=x onerror=alert(1)>', 'le balisage reste inerte');
});

test('champ de formulaire : label TOUJOURS associé (for/id), erreur en rôle alert', () => {
  const f = kit.field('login.email', { type: 'email', required: true });
  const wrap = f.wrap as unknown as FakeElement;
  const label = wrap.querySelector('label')!;
  const input = wrap.querySelector('input')!;
  assert.equal(label.getAttribute('for'), input.getAttribute('id'), 'label lié au champ');
  assert.equal(label.text, t('login.email'));
  f.setError('problème');
  const alert = wrap.querySelector('[role="alert"]')!;
  assert.equal(alert.text, 'problème');
});

test('bouton : une action asynchrone DÉSACTIVE le déclencheur (anti double-soumission)', async () => {
  let calls = 0;
  let release: () => void = () => { /* posé ci-dessous */ };
  const pending = new Promise<void>((r) => { release = r; });
  const btn = kit.button('OK', async () => { calls += 1; await pending; }) as unknown as FakeElement & { disabled: boolean };
  btn.dispatch('click');
  assert.equal(btn.disabled, true, 'désactivé pendant l’action');
  btn.dispatch('click');
  btn.dispatch('click');
  release();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls, 1, 'un seul déclenchement malgré trois clics');
  assert.equal(btn.disabled, false, 'réactivé après coup');
});

test('badge de statut : le TEXTE porte l’information (jamais la couleur seule)', () => {
  const b = kit.statusBadge('terminated', t('emp.status.terminated')) as unknown as FakeElement;
  assert.equal(b.text, 'Sorti');
  assert.equal(b.getAttribute('data-status'), 'terminated', 'le code métier reste inaltéré');
});

test('tableau : en-têtes scope=col, cellules data-label (alternative cartes mobile), clavier', () => {
  interface Row { a: string; b: string }
  const table = kit.dataTable<Row>({
    columns: [
      { key: 'a', labelKey: 'emp.matricule', render: (r) => r.a },
      { key: 'b', labelKey: 'emp.name', render: (r) => r.b },
    ],
    rows: [{ a: 'M-1', b: 'Awa' }, { a: 'M-2', b: 'Bio' }],
    onRowClick: () => { /* navigable */ },
  }) as unknown as FakeElement;
  const ths = table.querySelectorAll('th');
  assert.equal(ths.length, 2);
  for (const th of ths) assert.equal(th.getAttribute('scope'), 'col');
  const tds = table.querySelectorAll('td');
  assert.equal(tds[0]!.getAttribute('data-label'), t('emp.matricule'), 'libellé porté par la cellule (vue mobile)');
  const rows = table.querySelectorAll('tr').filter((r) => r.getAttribute('tabindex') === '0');
  assert.equal(rows.length, 2, 'lignes cliquables focusables au clavier');
});

test('états : interdit/hors-ligne/introuvable rendus avec titre et explication traduits', () => {
  setLocale('en');
  const forbidden = kit.states.forbidden() as unknown as FakeElement;
  assert.ok(forbidden.text.includes('Access denied'));
  assert.ok(forbidden.text.includes('server'), 'l’explication rappelle le contrôle serveur');
  setLocale('fr');
  const offline = kit.states.offline() as unknown as FakeElement;
  assert.ok(offline.text.includes('Hors connexion'));
  assert.ok(offline.text.includes('aucune donnée RH'), 'le message assume la protection hors-ligne');
});

test('stateForError : chaque erreur API a un écran dédié (409, 423, 429, 503)', () => {
  const conflict = kit.stateForError({ kind: 'conflict' }) as unknown as FakeElement;
  assert.ok(conflict.text.includes(t('state.conflict')));
  const locked = kit.stateForError({ kind: 'locked', retryAfterSeconds: 30 }) as unknown as FakeElement;
  assert.ok(locked.text.includes(t('state.locked')));
  const rate = kit.stateForError({ kind: 'rate_limited', retryAfterSeconds: 12 }) as unknown as FakeElement;
  assert.ok(rate.text.includes('12'), 'le délai Retry-After est montré');
  const unavailable = kit.stateForError({ kind: 'unavailable' }) as unknown as FakeElement;
  assert.ok(unavailable.text.includes(t('state.unavailable')));
});

test('masquage d’affichage : valeur absente ⇒ ••• avec explication, jamais de reconstruction', () => {
  const masked = kit.maskedValue(null) as unknown as FakeElement;
  assert.equal(masked.text, '•••');
  assert.equal(masked.getAttribute('title'), t('app.maskedHint'));
  const clear = kit.maskedValue('BJ') as unknown as FakeElement;
  assert.equal(clear.text, 'BJ');
});

test('garde par permission : rendu conditionnel pur (le serveur reste juge)', () => {
  let rendered = 0;
  kit.permissionGuard(false, () => { rendered += 1; return null; });
  assert.equal(rendered, 0);
  kit.permissionGuard(true, () => { rendered += 1; return null; });
  assert.equal(rendered, 1);
});

test('navigation par permissions : sections vides retirées, familles audit.view_* reconnues', () => {
  const none = visibleNav([]);
  assert.ok(none.every((s) => s.items.every((i) => i.anyOf.length === 0)), 'sans permission : uniquement les entrées libres');
  const hr = visibleNav(['employees.view']);
  assert.ok(hr.some((s) => s.items.some((i) => i.route === '/employees')));
  assert.ok(!hr.some((s) => s.items.some((i) => i.route === '/admin/users')), 'pas d’admin sans users.view');
  const auditOwn = NAV_MAP.flatMap((s) => s.items).find((i) => i.route === '/audit')!;
  assert.equal(allowed(auditOwn, ['audit.view_own']), true, 'audit.view_own ouvre la consultation bornée');
  assert.equal(allowed(auditOwn, ['workflow.view']), false);
});

test('routeur : correspondances, paramètres décodés, requête analysée', () => {
  const defs = [
    { pattern: '/employees', render: () => null as never },
    { pattern: '/employees/:id', render: () => null as never },
  ];
  const m = matchRoute(defs, '/employees/abc%20d');
  assert.equal(m!.def.pattern, '/employees/:id');
  assert.equal(m!.params['id'], 'abc d');
  assert.equal(matchRoute(defs, '/inconnu'), null);
  const parsed = parseHash('#/employees?status=active&page=2');
  assert.equal(parsed.path, '/employees');
  assert.equal(parsed.query.get('status'), 'active');
});
