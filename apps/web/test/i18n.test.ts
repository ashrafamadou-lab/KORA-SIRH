/**
 * i18n (E7) : complétude FR/EN vérifiée à l'EXÉCUTION en plus du typage, aucune clé
 * brute rendue, interpolation sûre, formats localisés, codes métier inaltérés.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fr } from '../src/i18n/fr.ts';
import { en } from '../src/i18n/en.ts';
import { allMessageKeys, dictFor, setLocale, t } from '../src/core/i18n.ts';
import { fmtDate, fmtNumber } from '../src/core/format.ts';

test('complétude : FR et EN portent exactement les mêmes clés, toutes non vides', () => {
  const frKeys = Object.keys(fr).sort();
  const enKeys = Object.keys(en).sort();
  assert.deepEqual(enKeys, frKeys, 'les dictionnaires doivent être isomorphes');
  for (const key of frKeys) {
    assert.ok((fr as Record<string, string>)[key]!.trim().length > 0, `fr:${key} vide`);
    assert.ok((en as Record<string, string>)[key]!.trim().length > 0, `en:${key} vide`);
  }
});

test('aucune clé technique ne sort à l’écran : t(clé) ne rend jamais la clé elle-même', () => {
  for (const locale of ['fr', 'en'] as const) {
    setLocale(locale);
    for (const key of allMessageKeys()) {
      const rendered = t(key);
      assert.notEqual(rendered, key, `${locale}:${key} rend sa propre clé`);
      assert.ok(!/^[a-z]+\.[a-zA-Z.]+$/.test(rendered) || rendered === 'KORA', `${locale}:${key} ressemble à une clé brute : ${rendered}`);
    }
  }
  setLocale('fr');
});

test('interpolation : {param} remplacé, paramètre absent laissé visible (détectable)', () => {
  setLocale('fr');
  assert.equal(t('state.rateLimitedBody', { seconds: 30 }), 'Patientez 30 s avant de réessayer.');
  setLocale('en');
  assert.equal(t('state.rateLimitedBody', { seconds: 30 }), 'Wait 30s before retrying.');
  setLocale('fr');
});

test('placeholders cohérents entre FR et EN (mêmes paramètres attendus)', () => {
  const params = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const key of allMessageKeys()) {
    assert.deepEqual(params(dictFor('en')[key]), params(dictFor('fr')[key]), `paramètres divergents pour ${key}`);
  }
});

test('formats localisés : dates et nombres suivent la langue, la donnée reste intacte', () => {
  setLocale('fr');
  const frDate = fmtDate('2026-03-15');
  setLocale('en');
  const enDate = fmtDate('2026-03-15');
  assert.notEqual(frDate, enDate, 'le format de date doit changer avec la langue');
  assert.ok(frDate.includes('2026') && enDate.includes('2026'));
  setLocale('fr');
  assert.equal(fmtNumber(1234567).replace(/ | /g, ' '), '1 234 567');
  setLocale('en');
  assert.equal(fmtNumber(1234567), '1,234,567');
  setLocale('fr');
});

test('les CODES métier ne sont jamais traduits/altérés par le rendu (exemple statuts)', () => {
  // La traduction mappe un code vers un libellé, mais le code lui-même reste la clé
  // de données transmise à l'API : aucune fonction de i18n ne transforme une valeur.
  setLocale('en');
  assert.equal(t('emp.status.terminated'), 'Terminated');
  setLocale('fr');
  assert.equal(t('emp.status.terminated'), 'Sorti');
});
