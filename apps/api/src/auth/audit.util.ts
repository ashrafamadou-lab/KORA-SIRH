import type { Prisma } from '@prisma/client';

export interface AuthAuditEntry {
  action: string;
  actorUserId?: string;
  recordId?: string;
  reason?: string;
  /** Module d'audit — 'auth' par défaut ('admin_users', 'workflow', 'config', 'notify', 'audit'…). */
  module?: string;
  /** Type d'entité concernée — 'user' par défaut (E6 : 'audit_log' pour les traces de consultation). */
  recordType?: string;
  /** Issue de l'opération — MÉTADONNÉE hors payload de hachage (comme ip/device). */
  result?: 'success' | 'denied' | 'failure';
  /** Identifiant de corrélation (regroupe les traces d'une même opération) — hors payload. */
  correlationId?: string;
}

/** Écriture d'audit — toujours DANS la transaction courante, jamais après. */
export async function auditAuth(
  tx: Prisma.TransactionClient,
  tenantId: string,
  entry: AuthAuditEntry,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO audit.audit_log (tenant_id, actor_user_id, action, module, record_type, record_id, reason, result, correlation_id)
    VALUES (${tenantId}::uuid, ${entry.actorUserId ?? null}::uuid, ${entry.action},
            ${entry.module ?? 'auth'}, ${entry.recordType ?? 'user'}, ${entry.recordId ?? null}, ${entry.reason ?? null},
            ${entry.result ?? null}, ${entry.correlationId ?? null}::uuid)`;
}
