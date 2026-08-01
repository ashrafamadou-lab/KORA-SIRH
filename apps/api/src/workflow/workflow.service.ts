import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { auditAuth } from '../auth/audit.util';
import {
  resolveTransition,
  type WorkflowAction,
  type WorkflowStatus,
} from '../../../../packages/core/src/workflow-machine.ts';
import {
  firstActiveStepFrom,
  isLastEffectiveStep,
  type WorkflowStepDef,
  type WorkflowContext,
} from '../../../../packages/core/src/workflow-conditions.ts';
import {
  canDecide,
  canDelegate,
  type ActorContext,
} from '../../../../packages/core/src/workflow-authz.ts';

export interface ActorIdentity {
  userId: string;
  roleKeys: string[];
  scopes: Array<{ type: string; ref: string | null }>;
}

type DecisionAction = Extract<WorkflowAction, 'approve' | 'reject' | 'return'>;

export type CreateDefinitionOutcome =
  | { kind: 'ok'; id: string; version: number }
  | { kind: 'invalid'; reason: string };

export type ActivateOutcome = { kind: 'ok' } | { kind: 'not_draft' } | { kind: 'not_found' };

export type SubmitOutcome =
  | { kind: 'ok'; instanceId: string; status: WorkflowStatus; currentStepIndex: number | null }
  | { kind: 'no_active_definition' }
  | { kind: 'empty_workflow' };

export type ActOutcome =
  | { kind: 'ok'; status: WorkflowStatus; currentStepIndex: number | null; transitionSeq: number }
  | { kind: 'not_found' }
  | { kind: 'stale' }         // l'instance a déjà avancé (concurrence) — aucune 2e transition
  | { kind: 'forbidden'; reason: string }
  | { kind: 'invalid'; reason: string };

interface InstanceRow {
  id: string;
  status: WorkflowStatus;
  current_step_index: number;
  steps_snapshot: WorkflowStepDef[];
  context: WorkflowContext;
  revision: number;
  delegated_to_user_id: string | null;
  created_by: string;
  subject_type: string;
  subject_id: string;
}

/**
 * Moteur de workflow générique (E3). Toute action décisionnelle prend un SELECT ... FOR
 * UPDATE sur la ligne d'instance : deux actions concurrentes se sérialisent, la seconde
 * observe l'état avancé et retourne `stale` (aucune double transition). L'idempotency_key
 * rejoue le même résultat sans nouvelle transition. Discipline transactionnelle : les
 * callbacks withTenant retournent des résultats ; les exceptions HTTP sont côté contrôleur.
 */
