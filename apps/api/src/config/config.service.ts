import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { auditAuth } from '../auth/audit.util';
import { WorkflowService } from '../workflow/workflow.service';
import {
  activationAllowed,
  activationStatusFor,
} from '../../../../packages/core/src/parameter-lifecycle.ts';

export interface CreateDraftInput {
  key: string;
  value: unknown;
  unit?: string | null;
  countryCode?: string;
  effectiveFrom: string;      // YYYY-MM-DD
  sourceText?: string | null;
  sourceUrl?: string | null;
  legalRef?: string | null;
  notes?: string | null;
  isLegalSensitive?: boolean;  // défaut true (contrôles renforcés)
}

export type CreateOutcome = { kind: 'ok'; id: string } | { kind: 'forbidden'; reason: string } | { kind: 'invalid'; reason: string };
export type SubmitOutcome =
  | { kind: 'ok'; instanceId: string }
  | { kind: 'forbidden'; reason: string }
  | { kind: 'not_found' }
  | { kind: 'bad_state'; status: string }
  | { kind: 'no_workflow' };
export type ActivateOutcome =
  | { kind: 'ok'; status: 'active' | 'scheduled' }
  | { kind: 'forbidden'; reason: string }
  | { kind: 'not_found' }
  | { kind: 'not_approved'; status: string }
  | { kind: 'no_countersign' }
  | { kind: 'conflict'; reason: string };

interface ParamRow {
  id: string;
  tenant_id: string | null;
  key: string;
  country_code: string;
  value: unknown;
  effective_from: string;
  status: string;
  is_legal_sensitive: boolean;
  source_text: string | null;
  created_by: string | null;
  workflow_instance_id: string | null;
}

/**
 * Config Center (E4). Gère les paramètres DU TENANT (tenant_id = tenant courant) : la RLS
 * de 0006 réserve l'écriture au périmètre du tenant — les paramètres globaux (pays) restent
 * en lecture seule et surchargeables, ce qui garantit structurellement qu'une surcharge
 * tenant ne modifie jamais la valeur globale. Contreseing délégué au Workflow Engine (E3).
 * Discipline transactionnelle : résultats retournés, exceptions HTTP côté contrôleur.
 */
