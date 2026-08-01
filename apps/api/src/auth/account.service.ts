import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma.service';
import { auditAuth } from './audit.util';
import { BreachedPasswordService } from './breached-password.service';
import { checkPassword } from '../../../../packages/core/src/password-policy.ts';

export interface ActiveSession {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

export type PasswordChangeOutcome =
  | { kind: 'ok' }
  | { kind: 'wrong_current' }
  | { kind: 'policy'; issues: string[] }
  | { kind: 'breached' }
  | { kind: 'breach_unavailable' }; // mode fail-closed : refus explicite (503)

/**
 * Cycle de vie du compte côté utilisateur (clôture E1/E2). Discipline transactionnelle :
 * chaque withTenant retourne un résultat ; les exceptions sont levées après commit.
 * Un jeton de session n'est JAMAIS retourné (on n'expose que des métadonnées + `current`).
 */
@Injectable()
export class AccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly breached: BreachedPasswordService,
  ) {}

  listSessions(tenantId: string, userId: string, currentSessionId: string): Promise<ActiveSession[]> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.session.findMany({
        where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
      });
      return rows.map((s) => ({
        id: s.id,
        createdAt: s.createdAt.toISOString(),
        lastSeenAt: s.lastSeenAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
        ip: s.ip,
        userAgent: s.userAgent,
        current: s.id === currentSessionId,
      }));
    });
  }

  /** Révoque une session précise DE L'UTILISATEUR — bornée tenant (RLS) et propriétaire. */
  async revokeSession(
    tenantId: string,
    userId: string,
    sessionId: string,
  ): Promise<{ kind: 'ok' } | { kind: 'not_found' }> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const updated = await tx.$executeRaw`
        UPDATE admin.sessions SET revoked_at = now()
         WHERE id = ${sessionId}::uuid AND user_id = ${userId}::uuid AND revoked_at IS NULL`;
      if (updated === 0) return { kind: 'not_found' as const };
      await auditAuth(tx, tenantId, {
        action: 'session_revoked',
        actorUserId: userId,
        recordId: sessionId,
        reason: 'self',
      });
      return { kind: 'ok' as const };
    });
  }

  /** Révoque toutes les sessions SAUF la courante (« se déconnecter partout ailleurs »). */
  async revokeOtherSessions(
    tenantId: string,
    userId: string,
    keepSessionId: string,
  ): Promise<number> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        UPDATE admin.sessions SET revoked_at = now()
         WHERE user_id = ${userId}::uuid AND id <> ${keepSessionId}::uuid AND revoked_at IS NULL
         RETURNING id`;
      if (rows.length > 0) {
        await auditAuth(tx, tenantId, {
          action: 'sessions_revoked_others',
          actorUserId: userId,
          recordId: userId,
          reason: `count=${rows.length}`,
        });
      }
      return rows.length;
    });
  }

  /**
   * Changement de mot de passe : ancien vérifié, politique locale (@kora/core) toujours
   * appliquée, compromission selon le mode configuré, puis — en cas de succès — TOUTES
   * les autres sessions sont révoquées (condition de validation). L'appel se fait en deux
   * temps : vérifications hors transaction (dont l'éventuel appel réseau HIBP), puis une
   * transaction courte qui écrit le hash, révoque les autres sessions et audite.
   */
  async changePassword(
    tenantId: string,
    userId: string,
    email: string,
    currentPassword: string,
    newPassword: string,
    keepSessionId: string,
  ): Promise<PasswordChangeOutcome> {
    // 1. Politique locale — toujours, indépendante de toute disponibilité réseau.
    const policy = checkPassword(newPassword, { email });
    if (!policy.ok) return { kind: 'policy', issues: policy.issues };

    // 2. Vérification de l'ancien mot de passe (lecture bornée tenant).
    const current = await this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ password_hash: string | null }>>`
        SELECT password_hash FROM admin.users
         WHERE id = ${userId}::uuid AND deleted_at IS NULL AND is_active`;
      return rows[0]?.password_hash ?? null;
    });
    if (!current) return { kind: 'wrong_current' };
    const oldOk = await argon2.verify(current, currentPassword).catch(() => false);
    if (!oldOk) return { kind: 'wrong_current' };

    // 3. Compromission (mode 'hibp' seulement) — fail open/closed documenté et testable.
    if (this.breached.enabled) {
      const outcome = await this.breached.check(newPassword);
      if (outcome.status === 'breached') return { kind: 'breached' };
      if (outcome.status === 'unavailable' && this.breached.failMode === 'closed') {
        return { kind: 'breach_unavailable' };
      }
    }

    // 4. Écriture + révocation des autres sessions + audit, en une transaction.
    const newHash = await argon2.hash(newPassword, { type: argon2.argon2id });
    await this.prisma.withTenant(tenantId, async (tx) => {
      await tx.$executeRaw`
        UPDATE admin.users
           SET password_hash = ${newHash}, password_updated_at = now(),
               failed_login_count = 0, locked_until = NULL
         WHERE id = ${userId}::uuid`;
      await tx.$executeRaw`
        UPDATE admin.sessions SET revoked_at = now()
         WHERE user_id = ${userId}::uuid AND id <> ${keepSessionId}::uuid AND revoked_at IS NULL`;
      await auditAuth(tx, tenantId, {
        action: 'password_changed',
        actorUserId: userId,
        recordId: userId,
      });
    });
    return { kind: 'ok' };
  }
}
