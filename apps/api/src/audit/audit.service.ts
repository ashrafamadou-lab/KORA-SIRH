import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { auditAuth } from '../auth/audit.util';
import {
  filtersDigest,
  maskAuditText,
  maskJsonDeep,
  resolveAuditAccess,
  toCsv,
  type AuditAccess,
} from '../../../../packages/core/src/audit-view.ts';

/**
 * Consultation de l'audit trail (E6) — LECTURE SEULE.
 * Le journal est append-only : ce service n'expose AUCUNE correction, suppression ni
 * recalcul de chaîne. Trois périmètres de vue, résolus depuis les permissions et
 * INTERSECTÉS avec tout filtre demandé (un filtre ne peut qu'étrécir, jamais élargir) :
 *   audit.view            → tout l'audit du tenant ;
 *   audit.view_<module>   → les modules nommés ;
 *   audit.view_own        → uniquement ses propres événements.
 * Masquage systématique : reason / old_value / new_value passent par le masque
 * anti-secrets (mêmes règles pour l'API, les exports et les traces).
 * Les consultations sensibles laissent une trace d'audit DISTINCTE (module 'audit'),
 * écrite dans la MÊME transaction que la lecture.
 */

export interface AuditFilters {
  from?: Date;
  to?: Date;
  actorUserId?: string;
  action?: string;
  module?: string;
  recordType?: string;
  recordId?: string;
  result?: string;
  correlationId?: string;
  employeeId?: string;
}

export type ListOutcome =
  | { kind: 'ok'; items: unknown[]; nextCursor: string | null }
  | { kind: 'forbidden' };

export type DetailOutcome =
  | { kind: 'ok'; event: Record<string, unknown> }
  | { kind: 'not_found' }
  | { kind: 'forbidden' };

export type IntegrityOutcome = {
  status: 'valid' | 'broken' | 'unverified';
  checked: number;
  lastId: string | null;
  brokenAtId?: string;
  /** Reprise (status=unverified) : repasser ces valeurs pour continuer la vérification. */
  nextAfterId?: string;
  nextSeed?: string;
};

export type ExportOutcome =
  | { kind: 'ok'; count: number; csv?: string; items?: unknown[] }
  | { kind: 'forbidden' };

interface AuditRow {
  id: string;
  occurred_at: Date;
  actor_user_id: string | null;
  on_behalf_of: string | null;
  action: string;
  module: string;
  record_type: string;
  record_id: string | null;
  employee_id: string | null;
  reason: string | null;
  result: string | null;
  correlation_id: string | null;
  workflow_ref: string | null;
  old_value?: unknown;
  new_value?: unknown;
}

