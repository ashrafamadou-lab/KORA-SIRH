/**
 * E10.2 — Exécutions du moteur de présence : orchestration, résultats VERSIONNÉS,
 * anomalies, recalcul motivé avec prévisualisation, agrégats retraçables.
 *
 * Principes portés ici (le calcul lui-même vit dans @kora/core/presence — pur) :
 *  - le moteur LIT et ne modifie JAMAIS : bruts, événements, horaires, affectations,
 *    paramètres — seules time.day_results / day_anomalies / calc_runs sont écrites ;
 *  - chaque résultat emporte son INSTANTANÉ (horaire, affectation, fuseau, paramètres
 *    E4 résolus À LA DATE avec provenance, version du moteur) → reproductible ;
 *  - un recalcul n'écrase jamais : contenu identique ⇒ AUCUNE écriture (idempotence),
 *    contenu différent ⇒ nouvelle version, l'ancienne bascule hors « courante » ;
 *  - exécution = UNE transaction : la contrainte d'exclusion PostgreSQL fait attendre
 *    puis REJETTE toute exécution active chevauchante du même tenant (409 net) ;
 *  - un jour en erreur n'en cache pas d'autres : résultat calc_state='error' +
 *    anomalie calc_failed, l'exécution devient completed_with_errors ;
 *  - AUCUN taux, AUCUN montant : heures supplémentaires CANDIDATES uniquement.
 *
 * Limites v1 assumées (README) : exécution SYNCHRONE bornée (le worker asynchrone
 * est prévu par le modèle : statuts queued/cancelled réservés) ; statut salarié
 * apprécié au moment du traitement (sauf embauche, comparée à la date) ; les
 * événements à cheval sur deux journées sont départagés par DISTANCE à la plage
 * planifiée (égalité → journée la plus ancienne), règle stable quel que soit le
 * périmètre de l'exécution.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { auditAuth } from '../auth/audit.util';
import { NotificationService } from '../notify/notification.service';
import { rotationDayIndex, localToUtc } from '../../../../packages/core/src/time.ts';
import {
  computeDay,
  DEFAULT_PRESENCE_PARAMS,
  PRESENCE_ENGINE_VERSION,
  PRESENCE_PARAM_KEYS,
  type ComputeDayInput,
  type DayComputation,
  type DayJustification,
  type EmploymentContext,
  type PlannedDay,
  type PresenceEvent,
  type PresenceParams,
} from '../../../../packages/core/src/presence.ts';
import { DATE_RE, holdsPermission, scopeSetFor, scopeCsv, type ScopeSet, type TimeOutcome } from './time-access';

// ---------------------------------------------------------------------------
// Bornes v1 (documentées) — le worker asynchrone lèvera les plafonds.
// ---------------------------------------------------------------------------
const MAX_PERIOD_DAYS = 366;
const MAX_RUN_EVALUATIONS = 20_000;   // salariés × jours par exécution synchrone
const MAX_PREVIEW_EVALUATIONS = 2_000;
const LARGE_RUN_NOTIFY_THRESHOLD = 500;

const DAY_MS = 86_400_000;
const dateMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const msDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => msDate(dateMs(d) + n * DAY_MS);
const daysBetween = (a: string, b: string) => Math.round((dateMs(b) - dateMs(a)) / DAY_MS);
const timeToMinute = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** Sérialisation STABLE (clés triées) — pour comparer contenus JSON sans dépendre de l'ordre. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>).sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export interface RunInput {
  periodStart: string;
  periodEnd: string;
  scopeKind: 'tenant' | 'company' | 'site' | 'unit' | 'employee';
  scopeId?: string;
  reason: string;
}

interface ParamsAtDate {
  params: PresenceParams;
  paramsUsed: Record<string, { value: unknown; parameterId: string | null; effectiveFrom: string | null; source: 'parametre' | 'defaut' }>;
  defaultTz: string | null;
  defaultTzUsedEntry: { value: unknown; parameterId: string | null; effectiveFrom: string | null; source: 'parametre' | 'defaut' } | null;
}

interface PlannedInfo {
  planned: PlannedDay | null;
  holiday: boolean;
  exceptionKind: 'closed' | 'rest' | 'special_hours' | null;
  modelCode: string | null;
  modelVersion: number | null;
  cycleDayIndex: number | null;
  assignmentId: string | null;
  companyId: string | null;
  siteId: string | null;
  unitId: string | null;
}

interface EmployeeContextBundle {
  employee: { id: string; status: string; hire_date: string | null };
  scheduleRows: Array<{ id: string; model_id: string; anchor_date: string; effective_from: string; effective_to: string | null; code: string }>;
  versionRows: Array<{ id: string; model_id: string; version: number; cycle_days: number; effective_from: string }>;
  dayRows: Array<{ version_id: string; day_index: number; is_rest: boolean; start_minute: number | null; end_minute: number | null; break_start_minute: number | null; break_end_minute: number | null }>;
  orgRows: Array<{ id: string; company_id: string | null; site_id: string | null; unit_id: string | null; effective_from: string; effective_to: string | null }>;
  exceptionRows: Array<{ exception_date: string; kind: 'closed' | 'rest' | 'special_hours'; start_minute: number | null; end_minute: number | null; employee_id: string | null; unit_id: string | null; site_id: string | null; company_id: string | null }>;
  holidayRows: Array<{ holiday_date: string; company_id: string | null; site_id: string | null; unit_id: string | null }>;
  eventRows: Array<{ id: string; local_date: string; local_time: string; event_type: string; site_id: string | null; tz: string }>;
  pendingDates: Set<string>;
  consumed: Set<string>;
  /** Surcouche corrective E10.3 (événements APPROUVÉS) — épinglés par journée. */
  pinned: Map<string, Array<{ id: string; localMinute: number; type: 'in' | 'out'; siteId: string | null }>>;
  justifications: Map<string, DayJustification[]>;
  correctionsCount: Map<string, number>;
}

interface DayEvaluation {
  computation: DayComputation;
  plannedInfo: PlannedInfo;
  paramsUsed: Record<string, unknown>;
  tz: string;
  firstInIso: string | null;
  lastOutIso: string | null;
  calcState: 'ok' | 'error';
  calcNote: string | null;
}

