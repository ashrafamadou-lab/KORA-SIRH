import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma.service';
import { auditAuth } from './audit.util';
import { generateTotpSecret, verifyTotp } from '../../../../packages/core/src/totp.ts';
import { base32Encode } from '../../../../packages/core/src/base32.ts';
import { openSecret, parseKey, sealSecret } from '../../../../packages/core/src/secret-box.ts';

const RECOVERY_CODE_COUNT = 8;

/**
 * MFA TOTP de bout en bout (US-E1-02, tranche 2) :
 * enrôlement → activation (avec preuve de possession) → vérification au login
 * (TOTP ou code de récupération à usage unique) → rotation des codes → désactivation.
 * Le secret est scellé AES-256-GCM sous KORA_MFA_KEY (jamais stocké en clair).
 * Discipline transactionnelle : les méthodes retournent des RÉSULTATS ; les audits
 * d'échec sont committés — aucune exception n'est levée dans une transaction.
 * Limite v1 assumée : pas d'anti-rejeu du TOTP dans sa fenêtre de 90 s (les codes de
 * récupération, eux, sont à usage strictement unique) — voir journal de Phase 1.
 */
export type MfaEnrollOutcome =
  | { kind: 'ok'; secret: string; otpauthUri: string }
  | { kind: 'already_enabled' };

export type MfaActivateOutcome =
  | { kind: 'ok'; recoveryCodes: string[] }
  | { kind: 'no_pending' }
  | { kind: 'bad_code' };

export type MfaDisableOutcome = { kind: 'ok' } | { kind: 'not_enabled' } | { kind: 'bad_code' };

export type MfaRotateOutcome =
  | { kind: 'ok'; recoveryCodes: string[] }
  | { kind: 'not_enabled' }
  | { kind: 'bad_code' };

interface MfaUserRow {
  email: string;
  mfa_enabled: boolean;
  mfa_secret_enc: string | null;
}

@Injectable()
export class MfaService {
  /** Fail-fast : sans clé valide, l'application refuse de démarrer (pas de MFA dégradé silencieux). */
  private readonly key = parseKey(
    process.env.KORA_MFA_KEY ??
      (() => {
        throw new Error('KORA_MFA_KEY manquante (32 octets hex/base64) — voir .env.example');
      })(),
  );

  constructor(private readonly prisma: PrismaService) {}

  async enroll(tenantId: string, userId: string): Promise<MfaEnrollOutcome> {
    return this.prisma.withTenant<MfaEnrollOutcome>(tenantId, async (tx) => {
      const user = await this.loadUser(tx, userId);
      if (!user || user.mfa_enabled) return { kind: 'already_enabled' };

      const secret = generateTotpSecret();
      await tx.$executeRaw`
        UPDATE admin.users
           SET mfa_secret_enc = ${sealSecret(secret, this.key)}, mfa_enabled = false
         WHERE id = ${userId}::uuid`;
      await auditAuth(tx, tenantId, { action: 'mfa_enrolled', actorUserId: userId, recordId: userId });

      const label = encodeURIComponent(`KORA:${user.email}`);
      return {
        kind: 'ok',
        secret,
        otpauthUri: `otpauth://totp/${label}?secret=${secret}&issuer=KORA&algorithm=SHA1&digits=6&period=30`,
      };
    });
  }

  async activate(tenantId: string, userId: string, code: string): Promise<MfaActivateOutcome> {
    return this.prisma.withTenant<MfaActivateOutcome>(tenantId, async (tx) => {
      const user = await this.loadUser(tx, userId);
      if (!user || !user.mfa_secret_enc || user.mfa_enabled) return { kind: 'no_pending' };

      if (!this.checkTotp(user.mfa_secret_enc, code)) {
        await auditAuth(tx, tenantId, {
          action: 'mfa_activate_failed',
          actorUserId: userId,
          recordId: userId,
          reason: 'bad_code',
        });
        return { kind: 'bad_code' };
      }

      await tx.$executeRaw`UPDATE admin.users SET mfa_enabled = true WHERE id = ${userId}::uuid`;
      const recoveryCodes = await this.rotateRecoveryCodes(tx, tenantId, userId);
      await auditAuth(tx, tenantId, { action: 'mfa_activated', actorUserId: userId, recordId: userId });
      return { kind: 'ok', recoveryCodes };
    });
  }