@Injectable()
export class ConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workflow: WorkflowService,
  ) {}

  private permFor(action: 'create' | 'submit' | 'activate', legal: boolean): string {
    return `${legal ? 'legal_parameters' : 'parameters'}.${action}`;
  }

  private async hasPermission(tx: Prisma.TransactionClient, userId: string, key: string): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n
        FROM admin.user_roles ur JOIN admin.role_permissions rp ON rp.role_id = ur.role_id
       WHERE ur.user_id = ${userId}::uuid AND rp.permission_key = ${key}`;
    return (rows[0]?.n ?? 0) > 0;
  }

  // ---------- Création ----------

  async createDraft(tenantId: string, actorUserId: string, input: CreateDraftInput): Promise<CreateOutcome> {
    const legal = input.isLegalSensitive !== false;
    if (!/^[a-z0-9_]+(\.[a-z0-9_]+)+$/.test(input.key)) return { kind: 'invalid', reason: 'clé invalide' };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom)) return { kind: 'invalid', reason: 'date d’effet invalide' };
    // Un paramètre juridique exige une source dès le draft (le contreseing la vérifiera).
    if (legal && !input.sourceText) return { kind: 'invalid', reason: 'source requise pour un paramètre juridique' };

    return this.prisma.withTenant<CreateOutcome>(tenantId, async (tx) => {
      if (!(await this.hasPermission(tx, actorUserId, this.permFor('create', legal)))) {
        return { kind: 'forbidden', reason: `permission ${this.permFor('create', legal)} requise` };
      }
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO compliance.legal_parameters
          (tenant_id, country_code, key, value, unit, effective_from, source_text, source_url,
           legal_ref, notes, is_legal_sensitive, status, created_by)
        VALUES (${tenantId}::uuid, ${input.countryCode ?? 'BJ'}, ${input.key},
                ${JSON.stringify(input.value)}::jsonb, ${input.unit ?? null},
                ${input.effectiveFrom}::date, ${input.sourceText ?? null}, ${input.sourceUrl ?? null},
                ${input.legalRef ?? null}, ${input.notes ?? null}, ${legal}, 'draft', ${actorUserId}::uuid)
        RETURNING id`;
      await auditAuth(tx, tenantId, {
        action: 'parameter_created', actorUserId, recordId: rows[0]!.id,
        reason: `${input.key}`, module: 'config',
      });
      return { kind: 'ok', id: rows[0]!.id };
    });
  }

  // ---------- Soumission au contreseing (via E3) ----------

  async submit(tenantId: string, actorUserId: string, parameterId: string, definitionKey: string): Promise<SubmitOutcome> {
    const param = await this.load(tenantId, parameterId);
    if (!param) return { kind: 'not_found' };
    if (param.status !== 'draft') return { kind: 'bad_state', status: param.status };

    const permCheck = await this.prisma.withTenant(tenantId, (tx) =>
      this.hasPermission(tx, actorUserId, this.permFor('submit', param.is_legal_sensitive)));
    if (!permCheck) return { kind: 'forbidden', reason: `permission ${this.permFor('submit', param.is_legal_sensitive)} requise` };

    // Le sujet du workflow EST la version exacte du paramètre : la décision y est liée.
    const wf = await this.workflow.submit(tenantId, actorUserId, {
      definitionKey,
      subjectType: 'legal_parameter',
      subjectId: parameterId,
      context: { key: param.key, isLegalSensitive: param.is_legal_sensitive },
    });
    if (wf.kind !== 'ok') return { kind: 'no_workflow' };

    await this.prisma.withTenant(tenantId, async (tx) => {
      await tx.$executeRaw`
        UPDATE compliance.legal_parameters
           SET status = 'submitted', submitted_by = ${actorUserId}::uuid, workflow_instance_id = ${wf.instanceId}::uuid
         WHERE id = ${parameterId}::uuid AND status = 'draft'`;
      await auditAuth(tx, tenantId, {
        action: 'parameter_submitted', actorUserId, recordId: parameterId,
        reason: `wf=${wf.instanceId}`, module: 'config',
      });
    });
    return { kind: 'ok', instanceId: wf.instanceId };
  }

  // ---------- Activation (active immédiate ou planifiée) ----------

  async activate(tenantId: string, actorUserId: string, parameterId: string, today: string): Promise<ActivateOutcome> {
    return this.prisma.withTenant<ActivateOutcome>(tenantId, async (tx) => {
      // Sérialise les activations concurrentes de la même portée (clé+pays).
      const param = await this.lockParam(tx, parameterId);
      if (!param) return { kind: 'not_found' };
      if (param.status !== 'approved') return { kind: 'not_approved', status: param.status };

      if (!(await this.hasPermission(tx, actorUserId, this.permFor('activate', param.is_legal_sensitive)))) {
        return { kind: 'forbidden', reason: `permission ${this.permFor('activate', param.is_legal_sensitive)} requise` };
      }
      // Séparation des tâches : le créateur ne peut pas activer son propre paramètre juridique.
      const sep = activationAllowed({ createdBy: param.created_by ?? '', actorUserId, isLegalSensitive: param.is_legal_sensitive });
      if (!sep.allowed) return { kind: 'forbidden', reason: sep.reason! };

      // Contreseing : l'instance de workflow liée doit être approuvée ; on en tire le
      // vérificateur (dernière approbation) — décision liée à CETTE version.
      if (!param.workflow_instance_id) return { kind: 'no_countersign' };
      const wf = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT status FROM workflow.instances WHERE id = ${param.workflow_instance_id}::uuid`;
      if (wf[0]?.status !== 'approved') return { kind: 'no_countersign' };
      const approver = await tx.$queryRaw<Array<{ actor_user_id: string | null; occurred_at: Date }>>`
        SELECT actor_user_id, occurred_at FROM workflow.transitions
         WHERE instance_id = ${param.workflow_instance_id}::uuid AND action = 'approve'
         ORDER BY seq DESC LIMIT 1`;
      const verifiedBy = approver[0]?.actor_user_id ?? actorUserId;

      await pgAdvisoryLock(tx, `${tenantId}:${param.key}:${param.country_code}`);

      // Fenêtre en vigueur ou planifiée existante pour la même portée (hors la version en cours).
      const current = await tx.$queryRaw<Array<{ id: string; effective_from: string }>>`
        SELECT id, effective_from::text FROM compliance.legal_parameters
         WHERE tenant_id = ${tenantId}::uuid AND key = ${param.key} AND country_code = ${param.country_code}
           AND status IN ('active', 'scheduled') AND deleted_at IS NULL
         FOR UPDATE`;
      if (current[0] && param.effective_from <= current[0].effective_from) {
        return { kind: 'conflict', reason: 'la date d’effet précède ou égale la version en vigueur' };
      }
      // Fermer proprement la version courante à la nouvelle date d'effet (sans réécrire son
      // contenu ni son historique) AVANT d'ouvrir la nouvelle (anti-chevauchement).
      const newStatus = activationStatusFor(param.effective_from, today);
      if (current[0]) {
        const closeStatus = newStatus === 'active' ? 'superseded' : 'active';
        await tx.$executeRaw`
          UPDATE compliance.legal_parameters
             SET effective_to = ${param.effective_from}::date, status = ${closeStatus}
           WHERE id = ${current[0].id}::uuid`;
      }
      await tx.$executeRaw`
        UPDATE compliance.legal_parameters
           SET status = ${newStatus}, activated_by = ${actorUserId}::uuid, activated_at = now(),
               approved_by = ${verifiedBy}::uuid, verified_by = ${verifiedBy}, verified_at = ${today}::date,
               confidence = 'verified'
         WHERE id = ${parameterId}::uuid`;
      await auditAuth(tx, tenantId, {
        action: newStatus === 'active' ? 'parameter_activated' : 'parameter_scheduled',
        actorUserId, recordId: parameterId, reason: `effet ${param.effective_from}`, module: 'config',
      });
      return { kind: 'ok', status: newStatus };
    });
  }

  /** Promotion des versions planifiées dont la date d'effet est atteinte (tick). */
  async promoteScheduled(tenantId: string, today: string): Promise<{ promoted: number }> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; key: string; country_code: string; effective_from: string }>>`
        SELECT id, key, country_code, effective_from::text FROM compliance.legal_parameters
         WHERE tenant_id = ${tenantId}::uuid AND status = 'scheduled' AND effective_from <= ${today}::date
         FOR UPDATE SKIP LOCKED`;
      for (const r of rows) {
        // Superséder toute version encore active de la même portée dont la fenêtre se termine.
        await tx.$executeRaw`
          UPDATE compliance.legal_parameters SET status = 'superseded'
           WHERE tenant_id = ${tenantId}::uuid AND key = ${r.key} AND country_code = ${r.country_code}
             AND status = 'active' AND effective_to IS NOT NULL AND effective_to <= ${today}::date`;
        await tx.$executeRaw`UPDATE compliance.legal_parameters SET status = 'active' WHERE id = ${r.id}::uuid`;
      }
      return { promoted: rows.length };
    });
  }

  // ---------- Rejet workflow → resoumission ----------
  // (Le passage submitted→approved/rejected est piloté par E3 via syncSubject. Ici on
  //  permet au demandeur de repartir d'un draft après rejet.)
  async resetToDraft(tenantId: string, actorUserId: string, parameterId: string): Promise<{ kind: 'ok' } | { kind: 'not_found' } | { kind: 'bad_state'; status: string }> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT status FROM compliance.legal_parameters WHERE id = ${parameterId}::uuid FOR UPDATE`;
      const st = rows[0]?.status;
      if (!st) return { kind: 'not_found' as const };
      if (st !== 'rejected') return { kind: 'bad_state' as const, status: st };
      await tx.$executeRaw`UPDATE compliance.legal_parameters SET status = 'draft', workflow_instance_id = NULL WHERE id = ${parameterId}::uuid`;
      await auditAuth(tx, tenantId, { action: 'parameter_reset_draft', actorUserId, recordId: parameterId, module: 'config' });
      return { kind: 'ok' as const };
    });
  }

  // ---------- Lectures ----------

  resolveAt(tenantId: string, key: string, country: string, date: string): Promise<unknown> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT * FROM compliance.parameter_value_at(${key}, ${country}::char(2), ${tenantId}::uuid, ${date}::date)`;
      return rows[0] ?? null;
    });
  }

  history(tenantId: string, key: string, country: string): Promise<unknown[]> {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT id, value, unit, effective_from AS "effectiveFrom", effective_to AS "effectiveTo",
               status, source_text AS "sourceText", verified_by AS "verifiedBy", verified_at AS "verifiedAt",
               confidence, legal_ref AS "legalRef",
               CASE WHEN tenant_id IS NULL THEN 'country' ELSE 'tenant' END AS scope,
               created_by AS "createdBy", created_at AS "createdAt"
          FROM compliance.legal_parameters
         WHERE key = ${key} AND country_code = ${country}::char(2)
           AND (tenant_id IS NULL OR tenant_id = ${tenantId}::uuid) AND deleted_at IS NULL
         ORDER BY effective_from, created_at`);
  }

  /**
   * Prévisualisation : ce qui est résolu AUJOURD'HUI à la date d'effet de la version, vs la
   * valeur candidate — pour voir l'impact avant activation.
   */
  async preview(tenantId: string, parameterId: string): Promise<unknown> {
    const param = await this.load(tenantId, parameterId);
    if (!param) return null;
    return this.prisma.withTenant(tenantId, async (tx) => {
      const current = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT value, status, effective_from AS "effectiveFrom"
          FROM compliance.parameter_value_at(${param.key}, ${param.country_code}::char(2), ${tenantId}::uuid, ${param.effective_from}::date)`;
      return {
        parameterId,
        key: param.key,
        effectiveFrom: param.effective_from,
        candidateValue: param.value,
        currentlyApplicableAtThatDate: current[0] ?? null,
      };
    });
  }

  // ---------- privé ----------

  private async load(tenantId: string, parameterId: string): Promise<ParamRow | null> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<ParamRow[]>`
        SELECT id, tenant_id, key, country_code, value, effective_from::text, status,
               is_legal_sensitive, source_text, created_by, workflow_instance_id
          FROM compliance.legal_parameters WHERE id = ${parameterId}::uuid`;
      return rows[0] ?? null;
    });
  }

  private async lockParam(tx: Prisma.TransactionClient, parameterId: string): Promise<ParamRow | null> {
    const rows = await tx.$queryRaw<ParamRow[]>`
      SELECT id, tenant_id, key, country_code, value, effective_from::text, status,
             is_legal_sensitive, source_text, created_by, workflow_instance_id
        FROM compliance.legal_parameters WHERE id = ${parameterId}::uuid FOR UPDATE`;
    return rows[0] ?? null;
  }
}

/** Verrou consultatif transactionnel par portée — sérialise les activations concurrentes. */
async function pgAdvisoryLock(tx: Prisma.TransactionClient, key: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}
