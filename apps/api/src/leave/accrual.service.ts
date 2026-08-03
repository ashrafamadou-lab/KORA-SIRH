/**
 * E11.1 — Exécutions d'acquisition : mensuelle/annuelle par politique résolue,
 * prorata embauche/cessation, suspension du service effectif (événements de
 * carrière E9), report/expiration au passage de période — TOUT passe par le
 * ledger append-only avec clés d'idempotence : relancer n'écrit RIEN de neuf
 * (compté « déjà acquis »), deux exécutions actives ne se chevauchent pas
 * (contrainte d'exclusion), chaque mouvement conserve politique, version et
 * paramètres E4 exacts. Un rythme introuvable est une ERREUR listée, jamais
 * un défaut silencieux.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { auditAuth } from '../auth/audit.util';
import { NotificationService } from '../notify/notification.service';
import {
  LEAVE_ENGINE_VERSION, expectedAccruals, planRollover, referencePeriodOf,
  type EmploymentSpan, type ResolvedPolicy,
} from '../../../../packages/core/src/leave.ts';
import { DATE_RE, holdsPermission, pgCode, type TimeOutcome } from './leave-access';
import { LeaveCatalogService, monthsBetween, type ResolvedPolicyRow } from './catalog.service';

export interface AccrualRunInput {
  periodStart: string;
  periodEnd: string;
  scopeKind: 'tenant' | 'company' | 'site' | 'employee';
  scopeId?: string;
  reason: string;
  kind?: 'accrual' | 'carry_over' | 'recompute';
}

const MAX_EVALUATIONS = 20_000;

@Injectable()
export class LeaveAccrualService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: LeaveCatalogService,
    private readonly notify: NotificationService,
  ) {}

  async run(tenantId: string, actor: string, input: AccrualRunInput): Promise<TimeOutcome<{ run: unknown }>> {
    if (!DATE_RE.test(input.periodStart) || !DATE_RE.test(input.periodEnd) || input.periodEnd < input.periodStart) {
      return { kind: 'invalid', reason: 'période invalide (AAAA-MM-JJ, début ≤ fin)' };
    }
    if (!input.reason || input.reason.length < 3) return { kind: 'invalid', reason: 'motif obligatoire (3 caractères minimum)' };
    const kind = input.kind ?? 'accrual';
    const out = await this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'leave.accrual_run'))) {
        return { kind: 'forbidden' as const, reason: 'permission requise : leave.accrual_run' };
      }
      // Sérialisation DÉTERMINISTE des départs concurrents (même leçon que le moteur
      // de présence, run CI 30821391737) : verrou consultatif transactionnel par
      // tenant AVANT l'insertion — deux INSERT simultanés ne se deadlockent jamais
      // sur la vérification d'exclusion. La contrainte RESTE le garde-fou ultime.
      // $executeRaw impératif : pg_advisory_xact_lock renvoie void, que $queryRaw
      // ne sait pas désérialiser (500 constaté au run CI 30850506848) — même
      // convention que le verrou d'activation du Config-Center (config.service).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}::text || ':leave_accrual_run'))`;
      // Exécution déclarée (le verrou anti-chevauchement est la contrainte d'exclusion).
      let runId: string;
      try {
        const ins = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO leave.accrual_runs
            (tenant_id, period_start, period_end, scope_kind, scope_company_id, scope_site_id, scope_employee_id,
             reason, kind, engine_version, started_by)
          VALUES (${tenantId}::uuid, ${input.periodStart}::date, ${input.periodEnd}::date, ${input.scopeKind},
                  ${input.scopeKind === 'company' ? input.scopeId : null}::uuid,
                  ${input.scopeKind === 'site' ? input.scopeId : null}::uuid,
                  ${input.scopeKind === 'employee' ? input.scopeId : null}::uuid,
                  ${input.reason}, ${kind}, ${LEAVE_ENGINE_VERSION}, ${actor}::uuid)
          RETURNING id`;
        runId = ins[0]!.id;
      } catch (e) {
        if (pgCode(e) === '23P01') {
          return { kind: 'conflict' as const, reason: 'une exécution ACTIVE chevauche déjà cette période pour ce tenant' };
        }
        throw e;
      }

      // Salariés du périmètre (embauchés avant la fin de période, non supprimés).
      const employees = await tx.$queryRaw<Array<{
        id: string; matricule: string; status: string; hire_date: string | null;
      }>>`
        SELECT DISTINCT e.id, e.matricule, e.status, e.hire_date::text
          FROM core.employees e
          LEFT JOIN core.employee_assignments a ON a.employee_id = e.id AND a.is_primary
           AND daterange(a.effective_from, a.effective_to, '[)') && daterange(${input.periodStart}::date, ${input.periodEnd}::date, '[]')
         WHERE e.deleted_at IS NULL AND e.hire_date IS NOT NULL AND e.hire_date <= ${input.periodEnd}::date
           AND (${input.scopeKind} = 'tenant'
             OR (${input.scopeKind} = 'employee' AND e.id = ${input.scopeId ?? null}::uuid)
             OR (${input.scopeKind} = 'company'  AND a.company_id = ${input.scopeId ?? null}::uuid)
             OR (${input.scopeKind} = 'site'     AND a.site_id = ${input.scopeId ?? null}::uuid))
         ORDER BY e.matricule`;

      const types = await tx.$queryRaw<Array<{ id: string; code: string; unit: string }>>`
        SELECT id, code, unit FROM leave.absence_types WHERE status = 'active'`;

      const errorReport: Array<Record<string, unknown>> = [];
      let written = 0, skipped = 0, evaluations = 0;

      // Fenêtres MENSUELLES : politique, version ET paramètres E4 sont résolus au
      // FAIT GÉNÉRATEUR (le mois acquis) — jamais une valeur unique plaquée sur
      // toute la plage. Un changement daté (nouvelle version, nouveau paramètre)
      // vaut à sa date, le passé demeure.
      const months = monthWindows(input.periodStart, input.periodEnd);
      for (const emp of employees) {
        const employment = await this.employmentSpan(tx, emp.id, emp.status, emp.hire_date!);
        for (const ty of types) {
          const windows = kind === 'carry_over' ? [months[0]!] : months;
          for (const w of windows) {
            evaluations += 1;
            if (evaluations > MAX_EVALUATIONS) {
              return { kind: 'invalid' as const, reason: `plus de ${MAX_EVALUATIONS} évaluations — réduisez le périmètre ou la période` };
            }
            const resolved = await this.catalog.resolveFor(tx, tenantId, emp.id, ty.id, w.start);
            if (resolved.kind === 'none') continue;
            if (resolved.kind === 'ambiguous') {
              errorReport.push({ matricule: emp.matricule, type: ty.code, month: w.start.slice(0, 7), error: `politiques ambiguës : ${resolved.codes.join(', ')}` });
              continue;
            }
            const rates = await this.catalog.resolveRates(tx, tenantId, resolved.row, w.start);
            const policy = this.toEnginePolicy(resolved.row, rates);
            // Éligibilité : ancienneté minimale (E4 ou valeur de version) au mois considéré.
            const eligMin = this.eligibilityMinMonths(resolved.row, rates);
            if (eligMin !== null && emp.hire_date && monthsBetween(emp.hire_date, w.end) < eligMin) {
              continue;
            }
            if (kind === 'carry_over') {
              const r = await this.rolloverFor(tx, tenantId, emp.id, ty.id, policy, resolved.row, w.start, rates.paramsUsed);
              written += r.written; skipped += r.skipped;
              continue;
            }
            const { entries, errors } = expectedAccruals({
              policy, employment, periodStart: w.start, periodEnd: w.end,
            });
            for (const msg of errors) errorReport.push({ matricule: emp.matricule, type: ty.code, month: w.start.slice(0, 7), error: msg });
            for (const entry of entries) {
              const r = await tx.$executeRaw`
                INSERT INTO leave.entitlement_ledger
                  (tenant_id, employee_id, absence_type_id, policy_id, policy_version,
                   reference_period_start, reference_period_end, entry_kind, quantity, unit,
                   effective_on, origin, business_ref, params_used, idempotency_key, created_by)
                VALUES (${tenantId}::uuid, ${emp.id}::uuid, ${ty.id}::uuid, ${resolved.row.policyId}::uuid, ${resolved.row.policyVersion},
                        ${entry.referencePeriodStart}::date, ${entry.referencePeriodEnd}::date, 'accrual',
                        ${entry.quantity}, ${resolved.row.unit}, ${entry.effectiveOn}::date, 'system_accrual',
                        ${`run:${runId}:${entry.monthLabel}`},
                        ${JSON.stringify({ ...rates.paramsUsed, rateSource: rates.rateSource, serviceRatio: entry.serviceRatio, proratedFor: entry.proratedFor })}::jsonb,
                        ${`${entry.idempotencyKey}:${emp.id}`}, NULL)
                ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`;
              if (r > 0) written += 1; else skipped += 1;
            }
            // Plafond de cumul : l'excédent au-delà du plafond EXPIRE explicitement.
            if (rates.capValue !== null && entries.length > 0) {
              const capped = await this.applyCap(tx, tenantId, emp.id, ty.id, resolved.row, rates.capValue, entries[0]!.referencePeriodStart, entries[0]!.referencePeriodEnd);
              written += capped;
            }
          }
        }
      }

      const status = errorReport.length > 0 ? 'completed_with_errors' : 'completed';
      await tx.$executeRaw`
        UPDATE leave.accrual_runs
           SET status = ${status}, employees_count = ${employees.length},
               entries_written = ${written}, entries_skipped = ${skipped},
               errors_count = ${errorReport.length}, error_report = ${JSON.stringify(errorReport.slice(0, 200))}::jsonb,
               finished_at = now()
         WHERE id = ${runId}::uuid`;
      await auditAuth(tx, tenantId, {
        action: 'leave_accrual_run', actorUserId: actor, module: 'leave',
        recordType: 'accrual_run', recordId: runId,
        newValue: { kind, periodStart: input.periodStart, periodEnd: input.periodEnd, written, skipped, errors: errorReport.length },
        result: 'success',
      });
      if (errorReport.length > 0) {
        await this.notify.publishEventTx(tx, tenantId, {
          eventKey: `conges-acquisition-erreurs-${runId}`, templateKey: 'conges_acquisition_erreurs',
          payload: { execution: runId, erreurs: errorReport.length },
          recipients: [{ userId: actor }], source: 'business',
          subjectType: 'accrual_run', subjectId: runId, createdBy: actor,
        });
      }
      const run = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT id, period_start::text AS "periodStart", period_end::text AS "periodEnd", scope_kind AS "scopeKind",
               reason, kind, status, engine_version AS "engineVersion", employees_count AS "employeesCount",
               entries_written AS "entriesWritten", entries_skipped AS "entriesSkipped", errors_count AS "errorsCount",
               error_report AS "errorReport", started_at AS "startedAt", finished_at AS "finishedAt"
          FROM leave.accrual_runs WHERE id = ${runId}::uuid`;
      return { kind: 'ok' as const, run: run[0] };
    }, { timeoutMs: 60_000 });
    return out;
  }

  async listRuns(tenantId: string, actor: string): Promise<TimeOutcome<{ items: unknown[] }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'leave.accrual_run', 'leave.balance_view'))) {
        return { kind: 'forbidden', reason: 'permission requise : leave.accrual_run' };
      }
      const items = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT id, period_start::text AS "periodStart", period_end::text AS "periodEnd", scope_kind AS "scopeKind",
               reason, kind, status, engine_version AS "engineVersion", employees_count AS "employeesCount",
               entries_written AS "entriesWritten", entries_skipped AS "entriesSkipped", errors_count AS "errorsCount",
               error_report AS "errorReport", started_at AS "startedAt", finished_at AS "finishedAt"
          FROM leave.accrual_runs ORDER BY started_at DESC LIMIT 100`;
      return { kind: 'ok', items };
    });
  }

  // ---------------- Internes ----------------

  /** Cessation datée (dernier événement de carrière) + suspensions (suspension → return/reinstatement). */
  private async employmentSpan(
    tx: Prisma.TransactionClient, employeeId: string, status: string, hireDate: string,
  ): Promise<EmploymentSpan> {
    let terminationDate: string | null = null;
    if (status === 'terminated' || status === 'archived') {
      const term = await tx.$queryRaw<Array<{ d: string | null }>>`
        SELECT max(effective_date)::text AS d FROM core.career_events
         WHERE employee_id = ${employeeId}::uuid AND event_type = 'termination'`;
      terminationDate = term[0]?.d ?? null;
    }
    const events = await tx.$queryRaw<Array<{ event_type: string; effective_date: string }>>`
      SELECT event_type, effective_date::text FROM core.career_events
       WHERE employee_id = ${employeeId}::uuid AND event_type IN ('suspension', 'return', 'reinstatement')
       ORDER BY effective_date, occurred_at`;
    const suspensions: Array<{ from: string; to: string }> = [];
    let openFrom: string | null = null;
    for (const ev of events) {
      if (ev.event_type === 'suspension') {
        if (openFrom === null) openFrom = ev.effective_date;
      } else if (openFrom !== null) {
        // La date de RETOUR est le premier jour travaillé : la suspension s'achève la veille.
        suspensions.push({ from: openFrom, to: addDaysIso(ev.effective_date, -1) });
        openFrom = null;
      }
    }
    if (openFrom !== null) suspensions.push({ from: openFrom, to: '9999-12-31' });
    return { hireDate, terminationDate, suspensions };
  }

  private toEnginePolicy(row: ResolvedPolicyRow, rates: { accrualRate: number | null; carryOverMax: number | null; capValue: number | null }): ResolvedPolicy {
    const c = row.content;
    return {
      policyId: row.policyId, policyVersion: row.policyVersion,
      unit: row.unit as ResolvedPolicy['unit'],
      accrualMode: c['accrual_mode'] as ResolvedPolicy['accrualMode'],
      accrualRate: rates.accrualRate,
      rateSource: { kind: 'policy_value' },
      referencePeriod: c['reference_period'] as ResolvedPolicy['referencePeriod'],
      refStartMonth: (c['ref_start_month'] as number | null) ?? undefined,
      refStartDay: (c['ref_start_day'] as number | null) ?? undefined,
      prorataHire: c['prorata_hire'] as boolean,
      prorataTermination: c['prorata_termination'] as boolean,
      rounding: c['rounding'] as ResolvedPolicy['rounding'],
      accrualRequiresService: c['accrual_requires_service'] as boolean,
      capValue: rates.capValue,
      carryOverMax: rates.carryOverMax,
      carryOverExpiryMonths: (c['carry_over_expiry_months'] as number | null) ?? null,
    };
  }

  private eligibilityMinMonths(row: ResolvedPolicyRow, rates: { paramsUsed: Record<string, unknown> }): number | null {
    const c = row.content;
    const key = c['eligibility_min_months_param'];
    if (typeof key === 'string' && key) {
      const p = rates.paramsUsed[key] as { value?: unknown } | undefined;
      const v = p?.value;
      return typeof v === 'number' && Number.isFinite(v) ? v : null; // paramètre absent ⇒ pas de barrière inventée
    }
    const v = c['eligibility_min_months'];
    return typeof v === 'number' ? v : null;
  }

  /** Passage de période : expiration + report en mouvements DISTINCTS et idempotents. */
  private async rolloverFor(
    tx: Prisma.TransactionClient, tenantId: string, employeeId: string, typeId: string,
    policy: ResolvedPolicy, row: ResolvedPolicyRow, atDate: string, paramsUsed: Record<string, unknown>,
  ): Promise<{ written: number; skipped: number }> {
    // Période qui SE FERME : celle qui précède la période contenant atDate.
    const current = referencePeriodOf(policy, atDate, '2000-01-01');
    const prevEnd = addDaysIso(current.start, -1);
    const prev = referencePeriodOf(policy, prevEnd, '2000-01-01');
    const bal = await tx.$queryRaw<Array<{ available: string | number | null }>>`
      SELECT available FROM leave.balances_v
       WHERE tenant_id = ${tenantId}::uuid AND employee_id = ${employeeId}::uuid
         AND absence_type_id = ${typeId}::uuid AND reference_period_start = ${prev.start}::date`;
    const available = bal[0]?.available === null || bal[0]?.available === undefined ? 0 : Number(bal[0].available);
    const plan = planRollover({ policy, fromPeriod: prev, toPeriod: current, available });
    let written = 0, skipped = 0;
    if (plan.expire) {
      const r = await tx.$executeRaw`
        INSERT INTO leave.entitlement_ledger
          (tenant_id, employee_id, absence_type_id, policy_id, policy_version,
           reference_period_start, reference_period_end, entry_kind, quantity, unit,
           effective_on, origin, params_used, idempotency_key)
        VALUES (${tenantId}::uuid, ${employeeId}::uuid, ${typeId}::uuid, ${row.policyId}::uuid, ${row.policyVersion},
                ${prev.start}::date, ${prev.end}::date, 'expiry', ${plan.expire.quantity}, ${row.unit},
                ${prev.end}::date, 'carry_over_job', ${JSON.stringify(paramsUsed)}::jsonb,
                ${`${plan.expire.idempotencyKey}:${employeeId}`})
        ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`;
      if (r > 0) written += 1; else skipped += 1;
    }
    if (plan.carryOver) {
      const r = await tx.$executeRaw`
        INSERT INTO leave.entitlement_ledger
          (tenant_id, employee_id, absence_type_id, policy_id, policy_version,
           reference_period_start, reference_period_end, entry_kind, quantity, unit,
           effective_on, origin, params_used, idempotency_key)
        VALUES (${tenantId}::uuid, ${employeeId}::uuid, ${typeId}::uuid, ${row.policyId}::uuid, ${row.policyVersion},
                ${plan.carryOver.toPeriodStart}::date, ${plan.carryOver.toPeriodEnd}::date, 'carry_over',
                ${plan.carryOver.quantity}, ${row.unit}, ${plan.carryOver.toPeriodStart}::date, 'carry_over_job',
                ${JSON.stringify(paramsUsed)}::jsonb, ${`${plan.carryOver.idempotencyKey}:${employeeId}`})
        ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`;
      if (r > 0) written += 1; else skipped += 1;
      // L'expiration au terme de la période fermée : un mouvement d'expiration au
      // ledger de la période PRÉCÉDENTE équilibre le report (le disponible n'est
      // jamais compté deux fois).
      const r2 = await tx.$executeRaw`
        INSERT INTO leave.entitlement_ledger
          (tenant_id, employee_id, absence_type_id, policy_id, policy_version,
           reference_period_start, reference_period_end, entry_kind, quantity, unit,
           effective_on, origin, reason, params_used, idempotency_key)
        VALUES (${tenantId}::uuid, ${employeeId}::uuid, ${typeId}::uuid, ${row.policyId}::uuid, ${row.policyVersion},
                ${prev.start}::date, ${prev.end}::date, 'expiry', ${plan.carryOver.quantity}, ${row.unit},
                ${prev.end}::date, 'carry_over_job', 'sortie de période : reporté vers la période suivante',
                ${JSON.stringify(paramsUsed)}::jsonb, ${`carryout:${plan.carryOver.idempotencyKey}:${employeeId}`})
        ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`;
      if (r2 > 0) written += 1; else skipped += 1;
    }
    return { written, skipped };
  }

  /** Plafond de cumul : l'excédent au-delà du plafond expire EXPLICITEMENT. */
  private async applyCap(
    tx: Prisma.TransactionClient, tenantId: string, employeeId: string, typeId: string,
    row: ResolvedPolicyRow, cap: number, refStart: string, refEnd: string,
  ): Promise<number> {
    const bal = await tx.$queryRaw<Array<{ available: string | number | null }>>`
      SELECT available FROM leave.balances_v
       WHERE tenant_id = ${tenantId}::uuid AND employee_id = ${employeeId}::uuid
         AND absence_type_id = ${typeId}::uuid AND reference_period_start = ${refStart}::date`;
    const available = bal[0]?.available === null || bal[0]?.available === undefined ? 0 : Number(bal[0].available);
    const excess = Math.round((available - cap) * 1000) / 1000;
    if (excess <= 0) return 0;
    const r = await tx.$executeRaw`
      INSERT INTO leave.entitlement_ledger
        (tenant_id, employee_id, absence_type_id, policy_id, policy_version,
         reference_period_start, reference_period_end, entry_kind, quantity, unit,
         effective_on, origin, reason, idempotency_key)
      VALUES (${tenantId}::uuid, ${employeeId}::uuid, ${typeId}::uuid, ${row.policyId}::uuid, ${row.policyVersion},
              ${refStart}::date, ${refEnd}::date, 'expiry', ${excess}, ${row.unit},
              ${refStart}::date, 'system_accrual', 'plafond de cumul atteint : excédent expiré',
              ${`cap:${row.policyId}:${row.policyVersion}:${refStart}:${employeeId}:${available}`})
      ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`;
    return r > 0 ? 1 : 0;
  }
}

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

/** Fenêtres mensuelles couvrant [start..end] (bornées aux mois civils). */
function monthWindows(start: string, end: string): Array<{ start: string; end: string }> {
  const out: Array<{ start: string; end: string }> = [];
  const [sy, sm] = start.split('-').map(Number);
  const [ey, em] = end.split('-').map(Number);
  let y = sy!, m = sm!;
  while (y < ey! || (y === ey! && m <= em!)) {
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    out.push({ start: `${y}-${String(m).padStart(2, '0')}-01`, end: `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}` });
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}
