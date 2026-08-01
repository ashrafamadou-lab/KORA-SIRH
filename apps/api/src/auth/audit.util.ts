import type { Prisma } from '@prisma/client';

export interface AuthAuditEntry {
  action: string;
  actorUserId?: string;
  recordId?: string;
  reason?: string;
  /** Module d'audit — 'auth' par défaut, 'admin_users' pour l'administration des comptes. */
  module?: string;
}

/** Écriture d'audit — toujours DANS la transaction courante, jamais après. */
export async function auditAuth(
  tx: Prisma.TransactionClient,
  tenantId: string,
  entry: AuthAuditEntry,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO audit.audit_log (tenant_id, actor_user_id, action, module, record_type, record_id, reason)
    VALUES (${tenantId}::uuid, ${entry.actorUserId ?? null}::uuid, ${entry.action},
            ${entry.module ?? 'auth'}, 'user', ${entry.recordId ?? null}, ${entry.reason ?? null})`;
}