@Injectable()
export class CalcService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notify: NotificationService,
  ) {}

  // ==================================================================
  // Exécution d'un calcul (ou d'un recalcul motivé) — SYNCHRONE, bornée.
  // ==================================================================

  async run(
    tenantId: string, actor: string, input: RunInput, opts: { recalc: boolean },
  ): Promise<TimeOutcome<{ run: Record<string, unknown> }>> {
    const invalid = this.validateRunInput(input);
    if (invalid) return { kind: 'invalid', reason: invalid };
    const days = daysBetween(input.periodStart, input.periodEnd) + 1;

    let runId = '';
    try {
      const out = await this.prisma.withTenant(tenantId, async (tx) => {
        const employees = await this.resolveEmployees(tx, input);
        if (employees === null) return { kind: 'not_found' as const };
        if (employees.length * days > MAX_RUN_EVALUATIONS) {
          return {
            kind: 'invalid' as const,
            reason: `périmètre trop large : ${employees.length} salarié(s) × ${days} jour(s) > ${MAX_RUN_EVALUATIONS} — réduire la période ou le périmètre (worker asynchrone : évolution prévue)`,
          };
        }
        // L'insertion pose le VERROU d'exclusion : une exécution active chevauchante
        // du même tenant attendra la fin de cette transaction puis recevra 23P01.
        const startedAt = Date.now();
        const runRows = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO time.calc_runs
            (tenant_id, period_start, period_end, scope_kind, scope_company_id, scope_site_id,
             scope_unit_id, scope_employee_id, reason, is_recalc, engine_version, status, created_by)
          VALUES (${tenantId}::uuid, ${input.periodStart}::date, ${input.periodEnd}::date,
                  ${input.scopeKind}, ${input.scopeKind === 'company' ? input.scopeId : null}::uuid,
                  ${input.scopeKind === 'site' ? input.scopeId : null}::uuid,
                  ${input.scopeKind === 'unit' ? input.scopeId : null}::uuid,
                  ${input.scopeKind === 'employee' ? input.scopeId : null}::uuid,
                  ${input.reason}, ${opts.recalc}, ${PRESENCE_ENGINE_VERSION}, 'running', ${actor}::uuid)
          RETURNING id`;
        runId = runRows[0]!.id;
        await auditAuth(tx, tenantId, {
          action: opts.recalc ? 'time_calc_recalc_started' : 'time_calc_run_started',
          actorUserId: actor, module: 'time', recordType: 'calc_run', recordId: runId,
          newValue: { ...input, employees: employees.length, days }, result: 'success',
        });

        const paramsCache = new Map<string, ParamsAtDate>();
        const siteTz = await this.siteTimeZones(tx);
        const frozen = await this.frozenPeriods(tx);
        let written = 0; let unchanged = 0; let errored = 0; let anomaliesTotal = 0; let blockingTotal = 0;

        for (const employeeId of employees) {
          const ctx = await this.loadEmployeeContext(tx, employeeId, input.periodStart, input.periodEnd);
          for (let i = 0; i < days; i += 1) {
            const date = addDays(input.periodStart, i);
            // Journée en période VERROUILLÉE/CLÔTURÉE : les résultats retenus sont
            // FIGÉS (la base refuserait l'écriture) — comptée « inchangée », documenté.
            if (this.isFrozen(frozen, ctx, date)) { unchanged += 1; continue; }
            const evaluation = await this.evaluateDay(tx, tenantId, ctx, date, paramsCache, siteTz);
            const persisted = await this.persistDay(tx, tenantId, runId, employeeId, date, evaluation);
            if (persisted.wrote) {
              written += 1;
              anomaliesTotal += evaluation.computation.anomalies.length;
              blockingTotal += evaluation.computation.anomalies.filter((a) => a.severity === 'blocking').length;
            } else unchanged += 1;
            if (evaluation.calcState === 'error') errored += 1;
          }
        }

        // E10.3 — parcours « anomalie bloquante ⇒ demande » : chaque anomalie
        // BLOQUANTE d'origine emploi écrite par CETTE exécution reçoit un BROUILLON
        // de demande de correction (origin auto_anomaly), une seule fois par anomalie.
        await tx.$executeRaw`
          INSERT INTO time.correction_requests
            (tenant_id, employee_id, work_date, kind, origin, requester_user_id, motive, payload, anomaly_id)
          SELECT a.tenant_id, a.employee_id, a.work_date, 'exclude_event', 'auto_anomaly', ${actor}::uuid,
                 'brouillon automatique : anomalie bloquante « ' || a.code || ' »',
                 jsonb_build_object('eventId', a.refs -> 'eventIds' ->> 0),
                 a.id
            FROM time.day_anomalies a
            JOIN time.day_results r ON r.id = a.day_result_id
           WHERE r.calc_run_id = ${runId}::uuid AND a.severity = 'blocking'
             AND a.code IN ('suspended', 'not_yet_hired', 'terminated')
             AND a.refs -> 'eventIds' ->> 0 IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM time.correction_requests cr WHERE cr.anomaly_id = a.id)`;

        const status = errored > 0 ? 'completed_with_errors' : 'completed';
        const durationMs = Date.now() - startedAt;
        await tx.$executeRaw`
          UPDATE time.calc_runs
             SET status = ${status}, finished_at = now(), employees_count = ${employees.length},
                 days_count = ${days}, results_written = ${written}, results_unchanged = ${unchanged},
                 results_error = ${errored}, anomalies_count = ${anomaliesTotal}, duration_ms = ${durationMs}
           WHERE id = ${runId}::uuid`;
        await auditAuth(tx, tenantId, {
          action: 'time_calc_run_finished', actorUserId: actor, module: 'time',
          recordType: 'calc_run', recordId: runId,
          newValue: { status, written, unchanged, errored, anomalies: anomaliesTotal, durationMs },
          result: 'success',
        });

        // E5 — canaux : sans modèle actif, rien n'est envoyé (le run reste la vérité).
        if (blockingTotal > 0) {
          await this.notifyPermissionHolders(tx, tenantId, actor, 'time.anomalies_manage',
            `temps-anomalies-bloquantes-${runId}`, 'temps_anomalies_bloquantes',
            { execution_id: runId, bloquantes: blockingTotal, periode: `${input.periodStart} → ${input.periodEnd}` },
            'calc_run', runId);
        }
        if (employees.length * days >= LARGE_RUN_NOTIFY_THRESHOLD) {
          await this.notify.publishEventTx(tx, tenantId, {
            eventKey: `temps-calcul-termine-${runId}`,
            templateKey: 'temps_calcul_termine',
            payload: { execution_id: runId, statut: status, resultats: written, inchanges: unchanged },
            recipients: [{ userId: actor }],
            source: 'business', subjectType: 'calc_run', subjectId: runId, createdBy: actor,
          });
        }

        const run = await this.readRun(tx, runId);
        return { kind: 'ok' as const, run: run! };
      }, { timeoutMs: 120_000 }); // exécution bornée (MAX_RUN_EVALUATIONS) — fenêtre élargie
      return out;
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('calc_runs_no_concurrent_overlap')) {
        return { kind: 'conflict', reason: 'une exécution ACTIVE du même tenant chevauche cette période — attendre sa fin (protection PostgreSQL contre les versions courantes concurrentes)' };
      }
      // Échec SYSTÉMIQUE : la transaction est annulée (aucune écriture partielle) ;
      // l'échec est MATÉRIALISÉ par une exécution 'failed' + notification E5.
      return this.recordFailedRun(tenantId, actor, input, opts.recalc, msg);
    }
  }

  /** Prévisualisation d'un recalcul : calcule, COMPARE, n'écrit RIEN. */
  async preview(
    tenantId: string, actor: string, input: RunInput,
  ): Promise<TimeOutcome<{ evaluated: number; wouldWrite: number; unchanged: number; diffs: unknown[] }>> {
    const invalid = this.validateRunInput(input);
    if (invalid) return { kind: 'invalid', reason: invalid };
    const days = daysBetween(input.periodStart, input.periodEnd) + 1;
    return this.prisma.withTenant(tenantId, async (tx) => {
      const employees = await this.resolveEmployees(tx, input);
      if (employees === null) return { kind: 'not_found' };
      if (employees.length * days > MAX_PREVIEW_EVALUATIONS) {
        return { kind: 'invalid', reason: `prévisualisation bornée à ${MAX_PREVIEW_EVALUATIONS} évaluations (${employees.length} × ${days} demandées)` };
      }
      const paramsCache = new Map<string, ParamsAtDate>();
      const siteTz = await this.siteTimeZones(tx);
      const frozen = await this.frozenPeriods(tx);
      const diffs: unknown[] = [];
      let wouldWrite = 0; let unchanged = 0;
      for (const employeeId of employees) {
        const ctx = await this.loadEmployeeContext(tx, employeeId, input.periodStart, input.periodEnd);
        for (let i = 0; i < days; i += 1) {
          const date = addDays(input.periodStart, i);
          if (this.isFrozen(frozen, ctx, date)) { unchanged += 1; continue; }
          const evaluation = await this.evaluateDay(tx, tenantId, ctx, date, paramsCache, siteTz);
          const current = await this.readCurrent(tx, employeeId, date);
          const next = this.rowShape(evaluation);
          const changed = this.changedFields(current, next);
          if (changed === null) { unchanged += 1; continue; }
          wouldWrite += 1;
          diffs.push({
            employeeId, date,
            currentVersion: current ? Number(current['version']) : null,
            currentStatus: current ? (current['day_status'] as string) : null,
            nextStatus: evaluation.computation.status,
            changedFields: changed,
            nextAnomalies: evaluation.computation.anomalies.map((a) => a.code),
          });
        }
      }
      await auditAuth(tx, tenantId, {
        action: 'time_calc_preview', actorUserId: actor, module: 'time',
        recordType: 'calc_run',
        newValue: { ...input, evaluated: employees.length * days, wouldWrite }, result: 'success',
      });
      return { kind: 'ok', evaluated: employees.length * days, wouldWrite, unchanged, diffs };
    }, { timeoutMs: 60_000 });
  }

  private validateRunInput(input: RunInput): string | null {
    if (!DATE_RE.test(input.periodStart) || !DATE_RE.test(input.periodEnd)) return 'periodStart/periodEnd : AAAA-MM-JJ';
    if (input.periodEnd < input.periodStart) return 'periodEnd avant periodStart';
    if (daysBetween(input.periodStart, input.periodEnd) + 1 > MAX_PERIOD_DAYS) return `période bornée à ${MAX_PERIOD_DAYS} jours`;
    if (!['tenant', 'company', 'site', 'unit', 'employee'].includes(input.scopeKind)) return 'scopeKind : tenant, company, site, unit ou employee';
    if (input.scopeKind !== 'tenant' && !input.scopeId) return `scopeId requis pour le périmètre « ${input.scopeKind} »`;
    if (input.reason.length < 1 || input.reason.length > 300) return 'reason : 1 à 300 caractères';
    return null;
  }

  private async recordFailedRun(
    tenantId: string, actor: string, input: RunInput, recalc: boolean, message: string,
  ): Promise<TimeOutcome<{ run: Record<string, unknown> }>> {
    const note = message.split('\n')[0]!.slice(0, 500);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO time.calc_runs
          (tenant_id, period_start, period_end, scope_kind, scope_company_id, scope_site_id,
           scope_unit_id, scope_employee_id, reason, is_recalc, engine_version, status, finished_at, error_note, created_by)
        VALUES (${tenantId}::uuid, ${input.periodStart}::date, ${input.periodEnd}::date,
                ${input.scopeKind}, ${input.scopeKind === 'company' ? input.scopeId : null}::uuid,
                ${input.scopeKind === 'site' ? input.scopeId : null}::uuid,
                ${input.scopeKind === 'unit' ? input.scopeId : null}::uuid,
                ${input.scopeKind === 'employee' ? input.scopeId : null}::uuid,
                ${input.reason}, ${recalc}, ${PRESENCE_ENGINE_VERSION}, 'failed', now(), ${note}, ${actor}::uuid)
        RETURNING id`;
      const failedId = rows[0]!.id;
      await auditAuth(tx, tenantId, {
        action: 'time_calc_run_failed', actorUserId: actor, module: 'time',
        recordType: 'calc_run', recordId: failedId, newValue: { note }, result: 'failure',
      });
      await this.notifyPermissionHolders(tx, tenantId, actor, 'time.calc_run',
        `temps-calcul-echec-${failedId}`, 'temps_calcul_echec',
        { execution_id: failedId, erreur: note, periode: `${input.periodStart} → ${input.periodEnd}` },
        'calc_run', failedId);
      const run = await this.readRun(tx, failedId);
      return { kind: 'ok', run: run! };
    });
  }

  private async notifyPermissionHolders(
    tx: Prisma.TransactionClient, tenantId: string, actor: string, permission: string,
    eventKey: string, templateKey: string, payload: Record<string, unknown>,
    subjectType: string, subjectId: string,
  ): Promise<void> {
    const holders = await tx.$queryRaw<Array<{ user_id: string }>>`
      SELECT DISTINCT ur.user_id FROM admin.user_roles ur
        JOIN admin.role_permissions rp ON rp.role_id = ur.role_id
        JOIN admin.users u ON u.id = ur.user_id
       WHERE rp.permission_key = ${permission} AND u.is_active`;
    const recipients = holders.length > 0 ? holders.map((h) => ({ userId: h.user_id })) : [{ userId: actor }];
    await this.notify.publishEventTx(tx, tenantId, {
      eventKey, templateKey, payload, recipients,
      source: 'business', subjectType, subjectId, createdBy: actor,
    });
  }

  // ==================================================================
  // Résolution du périmètre et des contextes
  // ==================================================================

  private async resolveEmployees(tx: Prisma.TransactionClient, input: RunInput): Promise<string[] | null> {
    const { periodStart: s, periodEnd: e } = input;
    if (input.scopeKind === 'employee') {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM core.employees WHERE id = ${input.scopeId}::uuid AND deleted_at IS NULL`;
      return rows.length > 0 ? [rows[0]!.id] : null;
    }
    const scopeCompany = input.scopeKind === 'company' ? input.scopeId! : null;
    const scopeSite = input.scopeKind === 'site' ? input.scopeId! : null;
    const scopeUnit = input.scopeKind === 'unit' ? input.scopeId! : null;
    if (input.scopeKind !== 'tenant') {
      const exists = await tx.$queryRaw<Array<{ ok: boolean }>>`
        SELECT (CASE
          WHEN ${scopeCompany}::uuid IS NOT NULL THEN EXISTS (SELECT 1 FROM org.companies WHERE id = ${scopeCompany}::uuid)
          WHEN ${scopeSite}::uuid IS NOT NULL THEN EXISTS (SELECT 1 FROM org.sites WHERE id = ${scopeSite}::uuid)
          ELSE EXISTS (SELECT 1 FROM org.units WHERE id = ${scopeUnit}::uuid) END) AS ok`;
      if (!exists[0]?.ok) return null;
    }
    // Inclus : salariés en activité (ou suspendus — leur journée le DIT), et tout
    // salarié ayant un horaire affecté ou des événements sur la période (un pointage
    // d'un salarié sorti doit produire son anomalie, pas disparaître).
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT e.id FROM core.employees e
       WHERE e.deleted_at IS NULL AND e.status <> 'draft'
         AND (e.status IN ('active', 'on_leave', 'suspended')
           OR EXISTS (SELECT 1 FROM time.employee_schedules es
                       WHERE es.employee_id = e.id
                         AND daterange(es.effective_from, es.effective_to, '[)') && daterange(${s}::date, ${e}::date, '[]'))
           OR EXISTS (SELECT 1 FROM time.punch_events ev
                       WHERE ev.employee_id = e.id AND ev.local_date BETWEEN ${s}::date AND ${e}::date))
         AND (${input.scopeKind === 'tenant'} OR EXISTS (
               SELECT 1 FROM core.employee_assignments a
                WHERE a.employee_id = e.id AND a.is_primary
                  AND daterange(a.effective_from, a.effective_to, '[)') && daterange(${s}::date, ${e}::date, '[]')
                  AND (a.company_id = ${scopeCompany}::uuid OR a.site_id = ${scopeSite}::uuid OR a.unit_id = ${scopeUnit}::uuid)))
       ORDER BY e.matricule`;
    return rows.map((r) => r.id);
  }

  private async siteTimeZones(tx: Prisma.TransactionClient): Promise<Map<string, string | null>> {
    const rows = await tx.$queryRaw<Array<{ id: string; time_zone: string | null }>>`
      SELECT id, time_zone FROM org.sites`;
    return new Map(rows.map((r) => [r.id, r.time_zone]));
  }

  /** Périodes VERROUILLÉES/CLÔTURÉES/ARCHIVÉES du tenant — leurs journées sont figées. */
  private async frozenPeriods(tx: Prisma.TransactionClient): Promise<Array<{
    scope_kind: string; company_id: string | null; site_id: string | null;
    period_start: string; period_end: string;
  }>> {
    return tx.$queryRaw`
      SELECT scope_kind, company_id, site_id, period_start::text, period_end::text
        FROM time.periods WHERE status IN ('locked', 'closed', 'archived')`;
  }

  private isFrozen(
    frozen: Array<{ scope_kind: string; company_id: string | null; site_id: string | null; period_start: string; period_end: string }>,
    ctx: EmployeeContextBundle, date: string,
  ): boolean {
    for (const p of frozen) {
      if (date < p.period_start || date > p.period_end) continue;
      if (p.scope_kind === 'tenant') return true;
      const org = ctx.orgRows.find((a) => a.effective_from <= date && (a.effective_to === null || a.effective_to > date));
      if (!org) continue;
      if (p.scope_kind === 'company' && org.company_id === p.company_id) return true;
      if (p.scope_kind === 'site' && org.site_id === p.site_id) return true;
    }
    return false;
  }

  /** Préchargement PAR SALARIÉ (période ± 1 jour) — évite le N+1 jour par jour. */
  private async loadEmployeeContext(
    tx: Prisma.TransactionClient, employeeId: string, periodStart: string, periodEnd: string,
  ): Promise<EmployeeContextBundle> {
    const s = addDays(periodStart, -1);
    const e = addDays(periodEnd, 1);
    const employee = (await tx.$queryRaw<Array<{ id: string; status: string; hire_date: string | null }>>`
      SELECT id, status, hire_date::text FROM core.employees WHERE id = ${employeeId}::uuid`)[0]!;
    const scheduleRows = await tx.$queryRaw<EmployeeContextBundle['scheduleRows']>`
      SELECT es.id, es.model_id, es.anchor_date::text, es.effective_from::text, es.effective_to::text, m.code
        FROM time.employee_schedules es JOIN time.schedule_models m ON m.id = es.model_id
       WHERE es.employee_id = ${employeeId}::uuid
         AND daterange(es.effective_from, es.effective_to, '[)') && daterange(${s}::date, ${e}::date, '[]')`;
    const modelIds = [...new Set(scheduleRows.map((r) => r.model_id))];
    const versionRows = modelIds.length === 0 ? [] : await tx.$queryRaw<EmployeeContextBundle['versionRows']>`
      SELECT id, model_id, version, cycle_days, effective_from::text
        FROM time.schedule_versions
       WHERE model_id = ANY(string_to_array(${modelIds.join(',')}, ',')::uuid[]) AND effective_from <= ${e}::date`;
    const versionIds = versionRows.map((v) => v.id);
    const dayRows = versionIds.length === 0 ? [] : await tx.$queryRaw<EmployeeContextBundle['dayRows']>`
      SELECT version_id, day_index, is_rest, start_minute, end_minute, break_start_minute, break_end_minute
        FROM time.schedule_version_days
       WHERE version_id = ANY(string_to_array(${versionIds.join(',')}, ',')::uuid[])`;
    const orgRows = await tx.$queryRaw<EmployeeContextBundle['orgRows']>`
      SELECT id, company_id, site_id, unit_id, effective_from::text, effective_to::text
        FROM core.employee_assignments
       WHERE employee_id = ${employeeId}::uuid AND is_primary
         AND daterange(effective_from, effective_to, '[)') && daterange(${s}::date, ${e}::date, '[]')`;
    const exceptionRows = await tx.$queryRaw<EmployeeContextBundle['exceptionRows']>`
      SELECT exception_date::text, kind, start_minute, end_minute, employee_id, unit_id, site_id, company_id
        FROM time.schedule_exceptions
       WHERE status = 'active' AND exception_date BETWEEN ${s}::date AND ${e}::date
         AND (employee_id = ${employeeId}::uuid OR employee_id IS NULL)`;
    const holidayRows = await tx.$queryRaw<EmployeeContextBundle['holidayRows']>`
      SELECT h.holiday_date::text, c.company_id, c.site_id, c.unit_id
        FROM time.holidays h JOIN time.holiday_calendars c ON c.id = h.calendar_id
       WHERE h.status = 'active' AND c.status = 'active' AND h.holiday_date BETWEEN ${s}::date AND ${e}::date`;
    // Événements : période élargie (les fenêtres d'appariement débordent sur la
    // veille et jusqu'au surlendemain pour les rotations traversant minuit).
    const eventRows = await tx.$queryRaw<EmployeeContextBundle['eventRows']>`
      SELECT id, local_date::text, local_time::text, event_type, site_id, tz
        FROM time.punch_events
       WHERE employee_id = ${employeeId}::uuid AND match_status = 'matched'
         AND local_date BETWEEN ${addDays(periodStart, -1)}::date AND ${addDays(periodEnd, 2)}::date
       ORDER BY local_date, local_time, id`;
    const pendingRows = await tx.$queryRaw<Array<{ local_date: string }>>`
      SELECT DISTINCT local_date::text FROM time.punch_events
       WHERE employee_id = ${employeeId}::uuid AND match_status <> 'matched'
         AND local_date IS NOT NULL AND local_date BETWEEN ${periodStart}::date AND ${periodEnd}::date`;
    const ctx: EmployeeContextBundle = {
      employee, scheduleRows, versionRows, dayRows, orgRows, exceptionRows, holidayRows, eventRows,
      pendingDates: new Set(pendingRows.map((r) => r.local_date)),
      consumed: new Set<string>(),
      pinned: new Map(), justifications: new Map(), correctionsCount: new Map(),
    };
    // Surcouche corrective APPROUVÉE (E10.3) — appliquée AVANT l'appariement, dans
    // l'ordre de création (déterministe) : exclusions, retypages, sites corrigés,
    // rattachements forcés, événements ajoutés (épinglés), justifications.
    const corrections = await tx.$queryRaw<Array<{ id: string; work_date: string; kind: string; effect: Record<string, unknown> }>>`
      SELECT id, work_date::text, kind, effect FROM time.correction_events
       WHERE employee_id = ${employeeId}::uuid
         AND work_date BETWEEN ${addDays(periodStart, -1)}::date AND ${addDays(periodEnd, 1)}::date
       ORDER BY created_at, id`;
    this.applyCorrectionOverlay(ctx, corrections);
    return ctx;
  }

  /** Chirurgie du POOL d'événements par la surcouche corrective — le brut reste intact. */
  private applyCorrectionOverlay(
    ctx: EmployeeContextBundle,
    corrections: Array<{ id: string; work_date: string; kind: string; effect: Record<string, unknown> }>,
  ): void {
    const bump = (date: string): void => {
      ctx.correctionsCount.set(date, (ctx.correctionsCount.get(date) ?? 0) + 1);
    };
    for (const c of corrections) {
      const eff = c.effect;
      bump(c.work_date);
      if (typeof eff['excludeEventId'] === 'string') {
        ctx.eventRows = ctx.eventRows.filter((e) => e.id !== eff['excludeEventId']);
        continue;
      }
      const retype = eff['retype'] as { eventId?: string; type?: string } | undefined;
      if (retype?.eventId && typeof retype.type === 'string') {
        const row = ctx.eventRows.find((e) => e.id === retype.eventId);
        if (row) row.event_type = retype.type;
        continue;
      }
      const site = eff['overrideSite'] as { eventId?: string; siteId?: string | null } | undefined;
      if (site?.eventId) {
        const row = ctx.eventRows.find((e) => e.id === site.eventId);
        if (row) row.site_id = site.siteId ?? null;
        continue;
      }
      const reattach = eff['reattach'] as { eventId?: string; targetDate?: string } | undefined;
      if (reattach?.eventId && typeof reattach.targetDate === 'string') {
        const row = ctx.eventRows.find((e) => e.id === reattach.eventId);
        if (row) {
          ctx.eventRows = ctx.eventRows.filter((e) => e.id !== row.id);
          const rel = daysBetween(reattach.targetDate, row.local_date) * 1440 + timeToMinute(row.local_time);
          const type = row.event_type === 'in' || row.event_type === 'break_end' ? 'in'
            : row.event_type === 'out' || row.event_type === 'break_start' ? 'out' : 'in';
          const list = ctx.pinned.get(reattach.targetDate) ?? [];
          list.push({ id: row.id, localMinute: rel, type, siteId: row.site_id });
          ctx.pinned.set(reattach.targetDate, list);
        }
        continue;
      }
      const add = eff['addEvent'] as { localMinute?: number; type?: string; siteId?: string | null } | undefined;
      if (add && typeof add.localMinute === 'number' && (add.type === 'in' || add.type === 'out')) {
        const list = ctx.pinned.get(c.work_date) ?? [];
        list.push({ id: `corr-${c.id}`, localMinute: Math.round(add.localMinute), type: add.type, siteId: add.siteId ?? null });
        ctx.pinned.set(c.work_date, list);
        continue;
      }
      const justify = eff['justify'] as { target?: string; category?: string; minutes?: number | null } | undefined;
      if (justify && typeof justify.target === 'string' && typeof justify.category === 'string') {
        const list = ctx.justifications.get(c.work_date) ?? [];
        list.push({
          target: justify.target as DayJustification['target'],
          category: justify.category,
          minutes: justify.minutes ?? null,
        });
        ctx.justifications.set(c.work_date, list);
        continue;
      }
      const offsite = eff['offsite'] as { category?: string; minutes?: number | null } | undefined;
      if (offsite && typeof offsite.category === 'string') {
        const list = ctx.justifications.get(c.work_date) ?? [];
        list.push({ target: 'offsite', category: offsite.category, minutes: offsite.minutes ?? null });
        ctx.justifications.set(c.work_date, list);
      }
    }
  }

  // ==================================================================
  // Résolution d'une journée : horaire effectif, contexte, événements.
  // ==================================================================

  private plannedFor(ctx: EmployeeContextBundle, date: string): PlannedInfo {
    const org = ctx.orgRows.find((a) => a.effective_from <= date && (a.effective_to === null || a.effective_to > date)) ?? null;
    const info: PlannedInfo = {
      planned: null, holiday: false, exceptionKind: null, modelCode: null, modelVersion: null,
      cycleDayIndex: null, assignmentId: org?.id ?? null, companyId: org?.company_id ?? null,
      siteId: org?.site_id ?? null, unitId: org?.unit_id ?? null,
    };
    // Férié applicable : calendrier GLOBAL, ou visant la société/le site/l'unité de
    // l'affectation à la date (même règle que la résolution E10.1).
    info.holiday = ctx.holidayRows.some((h) => h.holiday_date === date
      && ((h.company_id === null && h.site_id === null && h.unit_id === null)
        || (org !== null && (h.company_id === org.company_id || h.site_id === org.site_id || h.unit_id === org.unit_id))));

    const asg = ctx.scheduleRows.find((r) => r.effective_from <= date && (r.effective_to === null || r.effective_to > date));
    if (asg) {
      const ver = ctx.versionRows
        .filter((v) => v.model_id === asg.model_id && v.effective_from <= date)
        .sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1))[0];
      if (ver) {
        const idx = rotationDayIndex(date, asg.anchor_date, ver.cycle_days);
        const day = ctx.dayRows.find((d) => d.version_id === ver.id && d.day_index === idx);
        info.modelCode = asg.code;
        info.modelVersion = ver.version;
        info.cycleDayIndex = idx;
        if (day) {
          info.planned = {
            isRest: day.is_rest,
            startMinute: day.start_minute, endMinute: day.end_minute,
            breakStartMinute: day.break_start_minute, breakEndMinute: day.break_end_minute,
          };
        }
      }
    }
    // Exception la plus PRÉCISE (individuelle > unité > site > société) à la date.
    const candidates = ctx.exceptionRows
      .filter((x) => x.exception_date === date)
      .filter((x) => x.employee_id === ctx.employee.id
        || (x.employee_id === null && org !== null
          && ((x.unit_id !== null && x.unit_id === org.unit_id)
            || (x.site_id !== null && x.site_id === org.site_id)
            || (x.company_id !== null && x.company_id === org.company_id))))
      .sort((a, b) => this.exceptionRank(a) - this.exceptionRank(b));
    const exc = candidates[0];
    if (exc && info.planned !== null) {
      info.exceptionKind = exc.kind;
      if (exc.kind === 'closed' || exc.kind === 'rest') {
        info.planned = { isRest: true, startMinute: null, endMinute: null, breakStartMinute: null, breakEndMinute: null };
      } else if (exc.start_minute !== null && exc.end_minute !== null) {
        // Horaires SPÉCIAUX : plage remplacée, pause planifiée non conservée (documenté).
        info.planned = { isRest: false, startMinute: exc.start_minute, endMinute: exc.end_minute, breakStartMinute: null, breakEndMinute: null };
      }
    }
    return info;
  }

  private exceptionRank(x: { employee_id: string | null; unit_id: string | null; site_id: string | null }): number {
    if (x.employee_id !== null) return 0;
    if (x.unit_id !== null) return 1;
    if (x.site_id !== null) return 2;
    return 3;
  }

  /** Fenêtre d'appariement de la journée (minutes relatives à SON 00:00). */
  private windowOf(info: PlannedInfo, params: PresenceParams): { from: number; to: number; range: { from: number; to: number } } {
    if (info.planned !== null && !info.planned.isRest && info.planned.startMinute !== null && info.planned.endMinute !== null) {
      return {
        from: info.planned.startMinute - params.matchWindowBeforeMin,
        to: info.planned.endMinute + params.matchWindowAfterMin,
        range: { from: info.planned.startMinute, to: info.planned.endMinute },
      };
    }
    return { from: 0, to: 1440, range: { from: 0, to: 1440 } };
  }

  private distToRange(rel: number, range: { from: number; to: number }): number {
    if (rel >= range.from && rel <= range.to) return 0;
    return Math.min(Math.abs(rel - range.from), Math.abs(rel - range.to));
  }

  /**
   * Rattachement DÉTERMINISTE des événements à la journée : fenêtre paramétrée,
   * différend avec la veille/le lendemain tranché par la DISTANCE à la plage
   * planifiée (égalité → journée la plus ANCIENNE). La règle ne dépend que de la
   * date — un recalcul d'UN jour rattache comme l'exécution de toute la période.
   */
  private attachEvents(
    ctx: EmployeeContextBundle, date: string,
    infoPrev: PlannedInfo, info: PlannedInfo, infoNext: PlannedInfo, params: PresenceParams,
  ): PresenceEvent[] {
    const w = this.windowOf(info, params);
    const wPrev = this.windowOf(infoPrev, params);
    const wNext = this.windowOf(infoNext, params);
    const out: PresenceEvent[] = [];
    for (const ev of ctx.eventRows) {
      if (ctx.consumed.has(ev.id)) continue;
      const rel = daysBetween(date, ev.local_date) * 1440 + timeToMinute(ev.local_time);
      if (rel < w.from || rel > w.to) continue;
      const relPrev = rel + 1440;
      if (relPrev >= wPrev.from && relPrev <= wPrev.to
        && this.distToRange(rel, w.range) >= this.distToRange(relPrev, wPrev.range)) {
        continue; // la VEILLE le revendique au moins aussi fort → il lui revient (jour le plus ancien)
      }
      const relNext = rel - 1440;
      if (relNext >= wNext.from && relNext <= wNext.to
        && this.distToRange(rel, w.range) > this.distToRange(relNext, wNext.range)) {
        continue; // le LENDEMAIN est strictement plus proche → il lui revient
      }
      out.push({
        id: ev.id,
        localMinute: rel,
        // break_start = on QUITTE le poste (sortie), break_end = on y REVIENT (entrée) — règle documentée.
        type: ev.event_type === 'in' || ev.event_type === 'break_end' ? 'in'
          : ev.event_type === 'out' || ev.event_type === 'break_start' ? 'out' : 'unknown',
        siteMatches: ev.site_id === null || info.siteId === null ? null : ev.site_id === info.siteId,
        ambiguousTime: false, // les heures ambiguës restent hors 'matched' (file des non-appariés)
      });
    }
    for (const e of out) ctx.consumed.add(e.id);
    // Événements ÉPINGLÉS par une correction approuvée : rattachés à CETTE journée
    // sans fenêtre ni différend — le rattachement est la décision elle-même.
    for (const p of ctx.pinned.get(date) ?? []) {
      out.push({
        id: p.id, localMinute: p.localMinute, type: p.type,
        siteMatches: p.siteId === null || info.siteId === null ? null : p.siteId === info.siteId,
        ambiguousTime: false,
      });
      ctx.consumed.add(p.id);
    }
    return out;
  }

  private employmentAt(ctx: EmployeeContextBundle, date: string): EmploymentContext {
    const st = ctx.employee.status;
    // Limite v1 documentée : le statut est celui CONSTATÉ au traitement (comme la
    // normalisation E10.1) ; seule l'embauche est comparée à la date du jour.
    const notYetHired = (ctx.employee.hire_date !== null && ctx.employee.hire_date > date)
      || st === 'draft' || st === 'pre_hire';
    const terminated = st === 'terminated' || st === 'archived';
    const suspended = st === 'suspended';
    const org = ctx.orgRows.some((a) => a.effective_from <= date && (a.effective_to === null || a.effective_to > date));
    return {
      active: !notYetHired && !terminated && (st === 'active' || st === 'on_leave'),
      notYetHired, terminated, suspended, hasAssignment: org,
    };
  }

  private async paramsFor(
    tx: Prisma.TransactionClient, tenantId: string, date: string, cache: Map<string, ParamsAtDate>,
  ): Promise<ParamsAtDate> {
    const hit = cache.get(date);
    if (hit) return hit;
    const keys = [...Object.keys(PRESENCE_PARAM_KEYS), 'temps.fuseau.defaut'];
    type ParamRow = { key: string; parameter_id: string | null; value: unknown; effective_from: string | null };
    const rows = await tx.$queryRaw<ParamRow[]>`
      SELECT k.key, p.parameter_id, p.value, p.effective_from::text
        FROM unnest(string_to_array(${keys.join(',')}, ',')) AS k(key)
        LEFT JOIN LATERAL compliance.parameter_value_at(k.key, 'BJ'::char(2), ${tenantId}::uuid, ${date}::date) p ON true`;
    const byKey = new Map<string, ParamRow>(rows.map((r) => [r.key, r]));
    const params: PresenceParams = { ...DEFAULT_PRESENCE_PARAMS };
    const paramsUsed: ParamsAtDate['paramsUsed'] = {};
    for (const [key, field] of Object.entries(PRESENCE_PARAM_KEYS)) {
      const row = byKey.get(key);
      const raw = row?.parameter_id ? row.value : undefined;
      const num = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : null;
      if (num !== null) {
        (params as unknown as Record<string, number | null>)[field] = num;
        paramsUsed[key] = { value: num, parameterId: row!.parameter_id, effectiveFrom: row!.effective_from, source: 'parametre' };
      } else {
        paramsUsed[key] = { value: DEFAULT_PRESENCE_PARAMS[field], parameterId: null, effectiveFrom: null, source: 'defaut' };
      }
    }
    const tzRow = byKey.get('temps.fuseau.defaut');
    const tzVal = tzRow?.parameter_id && typeof tzRow.value === 'string' ? tzRow.value : null;
    const out: ParamsAtDate = {
      params, paramsUsed,
      defaultTz: tzVal,
      defaultTzUsedEntry: tzVal !== null
        ? { value: tzVal, parameterId: tzRow!.parameter_id, effectiveFrom: tzRow!.effective_from, source: 'parametre' }
        : { value: 'UTC', parameterId: null, effectiveFrom: null, source: 'defaut' },
    };
    cache.set(date, out);
    return out;
  }

  // ==================================================================
  // Évaluation d'une journée + persistance versionnée
  // ==================================================================

  private async evaluateDay(
    tx: Prisma.TransactionClient, tenantId: string, ctx: EmployeeContextBundle, date: string,
    paramsCache: Map<string, ParamsAtDate>, siteTz: Map<string, string | null>,
  ): Promise<DayEvaluation> {
    const at = await this.paramsFor(tx, tenantId, date, paramsCache);
    const info = this.plannedFor(ctx, date);
    const siteZone: string | null = info.siteId !== null ? siteTz.get(info.siteId) ?? null : null;
    const tz: string = siteZone ?? at.defaultTz ?? 'UTC';
    const paramsUsed: Record<string, unknown> = { ...at.paramsUsed };
    if (siteZone === null) paramsUsed['temps.fuseau.defaut'] = at.defaultTzUsedEntry;
    try {
      const infoPrev = this.plannedFor(ctx, addDays(date, -1));
      const infoNext = this.plannedFor(ctx, addDays(date, 1));
      const events = this.attachEvents(ctx, date, infoPrev, info, infoNext, at.params);
      const input: ComputeDayInput = {
        planned: info.planned, holiday: info.holiday,
        employment: this.employmentAt(ctx, date),
        events, params: at.params,
        hasPendingUnmatched: ctx.pendingDates.has(date),
        corrections: {
          justifications: ctx.justifications.get(date) ?? [],
          appliedCount: ctx.correctionsCount.get(date) ?? 0,
        },
      };
      const computation = computeDay(input);
      // Événements du JOUR CIVIL hors de TOUTE fenêtre d'appariement (veille, jour,
      // lendemain) : jamais silencieusement perdus — anomalie datée, heure intacte.
      const wPrev = this.windowOf(infoPrev, at.params);
      const w = this.windowOf(info, at.params);
      const wNext = this.windowOf(infoNext, at.params);
      for (const evRow of ctx.eventRows) {
        if (evRow.local_date !== date || ctx.consumed.has(evRow.id)) continue;
        const rel = timeToMinute(evRow.local_time);
        const inAny = (rel >= w.from && rel <= w.to)
          || (rel + 1440 >= wPrev.from && rel + 1440 <= wPrev.to)
          || (rel - 1440 >= wNext.from && rel - 1440 <= wNext.to);
        if (!inAny) {
          ctx.consumed.add(evRow.id);
          computation.anomalies.push({
            code: 'punch_outside_schedule', severity: 'warning',
            detail: `pointage ${evRow.local_time.slice(0, 5)} hors de toute fenêtre d'appariement`,
            refs: { eventId: evRow.id },
          });
        }
      }
      return {
        computation, plannedInfo: info, paramsUsed, tz,
        firstInIso: computation.firstInMinute === null ? null : this.relToUtcIso(date, computation.firstInMinute, tz),
        lastOutIso: computation.lastOutMinute === null ? null : this.relToUtcIso(date, computation.lastOutMinute, tz),
        calcState: 'ok', calcNote: null,
      };
    } catch (e) {
      // Un jour en ERREUR n'en cache pas d'autres : résultat 'error' + anomalie.
      const note = (e as Error).message.split('\n')[0]!.slice(0, 490);
      return {
        computation: {
          status: 'unresolved', periods: [], firstInMinute: null, lastOutMinute: null,
          presenceMinutes: 0, workedMinutes: 0, breakMinutes: 0, lateMinutesRaw: 0, lateMinutes: 0,
          earlyDepartureMinutesRaw: 0, earlyDepartureMinutes: 0, absenceMinutes: 0, nightMinutes: 0,
          restDayMinutes: 0, holidayMinutes: 0, overtimeCandidateMinutes: 0, usedEventIds: [],
          anomalies: [{ code: 'calc_failed', severity: 'blocking', detail: note }],
          justifiedCategory: null, justifiedMinutes: 0, lateJustified: false, earlyJustified: false,
          correctionsApplied: ctx.correctionsCount.get(date) ?? 0,
        },
        plannedInfo: info, paramsUsed, tz,
        firstInIso: null, lastOutIso: null, calcState: 'error', calcNote: note,
      };
    }
  }

  private relToUtcIso(date: string, rel: number, tz: string): string | null {
    const shift = Math.floor(rel / 1440);
    const minute = rel - shift * 1440;
    const d = addDays(date, shift);
    const r = localToUtc(
      { y: Number(d.slice(0, 4)), mo: Number(d.slice(5, 7)), d: Number(d.slice(8, 10)) },
      { h: Math.floor(minute / 60), mi: minute % 60 }, tz,
    );
    return r.utcMs === null ? null : new Date(r.utcMs).toISOString();
  }

  /** Projection comparable du résultat À ÉCRIRE (mêmes clés que la ligne stockée). */
  private rowShape(ev: DayEvaluation): Record<string, unknown> {
    const c = ev.computation;
    const p = ev.plannedInfo;
    return {
      day_status: c.status,
      presence_minutes: c.presenceMinutes, worked_minutes: c.workedMinutes, break_minutes: c.breakMinutes,
      late_minutes_raw: c.lateMinutesRaw, late_minutes: c.lateMinutes,
      early_departure_minutes_raw: c.earlyDepartureMinutesRaw, early_departure_minutes: c.earlyDepartureMinutes,
      absence_minutes: c.absenceMinutes, night_minutes: c.nightMinutes,
      rest_day_minutes: c.restDayMinutes, holiday_minutes: c.holidayMinutes,
      overtime_candidate_minutes: c.overtimeCandidateMinutes,
      justified_category: c.justifiedCategory, justified_minutes: c.justifiedMinutes,
      late_justified: c.lateJustified, early_justified: c.earlyJustified,
      corrections_applied: c.correctionsApplied,
      first_in: ev.firstInIso, last_out: ev.lastOutIso,
      work_periods: c.periods, used_event_ids: c.usedEventIds,
      tz: ev.tz, schedule_model_code: p.modelCode, schedule_model_version: p.modelVersion,
      cycle_day_index: p.cycleDayIndex,
      planned_start_minute: p.planned?.startMinute ?? null, planned_end_minute: p.planned?.endMinute ?? null,
      planned_break_start_minute: p.planned?.breakStartMinute ?? null,
      planned_break_end_minute: p.planned?.breakEndMinute ?? null,
      planned_rest: p.planned?.isRest ?? false, holiday: p.holiday, exception_kind: p.exceptionKind,
      assignment_id: p.assignmentId, company_id: p.companyId, site_id: p.siteId, unit_id: p.unitId,
      params_used: ev.paramsUsed, engine_version: PRESENCE_ENGINE_VERSION,
      calc_state: ev.calcState, calc_note: ev.calcNote,
      anomalies: ev.computation.anomalies.map((a) => ({ code: a.code, severity: a.severity, detail: a.detail ?? null, refs: a.refs ?? {} })),
    };
  }

  private async readCurrent(
    tx: Prisma.TransactionClient, employeeId: string, date: string,
  ): Promise<Record<string, unknown> | null> {
    const rows = await tx.$queryRaw<Array<Record<string, unknown>>>`
      SELECT r.id, r.version, r.day_status, r.presence_minutes, r.worked_minutes, r.break_minutes,
             r.late_minutes_raw, r.late_minutes, r.early_departure_minutes_raw, r.early_departure_minutes,
             r.absence_minutes, r.night_minutes, r.rest_day_minutes, r.holiday_minutes,
             r.overtime_candidate_minutes,
             r.justified_category, r.justified_minutes, r.late_justified, r.early_justified, r.corrections_applied,
             to_char(r.first_in AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS first_in,
             to_char(r.last_out AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_out,
             r.work_periods, r.used_event_ids, r.tz, r.schedule_model_code, r.schedule_model_version,
             r.cycle_day_index, r.planned_start_minute, r.planned_end_minute,
             r.planned_break_start_minute, r.planned_break_end_minute, r.planned_rest, r.holiday,
             r.exception_kind, r.assignment_id, r.company_id, r.site_id, r.unit_id, r.params_used,
             r.engine_version, r.calc_state, r.calc_note,
             (SELECT coalesce(jsonb_agg(jsonb_build_object('code', a.code, 'severity', a.severity,
                     'detail', a.detail, 'refs', a.refs) ORDER BY a.code, a.detail), '[]'::jsonb)
                FROM time.day_anomalies a WHERE a.day_result_id = r.id) AS anomalies
        FROM time.day_results r
       WHERE r.employee_id = ${employeeId}::uuid AND r.work_date = ${date}::date AND r.is_current`;
    return rows[0] ?? null;
  }

  /** Champs qui CHANGERAIENT (null = strictement identique ⇒ aucune écriture). */
  private changedFields(
    current: Record<string, unknown> | null, next: Record<string, unknown>,
  ): string[] | null {
    if (current === null) return ['(première version)'];
    const changed: string[] = [];
    const nextAnoms = [...(next['anomalies'] as Array<Record<string, unknown>>)]
      .sort((a, b) => stableJson(a) < stableJson(b) ? -1 : 1);
    const curAnoms = [...((current['anomalies'] as Array<Record<string, unknown>>) ?? [])]
      .sort((a, b) => stableJson(a) < stableJson(b) ? -1 : 1);
    if (stableJson(nextAnoms) !== stableJson(curAnoms)) changed.push('anomalies');
    for (const [k, v] of Object.entries(next)) {
      if (k === 'anomalies') continue;
      const cur = current[k];
      const same = typeof v === 'object' && v !== null
        ? stableJson(v) === stableJson(cur)
        : (v ?? null) === (cur ?? null) || String(v ?? '') === String(cur ?? '');
      if (!same) changed.push(k);
    }
    return changed.length === 0 ? null : changed;
  }

  private async persistDay(
    tx: Prisma.TransactionClient, tenantId: string, runId: string, employeeId: string,
    date: string, ev: DayEvaluation,
  ): Promise<{ wrote: boolean }> {
    const next = this.rowShape(ev);
    const current = await this.readCurrent(tx, employeeId, date);
    if (this.changedFields(current, next) === null) return { wrote: false };
    let version = 1;
    if (current !== null) {
      version = Number(current['version']) + 1;
      // Bascule SEULE permise par le trigger : l'ancienne version reste, figée.
      await tx.$executeRaw`
        UPDATE time.day_results SET is_current = false WHERE id = ${current['id'] as string}::uuid AND is_current`;
    }
    const c = ev.computation;
    const p = ev.plannedInfo;
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO time.day_results
        (tenant_id, employee_id, work_date, version, is_current, calc_run_id, engine_version, tz,
         schedule_model_code, schedule_model_version, cycle_day_index,
         planned_start_minute, planned_end_minute, planned_break_start_minute, planned_break_end_minute,
         planned_rest, holiday, exception_kind, assignment_id, company_id, site_id, unit_id, params_used,
         first_in, last_out, work_periods, used_event_ids,
         presence_minutes, worked_minutes, break_minutes, late_minutes_raw, late_minutes,
         early_departure_minutes_raw, early_departure_minutes, absence_minutes, night_minutes,
         rest_day_minutes, holiday_minutes, overtime_candidate_minutes,
         justified_category, justified_minutes, late_justified, early_justified, corrections_applied,
         day_status, calc_state, calc_note)
      VALUES (${tenantId}::uuid, ${employeeId}::uuid, ${date}::date, ${version}, true, ${runId}::uuid,
              ${PRESENCE_ENGINE_VERSION}, ${ev.tz}, ${p.modelCode}, ${p.modelVersion}, ${p.cycleDayIndex},
              ${p.planned?.startMinute ?? null}, ${p.planned?.endMinute ?? null},
              ${p.planned?.breakStartMinute ?? null}, ${p.planned?.breakEndMinute ?? null},
              ${p.planned?.isRest ?? false}, ${p.holiday}, ${p.exceptionKind},
              ${p.assignmentId}::uuid, ${p.companyId}::uuid, ${p.siteId}::uuid, ${p.unitId}::uuid,
              ${JSON.stringify(ev.paramsUsed)}::jsonb,
              ${ev.firstInIso}::timestamptz, ${ev.lastOutIso}::timestamptz,
              ${JSON.stringify(c.periods)}::jsonb, ${JSON.stringify(c.usedEventIds)}::jsonb,
              ${c.presenceMinutes}, ${c.workedMinutes}, ${c.breakMinutes}, ${c.lateMinutesRaw}, ${c.lateMinutes},
              ${c.earlyDepartureMinutesRaw}, ${c.earlyDepartureMinutes}, ${c.absenceMinutes}, ${c.nightMinutes},
              ${c.restDayMinutes}, ${c.holidayMinutes}, ${c.overtimeCandidateMinutes},
              ${c.justifiedCategory}, ${c.justifiedMinutes}, ${c.lateJustified}, ${c.earlyJustified}, ${c.correctionsApplied},
              ${c.status}, ${ev.calcState}, ${ev.calcNote})
      RETURNING id`;
    const resultId = rows[0]!.id;
    for (const a of c.anomalies) {
      await tx.$executeRaw`
        INSERT INTO time.day_anomalies (tenant_id, day_result_id, employee_id, work_date, code, severity, refs, detail)
        VALUES (${tenantId}::uuid, ${resultId}::uuid, ${employeeId}::uuid, ${date}::date,
                ${a.code}, ${a.severity}, ${JSON.stringify(a.refs ?? {})}::jsonb, ${a.detail ?? null})`;
    }
    return { wrote: true };
  }

  private async readRun(tx: Prisma.TransactionClient, id: string): Promise<Record<string, unknown> | null> {
    const rows = await tx.$queryRaw<Array<Record<string, unknown>>>`
      SELECT id, period_start::text AS "periodStart", period_end::text AS "periodEnd",
             scope_kind AS "scopeKind", scope_company_id AS "scopeCompanyId", scope_site_id AS "scopeSiteId",
             scope_unit_id AS "scopeUnitId", scope_employee_id AS "scopeEmployeeId",
             reason, is_recalc AS "isRecalc", engine_version AS "engineVersion", status,
             started_at AS "startedAt", finished_at AS "finishedAt",
             employees_count AS "employeesCount", days_count AS "daysCount",
             results_written AS "resultsWritten", results_unchanged AS "resultsUnchanged",
             results_error AS "resultsError", anomalies_count AS "anomaliesCount",
             duration_ms AS "durationMs", error_note AS "errorNote", created_by AS "createdBy"
        FROM time.calc_runs WHERE id = ${id}::uuid`;
    return rows[0] ?? null;
  }

  // ==================================================================
  // Consultations : exécutions
  // ==================================================================

  async listRuns(
    tenantId: string, actor: string, opts: { limit?: number; offset?: number },
  ): Promise<TimeOutcome<{ items: unknown[] }>> {
    const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
    const offset = Math.max(opts.offset ?? 0, 0);
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'time.calc_view', 'time.calc_run', 'time.calc_recalc'))) {
        return { kind: 'forbidden', reason: 'permission requise : time.calc_view' };
      }
      const items = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT id, period_start::text AS "periodStart", period_end::text AS "periodEnd",
               scope_kind AS "scopeKind", reason, is_recalc AS "isRecalc", engine_version AS "engineVersion",
               status, started_at AS "startedAt", finished_at AS "finishedAt",
               employees_count AS "employeesCount", days_count AS "daysCount",
               results_written AS "resultsWritten", results_unchanged AS "resultsUnchanged",
               results_error AS "resultsError", anomalies_count AS "anomaliesCount", duration_ms AS "durationMs"
          FROM time.calc_runs ORDER BY started_at DESC LIMIT ${limit} OFFSET ${offset}`;
      return { kind: 'ok', items };
    });
  }

  async getRun(tenantId: string, actor: string, id: string): Promise<TimeOutcome<{ run: unknown }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'time.calc_view', 'time.calc_run', 'time.calc_recalc'))) {
        return { kind: 'forbidden', reason: 'permission requise : time.calc_view' };
      }
      const run = await this.readRun(tx, id);
      if (!run) return { kind: 'not_found' };
      return { kind: 'ok', run };
    });
  }

  // ==================================================================
  // Consultations : résultats (self, registre, calendrier, détail, versions)
  // ==================================================================

  private async linkedEmployee(tx: Prisma.TransactionClient, actor: string): Promise<string | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM core.employees WHERE user_id = ${actor}::uuid AND deleted_at IS NULL`;
    return rows[0]?.id ?? null;
  }

  /** Le salarié est-il DANS la portée de l'acteur à la date ? (affectation principale) */
  private async scopeCovers(
    tx: Prisma.TransactionClient, set: { kind: string; companies: string[]; sites: string[]; units: string[] },
    employeeId: string, date: string,
  ): Promise<boolean> {
    if (set.kind === 'all') return true;
    if (set.kind !== 'scoped') return false;
    const csv = scopeCsv(set as Parameters<typeof scopeCsv>[0]);
    const rows = await tx.$queryRaw<Array<{ ok: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM core.employee_assignments a
                      WHERE a.employee_id = ${employeeId}::uuid AND a.is_primary
                        AND daterange(a.effective_from, a.effective_to, '[)') @> ${date}::date
                        AND (a.company_id = ANY(string_to_array(${csv.companies}, ',')::uuid[])
                          OR a.site_id    = ANY(string_to_array(${csv.sites}, ',')::uuid[])
                          OR a.unit_id    = ANY(string_to_array(${csv.units}, ',')::uuid[]))) AS ok`;
    return rows[0]?.ok === true;
  }

  private readonly RESULT_COLUMNS = `
    r.id, r.employee_id AS "employeeId", r.work_date::text AS "workDate", r.version,
    r.day_status AS "dayStatus", r.calc_state AS "calcState", r.calc_note AS "calcNote",
    r.tz, r.schedule_model_code AS "scheduleModelCode", r.schedule_model_version AS "scheduleModelVersion",
    r.cycle_day_index AS "cycleDayIndex",
    r.planned_start_minute AS "plannedStartMinute", r.planned_end_minute AS "plannedEndMinute",
    r.planned_break_start_minute AS "plannedBreakStartMinute", r.planned_break_end_minute AS "plannedBreakEndMinute",
    r.planned_rest AS "plannedRest", r.holiday, r.exception_kind AS "exceptionKind",
    r.first_in AS "firstIn", r.last_out AS "lastOut", r.work_periods AS "workPeriods",
    r.presence_minutes AS "presenceMinutes", r.worked_minutes AS "workedMinutes",
    r.break_minutes AS "breakMinutes", r.late_minutes_raw AS "lateMinutesRaw", r.late_minutes AS "lateMinutes",
    r.early_departure_minutes_raw AS "earlyDepartureMinutesRaw", r.early_departure_minutes AS "earlyDepartureMinutes",
    r.absence_minutes AS "absenceMinutes", r.night_minutes AS "nightMinutes",
    r.rest_day_minutes AS "restDayMinutes", r.holiday_minutes AS "holidayMinutes",
    r.overtime_candidate_minutes AS "overtimeCandidateMinutes", r.engine_version AS "engineVersion",
    r.justified_category AS "justifiedCategory", r.justified_minutes AS "justifiedMinutes",
    r.late_justified AS "lateJustified", r.early_justified AS "earlyJustified",
    r.corrections_applied AS "correctionsApplied",
    (SELECT count(*)::int FROM time.day_anomalies an WHERE an.day_result_id = r.id AND an.state = 'open') AS "openAnomalies"`;

  async myResults(
    tenantId: string, actor: string, opts: { from?: string; to?: string },
  ): Promise<TimeOutcome<{ linked: boolean; items: unknown[] }>> {
    for (const d of [opts.from, opts.to]) if (d !== undefined && !DATE_RE.test(d)) return { kind: 'invalid', reason: 'from/to : AAAA-MM-JJ' };
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'time.results_view_own'))) {
        return { kind: 'forbidden', reason: 'permission requise : time.results_view_own' };
      }
      const me = await this.linkedEmployee(tx, actor);
      if (me === null) return { kind: 'ok', linked: false, items: [] };
      const items = await tx.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT ${Prisma.raw(this.RESULT_COLUMNS)}
          FROM time.day_results r
         WHERE r.employee_id = ${me}::uuid AND r.is_current
           AND (${opts.from ?? null}::date IS NULL OR r.work_date >= ${opts.from ?? null}::date)
           AND (${opts.to ?? null}::date IS NULL OR r.work_date <= ${opts.to ?? null}::date)
         ORDER BY r.work_date DESC LIMIT 120`);
      return { kind: 'ok', linked: true, items };
    });
  }

  /** Registre QUOTIDIEN : résultats courants d'une date, portée réelle. */
  async listResults(
    tenantId: string, actor: string,
    opts: { date: string; status?: string; siteId?: string; unitId?: string; limit?: number; offset?: number },
  ): Promise<TimeOutcome<{ items: unknown[] }>> {
    if (!DATE_RE.test(opts.date)) return { kind: 'invalid', reason: 'date : AAAA-MM-JJ' };
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const set = await scopeSetFor(tx, actor, 'time.results_view');
      if (set.kind === 'none') return { kind: 'forbidden', reason: 'permission requise : time.results_view (avec une portée)' };
      const scoped = set.kind === 'scoped';
      const csv = scopeCsv(set);
      const items = await tx.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT ${Prisma.raw(this.RESULT_COLUMNS)},
               e.matricule, e.first_name AS "firstName", e.last_name AS "lastName",
               s.code AS "siteCode", u.code AS "unitCode"
          FROM time.day_results r
          JOIN core.employees e ON e.id = r.employee_id
          LEFT JOIN org.sites s ON s.id = r.site_id
          LEFT JOIN org.units u ON u.id = r.unit_id
         WHERE r.is_current AND r.work_date = ${opts.date}::date
           AND (${opts.status ?? null}::text IS NULL OR r.day_status = ${opts.status ?? null})
           AND (${opts.siteId ?? null}::uuid IS NULL OR r.site_id = ${opts.siteId ?? null}::uuid)
           AND (${opts.unitId ?? null}::uuid IS NULL OR r.unit_id = ${opts.unitId ?? null}::uuid)
           AND (${!scoped} OR r.company_id = ANY(string_to_array(${csv.companies}, ',')::uuid[])
             OR r.site_id = ANY(string_to_array(${csv.sites}, ',')::uuid[])
             OR r.unit_id = ANY(string_to_array(${csv.units}, ',')::uuid[]))
         ORDER BY e.matricule LIMIT ${limit} OFFSET ${offset}`);
      return { kind: 'ok', items };
    });
  }

  /** Calendrier d'UN salarié (self autorisé via results_view_own ; sinon portée). */
  async employeeResults(
    tenantId: string, actor: string, employeeId: string, opts: { from: string; to: string },
  ): Promise<TimeOutcome<{ items: unknown[]; self: boolean }>> {
    if (!DATE_RE.test(opts.from) || !DATE_RE.test(opts.to)) return { kind: 'invalid', reason: 'from/to : AAAA-MM-JJ' };
    if (daysBetween(opts.from, opts.to) + 1 > MAX_PERIOD_DAYS) return { kind: 'invalid', reason: `période bornée à ${MAX_PERIOD_DAYS} jours` };
    return this.prisma.withTenant(tenantId, async (tx) => {
      const me = await this.linkedEmployee(tx, actor);
      const self = me !== null && me === employeeId;
      if (self) {
        if (!(await holdsPermission(tx, actor, 'time.results_view_own', 'time.results_view'))) {
          return { kind: 'forbidden', reason: 'permission requise : time.results_view_own' };
        }
      } else {
        const set = await scopeSetFor(tx, actor, 'time.results_view');
        if (set.kind === 'none') return { kind: 'forbidden', reason: 'permission requise : time.results_view (avec une portée)' };
        if (!(await this.scopeCovers(tx, set, employeeId, opts.to))
          && !(await this.scopeCovers(tx, set, employeeId, opts.from))) {
          return { kind: 'not_found' };
        }
        // Consultation SENSIBLE (dossier temps d'un tiers) : auditée.
        await auditAuth(tx, tenantId, {
          action: 'time_results_consulted', actorUserId: actor, module: 'time',
          recordType: 'employee', recordId: employeeId,
          newValue: { from: opts.from, to: opts.to }, result: 'success',
        });
      }
      const items = await tx.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT ${Prisma.raw(this.RESULT_COLUMNS)}
          FROM time.day_results r
         WHERE r.employee_id = ${employeeId}::uuid AND r.is_current
           AND r.work_date BETWEEN ${opts.from}::date AND ${opts.to}::date
         ORDER BY r.work_date`);
      return { kind: 'ok', items, self };
    });
  }

  /** Détail d'une JOURNÉE : résultat courant, anomalies, chronologie, versions. */
  async dayDetail(
    tenantId: string, actor: string, employeeId: string, date: string,
  ): Promise<TimeOutcome<{ result: unknown; anomalies: unknown[]; events: unknown[]; versionCount: number; self: boolean }>> {
    if (!DATE_RE.test(date)) return { kind: 'invalid', reason: 'date : AAAA-MM-JJ' };
    return this.prisma.withTenant(tenantId, async (tx) => {
      const me = await this.linkedEmployee(tx, actor);
      const self = me !== null && me === employeeId;
      if (self) {
        if (!(await holdsPermission(tx, actor, 'time.results_view_own', 'time.results_view'))) {
          return { kind: 'forbidden', reason: 'permission requise : time.results_view_own' };
        }
      } else {
        const set = await scopeSetFor(tx, actor, 'time.results_view');
        if (set.kind === 'none') return { kind: 'forbidden', reason: 'permission requise : time.results_view (avec une portée)' };
        if (!(await this.scopeCovers(tx, set, employeeId, date))) return { kind: 'not_found' };
        await auditAuth(tx, tenantId, {
          action: 'time_results_day_consulted', actorUserId: actor, module: 'time',
          recordType: 'employee', recordId: employeeId, newValue: { date }, result: 'success',
        });
      }
      const rows = await tx.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT ${Prisma.raw(this.RESULT_COLUMNS)}, r.params_used AS "paramsUsed", r.used_event_ids AS "usedEventIds",
               r.calc_run_id AS "calcRunId", r.computed_at AS "computedAt"
          FROM time.day_results r
         WHERE r.employee_id = ${employeeId}::uuid AND r.work_date = ${date}::date AND r.is_current`);
      const result = rows[0];
      if (!result) return { kind: 'not_found' };
      const anomalies = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT a.id, a.code, a.severity, a.detail, a.refs, a.state, a.state_note AS "stateNote",
               a.state_at AS "stateAt", a.created_at AS "createdAt",
               a.assigned_to AS "assignedTo", a.due_at AS "dueAt",
               a.resolution_kind AS "resolutionKind", a.resolution_event_id AS "resolutionEventId"
          FROM time.day_anomalies a WHERE a.day_result_id = ${result['id'] as string}::uuid
         ORDER BY CASE a.severity WHEN 'blocking' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, a.code`;
      const events = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT ev.id, ev.local_date::text AS "localDate", ev.local_time::text AS "localTime",
               ev.event_type AS "eventType", ev.tz, ev.occurred_at AS "occurredAt",
               s.code AS "siteCode", d.code AS "deviceCode"
          FROM time.punch_events ev
          LEFT JOIN org.sites s ON s.id = ev.site_id
          LEFT JOIN time.devices d ON d.id = ev.device_id
         WHERE ev.employee_id = ${employeeId}::uuid AND ev.match_status = 'matched'
           AND ev.local_date BETWEEN ${addDays(date, -1)}::date AND ${addDays(date, 1)}::date
         ORDER BY ev.local_date, ev.local_time, ev.id`;
      const count = await tx.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM time.day_results
         WHERE employee_id = ${employeeId}::uuid AND work_date = ${date}::date`;
      return { kind: 'ok', result, anomalies, events, versionCount: count[0]?.n ?? 1, self };
    });
  }

  /** HISTORIQUE complet des versions d'une journée (recalculs motivés, comparables). */
  async history(
    tenantId: string, actor: string, employeeId: string, date: string,
  ): Promise<TimeOutcome<{ versions: unknown[] }>> {
    if (!DATE_RE.test(date)) return { kind: 'invalid', reason: 'date : AAAA-MM-JJ' };
    return this.prisma.withTenant(tenantId, async (tx) => {
      const me = await this.linkedEmployee(tx, actor);
      const self = me !== null && me === employeeId;
      if (!self) {
        const set = await scopeSetFor(tx, actor, 'time.results_view');
        if (set.kind === 'none') return { kind: 'forbidden', reason: 'permission requise : time.results_view (avec une portée)' };
        if (!(await this.scopeCovers(tx, set, employeeId, date))) return { kind: 'not_found' };
      } else if (!(await holdsPermission(tx, actor, 'time.results_view_own', 'time.results_view'))) {
        return { kind: 'forbidden', reason: 'permission requise : time.results_view_own' };
      }
      const versions = await tx.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT ${Prisma.raw(this.RESULT_COLUMNS)}, r.is_current AS "isCurrent", r.computed_at AS "computedAt",
               r.params_used AS "paramsUsed",
               cr.reason AS "runReason", cr.is_recalc AS "runIsRecalc", cr.started_at AS "runStartedAt",
               (SELECT count(*)::int FROM time.day_anomalies an WHERE an.day_result_id = r.id) AS "anomalyCount"
          FROM time.day_results r JOIN time.calc_runs cr ON cr.id = r.calc_run_id
         WHERE r.employee_id = ${employeeId}::uuid AND r.work_date = ${date}::date
         ORDER BY r.version`);
      if (versions.length === 0) return { kind: 'not_found' };
      return { kind: 'ok', versions };
    });
  }

  /** COMPARAISON de deux versions : champs changés, valeurs côte à côte. */
  async compare(
    tenantId: string, actor: string, employeeId: string, date: string, v1: number, v2: number,
  ): Promise<TimeOutcome<{ fields: unknown[]; a: unknown; b: unknown }>> {
    const hist = await this.history(tenantId, actor, employeeId, date);
    if (hist.kind !== 'ok') return hist;
    const versions = hist.versions as Array<Record<string, unknown>>;
    const a = versions.find((v) => Number(v['version']) === v1);
    const b = versions.find((v) => Number(v['version']) === v2);
    if (!a || !b) return { kind: 'not_found' };
    const fields: unknown[] = [];
    const keys: string[] = [
      'dayStatus', 'presenceMinutes', 'workedMinutes', 'breakMinutes', 'lateMinutesRaw', 'lateMinutes',
      'earlyDepartureMinutesRaw', 'earlyDepartureMinutes', 'absenceMinutes', 'nightMinutes',
      'restDayMinutes', 'holidayMinutes', 'overtimeCandidateMinutes', 'firstIn', 'lastOut',
      'workPeriods', 'plannedStartMinute', 'plannedEndMinute', 'plannedRest', 'holiday',
      'scheduleModelCode', 'scheduleModelVersion', 'tz', 'engineVersion', 'paramsUsed', 'anomalyCount', 'calcState',
    ];
    for (const k of keys) {
      const va = a[k]; const vb = b[k];
      const same = typeof va === 'object' || typeof vb === 'object'
        ? stableJson(va ?? null) === stableJson(vb ?? null)
        : String(va ?? '') === String(vb ?? '');
      if (!same) fields.push({ field: k, a: va ?? null, b: vb ?? null });
    }
    return {
      kind: 'ok', fields,
      a: { version: v1, runReason: a['runReason'], runIsRecalc: a['runIsRecalc'], computedAt: a['computedAt'] },
      b: { version: v2, runReason: b['runReason'], runIsRecalc: b['runIsRecalc'], computedAt: b['computedAt'] },
    };
  }

  // ==================================================================
  // Agrégats — RETRAÇABLES : mêmes lignes day_results que les écrans (non-paie).
  // ==================================================================

  async aggregates(
    tenantId: string, actor: string,
    opts: { from: string; to: string; siteId?: string; unitId?: string; employeeId?: string },
  ): Promise<TimeOutcome<{ perEmployee: unknown[]; totals: Record<string, number> }>> {
    if (!DATE_RE.test(opts.from) || !DATE_RE.test(opts.to)) return { kind: 'invalid', reason: 'from/to : AAAA-MM-JJ' };
    if (daysBetween(opts.from, opts.to) + 1 > MAX_PERIOD_DAYS) return { kind: 'invalid', reason: `période bornée à ${MAX_PERIOD_DAYS} jours` };
    return this.prisma.withTenant(tenantId, async (tx) => {
      const set = await scopeSetFor(tx, actor, 'time.results_view');
      if (set.kind === 'none') return { kind: 'forbidden', reason: 'permission requise : time.results_view (avec une portée)' };
      const scoped = set.kind === 'scoped';
      const csv = scopeCsv(set);
      const perEmployee = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT r.employee_id AS "employeeId", e.matricule, e.first_name AS "firstName", e.last_name AS "lastName",
               count(*)::int AS "daysTotal",
               count(*) FILTER (WHERE r.planned_start_minute IS NOT NULL AND NOT r.planned_rest AND NOT r.holiday
                 AND r.day_status NOT IN ('not_employed', 'suspended'))::int AS "expectedDays",
               count(*) FILTER (WHERE r.worked_minutes > 0)::int AS "presentDays",
               count(*) FILTER (WHERE r.day_status = 'absent')::int AS "absentDays",
               count(*) FILTER (WHERE r.day_status = 'unresolved')::int AS "unresolvedDays",
               count(*) FILTER (WHERE r.late_minutes > 0)::int AS "lateCount",
               coalesce(sum(r.late_minutes), 0)::int AS "lateMinutes",
               count(*) FILTER (WHERE r.early_departure_minutes > 0)::int AS "earlyCount",
               coalesce(sum(r.early_departure_minutes), 0)::int AS "earlyDepartureMinutes",
               coalesce(sum(r.worked_minutes), 0)::int AS "workedMinutes",
               coalesce(sum(r.night_minutes), 0)::int AS "nightMinutes",
               coalesce(sum(r.rest_day_minutes), 0)::int AS "restDayMinutes",
               coalesce(sum(r.holiday_minutes), 0)::int AS "holidayMinutes",
               coalesce(sum(r.overtime_candidate_minutes), 0)::int AS "overtimeCandidateMinutes",
               (SELECT count(*)::int FROM time.day_anomalies an
                 JOIN time.day_results dr ON dr.id = an.day_result_id
                WHERE an.employee_id = r.employee_id AND dr.is_current AND an.state = 'open'
                  AND an.work_date BETWEEN ${opts.from}::date AND ${opts.to}::date) AS "openAnomalies"
          FROM time.day_results r JOIN core.employees e ON e.id = r.employee_id
         WHERE r.is_current AND r.work_date BETWEEN ${opts.from}::date AND ${opts.to}::date
           AND (${opts.siteId ?? null}::uuid IS NULL OR r.site_id = ${opts.siteId ?? null}::uuid)
           AND (${opts.unitId ?? null}::uuid IS NULL OR r.unit_id = ${opts.unitId ?? null}::uuid)
           AND (${opts.employeeId ?? null}::uuid IS NULL OR r.employee_id = ${opts.employeeId ?? null}::uuid)
           AND (${!scoped} OR r.company_id = ANY(string_to_array(${csv.companies}, ',')::uuid[])
             OR r.site_id = ANY(string_to_array(${csv.sites}, ',')::uuid[])
             OR r.unit_id = ANY(string_to_array(${csv.units}, ',')::uuid[]))
         GROUP BY r.employee_id, e.matricule, e.first_name, e.last_name
         ORDER BY e.matricule`;
      const totals: Record<string, number> = {};
      for (const row of perEmployee) {
        for (const [k, v] of Object.entries(row)) {
          if (typeof v === 'number') totals[k] = (totals[k] ?? 0) + v;
        }
      }
      delete totals['employeeId'];
      return { kind: 'ok', perEmployee, totals };
    });
  }

  // ==================================================================
  // Anomalies : file, changement d'état contrôlé (resolved = E10.3).
  // ==================================================================

  async listAnomalies(
    tenantId: string, actor: string,
    opts: { state?: string; severity?: string; code?: string; from?: string; to?: string; limit?: number; offset?: number },
  ): Promise<TimeOutcome<{ items: unknown[] }>> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);
    for (const d of [opts.from, opts.to]) if (d !== undefined && !DATE_RE.test(d)) return { kind: 'invalid', reason: 'from/to : AAAA-MM-JJ' };
    return this.prisma.withTenant(tenantId, async (tx) => {
      const set = await scopeSetFor(tx, actor, 'time.anomalies_view');
      const alt = set.kind !== 'none' ? set : await scopeSetFor(tx, actor, 'time.anomalies_manage');
      if (alt.kind === 'none') return { kind: 'forbidden', reason: 'permission requise : time.anomalies_view (avec une portée)' };
      const scoped = alt.kind === 'scoped';
      const csv = scopeCsv(alt);
      // Seules les anomalies de la version COURANTE comptent (les remplacées restent
      // consultables via l'historique de la journée).
      const items = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT a.id, a.code, a.severity, a.detail, a.refs, a.state, a.state_note AS "stateNote",
               a.state_at AS "stateAt", a.work_date::text AS "workDate", a.created_at AS "createdAt",
               a.assigned_to AS "assignedTo", a.due_at AS "dueAt",
               a.resolution_kind AS "resolutionKind", a.resolution_event_id AS "resolutionEventId",
               a.employee_id AS "employeeId", e.matricule, e.first_name AS "firstName", e.last_name AS "lastName",
               r.day_status AS "dayStatus", r.site_id AS "siteId", r.unit_id AS "unitId"
          FROM time.day_anomalies a
          JOIN time.day_results r ON r.id = a.day_result_id AND r.is_current
          JOIN core.employees e ON e.id = a.employee_id
         WHERE (${opts.state ?? null}::text IS NULL OR a.state = ${opts.state ?? null})
           AND (${opts.severity ?? null}::text IS NULL OR a.severity = ${opts.severity ?? null})
           AND (${opts.code ?? null}::text IS NULL OR a.code = ${opts.code ?? null})
           AND (${opts.from ?? null}::date IS NULL OR a.work_date >= ${opts.from ?? null}::date)
           AND (${opts.to ?? null}::date IS NULL OR a.work_date <= ${opts.to ?? null}::date)
           AND (${!scoped} OR r.company_id = ANY(string_to_array(${csv.companies}, ',')::uuid[])
             OR r.site_id = ANY(string_to_array(${csv.sites}, ',')::uuid[])
             OR r.unit_id = ANY(string_to_array(${csv.units}, ',')::uuid[]))
         ORDER BY CASE a.severity WHEN 'blocking' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
                  a.work_date DESC, a.created_at
         LIMIT ${limit} OFFSET ${offset}`;
      return { kind: 'ok', items };
    });
  }

  async setAnomalyState(
    tenantId: string, actor: string, anomalyId: string,
    input: { state: string; note?: string; resolutionKind?: string },
  ): Promise<TimeOutcome<Record<never, never>>> {
    if (input.state === 'resolved' && input.resolutionKind !== 'classified') {
      return {
        kind: 'conflict',
        reason: '« resolved » exige une référence probante : correction appliquée (résolution automatique) ou CLASSEMENT motivé (resolutionKind=classified + note) — jamais un simple clic',
      };
    }
    if (input.state === 'resolved' && (input.note === undefined || input.note.length === 0)) {
      return { kind: 'invalid', reason: 'classement : note motivée OBLIGATOIRE' };
    }
    if (!['open', 'acknowledged', 'dismissed', 'resolved'].includes(input.state)) {
      return { kind: 'invalid', reason: 'state : open, acknowledged, dismissed ou resolved (classement motivé)' };
    }
    if (input.note !== undefined && input.note.length > 300) return { kind: 'invalid', reason: 'note : 300 caractères max' };
    return this.prisma.withTenant(tenantId, async (tx) => {
      const set = await scopeSetFor(tx, actor, 'time.anomalies_manage');
      if (set.kind === 'none') return { kind: 'forbidden', reason: 'permission requise : time.anomalies_manage (avec une portée)' };
      const rows = await tx.$queryRaw<Array<{ id: string; state: string; employee_id: string; work_date: string; is_current: boolean }>>`
        SELECT a.id, a.state, a.employee_id, a.work_date::text, r.is_current
          FROM time.day_anomalies a JOIN time.day_results r ON r.id = a.day_result_id
         WHERE a.id = ${anomalyId}::uuid`;
      const anom = rows[0];
      if (!anom) return { kind: 'not_found' };
      if (!anom.is_current) return { kind: 'conflict', reason: 'anomalie d\'une version REMPLACÉE — agir sur la version courante' };
      if (set.kind === 'scoped' && !(await this.scopeCovers(tx, set, anom.employee_id, anom.work_date))) {
        return { kind: 'not_found' };
      }
      try {
        if (input.state === 'resolved') {
          // CLASSEMENT motivé sans correction : décision explicite, note obligatoire —
          // la référence probante est portée par resolution_kind (trigger).
          await tx.$executeRaw`
            UPDATE time.day_anomalies
               SET state = 'resolved', resolution_kind = 'classified', resolution_event_id = NULL,
                   state_note = ${input.note!}, state_by = ${actor}::uuid, state_at = now()
             WHERE id = ${anomalyId}::uuid`;
        } else {
          // Quitter « resolved » (réouverture contrôlée) PURGE la référence de résolution.
          await tx.$executeRaw`
            UPDATE time.day_anomalies
               SET state = ${input.state}, state_note = ${input.note ?? null},
                   resolution_kind = NULL, resolution_event_id = NULL,
                   state_by = ${actor}::uuid, state_at = now()
             WHERE id = ${anomalyId}::uuid`;
        }
      } catch (e) {
        // Le TRIGGER porte la machine à états — son message est la vérité.
        return { kind: 'conflict', reason: (e as Error).message.split('\n')[0] ?? 'transition interdite' };
      }
      await auditAuth(tx, tenantId, {
        action: 'time_anomaly_state_changed', actorUserId: actor, module: 'time',
        recordType: 'day_anomaly', recordId: anomalyId,
        oldValue: { state: anom.state },
        newValue: { state: input.state, note: input.note ?? null, resolutionKind: input.state === 'resolved' ? 'classified' : null },
        result: 'success',
      });
      return { kind: 'ok' };
    });
  }

  /** Affectation d'une anomalie à un gestionnaire + échéance de traitement. */
  async assignAnomaly(
    tenantId: string, actor: string, anomalyId: string,
    input: { userId?: string | null; dueAt?: string | null },
  ): Promise<TimeOutcome<Record<never, never>>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const set = await scopeSetFor(tx, actor, 'time.anomalies_manage');
      if (set.kind === 'none') return { kind: 'forbidden', reason: 'permission requise : time.anomalies_manage (avec une portée)' };
      const rows = await tx.$queryRaw<Array<{ employee_id: string; work_date: string }>>`
        SELECT employee_id, work_date::text FROM time.day_anomalies WHERE id = ${anomalyId}::uuid`;
      const anom = rows[0];
      if (!anom) return { kind: 'not_found' };
      if (set.kind === 'scoped' && !(await this.scopeCovers(tx, set, anom.employee_id, anom.work_date))) {
        return { kind: 'not_found' };
      }
      await tx.$executeRaw`
        UPDATE time.day_anomalies
           SET assigned_to = ${input.userId ?? null}::uuid, due_at = ${input.dueAt ?? null}::timestamptz
         WHERE id = ${anomalyId}::uuid`;
      await auditAuth(tx, tenantId, {
        action: 'time_anomaly_assigned', actorUserId: actor, module: 'time',
        recordType: 'day_anomaly', recordId: anomalyId,
        newValue: { userId: input.userId ?? null, dueAt: input.dueAt ?? null }, result: 'success',
      });
      return { kind: 'ok' };
    });
  }
}
