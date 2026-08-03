/**
 * E11.1 — Soldes, ledger, projection, décompte, ajustements et reprise :
 *  - le solde EXPOSÉ vient de la vue (somme des mouvements), jamais d'un champ ;
 *  - portées réelles : self (salarié lié), ÉQUIPE (responsable résolu E9),
 *    RH (portées E8) — l'identifiant du body/URL n'élargit JAMAIS le périmètre ;
 *  - types CONFIDENTIELS : motifs/références masqués sans permission dédiée,
 *    soldes exclus des vues d'équipe (le manager n'a pas à connaître la maladie) ;
 *  - ajustement = mouvement COMPENSATOIRE motivé avec avant/après calculés ;
 *    au-delà du seuil E4 `conges.ajustement.seuil_sensible`, circuit E3 requis ;
 *  - import de soldes d'ouverture : préversion, ATOMIQUE par défaut, idempotent
 *    (rejeu = doublons comptés, zéro doublon écrit), rapport d'erreurs par ligne ;
 *  - décompte d'une plage : calendrier + horaire E10 réels (fériés, repos,
 *    rotations de nuit rattachées à LEUR journée), unités ouvrés/ouvrables/
 *    calendaires/heures/demi-journées.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma.service';
import { auditAuth } from '../auth/audit.util';
import { NotificationService } from '../notify/notification.service';
import { WorkflowService } from '../workflow/workflow.service';
import { SchedulesService } from '../time/schedules.service';
import {
  countLeave, projectBalance, type CountingDay, type LeaveUnit, type ResolvedPolicy,
} from '../../../../packages/core/src/leave.ts';
import {
  DATE_RE, holdsPermission, linkedEmployee, numericParam, paramsAt, scopeSetFor,
  teamEmployeeIds, type ScopeSet, type TimeOutcome,
} from './leave-access';
import { LeaveCatalogService } from './catalog.service';

type Tx = Prisma.TransactionClient;

const BALANCE_COLUMNS = `
  b.employee_id AS "employeeId", b.absence_type_id AS "absenceTypeId", b.unit,
  b.reference_period_start::text AS "periodStart", b.reference_period_end::text AS "periodEnd",
  coalesce(b.accrued, 0)::float8 AS accrued, coalesce(b.adjusted_out, 0)::float8 AS "adjustedOut",
  coalesce(b.carried_in, 0)::float8 AS "carriedIn", coalesce(b.expired, 0)::float8 AS expired,
  coalesce(b.reserved, 0)::float8 AS reserved, coalesce(b.consumed, 0)::float8 AS consumed,
  coalesce(b.available, 0)::float8 AS available,
  t.code AS "typeCode", t.label_fr AS "typeLabelFr", t.label_en AS "typeLabelEn", t.confidential,
  e.matricule, e.first_name AS "firstName", e.last_name AS "lastName"`;

@Injectable()
export class LeaveBalancesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: LeaveCatalogService,
    private readonly schedules: SchedulesService,
    private readonly notify: NotificationService,
    private readonly wf: WorkflowService,
  ) {
    this.wf.registerSubjectHandler('leave_adjustment', async (tx, tenantId, subjectId, status) => {
      if (status === 'approved') {
        await this.applyAdjustmentTx(tx, tenantId, null, subjectId);
      } else if (status === 'rejected' || status === 'cancelled') {
        await tx.$executeRaw`
          UPDATE leave.pending_adjustments SET status = ${status}, decided_at = now()
           WHERE id = ${subjectId}::uuid AND status = 'pending'`;
      }
    });
  }

  // ================= Soldes =================

  /** Portée effective du lecteur : self / équipe / RH — la plus large disponible. */
  private async readableEmployees(
    tx: Tx, actor: string, date: string,
  ): Promise<{ mode: 'none' | 'all' | 'list'; ids: string[]; team: boolean; rhScoped: ScopeSet | null }> {
    const rh = await scopeSetFor(tx, actor, 'leave.balance_view');
    if (rh.kind === 'all') return { mode: 'all', ids: [], team: false, rhScoped: null };
    let ids: string[] = [];
    let team = false;
    if (await holdsPermission(tx, actor, 'leave.balance_view_team')) {
      ids = await teamEmployeeIds(tx, actor, date);
      team = true;
    }
    if (rh.kind === 'scoped') return { mode: 'list', ids, team, rhScoped: rh };
    if (team) return { mode: 'list', ids, team, rhScoped: null };
    return { mode: 'none', ids: [], team: false, rhScoped: null };
  }

  async listBalances(
    tenantId: string, actor: string,
    opts: { employeeId?: string; typeId?: string; date?: string; limit?: number },
  ): Promise<TimeOutcome<{ items: unknown[] }>> {
    const date = opts.date ?? new Date().toISOString().slice(0, 10);
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const scope = await this.readableEmployees(tx, actor, date);
      if (scope.mode === 'none') return { kind: 'forbidden', reason: 'permission requise : leave.balance_view ou leave.balance_view_team' };
      const sensitive = await holdsPermission(tx, actor, 'leave.sensitive_view');
      const rhAll = scope.mode === 'all';
      const rhScoped = scope.rhScoped;
      const items = await tx.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT ${Prisma.raw(BALANCE_COLUMNS)}
          FROM leave.balances_v b
          JOIN leave.absence_types t ON t.id = b.absence_type_id
          JOIN core.employees e ON e.id = b.employee_id
         WHERE (${opts.employeeId ?? null}::uuid IS NULL OR b.employee_id = ${opts.employeeId ?? null}::uuid)
           AND (${opts.typeId ?? null}::uuid IS NULL OR b.absence_type_id = ${opts.typeId ?? null}::uuid)
           AND (${rhAll} OR b.employee_id = ANY(string_to_array(${scope.ids.join(',')}, ',')::uuid[])
             OR (${rhScoped !== null} AND EXISTS (
                  SELECT 1 FROM core.employee_assignments a
                   WHERE a.employee_id = b.employee_id AND a.is_primary
                     AND daterange(a.effective_from, a.effective_to, '[)') @> ${date}::date
                     AND (a.company_id = ANY(string_to_array(${(rhScoped?.companies ?? []).join(',')}, ',')::uuid[])
                       OR a.site_id    = ANY(string_to_array(${(rhScoped?.sites ?? []).join(',')}, ',')::uuid[])
                       OR a.unit_id    = ANY(string_to_array(${(rhScoped?.units ?? []).join(',')}, ',')::uuid[])))))
         ORDER BY e.matricule, t.code, b.reference_period_start DESC
         LIMIT ${limit}`);
      // Vue d'ÉQUIPE sans droit RH : les types confidentiels sont EXCLUS (rien de médical au manager).
      const filtered = items.filter((r) => {
        if (!r['confidential']) return true;
        if (sensitive) return true;
        return rhAll || rhScoped !== null; // la portée RH voit le solde (pas les motifs) ; l'équipe seule, non
      });
      await auditAuth(tx, tenantId, {
        action: 'leave_balances_viewed', actorUserId: actor, module: 'leave',
        recordType: 'balances', recordId: opts.employeeId ?? 'liste',
        newValue: { count: filtered.length, team: scope.team }, result: 'success',
      });
      return { kind: 'ok', items: filtered };
    });
  }

  async myBalances(tenantId: string, actor: string): Promise<TimeOutcome<{ linked: boolean; items: unknown[] }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'leave.balance_view_own'))) {
        return { kind: 'forbidden', reason: 'permission requise : leave.balance_view_own' };
      }
      const me = await linkedEmployee(tx, actor);
      if (!me) return { kind: 'ok', linked: false, items: [] };
      const items = await tx.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT ${Prisma.raw(BALANCE_COLUMNS)}
          FROM leave.balances_v b
          JOIN leave.absence_types t ON t.id = b.absence_type_id
          JOIN core.employees e ON e.id = b.employee_id
         WHERE b.employee_id = ${me}::uuid
         ORDER BY t.code, b.reference_period_start DESC`);
      return { kind: 'ok', linked: true, items };
    });
  }

  /** Projection à une date FUTURE — clairement distinguée du droit acquis. */
  async projection(
    tenantId: string, actor: string, opts: { employeeId?: string; typeId: string; toDate: string },
  ): Promise<TimeOutcome<{ projection: unknown }>> {
    if (!DATE_RE.test(opts.toDate)) return { kind: 'invalid', reason: 'toDate : AAAA-MM-JJ' };
    const today = new Date().toISOString().slice(0, 10);
    return this.prisma.withTenant(tenantId, async (tx) => {
      let employeeId = opts.employeeId ?? null;
      const me = await linkedEmployee(tx, actor);
      if (employeeId === null || employeeId === me) {
        if (!(await holdsPermission(tx, actor, 'leave.balance_view_own'))) {
          return { kind: 'forbidden', reason: 'permission requise : leave.balance_view_own' };
        }
        if (!me) return { kind: 'invalid', reason: 'compte non relié à un dossier salarié' };
        employeeId = me;
      } else {
        const scope = await this.readableEmployees(tx, actor, today);
        if (scope.mode === 'none') return { kind: 'forbidden', reason: 'permission requise : leave.balance_view' };
        if (scope.mode === 'list' && !scope.ids.includes(employeeId)) {
          if (scope.rhScoped === null) return { kind: 'not_found' };
          const ok = await this.coveredByRh(tx, scope.rhScoped, employeeId, today);
          if (!ok) return { kind: 'not_found' };
        }
      }
      const resolved = await this.catalog.resolveFor(tx, tenantId, employeeId, opts.typeId, today);
      if (resolved.kind === 'ambiguous') {
        return { kind: 'conflict', reason: `politiques ambiguës : ${resolved.codes.join(', ')}` };
      }
      if (resolved.kind === 'none') return { kind: 'ok', projection: null };
      const rates = await this.catalog.resolveRates(tx, tenantId, resolved.row, today);
      const emp = await tx.$queryRaw<Array<{ hire_date: string | null; status: string }>>`
        SELECT hire_date::text, status FROM core.employees WHERE id = ${employeeId}::uuid`;
      if (!emp[0]?.hire_date) return { kind: 'ok', projection: null };
      const bal = await tx.$queryRaw<Array<{ available: unknown; period_start: string }>>`
        SELECT available, reference_period_start::text AS period_start FROM leave.balances_v
         WHERE employee_id = ${employeeId}::uuid AND absence_type_id = ${opts.typeId}::uuid
         ORDER BY reference_period_start DESC LIMIT 1`;
      const available = bal[0] ? Number(bal[0].available) : 0;
      const policy = this.enginePolicy(resolved.row, rates);
      const p = projectBalance({
        policy, employment: { hireDate: emp[0].hire_date, terminationDate: null, suspensions: [] },
        currentAvailable: available, fromDateExclusive: today, toDate: opts.toDate,
      });
      return {
        kind: 'ok',
        projection: {
          employeeId, typeId: opts.typeId, toDate: opts.toDate,
          currentAvailable: available, projected: p.projected,
          plannedAccruals: p.plannedAccruals, note: p.note,
          policyCode: resolved.row.policyCode, policyVersion: resolved.row.policyVersion,
        },
      };
    });
  }

  private async coveredByRh(tx: Tx, set: ScopeSet, employeeId: string, date: string): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ ok: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM core.employee_assignments a
                      WHERE a.employee_id = ${employeeId}::uuid AND a.is_primary
                        AND daterange(a.effective_from, a.effective_to, '[)') @> ${date}::date
                        AND (a.company_id = ANY(string_to_array(${set.companies.join(',')}, ',')::uuid[])
                          OR a.site_id    = ANY(string_to_array(${set.sites.join(',')}, ',')::uuid[])
                          OR a.unit_id    = ANY(string_to_array(${set.units.join(',')}, ',')::uuid[]))) AS ok`;
    return rows[0]?.ok === true;
  }

  // ================= Ledger =================

  async ledger(
    tenantId: string, actor: string,
    opts: { employeeId?: string; typeId?: string; self?: boolean; limit?: number },
  ): Promise<TimeOutcome<{ items: unknown[] }>> {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const today = new Date().toISOString().slice(0, 10);
    return this.prisma.withTenant(tenantId, async (tx) => {
      let employeeFilter: string | null = opts.employeeId ?? null;
      let sensitive = await holdsPermission(tx, actor, 'leave.sensitive_view');
      if (opts.self) {
        if (!(await holdsPermission(tx, actor, 'leave.balance_view_own'))) {
          return { kind: 'forbidden', reason: 'permission requise : leave.balance_view_own' };
        }
        const me = await linkedEmployee(tx, actor);
        if (!me) return { kind: 'ok', items: [] };
        employeeFilter = me;
        sensitive = true; // ses PROPRES mouvements : motifs visibles
      } else {
        if (!(await holdsPermission(tx, actor, 'leave.ledger_view'))) {
          return { kind: 'forbidden', reason: 'permission requise : leave.ledger_view' };
        }
        const scope = await this.readableEmployees(tx, actor, today);
        if (scope.mode === 'none') return { kind: 'forbidden', reason: 'portée requise (leave.balance_view ou équipe)' };
        if (scope.mode === 'list') {
          if (employeeFilter === null) {
            if (scope.ids.length === 0 && scope.rhScoped === null) return { kind: 'ok', items: [] };
          } else if (!scope.ids.includes(employeeFilter)) {
            if (scope.rhScoped === null || !(await this.coveredByRh(tx, scope.rhScoped, employeeFilter, today))) {
              return { kind: 'not_found' };
            }
          }
        }
      }
      const items = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT l.id, l.employee_id AS "employeeId", e.matricule, e.first_name AS "firstName", e.last_name AS "lastName",
               l.absence_type_id AS "absenceTypeId", t.code AS "typeCode", t.confidential,
               l.policy_id AS "policyId", l.policy_version AS "policyVersion",
               l.reference_period_start::text AS "periodStart", l.reference_period_end::text AS "periodEnd",
               l.entry_kind AS "entryKind", l.quantity::float8 AS quantity, l.unit,
               l.effective_on::text AS "effectiveOn", l.origin, l.business_ref AS "businessRef",
               l.reason, l.reversal_of AS "reversalOf", l.params_used AS "paramsUsed",
               l.idempotency_key AS "idempotencyKey", l.created_by AS "createdBy", l.created_at AS "createdAt"
          FROM leave.entitlement_ledger l
          JOIN leave.absence_types t ON t.id = l.absence_type_id
          JOIN core.employees e ON e.id = l.employee_id
         WHERE (${employeeFilter}::uuid IS NULL OR l.employee_id = ${employeeFilter}::uuid)
           AND (${opts.typeId ?? null}::uuid IS NULL OR l.absence_type_id = ${opts.typeId ?? null}::uuid)
         ORDER BY l.created_at DESC, l.effective_on DESC
         LIMIT ${limit}`;
      // Cloisonnement : motif et référence MASQUÉS sur les types confidentiels sans permission dédiée.
      const masked = items.map((r) => r['confidential'] && !sensitive
        ? { ...r, reason: r['reason'] ? 'motif confidentiel' : null, businessRef: r['businessRef'] ? 'référence confidentielle' : null, paramsUsed: {} }
        : r);
      if (!opts.self) {
        await auditAuth(tx, tenantId, {
          action: 'leave_ledger_viewed', actorUserId: actor, module: 'leave',
          recordType: 'entitlement_ledger', recordId: employeeFilter ?? 'liste',
          newValue: { count: masked.length }, result: 'success',
        });
      }
      return { kind: 'ok', items: masked };
    });
  }

  // ================= Ajustement administratif =================

  async adjust(tenantId: string, actor: string, input: {
    employeeId: string; typeId: string; direction: 'credit' | 'debit';
    quantity: number; reason: string; businessRef?: string;
    periodStart: string; periodEnd: string; idempotencyKey?: string;
  }): Promise<TimeOutcome<{ status: string; before: number; after: number | null; entryId: string | null; instanceId?: string }>> {
    if (!['credit', 'debit'].includes(input.direction)) return { kind: 'invalid', reason: 'direction : credit ou debit' };
    if (!(input.quantity > 0)) return { kind: 'invalid', reason: 'quantity : strictement positive (le sens vient de direction)' };
    if (!input.reason || input.reason.length < 3) return { kind: 'invalid', reason: 'motif OBLIGATOIRE (3 caractères minimum)' };
    if (!DATE_RE.test(input.periodStart) || !DATE_RE.test(input.periodEnd)) return { kind: 'invalid', reason: 'période de référence : AAAA-MM-JJ' };
    const today = new Date().toISOString().slice(0, 10);
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'leave.balance_adjust'))) {
        return { kind: 'forbidden', reason: 'permission requise : leave.balance_adjust' };
      }
      const type = await tx.$queryRaw<Array<{ id: string; unit: string; negative_allowed: boolean; confidential: boolean }>>`
        SELECT id, unit, negative_allowed, confidential FROM leave.absence_types WHERE id = ${input.typeId}::uuid`;
      if (type.length === 0) return { kind: 'not_found' };
      // Type CONFIDENTIEL : le motif reste au ledger (masqué à la lecture sans
      // permission dédiée) — il ne part JAMAIS au journal d'audit général.
      const auditReason = type[0]!.confidential ? 'motif confidentiel (type cloisonné)' : input.reason;
      const emp = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM core.employees WHERE id = ${input.employeeId}::uuid AND deleted_at IS NULL`;
      if (emp.length === 0) return { kind: 'not_found' };
      const before = await this.availableOf(tx, input.employeeId, input.typeId, input.periodStart);
      const after = input.direction === 'credit' ? before + input.quantity : before - input.quantity;
      if (after < 0 && !type[0]!.negative_allowed) {
        return { kind: 'conflict', reason: `solde résultant négatif (${after.toFixed(3)}) : ce type ne l'autorise pas` };
      }
      // Seuil de SENSIBILITÉ (E4 à aujourd'hui) : au-delà, circuit E3 si configuré.
      const params = await paramsAt(tx, tenantId, today, ['conges.ajustement.seuil_sensible']);
      const threshold = numericParam(params['conges.ajustement.seuil_sensible']);
      const pendingId = randomUUID();
      if (threshold !== null && input.quantity >= threshold) {
        const stored = await this.storePendingAdjustment(tx, tenantId, actor, pendingId, input, before);
        if (!stored.ok) return { kind: 'conflict', reason: stored.reason };
        const submitted = await this.wf.submit(tenantId, actor, {
          definitionKey: 'conges_ajustement', subjectType: 'leave_adjustment',
          subjectId: pendingId,
          context: {
            employeeId: input.employeeId, typeId: input.typeId,
            direction: input.direction, quantity: input.quantity, before, after,
          },
        });
        if (submitted.kind === 'ok') {
          await tx.$executeRaw`
            UPDATE leave.pending_adjustments SET workflow_instance_id = ${submitted.instanceId}::uuid
             WHERE id = ${pendingId}::uuid`;
          await auditAuth(tx, tenantId, {
            action: 'leave_adjustment_submitted', actorUserId: actor, module: 'leave',
            recordType: 'leave_adjustment', recordId: pendingId,
            newValue: {
              employeeId: input.employeeId, typeId: input.typeId, direction: input.direction,
              quantity: input.quantity, before, after, reason: auditReason, instanceId: submitted.instanceId,
            },
            result: 'success',
          });
          return { kind: 'ok', status: 'pending_workflow', before, after: null, entryId: null, instanceId: submitted.instanceId };
        }
        if (submitted.kind !== 'no_active_definition') {
          return { kind: 'invalid', reason: 'soumission au circuit impossible' };
        }
        // Pas de circuit configuré : l'ajustement sensible reste DIRECT mais motivé + audité.
      }
      const applied = await this.writeAdjustment(tx, tenantId, actor, {
        ...input, idempotencyKey: input.idempotencyKey ?? `adjust:${pendingId}`,
      }, before, after, auditReason);
      if (applied.kind !== 'ok') return applied;
      return { kind: 'ok', status: 'applied', before, after, entryId: applied.entryId };
    });
  }

  /** Dépôt d'un ajustement EN ATTENTE de circuit — le ledger ne porte RIEN avant l'approbation. */
  private async storePendingAdjustment(
    tx: Tx, tenantId: string, actor: string, id: string,
    input: { employeeId: string; typeId: string; direction: string; quantity: number; reason: string; businessRef?: string; periodStart: string; periodEnd: string },
    before: number,
  ): Promise<{ ok: boolean; reason: string }> {
    await tx.$executeRaw`
      INSERT INTO leave.pending_adjustments
        (id, tenant_id, employee_id, absence_type_id, reference_period_start, reference_period_end,
         direction, quantity, reason, business_ref, before_available, created_by)
      VALUES (${id}::uuid, ${tenantId}::uuid, ${input.employeeId}::uuid, ${input.typeId}::uuid,
              ${input.periodStart}::date, ${input.periodEnd}::date, ${input.direction}, ${input.quantity},
              ${input.reason}, ${input.businessRef ?? null}, ${before}, ${actor}::uuid)`;
    return { ok: true, reason: '' };
  }

  /** Application par le circuit (handler E3) — idempotente : la clé du mouvement est l'identifiant de la demande. */
  private async applyAdjustmentTx(tx: Tx, tenantId: string, decidedBy: string | null, pendingId: string): Promise<void> {
    const pend = await tx.$queryRaw<Array<{
      employee_id: string; absence_type_id: string; reference_period_start: string;
      reference_period_end: string; direction: 'credit' | 'debit'; quantity: number;
      reason: string; business_ref: string | null; status: string;
    }>>`
      SELECT employee_id, absence_type_id, reference_period_start::text, reference_period_end::text,
             direction, quantity::float8 AS quantity, reason, business_ref, status
        FROM leave.pending_adjustments WHERE id = ${pendingId}::uuid FOR UPDATE`;
    const p = pend[0];
    if (!p) return;
    await tx.$executeRaw`
      INSERT INTO leave.entitlement_ledger
        (tenant_id, employee_id, absence_type_id, reference_period_start, reference_period_end,
         entry_kind, quantity, unit, effective_on, origin, business_ref, reason, idempotency_key, created_by)
      SELECT ${tenantId}::uuid, ${p.employee_id}::uuid, ${p.absence_type_id}::uuid,
             ${p.reference_period_start}::date, ${p.reference_period_end}::date,
             ${p.direction === 'credit' ? 'adjustment_credit' : 'adjustment_debit'},
             ${p.quantity}, t.unit, CURRENT_DATE, 'workflow', ${p.business_ref},
             ${p.reason}, ${`adjust:${pendingId}`}, ${decidedBy}::uuid
        FROM leave.absence_types t WHERE t.id = ${p.absence_type_id}::uuid
      ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`;
    await tx.$executeRaw`
      UPDATE leave.pending_adjustments SET status = 'applied', decided_at = now()
       WHERE id = ${pendingId}::uuid AND status = 'pending'`;
    await auditAuth(tx, tenantId, {
      action: 'leave_adjustment_applied', actorUserId: decidedBy ?? undefined, module: 'leave',
      recordType: 'leave_adjustment', recordId: pendingId,
      newValue: { direction: p.direction, quantity: p.quantity }, result: 'success',
    });
  }

  private async writeAdjustment(
    tx: Tx, tenantId: string, actor: string,
    input: { employeeId: string; typeId: string; direction: 'credit' | 'debit'; quantity: number; reason: string; businessRef?: string; periodStart: string; periodEnd: string; idempotencyKey: string },
    before: number, after: number, auditReason: string,
  ): Promise<{ kind: 'ok'; entryId: string } | { kind: 'conflict'; reason: string }> {
    try {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO leave.entitlement_ledger
          (tenant_id, employee_id, absence_type_id, reference_period_start, reference_period_end,
           entry_kind, quantity, unit, effective_on, origin, business_ref, reason, idempotency_key, created_by)
        SELECT ${tenantId}::uuid, ${input.employeeId}::uuid, ${input.typeId}::uuid,
               ${input.periodStart}::date, ${input.periodEnd}::date,
               ${input.direction === 'credit' ? 'adjustment_credit' : 'adjustment_debit'},
               ${input.quantity}, t.unit, CURRENT_DATE, 'admin', ${input.businessRef ?? null},
               ${input.reason}, ${input.idempotencyKey}, ${actor}::uuid
          FROM leave.absence_types t WHERE t.id = ${input.typeId}::uuid
        RETURNING id`;
      await auditAuth(tx, tenantId, {
        action: 'leave_adjustment_applied', actorUserId: actor, module: 'leave',
        recordType: 'entitlement_ledger', recordId: rows[0]!.id,
        newValue: { direction: input.direction, quantity: input.quantity, before, after, reason: auditReason }, result: 'success',
      });
      await this.notify.publishEventTx(tx, tenantId, {
        eventKey: `conges-ajustement-${rows[0]!.id}`, templateKey: 'conges_ajustement_applique',
        payload: { direction: input.direction, quantite: input.quantity },
        recipients: [{ userId: actor }], source: 'business',
        subjectType: 'entitlement_ledger', subjectId: rows[0]!.id, createdBy: actor,
      });
      return { kind: 'ok', entryId: rows[0]!.id };
    } catch (e) {
      if ((e as Error).message.includes('idempotency_key')) {
        return { kind: 'conflict', reason: 'clé d\'idempotence déjà utilisée : ajustement DÉJÀ enregistré' };
      }
      throw e;
    }
  }

  private async availableOf(tx: Tx, employeeId: string, typeId: string, periodStart: string): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ available: unknown }>>`
      SELECT available FROM leave.balances_v
       WHERE employee_id = ${employeeId}::uuid AND absence_type_id = ${typeId}::uuid
         AND reference_period_start = ${periodStart}::date`;
    return rows[0] ? Number(rows[0].available) : 0;
  }

  // ================= Import des soldes d'ouverture =================

  async importOpenings(tenantId: string, actor: string, input: {
    mode: 'preview' | 'apply'; asOfDate: string; contentText: string;
    filename?: string; atomic?: boolean; sourceNote?: string;
  }): Promise<TimeOutcome<{ kind2: string; counts: Record<string, number>; errors: unknown[]; importId: string | null }>> {
    if (!DATE_RE.test(input.asOfDate)) return { kind: 'invalid', reason: 'asOfDate : AAAA-MM-JJ' };
    if (!input.contentText || input.contentText.length > 2_000_000) return { kind: 'invalid', reason: 'contenu CSV requis (≤ 2 Mo)' };
    const atomic = input.atomic ?? true;
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'leave.openings_import'))) {
        return { kind: 'forbidden', reason: 'permission requise : leave.openings_import' };
      }
      const lines = input.contentText.split(/\r?\n/).filter((l) => l.trim().length > 0);
      if (lines.length < 2) return { kind: 'invalid', reason: 'CSV vide (entête + lignes attendues)' };
      const header = lines[0]!.split(';').map((h) => h.trim().toLowerCase());
      const idx = (name: string): number => header.indexOf(name);
      for (const req of ['matricule', 'type', 'quantite']) {
        if (idx(req) === -1) return { kind: 'invalid', reason: `colonne « ${req} » manquante (entête matricule;type;quantite[;periode_debut;periode_fin;source])` };
      }
      const types = await tx.$queryRaw<Array<{ id: string; code: string; unit: string }>>`
        SELECT id, code, unit FROM leave.absence_types`;
      const typeByCode = new Map<string, { id: string; code: string; unit: string }>(types.map((t) => [t.code, t]));
      const errors: Array<Record<string, unknown>> = [];
      const seenKeys = new Set<string>();
      const parsed: Array<{
        line: number; employeeId: string; typeId: string; unit: string; qty: number;
        periodStart: string; periodEnd: string; source: string | null; key: string;
      }> = [];
      let duplicated = 0;
      const year = input.asOfDate.slice(0, 4);
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i]!.split(';').map((c) => c.trim());
        const mat = cols[idx('matricule')] ?? '';
        const typeCode = (cols[idx('type')] ?? '').toUpperCase();
        const qtyRaw = (cols[idx('quantite')] ?? '').replace(',', '.');
        const qty = Number(qtyRaw);
        const pStart = idx('periode_debut') >= 0 && cols[idx('periode_debut')] ? cols[idx('periode_debut')]! : `${year}-01-01`;
        const pEnd = idx('periode_fin') >= 0 && cols[idx('periode_fin')] ? cols[idx('periode_fin')]! : `${year}-12-31`;
        const source = idx('source') >= 0 ? (cols[idx('source')] || null) : null;
        const type = typeByCode.get(typeCode);
        if (!type) { errors.push({ line: i + 1, error: `type « ${typeCode} » inconnu` }); continue; }
        if (!Number.isFinite(qty) || qty <= 0) { errors.push({ line: i + 1, error: `quantité invalide « ${qtyRaw} »` }); continue; }
        if (!DATE_RE.test(pStart) || !DATE_RE.test(pEnd) || pEnd < pStart) { errors.push({ line: i + 1, error: 'période de référence invalide' }); continue; }
        const emp = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM core.employees WHERE matricule = ${mat} AND deleted_at IS NULL`;
        if (emp.length === 0) { errors.push({ line: i + 1, error: `matricule « ${mat} » inconnu` }); continue; }
        const key = `opening:${input.asOfDate}:${mat}:${typeCode}`;
        if (seenKeys.has(key)) { errors.push({ line: i + 1, error: `doublon DANS le fichier (${mat} / ${typeCode})` }); continue; }
        seenKeys.add(key);
        const already = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM leave.entitlement_ledger WHERE idempotency_key = ${key}`;
        if (already.length > 0) { duplicated += 1; continue; }
        parsed.push({ line: i + 1, employeeId: emp[0]!.id, typeId: type.id, unit: type.unit, qty, periodStart: pStart, periodEnd: pEnd, source, key });
      }
      const counts = {
        received: lines.length - 1, accepted: parsed.length,
        duplicated, rejected: errors.length,
      };
      if (input.mode === 'preview') {
        return { kind: 'ok', kind2: 'preview', counts, errors, importId: null };
      }
      if (atomic && errors.length > 0) {
        const imp = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO leave.opening_imports
            (tenant_id, filename, as_of_date, status, atomic, lines_received, lines_accepted, lines_duplicated, lines_rejected, error_report, source_note, created_by)
          VALUES (${tenantId}::uuid, ${input.filename ?? null}, ${input.asOfDate}::date, 'rejected', true,
                  ${counts.received}, 0, ${duplicated}, ${errors.length}, ${JSON.stringify(errors.slice(0, 200))}::jsonb,
                  ${input.sourceNote ?? null}, ${actor}::uuid)
          RETURNING id`;
        await auditAuth(tx, tenantId, {
          action: 'leave_openings_import_rejected', actorUserId: actor, module: 'leave',
          recordType: 'opening_import', recordId: imp[0]!.id, newValue: counts, result: 'failure',
        });
        return { kind: 'ok', kind2: 'rejected', counts: { ...counts, accepted: 0 }, errors, importId: imp[0]!.id };
      }
      const imp = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO leave.opening_imports
          (tenant_id, filename, as_of_date, status, atomic, lines_received, lines_accepted, lines_duplicated, lines_rejected, error_report, source_note, created_by)
        VALUES (${tenantId}::uuid, ${input.filename ?? null}, ${input.asOfDate}::date, 'applied', ${atomic},
                ${counts.received}, ${parsed.length}, ${duplicated}, ${errors.length}, ${JSON.stringify(errors.slice(0, 200))}::jsonb,
                ${input.sourceNote ?? null}, ${actor}::uuid)
        RETURNING id`;
      for (const p of parsed) {
        await tx.$executeRaw`
          INSERT INTO leave.entitlement_ledger
            (tenant_id, employee_id, absence_type_id, reference_period_start, reference_period_end,
             entry_kind, quantity, unit, effective_on, origin, business_ref, reason, idempotency_key, created_by)
          VALUES (${tenantId}::uuid, ${p.employeeId}::uuid, ${p.typeId}::uuid, ${p.periodStart}::date, ${p.periodEnd}::date,
                  'opening_balance', ${p.qty}, ${p.unit}, ${input.asOfDate}::date, 'import',
                  ${`import:${imp[0]!.id}`}, ${p.source}, ${p.key}, ${actor}::uuid)
          ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`;
      }
      await auditAuth(tx, tenantId, {
        action: 'leave_openings_imported', actorUserId: actor, module: 'leave',
        recordType: 'opening_import', recordId: imp[0]!.id, newValue: counts, result: 'success',
      });
      return { kind: 'ok', kind2: 'applied', counts, errors, importId: imp[0]!.id };
    }, { timeoutMs: 60_000 });
  }

  async listImports(tenantId: string, actor: string): Promise<TimeOutcome<{ items: unknown[] }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'leave.openings_import', 'leave.balance_view'))) {
        return { kind: 'forbidden', reason: 'permission requise : leave.openings_import' };
      }
      const items = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT id, filename, as_of_date::text AS "asOfDate", status, atomic,
               lines_received AS "linesReceived", lines_accepted AS "linesAccepted",
               lines_duplicated AS "linesDuplicated", lines_rejected AS "linesRejected",
               error_report AS "errorReport", source_note AS "sourceNote", created_at AS "createdAt"
          FROM leave.opening_imports ORDER BY created_at DESC LIMIT 50`;
      return { kind: 'ok', items };
    });
  }

  // ================= Décompte d'une plage (préversion) =================

  async count(tenantId: string, actor: string, opts: {
    employeeId?: string; typeId: string; from: string; to: string;
    halfStart?: boolean; halfEnd?: boolean;
  }): Promise<TimeOutcome<{ count: unknown }>> {
    if (!DATE_RE.test(opts.from) || !DATE_RE.test(opts.to) || opts.to < opts.from) {
      return { kind: 'invalid', reason: 'plage invalide (AAAA-MM-JJ, from ≤ to)' };
    }
    const span = (Date.parse(opts.to) - Date.parse(opts.from)) / 86_400_000;
    if (span > 92) return { kind: 'invalid', reason: 'plage bornée à 92 jours' };
    return this.prisma.withTenant(tenantId, async (tx) => {
      let employeeId = opts.employeeId ?? null;
      const me = await linkedEmployee(tx, actor);
      if (employeeId === null || employeeId === me) {
        if (!(await holdsPermission(tx, actor, 'leave.balance_view_own'))) {
          return { kind: 'forbidden', reason: 'permission requise : leave.balance_view_own' };
        }
        if (!me) return { kind: 'invalid', reason: 'compte non relié à un dossier salarié' };
        employeeId = me;
      } else {
        const scope = await this.readableEmployees(tx, actor, opts.from);
        if (scope.mode === 'none') return { kind: 'forbidden', reason: 'permission requise : leave.balance_view' };
        if (scope.mode === 'list' && !scope.ids.includes(employeeId)) {
          if (scope.rhScoped === null || !(await this.coveredByRh(tx, scope.rhScoped, employeeId, opts.from))) {
            return { kind: 'not_found' };
          }
        }
      }
      const type = await tx.$queryRaw<Array<{ unit: string }>>`
        SELECT unit FROM leave.absence_types WHERE id = ${opts.typeId}::uuid`;
      if (type.length === 0) return { kind: 'not_found' };
      const unit = type[0]!.unit as LeaveUnit;
      // Régime des jours OUVRABLES : paramètre E4, résolu à la date de début.
      let workableWeekdays: number[] | undefined;
      if (unit === 'working_days') {
        const p = await paramsAt(tx, tenantId, opts.from, ['conges.ouvrables.jours']);
        const v = p['conges.ouvrables.jours']?.source === 'parametre' ? p['conges.ouvrables.jours']!.value : null;
        if (Array.isArray(v) && v.every((x) => typeof x === 'number')) workableWeekdays = v as number[];
      }
      const days: CountingDay[] = [];
      for (let d = opts.from; d <= opts.to; d = addDays(d, 1)) {
        const sched = await this.schedules.resolveScheduleAt(tx, employeeId, d) as {
          assigned: boolean;
          day?: { isRest: boolean; startMinute: number | null; endMinute: number | null; breakStartMinute: number | null; breakEndMinute: number | null } | null;
          exception?: { kind: string; startMinute: number | null; endMinute: number | null } | null;
          holidays?: unknown[];
        };
        const weekday = new Date(`${d}T00:00:00Z`).getUTCDay();
        const isHoliday = (sched.holidays?.length ?? 0) > 0;
        let scheduled = false, isRest = true, planned = 0;
        const day = sched.assigned ? sched.day : null;
        const exc = sched.exception ?? null;
        if (exc && (exc.kind === 'closed' || exc.kind === 'rest')) {
          scheduled = false; isRest = true; planned = 0;
        } else if (exc && exc.kind === 'special_hours' && exc.startMinute !== null && exc.endMinute !== null) {
          scheduled = true; isRest = false;
          planned = exc.endMinute > exc.startMinute ? exc.endMinute - exc.startMinute : exc.endMinute + 1440 - exc.startMinute;
        } else if (day && !day.isRest && day.startMinute !== null && day.endMinute !== null) {
          scheduled = true; isRest = false;
          planned = day.endMinute > day.startMinute ? day.endMinute - day.startMinute : day.endMinute + 1440 - day.startMinute;
          if (day.breakStartMinute !== null && day.breakEndMinute !== null && day.breakEndMinute > day.breakStartMinute) {
            planned -= day.breakEndMinute - day.breakStartMinute;
          }
        }
        days.push({ date: d, scheduled, plannedMinutes: planned, isRest, isHoliday, weekday });
      }
      const result = countLeave({
        unit, days, workableWeekdays,
        halfStart: opts.halfStart, halfEnd: opts.halfEnd,
      });
      return { kind: 'ok', count: { employeeId, typeId: opts.typeId, from: opts.from, to: opts.to, ...result } };
    });
  }

  private enginePolicy(row: { policyId: string; policyVersion: number; unit: string; content: Record<string, unknown> },
    rates: { accrualRate: number | null; carryOverMax: number | null; capValue: number | null }): ResolvedPolicy {
    const c = row.content;
    return {
      policyId: row.policyId, policyVersion: row.policyVersion,
      unit: row.unit as ResolvedPolicy['unit'],
      accrualMode: c['accrual_mode'] as ResolvedPolicy['accrualMode'],
      accrualRate: rates.accrualRate, rateSource: { kind: 'policy_value' },
      referencePeriod: c['reference_period'] as ResolvedPolicy['referencePeriod'],
      refStartMonth: (c['ref_start_month'] as number | null) ?? undefined,
      refStartDay: (c['ref_start_day'] as number | null) ?? undefined,
      prorataHire: c['prorata_hire'] as boolean,
      prorataTermination: c['prorata_termination'] as boolean,
      rounding: c['rounding'] as ResolvedPolicy['rounding'],
      accrualRequiresService: c['accrual_requires_service'] as boolean,
      capValue: rates.capValue, carryOverMax: rates.carryOverMax,
      carryOverExpiryMonths: (c['carry_over_expiry_months'] as number | null) ?? null,
    };
  }
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}
