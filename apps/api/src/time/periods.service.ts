/**
 * E10.3 — Périodes de présence, pré-clôture, CLÔTURE versionnée avec EMPREINTE,
 * réouverture contrôlée (circuit E3 si configuré), variables temps préparatoires
 * paie et exports immuables (CSV/JSON, schéma versionné, révisions explicites).
 *
 * Garanties : une seule période active compatible par périmètre (exclusion PG) ;
 * la clôture fige les résultats RETENUS ligne à ligne + totaux + empreinte
 * sha256 reproductible ; double clôture concurrente impossible (verrou de ligne
 * + UNIQUE close_no) ; une réouverture n'efface JAMAIS (révision de période,
 * clôture précédente « superseded ») ; un export remplacé est MARQUÉ, son
 * contenu reste ; AUCUN taux, AUCUN montant — variables temps uniquement.
 */
import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { auditAuth } from '../auth/audit.util';
import { NotificationService } from '../notify/notification.service';
import { WorkflowService } from '../workflow/workflow.service';
import { PRESENCE_ENGINE_VERSION } from '../../../../packages/core/src/presence.ts';
import { DATE_RE, holdsPermission, type TimeOutcome } from './time-access';

const EXPORT_SCHEMA = 'kora-paie-prep-1';
/** Contrôles BLOQUANTS par défaut — remplaçables par le paramètre E4
 * « temps.precloture.bloquants » (tableau JSON de clés), résolu à la date de fin
 * de période : aucune règle en dur, une valeur OPÉRATIONNELLE par défaut. */
const DEFAULT_BLOCKING = [
  'missing_employees', 'blocking_anomalies', 'pending_requests',
  'approved_unapplied', 'failed_days', 'stale_after_correction',
];

interface PeriodRow {
  id: string; scope_kind: string; company_id: string | null; site_id: string | null;
  label: string; period_start: string; period_end: string; status: string; revision: number;
}

