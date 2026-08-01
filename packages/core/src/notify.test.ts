import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSafeVariables,
  backoffDelayMs,
  canTransitionDelivery,
  channelsFor,
  extractPlaceholders,
  looksLikeSecret,
  nextDeliveryStatus,
  pickLocale,
  renderTemplate,
  scrubText,
  validateTemplateContent,
  validateValues,
  type TemplateContent,
} from './notify.ts';

const TPL: TemplateContent = {
  variables: ['prenom', 'demande'],
  channels: ['in_app', 'email'],
  subjectFr: 'Demande {{demande}}',
  subjectEn: 'Request {{demande}}',
  bodyFr: 'Bonjour {{prenom}}, votre demande {{demande}} a été traitée.',
  bodyEn: 'Hello {{prenom}}, your request {{demande}} was processed.',
};

// ---------- Variables contrôlées ----------

test('placeholders : extraction distincte, espaces tolérés', () => {
  assert.deepEqual(extractPlaceholders('A {{x}} et {{ y }} puis {{x}}'), ['x', 'y']);
  assert.deepEqual(extractPlaceholders('sans variable'), []);
});

test('modèle valide accepté', () => {
  assert.deepEqual(validateTemplateContent(TPL), { ok: true });
});

test('modèle : placeholder hors liste déclarée refusé', () => {
  const bad = { ...TPL, bodyFr: 'Bonjour {{inconnu}}' };
  const r = validateTemplateContent(bad);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.issues.some((i) => i.includes('{{inconnu}}')));
});

test('modèle : nom de variable interdit (secret / médical) refusé', () => {
  for (const name of ['password', 'jeton_reset', 'mfa_code', 'api_key', 'diagnostic_medical', 'etat_sante']) {
    const r = validateTemplateContent({ ...TPL, variables: [...TPL.variables, name] });
    assert.equal(r.ok, false, `« ${name} » aurait dû être refusé`);
  }
});

test('modèle : in_app obligatoire dans les canaux', () => {
  const r = validateTemplateContent({ ...TPL, channels: ['email'] });
  assert.equal(r.ok, false);
});

test('modèle : un secret embarqué dans le corps est refusé', () => {
  const r = validateTemplateContent({ ...TPL, bodyFr: 'Votre code : a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4' });
  assert.equal(r.ok, false);
});

test('valeurs : inconnues ou manquantes rejetées avant envoi', () => {
  assert.deepEqual(validateValues(TPL.variables, { prenom: 'Awa', demande: 'C-12' }), { ok: true });
  const missing = validateValues(TPL.variables, { prenom: 'Awa' });
  assert.deepEqual(missing, { ok: false, missing: ['demande'], unknown: [] });
  const unknown = validateValues(TPL.variables, { prenom: 'Awa', demande: 'C-12', extra: 'x' });
  assert.deepEqual(unknown, { ok: false, missing: [], unknown: ['extra'] });
});

test('rendu : FR par défaut, EN sur demande, valeurs substituées', () => {
  const fr = renderTemplate(TPL, 'fr', { prenom: 'Awa', demande: 'C-12' });
  assert.deepEqual(fr, { ok: true, subject: 'Demande C-12', body: 'Bonjour Awa, votre demande C-12 a été traitée.' });
  const en = renderTemplate(TPL, 'en', { prenom: 'Awa', demande: 'C-12' });
  assert.equal(en.ok && en.subject, 'Request C-12');
  const bad = renderTemplate(TPL, 'fr', { prenom: 'Awa' });
  assert.equal(bad.ok, false);
});

test('pickLocale : en accepté, tout le reste retombe sur fr', () => {
  assert.equal(pickLocale('en'), 'en');
  assert.equal(pickLocale('fr'), 'fr');
  assert.equal(pickLocale('de'), 'fr');
  assert.equal(pickLocale(undefined), 'fr');
});

// ---------- Garde anti-secrets ----------

test('looksLikeSecret : JWT, Bearer, hex, base32, base64, clé privée détectés', () => {
  assert.ok(looksLikeSecret('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'));
  assert.ok(looksLikeSecret('Authorization: Bearer abc.def.ghi'));
  assert.ok(looksLikeSecret('a1b2c3d4e5f60718293a4b5c6d7e8f90'));
  assert.ok(looksLikeSecret('JBSWY3DPEHPK3PXPJBSWY3DP'));
  assert.ok(looksLikeSecret('QWxhZGRpbjpvcGVuIHNlc2FtZUFsYWRkaW46b3BlbiBzZXNhbWU='));
  assert.ok(looksLikeSecret('-----BEGIN PRIVATE KEY-----'));
});

