import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  csvEscape,
  filtersDigest,
  isSecretKey,
  MASKED,
  maskAuditText,
  maskJsonDeep,
  parseAuditCursor,
  resolveAuditAccess,
  toCsv,
} from './audit-view.ts';

// ---------- Vues différenciées ----------

test('accès : audit.view = tout, view_<module> = liste, view_own = soi, sinon rien', () => {
  assert.deepEqual(resolveAuditAccess(['audit.view']), { all: true, modules: [], own: false, any: true });
  assert.deepEqual(resolveAuditAccess(['audit.view_notify', 'audit.view_auth', 'audit.view_notify']),
    { all: false, modules: ['notify', 'auth'], own: false, any: true });
  assert.deepEqual(resolveAuditAccess(['audit.view_own']), { all: false, modules: [], own: true, any: true });
  assert.deepEqual(resolveAuditAccess(['employees.view', 'workflow.act']),
    { all: false, modules: [], own: false, any: false });
  // Combinaison : modules + own s'additionnent.
  const combo = resolveAuditAccess(['audit.view_own', 'audit.view_admin_users']);
  assert.equal(combo.own, true);
  assert.deepEqual(combo.modules, ['admin_users']);
});

test('accès : view_own n’est PAS interprété comme un module, clés inconnues ignorées', () => {
  const a = resolveAuditAccess(['audit.view_own', 'audit.view_OWN', 'audit.view_', 'audit.export']);
  assert.deepEqual(a.modules, []);
  assert.equal(a.own, true);
});

// ---------- Masquage ----------

test('clés secrètes détectées (hash, token, mfa, mot de passe…), clés métier épargnées', () => {
  for (const k of ['password_hash', 'token_hash', 'mfa_secret', 'mot_de_passe', 'api_key', 'authorization', 'cookie']) {
    assert.ok(isSecretKey(k), `${k} doit être masqué`);
  }
  // E9 : identifiants personnels du dossier salarié — masqués aussi en consultation,
  // sous leurs DEUX graphies (snake_case en base, camelCase dans les objets audités).
  for (const k of ['cnss_number', 'cnssNumber', 'tax_id', 'taxId', 'ifu', 'id_document_number', 'idDocumentNumber',
    'iban', 'bank_account', 'emergency_phone', 'emergencyPhone', 'emergency_name']) {
    assert.ok(isSecretKey(k), `${k} (identifiant personnel) doit être masqué`);
  }
  for (const k of ['key', 'status', 'email', 'salaire_base', 'effective_from', 'matricule', 'id_document_type', 'idDocumentType', 'nationality']) {
    assert.ok(!isSecretKey(k), `${k} ne doit pas être masqué d'office`);
  }
});

test('maskJsonDeep : clé secrète ⇒ ‹masqué›, feuille texte scrubée, structure préservée', () => {
  const masked = maskJsonDeep({
    email: 'a@b.bj',
    password_hash: '$argon2id$v=19$m=65536',
    nested: { token: 'abc', note: 'jeton=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVPmB92K27uhb fin' },
    list: [{ mfa_secret: 'JBSWY3DPEHPK3PXP' }, 42, true],
    montant: 125000,
  }) as Record<string, unknown>;
  assert.equal(masked['email'], 'a@b.bj');
  assert.equal(masked['password_hash'], MASKED);
  const nested = masked['nested'] as Record<string, unknown>;
  assert.equal(nested['token'], MASKED);
  assert.ok(!(nested['note'] as string).includes('eyJ'), 'le JWT dans une feuille texte est scrubé');
  const list = masked['list'] as unknown[];
  assert.equal((list[0] as Record<string, unknown>)['mfa_secret'], MASKED);
  assert.equal(list[1], 42);
  assert.equal(masked['montant'], 125000);
});

test('maskJsonDeep : profondeur bornée, null conservé', () => {
  let deep: unknown = 'fond';
  for (let i = 0; i < 12; i++) deep = { d: deep };
  const out = JSON.stringify(maskJsonDeep(deep));
  assert.ok(out.includes(MASKED), 'au-delà de la profondeur maximale, tout est masqué');
  assert.equal(maskJsonDeep(null), null);
});

test('maskAuditText : hex 64 masqué, texte métier intact', () => {
  const s = maskAuditText('rotation clé a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90 ok');
  assert.ok(!s.includes('a1b2c3d4e5f607'), 'le blob hex est masqué');
  assert.ok(s.includes('rotation clé'), 'le contexte reste lisible');
});

// ---------- CSV ----------

test('csvEscape : RFC 4180 (guillemets, séparateurs, retours ligne) + anti-formule', () => {
  assert.equal(csvEscape('simple'), 'simple');
  assert.equal(csvEscape('a;b'), '"a;b"');
  assert.equal(csvEscape('dit "oui"'), '"dit ""oui"""');
  assert.equal(csvEscape('l1\nl2'), '"l1\nl2"');
  assert.equal(csvEscape(null), '');
  assert.equal(csvEscape(12.5), '12.5');
  // Injection de formule tableur neutralisée.
  assert.equal(csvEscape('=SUM(A1:A9)'), "'=SUM(A1:A9)");
  assert.equal(csvEscape('@cmd'), "'@cmd");
  assert.equal(csvEscape('+221'), "'+221");
});

test('toCsv : BOM UTF-8, en-tête, CRLF, objets JSON sérialisés', () => {
  const doc = toCsv(['id', 'action', 'detail'], [
    { id: 1, action: 'login', detail: { ip: 'x' } },
    { id: 2, action: 'a;b' },
  ]);
  assert.ok(doc.startsWith('﻿'), 'BOM présent');
  const lines = doc.slice(1).split('\r\n');
  assert.equal(lines[0], 'id;action;detail');
  assert.equal(lines[1], '1;login;"{""ip"":""x""}"');
  assert.equal(lines[2], '2;"a;b";');
  assert.equal(lines[3], '', 'CRLF final');
});

// ---------- Curseur ----------

test('curseur : absent = première page, id valide accepté, reste refusé', () => {
  assert.deepEqual(parseAuditCursor(undefined), { ok: true, id: null });
  assert.deepEqual(parseAuditCursor(''), { ok: true, id: null });
  assert.deepEqual(parseAuditCursor('12345'), { ok: true, id: 12345 });
  assert.deepEqual(parseAuditCursor('0'), { ok: false });
  assert.deepEqual(parseAuditCursor('-3'), { ok: false });
  assert.deepEqual(parseAuditCursor('abc'), { ok: false });
  assert.deepEqual(parseAuditCursor('1e5'), { ok: false });
  assert.deepEqual(parseAuditCursor('99999999999999999999'), { ok: false }, 'hors zone sûre');
});

// ---------- Empreinte de filtres ----------

test('filtersDigest : compact, ignore les vides, tronque les valeurs longues', () => {
  const d = filtersDigest({ module: 'auth', action: '', from: undefined, actor: 'x'.repeat(60) });
  assert.ok(d.startsWith('module=auth;actor='));
  assert.ok(d.length <= 200);
  assert.ok(d.includes('…'));
});
