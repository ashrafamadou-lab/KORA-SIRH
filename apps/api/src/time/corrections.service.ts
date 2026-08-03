/**
 * E10.3 — Demandes de correction : création (ESS/manager/RH/admin/auto/import),
 * soumission VERSIONNÉE dans un circuit E3, décision liée à la version exacte
 * (le contenu d'une demande soumise est FIGÉ par la base), application IDEMPOTENTE
 * (une demande = au plus UN événement correctif — contrainte UNIQUE), recalcul
 * E10.2 motivé, diff avant/après, résolution automatique de l'anomalie liée,
 * pièces justificatives cloisonnées (accès journalisé), E5 + E6 complets.
 *
 * Une correction ne touche JAMAIS le brut : elle produit une SURCOUCHE approuvée
 * que le moteur consomme au recalcul. Si le recalcul échoue après approbation,
 * la demande reste explicitement 'approved' (en attente d'application) puis
 * 'application_failed' — jamais faussement « appliquée ».
 */
import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { auditAuth } from '../auth/audit.util';
import { NotificationService } from '../notify/notification.service';
import { WorkflowService, type ActorIdentity } from '../workflow/workflow.service';
import { CalcService } from './calc.service';
import { DATE_RE, holdsPermission, scopeSetFor, scopeCsv, type ScopeSet, type TimeOutcome } from './time-access';

const KINDS = [
  'add_in', 'add_out', 'fix_type', 'exclude_event', 'reattach_event', 'fix_site_device',
  'justify_absence', 'justify_late', 'justify_early_departure', 'offsite_presence',
  'reference_correction', 'import_historical',
] as const;
type CorrectionKind = typeof KINDS[number];

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const CATEGORY_RE = /^[a-z0-9_]{2,50}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CreateCorrectionInput {
  employeeId?: string;
  workDate: string;
  kind: string;
  motive: string;
  payload: Record<string, unknown>;
  anomalyId?: string;
}