@Injectable()
export class WorkflowService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------- Définitions ----------

  async createDefinition(
    tenantId: string,
    actorUserId: string,
    input: { key: string; name: string; steps: WorkflowStepDef[] },
  ): Promise<CreateDefinitionOutcome> {
    if (!/^[a-z0-9_]+$/.test(input.key)) return { kind: 'invalid', reason: 'clé invalide' };
    if (!Array.isArray(input.steps) || input.steps.length === 0) {
      return { kind: 'invalid', reason: 'au moins une étape requise' };
    }
    for (const [i, s] of input.steps.entries()) {
      if (s.index !== i) return { kind: 'invalid', reason: `index d'étape incohérent en position ${i}` };
      if (!['role', 'user', 'manager', 'scope'].includes(s.approverType)) {
        return { kind: 'invalid', reason: `approverType invalide à l'étape ${i}` };
      }
    }
    return this.prisma.withTenant<CreateDefinitionOutcome>(tenantId, async (tx) => {
      const max = await tx.$queryRaw<Array<{ v: number | null }>>`
        SELECT max(version) AS v FROM workflow.definitions WHERE key = ${input.key}`;
      const version = (max[0]?.v ?? 0) + 1;
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO workflow.definitions (tenant_id, key, version, name, steps, created_by)
        VALUES (${tenantId}::uuid, ${input.key}, ${version}, ${input.name},
                ${JSON.stringify(input.steps)}::jsonb, ${actorUserId}::uuid)
        RETURNING id`;
      await auditAuth(tx, tenantId, {
        action: 'workflow_definition_created', actorUserId, recordId: rows[0]!.id,
        reason: `${input.key} v${version}`, module: 'workflow',
      });
      return { kind: 'ok', id: rows[0]!.id, version };
    });
  }

  /** Active une définition draft ; supersède l'active précédente de la même clé, s'il y en a. */
  async activateDefinition(tenantId: string, actorUserId: string, definitionId: string): Promise<ActivateOutcome> {
    return this.prisma.withTenant<ActivateOutcome>(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ status: string; key: string }>>`
        SELECT status, key FROM workflow.definitions WHERE id = ${definitionId}::uuid FOR UPDATE`;
      const def = rows[0];
      if (!def) return { kind: 'not_found' };
      if (def.status !== 'draft') return { kind: 'not_draft' };
      await tx.$executeRaw`
        UPDATE workflow.definitions SET status = 'superseded'
         WHERE key = ${def.key} AND status = 'active'`;
      await tx.$executeRaw`
        UPDATE workflow.definitions SET status = 'active', activated_at = now()
         WHERE id = ${definitionId}::uuid`;
      await auditAuth(tx, tenantId, {
        action: 'workflow_definition_activated', actorUserId, recordId: definitionId,
        reason: `${def.key}`, module: 'workflow',
      });
      return { kind: 'ok' };
    });
  }

  // ---------- Instances ----------

  async submit(
    tenantId: string,
    actorUserId: string,
    input: { definitionKey: string; subjectType: string; subjectId: string; context?: WorkflowContext },
  ): Promise<SubmitOutcome> {
    return this.prisma.withTenant<SubmitOutcome>(tenantId, async (tx) => {
      const defs = await tx.$queryRaw<Array<{ id: string; version: number; steps: WorkflowStepDef[] }>>`
        SELECT id, version, steps FROM workflow.definitions
         WHERE key = ${input.definitionKey} AND status = 'active'`;
      const def = defs[0];
      if (!def) return { kind: 'no_active_definition' };

      const context = input.context ?? {};
      const firstIndex = firstActiveStepFrom(def.steps, context, 0);
      if (firstIndex === null) return { kind: 'empty_workflow' };

      const deadline = this.deadlineFor(def.steps[firstIndex]!);
      const inst = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO workflow.instances
          (tenant_id, definition_id, definition_key, definition_version, steps_snapshot,
           subject_type, subject_id, status, current_step_index, context, step_entered_at, step_deadline, created_by)
        VALUES (${tenantId}::uuid, ${def.id}::uuid, ${input.definitionKey}, ${def.version},
                ${JSON.stringify(def.steps)}::jsonb, ${input.subjectType}, ${input.subjectId}::uuid,
                'pending', ${firstIndex}, ${JSON.stringify(context)}::jsonb, now(),
                ${deadline}::timestamptz, ${actorUserId}::uuid)
        RETURNING id`;
      const instanceId = inst[0]!.id;
      await this.appendTransition(tx, tenantId, instanceId, 1, {
        action: 'submit', fromStatus: null, toStatus: 'pending', stepIndex: firstIndex, actorUserId,
      });
      await this.syncSubject(tx, input.subjectType, input.subjectId, 'pending');
      await auditAuth(tx, tenantId, {
        action: 'workflow_submitted', actorUserId, recordId: instanceId,
        reason: `${input.definitionKey}`, module: 'workflow',
      });
      return { kind: 'ok', instanceId, status: 'pending', currentStepIndex: firstIndex };
    });
  }

  /** approve / reject / return — sous verrou d'instance, avec idempotence et anti-concurrence. */
  async decide(
    tenantId: string,
    actor: ActorIdentity,
    instanceId: string,
    action: DecisionAction,
    opts: { comment?: string; attachments?: unknown; idempotencyKey?: string; expectedRevision?: number } = {},
  ): Promise<ActOutcome> {
    return this.prisma.withTenant<ActOutcome>(tenantId, async (tx) => {
      const replay = await this.replayIfSeen(tx, instanceId, opts.idempotencyKey);
      if (replay) return replay;

      const inst = await this.lockInstance(tx, instanceId);
      if (!inst) return { kind: 'not_found' };

      // Garde optimiste explicite (double validation « à l'ancien état »).
      if (opts.expectedRevision !== undefined && opts.expectedRevision !== inst.revision) {
        return { kind: 'stale' };
      }
      if (inst.status !== 'pending') {
        // Déjà décidée/avancée : pas d'erreur dure, mais aucune nouvelle transition.
        return { kind: 'stale' };
      }

      const step = inst.steps_snapshot[inst.current_step_index];
      if (!step) return { kind: 'invalid', reason: 'étape courante introuvable' };

      const authz = canDecide(this.toActor(actor), {
        step, instanceContext: inst.context, createdBy: inst.created_by,
        delegatedToUserId: inst.delegated_to_user_id,
      });
      if (!authz.allowed) return { kind: 'forbidden', reason: authz.reason };

      const last = isLastEffectiveStep(inst.steps_snapshot, inst.context, inst.current_step_index);
      const transition = resolveTransition({ status: 'pending', action, isLastEffectiveStep: last });
      if (!transition.ok) return { kind: 'invalid', reason: transition.reason };

      let nextIndex = inst.current_step_index;
      let deadline: Date | null = null;
      if (transition.advancesStep) {
        const following = firstActiveStepFrom(inst.steps_snapshot, inst.context, inst.current_step_index + 1);
        // isLastEffectiveStep=false garantit un suivant ; garde défensive :
        if (following === null) return { kind: 'invalid', reason: 'incohérence de branche' };
        nextIndex = following;
        deadline = this.deadlineFor(inst.steps_snapshot[following]!);
      }

      const seq = await this.nextSeq(tx, instanceId);
      const finalIndex = transition.nextStatus === 'pending' && transition.advancesStep ? nextIndex : inst.current_step_index;
      await tx.$executeRaw`
        UPDATE workflow.instances
           SET status = ${transition.nextStatus},
               current_step_index = ${finalIndex},
               revision = revision + 1,
               delegated_to_user_id = NULL,
               step_entered_at = CASE WHEN ${transition.advancesStep} THEN now() ELSE step_entered_at END,
               step_deadline = ${deadline}::timestamptz,
               reminder_sent_at = NULL,
               decided_at = CASE WHEN ${transition.nextStatus} <> 'pending' THEN now() ELSE decided_at END
         WHERE id = ${instanceId}::uuid`;
      await this.appendTransition(tx, tenantId, instanceId, seq, {
        action, fromStatus: 'pending', toStatus: transition.nextStatus,
        stepIndex: inst.current_step_index, actorUserId: actor.userId,
        comment: opts.comment, attachments: opts.attachments,
      });
      if (transition.nextStatus === 'approved') await this.syncSubject(tx, inst.subject_type, inst.subject_id, 'approved');
      if (transition.nextStatus === 'rejected') await this.syncSubject(tx, inst.subject_type, inst.subject_id, 'rejected');

      await auditAuth(tx, tenantId, {
        action: `workflow_${action}`, actorUserId: actor.userId, recordId: instanceId,
        reason: transition.nextStatus, module: 'workflow',
      });

      const result: ActOutcome = {
        kind: 'ok', status: transition.nextStatus,
        currentStepIndex: transition.nextStatus === 'pending' ? finalIndex : null, transitionSeq: seq,
      };
      await this.recordIdempotency(tx, tenantId, instanceId, opts.idempotencyKey, seq, result);
      return result;
    });
  }

  async cancel(
    tenantId: string, actor: ActorIdentity, instanceId: string,
    opts: { comment?: string; idempotencyKey?: string } = {},
  ): Promise<ActOutcome> {
    return this.prisma.withTenant<ActOutcome>(tenantId, async (tx) => {
      const replay = await this.replayIfSeen(tx, instanceId, opts.idempotencyKey);
      if (replay) return replay;
      const inst = await this.lockInstance(tx, instanceId);
      if (!inst) return { kind: 'not_found' };
      if (inst.status !== 'pending' && inst.status !== 'returned') return { kind: 'stale' };
      // Seuls le demandeur ou un acteur assigné peuvent annuler.
      const assigned = canDelegate(this.toActor(actor), {
        step: inst.steps_snapshot[inst.current_step_index]!, instanceContext: inst.context,
        createdBy: inst.created_by, delegatedToUserId: inst.delegated_to_user_id,
      }).allowed;
      if (actor.userId !== inst.created_by && !assigned) {
        return { kind: 'forbidden', reason: 'annulation réservée au demandeur ou à un acteur assigné' };
      }
      const seq = await this.nextSeq(tx, instanceId);
      await tx.$executeRaw`
        UPDATE workflow.instances
           SET status = 'cancelled', revision = revision + 1, decided_at = now(), step_deadline = NULL
         WHERE id = ${instanceId}::uuid`;
      await this.appendTransition(tx, tenantId, instanceId, seq, {
        action: 'cancel', fromStatus: inst.status, toStatus: 'cancelled',
        stepIndex: inst.current_step_index, actorUserId: actor.userId, comment: opts.comment,
      });
      await this.syncSubject(tx, inst.subject_type, inst.subject_id, 'cancelled');
      await auditAuth(tx, tenantId, { action: 'workflow_cancel', actorUserId: actor.userId, recordId: instanceId, module: 'workflow' });
      const result: ActOutcome = { kind: 'ok', status: 'cancelled', currentStepIndex: null, transitionSeq: seq };
      await this.recordIdempotency(tx, tenantId, instanceId, opts.idempotencyKey, seq, result);
      return result;
    });
  }

  /** Réassigne l'étape courante à un utilisateur précis (traçé « par X pour le compte de Y »). */
  async delegate(
    tenantId: string, actor: ActorIdentity, instanceId: string,
    toUserId: string, opts: { comment?: string } = {},
  ): Promise<ActOutcome> {
    return this.prisma.withTenant<ActOutcome>(tenantId, async (tx) => {
      const inst = await this.lockInstance(tx, instanceId);
      if (!inst) return { kind: 'not_found' };
      if (inst.status !== 'pending') return { kind: 'stale' };
      const step = inst.steps_snapshot[inst.current_step_index]!;
      const authz = canDelegate(this.toActor(actor), {
        step, instanceContext: inst.context, createdBy: inst.created_by, delegatedToUserId: inst.delegated_to_user_id,
      });
      if (!authz.allowed) return { kind: 'forbidden', reason: authz.reason };
      const target = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM admin.users WHERE id = ${toUserId}::uuid AND deleted_at IS NULL AND is_active`;
      if (target.length === 0) return { kind: 'invalid', reason: 'délégataire inconnu ou inactif' };

      const seq = await this.nextSeq(tx, instanceId);
      await tx.$executeRaw`
        UPDATE workflow.instances SET delegated_to_user_id = ${toUserId}::uuid, revision = revision + 1
         WHERE id = ${instanceId}::uuid`;
      await this.appendTransition(tx, tenantId, instanceId, seq, {
        action: 'delegate', fromStatus: 'pending', toStatus: 'pending',
        stepIndex: inst.current_step_index, actorUserId: actor.userId, onBehalfOf: toUserId, comment: opts.comment,
      });
      await auditAuth(tx, tenantId, {
        action: 'workflow_delegate', actorUserId: actor.userId, recordId: instanceId,
        reason: `to=${toUserId}`, module: 'workflow',
      });
      return { kind: 'ok', status: 'pending', currentStepIndex: inst.current_step_index, transitionSeq: seq };
    });
  }

  /**
   * Balayage des échéances (relances + escalades). Appelé par un déclencheur planifié en
   * production ; ici exposé comme opération pour être testable. Émet des transitions
   * 'remind' (à reminder_hours) et 'escalate'/'expired' (à échéance dépassée).
   */
  async tick(tenantId: string): Promise<{ reminded: number; escalated: number }> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const due = await tx.$queryRaw<Array<{ id: string; current_step_index: number; steps_snapshot: WorkflowStepDef[] }>>`
        SELECT id, current_step_index, steps_snapshot
          FROM workflow.instances
         WHERE status = 'pending' AND step_deadline IS NOT NULL AND step_deadline <= now()
         FOR UPDATE SKIP LOCKED`;
      let escalated = 0;
      for (const row of due) {
        const seq = await this.nextSeq(tx, row.id);
        await this.appendTransition(tx, tenantId, row.id, seq, {
          action: 'escalate', fromStatus: 'pending', toStatus: 'pending',
          stepIndex: row.current_step_index, actorUserId: null, comment: 'échéance dépassée',
        });
        await tx.$executeRaw`
          UPDATE workflow.instances SET escalated_at = now(), revision = revision + 1
           WHERE id = ${row.id}::uuid`;
        await auditAuth(tx, tenantId, { action: 'workflow_escalate', recordId: row.id, reason: 'sla_breach', module: 'workflow' });
        escalated++;
      }
      // Relances : deadline non encore atteinte mais fenêtre de rappel franchie.
      const remind = await tx.$queryRaw<Array<{ id: string; current_step_index: number }>>`
        UPDATE workflow.instances i
           SET reminder_sent_at = now(), revision = revision + 1
         WHERE i.status = 'pending' AND i.reminder_sent_at IS NULL
           AND i.step_deadline IS NOT NULL AND i.step_deadline > now()
           AND (i.steps_snapshot -> i.current_step_index ->> 'reminderHours') IS NOT NULL
           AND now() >= i.step_entered_at
                 + make_interval(hours => (i.steps_snapshot -> i.current_step_index ->> 'reminderHours')::int)
        RETURNING i.id, i.current_step_index`;
      for (const row of remind) {
        const seq = await this.nextSeq(tx, row.id);
        await this.appendTransition(tx, tenantId, row.id, seq, {
          action: 'remind', fromStatus: 'pending', toStatus: 'pending',
          stepIndex: row.current_step_index, actorUserId: null, comment: 'relance',
        });
      }
      return { reminded: remind.length, escalated };
    });
  }

  // ---------- privé ----------

  private toActor(a: ActorIdentity): ActorContext {
    return { userId: a.userId, roleKeys: a.roleKeys, scopes: a.scopes.map((s) => ({ type: s.type as ActorContext['scopes'][number]['type'], ref: s.ref })) };
  }

  private deadlineFor(step: WorkflowStepDef): Date | null {
    if (!step.slaHours || step.slaHours <= 0) return null;
    return new Date(Date.now() + step.slaHours * 3600 * 1000);
  }

  private async lockInstance(tx: Prisma.TransactionClient, instanceId: string): Promise<InstanceRow | null> {
    const rows = await tx.$queryRaw<InstanceRow[]>`
      SELECT id, status, current_step_index, steps_snapshot, context, revision,
             delegated_to_user_id, created_by, subject_type, subject_id
        FROM workflow.instances WHERE id = ${instanceId}::uuid FOR UPDATE`;
    return rows[0] ?? null;
  }

  private async nextSeq(tx: Prisma.TransactionClient, instanceId: string): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ seq: number }>>`
      SELECT COALESCE(max(seq), 0) + 1 AS seq FROM workflow.transitions WHERE instance_id = ${instanceId}::uuid`;
    return rows[0]!.seq;
  }

  private async appendTransition(
    tx: Prisma.TransactionClient, tenantId: string, instanceId: string, seq: number,
    t: { action: WorkflowAction | 'submit'; fromStatus: string | null; toStatus: string | null;
         stepIndex: number | null; actorUserId: string | null; onBehalfOf?: string | null;
         comment?: string; attachments?: unknown },
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO workflow.transitions
        (tenant_id, instance_id, seq, action, from_status, to_status, step_index, actor_user_id, on_behalf_of, comment, attachments)
      VALUES (${tenantId}::uuid, ${instanceId}::uuid, ${seq}, ${t.action}, ${t.fromStatus}, ${t.toStatus},
              ${t.stepIndex}, ${t.actorUserId}::uuid, ${t.onBehalfOf ?? null}::uuid, ${t.comment ?? null},
              ${t.attachments ? JSON.stringify(t.attachments) : null}::jsonb)`;
  }

  private async replayIfSeen(
    tx: Prisma.TransactionClient, instanceId: string, key: string | undefined,
  ): Promise<ActOutcome | null> {
    if (!key) return null;
    const rows = await tx.$queryRaw<Array<{ result: ActOutcome }>>`
      SELECT result FROM workflow.action_idempotency
       WHERE instance_id = ${instanceId}::uuid AND idempotency_key = ${key}`;
    return rows[0]?.result ?? null;
  }

  private async recordIdempotency(
    tx: Prisma.TransactionClient, tenantId: string, instanceId: string,
    key: string | undefined, seq: number, result: ActOutcome,
  ): Promise<void> {
    if (!key) return;
    await tx.$executeRaw`
      INSERT INTO workflow.action_idempotency (tenant_id, instance_id, idempotency_key, transition_seq, result)
      VALUES (${tenantId}::uuid, ${instanceId}::uuid, ${key}, ${seq}, ${JSON.stringify(result)}::jsonb)
      ON CONFLICT (instance_id, idempotency_key) DO NOTHING`;
  }

  /**
   * Effet métier générique à l'atteinte d'un état. Le sujet EST l'objet métier exact
   * (sa version, pour un paramètre) : la décision du workflow est donc liée à la version
   * précise concernée. Deux consommateurs v1 : l'objet de démonstration et le Config
   * Center (le lien E3→E4 du contreseing).
   */
  private async syncSubject(
    tx: Prisma.TransactionClient, subjectType: string, subjectId: string, status: string,
  ): Promise<void> {
    if (subjectType === 'demo_request') {
      await tx.$executeRaw`
        UPDATE workflow.demo_requests SET status = ${status} WHERE id = ${subjectId}::uuid`;
      return;
    }
    if (subjectType === 'legal_parameter' || subjectType === 'parameter') {
      // Le contreseing pilote le cycle de vie de la version : submitted → approved/rejected,
      // cancelled → retour en draft (resoumission). On ne touche jamais une version déjà
      // active/scheduled/superseded.
      const paramStatus =
        status === 'approved' ? 'approved' : status === 'rejected' ? 'rejected' : status === 'cancelled' ? 'draft' : null;
      if (!paramStatus) return;
      await tx.$executeRaw`
        UPDATE compliance.legal_parameters SET status = ${paramStatus}
         WHERE id = ${subjectId}::uuid AND status IN ('submitted', 'approved')`;
    }
  }
}
