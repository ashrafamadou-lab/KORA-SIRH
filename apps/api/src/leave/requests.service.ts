/**
 * E11.2 — Demandes de congés et d'absences (ESS) : brouillon → soumission FIGÉE
 * et versionnée → circuit E3 configurable (séparation des tâches par défaut) →
 * application IDEMPOTENTE (absence + consommation + neutralisation de la
 * réservation), annulation par circuit DISTINCT, demandes pour tiers motivées,
 * rétroactif contrôlé (période close = constat, JAMAIS un impact automatique),
 * justificatifs cloisonnés, file RH, expiration administrative.
 *
 * Une demande ne touche JAMAIS un solde : chaque effet est un mouvement
 * append-only du ledger E11.1 (reservation / release / consumption / reversal),
 * idempotent PAR LA BASE (clé unique). Deux absences approuvées ne se
 * chevauchent jamais : contrainte d'EXCLUSION. Le décompte est recalculé côté
 * serveur à la soumission avec le calendrier E10 réel — la valeur du client
 * n'est qu'un affichage.
 */
import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { auditAuth } from '../auth/audit.util';
import { NotificationService } from '../notify/notification.service';
import { WorkflowService, type ActorIdentity } from '../workflow/workflow.service';
import { LeaveCatalogService } from './catalog.service';
import { LeaveBalancesService } from './balances.service';
import {
  DATE_RE, holdsPermission, scopeSetFor, type ScopeSet, type TimeOutcome,
  linkedEmployee, teamEmployeeIds, paramsAt, numericParam, pgCode,
} from './leave-access';
import {
  verifySubmission, hasBlocking, circuitFor, reservationKey, releaseKey, consumptionKey,
  cancellationReversalKey, capacityAlerts, calendarLabelMode,
  type CheckItem, type SubmissionFacts,
} from '../../../../packages/core/src/leave-requests.ts';
import { projectBalance } from '../../../../packages/core/src/leave.ts';

type Tx = Prisma.TransactionClient;

interface DraftPayload {
  startDate: string; endDate: string;
  halfDayStart: boolean; halfDayEnd: boolean;
  hours: number | null; comment: string | null;
}

interface RequestRow {
  id: string; employee_id: string; absence_type_id: string; status: string;
  current_version: number; draft_payload: Record<string, unknown>;
  on_behalf: boolean; on_behalf_reason: string | null; on_behalf_permission: string | null;
  source: string; employee_confirmed_at: string | null;
  workflow_instance_id: string | null; cancel_workflow_instance_id: string | null;
  created_by: string;
}

interface TypeRow {
  id: string; code: string; label_fr: string; label_en: string; unit: string;
  justification: string; deposit_delay_days: number | null; retroactive_allowed: boolean;
  negative_allowed: boolean; confidential: boolean; workflow_required: boolean; status: string;
}

const MASKED = 'motif confidentiel';