const SEGMENT_SIZE = 5000;

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------- périmètre de vue ----------

  private async accessFor(tx: Prisma.TransactionClient, userId: string): Promise<AuditAccess> {
    const rows = await tx.$queryRaw<Array<{ permission_key: string }>>`
      SELECT rp.permission_key
        FROM admin.user_roles ur
        JOIN admin.role_permissions rp ON rp.role_id = ur.role_id
       WHERE ur.user_id = ${userId}::uuid`;
    return resolveAuditAccess(rows.map((r) => r.permission_key));
  }

  /** Liste filtrée, visibilité intersectée, curseur stable par id décroissant. */
  private async queryEvents(
    tx: Prisma.TransactionClient,
    access: AuditAccess,
    selfUserId: string,
    f: AuditFilters,
    opts: { beforeId: string | null; limit: number; withValues: boolean },
  ): Promise<AuditRow[]> {
    // Les modules visibles passent en param TEXTE (string_to_array) : bind portable,
    // aucun risque de sérialisation de tableau côté driver. Noms bornés à [a-z_].
    const modulesCsv = access.modules.join(',');
    return tx.$queryRaw<AuditRow[]>`
      SELECT id::text AS id, occurred_at, actor_user_id, on_behalf_of, action, module,
             record_type, record_id, employee_id, reason, result, correlation_id, workflow_ref,
             CASE WHEN ${opts.withValues} THEN old_value ELSE NULL END AS old_value,
             CASE WHEN ${opts.withValues} THEN new_value ELSE NULL END AS new_value
        FROM audit.audit_log
       WHERE (${access.all}
              OR module = ANY(string_to_array(${modulesCsv}, ','))
              OR (${access.own} AND actor_user_id = ${selfUserId}::uuid))
         AND (${f.from ?? null}::timestamptz IS NULL OR occurred_at >= ${f.from ?? null}::timestamptz)
         AND (${f.to ?? null}::timestamptz IS NULL OR occurred_at <= ${f.to ?? null}::timestamptz)
         AND (${f.actorUserId ?? null}::uuid IS NULL OR actor_user_id = ${f.actorUserId ?? null}::uuid)
         AND (${f.action ?? null}::text IS NULL OR action = ${f.action ?? null})
         AND (${f.module ?? null}::text IS NULL OR module = ${f.module ?? null})
         AND (${f.recordType ?? null}::text IS NULL OR record_type = ${f.recordType ?? null})
         AND (${f.recordId ?? null}::text IS NULL OR record_id = ${f.recordId ?? null})
         AND (${f.result ?? null}::text IS NULL OR result = ${f.result ?? null})
         AND (${f.correlationId ?? null}::uuid IS NULL OR correlation_id = ${f.correlationId ?? null}::uuid)
         AND (${f.employeeId ?? null}::uuid IS NULL OR employee_id = ${f.employeeId ?? null}::uuid)
         AND (${opts.beforeId}::bigint IS NULL OR id < ${opts.beforeId}::bigint)
       ORDER BY id DESC
       LIMIT ${opts.limit}`;
  }

  private toApi(row: AuditRow, withValues: boolean): Record<string, unknown> {
    const base: Record<string, unknown> = {
      id: row.id,
      occurredAt: row.occurred_at,
      actorUserId: row.actor_user_id,
      onBehalfOf: row.on_behalf_of,
      action: row.action,
      module: row.module,
      recordType: row.record_type,
      recordId: row.record_id,
      employeeId: row.employee_id,
      reason: row.reason === null ? null : maskAuditText(row.reason),
      result: row.result,
      correlationId: row.correlation_id,
      workflowRef: row.workflow_ref,
    };
    if (withValues) {
      base['oldValue'] = row.old_value === null || row.old_value === undefined ? null : maskJsonDeep(row.old_value);
      base['newValue'] = row.new_value === null || row.new_value === undefined ? null : maskJsonDeep(row.new_value);
    }
    return base;
  }

  // ---------- consultation ----------

  async listEvents(
    tenantId: string,
    actorUserId: string,
    filters: AuditFilters,
    page: { beforeId: string | null; limit: number },
  ): Promise<ListOutcome> {
    return this.prisma.withTenant<ListOutcome>(tenantId, async (tx) => {
      const access = await this.accessFor(tx, actorUserId);
      if (!access.any) return { kind: 'forbidden' };
      const rows = await this.queryEvents(tx, access, actorUserId, filters, {
        beforeId: page.beforeId, limit: page.limit + 1, withValues: false,
      });
      const hasMore = rows.length > page.limit;
      const slice = rows.slice(0, page.limit);
      // Trace de consultation quand la vue dépasse ses propres événements (sensible).
      if (access.all || access.modules.length > 0) {
        const digest = filtersDigest({ ...filters, cursor: page.beforeId ?? undefined });
        await auditAuth(tx, tenantId, {
          action: 'audit_consulted', actorUserId, module: 'audit', recordType: 'audit_log',
          reason: digest || undefined,
          result: 'success',
        });
      }
      return {
        kind: 'ok',
        items: slice.map((r) => this.toApi(r, false)),
        nextCursor: hasMore && slice.length > 0 ? slice[slice.length - 1]!.id : null,
      };
    });
  }

  async getEvent(tenantId: string, actorUserId: string, id: string): Promise<DetailOutcome> {
    return this.prisma.withTenant<DetailOutcome>(tenantId, async (tx) => {
      const access = await this.accessFor(tx, actorUserId);
      if (!access.any) return { kind: 'forbidden' };
      const rows = await tx.$queryRaw<AuditRow[]>`
        SELECT id::text AS id, occurred_at, actor_user_id, on_behalf_of, action, module,
               record_type, record_id, employee_id, reason, result, correlation_id, workflow_ref,
               old_value, new_value
          FROM audit.audit_log
         WHERE id = ${id}::bigint
           AND (${access.all}
                OR module = ANY(string_to_array(${access.modules.join(',')}, ','))
                OR (${access.own} AND actor_user_id = ${actorUserId}::uuid))`;
      const row = rows[0];
      if (!row) return { kind: 'not_found' };
      // Le détail expose old/new (masqués) : consultation sensible, toujours tracée.
      await auditAuth(tx, tenantId, {
        action: 'audit_event_viewed', actorUserId, module: 'audit', recordType: 'audit_log',
        recordId: row.id, result: 'success',
      });
      return { kind: 'ok', event: this.toApi(row, true) };
    });
  }

  // ---------- intégrité de la chaîne ----------

  /**
   * Vérification BORNÉE (protection contre les requêtes trop coûteuses) et REPRENABLE :
   * le hash de reprise vient du segment précédent (cryptographique, pas déclaratif).
   * valid = fin de chaîne atteinte sans rupture ; broken = première rupture identifiée ;
   * unverified = plafond atteint avant la fin — l'appelant peut continuer avec
   * (nextAfterId, nextSeed). AUCUNE réparation n'existe, ni ici ni ailleurs dans l'API.
   */
  async checkIntegrity(
    tenantId: string,
    actorUserId: string,
    opts: { maxRows: number; afterId: string | null; seed: string | null },
  ): Promise<IntegrityOutcome> {
    return this.prisma.withTenant<IntegrityOutcome>(tenantId, async (tx) => {
      let checked = 0;
      let after = opts.afterId ?? '0';
      let seed = opts.seed;
      let lastId: string | null = opts.afterId;
      let outcome: IntegrityOutcome | null = null;

      while (checked < opts.maxRows) {
        const lim = Math.min(SEGMENT_SIZE, opts.maxRows - checked);
        const seg = (await tx.$queryRaw<Array<{
          broken_id: string | null; checked: number; last_id: string; last_hash: string | null;
        }>>`
          SELECT broken_id::text AS broken_id, checked, last_id::text AS last_id, last_hash
            FROM audit.verify_chain_segment(${tenantId}::uuid, ${after}::bigint, ${seed}, ${lim})`)[0]!;
        checked += seg.checked;
        if (seg.checked > 0) lastId = seg.last_id;
        if (seg.broken_id !== null) {
          outcome = { status: 'broken', checked, lastId, brokenAtId: seg.broken_id };
          break;
        }
        if (seg.checked < lim) {
          outcome = { status: 'valid', checked, lastId };
          break;
        }
        after = seg.last_id;
        seed = seg.last_hash;
      }
      if (!outcome) {
        outcome = {
          status: 'unverified', checked, lastId,
          nextAfterId: lastId ?? '0', nextSeed: seed ?? undefined,
        };
      }
      await auditAuth(tx, tenantId, {
        action: 'audit_integrity_checked', actorUserId, module: 'audit', recordType: 'audit_log',
        reason: `status=${outcome.status};checked=${outcome.checked}${outcome.brokenAtId ? `;broken_at=${outcome.brokenAtId}` : ''}`,
        result: outcome.status === 'broken' ? 'failure' : 'success',
      });
      return outcome;
    });
  }

  // ---------- export (permission dédiée, borné à la visibilité, audité) ----------

  async exportEvents(
    tenantId: string,
    actorUserId: string,
    filters: AuditFilters,
    format: 'csv' | 'json',
    limit: number,
  ): Promise<ExportOutcome> {
    return this.prisma.withTenant<ExportOutcome>(tenantId, async (tx) => {
      const access = await this.accessFor(tx, actorUserId);
      if (!access.any) return { kind: 'forbidden' };
      const rows = await this.queryEvents(tx, access, actorUserId, filters, {
        beforeId: null, limit, withValues: true,
      });
      const items = rows.map((r) => this.toApi(r, true));
      await auditAuth(tx, tenantId, {
        action: 'audit_exported', actorUserId, module: 'audit', recordType: 'audit_log',
        reason: `format=${format};rows=${items.length};${filtersDigest({ ...filters })}`.slice(0, 300),
        result: 'success',
      });
      if (format === 'json') return { kind: 'ok', count: items.length, items };
      const columns = ['id', 'occurredAt', 'actorUserId', 'onBehalfOf', 'module', 'action', 'recordType',
        'recordId', 'employeeId', 'result', 'correlationId', 'workflowRef', 'reason', 'oldValue', 'newValue'];
      return { kind: 'ok', count: items.length, csv: toCsv(columns, items as Array<Record<string, unknown>>) };
    });
  }
}
