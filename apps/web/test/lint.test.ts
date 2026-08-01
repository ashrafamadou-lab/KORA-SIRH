/**
 * Lint maison (E7) — motifs INTERDITS dans apps/web/src, appliqués par la CI :
 *  - innerHTML / outerHTML / insertAdjacentHTML / document.write : rendu HTML non
 *    contrôlé interdit (anti-XSS, CSP) ;
 *  - localStorage : réservé au SEUL miroir de langue (core/i18n.ts) — jamais un jeton,
 *    jamais une donnée RH ; sessionStorage : réservé au SEUL module de session ;
 *  - eval / new Function : interdits (CSP) ;
 *  - console.* dans src : interdit (aucune donnée ne part en console) ;
 *  - chaînes accentuées hors src/i18n : les libellés visibles vivent dans les
 *    dictionnaires (aucun texte français codé en dur dans les composants).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const files = walk(SRC).map((f) => ({
  path: relative(SRC, f).split('\\').join('/'),
  code: readFileSync(f, 'utf8'),
}));

test('aucun rendu HTML non contrôlé (innerHTML & co interdits partout dans src)', () => {
  for (const f of files) {
    const code = stripComments(f.code);
    for (const pattern of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write(']) {
      assert.ok(!code.includes(pattern), `${f.path} contient ${pattern}`);
    }
  }
});

test('stockages : AUCUN jeton côté client — localStorage limité au miroir de langue, sessionStorage/indexedDB interdits', () => {
  for (const f of files) {
    const code = stripComments(f.code);
    if (code.includes('localStorage')) {
      assert.equal(f.path, 'core/i18n.ts', `${f.path} touche localStorage (réservé au miroir de langue)`);
    }
    // Clôture Phase 1 : le jeton vit dans un cookie HttpOnly côté serveur — plus
    // AUCUN module client n'a le droit de toucher sessionStorage.
    assert.ok(!code.includes('sessionStorage'), `${f.path} touche sessionStorage (interdit — cookie HttpOnly)`);
    assert.ok(!code.includes('indexedDB'), `${f.path} touche indexedDB (interdit)`);
    assert.ok(!/document\.cookie/.test(code), `${f.path} touche document.cookie (interdit — le cookie de session est HttpOnly, le CSRF vient de l'API)`);
    assert.ok(!code.includes('kora.session'), `${f.path} référence l'ancien stockage de jeton`);
    assert.ok(!/authorization.*Bearer|Bearer \$\{/i.test(code), `${f.path} manipule un jeton Bearer côté navigateur`);
  }
});

test('ni eval, ni new Function, ni console.* dans les sources applicatives', () => {
  for (const f of files) {
    const code = stripComments(f.code);
    assert.ok(!/\beval\s*\(/.test(code), `${f.path} utilise eval`);
    assert.ok(!/new\s+Function\s*\(/.test(code), `${f.path} utilise new Function`);
    assert.ok(!/\bconsole\.\w+\(/.test(code), `${f.path} écrit en console (fuite potentielle)`);
  }
});

test('aucune chaîne visible codée en dur : accents interdits dans les LITTÉRAUX hors i18n', () => {
  for (const f of files) {
    if (f.path.startsWith('i18n/')) continue;
    const code = stripComments(f.code);
    const literals = [...code.matchAll(/'([^'\\]|\\.)*'|"([^"\\]|\\.)*"|`([^`\\]|\\.)*`/g)].map((m) => m[0]);
    for (const lit of literals) {
      assert.ok(!/[àâäéèêëîïôöùûüçÀÂÄÉÈÊËÎÏÔÖÙÛÜÇ]/.test(lit),
        `${f.path} : libellé accentué en dur ${lit.slice(0, 40)}… — utiliser t()`);
    }
  }
});

test('les secrets n’ont aucun point d’ancrage : mots-clés interdits dans src', () => {
  for (const f of files) {
    const code = stripComments(f.code).toLowerCase();
    for (const banned of ['password_hash', 'mfa_secret', 'recoverycodes.join', 'document.title = ']) {
      assert.ok(!code.includes(banned), `${f.path} contient ${banned}`);
    }
  }
});
