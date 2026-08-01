import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPassword, hibpDigest } from './password-policy.ts';
import { DEFAULT_LOCKOUT_POLICY, isLocked, lockDelaySeconds, lockedUntilMs } from './lockout.ts';
import {
  hashSessionToken,
  mintSessionToken,
  parseSessionToken,
  sessionStatus,
} from './session-token.ts';

// ---------- Politique de mots de passe ----------

test('checkPassword : mot de passe robuste accepté', () => {
  const r = checkPassword('Trajet-Manguier-2026!', { email: 'firmin@demo.bj' });
  assert.deepEqual(r, { ok: true, issues: [] });
});

test('checkPassword : longueur et classes de caractères', () => {
  assert.ok(checkPassword('Ab1!x').issues.includes('too_short'));
  assert.ok(checkPassword('abcdefghijklmnop').issues.includes('not_enough_char_classes'));
  assert.equal(checkPassword('abcdefghijkL9!').ok, true);
});

test('checkPassword : liste de compromission et partie locale de l’email', () => {
  assert.ok(checkPassword('MOTDEPASSE').issues.includes('in_denylist'));
  const r = checkPassword('xxFIRMINxx-2026!A', { email: 'Firmin@demo.bj' });
  assert.ok(r.issues.includes('contains_email_localpart'));
});

// ---------- Verrouillage progressif ----------

test('lockout : progression 0 → 30 s → 60 s, plafonnée à 900 s', () => {
  assert.equal(lockDelaySeconds(0), 0);
  assert.equal(lockDelaySeconds(4), 0);
  assert.equal(lockDelaySeconds(5), 30);
  assert.equal(lockDelaySeconds(6), 60);
  assert.equal(lockDelaySeconds(7), 120);
  assert.equal(lockDelaySeconds(10), 900, 'plafond atteint');
  assert.equal(lockDelaySeconds(50), 900, 'reste au plafond');
});

test('lockout : échéance et test de verrou', () => {
  const now = 1_754_000_000_000;
  assert.equal(lockedUntilMs(3, now), null);
  assert.equal(lockedUntilMs(5, now), now + 30_000);
  assert.equal(isLocked(null, now), false);
  assert.equal(isLocked(now + 1, now), true);
  assert.equal(isLocked(now - 1, now), false);
  assert.equal(DEFAULT_LOCKOUT_POLICY.threshold, 5);
});

// ---------- Jetons de session ----------

const TENANT = '11111111-1111-4111-8111-111111111111';

test('session-token : frappe → analyse → empreinte, cohérents', () => {
  const { token, tokenHash } = mintSessionToken(TENANT);
  assert.match(token, /^k1\.11111111-1111-4111-8111-111111111111\.[A-Za-z0-9_-]{43}$/);
  assert.equal(parseSessionToken(token)?.tenantId, TENANT);
  assert.equal(hashSessionToken(token), tokenHash);
  assert.match(tokenHash, /^[0-9a-f]{64}$/);
  // deux frappes ne se ressemblent jamais
  assert.notEqual(mintSessionToken(TENANT).token, token);
});

test('session-token : rejets (préfixe, uuid, secret court, structure)', () => {
  assert.equal(parseSessionToken(`k2.${TENANT}.${'a'.repeat(43)}`), null);
  assert.equal(parseSessionToken(`k1.pas-un-uuid.${'a'.repeat(43)}`), null);
  assert.equal(parseSessionToken(`k1.${TENANT}.court`), null);
  assert.equal(parseSessionToken(`k1.${TENANT}`), null);
  assert.throws(() => mintSessionToken('pas-un-uuid'));
});

test('sessionStatus : active / révoquée / expirée / inactivité', () => {
  const base = { createdAtMs: 0, lastSeenAtMs: 90_000, expiresAtMs: 200_000 };
  const idleMax = 60; // secondes
  assert.equal(sessionStatus(base, 100_000, idleMax), 'active');
  assert.equal(sessionStatus({ ...base, revokedAtMs: 95_000 }, 100_000, idleMax), 'revoked');
  assert.equal(sessionStatus(base, 200_000, idleMax), 'expired');
  assert.equal(sessionStatus(base, 190_000, idleMax), 'idle_timeout', '100 s sans activité > 60 s');
});

test('hibpDigest : découpe k-anonymat conforme (vecteur SHA-1 connu)', () => {
  // sha1('password') = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
  const { prefix, suffix } = hibpDigest('password');
  assert.equal(prefix, '5BAA6');
  assert.equal(suffix, '1E4C9B93F3F0682250B6CF8331B7EE68FD8');
  assert.equal(prefix.length, 5);
  assert.equal(suffix.length, 35);
});
