import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base32Decode, base32Encode } from './base32.ts';
import { generateTotpSecret, totp, verifyTotp } from './totp.ts';

test('base32 : vecteurs RFC 4648 (sans padding)', () => {
  const vectors: Array<[string, string]> = [
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ];
  for (const [plain, encoded] of vectors) {
    assert.equal(base32Encode(Buffer.from(plain, 'ascii')), encoded);
    assert.equal(Buffer.from(base32Decode(encoded)).toString('ascii'), plain);
  }
});

test('base32 : décodage tolérant (casse, padding, espaces) et rejet des caractères invalides', () => {
  assert.equal(Buffer.from(base32Decode('mzxw6ytboi======')).toString('ascii'), 'foobar');
  assert.equal(Buffer.from(base32Decode('MZXW 6YTB OI')).toString('ascii'), 'foobar');
  assert.throws(() => base32Decode('ABC1')); // « 1 » hors alphabet
});

test('TOTP : vecteurs officiels RFC 6238 (SHA-1, 8 chiffres)', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890', 'ascii'));
  const vectors: Array<[number, string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];
  for (const [t, expected] of vectors) {
    assert.equal(totp(secret, t, { digits: 8 }), expected);
  }
});

test('TOTP : 6 chiffres par défaut, secret généré valide', () => {
  const secret = generateTotpSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/); // 20 octets → 32 caractères base32
  const code = totp(secret, 1_700_000_000);
  assert.match(code, /^\d{6}$/);
});

test('verifyTotp : fenêtre de dérive ±1 pas', () => {
  const secret = generateTotpSecret();
  const now = 1_754_000_000;
  assert.equal(verifyTotp(totp(secret, now), secret, now), true);
  assert.equal(verifyTotp(totp(secret, now - 30), secret, now), true, 'pas précédent accepté');
  assert.equal(verifyTotp(totp(secret, now + 30), secret, now), true, 'pas suivant accepté');
  assert.equal(verifyTotp(totp(secret, now - 90), secret, now), false, 'hors fenêtre refusé');
  assert.equal(verifyTotp(totp(secret, now - 90), secret, now, { windowSteps: 3 }), true);
});

test('verifyTotp : entrées malformées refusées sans exception', () => {
  const secret = generateTotpSecret();
  const now = 1_754_000_000;
  assert.equal(verifyTotp('abcdef', secret, now), false);
  assert.equal(verifyTotp('12345', secret, now), false);
  assert.equal(verifyTotp('1234567', secret, now), false);
  assert.equal(verifyTotp('', secret, now), false);
});