@Injectable()
export class LeaveRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notify: NotificationService,
    private readonly wf: WorkflowService,
    private readonly catalog: LeaveCatalogService,
    private readonly balances: LeaveBalancesService,
  ) {
    // Pont E3 → demande : la DÉCISION évolue dans la même transaction ; toute
    // APPLICATION (mouvements + absence) reste hors décision — son échec ne
    // peut jamais annuler une approbation (leçon E10.3).
    this.wf.registerSubjectHandler('leave_request', (tx, tenantId, subjectId, status) =>
      this.onDecision(tx, tenantId, subjectId, status));
    this.wf.registerSubjectHandler('leave_request_cancel', (tx, tenantId, subjectId, status) =>
      this.onCancelDecision(tx, tenantId, subjectId, status));
  }

  // ==================================================================
  // Création / brouillon / confirmation
  // ==================================================================

  async create(tenantId: string, actor: string, input: {
    employeeId?: string; typeId: string; startDate: string; endDate: string;
    halfDayStart?: boolean; halfDayEnd?: boolean; hours?: number; comment?: string;
    onBehalfReason?: string;
  }): Promise<TimeOutcome<{ id: string; onBehalf: boolean }>> {
    if (!DATE_RE.test(input.startDate) || !DATE_RE.test(input.endDate) || input.endDate < input.startDate) {
      return { kind: 'invalid', reason: 'période invalide (AAAA-MM-JJ, début ≤ fin)' };
    }
    if (spanDays(input.startDate, input.endDate) > 92) return { kind: 'invalid', reason: 'période bornée à 92 jours' };
    if (input.hours !== undefined && (input.hours <= 0 || input.hours > 24 || input.startDate !== input.endDate)) {
      return { kind: 'invalid', reason: 'heures : volume positif sur UNE seule journée' };
    }
    return this.prisma.withTenant(tenantId, async (tx) => {
      const me = await linkedEmployee(tx, actor);
      let employeeId = input.employeeId ?? me;
      let onBehalf = false;
      let permissionUsed: string | null = null;
      let source = 'ess';
      if (!employeeId) return { kind: 'invalid', reason: 'compte non relié à un dossier salarié — précisez employeeId' };
      if (employeeId === me) {
        if (!(await holdsPermission(tx, actor, 'leave.request_self'))) {
          return { kind: 'forbidden', reason: 'permission requise : leave.request_self' };
        }
      } else {
        // Demande POUR UN TIERS (§11) : permission + périmètre réel + motif.
        if (!(await holdsPermission(tx, actor, 'leave.request_for_others'))) {
          return { kind: 'forbidden', reason: 'permission requise : leave.request_for_others' };
        }
        const team = await teamEmployeeIds(tx, actor, input.startDate);
        let covered = team.includes(employeeId);
        if (!covered) {
          const set = await scopeSetFor(tx, actor, 'leave.request_for_others');
          covered = set.kind === 'all' || (set.kind === 'scoped' && await this.inScope(tx, set, employeeId, input.startDate));
        }
        if (!covered) return { kind: 'not_found' };
        if (!input.onBehalfReason || input.onBehalfReason.trim().length < 3) {
          return { kind: 'invalid', reason: 'demande pour un tiers : motif obligatoire (onBehalfReason)' };
        }
        onBehalf = true;
        permissionUsed = 'leave.request_for_others';
        source = (await holdsPermission(tx, actor, 'leave.requests_admin')) ? 'rh' : 'manager';
      }
      const type = await this.typeRow(tx, input.typeId);
      if (!type || type.status !== 'active') return { kind: 'invalid', reason: 'type d\'absence inconnu ou inactif' };
      const payload: DraftPayload = {
        startDate: input.startDate, endDate: input.endDate,
        halfDayStart: input.halfDayStart === true, halfDayEnd: input.halfDayEnd === true,
        hours: input.hours ?? null, comment: input.comment ?? null,
      };
      const ins = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO leave.requests (tenant_id, employee_id, absence_type_id, created_by, draft_payload,
                                    on_behalf, on_behalf_reason, on_behalf_permission, source)
        VALUES (${tenantId}::uuid, ${employeeId}::uuid, ${input.typeId}::uuid, ${actor}::uuid,
                ${JSON.stringify(payload)}::jsonb, ${onBehalf}, ${input.onBehalfReason ?? null},
                ${permissionUsed}, ${source})
        RETURNING id`;
      const id = ins[0]!.id;
      await this.event(tx, tenantId, id, null, 'created', actor, {
        onBehalf, source, typeCode: type.code,
      });
      await auditAuth(tx, tenantId, {
        action: onBehalf ? 'leave_request_created_for_other' : 'leave_request_created',
        actorUserId: actor, module: 'leave', recordType: 'leave_request', recordId: id,
        newValue: { employeeId, type: type.confidential ? MASKED : type.code, start: input.startDate, end: input.endDate },
        result: 'success',
      });
      return { kind: 'ok', id, onBehalf };
    });
  }

  async updateDraft(tenantId: string, actor: string, id: string, input: {
    startDate?: string; endDate?: string; halfDayStart?: boolean; halfDayEnd?: boolean;
    hours?: number | null; comment?: string | null;
  }): Promise<TimeOutcome<{ updated: boolean }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const req = await this.lockRequest(tx, id);
      if (!req) return { kind: 'not_found' };
      const who = await this.ownership(tx, actor, req);
      if (!who.ownerOrAdmin) return { kind: 'forbidden', reason: 'brouillon : réservé au salarié, à l\'auteur ou à l\'administration' };
      if (req.status !== 'draft' && req.status !== 'returned') {
        return { kind: 'conflict', reason: `demande au statut « ${req.status} » — contenu figé, resoumission requise` };
      }
      const cur = req.draft_payload as unknown as DraftPayload;
      const next: DraftPayload = {
        startDate: input.startDate ?? cur.startDate,
        endDate: input.endDate ?? cur.endDate,
        halfDayStart: input.halfDayStart ?? cur.halfDayStart,
        halfDayEnd: input.halfDayEnd ?? cur.halfDayEnd,
        hours: input.hours === undefined ? cur.hours : input.hours,
        comment: input.comment === undefined ? cur.comment : input.comment,
      };
      if (!DATE_RE.test(next.startDate) || !DATE_RE.test(next.endDate) || next.endDate < next.startDate) {
        return { kind: 'invalid', reason: 'période invalide (AAAA-MM-JJ, début ≤ fin)' };
      }
      if (spanDays(next.startDate, next.endDate) > 92) return { kind: 'invalid', reason: 'période bornée à 92 jours' };
      if (next.hours !== null && (next.hours <= 0 || next.hours > 24 || next.startDate !== next.endDate)) {
        return { kind: 'invalid', reason: 'heures : volume positif sur UNE seule journée' };
      }
      await tx.$executeRaw`
        UPDATE leave.requests SET draft_payload = ${JSON.stringify(next)}::jsonb WHERE id = ${id}::uuid`;
      await this.event(tx, tenantId, id, null, 'draft_updated', actor, {});
      await auditAuth(tx, tenantId, {
        action: 'leave_request_draft_updated', actorUserId: actor, module: 'leave',
        recordType: 'leave_request', recordId: id, result: 'success',
      });
      return { kind: 'ok', updated: true };
    });
  }

  /** Confirmation par le SALARIÉ d'une demande déposée pour lui (paramètre E4). */
  async confirm(tenantId: string, actor: string, id: string): Promise<TimeOutcome<{ confirmed: boolean }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const req = await this.lockRequest(tx, id);
      if (!req) return { kind: 'not_found' };
      const me = await linkedEmployee(tx, actor);
      if (me !== req.employee_id) return { kind: 'forbidden', reason: 'seul le salarié bénéficiaire confirme' };
      if (req.status !== 'draft' && req.status !== 'returned') {
        return { kind: 'conflict', reason: 'confirmation avant soumission uniquement' };
      }
      await tx.$executeRaw`
        UPDATE leave.requests SET employee_confirmed_at = COALESCE(employee_confirmed_at, now()) WHERE id = ${id}::uuid`;
      await this.event(tx, tenantId, id, null, 'confirmation_given', actor, {});
      await auditAuth(tx, tenantId, {
        action: 'leave_request_confirmed', actorUserId: actor, module: 'leave',
        recordType: 'leave_request', recordId: id, result: 'success',
      });
      return { kind: 'ok', confirmed: true };
    });
  }

  // ==================================================================
  // Évaluation (prévisualisation ET soumission — MÊME calcul serveur)
  // ==================================================================

  private async evaluate(tx: Tx, tenantId: string, actor: string, req: RequestRow, type: TypeRow) {
    const p = req.draft_payload as unknown as DraftPayload;
    const today = new Date().toISOString().slice(0, 10);
    // Décompte E10 réel (horaire résolu, exceptions, rotations, fériés, régime E4).
    const count = await this.balances.countForEmployeeTx(
      tx, tenantId, req.employee_id, type.unit as never, p.startDate, p.endDate,
      { halfStart: p.halfDayStart, halfEnd: p.halfDayEnd },
    );
    let quantity = count.quantity;
    let plannedHoursOnDay: number | null = null;
    if (type.unit === 'hours' && p.hours !== null) {
      const day = count.days.find((d) => d.date === p.startDate);
      plannedHoursOnDay = day ? Math.round((day.plannedMinutes / 60) * 100) / 100 : 0;
      quantity = p.hours;
    }
    // Politique + règles à la DATE DE DÉBUT (fait générateur de la demande).
    const resolved = await this.catalog.resolveFor(tx, tenantId, req.employee_id, req.absence_type_id, p.startDate);
    if (resolved.kind === 'ambiguous') {
      return { kind: 'conflict' as const, reason: `politiques AMBIGUËS : ${resolved.codes.join(', ')} — corrigez les populations` };
    }
    const policy = resolved.kind === 'ok' ? resolved.row : null;
    const content = policy?.content ?? {};
    let paramsUsed: Record<string, unknown> = {};
    let available: number | null = null;
    let projectedAtStart: number | null = null;
    if (policy) {
      const rates = await this.catalog.resolveRates(tx, tenantId, policy, p.startDate);
      paramsUsed = rates.paramsUsed;
      const bal = await tx.$queryRaw<Array<{ available: unknown }>>`
        SELECT available FROM leave.balances_v
         WHERE employee_id = ${req.employee_id}::uuid AND absence_type_id = ${req.absence_type_id}::uuid
         ORDER BY reference_period_start DESC LIMIT 1`;
      available = bal[0] ? Number(bal[0].available) : 0;
      // Sa PROPRE réservation active ne compte pas contre elle : l'avant/après d'une
      // demande déjà soumise repart du disponible SANS elle (une resoumission libère
      // l'ancienne réservation dans la même transaction).
      if (req.current_version > 0) {
        const own = await tx.$queryRaw<Array<{ q: unknown }>>`
          SELECT COALESCE(sum(CASE entry_kind WHEN 'reservation' THEN quantity ELSE -quantity END), 0) AS q
            FROM leave.entitlement_ledger
           WHERE tenant_id = ${tenantId}::uuid AND request_id = ${req.id}::uuid
             AND request_version = ${req.current_version}
             AND entry_kind IN ('reservation', 'release')`;
        available = Math.round((available + Number(own[0]?.q ?? 0)) * 1000) / 1000;
      }
      const emp = await tx.$queryRaw<Array<{ hire_date: string | null }>>`
        SELECT hire_date::text FROM core.employees WHERE id = ${req.employee_id}::uuid`;
      if (emp[0]?.hire_date && p.startDate > today) {
        const proj = projectBalance({
          policy: {
            policyId: policy.policyId, policyVersion: policy.policyVersion,
            unit: policy.unit as never,
            accrualMode: content['accrual_mode'] as never,
            accrualRate: rates.accrualRate, rateSource: { kind: 'policy_value' },
            referencePeriod: content['reference_period'] as never,
            refStartMonth: (content['ref_start_month'] as number | null) ?? undefined,
            refStartDay: (content['ref_start_day'] as number | null) ?? undefined,
            prorataHire: content['prorata_hire'] as boolean,
            prorataTermination: content['prorata_termination'] as boolean,
            rounding: content['rounding'] as never,
            accrualRequiresService: content['accrual_requires_service'] as boolean,
            capValue: rates.capValue, carryOverMax: rates.carryOverMax,
            carryOverExpiryMonths: (content['carry_over_expiry_months'] as number | null) ?? null,
          },
          employment: { hireDate: emp[0].hire_date, terminationDate: null, suspensions: [] },
          currentAvailable: available, fromDateExclusive: today, toDate: p.startDate,
        });
        projectedAtStart = proj.projected;
      } else {
        projectedAtStart = available;
      }
    }
    // Emploi : actif, non suspendu sur la période, cessation respectée.
    const employment = await this.employmentFacts(tx, req.employee_id);
    const activeOk = employment.hireDate !== null && employment.hireDate <= p.startDate
      && (employment.terminationDate === null || employment.terminationDate >= p.endDate)
      && employment.status === 'active';
    const suspendedDays = employment.suspensions.reduce((acc, s) => {
      const from = s.from > p.startDate ? s.from : p.startDate;
      const to = s.to !== null && s.to < p.endDate ? s.to : p.endDate;
      return to >= from ? acc + spanDays(from, to) + 1 : acc;
    }, 0);
    // Chevauchements : demandes vivantes et absences approuvées.
    const overlapReq = await tx.$queryRaw<Array<{ n: unknown }>>`
      SELECT count(*) AS n FROM leave.requests r
        JOIN leave.request_versions v
          ON v.tenant_id = r.tenant_id AND v.request_id = r.id AND v.version = r.current_version
       WHERE r.employee_id = ${req.employee_id}::uuid AND r.id <> ${req.id}::uuid
         AND r.status IN ('submitted', 'in_review', 'approved', 'approved_pending_application', 'application_failed')
         AND daterange(v.start_date, v.end_date, '[]') && daterange(${p.startDate}::date, ${p.endDate}::date, '[]')`;
    const overlapAbs = await tx.$queryRaw<Array<{ n: unknown }>>`
      SELECT count(*) AS n FROM leave.absences a
       WHERE a.employee_id = ${req.employee_id}::uuid AND a.status = 'approved'
         AND a.request_id <> ${req.id}::uuid
         AND daterange(a.start_date, a.end_date, '[]') && daterange(${p.startDate}::date, ${p.endDate}::date, '[]')`;
    // Périodes de présence closes/verrouillées couvertes + exports paie produits.
    const closed = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT p2.id FROM time.periods p2
       WHERE p2.status IN ('locked', 'closed', 'archived')
         AND daterange(p2.period_start, p2.period_end, '[]') && daterange(${p.startDate}::date, ${p.endDate}::date, '[]')
         AND (p2.scope_kind = 'tenant'
           OR EXISTS (SELECT 1 FROM core.employee_assignments a
                       WHERE a.employee_id = ${req.employee_id}::uuid AND a.is_primary
                         AND daterange(a.effective_from, a.effective_to, '[)') @> p2.period_start
                         AND ((p2.scope_kind = 'company' AND a.company_id = p2.company_id)
                           OR (p2.scope_kind = 'site'    AND a.site_id    = p2.site_id))))`;
    let payrollExports = 0;
    if (closed.length > 0) {
      const ids = closed.map((c) => c.id).join(',');
      const pe = await tx.$queryRaw<Array<{ n: unknown }>>`
        SELECT count(*) AS n FROM time.payroll_exports e
          JOIN time.period_closes c ON c.id = e.close_id
         WHERE e.status = 'active' AND c.period_id = ANY(string_to_array(${ids}, ',')::uuid[])`;
      payrollExports = Number(pe[0]?.n ?? 0);
    }
    const attachments = await tx.$queryRaw<Array<{ n: unknown }>>`
      SELECT count(*) AS n FROM leave.request_attachments
       WHERE request_id = ${req.id}::uuid AND deleted_at IS NULL`;
    // Paramètre E4 : la demande pour tiers exige-t-elle la confirmation du salarié ?
    const confirmProv = await paramsAt(tx, tenantId, p.startDate, ['conges.demande.confirmation_salarie']);
    const confirmParam = numericParam(confirmProv['conges.demande.confirmation_salarie']);
    const beneficiary = await tx.$queryRaw<Array<{ user_id: string | null }>>`
      SELECT user_id FROM core.employees WHERE id = ${req.employee_id}::uuid`;
    const confirmationRequired = req.on_behalf && confirmParam === 1 && beneficiary[0]?.user_id !== null;
    const retroactive = p.startDate < today;
    const facts: SubmissionFacts = {
      quantity, unit: type.unit as never, startDate: p.startDate, submittedOn: today,
      employmentActive: activeOk, suspendedDays,
      policyFound: policy !== null, available, projectedAtStart,
      negativeAllowed: type.negative_allowed,
      anticipationAllowed: content['anticipation_allowed'] === true,
      minBlock: numOrNull(content['min_block']),
      maxPerRequest: numOrNull(content['max_per_request']),
      noticeDays: numOrNull(content['notice_days']),
      retroactiveAllowed: type.retroactive_allowed,
      actorHasRetroPermission: await holdsPermission(tx, actor, 'leave.request_retroactive'),
      retroReason: (p.comment ?? null),
      depositDelayDays: type.deposit_delay_days,
      justificationRequired: type.justification === 'required',
      attachmentCount: Number(attachments[0]?.n ?? 0),
      overlappingRequests: Number(overlapReq[0]?.n ?? 0),
      overlappingAbsences: Number(overlapAbs[0]?.n ?? 0),
      closedPeriodsCovered: closed.length,
      payrollExportsCovered: payrollExports,
      halfDayAsked: p.halfDayStart || p.halfDayEnd,
      hoursAsked: type.unit === 'hours' ? p.hours : null,
      plannedHoursOnDay,
      confirmationRequired, confirmed: req.employee_confirmed_at !== null,
    };
    const checks = verifySubmission(facts);
    return {
      kind: 'ok' as const, payload: p, quantity, unit: type.unit, count, checks,
      policy, paramsUsed, available, projectedAtStart, retroactive,
      circuitKey: circuitFor({ retroactive, confidential: type.confidential }),
      afterAvailable: available === null ? null : Math.round((available - quantity) * 1000) / 1000,
    };
  }

  async preview(tenantId: string, actor: string, id: string): Promise<TimeOutcome<{ preview: unknown }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const req = await this.getRequest(tx, id);
      if (!req) return { kind: 'not_found' };
      const who = await this.ownership(tx, actor, req);
      if (!who.ownerOrAdmin && !who.team) return { kind: 'forbidden', reason: 'prévisualisation : demandeur, salarié, équipe ou administration' };
      const type = await this.typeRow(tx, req.absence_type_id);
      if (!type) return { kind: 'not_found' };
      const ev = await this.evaluate(tx, tenantId, actor, req, type);
      if (ev.kind !== 'ok') return ev;
      return {
        kind: 'ok',
        preview: {
          requestId: id, status: req.status, version: req.current_version,
          quantity: ev.quantity, unit: ev.unit,
          detail: ev.count.detail, errors: ev.count.errors,
          checks: ev.checks, blocking: hasBlocking(ev.checks),
          available: ev.available, afterAvailable: ev.afterAvailable,
          projectedAtStart: ev.projectedAtStart,
          projectionNote: 'PROJECTION : acquisitions futures conditionnelles — le solde projeté n\'est pas un droit acquis',
          retroactive: ev.retroactive, circuit: ev.circuitKey,
          policyCode: ev.policy?.policyCode ?? null, policyVersion: ev.policy?.policyVersion ?? null,
        },
      };
    });
  }

  // ==================================================================
  // Soumission : gel versionné + réservation VERROUILLÉE + circuit E3
  // ==================================================================

  async submit(tenantId: string, actor: string, id: string): Promise<TimeOutcome<{
    instanceId: string; version: number; quantity: number; checks: CheckItem[];
  }>> {
    // UNE transaction sous VERROU : contrôles, gel versionné, réservation et statut
    // vivent ensemble. L'instance E3 n'est créée qu'une fois TOUT validé sous le
    // verrou — une soumission refusée ne laisse JAMAIS d'instance orpheline dont la
    // fermeture cascaderait sur la demande (leçon CI run 30892743033 : l'annulation
    // de l'orphelin annulait la soumission GAGNANTE, même sujet).
    return this.prisma.withTenant<TimeOutcome<{
      instanceId: string; version: number; quantity: number; checks: CheckItem[];
    }>>(tenantId, async (tx) => {
      const req = await this.lockRequest(tx, id);
      if (!req) return { kind: 'not_found' };
      const who = await this.ownership(tx, actor, req);
      if (!who.ownerOrAdmin) return { kind: 'forbidden', reason: 'soumission : salarié, auteur ou administration' };
      if (req.status !== 'draft' && req.status !== 'returned') {
        return { kind: 'conflict', reason: `demande au statut « ${req.status} » — seule une demande en brouillon ou retournée se soumet` };
      }
      const type = await this.typeRow(tx, req.absence_type_id);
      if (!type) return { kind: 'not_found' };
      // Sérialisation anti SURCONSOMMATION par (salarié, type) : deux soumissions
      // concurrentes se suivent — la seconde constate le disponible déjà réservé.
      // ($executeRaw : pg_advisory_xact_lock renvoie void — leçon CI 30850506848.)
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}::text || ':leave_reserve:' || ${req.employee_id}::text || ':' || ${req.absence_type_id}::text))`;
      const ev = await this.evaluate(tx, tenantId, actor, req, type);
      if (ev.kind !== 'ok') return ev;
      if (hasBlocking(ev.checks)) {
        const msg = ev.checks.filter((c) => c.level === 'error').map((c) => `${c.code} : ${c.fr}`).join(' ; ');
        return { kind: 'invalid', reason: `soumission refusée — ${msg}` };
      }
      const version = req.current_version + 1;
      const p = ev.payload;
      const mgr = await this.managerUserOf(tx, req.employee_id, p.startDate);
      const org = await tx.$queryRaw<Array<{ company_id: string | null; site_id: string | null; unit_id: string | null }>>`
        SELECT company_id, site_id, unit_id FROM core.employee_assignments
         WHERE employee_id = ${req.employee_id}::uuid AND is_primary
           AND daterange(effective_from, effective_to, '[)') @> ${p.startDate}::date LIMIT 1`;
      const beneficiary = await tx.$queryRaw<Array<{ user_id: string | null }>>`
        SELECT user_id FROM core.employees WHERE id = ${req.employee_id}::uuid`;
      const excluded = [beneficiary[0]?.user_id, req.created_by].filter((u): u is string => !!u && u !== undefined);
      const context = {
        requestId: req.id,
        requestVersion: version,
        employeeId: req.employee_id,
        typeCode: type.confidential ? 'CONFIDENTIEL' : type.code,
        confidential: type.confidential,
        quantity: ev.quantity, unit: ev.unit,
        retroactive: ev.retroactive,
        negative: ev.checks.some((c) => c.code === 'negative_used'),
        periodClosed: ev.checks.some((c) => c.code === 'closed_period'),
        managerUserId: mgr ?? undefined,
        hasManager: mgr !== null,
        scopeRef: org[0]?.unit_id ?? undefined,
        siteId: org[0]?.site_id ?? undefined,
        companyId: org[0]?.company_id ?? undefined,
        // Séparation des tâches : demandeur ET bénéficiaire exclus de la décision.
        excludedDeciderUserIds: [...new Set(excluded)],
      };
      // Instance E3 (sa propre transaction, connexion distincte) — créée en DERNIER :
      // tout refus ci-dessus n'a rien produit, ni ici ni côté workflow.
      const submitted = await this.wf.submit(tenantId, actor, {
        definitionKey: ev.circuitKey, subjectType: 'leave_request', subjectId: id, context,
      });
      if (submitted.kind === 'no_active_definition') {
        return { kind: 'conflict', reason: `aucun circuit « ${ev.circuitKey} » actif — configurez le workflow avant de soumettre` };
      }
      if (submitted.kind !== 'ok') return { kind: 'invalid', reason: 'workflow vide' };
      await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO leave.request_versions (tenant_id, request_id, version, start_date, end_date,
          half_day_start, half_day_end, hours_requested, quantity, unit, count_detail, checks,
          policy_id, policy_version, params_used, retroactive, retro_reason, negative_used,
          comment, workflow_instance_id, created_by)
        VALUES (${tenantId}::uuid, ${id}::uuid, ${version}, ${p.startDate}::date, ${p.endDate}::date,
          ${p.halfDayStart}, ${p.halfDayEnd}, ${type.unit === 'hours' ? p.hours : null},
          ${ev.quantity}, ${ev.unit}, ${JSON.stringify(ev.count.detail)}::jsonb,
          ${JSON.stringify(ev.checks)}::jsonb,
          ${ev.policy?.policyId ?? null}::uuid, ${ev.policy?.policyVersion ?? null},
          ${JSON.stringify(ev.paramsUsed)}::jsonb, ${ev.retroactive},
          ${ev.retroactive ? (p.comment ?? '') : null}, ${ev.checks.some((c) => c.code === 'negative_used')},
          ${p.comment}, ${submitted.instanceId}::uuid, ${actor}::uuid)
        RETURNING id`;
      // Réservation : mouvement append-only idempotent (jamais une retouche de solde).
      if (ev.quantity > 0) {
        const refYear = p.startDate.slice(0, 4);
        await tx.$executeRaw`
          INSERT INTO leave.entitlement_ledger (tenant_id, employee_id, absence_type_id, policy_id, policy_version,
            reference_period_start, reference_period_end, entry_kind, quantity, unit, effective_on, origin,
            business_ref, reason, params_used, idempotency_key, created_by, request_id, request_version)
          VALUES (${tenantId}::uuid, ${req.employee_id}::uuid, ${req.absence_type_id}::uuid,
            ${ev.policy?.policyId ?? null}::uuid, ${ev.policy?.policyVersion ?? null},
            ${refYear + '-01-01'}::date, ${refYear + '-12-31'}::date, 'reservation',
            ${ev.quantity}, ${ev.unit}, ${p.startDate}::date, 'workflow',
            ${'demande ' + id + ' v' + version}, ${type.confidential ? MASKED : 'réservation à la soumission'},
            ${JSON.stringify(ev.paramsUsed)}::jsonb, ${reservationKey(id, version)}, ${actor}::uuid,
            ${id}::uuid, ${version})
          ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`;
      }
      // Version précédente supplantée : sa réservation est LIBÉRÉE (mouvement distinct).
      if (version > 1) {
        await this.releaseReservation(tx, tenantId, req, version - 1, 'superseded', actor);
        await this.event(tx, tenantId, id, version, 'resubmitted', actor, { previous: version - 1 });
      }
      await tx.$executeRaw`
        UPDATE leave.requests
           SET status = 'submitted', current_version = ${version},
               workflow_instance_id = ${submitted.instanceId}::uuid
         WHERE id = ${id}::uuid`;
      await this.event(tx, tenantId, id, version, 'submitted', actor, {
        instanceId: submitted.instanceId, circuit: ev.circuitKey, quantity: ev.quantity,
      });
      if (ev.quantity > 0) {
        await this.event(tx, tenantId, id, version, 'reservation_posted', actor, { quantity: ev.quantity });
      }
      const recipients = await this.stakeholders(tx, req);
      await this.notifyUsers(tx, tenantId, actor, recipients, `conges-demande-soumise-${id}-v${version}`,
        'conges_demande_soumise', {
          demande: id, version: String(version),
          type: type.confidential ? 'absence' : type.code,
          debut: p.startDate, fin: p.endDate, quantite: String(ev.quantity),
        });
      await auditAuth(tx, tenantId, {
        action: 'leave_request_submitted', actorUserId: actor, module: 'leave',
        recordType: 'leave_request', recordId: id,
        newValue: {
          version, instanceId: submitted.instanceId, circuit: ev.circuitKey,
          quantity: ev.quantity, retroactive: ev.retroactive,
          type: type.confidential ? MASKED : type.code,
        },
        result: 'success',
      });
      return { kind: 'ok', instanceId: submitted.instanceId, version, quantity: ev.quantity, checks: ev.checks };
    }, { timeoutMs: 30000 });
  }

  /** Délégation de l'étape courante (E3 décide : seul un acteur ASSIGNÉ délègue). */
  async delegateStep(tenantId: string, actor: string, requestId: string, toUserId: string): Promise<TimeOutcome<{ delegated: boolean }>> {
    const inst = await this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ workflow_instance_id: string | null; status: string }>>`
        SELECT workflow_instance_id, status FROM leave.requests WHERE id = ${requestId}::uuid`;
      if (rows.length === 0) return { kind: 'not_found' as const };
      if (!['submitted', 'in_review'].includes(rows[0]!.status) || !rows[0]!.workflow_instance_id) {
        return { kind: 'conflict' as const, reason: `demande au statut « ${rows[0]!.status} » — rien à déléguer` };
      }
      return { kind: 'ok' as const, instanceId: rows[0]!.workflow_instance_id };
    });
    if (inst.kind !== 'ok') return inst;
    const identity = await this.actorIdentity(tenantId, actor);
    const out = await this.wf.delegate(tenantId, identity, inst.instanceId, toUserId, {});
    if (out.kind === 'forbidden') return { kind: 'forbidden', reason: out.reason };
    if (out.kind === 'stale') return { kind: 'conflict', reason: 'instance déjà décidée' };
    if (out.kind !== 'ok') return { kind: 'invalid', reason: out.kind === 'invalid' ? out.reason : 'délégation impossible' };
    await this.prisma.withTenant(tenantId, (tx) => auditAuth(tx, tenantId, {
      action: 'leave_request_delegated', actorUserId: actor, module: 'leave',
      recordType: 'leave_request', recordId: requestId, newValue: { toUserId }, result: 'success',
    }));
    return { kind: 'ok', delegated: true };
  }

  // ==================================================================
  // Décision (enveloppe E3) — application HORS transaction de décision
  // ==================================================================

  async decide(
    tenantId: string, actor: string, requestId: string,
    input: { action: 'approve' | 'reject' | 'return'; comment?: string; idempotencyKey?: string },
  ): Promise<TimeOutcome<{ status: string; applied?: boolean; applicationError?: string | null }>> {
    const inst = await this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ workflow_instance_id: string | null; status: string }>>`
        SELECT workflow_instance_id, status FROM leave.requests WHERE id = ${requestId}::uuid`;
      if (rows.length === 0) return { kind: 'not_found' as const };
      if (!['submitted', 'in_review'].includes(rows[0]!.status) || !rows[0]!.workflow_instance_id) {
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

    if (out.status === 'pending') {
      // Étape intermédiaire franchie : la demande passe en INSTRUCTION.
      await this.prisma.withTenant(tenantId, async (tx) => {
        const moved = await tx.$executeRaw`
          UPDATE leave.requests SET status = 'in_review' WHERE id = ${requestId}::uuid AND status = 'submitted'`;
        if (moved > 0) {
          await this.event(tx, tenantId, requestId, null, 'review_started', actor, {});
          await auditAuth(tx, tenantId, {
            action: 'leave_request_review_started', actorUserId: actor, module: 'leave',
            recordType: 'leave_request', recordId: requestId, result: 'success',
          });
        }
      });
      return { kind: 'ok', status: 'in_review' };
    }
    if (out.status === 'returned') {
      // E3 ne synchronise pas les retours : la demande redevient éditable ICI.
      await this.prisma.withTenant(tenantId, async (tx) => {
        const moved = await tx.$executeRaw`
          UPDATE leave.requests SET status = 'returned'
           WHERE id = ${requestId}::uuid AND status IN ('submitted', 'in_review')`;
        if (moved > 0) {
          await this.event(tx, tenantId, requestId, null, 'returned', actor, { comment: input.comment ?? null });
          const req = await this.getRequest(tx, requestId);
          if (req) {
            await this.notifyUsers(tx, tenantId, actor, await this.stakeholders(tx, req),
              `conges-demande-retour-${requestId}-v${req.current_version}`, 'conges_demande_retour',
              { demande: requestId, commentaire: input.comment ?? '' });
          }
          await auditAuth(tx, tenantId, {
            action: 'leave_request_returned', actorUserId: actor, module: 'leave',
            recordType: 'leave_request', recordId: requestId, result: 'success',
          });
        }
      });
      return { kind: 'ok', status: 'returned' };
    }
    if (out.status === 'approved') {
      // Le handler a posé 'approved_pending_application' DANS la décision ;
      // l'application court MAINTENANT, hors décision — échec relançable.
      const applied = await this.applyApproved(tenantId, actor, requestId);
      if (applied.kind === 'ok') return { kind: 'ok', status: 'approved', applied: true };
      return {
        kind: 'ok', status: 'approved', applied: false,
        applicationError: 'reason' in applied ? String(applied.reason) : 'application en échec — relançable',
      };
    }
    return { kind: 'ok', status: out.status ?? 'rejected' };
  }

  /** Pont E3 (même transaction que la décision) : le statut de la DEMANDE suit. */
  private async onDecision(tx: Tx, tenantId: string, requestId: string, status: string): Promise<void> {
    if (status === 'approved') {
      await tx.$executeRaw`
        UPDATE leave.requests SET status = 'approved_pending_application'
         WHERE id = ${requestId}::uuid AND status IN ('submitted', 'in_review')`;
      await this.event(tx, tenantId, requestId, null, 'approved', null, {});
      await auditAuth(tx, tenantId, {
        action: 'leave_request_approved', module: 'leave',
        recordType: 'leave_request', recordId: requestId, result: 'success',
      });
      return;
    }
    if (status === 'rejected' || status === 'cancelled') {
      const req = await this.getRequest(tx, requestId);
      if (!req || !['submitted', 'in_review'].includes(req.status)) return;
      await tx.$executeRaw`
        UPDATE leave.requests SET status = ${status} WHERE id = ${requestId}::uuid`;
      await this.releaseReservation(tx, tenantId, req, req.current_version, status, null);
      await this.event(tx, tenantId, requestId, req.current_version,
        status === 'rejected' ? 'rejected' : 'withdrawn', null, {});
      await this.notifyUsers(tx, tenantId, req.created_by, await this.stakeholders(tx, req),
        `conges-demande-${status}-${requestId}-v${req.current_version}`,
        status === 'rejected' ? 'conges_demande_rejetee' : 'conges_demande_annulee',
        { demande: requestId });
      await auditAuth(tx, tenantId, {
        action: status === 'rejected' ? 'leave_request_rejected' : 'leave_request_cancelled',
        module: 'leave', recordType: 'leave_request', recordId: requestId, result: 'success',
      });
    }
  }

  // ==================================================================
  // Application IDEMPOTENTE d'une demande approuvée (§13)
  // ==================================================================

  async applyApproved(tenantId: string, actor: string, requestId: string): Promise<TimeOutcome<{ absenceId: string }>> {
    const step = await this.prisma.withTenant(tenantId, async (tx) => {
      const req = await this.lockRequest(tx, requestId);
      if (!req) return { kind: 'not_found' as const };
      if (req.status === 'applied') {
        const abs = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM leave.absences WHERE request_id = ${requestId}::uuid AND request_version = ${req.current_version}`;
        return { kind: 'already' as const, absenceId: abs[0]?.id ?? requestId };
      }
      if (!['approved_pending_application', 'approved', 'application_failed'].includes(req.status)) {
        return { kind: 'conflict' as const, reason: `demande au statut « ${req.status} » — seule une demande approuvée s'applique` };
      }
      const ver = await tx.$queryRaw<Array<{
        version: number; start_date: string; end_date: string; half_day_start: boolean; half_day_end: boolean;
        hours_requested: string | null; quantity: string; unit: string; policy_id: string | null;
        policy_version: number | null; params_used: Record<string, unknown>; count_detail: unknown;
      }>>`
        SELECT version, start_date::text, end_date::text, half_day_start, half_day_end,
               hours_requested::text, quantity::text, unit, policy_id, policy_version, params_used, count_detail
          FROM leave.request_versions
         WHERE request_id = ${requestId}::uuid AND version = ${req.current_version}`;
      const v = ver[0];
      if (!v) return { kind: 'invalid' as const, reason: 'version soumise introuvable' };
      // Re-vérification LÉGÈRE avant écriture : chevauchement d'absence approuvée
      // (pré-contrôle du même invariant que l'EXCLUSION — qui reste le filet).
      const clash = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM leave.absences
         WHERE employee_id = ${req.employee_id}::uuid AND status = 'approved'
           AND daterange(start_date, end_date, '[]') && daterange(${v.start_date}::date, ${v.end_date}::date, '[]')
         LIMIT 1`;
      if (clash.length > 0) {
        return { kind: 'apply_failed' as const, message: `chevauche l'absence approuvée ${clash[0]!.id} — annulation ou correction requise` };
      }
      const type = await this.typeRow(tx, req.absence_type_id);
      try {
        const abs = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO leave.absences (tenant_id, employee_id, absence_type_id, request_id, request_version,
            start_date, end_date, half_day_start, half_day_end, hours_requested, quantity, unit,
            policy_id, policy_version, params_used, count_detail, applied_by)
          VALUES (${tenantId}::uuid, ${req.employee_id}::uuid, ${req.absence_type_id}::uuid,
            ${requestId}::uuid, ${v.version}, ${v.start_date}::date, ${v.end_date}::date,
            ${v.half_day_start}, ${v.half_day_end}, ${v.hours_requested === null ? null : Number(v.hours_requested)},
            ${Number(v.quantity)}, ${v.unit}, ${v.policy_id}::uuid, ${v.policy_version},
            ${JSON.stringify(v.params_used)}::jsonb, ${JSON.stringify(v.count_detail)}::jsonb, ${actor}::uuid)
          ON CONFLICT (tenant_id, request_id, request_version) DO UPDATE SET applied_at = leave.absences.applied_at
          RETURNING id`;
        const absenceId = abs[0]!.id;
        const qty = Number(v.quantity);
        if (qty > 0) {
          const refYear = v.start_date.slice(0, 4);
          // Consommation : UNE seule par version (clé) ; réservation NEUTRALISÉE par
          // une libération distincte — jamais un double débit, jamais une retouche.
          await tx.$executeRaw`
            INSERT INTO leave.entitlement_ledger (tenant_id, employee_id, absence_type_id, policy_id, policy_version,
              reference_period_start, reference_period_end, entry_kind, quantity, unit, effective_on, origin,
              business_ref, reason, params_used, idempotency_key, created_by, request_id, request_version)
            VALUES (${tenantId}::uuid, ${req.employee_id}::uuid, ${req.absence_type_id}::uuid,
              ${v.policy_id}::uuid, ${v.policy_version},
              ${refYear + '-01-01'}::date, ${refYear + '-12-31'}::date, 'consumption',
              ${qty}, ${v.unit}, ${v.start_date}::date, 'workflow',
              ${'demande ' + requestId + ' v' + v.version},
              ${type?.confidential ? MASKED : 'consommation après approbation'},
              ${JSON.stringify(v.params_used)}::jsonb, ${consumptionKey(requestId, v.version)}, ${actor}::uuid,
              ${requestId}::uuid, ${v.version})
            ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`;
          await this.releaseReservation(tx, tenantId, req, v.version, 'applied', actor);
        }
        await tx.$executeRaw`
          UPDATE leave.requests SET status = 'applied'
           WHERE id = ${requestId}::uuid AND status IN ('approved_pending_application', 'approved', 'application_failed')`;
        await this.event(tx, tenantId, requestId, v.version, 'applied', actor, { absenceId, quantity: qty });
        const recipients = await this.stakeholders(tx, req);
        await this.notifyUsers(tx, tenantId, actor, recipients, `conges-demande-appliquee-${requestId}-v${v.version}`,
          'conges_demande_appliquee', { demande: requestId, quantite: String(qty) });
        await auditAuth(tx, tenantId, {
          action: 'leave_request_applied', actorUserId: actor, module: 'leave',
          recordType: 'leave_request', recordId: requestId,
          newValue: { absenceId, version: v.version, quantity: qty }, result: 'success',
        });
        return { kind: 'ok' as const, absenceId };
      } catch (e) {
        const code = pgCode(e);
        if (code === '23P01' || code === '25P02') {
          // Exclusion (chevauchement) : transaction AVORTÉE — plus AUCUNE requête
          // ici ; le constat s'écrit dans une transaction NEUVE (leçon E10.3).
          return { kind: 'apply_failed' as const, message: 'chevauchement d\'absences approuvées constaté par la base (exclusion)' };
        }
        throw e;
      }
    });
    if (step.kind === 'already') return { kind: 'ok', absenceId: step.absenceId };
    if (step.kind === 'apply_failed') {
      await this.prisma.withTenant(tenantId, async (tx) => {
        await tx.$executeRaw`
          UPDATE leave.requests SET status = 'application_failed'
           WHERE id = ${requestId}::uuid AND status IN ('approved_pending_application', 'approved', 'application_failed')`;
        await this.event(tx, tenantId, requestId, null, 'application_failed', actor, { error: step.message });
        const req = await this.getRequest(tx, requestId);
        if (req) {
          await this.notifyUsers(tx, tenantId, actor, await this.stakeholders(tx, req),
            `conges-demande-echec-${requestId}-v${req.current_version}`, 'conges_demande_echec_application',
            { demande: requestId, erreur: step.message });
        }
        await auditAuth(tx, tenantId, {
          action: 'leave_request_application_failed', actorUserId: actor, module: 'leave',
          recordType: 'leave_request', recordId: requestId, newValue: { error: step.message }, result: 'failure',
        });
      });
      return { kind: 'conflict', reason: `application en échec : ${step.message} — demande en « application_failed », relançable` };
    }
    return step;
  }

  /** Reprise EXPLICITE d'une application échouée (idempotente de bout en bout). */
  async retryApplication(tenantId: string, actor: string, requestId: string): Promise<TimeOutcome<{ absenceId: string }>> {
    const allowed = await this.prisma.withTenant(tenantId, async (tx) => {
      const req = await this.getRequest(tx, requestId);
      if (!req) return { kind: 'not_found' as const };
      const who = await this.ownership(tx, actor, req);
      if (!who.admin && !who.ownerOrAdmin) return { kind: 'forbidden' as const, reason: 'reprise : administration ou demandeur' };
      await this.event(tx, tenantId, requestId, null, 'application_retried', actor, {});
      return { kind: 'ok' as const };
    });
    if (allowed.kind !== 'ok') return allowed;
    return this.applyApproved(tenantId, actor, requestId);
  }

  // ==================================================================
  // Retrait / annulation / expiration
  // ==================================================================

  /** Retrait AVANT décision (brouillon/retourné : direct ; soumis : via E3). */
  async withdraw(tenantId: string, actor: string, id: string): Promise<TimeOutcome<Record<never, never>>> {
    const state = await this.prisma.withTenant(tenantId, async (tx) => {
      const req = await this.lockRequest(tx, id);
      if (!req) return { kind: 'not_found' as const };
      const who = await this.ownership(tx, actor, req);
      if (!who.ownerOrAdmin) return { kind: 'forbidden' as const, reason: 'retrait réservé au salarié, à l\'auteur ou à l\'administration' };
      if (req.status === 'draft' || req.status === 'returned') {
        await tx.$executeRaw`UPDATE leave.requests SET status = 'cancelled' WHERE id = ${id}::uuid`;
        if (req.current_version > 0) {
          await this.releaseReservation(tx, tenantId, req, req.current_version, 'withdrawn', actor);
        }
        await this.event(tx, tenantId, id, req.current_version || null, 'withdrawn', actor, {});
        await auditAuth(tx, tenantId, {
          action: 'leave_request_withdrawn', actorUserId: actor, module: 'leave',
          recordType: 'leave_request', recordId: id, result: 'success',
        });
        return { kind: 'ok' as const, viaWorkflow: null };
      }
      if (['submitted', 'in_review'].includes(req.status) && req.workflow_instance_id) {
        return { kind: 'ok' as const, viaWorkflow: req.workflow_instance_id };
      }
      return { kind: 'conflict' as const, reason: `demande au statut « ${req.status} » — le retrait n'est plus permis (annulation par circuit dédié)` };
    });
    if (state.kind !== 'ok') return state;
    if (state.viaWorkflow) {
      const identity = await this.actorIdentity(tenantId, actor);
      const out = await this.wf.cancel(tenantId, identity, state.viaWorkflow, { comment: 'retrait par le demandeur' });
      if (out.kind === 'forbidden') return { kind: 'forbidden', reason: out.reason };
      if (out.kind === 'stale') return { kind: 'conflict', reason: 'la demande a déjà été décidée' };
      if (out.kind !== 'ok') return { kind: 'conflict', reason: 'retrait impossible' };
    }
    return { kind: 'ok' };
  }

  /** Annulation APRÈS application : circuit E3 DISTINCT — jamais silencieuse. */
  async requestCancellation(tenantId: string, actor: string, id: string, reason: string): Promise<TimeOutcome<{ instanceId: string }>> {
    if (!reason || reason.trim().length < 3) return { kind: 'invalid', reason: 'motif d\'annulation obligatoire' };
    const prep = await this.prisma.withTenant(tenantId, async (tx) => {
      const req = await this.lockRequest(tx, id);
      if (!req) return { kind: 'not_found' as const };
      const who = await this.ownership(tx, actor, req);
      const permitted = who.ownerOrAdmin || (await holdsPermission(tx, actor, 'leave.request_cancel_approved'));
      if (!permitted) return { kind: 'forbidden' as const, reason: 'annulation d\'une demande appliquée : salarié, auteur ou permission dédiée' };
      if (req.status !== 'applied') {
        return { kind: 'conflict' as const, reason: `demande au statut « ${req.status} » — le circuit d'annulation vise une demande appliquée` };
      }
      if (req.cancel_workflow_instance_id) {
        return { kind: 'conflict' as const, reason: 'un circuit d\'annulation est déjà ouvert pour cette demande' };
      }
      const mgr = await this.managerUserOf(tx, req.employee_id, new Date().toISOString().slice(0, 10));
      const beneficiary = await tx.$queryRaw<Array<{ user_id: string | null }>>`
        SELECT user_id FROM core.employees WHERE id = ${req.employee_id}::uuid`;
      return {
        kind: 'ok' as const, req,
        context: {
          requestId: id, requestVersion: req.current_version, employeeId: req.employee_id,
          cancelReason: reason, managerUserId: mgr ?? undefined, hasManager: mgr !== null,
          excludedDeciderUserIds: [...new Set([beneficiary[0]?.user_id, actor].filter((u): u is string => !!u))],
        },
      };
    });
    if (prep.kind !== 'ok') return prep;
    const submitted = await this.wf.submit(tenantId, actor, {
      definitionKey: 'conges_annulation', subjectType: 'leave_request_cancel', subjectId: id, context: prep.context,
    });
    if (submitted.kind === 'no_active_definition') {
      return { kind: 'conflict', reason: 'aucun circuit « conges_annulation » actif — configurez le workflow' };
    }
    if (submitted.kind !== 'ok') return { kind: 'invalid', reason: 'workflow vide' };
    return this.prisma.withTenant(tenantId, async (tx) => {
      await tx.$executeRaw`
        UPDATE leave.requests SET cancel_workflow_instance_id = ${submitted.instanceId}::uuid WHERE id = ${id}::uuid`;
      await this.event(tx, tenantId, id, prep.req.current_version, 'cancel_requested', actor, {
        instanceId: submitted.instanceId, reason,
      });
      await auditAuth(tx, tenantId, {
        action: 'leave_request_cancel_requested', actorUserId: actor, module: 'leave',
        recordType: 'leave_request', recordId: id, reason, result: 'success',
      });
      return { kind: 'ok', instanceId: submitted.instanceId };
    });
  }

  /** Pont E3 du circuit d'annulation : reversement + absence annulée, MÊME transaction. */
  private async onCancelDecision(tx: Tx, tenantId: string, requestId: string, status: string): Promise<void> {
    if (status !== 'approved' && status !== 'rejected' && status !== 'cancelled') return;
    const req = await this.getRequest(tx, requestId);
    if (!req) return;
    if (status !== 'approved') {
      await tx.$executeRaw`
        UPDATE leave.requests SET cancel_workflow_instance_id = NULL WHERE id = ${requestId}::uuid`;
      await this.event(tx, tenantId, requestId, req.current_version, 'cancel_rejected', null, { outcome: status });
      return;
    }
    const v = req.current_version;
    const inst = await tx.$queryRaw<Array<{ context: Record<string, unknown> }>>`
      SELECT context FROM workflow.instances WHERE id = ${req.cancel_workflow_instance_id}::uuid`;
    const reason = String(inst[0]?.context?.['cancelReason'] ?? 'annulation approuvée');
    await tx.$executeRaw`
      UPDATE leave.absences
         SET status = 'cancelled', cancelled_at = now(), cancelled_by = NULL,
             cancel_reason = ${reason}
       WHERE request_id = ${requestId}::uuid AND request_version = ${v} AND status = 'approved'`;
    // Reversement de la CONSOMMATION : mouvement référencé, jamais une suppression.
    const cons = await tx.$queryRaw<Array<{ id: string; quantity: string; unit: string; policy_id: string | null; policy_version: number | null; reference_period_start: string; reference_period_end: string; effective_on: string }>>`
      SELECT id, quantity::text, unit, policy_id, policy_version,
             reference_period_start::text, reference_period_end::text, effective_on::text
        FROM leave.entitlement_ledger
       WHERE tenant_id = ${tenantId}::uuid AND idempotency_key = ${consumptionKey(requestId, v)}`;
    if (cons[0]) {
      await tx.$executeRaw`
        INSERT INTO leave.entitlement_ledger (tenant_id, employee_id, absence_type_id, policy_id, policy_version,
          reference_period_start, reference_period_end, entry_kind, quantity, unit, effective_on, origin,
          business_ref, reason, idempotency_key, reversal_of, request_id, request_version)
        VALUES (${tenantId}::uuid, ${req.employee_id}::uuid, ${req.absence_type_id}::uuid,
          ${cons[0].policy_id}::uuid, ${cons[0].policy_version},
          ${cons[0].reference_period_start}::date, ${cons[0].reference_period_end}::date, 'reversal',
          ${Number(cons[0].quantity)}, ${cons[0].unit}, ${cons[0].effective_on}::date, 'reversal',
          ${'annulation demande ' + requestId + ' v' + v}, ${reason.slice(0, 490)},
          ${cancellationReversalKey(requestId, v)}, ${cons[0].id}::uuid, ${requestId}::uuid, ${v})
        ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`;
    }
    await tx.$executeRaw`
      UPDATE leave.requests SET status = 'cancelled', cancel_workflow_instance_id = NULL
       WHERE id = ${requestId}::uuid AND status = 'applied'`;
    await this.event(tx, tenantId, requestId, v, 'cancel_approved', null, { reason });
    await this.notifyUsers(tx, tenantId, req.created_by, await this.stakeholders(tx, req),
      `conges-annulation-approuvee-${requestId}-v${v}`, 'conges_annulation_decidee',
      { demande: requestId, decision: 'approuvée' });
    await auditAuth(tx, tenantId, {
      action: 'leave_request_cancel_approved', module: 'leave',
      recordType: 'leave_request', recordId: requestId, reason, result: 'success',
    });
  }

  /** Expiration ADMINISTRATIVE : uniquement une demande RETOURNÉE non resoumise. */
  async expire(tenantId: string, actor: string, id: string, reason: string): Promise<TimeOutcome<{ expired: boolean }>> {
    if (!reason || reason.trim().length < 3) return { kind: 'invalid', reason: 'motif d\'expiration obligatoire' };
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'leave.requests_admin'))) {
        return { kind: 'forbidden', reason: 'permission requise : leave.requests_admin' };
      }
      const req = await this.lockRequest(tx, id);
      if (!req) return { kind: 'not_found' };
      if (req.status !== 'returned') {
        return { kind: 'conflict', reason: `demande au statut « ${req.status} » — l'expiration ne vise qu'une demande retournée non resoumise (une demande en circuit se DÉCIDE)` };
      }
      await tx.$executeRaw`UPDATE leave.requests SET status = 'expired' WHERE id = ${id}::uuid`;
      if (req.current_version > 0) {
        await this.releaseReservation(tx, tenantId, req, req.current_version, 'expired', actor);
      }
      await this.event(tx, tenantId, id, req.current_version || null, 'expired', actor, { reason });
      await this.notifyUsers(tx, tenantId, actor, await this.stakeholders(tx, req),
        `conges-demande-expiree-${id}`, 'conges_demande_expiree', { demande: id, motif: reason });
      await auditAuth(tx, tenantId, {
        action: 'leave_request_expired', actorUserId: actor, module: 'leave',
        recordType: 'leave_request', recordId: id, reason, result: 'success',
      });
      return { kind: 'ok', expired: true };
    });
  }

  // ==================================================================
  // Consultations : mes demandes, équipe, file RH, détail
  // ==================================================================

  async mine(tenantId: string, actor: string): Promise<TimeOutcome<{ items: unknown[] }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'leave.requests_view_own', 'leave.request_self'))) {
        return { kind: 'forbidden', reason: 'permission requise : leave.requests_view_own' };
      }
      const me = await linkedEmployee(tx, actor);
      const rows = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT r.id, r.status, r.current_version AS version, r.on_behalf AS "onBehalf", r.source,
               r.draft_payload AS draft, t.code AS "typeCode", t.label_fr AS "labelFr", t.label_en AS "labelEn",
               t.confidential,
               v.start_date::text AS "startDate", v.end_date::text AS "endDate",
               v.quantity::text AS quantity, v.unit, v.retroactive,
               r.created_at AS "createdAt", r.employee_confirmed_at AS "confirmedAt"
          FROM leave.requests r
          JOIN leave.absence_types t ON t.id = r.absence_type_id
          LEFT JOIN leave.request_versions v
            ON v.request_id = r.id AND v.version = r.current_version
         WHERE r.employee_id = ${me}::uuid OR r.created_by = ${actor}::uuid
         ORDER BY r.created_at DESC LIMIT 200`;
      return { kind: 'ok', items: rows };
    });
  }

  async listTeam(tenantId: string, actor: string, opts: {
    scope: 'team' | 'admin'; status?: string; sensitiveOnly?: boolean; retroOnly?: boolean; failedOnly?: boolean;
  }): Promise<TimeOutcome<{ items: unknown[]; delayDays: number | null }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const today = new Date().toISOString().slice(0, 10);
      let ids: string[] = [];
      let all = false;
      let admin = false;
      if (opts.scope === 'admin') {
        const set = await scopeSetFor(tx, actor, 'leave.requests_admin');
        if (set.kind === 'none') return { kind: 'forbidden', reason: 'permission requise : leave.requests_admin' };
        admin = true;
        if (set.kind === 'all') all = true;
        else ids = await this.scopedEmployeeIds(tx, set, today);
      } else {
        if (!(await holdsPermission(tx, actor, 'leave.requests_view_team'))) {
          return { kind: 'forbidden', reason: 'permission requise : leave.requests_view_team' };
        }
        ids = await teamEmployeeIds(tx, actor, today);
        if (ids.length === 0) return { kind: 'ok', items: [], delayDays: null };
      }
      const sensitive = await holdsPermission(tx, actor, 'leave.sensitive_view');
      const rows = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT r.id, r.status, r.current_version AS version, r.on_behalf AS "onBehalf", r.source,
               t.code AS "typeCode", t.label_fr AS "labelFr", t.label_en AS "labelEn", t.confidential,
               e.matricule, e.first_name AS "firstName", e.last_name AS "lastName",
               v.start_date::text AS "startDate", v.end_date::text AS "endDate",
               v.quantity::text AS quantity, v.unit, v.retroactive, v.comment,
               v.created_at AS "submittedAt",
               (SELECT count(*)::int FROM leave.request_attachments a
                 WHERE a.request_id = r.id AND a.deleted_at IS NULL) AS "attachmentCount",
               (SELECT min(a.verified_status) FROM leave.request_attachments a
                 WHERE a.request_id = r.id AND a.deleted_at IS NULL) AS "attachmentStatus"
          FROM leave.requests r
          JOIN leave.absence_types t ON t.id = r.absence_type_id
          JOIN core.employees e ON e.id = r.employee_id
          LEFT JOIN leave.request_versions v
            ON v.request_id = r.id AND v.version = r.current_version
         WHERE r.current_version > 0
           AND (${all} OR r.employee_id = ANY(string_to_array(${ids.join(',')}, ',')::uuid[]))
         ORDER BY v.created_at DESC NULLS LAST LIMIT 500`;
      const delayProv = admin ? await paramsAt(tx, tenantId, today, ['conges.demande.delai_traitement_jours']) : {};
      const delayDays = numericParam(delayProv['conges.demande.delai_traitement_jours']);
      const items = rows
        .filter((r) => opts.status === undefined || r['status'] === opts.status)
        .filter((r) => opts.sensitiveOnly !== true || r['confidential'] === true)
        .filter((r) => opts.retroOnly !== true || r['retroactive'] === true)
        .filter((r) => opts.failedOnly !== true || r['status'] === 'application_failed')
        .map((r) => this.maskRow(r, sensitive));
      await auditAuth(tx, tenantId, {
        action: 'leave_requests_list_accessed', actorUserId: actor, module: 'leave',
        recordType: 'leave_request', reason: opts.scope, result: 'success',
      });
      return { kind: 'ok', items, delayDays };
    });
  }

  async detail(tenantId: string, actor: string, id: string): Promise<TimeOutcome<{ request: unknown }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const req = await this.getRequest(tx, id);
      if (!req) return { kind: 'not_found' };
      const who = await this.ownership(tx, actor, req);
      if (!who.ownerOrAdmin && !who.team) return { kind: 'not_found' };
      const sensitive = await holdsPermission(tx, actor, 'leave.sensitive_view');
      const seeAll = who.self || sensitive;
      const rows = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT r.id, r.status, r.current_version AS version, r.on_behalf AS "onBehalf",
               r.on_behalf_reason AS "onBehalfReason", r.source, r.draft_payload AS draft,
               r.workflow_instance_id AS "instanceId", r.cancel_workflow_instance_id AS "cancelInstanceId",
               r.employee_confirmed_at AS "confirmedAt", r.created_by AS "createdBy",
               t.code AS "typeCode", t.label_fr AS "labelFr", t.label_en AS "labelEn", t.confidential,
               e.matricule, e.first_name AS "firstName", e.last_name AS "lastName"
          FROM leave.requests r
          JOIN leave.absence_types t ON t.id = r.absence_type_id
          JOIN core.employees e ON e.id = r.employee_id
         WHERE r.id = ${id}::uuid`;
      const head = this.maskRow(rows[0]!, seeAll);
      const versions = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT version, start_date::text AS "startDate", end_date::text AS "endDate",
               half_day_start AS "halfDayStart", half_day_end AS "halfDayEnd",
               hours_requested::text AS hours, quantity::text AS quantity, unit,
               checks, count_detail AS "countDetail", retroactive, retro_reason AS "retroReason",
               comment, policy_id AS "policyId", policy_version AS "policyVersion",
               workflow_instance_id AS "instanceId", created_at AS "createdAt"
          FROM leave.request_versions WHERE request_id = ${id}::uuid ORDER BY version`;
      const events = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT version, event, actor_user_id AS "actorUserId", detail, created_at AS "createdAt"
          FROM leave.request_events WHERE request_id = ${id}::uuid ORDER BY id`;
      const attachments = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT id, filename, mime, byte_size AS "byteSize", sensitive, verified_status AS "verifiedStatus",
               created_at AS "createdAt"
          FROM leave.request_attachments WHERE request_id = ${id}::uuid AND deleted_at IS NULL`;
      const confidential = rows[0]!['confidential'] === true;
      const cleanVersions = versions.map((v) => {
        if (confidential && !seeAll) {
          return { ...v, comment: MASKED, retroReason: v['retroReason'] === null ? null : MASKED };
        }
        return v;
      });
      const cleanAttachments = attachments.map((a) =>
        (a['sensitive'] === true && !seeAll && !who.self)
          ? { ...a, filename: 'justificatif confidentiel' }
          : a);
      if (!who.self) {
        await auditAuth(tx, tenantId, {
          action: 'leave_request_accessed', actorUserId: actor, module: 'leave',
          recordType: 'leave_request', recordId: id, result: 'success',
        });
      }
      return { kind: 'ok', request: { ...head, versions: cleanVersions, events, attachments: cleanAttachments } };
    });
  }

  // ==================================================================
  // Justificatifs : ajout, consultation JOURNALISÉE, vérification
  // ==================================================================

  async addAttachment(tenantId: string, actor: string, requestId: string, input: {
    filename: string; mime: string; contentBase64: string;
  }): Promise<TimeOutcome<{ id: string; sha256: string }>> {
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
      const req = await this.getRequest(tx, requestId);
      if (!req) return { kind: 'not_found' };
      const who = await this.ownership(tx, actor, req);
      if (!who.ownerOrAdmin) return { kind: 'forbidden', reason: 'pièce : réservée au salarié, à l\'auteur ou à l\'administration' };
      if (!['draft', 'returned', 'submitted', 'in_review'].includes(req.status)) {
        return { kind: 'conflict', reason: 'demande décidée : plus de pièce ajoutable' };
      }
      const type = await this.typeRow(tx, req.absence_type_id);
      const sensitive = type?.confidential === true || type?.justification === 'required';
      const ins = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO leave.request_attachments (tenant_id, request_id, filename, mime, byte_size, sha256,
          sensitive, content, uploaded_by)
        VALUES (${tenantId}::uuid, ${requestId}::uuid, ${input.filename}, ${input.mime}, ${content.length},
          ${sha256}, ${sensitive}, ${content}, ${actor}::uuid)
        RETURNING id`;
      await this.event(tx, tenantId, requestId, req.current_version || null, 'attachment_added', actor, {
        attachmentId: ins[0]!.id, sensitive,
      });
      await auditAuth(tx, tenantId, {
        action: 'leave_attachment_added', actorUserId: actor, module: 'leave',
        recordType: 'leave_attachment', recordId: ins[0]!.id,
        newValue: { requestId, sensitive, bytes: content.length }, result: 'success',
      });
      return { kind: 'ok', id: ins[0]!.id, sha256 };
    });
  }

  async downloadAttachment(tenantId: string, actor: string, attachmentId: string): Promise<TimeOutcome<{
    filename: string; mime: string; contentBase64: string;
  }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{
        id: string; request_id: string; filename: string; mime: string; content: Buffer;
        sensitive: boolean; deleted_at: string | null;
      }>>`
        SELECT id, request_id, filename, mime, content, sensitive, deleted_at
          FROM leave.request_attachments WHERE id = ${attachmentId}::uuid`;
      const att = rows[0];
      if (!att || att.deleted_at) return { kind: 'not_found' };
      const req = await this.getRequest(tx, att.request_id);
      if (!req) return { kind: 'not_found' };
      const who = await this.ownership(tx, actor, req);
      let allowed: boolean;
      if (att.sensitive) {
        // Pièce SENSIBLE : salarié lui-même, vérificateur ou permission sensible —
        // jamais le simple périmètre d'équipe/administration.
        allowed = who.self
          || (await holdsPermission(tx, actor, 'leave.attachments_verify', 'leave.sensitive_view'));
      } else {
        allowed = who.ownerOrAdmin || who.team;
      }
      if (!allowed) return { kind: 'forbidden', reason: 'justificatif : accès restreint' };
      await tx.$executeRaw`
        INSERT INTO leave.attachment_access_log (tenant_id, attachment_id, viewed_by)
        VALUES (${tenantId}::uuid, ${attachmentId}::uuid, ${actor}::uuid)`;
      await this.event(tx, tenantId, att.request_id, null, 'attachment_viewed', actor, { attachmentId });
      await auditAuth(tx, tenantId, {
        action: 'leave_attachment_viewed', actorUserId: actor, module: 'leave',
        recordType: 'leave_attachment', recordId: attachmentId, result: 'success',
      });
      return { kind: 'ok', filename: att.filename, mime: att.mime, contentBase64: Buffer.from(att.content).toString('base64') };
    });
  }

  /** Vérification (§7-§8) : un STATUT, jamais un contenu exposé aux tiers. */
  async verifyAttachment(tenantId: string, actor: string, attachmentId: string, status: 'accepted' | 'rejected'): Promise<TimeOutcome<{ verified: string }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'leave.attachments_verify'))) {
        return { kind: 'forbidden', reason: 'permission requise : leave.attachments_verify' };
      }
      const rows = await tx.$queryRaw<Array<{ request_id: string; deleted_at: string | null }>>`
        SELECT request_id, deleted_at FROM leave.request_attachments WHERE id = ${attachmentId}::uuid`;
      if (!rows[0] || rows[0].deleted_at) return { kind: 'not_found' };
      const req = await this.getRequest(tx, rows[0].request_id);
      if (!req) return { kind: 'not_found' };
      // Séparation des tâches : ni le salarié, ni l'auteur de la demande.
      const me = await linkedEmployee(tx, actor);
      if (req.created_by === actor || (me !== null && me === req.employee_id)) {
        return { kind: 'forbidden', reason: 'séparation des tâches : on ne vérifie pas sa propre pièce' };
      }
      await tx.$executeRaw`
        UPDATE leave.request_attachments
           SET verified_status = ${status}, verified_by = ${actor}::uuid, verified_at = now()
         WHERE id = ${attachmentId}::uuid`;
      await this.event(tx, tenantId, rows[0].request_id, null, 'attachment_verified', actor, { attachmentId, status });
      await auditAuth(tx, tenantId, {
        action: 'leave_attachment_verified', actorUserId: actor, module: 'leave',
        recordType: 'leave_attachment', recordId: attachmentId, newValue: { status }, result: 'success',
      });
      return { kind: 'ok', verified: status };
    });
  }

  // ==================================================================
  // Calendrier d'équipe (§9-§10) + export
  // ==================================================================

  async calendar(tenantId: string, actor: string, opts: {
    from: string; to: string; companyId?: string; siteId?: string; unitId?: string;
  }): Promise<TimeOutcome<{ calendar: unknown }>> {
    if (!DATE_RE.test(opts.from) || !DATE_RE.test(opts.to) || opts.to < opts.from) {
      return { kind: 'invalid', reason: 'plage invalide (AAAA-MM-JJ, from ≤ to)' };
    }
    if (spanDays(opts.from, opts.to) > 62) return { kind: 'invalid', reason: 'plage bornée à 62 jours' };
    return this.prisma.withTenant(tenantId, async (tx) => {
      const set = await scopeSetFor(tx, actor, 'leave.calendar_view');
      const team = await teamEmployeeIds(tx, actor, opts.from);
      if (set.kind === 'none' && team.length === 0) {
        return { kind: 'forbidden', reason: 'permission requise : leave.calendar_view (ou une équipe résolue)' };
      }
      const typed = set.kind !== 'none';
      const sensitive = await holdsPermission(tx, actor, 'leave.sensitive_view');
      const canSeePending = await holdsPermission(tx, actor, 'leave.requests_view_team', 'leave.requests_admin');
      // Population : périmètre RH (all/scoped) ∪ équipe résolue, filtres appliqués.
      const employees = await tx.$queryRaw<Array<{
        id: string; matricule: string; first_name: string; last_name: string;
        company_id: string | null; site_id: string | null; unit_id: string | null;
      }>>`
        SELECT DISTINCT e.id, e.matricule, e.first_name, e.last_name, a.company_id, a.site_id, a.unit_id
          FROM core.employees e
          JOIN core.employee_assignments a ON a.employee_id = e.id AND a.is_primary
         WHERE e.deleted_at IS NULL AND e.status = 'active'
           AND daterange(a.effective_from, a.effective_to, '[)') && daterange(${opts.from}::date, ${opts.to}::date, '[]')
           AND (${opts.companyId ?? null}::uuid IS NULL OR a.company_id = ${opts.companyId ?? null}::uuid)
           AND (${opts.siteId ?? null}::uuid IS NULL OR a.site_id = ${opts.siteId ?? null}::uuid)
           AND (${opts.unitId ?? null}::uuid IS NULL OR a.unit_id = ${opts.unitId ?? null}::uuid)
           AND (${set.kind === 'all'}
             OR e.id = ANY(string_to_array(${team.join(',')}, ',')::uuid[])
             OR a.company_id = ANY(string_to_array(${set.kind === 'scoped' ? set.companies.join(',') : ''}, ',')::uuid[])
             OR a.site_id    = ANY(string_to_array(${set.kind === 'scoped' ? set.sites.join(',') : ''}, ',')::uuid[])
             OR a.unit_id    = ANY(string_to_array(${set.kind === 'scoped' ? set.units.join(',') : ''}, ',')::uuid[]))
         ORDER BY e.last_name, e.first_name LIMIT 300`;
      const empIds = employees.map((e) => e.id);
      if (empIds.length === 0) return { kind: 'ok', calendar: { employees: [], entries: [], holidays: [], alerts: [] } };
      const absences = await tx.$queryRaw<Array<{
        employee_id: string; start_date: string; end_date: string; code: string;
        label_fr: string; label_en: string; confidential: boolean;
      }>>`
        SELECT ab.employee_id, ab.start_date::text, ab.end_date::text, t.code, t.label_fr, t.label_en, t.confidential
          FROM leave.absences ab JOIN leave.absence_types t ON t.id = ab.absence_type_id
         WHERE ab.status = 'approved'
           AND ab.employee_id = ANY(string_to_array(${empIds.join(',')}, ',')::uuid[])
           AND daterange(ab.start_date, ab.end_date, '[]') && daterange(${opts.from}::date, ${opts.to}::date, '[]')`;
      const pending = canSeePending ? await tx.$queryRaw<Array<{
        employee_id: string; start_date: string; end_date: string; code: string;
        label_fr: string; label_en: string; confidential: boolean; status: string;
      }>>`
        SELECT r.employee_id, v.start_date::text, v.end_date::text, t.code, t.label_fr, t.label_en,
               t.confidential, r.status
          FROM leave.requests r
          JOIN leave.request_versions v ON v.request_id = r.id AND v.version = r.current_version
          JOIN leave.absence_types t ON t.id = r.absence_type_id
         WHERE r.status IN ('submitted', 'in_review', 'approved_pending_application', 'application_failed')
           AND r.employee_id = ANY(string_to_array(${empIds.join(',')}, ',')::uuid[])
           AND daterange(v.start_date, v.end_date, '[]') && daterange(${opts.from}::date, ${opts.to}::date, '[]')` : [];
      const holidays = await tx.$queryRaw<Array<{ day: string; label: string }>>`
        SELECT DISTINCT h.holiday_date::text AS day, h.label_fr AS label
          FROM time.holidays h
          JOIN time.holiday_calendars c ON c.id = h.calendar_id AND c.status = 'active'
         WHERE h.status = 'active'
           AND h.holiday_date BETWEEN ${opts.from}::date AND ${opts.to}::date
         ORDER BY 1`;
      const entryOf = (r: { employee_id: string; start_date: string; end_date: string; code: string; label_fr: string; label_en: string; confidential: boolean }, status: string) => {
        const mode = calendarLabelMode({ confidential: r.confidential, viewerHasSensitive: sensitive, viewerHasTypedView: typed });
        return {
          employeeId: r.employee_id, startDate: r.start_date, endDate: r.end_date, status,
          labelMode: mode,
          typeCode: mode === 'detail' ? r.code : null,
          labelFr: mode === 'detail' ? r.label_fr : mode === 'generic' ? 'Absence' : 'Indisponible',
          labelEn: mode === 'detail' ? r.label_en : mode === 'generic' ? 'Absence' : 'Unavailable',
        };
      };
      const entries = [
        ...absences.map((a) => entryOf(a, 'approved')),
        ...pending.map((p2) => entryOf(p2, 'pending')),
      ];
      // Capacité : effectif présent par jour vs seuil E4 (interne, versionné).
      const presProv = await paramsAt(tx, tenantId, opts.from, ['conges.equipe.presence_minimale']);
      const minPresence = numericParam(presProv['conges.equipe.presence_minimale']);
      const days: { date: string; headcount: number; approvedAbsent: number; pendingAbsent: number }[] = [];
      for (let d = opts.from; d <= opts.to; d = addDaysIso(d, 1)) {
        const approvedAbsent = new Set(absences.filter((a) => a.start_date <= d && d <= a.end_date).map((a) => a.employee_id)).size;
        const pendingAbsent = new Set(pending.filter((p2) => p2.start_date <= d && d <= p2.end_date).map((p2) => p2.employee_id)).size;
        days.push({ date: d, headcount: empIds.length, approvedAbsent, pendingAbsent });
      }
      const alerts = capacityAlerts(days, minPresence);
      await auditAuth(tx, tenantId, {
        action: 'leave_calendar_accessed', actorUserId: actor, module: 'leave',
        recordType: 'leave_calendar', reason: `${opts.from}..${opts.to}`, result: 'success',
      });
      return {
        kind: 'ok',
        calendar: {
          from: opts.from, to: opts.to,
          employees: employees.map((e) => ({
            id: e.id, matricule: e.matricule, firstName: e.first_name, lastName: e.last_name,
          })),
          entries, holidays: holidays.map((h) => ({ date: h.day, label: h.label })),
          days, alerts, minPresence,
        },
      };
    });
  }

  async exportCalendar(tenantId: string, actor: string, opts: {
    from: string; to: string; companyId?: string; siteId?: string; unitId?: string;
  }): Promise<TimeOutcome<{ csv: string }>> {
    const allowed = await this.prisma.withTenant(tenantId, (tx) => holdsPermission(tx, actor, 'leave.calendar_export'));
    if (!allowed) return { kind: 'forbidden', reason: 'permission requise : leave.calendar_export' };
    const cal = await this.calendar(tenantId, actor, opts);
    if (cal.kind !== 'ok') return cal;
    const c = cal.calendar as {
      employees: Array<{ id: string; matricule: string; firstName: string; lastName: string }>;
      entries: Array<{ employeeId: string; startDate: string; endDate: string; status: string; labelFr: string; typeCode: string | null }>;
    };
    const byId = new Map(c.employees.map((e) => [e.id, e]));
    const lines = ['matricule;nom;debut;fin;statut;libelle'];
    for (const e of c.entries) {
      const emp = byId.get(e.employeeId);
      if (!emp) continue;
      // L'export ne dit JAMAIS plus que l'écran : libellé déjà masqué par niveau.
      lines.push(`${emp.matricule};${emp.lastName} ${emp.firstName};${e.startDate};${e.endDate};${e.status};${e.labelFr}`);
    }
    await this.prisma.withTenant(tenantId, (tx) => auditAuth(tx, tenantId, {
      action: 'leave_calendar_exported', actorUserId: actor, module: 'leave',
      recordType: 'leave_calendar', reason: `${opts.from}..${opts.to}`,
      newValue: { rows: lines.length - 1 }, result: 'success',
    }));
    return { kind: 'ok', csv: lines.join('\n') };
  }

  // ==================================================================
  // Aides internes
  // ==================================================================

  private async lockRequest(tx: Tx, id: string): Promise<RequestRow | null> {
    const rows = await tx.$queryRaw<RequestRow[]>`
      SELECT id, employee_id, absence_type_id, status, current_version, draft_payload,
             on_behalf, on_behalf_reason, on_behalf_permission, source,
             employee_confirmed_at::text AS employee_confirmed_at,
             workflow_instance_id, cancel_workflow_instance_id, created_by
        FROM leave.requests WHERE id = ${id}::uuid FOR UPDATE`;
    return rows[0] ?? null;
  }

  private async getRequest(tx: Tx, id: string): Promise<RequestRow | null> {
    const rows = await tx.$queryRaw<RequestRow[]>`
      SELECT id, employee_id, absence_type_id, status, current_version, draft_payload,
             on_behalf, on_behalf_reason, on_behalf_permission, source,
             employee_confirmed_at::text AS employee_confirmed_at,
             workflow_instance_id, cancel_workflow_instance_id, created_by
        FROM leave.requests WHERE id = ${id}::uuid`;
    return rows[0] ?? null;
  }

  private async typeRow(tx: Tx, typeId: string): Promise<TypeRow | null> {
    const rows = await tx.$queryRaw<TypeRow[]>`
      SELECT id, code, label_fr, label_en, unit, justification, deposit_delay_days,
             retroactive_allowed, negative_allowed, confidential, workflow_required, status
        FROM leave.absence_types WHERE id = ${typeId}::uuid`;
    return rows[0] ?? null;
  }

  /** Qui est l'acteur vis-à-vis de la demande ? (portées réelles, jamais l'URL) */
  private async ownership(tx: Tx, actor: string, req: RequestRow): Promise<{
    self: boolean; creator: boolean; team: boolean; admin: boolean; ownerOrAdmin: boolean;
  }> {
    const me = await linkedEmployee(tx, actor);
    const self = me !== null && me === req.employee_id;
    const creator = req.created_by === actor;
    const admin = await holdsPermission(tx, actor, 'leave.requests_admin');
    let team = false;
    if (!self && !creator && !admin) {
      if (await holdsPermission(tx, actor, 'leave.requests_view_team')) {
        const ids = await teamEmployeeIds(tx, actor, new Date().toISOString().slice(0, 10));
        team = ids.includes(req.employee_id);
      }
    } else {
      team = true;
    }
    return { self, creator, team, admin, ownerOrAdmin: self || creator || admin };
  }

  private async inScope(tx: Tx, set: ScopeSet, employeeId: string, date: string): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ ok: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM core.employee_assignments a
                      WHERE a.employee_id = ${employeeId}::uuid AND a.is_primary
                        AND daterange(a.effective_from, a.effective_to, '[)') @> ${date}::date
                        AND (a.company_id = ANY(string_to_array(${set.companies.join(',')}, ',')::uuid[])
                          OR a.site_id    = ANY(string_to_array(${set.sites.join(',')}, ',')::uuid[])
                          OR a.unit_id    = ANY(string_to_array(${set.units.join(',')}, ',')::uuid[]))) AS ok`;
    return rows[0]?.ok === true;
  }

  private async scopedEmployeeIds(tx: Tx, set: ScopeSet, date: string): Promise<string[]> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT DISTINCT e.id FROM core.employees e
        JOIN core.employee_assignments a ON a.employee_id = e.id AND a.is_primary
       WHERE e.deleted_at IS NULL
         AND daterange(a.effective_from, a.effective_to, '[)') @> ${date}::date
         AND (a.company_id = ANY(string_to_array(${set.companies.join(',')}, ',')::uuid[])
           OR a.site_id    = ANY(string_to_array(${set.sites.join(',')}, ',')::uuid[])
           OR a.unit_id    = ANY(string_to_array(${set.units.join(',')}, ',')::uuid[]))`;
    return rows.map((r) => r.id);
  }

  private async employmentFacts(tx: Tx, employeeId: string): Promise<{
    status: string; hireDate: string | null; terminationDate: string | null;
    suspensions: Array<{ from: string; to: string | null }>;
  }> {
    const emp = await tx.$queryRaw<Array<{ status: string; hire_date: string | null }>>`
      SELECT status, hire_date::text FROM core.employees WHERE id = ${employeeId}::uuid`;
    if (!emp[0]) return { status: 'unknown', hireDate: null, terminationDate: null, suspensions: [] };
    const events = await tx.$queryRaw<Array<{ event_type: string; effective_date: string }>>`
      SELECT event_type, effective_date::text FROM core.career_events
       WHERE employee_id = ${employeeId}::uuid ORDER BY effective_date, occurred_at`;
    let terminationDate: string | null = null;
    const suspensions: Array<{ from: string; to: string | null }> = [];
    let open: string | null = null;
    for (const e of events) {
      if (e.event_type === 'termination') terminationDate = e.effective_date;
      if (e.event_type === 'suspension' && open === null) open = e.effective_date;
      if ((e.event_type === 'return' || e.event_type === 'reinstatement') && open !== null) {
        suspensions.push({ from: open, to: addDaysIso(e.effective_date, -1) });
        open = null;
      }
    }
    if (open !== null) suspensions.push({ from: open, to: null });
    return { status: emp[0].status, hireDate: emp[0].hire_date, terminationDate, suspensions };
  }

  /** Responsable RÉSOLU (même logique prouvée qu'E10.3) : dérogation, sinon poste. */
  private async managerUserOf(tx: Tx, employeeId: string, date: string): Promise<string | null> {
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

  private async releaseReservation(tx: Tx, tenantId: string, req: RequestRow, version: number, cause: string, actor: string | null): Promise<void> {
    const res = await tx.$queryRaw<Array<{ id: string; quantity: string; unit: string; policy_id: string | null; policy_version: number | null; reference_period_start: string; reference_period_end: string; effective_on: string }>>`
      SELECT id, quantity::text, unit, policy_id, policy_version,
             reference_period_start::text, reference_period_end::text, effective_on::text
        FROM leave.entitlement_ledger
       WHERE tenant_id = ${tenantId}::uuid AND idempotency_key = ${reservationKey(req.id, version)}`;
    if (!res[0]) return;
    await tx.$executeRaw`
      INSERT INTO leave.entitlement_ledger (tenant_id, employee_id, absence_type_id, policy_id, policy_version,
        reference_period_start, reference_period_end, entry_kind, quantity, unit, effective_on, origin,
        business_ref, reason, idempotency_key, created_by, request_id, request_version)
      VALUES (${tenantId}::uuid, ${req.employee_id}::uuid, ${req.absence_type_id}::uuid,
        ${res[0].policy_id}::uuid, ${res[0].policy_version},
        ${res[0].reference_period_start}::date, ${res[0].reference_period_end}::date, 'release',
        ${Number(res[0].quantity)}, ${res[0].unit}, ${res[0].effective_on}::date, 'workflow',
        ${'demande ' + req.id + ' v' + version}, ${'libération : ' + cause},
        ${releaseKey(req.id, version)}, ${actor}::uuid, ${req.id}::uuid, ${version})
      ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`;
    await this.event(tx, tenantId, req.id, version, 'reservation_released', actor, { cause });
  }

  private async stakeholders(tx: Tx, req: RequestRow): Promise<string[]> {
    const out = [req.created_by];
    const ben = await tx.$queryRaw<Array<{ user_id: string | null }>>`
      SELECT user_id FROM core.employees WHERE id = ${req.employee_id}::uuid`;
    if (ben[0]?.user_id) out.push(ben[0].user_id);
    return [...new Set(out)];
  }

  private async event(tx: Tx, tenantId: string, requestId: string, version: number | null, event: string, actor: string | null, detail: Record<string, unknown>): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO leave.request_events (tenant_id, request_id, version, event, actor_user_id, detail)
      VALUES (${tenantId}::uuid, ${requestId}::uuid, ${version}, ${event}, ${actor}::uuid, ${JSON.stringify(detail)}::jsonb)`;
  }

  private async notifyUsers(
    tx: Tx, tenantId: string, actor: string, userIds: string[],
    eventKey: string, templateKey: string, payload: Record<string, unknown>,
  ): Promise<void> {
    await this.notify.publishEventTx(tx, tenantId, {
      eventKey, templateKey, payload,
      recipients: [...new Set(userIds)].map((u) => ({ userId: u })),
      source: 'business', subjectType: 'leave_request',
      subjectId: (payload['demande'] as string) ?? eventKey, createdBy: actor,
    });
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

  private maskRow(r: Record<string, unknown>, sensitive: boolean): Record<string, unknown> {
    if (r['confidential'] !== true || sensitive) return r;
    return {
      ...r,
      typeCode: null,
      labelFr: 'Absence', labelEn: 'Absence',
      comment: r['comment'] === undefined ? undefined : MASKED,
      draft: r['draft'] === undefined ? undefined : {},
    };
  }
}

function spanDays(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}
function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}
function numOrNull(v: unknown): number | null {
  return typeof v === 'number' ? v : v === null || v === undefined ? null : Number.isNaN(Number(v)) ? null : Number(v);
}