  /**
   * Vérification au LOGIN — s'exécute DANS la transaction de login (pas de nouvelle
   * transaction). TOTP d'abord ; sinon code de récupération consommé atomiquement
   * (UPDATE … WHERE used_at IS NULL RETURNING : l'usage unique tient sous concurrence).
   */
  async verifyForLogin(
    tx: Prisma.TransactionClient,
    tenantId: string,
    user: { id: string; secretEnc: string },
    code: string,
  ): Promise<boolean> {
    if (this.checkTotp(user.secretEnc, code)) return true;

    const normalized = code.toUpperCase().replace(/[^A-Z2-7]/g, '');
    if (normalized.length !== 8) return false;
    const consumed = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE admin.mfa_recovery_codes
         SET used_at = now()
       WHERE user_id = ${user.id}::uuid
         AND code_hash = ${sha256(normalized)}
         AND used_at IS NULL
       RETURNING id`;
    if (consumed.length !== 1) return false;
    await auditAuth(tx, tenantId, {
      action: 'mfa_recovery_used',
      actorUserId: user.id,
      recordId: user.id,
    });
    return true;
  }

  async disable(tenantId: string, userId: string, code: string): Promise<MfaDisableOutcome> {
    return this.prisma.withTenant<MfaDisableOutcome>(tenantId, async (tx) => {
      const user = await this.loadUser(tx, userId);
      if (!user || !user.mfa_enabled || !user.mfa_secret_enc) return { kind: 'not_enabled' };

      const valid =
        this.checkTotp(user.mfa_secret_enc, code) ||
        (await this.verifyForLogin(tx, tenantId, { id: userId, secretEnc: user.mfa_secret_enc }, code));
      if (!valid) {
        await auditAuth(tx, tenantId, {
          action: 'mfa_disable_failed',
          actorUserId: userId,
          recordId: userId,
          reason: 'bad_code',
        });
        return { kind: 'bad_code' };
      }

      await tx.$executeRaw`
        UPDATE admin.users SET mfa_enabled = false, mfa_secret_enc = NULL
         WHERE id = ${userId}::uuid`;
      await tx.$executeRaw`DELETE FROM admin.mfa_recovery_codes WHERE user_id = ${userId}::uuid`;
      await auditAuth(tx, tenantId, { action: 'mfa_disabled', actorUserId: userId, recordId: userId });
      return { kind: 'ok' };
    });
  }

  /** Rotation des codes de récupération — TOTP exigé (un code de récupération ne suffit pas). */
  async regenerateRecoveryCodes(
    tenantId: string,
    userId: string,
    code: string,
  ): Promise<MfaRotateOutcome> {
    return this.prisma.withTenant<MfaRotateOutcome>(tenantId, async (tx) => {
      const user = await this.loadUser(tx, userId);
      if (!user || !user.mfa_enabled || !user.mfa_secret_enc) return { kind: 'not_enabled' };
      if (!this.checkTotp(user.mfa_secret_enc, code)) {
        await auditAuth(tx, tenantId, {
          action: 'mfa_rotate_failed',
          actorUserId: userId,
          recordId: userId,
          reason: 'bad_code',
        });
        return { kind: 'bad_code' };
      }
      const recoveryCodes = await this.rotateRecoveryCodes(tx, tenantId, userId);
      await auditAuth(tx, tenantId, {
        action: 'mfa_recovery_rotated',
        actorUserId: userId,
        recordId: userId,
      });
      return { kind: 'ok', recoveryCodes };
    });
  }

  // ---------- privé ----------

  private async loadUser(tx: Prisma.TransactionClient, userId: string): Promise<MfaUserRow | undefined> {
    const rows = await tx.$queryRaw<MfaUserRow[]>`
      SELECT email::text AS email, mfa_enabled, mfa_secret_enc
        FROM admin.users
       WHERE id = ${userId}::uuid AND deleted_at IS NULL AND is_active`;
    return rows[0];
  }

  private checkTotp(secretEnc: string, code: string): boolean {
    try {
      const secret = openSecret(secretEnc, this.key);
      return verifyTotp(code, secret, Math.floor(Date.now() / 1000));
    } catch {
      return false; // secret illisible (clé tournée ?) = jamais un accès accordé
    }
  }

  private async rotateRecoveryCodes(
    tx: Prisma.TransactionClient,
    tenantId: string,
    userId: string,
  ): Promise<string[]> {
    await tx.$executeRaw`DELETE FROM admin.mfa_recovery_codes WHERE user_id = ${userId}::uuid`;
    const codes: string[] = [];
    for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
      const raw = base32Encode(randomBytes(5)); // 8 caractères, 40 bits
      codes.push(`${raw.slice(0, 4)}-${raw.slice(4)}`);
      await tx.$executeRaw`
        INSERT INTO admin.mfa_recovery_codes (tenant_id, user_id, code_hash)
        VALUES (${tenantId}::uuid, ${userId}::uuid, ${sha256(raw)})`;
    }
    return codes;
  }
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
