import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma.service';
import { auditAuth } from '../auth/audit.util';
import { BreachedPasswordService } from '../auth/breached-password.service';
import { checkPassword } from '../../../../packages/core/src/password-policy.ts';

export interface AdminUserRow {
  id: string;
  email: string;
  isActive: boolean;
  mfaEnabled: boolean;
  roles: string[];
}

export type CreateOutcome =
  | { kind: 'ok'; id: string }
  | { kind: 'duplicate' }
  | { kind: 'policy'; issues: string[] }
  | { kind: 'breached' }
  | { kind: 'breach_unavailable' };

export type SetActiveOutcome = { kind: 'ok'; sessionsRevoked: number } | { kind: 'not_found' };

export type AssignRolesOutcome =
  | { kind: 'ok' }
  | { kind: 'user_not_found' }
  | { kind: 'unknown_roles'; roles: string[] }
  // Anti-élévation : l'acteur ne peut accorder que des permissions qu'il détient lui-même.
  | { kind: 'escalation'; permissions: string[] };

const AUDIT = 'admin_users';

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly breached: BreachedPasswordService,
  ) {}

  list(tenantId: string): Promise<AdminUserRow[]> {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.$queryRaw<AdminUserRow[]>`
        SELECT u.id, u.email::text AS email, u.is_active AS "isActive", u.mfa_enabled AS "mfaEnabled",
               COALESCE(array_agg(r.key) FILTER (WHERE r.key IS NOT NULL), '{}') AS roles
          FROM admin.users u
          LEFT JOIN admin.user_roles ur ON ur.user_id = u.id
          LEFT JOIN admin.roles r ON r.id = ur.role_id
         WHERE u.deleted_at IS NULL
         GROUP BY u.id, u.email, u.is_active, u.mfa_enabled
         ORDER BY u.email`,
    );
  }

  async create(
    tenantId: string,
    actorUserId: string,
    email: string,
    password: string,
  ): Promise<CreateOutcome> {
    const policy = checkPassword(password, { email });
    if (!policy.ok) return { kind: 'policy', issues: policy.issues };
    if (this.breached.enabled) {
      const b = await this.breached.check(password);
      if (b.status === 'breached') return { kind: 'breached' };
      if (b.status === 'unavailable' && this.breached.failMode === 'closed') {
        return { kind: 'breach_unavailable' };
      }
    }
    const hash = await argon2.hash(password, { type: argon2.argon2id });
    return this.prisma.withTenant<CreateOutcome>(tenantId, async (tx) => {
      const existing = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM admin.users WHERE email = ${email} AND deleted_at IS NULL`;
      if (existing.length > 0) return { kind: 'duplicate' };
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO admin.users (tenant_id, email, password_hash, password_updated_at)
        VALUES (${tenantId}::uuid, ${email}, ${hash}, now())
        RETURNING id`;
      const id = rows[0]!.id;
      await auditAuth(tx, tenantId, { action: 'user_created', actorUserId, recordId: id, module: AUDIT });
      return { kind: 'ok', id };
    });
  }

  /** Activation / désactivation. La désactivation révoque TOUTES les sessions du compte. */
  async setActive(
    tenantId: string,
    actorUserId: string,
    targetUserId: string,
    active: boolean,
  ): Promise<SetActiveOutcome> {
    return this.prisma.withTenant<SetActiveOutcome>(tenantId, async (tx) => {
      const updated = await tx.$executeRaw`
        UPDATE admin.users SET is_active = ${active}
         WHERE id = ${targetUserId}::uuid AND deleted_at IS NULL`;
      if (updated === 0) return { kind: 'not_found' };

      let sessionsRevoked = 0;
      if (!active) {
        const revoked = await tx.$queryRaw<Array<{ id: string }>>`
          UPDATE admin.sessions SET revoked_at = now()
           WHERE user_id = ${targetUserId}::uuid AND revoked_at IS NULL
           RETURNING id`;
        sessionsRevoked = revoked.length;
      }
      await auditAuth(tx, tenantId, {
        action: active ? 'user_activated' : 'user_deactivated',
        actorUserId,
        recordId: targetUserId,
        reason: active ? undefined : `sessions_revoked=${sessionsRevoked}`,
        module: AUDIT,
      });
      return { kind: 'ok', sessionsRevoked };
    });
  }

  /** Révocation administrative de TOUTES les sessions d'un utilisateur (permission sessions.revoke). */
  async revokeUserSessions(
    tenantId: string,
    actorUserId: string,
    targetUserId: string,
  ): Promise<{ revoked: number }> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        UPDATE admin.sessions SET revoked_at = now()
         WHERE user_id = ${targetUserId}::uuid AND revoked_at IS NULL
         RETURNING id`;
      await auditAuth(tx, tenantId, {
        action: 'admin_sessions_revoked',
        actorUserId,
        recordId: targetUserId,
        reason: `count=${rows.length}`,
        module: AUDIT,
      });
      return { revoked: rows.length };
    });
  }

  /**
   * Affectation de rôles avec DÉLÉGATION BORNÉE (condition de validation) : l'ensemble des
   * permissions apportées par les rôles cibles doit être INCLUS dans les permissions que
   * l'acteur détient lui-même. Sinon → escalation (403), aucune écriture.
   */
  async assignRoles(
    tenantId: string,
    actorUserId: string,
    targetUserId: string,
    roleKeys: string[],
  ): Promise<AssignRolesOutcome> {
    return this.prisma.withTenant<AssignRolesOutcome>(tenantId, async (tx) => {
      const target = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM admin.users WHERE id = ${targetUserId}::uuid AND deleted_at IS NULL`;
      if (target.length === 0) return { kind: 'user_not_found' };

      const roles = await tx.$queryRaw<Array<{ id: string; key: string }>>`
        SELECT id, key FROM admin.roles WHERE key = ANY(${roleKeys}::text[])`;
      const found = new Set(roles.map((r) => r.key));
      const unknown = roleKeys.filter((k) => !found.has(k));
      if (unknown.length > 0) return { kind: 'unknown_roles', roles: unknown };

      // Permissions apportées par les rôles cibles.
      const roleIds = roles.map((r) => r.id);
      const granted = await tx.$queryRaw<Array<{ permission_key: string }>>`
        SELECT DISTINCT permission_key FROM admin.role_permissions
         WHERE role_id = ANY(${roleIds}::uuid[])`;
      // Permissions détenues par l'acteur.
      const actor = await tx.$queryRaw<Array<{ permission_key: string }>>`
        SELECT DISTINCT rp.permission_key
          FROM admin.user_roles ur JOIN admin.role_permissions rp ON rp.role_id = ur.role_id
         WHERE ur.user_id = ${actorUserId}::uuid`;
      const actorPerms = new Set(actor.map((p) => p.permission_key));
      const escalation = granted
        .map((p) => p.permission_key)
        .filter((p) => !actorPerms.has(p));
      if (escalation.length > 0) {
        await auditAuth(tx, tenantId, {
          action: 'role_assign_denied',
          actorUserId,
          recordId: targetUserId,
          reason: `escalation:${escalation.join(',')}`,
          module: AUDIT,
        });
        return { kind: 'escalation', permissions: escalation };
      }

      // Remplacement de l'ensemble des rôles de la cible.
      await tx.$executeRaw`DELETE FROM admin.user_roles WHERE user_id = ${targetUserId}::uuid`;
      for (const r of roles) {
        await tx.$executeRaw`
          INSERT INTO admin.user_roles (tenant_id, user_id, role_id)
          VALUES (${tenantId}::uuid, ${targetUserId}::uuid, ${r.id}::uuid)`;
      }
      await auditAuth(tx, tenantId, {
        action: 'roles_assigned',
        actorUserId,
        recordId: targetUserId,
        reason: roleKeys.join(','),
        module: AUDIT,
      });
      return { kind: 'ok' };
    });
  }
}