test('looksLikeSecret : contenus RH légitimes non signalés', () => {
  assert.equal(looksLikeSecret('Votre demande de congés du 12/08 au 26/08 est approuvée.'), null);
  assert.equal(looksLikeSecret('3f6c1e0a-2b4d-4c8e-9f10-123456789abc'), null, 'un UUID est un identifiant, pas un secret');
  assert.equal(looksLikeSecret('RAPPEL IMPORTANT'), null, 'capitales sans chiffre base32 : pas un secret');
});

test('assertSafeVariables : noms interdits, secrets et non-scalaires refusés', () => {
  const ok = assertSafeVariables({ prenom: 'Awa', montant: 125000, urgent: true });
  assert.equal(ok.ok, true);
  const bad = assertSafeVariables({
    password: 'x',
    jeton: 'abc',
    lien_token: 'https://x/reset',
    objet: { a: 1 },
    blob: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
  });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    const names = bad.violations.map((v) => v.name).sort();
    assert.deepEqual(names, ['blob', 'jeton', 'lien_token', 'objet', 'password']);
  }
});

test('scrubText : masque les secrets et tronque pour les journaux', () => {
  const s = scrubText('échec SMTP jeton=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVPmB92K27uhb code=550');
  assert.ok(!s.includes('eyJ'), 'le JWT est masqué');
  assert.ok(s.includes('code=550'), 'le diagnostic utile survit');
  assert.ok(scrubText('x'.repeat(500), 300).length <= 300);
});

// ---------- Canaux et préférences ----------

test('canaux : in_app toujours ; préférence désactive un canal sortant', () => {
  const r = channelsFor({ templateChannels: ['in_app', 'email', 'sms'], mandatory: false, preferences: { email: false } });
  assert.deepEqual(r, ['in_app', 'sms']);
});

test('canaux : une notification OBLIGATOIRE ignore les préférences', () => {
  const r = channelsFor({ templateChannels: ['in_app', 'email'], mandatory: true, preferences: { email: false } });
  assert.deepEqual(r, ['in_app', 'email']);
});

test('canaux : préférence absente = activé (opt-out)', () => {
  const r = channelsFor({ templateChannels: ['in_app', 'push'], mandatory: false, preferences: {} });
  assert.deepEqual(r, ['in_app', 'push']);
});

// ---------- File : backoff et états ----------

test('backoff : exponentiel plafonné', () => {
  const opts = { baseMs: 60000, factor: 2, maxMs: 3600000 };
  assert.equal(backoffDelayMs(1, opts), 60000);
  assert.equal(backoffDelayMs(2, opts), 120000);
  assert.equal(backoffDelayMs(3, opts), 240000);
  assert.equal(backoffDelayMs(10, opts), 3600000, 'plafonné à maxMs');
  assert.equal(backoffDelayMs(1, { baseMs: 0, factor: 2, maxMs: 1000 }), 0);
});

test('état suivant : sent, failed (réessai) puis dead_letter à épuisement', () => {
  assert.equal(nextDeliveryStatus(true, 1, 5), 'sent');
  assert.equal(nextDeliveryStatus(false, 1, 5), 'failed');
  assert.equal(nextDeliveryStatus(false, 4, 5), 'failed');
  assert.equal(nextDeliveryStatus(false, 5, 5), 'dead_letter');
});

test('machine à états : miroir du trigger SQL', () => {
  assert.ok(canTransitionDelivery('pending', 'processing'));
  assert.ok(canTransitionDelivery('pending', 'cancelled'));
  assert.ok(canTransitionDelivery('processing', 'sent'));
  assert.ok(canTransitionDelivery('processing', 'failed'));
  assert.ok(canTransitionDelivery('processing', 'dead_letter'));
  assert.ok(canTransitionDelivery('failed', 'processing'));
  assert.ok(canTransitionDelivery('dead_letter', 'pending'));
  assert.ok(canTransitionDelivery('cancelled', 'pending'));
  assert.ok(!canTransitionDelivery('pending', 'sent'), 'pas de saut pending->sent');
  assert.ok(!canTransitionDelivery('sent', 'pending'), 'sent est terminal');
  assert.ok(!canTransitionDelivery('sent', 'failed'));
});