@Injectable()
export class CorrectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notify: NotificationService,
    private readonly wf: WorkflowService,
    private readonly calc: CalcService,
  ) {
    // Pont E3 → E10.3 : la décision du workflow fait évoluer la DEMANDE dans la
    // même transaction. L'APPLICATION (événement correctif + recalcul) reste hors
    // de la transaction de décision — son échec ne peut pas annuler l'approbation.
    this.wf.registerSubjectHandler('time_correction', (tx, tenantId, subjectId, status) =>
      this.onWorkflowOutcome(tx, tenantId, subjectId, status));
  }

  // ==================================================================
  // Création (tous parcours) et validation par type
  // ==================================================================

  private validatePayload(kind: CorrectionKind, p: Record<string, unknown>): string | null {
    const timeOk = (v: unknown): boolean => typeof v === 'string' && TIME_RE.test(v);
    const uuidOk = (v: unknown): boolean => typeof v === 'string' && UUID_RE.test(v);
    switch (kind) {
      case 'add_in':
      case 'add_out':
        if (!timeOk(p['localTime'])) return 'payload.localTime : « HH:MM » requis';
        if (p['dayOffset'] !== undefined && p['dayOffset'] !== 0 && p['dayOffset'] !== 1) {
          return 'payload.dayOffset : 0 (le jour) ou 1 (le lendemain)';
        }
        return null;
      case 'fix_type':
        if (!uuidOk(p['eventId'])) return 'payload.eventId : UUID requis';
        if (p['newType'] !== 'in' && p['newType'] !== 'out') return 'payload.newType : in ou out';
        return null;
      case 'exclude_event':
        return uuidOk(p['eventId']) ? null : 'payload.eventId : UUID requis';
      case 'reattach_event':
        if (!uuidOk(p['eventId'])) return 'payload.eventId : UUID requis';
        if (typeof p['targetDate'] !== 'string' || !DATE_RE.test(p['targetDate'])) return 'payload.targetDate : AAAA-MM-JJ';
        return null;
      case 'fix_site_device':
        if (!uuidOk(p['eventId'])) return 'payload.eventId : UUID requis';
        if (p['siteId'] !== undefined && p['siteId'] !== null && !uuidOk(p['siteId'])) return 'payload.siteId : UUID';
        return null;
      case 'justify_absence':
      case 'justify_late':
      case 'justify_early_departure':
      case 'offsite_presence':
        if (typeof p['category'] !== 'string' || !CATEGORY_RE.test(p['category'])) {
          return 'payload.category : identifiant en minuscules (maladie, mission, formation…)';
        }
        if (p['minutes'] !== undefined && p['minutes'] !== null
          && (typeof p['minutes'] !== 'number' || !Number.isInteger(p['minutes']) || p['minutes'] < 0 || p['minutes'] > 1440)) {
          return 'payload.minutes : entier 0..1440';
        }
        return null;
      case 'reference_correction':
        if (p['referenceKind'] !== 'schedule' && p['referenceKind'] !== 'assignment') {
          return 'payload.referenceKind : schedule ou assignment';
        }
        return uuidOk(p['referenceId']) ? null : 'payload.referenceId : UUID de la version APPROUVÉE référencée';
      case 'import_historical':
        return 'import_historical passe par le point d\'entrée d\'import contrôlé';
      default:
        return 'type inconnu';
    }
  }

  /** Effet NORMALISÉ écrit dans l'événement correctif — miroir exact du payload validé. */
  private effectOf(kind: CorrectionKind, p: Record<string, unknown>): Record<string, unknown> {
    const minuteOf = (v: string, offset: unknown): number =>
      Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5)) + (offset === 1 ? 1440 : 0);
    switch (kind) {
      case 'add_in': return { addEvent: { localMinute: minuteOf(p['localTime'] as string, p['dayOffset']), type: 'in', siteId: p['siteId'] ?? null } };
      case 'add_out': return { addEvent: { localMinute: minuteOf(p['localTime'] as string, p['dayOffset']), type: 'out', siteId: p['siteId'] ?? null } };
      case 'fix_type': return { retype: { eventId: p['eventId'], type: p['newType'] } };
      case 'exclude_event': return { excludeEventId: p['eventId'] };
      case 'reattach_event': return { reattach: { eventId: p['eventId'], targetDate: p['targetDate'] } };
      case 'fix_site_device': return { overrideSite: { eventId: p['eventId'], siteId: p['siteId'] ?? null } };
      case 'justify_absence': return { justify: { target: 'absence', category: p['category'], minutes: p['minutes'] ?? null } };
      case 'justify_late': return { justify: { target: 'late', category: p['category'], minutes: p['minutes'] ?? null } };
      case 'justify_early_departure': return { justify: { target: 'early_departure', category: p['category'], minutes: p['minutes'] ?? null } };
      case 'offsite_presence': return { offsite: { category: p['category'], minutes: p['minutes'] ?? null } };
      case 'reference_correction': return { reference: { kind: p['referenceKind'], id: p['referenceId'] } };
      default: return {};
    }
  }

  private async linkedEmployee(tx: Prisma.TransactionClient, actor: string): Promise<string | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM core.employees WHERE user_id = ${actor}::uuid AND deleted_at IS NULL`;
    return rows[0]?.id ?? null;
  }

  private async scopeCovers(
    tx: Prisma.TransactionClient, set: ScopeSet, employeeId: string, date: string,
  ): Promise<boolean> {
    if (set.kind === 'all') return true;
    if (set.kind !== 'scoped') return false;
    const csv = scopeCsv(set);
    const rows = await tx.$queryRaw<Array<{ ok: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM core.employee_assignments a
                      WHERE a.employee_id = ${employeeId}::uuid AND a.is_primary
                        AND daterange(a.effective_from, a.effective_to, '[)') @> ${date}::date
                        AND (a.company_id = ANY(string_to_array(${csv.companies}, ',')::uuid[])
                          OR a.site_id    = ANY(string_to_array(${csv.sites}, ',')::uuid[])
                          OR a.unit_id    = ANY(string_to_array(${csv.units}, ',')::uuid[]))) AS ok`;
    return rows[0]?.ok === true;
  }

  async create(
    tenantId: string, actor: string, input: CreateCorrectionInput,
  ): Promise<TimeOutcome<{ id: string }>> {
    if (!DATE_RE.test(input.workDate)) return { kind: 'invalid', reason: 'workDate : AAAA-MM-JJ' };
    if (!KINDS.includes(input.kind as CorrectionKind) || input.kind === 'import_historical') {
      return { kind: 'invalid', reason: 'kind : type de correction inconnu' };
    }
    if (input.motive.length < 1 || input.motive.length > 500) return { kind: 'invalid', reason: 'motive : 1 à 500 caractères' };
    const payloadError = this.validatePayload(input.kind as CorrectionKind, input.payload);
    if (payloadError) return { kind: 'invalid', reason: payloadError };
    return this.prisma.withTenant(tenantId, async (tx) => {
      // Origine et périmètre : le SELF ne vise QUE soi (l'identifiant du body ne
      // peut pas élargir le périmètre) ; un tiers exige la permission à portée.
      const me = await this.linkedEmployee(tx, actor);
      let employeeId: string;
      let origin: string;
      if (input.employeeId === undefined || input.employeeId === me) {
        if (!(await holdsPermission(tx, actor, 'time.correction_request_self', 'time.correction_request', 'time.correction_admin'))) {
          return { kind: 'forbidden', reason: 'permission requise : time.correction_request_self' };
        }
        if (me === null) return { kind: 'invalid', reason: 'compte non relié à un dossier salarié — demande pour soi impossible' };
        employeeId = me;
        origin = 'self';
      } else {
        const isAdmin = await holdsPermission(tx, actor, 'time.correction_admin');
        const set = await scopeSetFor(tx, actor, isAdmin ? 'time.correction_admin' : 'time.correction_request');
        if (set.kind === 'none') return { kind: 'forbidden', reason: 'permission requise : time.correction_request (avec une portée)' };
        if (!(await this.scopeCovers(tx, set, input.employeeId, input.workDate))) return { kind: 'not_found' };
        employeeId = input.employeeId;
        origin = isAdmin ? 'admin' : 'manager';
      }
      if (input.anomalyId !== undefined) {
        const anom = await tx.$queryRaw<Array<{ id: string; employee_id: string }>>`
          SELECT id, employee_id FROM time.day_anomalies WHERE id = ${input.anomalyId}::uuid`;
        if (anom.length === 0 || anom[0]!.employee_id !== employeeId) return { kind: 'not_found' };
      }
      // Instantané AVANT : le résultat courant au moment de la demande.
      const before = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT id, version, day_status AS status, worked_minutes AS "workedMinutes",
               late_minutes AS "lateMinutes", absence_minutes AS "absenceMinutes"
          FROM time.day_results
         WHERE employee_id = ${employeeId}::uuid AND work_date = ${input.workDate}::date AND is_current`;
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO time.correction_requests
          (tenant_id, employee_id, work_date, kind, origin, requester_user_id, motive, payload, before_snapshot, anomaly_id)
        VALUES (${tenantId}::uuid, ${employeeId}::uuid, ${input.workDate}::date, ${input.kind}, ${origin},
                ${actor}::uuid, ${input.motive}, ${JSON.stringify(input.payload)}::jsonb,
                ${before[0] ? JSON.stringify(before[0]) : null}::jsonb, ${input.anomalyId ?? null}::uuid)
        RETURNING id`;
      const id = rows[0]!.id;
      await auditAuth(tx, tenantId, {
        action: 'time_correction_created', actorUserId: actor, module: 'time',
        recordType: 'correction_request', recordId: id,
        newValue: { kind: input.kind, employeeId, workDate: input.workDate, origin }, result: 'success',
      });
      return { kind: 'ok', id };
    });
  }

  // ==================================================================
  // Soumission : contexte E3 (manager, périmètre, période, ampleur) + circuit.
  // ==================================================================

  private async managerUserOf(
    tx: Prisma.TransactionClient, employeeId: string, date: string,
  ): Promise<string | null> {
    const asg = await tx.$queryRaw<Array<{ position_id: string | null; manager_override_employee_id: string | null }>>`
      SELECT position_id, manager_override_employee_id FROM core.employee_assignments
       WHERE employee_id = ${employeeId}::uuid AND is_primary
         AND daterange(effective_from, effective_to, '[)') @> ${date}::date LIMIT 1`;
    const a = asg[0];
    if (!a) return null;
    let managerEmployee: string | null = a.manager_override_employee_id;
    if (!managerEmployee && a.position_id) {
      const mgr = await tx.$queryRaw<Array<{ id: string | null }>>`
        SELECT org.position_manager_at(${a.position_id}::uuid, ${date}::date) AS id`;
      const managerPosition = mgr[0]?.id ?? null;
      if (managerPosition) {
        const occ = await tx.$queryRaw<Array<{ employee_id: string }>>`
          SELECT employee_id FROM core.employee_assignments
           WHERE position_id = ${managerPosition}::uuid AND is_primary
             AND daterange(effective_from, effective_to, '[)') @> ${date}::date LIMIT 1`;
        managerEmployee = occ[0]?.employee_id ?? null;
      }
    }
    if (!managerEmployee) return null;
    const usr = await tx.$queryRaw<Array<{ user_id: string | null }>>`
      SELECT user_id FROM core.employees WHERE id = ${managerEmployee}::uuid`;
    return usr[0]?.user_id ?? null;
  }

  async submit(tenantId: string, actor: string, requestId: string): Promise<TimeOutcome<{ instanceId: string; version: number }>> {
    // 1. Préparer le contexte et faire avancer la demande (une transaction).
    const prep = await this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{
        id: string; employee_id: string; work_date: string; kind: CorrectionKind; status: string;
        version: number; requester_user_id: string; payload: Record<string, unknown>; origin: string;
      }>>`
        SELECT id, employee_id, work_date::text, kind, status, version, requester_user_id, payload, origin
          FROM time.correction_requests WHERE id = ${requestId}::uuid FOR UPDATE`;
      const req = rows[0];
      if (!req) return { kind: 'not_found' as const };
      // Seul le demandeur (ou l'administration) soumet.
      if (req.requester_user_id !== actor && !(await holdsPermission(tx, actor, 'time.correction_admin'))) {
        return { kind: 'forbidden' as const, reason: 'seul le demandeur ou l\'administration du temps peut soumettre' };
      }
      if (req.status !== 'draft' && req.status !== 'returned') {
        return { kind: 'conflict' as const, reason: `demande au statut « ${req.status} » — seule une demande en brouillon ou retournée se soumet` };
      }
      const payloadError = this.validatePayload(req.kind, req.payload);
      if (payloadError) return { kind: 'invalid' as const, reason: payloadError };
      const nextVersion = req.status === 'returned' ? req.version + 1 : req.version;
      // Contexte du circuit : manager, périmètre, période, ampleur, rétroactivité.
      const managerUserId = await this.managerUserOf(tx, req.employee_id, req.work_date);
      const org = await tx.$queryRaw<Array<{ company_id: string | null; site_id: string | null; unit_id: string | null }>>`
        SELECT company_id, site_id, unit_id FROM core.employee_assignments
         WHERE employee_id = ${req.employee_id}::uuid AND is_primary
           AND daterange(effective_from, effective_to, '[)') @> ${req.work_date}::date LIMIT 1`;
      const period = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT status FROM time.periods
         WHERE ${req.work_date}::date BETWEEN period_start AND period_end
           AND status IN ('locked', 'closed', 'archived') LIMIT 1`;
      const minutes = typeof req.payload['minutes'] === 'number' ? req.payload['minutes'] as number : 0;
      const context = {
        requestId: req.id,
        requestVersion: nextVersion,
        employeeId: req.employee_id,
        kind: req.kind,
        minutes,
        managerUserId: managerUserId ?? undefined,
        hasManager: managerUserId !== null,
        scopeRef: org[0]?.unit_id ?? undefined,
        siteId: org[0]?.site_id ?? undefined,
        companyId: org[0]?.company_id ?? undefined,
        periodClosed: period.length > 0,
        sensitive: req.kind.startsWith('justify_') || req.kind === 'offsite_presence',
      };
      return { kind: 'ok' as const, req, nextVersion, context };
    });
    if (prep.kind !== 'ok') return prep;

    // 2. Instance E3 (sa transaction) — le circuit est configuré par le tenant.
    const submitted = await this.wf.submit(tenantId, actor, {
      definitionKey: 'temps_correction', subjectType: 'time_correction',
      subjectId: requestId, context: prep.context,
    });
    if (submitted.kind === 'no_active_definition') {
      return { kind: 'conflict', reason: 'aucun circuit « temps_correction » actif — configurez le workflow avant de soumettre' };
    }
    if (submitted.kind !== 'ok') return { kind: 'invalid', reason: 'workflow vide' };

    // 3. Marquer la demande soumise (statut + version + instance) — contenu désormais FIGÉ par la base.
    return this.prisma.withTenant(tenantId, async (tx) => {
      await tx.$executeRaw`
        UPDATE time.correction_requests
           SET status = 'submitted', version = ${prep.nextVersion},
               workflow_instance_id = ${submitted.instanceId}::uuid, submitted_at = now()
         WHERE id = ${requestId}::uuid`;
      await auditAuth(tx, tenantId, {
        action: 'time_correction_submitted', actorUserId: actor, module: 'time',
        recordType: 'correction_request', recordId: requestId,
        newValue: { version: prep.nextVersion, instanceId: submitted.instanceId, periodClosed: prep.context.periodClosed },
        result: 'success',
      });
      return { kind: 'ok', instanceId: submitted.instanceId, version: prep.nextVersion };
    });
  }

  /** Annulation AVANT décision : demandeur (brouillon/retourné directement ; soumis via E3). */
  async cancel(tenantId: string, actor: string, requestId: string): Promise<TimeOutcome<Record<never, never>>> {
    const state = await this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ status: string; requester_user_id: string; workflow_instance_id: string | null }>>`
        SELECT status, requester_user_id, workflow_instance_id FROM time.correction_requests
         WHERE id = ${requestId}::uuid FOR UPDATE`;
      const req = rows[0];
      if (!req) return { kind: 'not_found' as const };
      if (req.requester_user_id !== actor && !(await holdsPermission(tx, actor, 'time.correction_admin'))) {
        return { kind: 'forbidden' as const, reason: 'annulation réservée au demandeur ou à l\'administration' };
      }
      if (req.status === 'draft' || req.status === 'returned') {
        await tx.$executeRaw`UPDATE time.correction_requests SET status = 'cancelled' WHERE id = ${requestId}::uuid`;
        await auditAuth(tx, tenantId, {
          action: 'time_correction_cancelled', actorUserId: actor, module: 'time',
          recordType: 'correction_request', recordId: requestId, result: 'success',
        });
        return { kind: 'ok' as const, viaWorkflow: null };
      }
      if (req.status === 'submitted' && req.workflow_instance_id) {
        return { kind: 'ok' as const, viaWorkflow: req.workflow_instance_id };
      }
      return { kind: 'conflict' as const, reason: `demande au statut « ${req.status} » — l'annulation n'est plus permise` };
    });
    if (state.kind !== 'ok') return state;
    if (state.viaWorkflow) {
      const identity = await this.actorIdentity(tenantId, actor);
      const out = await this.wf.cancel(tenantId, identity, state.viaWorkflow, { comment: 'annulation par le demandeur' });
      if (out.kind === 'forbidden') return { kind: 'forbidden', reason: out.reason };
      if (out.kind === 'stale') return { kind: 'conflict', reason: 'la demande a déjà été décidée' };
      if (out.kind !== 'ok') return { kind: 'conflict', reason: 'annulation impossible' };
    }
    return { kind: 'ok' };
  }

  private async actorIdentity(tenantId: string, userId: string): Promise<ActorIdentity> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const roles = await tx.$queryRaw<Array<{ key: string }>>`
        SELECT r.key FROM admin.user_roles ur JOIN admin.roles r ON r.id = ur.role_id
         WHERE ur.user_id = ${userId}::uuid`;
      const scopes = await tx.$queryRaw<Array<{ scope_type: string; scope_ref: string | null }>>`
        SELECT scope_type, scope_ref FROM admin.user_scopes WHERE user_id = ${userId}::uuid`;
      return {
        userId,
        roleKeys: roles.map((r) => r.key),
        scopes: scopes.map((s) => ({ type: s.scope_type, ref: s.scope_ref })),
      };
    });
  }

  // ==================================================================
  // Décision (enveloppe E3) : approbation ⇒ application automatique hors décision.
  // ==================================================================

  async decide(
    tenantId: string, actor: string, requestId: string,
    input: { action: 'approve' | 'reject' | 'return'; comment?: string; idempotencyKey?: string },
  ): Promise<TimeOutcome<{ status: string; applied?: boolean; applicationError?: string | null }>> {
    const inst = await this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ workflow_instance_id: string | null; status: string }>>`
        SELECT workflow_instance_id, status FROM time.correction_requests WHERE id = ${requestId}::uuid`;
      if (rows.length === 0) return { kind: 'not_found' as const };
      if (rows[0]!.status !== 'submitted' || !rows[0]!.workflow_instance_id) {
        return { kind: 'conflict' as const, reason: `demande au statut « ${rows[0]!.status} » — rien à décider` };
      }
      return { kind: 'ok' as const, instanceId: rows[0]!.workflow_instance_id };
    });
    if (inst.kind !== 'ok') return inst;
    const identity = await this.actorIdentity(tenantId, actor);
    const out = await this.wf.decide(tenantId, identity, inst.instanceId, input.action, {
      comment: input.comment, idempotencyKey: input.idempotencyKey,
    });
    if (out.kind === 'forbidden') return { kind: 'forbidden', reason: out.reason };
    if (out.kind === 'stale') return { kind: 'conflict', reason: 'décision déjà rendue ou instance avancée (aucune double transition)' };
    if (out.kind === 'not_found') return { kind: 'not_found' };
    if (out.kind !== 'ok') return { kind: 'invalid', reason: out.kind === 'invalid' ? out.reason : 'décision impossible' };
    // RETOUR pour complément : E3 ne synchronise pas les états non finaux — la
    // demande redevient éditable ici (resoumission = version+1, garanti par la base).
    if (out.status === 'returned') {
      await this.prisma.withTenant(tenantId, async (tx) => {
        await tx.$executeRaw`
          UPDATE time.correction_requests SET status = 'returned'
           WHERE id = ${requestId}::uuid AND status = 'submitted'`;
        await auditAuth(tx, tenantId, {
          action: 'time_correction_returned', actorUserId: actor, module: 'time',
          recordType: 'correction_request', recordId: requestId, result: 'success',
        });
      });
      return { kind: 'ok', status: 'returned' };
    }
    // Approbation FINALE ⇒ application immédiate (hors transaction de décision).
    if (out.status === 'approved') {
      const applied = await this.applyApproved(tenantId, actor, requestId);
      if (applied.kind === 'ok') return { kind: 'ok', status: 'approved', applied: true };
      return {
        kind: 'ok', status: 'approved', applied: false,
        applicationError: applied.kind === 'conflict' || applied.kind === 'invalid' || applied.kind === 'forbidden'
          ? applied.reason : 'application en échec — relançable',
      };
    }
    return { kind: 'ok', status: out.status };
  }

  /** Effet E3 (même transaction que la décision) : le statut de la DEMANDE suit. */
  private async onWorkflowOutcome(
    tx: Prisma.TransactionClient, tenantId: string, requestId: string, status: string,
  ): Promise<void> {
    const map: Record<string, string> = { approved: 'approved', rejected: 'rejected', cancelled: 'cancelled', returned: 'returned' };
    const next = map[status];
    if (!next) return;
    // Une demande non soumise n'est jamais touchée : la décision est liée à la
    // version SOUMISE (contenu figé par trigger tant que 'submitted').
    await tx.$executeRaw`
      UPDATE time.correction_requests
         SET status = ${next}, decided_at = CASE WHEN ${next} IN ('approved', 'rejected') THEN now() ELSE decided_at END
       WHERE id = ${requestId}::uuid AND status = 'submitted'`;
    await auditAuth(tx, tenantId, {
      action: `time_correction_${next}`, module: 'time',
      recordType: 'correction_request', recordId: requestId, result: 'success',
    });
  }

  // ==================================================================
  // Application IDEMPOTENTE d'une correction approuvée.
  // ==================================================================

  async applyApproved(tenantId: string, actor: string, requestId: string): Promise<TimeOutcome<{ eventId: string; runId: string | null }>> {
    // 1. Événement correctif (append-only, UNIQUE par demande) — sa propre transaction.
    const step1 = await this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{
        id: string; employee_id: string; work_date: string; kind: CorrectionKind; status: string;
        payload: Record<string, unknown>; anomaly_id: string | null; applied_event_id: string | null;
        requester_user_id: string;
      }>>`
        SELECT id, employee_id, work_date::text, kind, status, payload, anomaly_id, applied_event_id, requester_user_id
          FROM time.correction_requests WHERE id = ${requestId}::uuid FOR UPDATE`;
      const req = rows[0];
      if (!req) return { kind: 'not_found' as const };
      if (req.status === 'applied' && req.applied_event_id) {
        // Rejeu d'une application DÉJÀ constatée : idempotent, rien de neuf.
        return { kind: 'already' as const, eventId: req.applied_event_id };
      }
      if (req.status !== 'approved' && req.status !== 'application_failed') {
        return { kind: 'conflict' as const, reason: `demande au statut « ${req.status} » — seule une demande approuvée s'applique` };
      }
      const effect = this.effectOf(req.kind, req.payload);
      let eventId: string;
      const existing = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM time.correction_events WHERE request_id = ${requestId}::uuid`;
      if (existing.length > 0) {
        eventId = existing[0]!.id; // application rejouée : l'événement EXISTE déjà, rien de neuf
      } else {
        try {
          const ins = await tx.$queryRaw<Array<{ id: string }>>`
            INSERT INTO time.correction_events (tenant_id, request_id, employee_id, work_date, kind, effect, created_by)
            VALUES (${tenantId}::uuid, ${requestId}::uuid, ${req.employee_id}::uuid, ${req.work_date}::date,
                    ${req.kind}, ${JSON.stringify(effect)}::jsonb, ${actor}::uuid)
            RETURNING id`;
          eventId = ins[0]!.id;
        } catch (e) {
          const msg = (e as Error).message;
          if (msg.includes('période') || msg.includes('verrouillée')) {
            // Période close : l'application ÉCHOUE explicitement — réouverture requise.
            await tx.$executeRaw`
              UPDATE time.correction_requests SET status = 'application_failed',
                     application_error = ${msg.split('\n')[0]!.slice(0, 490)}
               WHERE id = ${requestId}::uuid AND status IN ('approved')`;
            await auditAuth(tx, tenantId, {
              action: 'time_correction_application_failed', actorUserId: actor, module: 'time',
              recordType: 'correction_request', recordId: requestId,
              newValue: { error: 'période verrouillée/clôturée' }, result: 'failure',
            });
            return { kind: 'conflict' as const, reason: 'période verrouillée ou clôturée : réouverture contrôlée requise avant application' };
          }
          throw e;
        }
        await auditAuth(tx, tenantId, {
          action: 'time_correction_event_created', actorUserId: actor, module: 'time',
          recordType: 'correction_event', recordId: eventId,
          newValue: { requestId, kind: req.kind, workDate: req.work_date }, result: 'success',
        });
      }
      // Dates impactées : la journée visée, plus la cible d'un rattachement.
      const dates = [req.work_date];
      const target = (req.payload['targetDate'] as string | undefined);
      if (req.kind === 'reattach_event' && target) dates.push(target);
      dates.sort();
      return {
        kind: 'ok' as const, eventId, req,
        from: dates[0]!, to: dates[dates.length - 1]!,
      };
    });
    if (step1.kind === 'already') return { kind: 'ok', eventId: step1.eventId, runId: null };
    if (step1.kind !== 'ok') return step1;

    // 2. Recalcul E10.2 MOTIVÉ (machinerie standard : versions, historique, audit).
    const run = await this.calc.run(tenantId, actor, {
      periodStart: step1.from, periodEnd: step1.to,
      scopeKind: 'employee', scopeId: step1.req.employee_id,
      reason: `application de la correction ${requestId} (${step1.req.kind})`,
    }, { recalc: true });

    const runOk = run.kind === 'ok' && typeof run.run['status'] === 'string'
      && (run.run['status'] as string).startsWith('completed');

    // 3. Constat : appliquée (diff consigné, anomalie liée résolue) ou échec explicite.
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!runOk) {
        const reason = run.kind === 'ok' ? `recalcul en statut ${String(run.run['status'])}` : 'recalcul refusé';
        await tx.$executeRaw`
          UPDATE time.correction_requests SET status = 'application_failed',
                 application_error = ${reason.slice(0, 490)}
           WHERE id = ${requestId}::uuid AND status IN ('approved', 'application_failed')`;
        await this.notifyUsers(tx, tenantId, actor, [step1.req.requester_user_id],
          `temps-correction-echec-${requestId}`, 'temps_correction_echec_application',
          { demande: requestId, erreur: reason });
        await auditAuth(tx, tenantId, {
          action: 'time_correction_application_failed', actorUserId: actor, module: 'time',
          recordType: 'correction_request', recordId: requestId, newValue: { reason }, result: 'failure',
        });
        return { kind: 'conflict', reason: `application en échec : ${reason} — demande en « application_failed », relançable` };
      }
      const after = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT id, version, day_status AS status, worked_minutes AS "workedMinutes",
               late_minutes AS "lateMinutes", absence_minutes AS "absenceMinutes",
               justified_category AS "justifiedCategory", justified_minutes AS "justifiedMinutes"
          FROM time.day_results
         WHERE employee_id = ${step1.req.employee_id}::uuid AND work_date = ${step1.req.work_date}::date AND is_current`;
      await tx.$executeRaw`
        UPDATE time.correction_requests
           SET status = 'applied', applied_at = now(), applied_event_id = ${step1.eventId}::uuid,
               application_error = NULL,
               after_snapshot = ${after[0] ? JSON.stringify(after[0]) : null}::jsonb
         WHERE id = ${requestId}::uuid AND status IN ('approved', 'application_failed')`;
      // Résolution AUTOMATIQUE de l'anomalie liée — référence probante = l'événement.
      if (step1.req.anomaly_id) {
        await tx.$executeRaw`
          UPDATE time.day_anomalies
             SET state = 'resolved', resolution_kind = 'correction_applied',
                 resolution_event_id = ${step1.eventId}::uuid,
                 state_note = 'résolue par application de la correction approuvée',
                 state_by = ${actor}::uuid, state_at = now()
           WHERE id = ${step1.req.anomaly_id}::uuid AND state <> 'resolved'`;
      }
      await this.notifyUsers(tx, tenantId, actor, [step1.req.requester_user_id],
        `temps-correction-appliquee-${requestId}`, 'temps_correction_appliquee',
        { demande: requestId, journee: step1.req.work_date });
      await auditAuth(tx, tenantId, {
        action: 'time_correction_applied', actorUserId: actor, module: 'time',
        recordType: 'correction_request', recordId: requestId,
        newValue: { eventId: step1.eventId, runId: run.kind === 'ok' ? run.run['id'] : null }, result: 'success',
      });
      return { kind: 'ok', eventId: step1.eventId, runId: run.kind === 'ok' ? (run.run['id'] as string) : null };
    });
  }

  private async notifyUsers(
    tx: Prisma.TransactionClient, tenantId: string, actor: string, userIds: string[],
    eventKey: string, templateKey: string, payload: Record<string, unknown>,
  ): Promise<void> {
    await this.notify.publishEventTx(tx, tenantId, {
      eventKey, templateKey, payload,
      recipients: [...new Set(userIds)].map((u) => ({ userId: u })),
      source: 'business', subjectType: 'correction_request',
      subjectId: (payload['demande'] as string) ?? eventKey, createdBy: actor,
    });
  }

  // ==================================================================
  // Consultations
  // ==================================================================

  private readonly REQUEST_COLUMNS = `
    cr.id, cr.employee_id AS "employeeId", cr.work_date::text AS "workDate", cr.kind, cr.origin,
    cr.status, cr.version, cr.requester_user_id AS "requesterUserId", cr.motive, cr.payload,
    cr.before_snapshot AS "beforeSnapshot", cr.after_snapshot AS "afterSnapshot",
    cr.anomaly_id AS "anomalyId", cr.workflow_instance_id AS "workflowInstanceId",
    cr.applied_event_id AS "appliedEventId", cr.application_error AS "applicationError",
    cr.submitted_at AS "submittedAt", cr.decided_at AS "decidedAt", cr.applied_at AS "appliedAt",
    cr.created_at AS "createdAt",
    e.matricule, e.first_name AS "firstName", e.last_name AS "lastName",
    (SELECT count(*)::int FROM time.correction_attachments att
      WHERE att.request_id = cr.id AND att.deleted_at IS NULL) AS "attachmentCount"`;

  async listMine(tenantId: string, actor: string, opts: { limit?: number }): Promise<TimeOutcome<{ linked: boolean; items: unknown[] }>> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'time.correction_request_self', 'time.correction_request', 'time.correction_admin'))) {
        return { kind: 'forbidden', reason: 'permission requise : time.correction_request_self' };
      }
      const items = await tx.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT ${Prisma.raw(this.REQUEST_COLUMNS)}
          FROM time.correction_requests cr JOIN core.employees e ON e.id = cr.employee_id
         WHERE cr.requester_user_id = ${actor}::uuid OR e.user_id = ${actor}::uuid
         ORDER BY cr.created_at DESC LIMIT ${limit}`);
      return { kind: 'ok', linked: true, items };
    });
  }

  async list(
    tenantId: string, actor: string,
    opts: { status?: string; employeeId?: string; from?: string; to?: string; limit?: number; offset?: number },
  ): Promise<TimeOutcome<{ items: unknown[] }>> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const set = await scopeSetFor(tx, actor, 'time.correction_view');
      const alt = set.kind !== 'none' ? set : await scopeSetFor(tx, actor, 'time.correction_admin');
      if (alt.kind === 'none') return { kind: 'forbidden', reason: 'permission requise : time.correction_view (avec une portée)' };
      const scoped = alt.kind === 'scoped';
      const csv = scopeCsv(alt);
      const items = await tx.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT ${Prisma.raw(this.REQUEST_COLUMNS)}
          FROM time.correction_requests cr JOIN core.employees e ON e.id = cr.employee_id
         WHERE (${opts.status ?? null}::text IS NULL OR cr.status = ${opts.status ?? null})
           AND (${opts.employeeId ?? null}::uuid IS NULL OR cr.employee_id = ${opts.employeeId ?? null}::uuid)
           AND (${opts.from ?? null}::date IS NULL OR cr.work_date >= ${opts.from ?? null}::date)
           AND (${opts.to ?? null}::date IS NULL OR cr.work_date <= ${opts.to ?? null}::date)
           AND (${!scoped} OR EXISTS (
                 SELECT 1 FROM core.employee_assignments sa
                  WHERE sa.employee_id = cr.employee_id AND sa.is_primary
                    AND daterange(sa.effective_from, sa.effective_to, '[)') @> cr.work_date
                    AND (sa.company_id = ANY(string_to_array(${csv.companies}, ',')::uuid[])
                      OR sa.site_id    = ANY(string_to_array(${csv.sites}, ',')::uuid[])
                      OR sa.unit_id    = ANY(string_to_array(${csv.units}, ',')::uuid[]))))
         ORDER BY cr.created_at DESC LIMIT ${limit} OFFSET ${offset}`);
      return { kind: 'ok', items };
    });
  }

  async detail(tenantId: string, actor: string, requestId: string): Promise<TimeOutcome<{ request: unknown; attachments: unknown[] }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT ${Prisma.raw(this.REQUEST_COLUMNS)}, e.user_id AS "employeeUserId"
          FROM time.correction_requests cr JOIN core.employees e ON e.id = cr.employee_id
         WHERE cr.id = ${requestId}::uuid`);
      const req = rows[0];
      if (!req) return { kind: 'not_found' };
      const isMine = req['requesterUserId'] === actor || req['employeeUserId'] === actor;
      if (!isMine) {
        const set = await scopeSetFor(tx, actor, 'time.correction_view');
        const alt = set.kind !== 'none' ? set : await scopeSetFor(tx, actor, 'time.correction_admin');
        if (alt.kind === 'none') return { kind: 'forbidden', reason: 'permission requise : time.correction_view' };
        if (!(await this.scopeCovers(tx, alt, req['employeeId'] as string, req['workDate'] as string))) {
          return { kind: 'not_found' };
        }
      }
      // Les PIÈCES : métadonnées seulement — une pièce SENSIBLE n'expose ni nom de
      // fichier ni empreinte hors de son cercle (cloisonnement médical).
      const canSeeSensitive = isMine || (await holdsPermission(tx, actor, 'time.attachments_view'));
      const attachments = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT id, CASE WHEN sensitive AND NOT ${canSeeSensitive} THEN 'pièce confidentielle' ELSE filename END AS filename,
               mime, byte_size AS "byteSize", sensitive, av_status AS "avStatus",
               created_at AS "createdAt", deleted_at IS NOT NULL AS "deleted"
          FROM time.correction_attachments
         WHERE request_id = ${requestId}::uuid AND deleted_at IS NULL
         ORDER BY created_at`;
      delete (req as Record<string, unknown>)['employeeUserId'];
      return { kind: 'ok', request: req, attachments };
    });
  }

  // ==================================================================
  // Pièces justificatives
  // ==================================================================

  async addAttachment(
    tenantId: string, actor: string, requestId: string,
    input: { filename: string; mime: string; contentBase64: string; sensitive?: boolean },
  ): Promise<TimeOutcome<{ id: string; sha256: string }>> {
    if (!/^[\w.\- ()]{1,200}$/.test(input.filename)) return { kind: 'invalid', reason: 'filename : 1 à 200 caractères sûrs' };
    if (!['application/pdf', 'image/png', 'image/jpeg'].includes(input.mime)) {
      return { kind: 'invalid', reason: 'mime : application/pdf, image/png ou image/jpeg' };
    }
    let content: Buffer;
    try {
      content = Buffer.from(input.contentBase64, 'base64');
    } catch {
      return { kind: 'invalid', reason: 'contentBase64 invalide' };
    }
    if (content.length < 1 || content.length > 5_000_000) return { kind: 'invalid', reason: 'pièce : 1 octet à 5 Mo' };
    const sha256 = createHash('sha256').update(content).digest('hex');
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ requester_user_id: string; status: string; employee_id: string }>>`
        SELECT requester_user_id, status, employee_id FROM time.correction_requests WHERE id = ${requestId}::uuid`;
      const req = rows[0];
      if (!req) return { kind: 'not_found' };
      const me = await this.linkedEmployee(tx, actor);
      const isMine = req.requester_user_id === actor || req.employee_id === me;
      if (!isMine && !(await holdsPermission(tx, actor, 'time.correction_admin'))) {
        return { kind: 'forbidden', reason: 'pièce : réservée au demandeur, au salarié ou à l\'administration' };
      }
      if (!['draft', 'returned', 'submitted'].includes(req.status)) {
        return { kind: 'conflict', reason: 'demande décidée : plus de pièce ajoutable' };
      }
      const ins = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO time.correction_attachments
          (tenant_id, request_id, filename, mime, byte_size, sha256, sensitive, content, av_status, uploaded_by)
        VALUES (${tenantId}::uuid, ${requestId}::uuid, ${input.filename}, ${input.mime}, ${content.length},
                ${sha256}, ${input.sensitive === true}, ${content}, 'skipped', ${actor}::uuid)
        RETURNING id`;
      await auditAuth(tx, tenantId, {
        action: 'time_attachment_added', actorUserId: actor, module: 'time',
        recordType: 'correction_attachment', recordId: ins[0]!.id,
        newValue: { requestId, mime: input.mime, byteSize: content.length, sensitive: input.sensitive === true },
        result: 'success',
      });
      return { kind: 'ok', id: ins[0]!.id, sha256 };
    });
  }

  async downloadAttachment(
    tenantId: string, actor: string, attachmentId: string,
  ): Promise<TimeOutcome<{ filename: string; mime: string; contentBase64: string; sha256: string }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{
        id: string; request_id: string; filename: string; mime: string; sha256: string;
        sensitive: boolean; content: Buffer; deleted_at: Date | null;
        requester_user_id: string; employee_user_id: string | null;
      }>>`
        SELECT a.id, a.request_id, a.filename, a.mime, a.sha256, a.sensitive, a.content, a.deleted_at,
               cr.requester_user_id, e.user_id AS employee_user_id
          FROM time.correction_attachments a
          JOIN time.correction_requests cr ON cr.id = a.request_id
          JOIN core.employees e ON e.id = cr.employee_id
         WHERE a.id = ${attachmentId}::uuid`;
      const att = rows[0];
      if (!att || att.deleted_at !== null) return { kind: 'not_found' };
      const isMine = att.requester_user_id === actor || att.employee_user_id === actor;
      // Cloisonnement : une pièce SENSIBLE n'est lisible que par son cercle et les
      // porteurs de time.attachments_view — l'administration « ordinaire » n'y voit
      // que l'existence d'un justificatif.
      if (!isMine && !(await holdsPermission(tx, actor, 'time.attachments_view'))) {
        return { kind: 'forbidden', reason: 'permission requise : time.attachments_view' };
      }
      await tx.$executeRaw`
        INSERT INTO time.attachment_access_log (tenant_id, attachment_id, viewed_by)
        VALUES (${tenantId}::uuid, ${attachmentId}::uuid, ${actor}::uuid)`;
      await auditAuth(tx, tenantId, {
        action: 'time_attachment_viewed', actorUserId: actor, module: 'time',
        recordType: 'correction_attachment', recordId: attachmentId,
        newValue: { sensitive: att.sensitive }, result: 'success',
      });
      return {
        kind: 'ok', filename: att.filename, mime: att.mime,
        contentBase64: Buffer.from(att.content).toString('base64'), sha256: att.sha256,
      };
    });
  }

  // ==================================================================
  // Import contrôlé de corrections historiques (administration).
  // ==================================================================

  async importHistorical(
    tenantId: string, actor: string,
    rows: Array<{ employeeId: string; workDate: string; kind: string; motive: string; payload: Record<string, unknown> }>,
  ): Promise<TimeOutcome<{ created: number; submitted: number; errors: Array<{ line: number; error: string }> }>> {
    if (!Array.isArray(rows) || rows.length === 0 || rows.length > 200) {
      return { kind: 'invalid', reason: 'import : 1 à 200 lignes' };
    }
    const holder = await this.prisma.withTenant(tenantId, (tx) => holdsPermission(tx, actor, 'time.correction_admin'));
    if (!holder) return { kind: 'forbidden', reason: 'permission requise : time.correction_admin' };
    const errors: Array<{ line: number; error: string }> = [];
    let created = 0;
    let submitted = 0;
    for (const [i, r] of rows.entries()) {
      const res = await this.create(tenantId, actor, {
        employeeId: r.employeeId, workDate: r.workDate, kind: r.kind, motive: `[import] ${r.motive}`, payload: r.payload,
      });
      if (res.kind !== 'ok') {
        errors.push({ line: i + 1, error: res.kind === 'invalid' || res.kind === 'forbidden' ? res.reason : res.kind });
        continue;
      }
      created += 1;
      await this.prisma.withTenant(tenantId, (tx) =>
        tx.$executeRaw`UPDATE time.correction_requests SET origin = 'import' WHERE id = ${res.id}::uuid`);
      const sub = await this.submit(tenantId, actor, res.id);
      if (sub.kind === 'ok') submitted += 1;
      else errors.push({ line: i + 1, error: `créée mais non soumise : ${sub.kind === 'conflict' || sub.kind === 'invalid' ? sub.reason : sub.kind}` });
    }
    await this.prisma.withTenant(tenantId, (tx) => auditAuth(tx, tenantId, {
      action: 'time_corrections_imported', actorUserId: actor, module: 'time',
      recordType: 'correction_request', newValue: { received: rows.length, created, submitted, errors: errors.length },
      result: errors.length === 0 ? 'success' : 'failure',
    }));
    return { kind: 'ok', created, submitted, errors };
  }

  // ==================================================================
  // Anomalies : balayage des échéances (notification des non-traitées).
  // ==================================================================

  async sweepAnomalies(tenantId: string, actor: string): Promise<TimeOutcome<{ notified: number }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'time.correction_admin', 'time.anomalies_manage'))) {
        return { kind: 'forbidden', reason: 'permission requise : time.anomalies_manage' };
      }
      const due = await tx.$queryRaw<Array<{ id: string; assigned_to: string | null; code: string; work_date: string }>>`
        SELECT a.id, a.assigned_to, a.code, a.work_date::text
          FROM time.day_anomalies a
          JOIN time.day_results r ON r.id = a.day_result_id AND r.is_current
         WHERE a.state IN ('open', 'acknowledged') AND a.due_at IS NOT NULL AND a.due_at <= now() + interval '24 hours'
         ORDER BY a.due_at LIMIT 100`;
      let notified = 0;
      for (const a of due) {
        await this.notify.publishEventTx(tx, tenantId, {
          eventKey: `temps-anomalie-echeance-${a.id}`,
          templateKey: 'temps_anomalie_echeance',
          payload: { anomalie: a.code, journee: a.work_date },
          recipients: [{ userId: a.assigned_to ?? actor }],
          source: 'business', subjectType: 'day_anomaly', subjectId: a.id, createdBy: actor,
        });
        notified += 1;
      }
      return { kind: 'ok', notified };
    });
  }
}
