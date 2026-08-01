/**
 * Scellement de secrets applicatifs — AES-256-GCM (chiffrement authentifié).
 * Usage KORA : le secret TOTP (mfa_secret_enc) et, plus tard, les identifiants
 * bancaires (Blueprint §15.2). Format : v1.<iv>.<tag>.<ct> en base64url.
 * Toute altération (iv, tag, ct) fait échouer l'ouverture — jamais de sortie corrompue.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const IV_BYTES = 12;
const KEY_BYTES = 32;

/** Accepte une clé en hex (64 caractères) ou base64/base64url (32 octets décodés). */
export function parseKey(input: string): Buffer {
  const trimmed = input.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return Buffer.from(trimmed, 'hex');
  for (const enc of ['base64', 'base64url'] as const) {
    try {
      const buf = Buffer.from(trimmed, enc);
      if (buf.length === KEY_BYTES) return buf;
    } catch {
      // essai suivant
    }
  }
  throw new Error(`clé invalide : attendu 32 octets (hex 64 caractères ou base64)`);
}

export function sealSecret(plaintext: string, key: Buffer): string {
  if (key.length !== KEY_BYTES) throw new Error('sealSecret : clé de 32 octets requise');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

export function openSecret(sealed: string, key: Buffer): string {
  if (key.length !== KEY_BYTES) throw new Error('openSecret : clé de 32 octets requise');
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('openSecret : format de secret scellé invalide');
  }
  const [, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8');
}
