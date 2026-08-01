import type { Prisma } from '@prisma/client';

export interface AuthAuditEntry {
  action: string;
  actorUserId?: string;
  recordId?: string;
  reason?: string;
}

/** Écriture d'audit du module auth — toujours DANS la transaction courante, jamais après. */
export async function auditAuth(
  tx: Prisma.TransactionClient,
  tenantId: string,
  entry: AuthAuditEntry,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO audit.audit_log (tenant_id, actor_user_id, action, module, record_type, record_id, reason)
    VALUES (${tenantId}::uuid, ${entry.actorUserId ?? null}::uuid, ${entry.action},
            'auth', 'user', ${entry.recordId ?? null}, ${entry.reason ?? null})`;
}
