import {
  HttpException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma.service';
import {
  DEFAULT_LOCKOUT_POLICY,
  isLocked,
  lockedUntilMs,
} from '../../../../packages/core/src/lockout.ts';
import {
  hashSessionToken,
  mintSessionToken,
  parseSessionToken,
  sessionStatus,
} from '../../../../packages/core/src/session-token.ts';

const ABSOLUTE_TTL_HOURS = 12;
const IDLE_MAX_SECONDS = 30 * 60;
const GENERIC_MESSAGE = 'identifiants invalides';

export interface LoginInput {
  tenantSlug: string;
  email: string;
  password: string;
  ip?: string | null;
  userAgent?: string | null;
}

export interface LoginResult {
  token: string;
  expiresAt: string;
  user: { id: string; email: string };
}

export interface AuthContext {
  tenantId: string;
  userId: string;
  sessionId: string;
  email: string;
}

interface UserRow {
  id: string;
  password_hash: string | null;
  is_active: boolean;
  failed_login_count: number;
  locked_until: Date | null;
}

@Injectable()
export class AuthService {
  /** Hachage factice, réel, calculé au démarrage : les échecs « compte inconnu » coûtent
   *  le même temps qu'une vraie vérification (anti-énumération par chronométrage). */
  private readonly dummyHash: Promise<string> = argon2.hash(`kora-dummy-${randomUUID()}`, {
    type: argon2.argon2id,
  });

  constructor(private readonly prisma: PrismaService) {}

  async login(input: LoginInput): Promise<LoginResult> {
    const tenantId = await this.prisma.resolveTenant(input.tenantSlug);
    if (!tenantId) {
      await this.burnTime(input.password);
      throw new UnauthorizedException(GENERIC_MESSAGE);
    }

    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<UserRow[]>`
        SELECT id, password_hash, is_active, failed_login_count, locked_until
          FROM admin.users
         WHERE email = ${input.email} AND deleted_at IS NULL`;
      const user = rows[0];

      if (!user || !user.is_active || !user.password_hash) {
        await this.burnTime(input.password);
        await this.audit(tx, tenantId, {
          action: 'login_failed',
          recordId: input.email,
          reason: !user ? 'unknown_user' : !user.is_active ? 'inactive' : 'no_password',
        });
        throw new UnauthorizedException(GENERIC_MESSAGE);
      }

      const now = Date.now();
      if (isLocked(user.locked_until?.getTime() ?? null, now)) {
        const retryAfterSeconds = Math.ceil((user.locked_until!.getTime() - now) / 1000);
        await this.audit(tx, tenantId, {
          action: 'login_failed',
          actorUserId: user.id,
          recordId: input.email,
          reason: 'locked',
        });
        throw new HttpException(
          { statusCode: 423, message: 'compte temporairement verrouillé', retryAfterSeconds },
          423,
        );
      }

      const valid = await argon2.verify(user.password_hash, input.password).catch(() => false);
      if (!valid) {
        const failedCount = user.failed_login_count + 1;
        const until = lockedUntilMs(failedCount, now, DEFAULT_LOCKOUT_POLICY);
        await tx.$executeRaw`
          UPDATE admin.users
             SET failed_login_count = ${failedCount}::int,
                 locked_until = ${until === null ? null : new Date(until)}::timestamptz
           WHERE id = ${user.id}::uuid`;
        await this.audit(tx, tenantId, {
          action: 'login_failed',
          actorUserId: user.id,
          recordId: input.email,
          reason: `bad_password_${failedCount}`,
        });
        throw new UnauthorizedException(GENERIC_MESSAGE);
      }

      await tx.$executeRaw`
        UPDATE admin.users
           SET failed_login_count = 0, locked_until = NULL
         WHERE id = ${user.id}::uuid`;

      const { token, tokenHash } = mintSessionToken(tenantId);
      const expiresAt = new Date(now + ABSOLUTE_TTL_HOURS * 3600 * 1000);
      await tx.session.create({
        data: {
          tenantId,
          userId: user.id,
          tokenHash,
          expiresAt,
          ip: input.ip ?? null,
          userAgent: input.userAgent?.slice(0, 300) ?? null,
        },
      });
      await this.audit(tx, tenantId, { action: 'login', actorUserId: user.id, recordId: user.id });

      return {
        token,
        expiresAt: expiresAt.toISOString(),
        user: { id: user.id, email: input.email },
      };
    });
  }

  /** Valide un jeton et retourne le contexte — utilisé par SessionGuard sur chaque requête. */
  async authenticate(token: string): Promise<AuthContext> {
    const parsed = parseSessionToken(token);
    if (!parsed) throw new UnauthorizedException('session invalide');

    return this.prisma.withTenant(parsed.tenantId, async (tx) => {
      const session = await tx.session.findUnique({
        where: { tokenHash: hashSessionToken(token) },
      });
      if (!session || session.tenantId !== parsed.tenantId) {
        throw new UnauthorizedException('session invalide');
      }
      const status = sessionStatus(
        {
          createdAtMs: session.createdAt.getTime(),
          lastSeenAtMs: session.lastSeenAt.getTime(),
          expiresAtMs: session.expiresAt.getTime(),
          revokedAtMs: session.revokedAt?.getTime() ?? null,
        },
        Date.now(),
        IDLE_MAX_SECONDS,
      );
      if (status !== 'active') throw new UnauthorizedException('session invalide');

      await tx.session.update({
        where: { id: session.id },
        data: { lastSeenAt: new Date() },
      });
      const rows = await tx.$queryRaw<Array<{ email: string }>>`
        SELECT email::text AS email FROM admin.users
         WHERE id = ${session.userId}::uuid AND deleted_at IS NULL`;
      const email = rows[0]?.email;
      if (!email) throw new UnauthorizedException('session invalide');

      return {
        tenantId: session.tenantId,
        userId: session.userId,
        sessionId: session.id,
        email,
      };
    });
  }

  /** Révocation idempotente de la session portée par le jeton. */
  async logout(token: string): Promise<void> {
    const parsed = parseSessionToken(token);
    if (!parsed) return;
    await this.prisma.withTenant(parsed.tenantId, async (tx) => {
      const session = await tx.session.findUnique({
        where: { tokenHash: hashSessionToken(token) },
      });
      if (!session || session.revokedAt) return;
      await tx.session.update({
        where: { id: session.id },
        data: { revokedAt: new Date() },
      });
      await this.audit(tx, parsed.tenantId, {
        action: 'logout',
        actorUserId: session.userId,
        recordId: session.id,
      });
    });
  }

  private async burnTime(password: string): Promise<void> {
    await argon2.verify(await this.dummyHash, password).catch(() => false);
  }

  private async audit(
    tx: Prisma.TransactionClient,
    tenantId: string,
    entry: { action: string; actorUserId?: string; recordId?: string; reason?: string },
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO audit.audit_log (tenant_id, actor_user_id, action, module, record_type, record_id, reason)
      VALUES (${tenantId}::uuid, ${entry.actorUserId ?? null}::uuid, ${entry.action},
              'auth', 'user', ${entry.recordId ?? null}, ${entry.reason ?? null})`;
  }
}
