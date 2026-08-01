/**
 * HOTP (RFC 4226) et TOTP (RFC 6238) — MFA de KORA (US-E1-02).
 * Implémentation stdlib uniquement (node:crypto), vérifiée contre les vecteurs de test
 * de la RFC 6238. La comparaison de codes est à temps constant.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { base32Decode, base32Encode } from './base32.ts';

export type TotpAlgorithm = 'sha1' | 'sha256' | 'sha512';

export interface TotpOptions {
  stepSeconds?: number;
  digits?: number;
  algorithm?: TotpAlgorithm;
}

/** Génère un secret TOTP (160 bits par défaut), encodé base32 pour le QR d'enrôlement. */
export function generateTotpSecret(byteLength = 20): string {
  return base32Encode(randomBytes(byteLength));
}

export function hotp(
  secret: Uint8Array,
  counter: bigint,
  digits = 6,
  algorithm: TotpAlgorithm = 'sha1',
): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(counter);
  const mac = createHmac(algorithm, Buffer.from(secret)).update(buf).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const code =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;
  return (code % 10 ** digits).toString().padStart(digits, '0');
}

export function totp(secretBase32: string, unixSeconds: number, opts: TotpOptions = {}): string {
  const { stepSeconds = 30, digits = 6, algorithm = 'sha1' } = opts;
  const counter = BigInt(Math.floor(unixSeconds / stepSeconds));
  return hotp(base32Decode(secretBase32), counter, digits, algorithm);
}

/**
 * Vérifie un code dans une fenêtre de ± windowSteps pas (défaut ±1, soit 90 s utiles) —
 * tolérance de dérive d'horloge des téléphones sans affaiblir sérieusement le facteur.
 */
export function verifyTotp(
  token: string,
  secretBase32: string,
  unixSeconds: number,
  opts: TotpOptions & { windowSteps?: number } = {},
): boolean {
  const { stepSeconds = 30, digits = 6, algorithm = 'sha1', windowSteps = 1 } = opts;
  if (!/^\d+$/.test(token) || token.length !== digits) return false;
  const secret = base32Decode(secretBase32);
  const center = Math.floor(unixSeconds / stepSeconds);
  const given = Buffer.from(token);
  let ok = false;
  for (let w = -windowSteps; w <= windowSteps; w++) {
    const candidate = Buffer.from(hotp(secret, BigInt(center + w), digits, algorithm));
    // timingSafeEqual sur longueurs égales garanties ; pas de court-circuit : on balaie
    // toute la fenêtre quoi qu'il arrive.
    if (candidate.length === given.length && timingSafeEqual(candidate, given)) ok = true;
  }
  return ok;
}