@Injectable()
export class PeriodsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notify: NotificationService,
    private readonly wf: WorkflowService,
  ) {
    // Pont E3 → réouverture : si un circuit « temps_reouverture » est configuré,
    // la réouverture n'a d'effet qu'à l'approbation — dans la même transaction.
    this.wf.registerSubjectHandler('time_period_reopen', async (tx, tenantId, subjectId, status) => {
      if (status === 'approved') await this.performReopenTx(tx, tenantId, subjectId, null, 'circuit approuvé');
    });
  }

  // ==================================================================
  // Périodes
  // ==================================================================

  async create(
    tenantId: string, actor: string,
    input: { scopeKind: string; companyId?: string; siteId?: string; label: string; periodStart: string; periodEnd: string },
  ): Promise<TimeOutcome<{ id: string }>> {
    if (!['tenant', 'company', 'site'].includes(input.scopeKind)) return { kind: 'invalid', reason: 'scopeKind : tenant, company ou site' };
    if (!DATE_RE.test(input.periodStart) || !DATE_RE.test(input.periodEnd)) return { kind: 'invalid', reason: 'periodStart/periodEnd : AAAA-MM-JJ' };
    if (input.periodEnd < input.periodStart) return { kind: 'invalid', reason: 'periodEnd avant periodStart' };
    if (input.label.length < 1 || input.label.length > 100) return { kind: 'invalid', reason: 'label : 1 à 100 caractères' };
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'time.period_manage'))) {
        return { kind: 'forbidden', reason: 'permission requise : time.period_manage' };
      }
      try {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO time.periods (tenant_id, scope_kind, company_id, site_id, label, period_start, period_end, created_by)
          VALUES (${tenantId}::uuid, ${input.scopeKind},
                  ${input.scopeKind === 'company' ? input.companyId : null}::uuid,
                  ${input.scopeKind === 'site' ? input.siteId : null}::uuid,
                  ${input.label}, ${input.periodStart}::date, ${input.periodEnd}::date, ${actor}::uuid)
          RETURNING id`;
        await auditAuth(tx, tenantId, {
          action: 'time_period_created', actorUserId: actor, module: 'time',
          recordType: 'period', recordId: rows[0]!.id, newValue: input, result: 'success',
        });
        return { kind: 'ok', id: rows[0]!.id };
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes('periods_no_overlap')) {
          return { kind: 'conflict', reason: 'une période active du même périmètre chevauche cet intervalle (une seule période active compatible — garanti par la base)' };
        }
        return { kind: 'invalid', reason: msg.split('\n')[0] ?? 'période refusée' };
      }
    });
  }

  async list(tenantId: string, actor: string): Promise<TimeOutcome<{ items: unknown[] }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'time.period_manage', 'time.period_close', 'time.preclose_view', 'time.payroll_view', 'time.period_reopen'))) {
        return { kind: 'forbidden', reason: 'permission requise : time.period_manage ou time.preclose_view' };
      }
      const items = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT p.id, p.scope_kind AS "scopeKind", p.company_id AS "companyId", p.site_id AS "siteId",
               p.label, p.period_start::text AS "periodStart", p.period_end::text AS "periodEnd",
               p.status, p.revision, p.created_at AS "createdAt",
               (SELECT count(*)::int FROM time.period_closes c WHERE c.period_id = p.id) AS "closeCount",
               (SELECT max(c.close_no)::int FROM time.period_closes c WHERE c.period_id = p.id AND c.status = 'active') AS "activeCloseNo"
          FROM time.periods p ORDER BY p.period_start DESC, p.label`;
      return { kind: 'ok', items };
    });
  }

  /** Transitions de GESTION (open ⇄ in_review ⇄ locked) — la clôture et la
   * réouverture ont leurs opérations dédiées. */
  async setStatus(
    tenantId: string, actor: string, periodId: string, status: string,
  ): Promise<TimeOutcome<Record<never, never>>> {
    if (!['open', 'in_review', 'locked'].includes(status)) {
      return { kind: 'invalid', reason: 'status : open, in_review ou locked (close/reopen : opérations dédiées)' };
    }
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'time.period_manage'))) {
        return { kind: 'forbidden', reason: 'permission requise : time.period_manage' };
      }
      const rows = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT status FROM time.periods WHERE id = ${periodId}::uuid FOR UPDATE`;
      if (rows.length === 0) return { kind: 'not_found' };
      try {
        await tx.$executeRaw`UPDATE time.periods SET status = ${status} WHERE id = ${periodId}::uuid`;
      } catch (e) {
        return { kind: 'conflict', reason: (e as Error).message.split('\n')[0] ?? 'transition refusée' };
      }
      if (status === 'in_review') {
        await this.notifyHolders(tx, tenantId, actor, 'time.preclose_view',
          `temps-precloture-${periodId}-${rows[0]!.status}`, 'temps_precloture_ouverte',
          { periode: periodId }, 'period', periodId);
      }
      await auditAuth(tx, tenantId, {
        action: 'time_period_status_changed', actorUserId: actor, module: 'time',
        recordType: 'period', recordId: periodId,
        oldValue: { status: rows[0]!.status }, newValue: { status }, result: 'success',
      });
      return { kind: 'ok' };
    });
  }

  // ==================================================================
  // Pré-clôture : contrôles, bloquants configurables (E4), avertissements tracés.
  // ==================================================================

  private async blockingKeys(tx: Prisma.TransactionClient, tenantId: string, atDate: string): Promise<string[]> {
    const rows = await tx.$queryRaw<Array<{ value: unknown }>>`
      SELECT value FROM compliance.parameter_value_at('temps.precloture.bloquants', 'BJ'::char(2), ${tenantId}::uuid, ${atDate}::date)`;
    const v = rows[0]?.value;
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
    return DEFAULT_BLOCKING;
  }

  private async computePreclose(
    tx: Prisma.TransactionClient, tenantId: string, p: PeriodRow,
  ): Promise<{ controls: Array<{ key: string; count: number; blocking: boolean }>; blockers: number; warnings: number; closable: boolean }> {
    const scopeTenant = p.scope_kind === 'tenant';
    const companyId = p.company_id;
    const siteId = p.site_id;
    // Salariés ATTENDUS : horaire affecté sur la période, dans le périmètre.
    const q = await tx.$queryRaw<Array<Record<string, number>>>`
      WITH scoped_results AS (
        SELECT r.* FROM time.day_results r
         WHERE r.is_current AND r.work_date BETWEEN ${p.period_start}::date AND ${p.period_end}::date
           AND (${scopeTenant} OR r.company_id = ${companyId}::uuid OR r.site_id = ${siteId}::uuid)
      ), expected AS (
        SELECT DISTINCT es.employee_id FROM time.employee_schedules es
         WHERE daterange(es.effective_from, es.effective_to, '[)') && daterange(${p.period_start}::date, ${p.period_end}::date, '[]')
           AND (${scopeTenant} OR EXISTS (
                 SELECT 1 FROM core.employee_assignments a
                  WHERE a.employee_id = es.employee_id AND a.is_primary
                    AND daterange(a.effective_from, a.effective_to, '[)') && daterange(${p.period_start}::date, ${p.period_end}::date, '[]')
                    AND (a.company_id = ${companyId}::uuid OR a.site_id = ${siteId}::uuid)))
      ), scoped_requests AS (
        SELECT cr.* FROM time.correction_requests cr
         WHERE cr.work_date BETWEEN ${p.period_start}::date AND ${p.period_end}::date
           AND (${scopeTenant} OR EXISTS (
                 SELECT 1 FROM core.employee_assignments a
                  WHERE a.employee_id = cr.employee_id AND a.is_primary
                    AND daterange(a.effective_from, a.effective_to, '[)') @> cr.work_date
                    AND (a.company_id = ${companyId}::uuid OR a.site_id = ${siteId}::uuid)))
      )
      SELECT
        (SELECT count(*)::int FROM expected) AS expected_employees,
        (SELECT count(DISTINCT employee_id)::int FROM scoped_results) AS employees_with_results,
        (SELECT count(*)::int FROM expected e WHERE NOT EXISTS (SELECT 1 FROM scoped_results r WHERE r.employee_id = e.employee_id)) AS missing_employees,
        (SELECT count(*)::int FROM time.day_anomalies an JOIN scoped_results r ON r.id = an.day_result_id
          WHERE an.state IN ('open', 'acknowledged')) AS open_anomalies,
        (SELECT count(*)::int FROM time.day_anomalies an JOIN scoped_results r ON r.id = an.day_result_id
          WHERE an.state IN ('open', 'acknowledged') AND an.severity = 'blocking') AS blocking_anomalies,
        (SELECT count(*)::int FROM scoped_requests WHERE status IN ('submitted', 'returned', 'draft')) AS pending_requests,
        (SELECT count(*)::int FROM scoped_requests WHERE status IN ('approved', 'application_failed')) AS approved_unapplied,
        (SELECT count(*)::int FROM scoped_results WHERE calc_state = 'error') AS failed_days,
        (SELECT count(*)::int FROM core.employees emp
          WHERE emp.deleted_at IS NULL AND emp.status IN ('active', 'on_leave')
            AND NOT EXISTS (SELECT 1 FROM time.employee_schedules es2 WHERE es2.employee_id = emp.id
                  AND daterange(es2.effective_from, es2.effective_to, '[)') && daterange(${p.period_start}::date, ${p.period_end}::date, '[]'))) AS no_schedule_employees,
        (SELECT count(*)::int FROM core.employees emp
          WHERE emp.deleted_at IS NULL AND emp.status IN ('active', 'on_leave')
            AND NOT EXISTS (SELECT 1 FROM core.employee_assignments a2 WHERE a2.employee_id = emp.id AND a2.is_primary
                  AND daterange(a2.effective_from, a2.effective_to, '[)') @> ${p.period_end}::date)) AS no_assignment_employees,
        (SELECT COALESCE(sum(overtime_candidate_minutes), 0)::int FROM scoped_results) AS overtime_candidate_minutes,
        (SELECT count(*)::int FROM scoped_results WHERE day_status IN ('worked_rest_day', 'worked_public_holiday')) AS worked_rest_holiday_days,
        (SELECT count(*)::int FROM scoped_results WHERE engine_version <> ${PRESENCE_ENGINE_VERSION}) AS engine_divergence,
        (SELECT count(*)::int FROM time.correction_events ce JOIN scoped_results r
              ON r.employee_id = ce.employee_id AND r.work_date = ce.work_date
          WHERE ce.created_at > r.computed_at) AS stale_after_correction`;
    const c = q[0]!;
    const blocking = await this.blockingKeys(tx, tenantId, p.period_end);
    const controls = Object.entries(c).map(([key, count]) => ({
      key, count: Number(count), blocking: blocking.includes(key),
    }));
    const blockers = controls.filter((x) => x.blocking && x.count > 0
      && !['expected_employees', 'employees_with_results'].includes(x.key)).length;
    const warnings = controls.filter((x) => !x.blocking && x.count > 0
      && !['expected_employees', 'employees_with_results', 'overtime_candidate_minutes', 'worked_rest_holiday_days'].includes(x.key)).length;
    return { controls, blockers, warnings, closable: blockers === 0 };
  }

  async preclose(tenantId: string, actor: string, periodId: string): Promise<TimeOutcome<{ period: unknown; controls: unknown[]; blockers: number; warnings: number; closable: boolean }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'time.preclose_view', 'time.period_close', 'time.period_manage'))) {
        return { kind: 'forbidden', reason: 'permission requise : time.preclose_view' };
      }
      const p = await this.readPeriod(tx, periodId);
      if (!p) return { kind: 'not_found' };
      const pre = await this.computePreclose(tx, tenantId, p);
      await auditAuth(tx, tenantId, {
        action: 'time_preclose_consulted', actorUserId: actor, module: 'time',
        recordType: 'period', recordId: periodId, newValue: { blockers: pre.blockers, warnings: pre.warnings }, result: 'success',
      });
      return {
        kind: 'ok',
        period: { id: p.id, label: p.label, status: p.status, revision: p.revision, periodStart: p.period_start, periodEnd: p.period_end },
        ...pre,
      };
    });
  }

  // ==================================================================
  // Clôture : fige lignes + totaux + empreinte ; idempotente ; anti-concurrente.
  // ==================================================================

  async close(
    tenantId: string, actor: string, periodId: string, opts: { confirmWarnings?: boolean },
  ): Promise<TimeOutcome<{ close: unknown }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'time.period_close'))) {
        return { kind: 'forbidden', reason: 'permission requise : time.period_close' };
      }
      // VERROU de période : deux clôtures concurrentes se sérialisent ici — la
      // seconde voit le statut 'closed' et échoue proprement.
      const p = await this.readPeriod(tx, periodId, true);
      if (!p) return { kind: 'not_found' };
      if (p.status === 'closed') return { kind: 'conflict', reason: 'période DÉJÀ clôturée (close_no existant) — la réouverture est la seule voie' };
      if (p.status !== 'locked') return { kind: 'conflict', reason: `période au statut « ${p.status} » — verrouiller (locked) avant de clôturer` };

      const pre = await this.computePreclose(tx, tenantId, p);
      if (pre.blockers > 0) {
        await this.notify.publishEventTx(tx, tenantId, {
          eventKey: `temps-cloture-bloquee-${periodId}-${p.revision}`,
          templateKey: 'temps_cloture_bloquee',
          payload: { periode: p.label, bloquants: pre.blockers },
          recipients: [{ userId: actor }], source: 'business', subjectType: 'period', subjectId: periodId, createdBy: actor,
        });
        await auditAuth(tx, tenantId, {
          action: 'time_period_close_blocked', actorUserId: actor, module: 'time',
          recordType: 'period', recordId: periodId,
          newValue: { blockers: pre.controls.filter((x) => x.blocking && x.count > 0) }, result: 'failure',
        });
        return { kind: 'conflict', reason: `clôture BLOQUÉE : ${pre.blockers} contrôle(s) bloquant(s) — voir la pré-clôture` };
      }
      if (pre.warnings > 0 && opts.confirmWarnings !== true) {
        return { kind: 'conflict', reason: `${pre.warnings} avertissement(s) : confirmation explicite requise (confirmWarnings) — ils seront TRACÉS dans la clôture` };
      }

      // Lignes RETENUES : la version courante de chaque journée du périmètre.
      const scopeTenant = p.scope_kind === 'tenant';
      const lines = await tx.$queryRaw<Array<{
        id: string; employee_id: string; work_date: string; day_status: string;
        worked_minutes: number; late_minutes: number; early_departure_minutes: number;
        absence_minutes: number; night_minutes: number; rest_day_minutes: number;
        holiday_minutes: number; overtime_candidate_minutes: number;
        justified_category: string | null; justified_minutes: number;
        corrections_applied: number; planned_start_minute: number | null;
        planned_rest: boolean; holiday: boolean; params_used: Record<string, unknown>;
      }>>`
        SELECT id, employee_id, work_date::text, day_status, worked_minutes, late_minutes,
               early_departure_minutes, absence_minutes, night_minutes, rest_day_minutes,
               holiday_minutes, overtime_candidate_minutes, justified_category, justified_minutes,
               corrections_applied, planned_start_minute, planned_rest, holiday, params_used
          FROM time.day_results r
         WHERE r.is_current AND r.work_date BETWEEN ${p.period_start}::date AND ${p.period_end}::date
           AND (${scopeTenant} OR r.company_id = ${p.company_id}::uuid OR r.site_id = ${p.site_id}::uuid)
         ORDER BY r.employee_id, r.work_date`;

      // EMPREINTE reproductible : sérialisation canonique triée des lignes retenues.
      const canonical = lines.map((l) =>
        `${l.employee_id}|${l.work_date}|${l.id}|${l.day_status}|${l.worked_minutes}|${l.late_minutes}|${l.early_departure_minutes}`
        + `|${l.absence_minutes}|${l.night_minutes}|${l.rest_day_minutes}|${l.holiday_minutes}|${l.overtime_candidate_minutes}`
        + `|${l.justified_category ?? ''}|${l.justified_minutes}|${l.corrections_applied}`).join('\n');
      const fingerprint = createHash('sha256').update(canonical, 'utf8').digest('hex');

      // Paramètres réellement utilisés : versions distinctes par clé, toutes lignes.
      const paramVersions: Record<string, Set<string>> = {};
      for (const l of lines) {
        for (const [key, v] of Object.entries(l.params_used ?? {})) {
          const pid = (v as { parameterId?: string | null })?.parameterId;
          if (!paramVersions[key]) paramVersions[key] = new Set();
          paramVersions[key]!.add(pid ?? 'defaut');
        }
      }
      const paramsSnapshot = Object.fromEntries(Object.entries(paramVersions).map(([k, s]) => [k, [...s].sort()]));

      const closeNoRows = await tx.$queryRaw<Array<{ n: number | null }>>`
        SELECT max(close_no)::int AS n FROM time.period_closes WHERE period_id = ${periodId}::uuid`;
      const closeNo = (closeNoRows[0]?.n ?? 0) + 1;
      const employees = new Set(lines.map((l) => l.employee_id));
      const daysCount = Math.round((Date.parse(p.period_end) - Date.parse(p.period_start)) / 86_400_000) + 1;

      // Défense en profondeur : une clôture active résiduelle est supersédée.
      await tx.$executeRaw`
        UPDATE time.period_closes SET status = 'superseded'
         WHERE period_id = ${periodId}::uuid AND status = 'active'`;

      const warningsList = pre.controls.filter((x) => !x.blocking && x.count > 0);
      const totalsRows = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT r.employee_id AS "employeeId",
               count(*) FILTER (WHERE r.planned_start_minute IS NOT NULL AND NOT r.planned_rest AND NOT r.holiday
                 AND r.day_status NOT IN ('not_employed', 'suspended'))::int AS "expectedDays",
               count(*) FILTER (WHERE r.worked_minutes > 0)::int AS "presentDays",
               count(*) FILTER (WHERE r.day_status = 'absent' AND r.justified_category IS NULL)::int AS "unjustifiedAbsenceDays",
               COALESCE((SELECT jsonb_object_agg(cat, stats) FROM (
                 SELECT r2.justified_category AS cat,
                        jsonb_build_object('days', count(*), 'minutes', sum(r2.justified_minutes)) AS stats
                   FROM time.day_results r2
                  WHERE r2.is_current AND r2.employee_id = r.employee_id
                    AND r2.work_date BETWEEN ${p.period_start}::date AND ${p.period_end}::date
                    AND r2.justified_category IS NOT NULL
                  GROUP BY r2.justified_category) j), '{}'::jsonb) AS justified,
               COALESCE(sum(r.late_minutes), 0)::int AS "lateMinutes",
               COALESCE(sum(r.early_departure_minutes), 0)::int AS "earlyDepartureMinutes",
               COALESCE(sum(r.worked_minutes), 0)::int AS "workedMinutes",
               COALESCE(sum(r.night_minutes), 0)::int AS "nightMinutes",
               COALESCE(sum(r.rest_day_minutes), 0)::int AS "restDayMinutes",
               COALESCE(sum(r.holiday_minutes), 0)::int AS "holidayMinutes",
               COALESCE(sum(r.overtime_candidate_minutes), 0)::int AS "overtimeCandidateMinutes",
               COALESCE(sum(r.corrections_applied), 0)::int AS "correctionsApplied"
          FROM time.day_results r
         WHERE r.is_current AND r.work_date BETWEEN ${p.period_start}::date AND ${p.period_end}::date
           AND (${scopeTenant} OR r.company_id = ${p.company_id}::uuid OR r.site_id = ${p.site_id}::uuid)
         GROUP BY r.employee_id`;

      const grand: Record<string, number> = {};
      for (const row of totalsRows) {
        for (const [k, v] of Object.entries(row)) {
          if (typeof v === 'number') grand[k] = (grand[k] ?? 0) + v;
        }
      }
      delete grand['employeeId'];

      const closeRows = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO time.period_closes
          (tenant_id, period_id, close_no, period_revision, engine_version, params_snapshot,
           dataset_sha256, employees_count, days_count, results_count, totals, warnings, closed_by)
        VALUES (${tenantId}::uuid, ${periodId}::uuid, ${closeNo}, ${p.revision}, ${PRESENCE_ENGINE_VERSION},
                ${JSON.stringify(paramsSnapshot)}::jsonb, ${fingerprint}, ${employees.size},
                ${daysCount}, ${lines.length}, ${JSON.stringify(grand)}::jsonb,
                ${JSON.stringify(warningsList)}::jsonb, ${actor}::uuid)
        RETURNING id`;
      const closeId = closeRows[0]!.id;
      for (const l of lines) {
        await tx.$executeRaw`
          INSERT INTO time.period_close_lines (tenant_id, close_id, employee_id, work_date, day_result_id)
          VALUES (${tenantId}::uuid, ${closeId}::uuid, ${l.employee_id}::uuid, ${l.work_date}::date, ${l.id}::uuid)`;
      }
      for (const t of totalsRows) {
        await tx.$executeRaw`
          INSERT INTO time.period_close_totals
            (tenant_id, close_id, employee_id, expected_days, present_days, unjustified_absence_days,
             justified, late_minutes, early_departure_minutes, worked_minutes, night_minutes,
             rest_day_minutes, holiday_minutes, overtime_candidate_minutes, corrections_applied)
          VALUES (${tenantId}::uuid, ${closeId}::uuid, ${t['employeeId'] as string}::uuid,
                  ${t['expectedDays'] as number}, ${t['presentDays'] as number}, ${t['unjustifiedAbsenceDays'] as number},
                  ${JSON.stringify(t['justified'] ?? {})}::jsonb, ${t['lateMinutes'] as number},
                  ${t['earlyDepartureMinutes'] as number}, ${t['workedMinutes'] as number}, ${t['nightMinutes'] as number},
                  ${t['restDayMinutes'] as number}, ${t['holidayMinutes'] as number},
                  ${t['overtimeCandidateMinutes'] as number}, ${t['correctionsApplied'] as number})`;
      }
      await tx.$executeRaw`UPDATE time.periods SET status = 'closed' WHERE id = ${periodId}::uuid`;

      // Les exports des clôtures PRÉCÉDENTES deviennent « remplacés » — jamais supprimés.
      const replaced = await tx.$queryRaw<Array<{ id: string }>>`
        UPDATE time.payroll_exports x SET status = 'superseded'
         WHERE x.status = 'active'
           AND x.close_id IN (SELECT c.id FROM time.period_closes c
                               WHERE c.period_id = ${periodId}::uuid AND c.id <> ${closeId}::uuid)
        RETURNING x.id`;
      if (replaced.length > 0) {
        await this.notifyHolders(tx, tenantId, actor, 'time.payroll_export',
          `temps-export-remplace-${closeId}`, 'temps_export_remplace',
          { periode: p.label, exports: replaced.length }, 'period_close', closeId);
      }
      await this.notifyHolders(tx, tenantId, actor, 'time.payroll_view',
        `temps-cloture-reussie-${closeId}`, 'temps_cloture_reussie',
        { periode: p.label, cloture: closeNo, empreinte: fingerprint.slice(0, 12) }, 'period_close', closeId);
      await auditAuth(tx, tenantId, {
        action: 'time_period_closed', actorUserId: actor, module: 'time',
        recordType: 'period_close', recordId: closeId,
        newValue: { periodId, closeNo, fingerprint, results: lines.length, warnings: warningsList.length },
        result: 'success',
      });
      const close = await this.readClose(tx, closeId);
      return { kind: 'ok', close: close! };
    }, { timeoutMs: 60_000 });
  }

  // ==================================================================
  // Réouverture contrôlée — circuit E3 si configuré, sinon permission directe.
  // ==================================================================

  async reopen(
    tenantId: string, actor: string, periodId: string, motive: string,
  ): Promise<TimeOutcome<{ mode: 'workflow' | 'direct'; instanceId?: string }>> {
    if (motive.length < 1 || motive.length > 300) return { kind: 'invalid', reason: 'motive : 1 à 300 caractères (OBLIGATOIRE)' };
    const gate = await this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'time.period_reopen'))) {
        return { kind: 'forbidden' as const, reason: 'permission requise : time.period_reopen' };
      }
      const p = await this.readPeriod(tx, periodId);
      if (!p) return { kind: 'not_found' as const };
      if (p.status !== 'closed') return { kind: 'conflict' as const, reason: `période au statut « ${p.status} » — seule une période clôturée se rouvre` };
      const def = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM workflow.definitions WHERE key = 'temps_reouverture' AND status = 'active'`;
      return { kind: 'ok' as const, hasWorkflow: def.length > 0 };
    });
    if (gate.kind !== 'ok') return gate;
    if (gate.hasWorkflow) {
      const submitted = await this.wf.submit(tenantId, actor, {
        definitionKey: 'temps_reouverture', subjectType: 'time_period_reopen',
        subjectId: periodId, context: { periodId, motive },
      });
      if (submitted.kind !== 'ok') return { kind: 'conflict', reason: 'circuit de réouverture indisponible' };
      return { kind: 'ok', mode: 'workflow', instanceId: submitted.instanceId };
    }
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.performReopenTx(tx, tenantId, periodId, actor, motive);
      return { kind: 'ok', mode: 'direct' };
    });
  }

  private async performReopenTx(
    tx: Prisma.TransactionClient, tenantId: string, periodId: string, actor: string | null, motive: string,
  ): Promise<void> {
    const rows = await tx.$queryRaw<PeriodRow[]>`
      SELECT id, scope_kind, company_id, site_id, label, period_start::text, period_end::text, status, revision
        FROM time.periods WHERE id = ${periodId}::uuid FOR UPDATE`;
    const p = rows[0];
    if (!p || p.status !== 'closed') return; // décision arrivée sur une période déjà rouverte : inerte
    await tx.$executeRaw`
      UPDATE time.periods SET status = 'reopened', revision = ${p.revision + 1} WHERE id = ${periodId}::uuid`;
    // La clôture active devient « superseded » — elle DEMEURE, avec ses lignes et exports.
    await tx.$executeRaw`
      UPDATE time.period_closes SET status = 'superseded'
       WHERE period_id = ${periodId}::uuid AND status = 'active'`;
    await this.notifyHolders(tx, tenantId, actor ?? undefined, 'time.period_close',
      `temps-reouverture-${periodId}-${p.revision + 1}`, 'temps_reouverture',
      { periode: p.label, revision: p.revision + 1, motif: motive }, 'period', periodId);
    await auditAuth(tx, tenantId, {
      action: 'time_period_reopened', actorUserId: actor ?? undefined, module: 'time',
      recordType: 'period', recordId: periodId,
      newValue: { revision: p.revision + 1, motive }, result: 'success',
    });
  }

  // ==================================================================
  // Clôtures : consultation, vérification d'empreinte, comparaison.
  // ==================================================================

  async listCloses(tenantId: string, actor: string, periodId: string): Promise<TimeOutcome<{ items: unknown[] }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'time.payroll_view', 'time.period_close', 'time.preclose_view', 'time.period_manage'))) {
        return { kind: 'forbidden', reason: 'permission requise : time.payroll_view' };
      }
      const items = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT c.id, c.close_no AS "closeNo", c.period_revision AS "periodRevision",
               c.engine_version AS "engineVersion", c.dataset_sha256 AS "datasetSha256",
               c.employees_count AS "employeesCount", c.days_count AS "daysCount",
               c.results_count AS "resultsCount", c.totals, c.warnings, c.status,
               c.closed_by AS "closedBy", c.closed_at AS "closedAt",
               (SELECT count(*)::int FROM time.payroll_exports x WHERE x.close_id = c.id) AS "exportCount"
          FROM time.period_closes c WHERE c.period_id = ${periodId}::uuid
         ORDER BY c.close_no`;
      return { kind: 'ok', items };
    });
  }

  /** Variables temps PRÉPARATOIRES paie d'une clôture — aucun montant, nulle part. */
  async payroll(tenantId: string, actor: string, closeId: string): Promise<TimeOutcome<{ close: unknown; rows: unknown[] }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'time.payroll_view', 'time.payroll_export'))) {
        return { kind: 'forbidden', reason: 'permission requise : time.payroll_view' };
      }
      const close = await this.readClose(tx, closeId);
      if (!close) return { kind: 'not_found' };
      const rows = await this.payrollRows(tx, closeId);
      await auditAuth(tx, tenantId, {
        action: 'time_payroll_consulted', actorUserId: actor, module: 'time',
        recordType: 'period_close', recordId: closeId, result: 'success',
      });
      return { kind: 'ok', close, rows };
    });
  }

  /** L'EMPREINTE se recalcule à l'identique depuis les lignes figées — preuve. */
  async verify(tenantId: string, actor: string, closeId: string): Promise<TimeOutcome<{ stored: string; recomputed: string; match: boolean }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'time.payroll_view', 'time.period_close', 'time.preclose_view'))) {
        return { kind: 'forbidden', reason: 'permission requise : time.payroll_view' };
      }
      const close = await tx.$queryRaw<Array<{ dataset_sha256: string }>>`
        SELECT dataset_sha256 FROM time.period_closes WHERE id = ${closeId}::uuid`;
      if (close.length === 0) return { kind: 'not_found' };
      const lines = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT l.employee_id, l.work_date::text AS work_date, l.day_result_id,
               r.day_status, r.worked_minutes, r.late_minutes, r.early_departure_minutes,
               r.absence_minutes, r.night_minutes, r.rest_day_minutes, r.holiday_minutes,
               r.overtime_candidate_minutes, r.justified_category, r.justified_minutes, r.corrections_applied
          FROM time.period_close_lines l JOIN time.day_results r ON r.id = l.day_result_id
         WHERE l.close_id = ${closeId}::uuid
         ORDER BY l.employee_id, l.work_date`;
      const canonical = lines.map((l) =>
        `${l['employee_id']}|${l['work_date']}|${l['day_result_id']}|${l['day_status']}|${l['worked_minutes']}|${l['late_minutes']}|${l['early_departure_minutes']}`
        + `|${l['absence_minutes']}|${l['night_minutes']}|${l['rest_day_minutes']}|${l['holiday_minutes']}|${l['overtime_candidate_minutes']}`
        + `|${l['justified_category'] ?? ''}|${l['justified_minutes']}|${l['corrections_applied']}`).join('\n');
      const recomputed = createHash('sha256').update(canonical, 'utf8').digest('hex');
      return { kind: 'ok', stored: close[0]!.dataset_sha256, recomputed, match: recomputed === close[0]!.dataset_sha256 };
    });
  }

  /** Différences entre deux clôtures d'une même période — consultables (§14). */
  async compare(tenantId: string, actor: string, closeId: string, withCloseId: string): Promise<TimeOutcome<{ differences: unknown[] }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'time.payroll_view', 'time.period_close'))) {
        return { kind: 'forbidden', reason: 'permission requise : time.payroll_view' };
      }
      const a = await this.payrollRows(tx, closeId);
      const b = await this.payrollRows(tx, withCloseId);
      if (a.length === 0 && b.length === 0) return { kind: 'not_found' };
      const byEmp = new Map<string, Record<string, unknown>>();
      for (const r of a) byEmp.set(r['employeeId'] as string, r);
      const numeric = ['expectedDays', 'presentDays', 'unjustifiedAbsenceDays', 'lateMinutes', 'earlyDepartureMinutes',
        'workedMinutes', 'nightMinutes', 'restDayMinutes', 'holidayMinutes', 'overtimeCandidateMinutes', 'correctionsApplied'];
      const differences: unknown[] = [];
      for (const r of b) {
        const prev = byEmp.get(r['employeeId'] as string);
        const fields: Array<{ field: string; a: unknown; b: unknown }> = [];
        for (const f of numeric) {
          const va = prev?.[f] ?? 0;
          const vb = r[f] ?? 0;
          if (va !== vb) fields.push({ field: f, a: va, b: vb });
        }
        if (fields.length > 0) {
          differences.push({ employeeId: r['employeeId'], matricule: r['matricule'], fields });
        }
        byEmp.delete(r['employeeId'] as string);
      }
      for (const [, prev] of byEmp) {
        differences.push({ employeeId: prev['employeeId'], matricule: prev['matricule'], fields: [{ field: 'removed', a: true, b: null }] });
      }
      return { kind: 'ok', differences };
    });
  }

  // ==================================================================
  // Exports préparatoires paie — idempotents, révisions explicites, audités.
  // ==================================================================

  private async payrollRows(tx: Prisma.TransactionClient, closeId: string): Promise<Array<Record<string, unknown>>> {
    return tx.$queryRaw<Array<Record<string, unknown>>>`
      SELECT t.employee_id AS "employeeId", e.matricule, e.first_name AS "firstName", e.last_name AS "lastName",
             t.expected_days AS "expectedDays", t.present_days AS "presentDays",
             t.unjustified_absence_days AS "unjustifiedAbsenceDays", t.justified,
             t.late_minutes AS "lateMinutes", t.early_departure_minutes AS "earlyDepartureMinutes",
             t.worked_minutes AS "workedMinutes", t.night_minutes AS "nightMinutes",
             t.rest_day_minutes AS "restDayMinutes", t.holiday_minutes AS "holidayMinutes",
             t.overtime_candidate_minutes AS "overtimeCandidateMinutes", t.corrections_applied AS "correctionsApplied"
        FROM time.period_close_totals t JOIN core.employees e ON e.id = t.employee_id
       WHERE t.close_id = ${closeId}::uuid
       ORDER BY e.matricule`;
  }

  /** Contenu CANONIQUE (aucun horodatage, aucun identifiant d'export) : le même
   * export rejoué produit STRICTEMENT le même contenu — l'idempotence en découle. */
  private buildExportContent(
    format: 'csv' | 'json',
    close: Record<string, unknown>,
    rows: Array<Record<string, unknown>>,
  ): Buffer {
    if (format === 'json') {
      return Buffer.from(JSON.stringify({
        schemaVersion: EXPORT_SCHEMA,
        qualification: 'variables temps préparatoires — AUCUN élément de paie définitif, aucun montant',
        close: {
          id: close['id'], closeNo: close['closeNo'], periodLabel: close['periodLabel'],
          periodStart: close['periodStart'], periodEnd: close['periodEnd'],
          engineVersion: close['engineVersion'], datasetSha256: close['datasetSha256'],
        },
        lines: rows.map((r) => ({
          matricule: r['matricule'], lastName: r['lastName'], firstName: r['firstName'],
          expectedDays: r['expectedDays'], presentDays: r['presentDays'],
          unjustifiedAbsenceDays: r['unjustifiedAbsenceDays'], justified: r['justified'],
          lateMinutes: r['lateMinutes'], earlyDepartureMinutes: r['earlyDepartureMinutes'],
          workedMinutes: r['workedMinutes'], nightMinutes: r['nightMinutes'],
          restDayMinutes: r['restDayMinutes'], holidayMinutes: r['holidayMinutes'],
          overtimeCandidateMinutes: r['overtimeCandidateMinutes'], correctionsApplied: r['correctionsApplied'],
        })),
      }, null, 2), 'utf8');
    }
    const header = 'matricule;nom;prenom;jours_attendus;jours_presents;jours_absence_non_justifiee;justifications;'
      + 'retard_minutes;depart_anticipe_minutes;heures_travaillees_minutes;heures_nuit_minutes;'
      + 'heures_repos_minutes;heures_ferie_minutes;heures_sup_candidates_minutes;corrections_appliquees';
    const csvRows = rows.map((r) => [
      r['matricule'], r['lastName'], r['firstName'], r['expectedDays'], r['presentDays'],
      r['unjustifiedAbsenceDays'], JSON.stringify(r['justified'] ?? {}).replaceAll(';', ','),
      r['lateMinutes'], r['earlyDepartureMinutes'], r['workedMinutes'], r['nightMinutes'],
      r['restDayMinutes'], r['holidayMinutes'], r['overtimeCandidateMinutes'], r['correctionsApplied'],
    ].join(';'));
    return Buffer.from([header, ...csvRows].join('\n') + '\n', 'utf8');
  }

  async generateExport(
    tenantId: string, actor: string, closeId: string, format: 'csv' | 'json',
  ): Promise<TimeOutcome<{ export: unknown; reused: boolean }>> {
    if (format !== 'csv' && format !== 'json') return { kind: 'invalid', reason: 'format : csv ou json' };
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'time.payroll_export'))) {
        return { kind: 'forbidden', reason: 'permission requise : time.payroll_export' };
      }
      const close = await this.readClose(tx, closeId);
      if (!close) return { kind: 'not_found' };
      const rows = await this.payrollRows(tx, closeId);
      const content = this.buildExportContent(format, close as Record<string, unknown>, rows);
      const sha256 = createHash('sha256').update(content).digest('hex');
      // IDEMPOTENCE : même clôture + même schéma + même contenu ⇒ l'export EXISTANT
      // est rendu ; un contenu différent (schéma révisé) ⇒ révision EXPLICITE.
      const existing = await tx.$queryRaw<Array<{ id: string; sha256: string; revision: number; status: string }>>`
        SELECT id, sha256, revision, status FROM time.payroll_exports
         WHERE close_id = ${closeId}::uuid AND schema_version = ${EXPORT_SCHEMA} AND format = ${format}
         ORDER BY revision DESC`;
      const same = existing.find((x) => x.sha256 === sha256 && x.status === 'active');
      if (same) {
        const full = await this.readExport(tx, same.id);
        return { kind: 'ok', export: full!, reused: true };
      }
      const revision = (existing[0]?.revision ?? 0) + 1;
      const ins = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO time.payroll_exports
          (tenant_id, close_id, schema_version, format, revision, content, sha256, employees_count, generated_by)
        VALUES (${tenantId}::uuid, ${closeId}::uuid, ${EXPORT_SCHEMA}, ${format}, ${revision},
                ${content}, ${sha256}, ${rows.length}, ${actor}::uuid)
        RETURNING id`;
      await auditAuth(tx, tenantId, {
        action: 'time_payroll_export_generated', actorUserId: actor, module: 'time',
        recordType: 'payroll_export', recordId: ins[0]!.id,
        newValue: { closeId, format, revision, sha256, employees: rows.length }, result: 'success',
      });
      const full = await this.readExport(tx, ins[0]!.id);
      return { kind: 'ok', export: full!, reused: false };
    });
  }

  async listExports(tenantId: string, actor: string, closeId: string): Promise<TimeOutcome<{ items: unknown[] }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'time.payroll_view', 'time.payroll_export'))) {
        return { kind: 'forbidden', reason: 'permission requise : time.payroll_view' };
      }
      const items = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT id, schema_version AS "schemaVersion", format, revision, sha256,
               employees_count AS "employeesCount", status, generated_by AS "generatedBy",
               generated_at AS "generatedAt", octet_length(content) AS "byteSize"
          FROM time.payroll_exports WHERE close_id = ${closeId}::uuid
         ORDER BY format, revision`;
      return { kind: 'ok', items };
    });
  }

  async downloadExport(
    tenantId: string, actor: string, exportId: string,
  ): Promise<TimeOutcome<{ filename: string; mime: string; contentBase64: string; sha256: string }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'time.payroll_export'))) {
        return { kind: 'forbidden', reason: 'permission requise : time.payroll_export' };
      }
      const rows = await tx.$queryRaw<Array<{ id: string; format: string; revision: number; content: Buffer; sha256: string; close_id: string }>>`
        SELECT id, format, revision, content, sha256, close_id FROM time.payroll_exports WHERE id = ${exportId}::uuid`;
      const x = rows[0];
      if (!x) return { kind: 'not_found' };
      await auditAuth(tx, tenantId, {
        action: 'time_payroll_export_downloaded', actorUserId: actor, module: 'time',
        recordType: 'payroll_export', recordId: exportId, newValue: { sha256: x.sha256 }, result: 'success',
      });
      return {
        kind: 'ok',
        filename: `kora-paie-prep-${x.close_id.slice(0, 8)}-r${x.revision}.${x.format}`,
        mime: x.format === 'csv' ? 'text/csv' : 'application/json',
        contentBase64: Buffer.from(x.content).toString('base64'),
        sha256: x.sha256,
      };
    });
  }

  // ==================================================================
  // privé
  // ==================================================================

  private async readPeriod(tx: Prisma.TransactionClient, id: string, forUpdate = false): Promise<PeriodRow | null> {
    const rows = forUpdate
      ? await tx.$queryRaw<PeriodRow[]>`
          SELECT id, scope_kind, company_id, site_id, label, period_start::text, period_end::text, status, revision
            FROM time.periods WHERE id = ${id}::uuid FOR UPDATE`
      : await tx.$queryRaw<PeriodRow[]>`
          SELECT id, scope_kind, company_id, site_id, label, period_start::text, period_end::text, status, revision
            FROM time.periods WHERE id = ${id}::uuid`;
    return rows[0] ?? null;
  }

  private async readExport(tx: Prisma.TransactionClient, id: string): Promise<Record<string, unknown> | null> {
    const rows = await tx.$queryRaw<Array<Record<string, unknown>>>`
      SELECT id, close_id AS "closeId", schema_version AS "schemaVersion", format, revision, sha256,
             employees_count AS "employeesCount", error_report AS "errorReport", status,
             generated_by AS "generatedBy", generated_at AS "generatedAt", octet_length(content) AS "byteSize"
        FROM time.payroll_exports WHERE id = ${id}::uuid`;
    return rows[0] ?? null;
  }

  private async readClose(tx: Prisma.TransactionClient, id: string): Promise<Record<string, unknown> | null> {
    const rows = await tx.$queryRaw<Array<Record<string, unknown>>>`
      SELECT c.id, c.period_id AS "periodId", c.close_no AS "closeNo", c.period_revision AS "periodRevision",
             c.engine_version AS "engineVersion", c.params_snapshot AS "paramsSnapshot",
             c.dataset_sha256 AS "datasetSha256", c.employees_count AS "employeesCount",
             c.days_count AS "daysCount", c.results_count AS "resultsCount", c.totals, c.warnings,
             c.status, c.closed_by AS "closedBy", c.closed_at AS "closedAt",
             p.label AS "periodLabel", p.period_start::text AS "periodStart", p.period_end::text AS "periodEnd",
             p.revision AS "currentPeriodRevision", p.status AS "periodStatus"
        FROM time.period_closes c JOIN time.periods p ON p.id = c.period_id
       WHERE c.id = ${id}::uuid`;
    return rows[0] ?? null;
  }

  private async notifyHolders(
    tx: Prisma.TransactionClient, tenantId: string, actor: string | undefined, permission: string,
    eventKey: string, templateKey: string, payload: Record<string, unknown>,
    subjectType: string, subjectId: string,
  ): Promise<void> {
    const holders = await tx.$queryRaw<Array<{ user_id: string }>>`
      SELECT DISTINCT ur.user_id FROM admin.user_roles ur
        JOIN admin.role_permissions rp ON rp.role_id = ur.role_id
        JOIN admin.users u ON u.id = ur.user_id
       WHERE rp.permission_key = ${permission} AND u.is_active`;
    const recipients = holders.length > 0 ? holders.map((h) => ({ userId: h.user_id }))
      : actor ? [{ userId: actor }] : [];
    if (recipients.length === 0) return;
    await this.notify.publishEventTx(tx, tenantId, {
      eventKey, templateKey, payload, recipients,
      source: 'business', subjectType, subjectId, createdBy: actor ?? recipients[0]!.userId,
    });
  }
}
