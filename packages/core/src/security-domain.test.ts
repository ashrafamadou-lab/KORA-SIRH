import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openSecret, parseKey, sealSecret } from './secret-box.ts';
import { hit, prune, type RateLimitState } from './rate-limit.ts';

// ---------- Secret box (AES-256-GCM) ----------

const KEY = randomBytes(32);

test('secret-box : aller-retour fidèle, IV unique à chaque scellement', () => {
  const sealed = sealSecret('JBSWY3DPEHPK3PXP', KEY);
  assert.match(sealed, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(openSecret(sealed, KEY), 'JBSWY3DPEHPK3PXP');
  assert.notEqual(sealSecret('JBSWY3DPEHPK3PXP', KEY), sealed, 'IV aléatoire → sorties distinctes');
});

test('secret-box : toute altération fait échouer l’ouverture', () => {
  const sealed = sealSecret('secret-totp', KEY);
  const parts = sealed.split('.');
  const flip = (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
  for (let i = 1; i <= 3; i++) {
    const tampered = parts.map((p, j) => (j === i ? flip(p) : p)).join('.');
    assert.throws(() => openSecret(tampered, KEY), `altération du segment ${i} non détectée`);
  }
  assert.throws(() => openSecret(sealed, randomBytes(32)), 'mauvaise clé acceptée');
  assert.throws(() => openSecret('v0.a.b.c', KEY), 'version inconnue acceptée');
});

test('secret-box : parseKey accepte hex 64 et base64 32 octets, rejette le reste', () => {
  const hex = KEY.toString('hex');
  assert.deepEqual(parseKey(hex), KEY);
  assert.deepEqual(parseKey(KEY.toString('base64')), KEY);
  assert.deepEqual(parseKey(KEY.toString('base64url')), KEY);
  assert.throws(() => parseKey('court'));
  assert.throws(() => parseKey('zz'.repeat(32)));
});

// ---------- Rate limiter à fenêtre glissante ----------

const POLICY = { windowMs: 60_000, max: 3 };

test('rate-limit : autorise jusqu’à max, bloque ensuite avec retryAfter cohérent', () => {
  const state: RateLimitState = new Map();
  const t0 = 1_000_000;
  assert.equal(hit(state, 'k', t0, POLICY).allowed, true);
  assert.equal(hit(state, 'k', t0 + 1000, POLICY).allowed, true);
  const third = hit(state, 'k', t0 + 2000, POLICY);
  assert.equal(third.allowed, true);
  assert.equal(third.remaining, 0);
  const blocked = hit(state, 'k', t0 + 3000, POLICY);
  assert.equal(blocked.allowed, false);
  // le plus ancien (t0) expire à t0+60000 → il reste 57 s
  assert.equal(blocked.retryAfterSeconds, 57);
});

test('rate-limit : la fenêtre glisse — les tentatives anciennes libèrent la place', () => {
  const state: RateLimitState = new Map();
  const t0 = 2_000_000;
  hit(state, 'k', t0, POLICY);
  hit(state, 'k', t0 + 1000, POLICY);
  hit(state, 'k', t0 + 2000, POLICY);
  assert.equal(hit(state, 'k', t0 + 3000, POLICY).allowed, false);
  assert.equal(hit(state, 'k', t0 + 61_000, POLICY).allowed, true, 't0 est sorti de la fenêtre');
});

test('rate-limit : clés indépendantes, prune purge les clés inactives', () => {
  const state: RateLimitState = new Map();
  const t0 = 3_000_000;
  hit(state, 'a', t0, POLICY);
  hit(state, 'b', t0, POLICY);
  assert.equal(hit(state, 'b', t0 + 1, POLICY).allowed, true, 'la clé a ne pollue pas la clé b');
  prune(state, t0 + 120_000, POLICY);
  assert.equal(state.size, 0, 'clés expirées purgées');
});
