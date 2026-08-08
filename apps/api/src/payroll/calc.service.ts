/**
 * E12.1 — Calcul de paie BRUT : simulation, exécution versionnée, comparaison.
 *
 * Le moteur ne recalcule NI la présence NI les congés : il CONSOMME les clôtures
 * E10 et E11 (variables préparatoires figées, empreintes portées au résultat).
 * Il ne connaît AUCUNE valeur légale : chaque taux, plafond ou décimale d'arrondi
 * vient d'une clé E4 résolue à la DATE DE PAIE, avec sa provenance ; une clé
 * absente fait échouer le salarié concerné — jamais un repli silencieux.
 *
 * Reproductibilité : Salarié + Période + Version de rémunération + Clôture E10 +
 * Clôture E11 + Versions de paramètres + Version du moteur → Résultat. L'empreinte
 * des entrées est enregistrée : deux résultats d'empreinte égale ont le même brut.
 *
 * Un résultat ne se modifie pas : un recalcul crée une VERSION, l'ancienne reste.
 */
import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { auditAuth } from '../auth/audit.util';
import { NotificationService } from '../notify/notification.service';
import { WorkflowService } from '../workflow/workflow.service';
import {
  DATE_RE, OPERATING_COUNTRY, ROUNDING_PARAM_KEY, calendarDays, holdsPermission,
  monthsBetween, payrollParamsAt, pgCode, type PayrollParam, type TimeOutcome,
} from './payroll-access';
import {
  PAYROLL_ENGINE_VERSION, PREP_CATEGORY_KEYS, computeGross, diffLines, inputsFingerprint,
  type GrossOutcome, type ParamProvenanceUsed, type RubricVersionSpec,
} from '../../../../packages/core/src/payroll.ts';
import { prepVariables, type AppliedFactLike } from '../../../../packages/core/src/leave-close.ts';

type Tx = Prisma.TransactionClient;

interface PeriodRow {
  id: string; label: string; period_start: string; period_end: string; pay_date: string;
  status: string; revision: number;
}

interface PayContext {
  period: PeriodRow;
  timeCloseId: string | null;
  leaveCloseId: string | null;
  roundingDp: number;
  params: Record<string, PayrollParam>;
}

@Injectable()
export class PayrollCalcService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notify: NotificationService,
    private readonly wf: WorkflowService,
  ) {
    // Pont E3 : la réouverture APPROUVÉE bascule la période (révision +1) —
    // les résultats validés DEMEURENT, un recalcul créera de nouvelles versions.
    this.wf.registerSubjectHandler('payroll_period_reopen', async (tx, tenantId, subjectId, status) => {
      if (status !== 'approved') return;
      await tx.$executeRaw`
        UPDATE payroll.pay_periods SET status = 'reopened', revision = revision + 1
         WHERE id = ${subjectId}::uuid AND status = 'validated'`;
      await auditAuth(tx, tenantId, {
        action: 'payroll_period_reopened', module: 'payroll',
        recordType: 'pay_period', recordId: subjectId, result: 'success',
      });
    });
  }

  // ==================================================================
  // Contexte de période : clôtures consommées + paramètres à la date de paie
  // ==================================================================

  private async periodRow(tx: Tx, id: string, lock = false): Promise<PeriodRow | null> {
    const rows = lock
      ? await tx.$queryRaw<PeriodRow[]>`
          SELECT id, label, period_start::text, period_end::text, pay_date::text, status, revision
            FROM payroll.pay_periods WHERE id = ${id}::uuid FOR UPDATE`
      : await tx.$queryRaw<PeriodRow[]>`
          SELECT id, label, period_start::text, period_end::text, pay_date::text, status, revision
            FROM payroll.pay_periods WHERE id = ${id}::uuid`;
    return rows[0] ?? null;
  }

  /** Clôture E10 ACTIVE couvrant la période, et clôture E11 ACTIVE la couvrant. */
  private async closesFor(tx: Tx, p: PeriodRow): Promise<{ timeCloseId: string | null; leaveCloseId: string | null }> {
    const t = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT c.id FROM time.period_closes c JOIN time.periods tp ON tp.id = c.period_id
       WHERE c.status = 'active'
         AND tp.period_start <= ${p.period_start}::date AND tp.period_end >= ${p.period_end}::date
       ORDER BY c.closed_at DESC LIMIT 1`;
    const l = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT c.id FROM leave.period_closes c JOIN leave.periods lp ON lp.id = c.period_id
       WHERE c.status = 'active'
         AND lp.period_start <= ${p.period_start}::date AND lp.period_end >= ${p.period_end}::date
       ORDER BY c.closed_at DESC LIMIT 1`;
    return { timeCloseId: t[0]?.id ?? null, leaveCloseId: l[0]?.id ?? null };
  }

  /** Toutes les clés E4 utiles à la période : rubriques actives + arrondi moteur. */
  private async paramKeysFor(tx: Tx, atDate: string): Promise<string[]> {
    const rows = await tx.$queryRaw<Array<{ key: string }>>`
      SELECT DISTINCT k.key FROM payroll.rubric_versions v
        JOIN payroll.rubrics r ON r.id = v.rubric_id AND r.status = 'active'
        CROSS JOIN LATERAL (
          SELECT v.rate_param_key AS key
          UNION ALL SELECT v.cap_param_key
          UNION ALL SELECT jsonb_path_query(v.formula, '$.**.key') #>> '{}'
          UNION ALL SELECT jsonb_path_query(v.eligibility, '$.**.key') #>> '{}'
        ) k
       WHERE v.effective_from <= ${atDate}::date AND k.key IS NOT NULL`;
    return [...new Set([...rows.map((r) => r.key), ROUNDING_PARAM_KEY])];
  }

  private async context(tx: Tx, tenantId: string, periodId: string, lock = false): Promise<PayContext | { error: string }> {
    const period = await this.periodRow(tx, periodId, lock);
    if (!period) return { error: 'not_found' };
    const closes = await this.closesFor(tx, period);
    const keys = await this.paramKeysFor(tx, period.pay_date);
    const params = await payrollParamsAt(tx, tenantId, OPERATING_COUNTRY, period.pay_date, keys);
    const rounding = params[ROUNDING_PARAM_KEY];
    if (!rounding || !Number.isInteger(rounding.value) || rounding.value < 0 || rounding.value > 6) {
      return {
        error: `paramètre E4 « ${ROUNDING_PARAM_KEY} » non résolu à la date de paie ${period.pay_date}`
          + ' — aucune décimale d’arrondi n’est écrite en dur : le calcul s’arrête',
      };
    }
    return { period, ...closes, roundingDp: rounding.value, params };
  }

  // ==================================================================
  // Entrées d'un salarié : rémunération à date + clôtures E10/E11
  // ==================================================================

  private async compensationAt(tx: Tx, employeeId: string, date: string): Promise<{
    id: string; structure_id: string; base_amount: string; currency: string; periodicity: string;
  } | null> {
    const rows = await tx.$queryRaw<Array<{
      id: string; structure_id: string; base_amount: string; currency: string; periodicity: string;
    }>>`
      SELECT id, structure_id, base_amount::text, currency, periodicity
        FROM payroll.compensations
       WHERE employee_id = ${employeeId}::uuid AND effective_from <= ${date}::date
       ORDER BY effective_from DESC LIMIT 1`;
    return rows[0] ?? null;
  }

  /** Versions de rubriques APPLICABLES à la date : la dernière datée ≤ date. */
  private async rubricsAt(tx: Tx, structureId: string, date: string): Promise<RubricVersionSpec[]> {
    const rows = await tx.$queryRaw<Array<Record<string, unknown>>>`
      SELECT r.id AS rubric_id, r.code, r.label_fr, r.label_en, r.kind, r.taxable, r.cotisable,
             sr.sequence, v.id AS version_id, v.version, v.valuation, v.fixed_value::text AS fixed_value,
             v.rate_value::text AS rate_value, v.rate_param_key, v.rate_base, v.formula, v.eligibility,
             v.proration, v.cap_value::text AS cap_value, v.cap_param_key,
             v.floor_value::text AS floor_value, v.rounding_dp
        FROM payroll.structure_rubrics sr
        JOIN payroll.rubrics r ON r.id = sr.rubric_id AND r.status = 'active'
        JOIN LATERAL (
          SELECT * FROM payroll.rubric_versions vv
           WHERE vv.rubric_id = r.id AND vv.effective_from <= ${date}::date
           ORDER BY vv.effective_from DESC, vv.version DESC LIMIT 1
        ) v ON true
       WHERE sr.structure_id = ${structureId}::uuid
       ORDER BY sr.sequence, r.code`;
    const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
    return rows.map((r) => ({
      rubricId: r['rubric_id'] as string,
      versionId: r['version_id'] as string,
      version: Number(r['version']),
      code: r['code'] as string,
      labelFr: r['label_fr'] as string,
      labelEn: r['label_en'] as string,
      kind: r['kind'] as RubricVersionSpec['kind'],
      taxable: r['taxable'] as boolean,
      cotisable: r['cotisable'] as boolean,
      sequence: Number(r['sequence']),
      valuation: r['valuation'] as RubricVersionSpec['valuation'],
      fixedValue: num(r['fixed_value']),
      rateValue: num(r['rate_value']),
      rateParamKey: (r['rate_param_key'] as string | null) ?? null,
      rateBase: (r['rate_base'] as string | null) ?? null,
      formula: (r['formula'] as RubricVersionSpec['formula']) ?? null,
      eligibility: (r['eligibility'] as RubricVersionSpec['eligibility']) ?? null,
      proration: r['proration'] as RubricVersionSpec['proration'],
      capValue: num(r['cap_value']),
      capParamKey: (r['cap_param_key'] as string | null) ?? null,
      floorValue: num(r['floor_value']),
      roundingDp: r['rounding_dp'] === null ? null : Number(r['rounding_dp']),
    }));
  }

  /**
   * Variables d'un salarié : rémunération historisée + CLÔTURES E10/E11.
   * Sans clôture couvrante, les volumes correspondants valent 0 et le résultat
   * le dit (aucune présence n'est recalculée ici, jamais).
   */
  private async variablesFor(
    tx: Tx, ctx: PayContext, employeeId: string, comp: { base_amount: string; periodicity: string },
  ): Promise<Record<string, number>> {
    const vars: Record<string, number> = {
      'base.montant': Number(comp.base_amount),
      'base.periodicite_mensuelle': comp.periodicity === 'monthly' ? 1 : 0,
      'periode.jours_calendaires': calendarDays(ctx.period.period_start, ctx.period.period_end),
      'temps.jours_attendus': 0, 'temps.jours_presents': 0, 'temps.jours_absence_injustifiee': 0,
      'temps.heures_travaillees': 0, 'temps.heures_nuit': 0, 'temps.heures_sup_candidates': 0,
      'temps.heures_repos_travaille': 0, 'temps.heures_ferie_travaille': 0,
      'temps.minutes_retard': 0, 'temps.minutes_depart_anticipe': 0, 'temps.corrections': 0,
      'emp.anciennete_mois': 0,
    };
    for (const c of PREP_CATEGORY_KEYS) {
      vars[`conges.jours_${c}`] = 0;
      vars[`conges.heures_${c}`] = 0;
    }

    const hire = await tx.$queryRaw<Array<{ hire_date: string | null }>>`
      SELECT hire_date::text FROM core.employees WHERE id = ${employeeId}::uuid`;
    if (hire[0]?.hire_date) vars['emp.anciennete_mois'] = monthsBetween(hire[0].hire_date, ctx.period.period_end);

    if (ctx.timeCloseId !== null) {
      const t = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT expected_days, present_days, unjustified_absence_days, late_minutes,
               early_departure_minutes, worked_minutes, night_minutes, rest_day_minutes,
               holiday_minutes, overtime_candidate_minutes, corrections_applied
          FROM time.period_close_totals
         WHERE close_id = ${ctx.timeCloseId}::uuid AND employee_id = ${employeeId}::uuid`;
      const r = t[0];
      if (r) {
        const h = (v: unknown): number => Math.round((Number(v ?? 0) / 60) * 1000) / 1000;
        vars['temps.jours_attendus'] = Number(r['expected_days'] ?? 0);
        vars['temps.jours_presents'] = Number(r['present_days'] ?? 0);
        vars['temps.jours_absence_injustifiee'] = Number(r['unjustified_absence_days'] ?? 0);
        vars['temps.heures_travaillees'] = h(r['worked_minutes']);
        vars['temps.heures_nuit'] = h(r['night_minutes']);
        vars['temps.heures_sup_candidates'] = h(r['overtime_candidate_minutes']);
        vars['temps.heures_repos_travaille'] = h(r['rest_day_minutes']);
        vars['temps.heures_ferie_travaille'] = h(r['holiday_minutes']);
        vars['temps.minutes_retard'] = Number(r['late_minutes'] ?? 0);
        vars['temps.minutes_depart_anticipe'] = Number(r['early_departure_minutes'] ?? 0);
        vars['temps.corrections'] = Number(r['corrections_applied'] ?? 0);
      }
    }

    if (ctx.leaveCloseId !== null) {
      // Mêmes volumes que l'export préparatoire E11.3 — MÊME fonction de domaine.
      const facts = await tx.$queryRaw<Array<{
        employee_id: string; prep_category: string; paid: boolean; unit: string;
        counted: string; minutes: number | null; status: string;
      }>>`
        SELECT f.employee_id, f.prep_category, f.paid, f.unit, f.counted::text, f.minutes, f.status
          FROM time.absence_facts f
          JOIN leave.period_closes c ON c.id = ${ctx.leaveCloseId}::uuid
          JOIN leave.periods lp ON lp.id = c.period_id
         WHERE f.employee_id = ${employeeId}::uuid
           AND f.work_date BETWEEN lp.period_start AND lp.period_end
           AND f.work_date BETWEEN ${ctx.period.period_start}::date AND ${ctx.period.period_end}::date
           AND f.status IN ('active', 'superseded')`;
      const prep = prepVariables(facts.map((f): AppliedFactLike => ({
        employeeId: f.employee_id, category: f.prep_category, paid: f.paid, unit: f.unit,
        counted: Number(f.counted), minutes: f.minutes, superseded: f.status === 'superseded',
      })));
      const mine = prep[0];
      if (mine) {
        for (const [cat, slot] of Object.entries(mine.categories)) {
          vars[`conges.jours_${cat}`] = slot.days;
          vars[`conges.heures_${cat}`] = slot.hours;
        }
      }
    }
    return vars;
  }

  private toParamResolver(params: Record<string, PayrollParam>): (key: string) => ParamProvenanceUsed | null {
    return (key: string) => (Object.prototype.hasOwnProperty.call(params, key) ? params[key]! : null);
  }

  // ==================================================================
  // Simulation : AUCUNE écriture de paie
  // ==================================================================

  async simulate(tenantId: string, actor: string, input: { periodId: string; employeeId: string }): Promise<TimeOutcome<{ simulation: unknown }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'payroll.simulate', 'payroll.run'))) {
        return { kind: 'forbidden', reason: 'permission requise : payroll.simulate' };
      }
      const ctx = await this.context(tx, tenantId, input.periodId);
      if ('error' in ctx) {
        return ctx.error === 'not_found' ? { kind: 'not_found' } : { kind: 'invalid', reason: ctx.error };
      }
      const one = await this.computeEmployee(tx, ctx, input.employeeId);
      if ('error' in one) return { kind: 'invalid', reason: one.error };
      await auditAuth(tx, tenantId, {
        action: 'payroll_simulated', actorUserId: actor, module: 'payroll',
        recordType: 'pay_period', recordId: input.periodId,
        newValue: { employeeId: input.employeeId, lines: one.gross.lines.length }, result: 'success',
      });
      return {
        kind: 'ok',
        simulation: {
          ...this.presentation(ctx, one),
          persisted: false,
          note: 'SIMULATION — aucun résultat de paie n’est écrit ; seul le journal d’audit conserve la consultation.',
        },
      };
    }, { timeoutMs: 30000 });
  }

  /** Un salarié : entrées résolues, brut calculé, empreinte des entrées. */
  private async computeEmployee(tx: Tx, ctx: PayContext, employeeId: string): Promise<{
    employeeId: string; comp: { id: string; structure_id: string; base_amount: string; currency: string; periodicity: string };
    variables: Record<string, number>; rubrics: RubricVersionSpec[]; gross: GrossOutcome; fingerprint: string;
  } | { error: string }> {
    const comp = await this.compensationAt(tx, employeeId, ctx.period.period_end);
    if (!comp) return { error: `aucune rémunération applicable au ${ctx.period.period_end} pour ce salarié` };
    const rubrics = await this.rubricsAt(tx, comp.structure_id, ctx.period.pay_date);
    const variables = await this.variablesFor(tx, ctx, employeeId, comp);
    const gross = computeGross({
      variables, rubrics, roundingDp: ctx.roundingDp, params: this.toParamResolver(ctx.params),
    });
    const fingerprint = inputsFingerprint({
      employeeId, periodId: ctx.period.id, periodStart: ctx.period.period_start,
      periodEnd: ctx.period.period_end, payDate: ctx.period.pay_date,
      compensationId: comp.id, structureId: comp.structure_id,
      timeCloseId: ctx.timeCloseId, leaveCloseId: ctx.leaveCloseId,
      engineVersion: PAYROLL_ENGINE_VERSION,
      rubricVersionIds: rubrics.map((r) => r.versionId),
      params: gross.paramsUsed, variables,
    });
    return { employeeId, comp: { ...comp }, variables, rubrics, gross, fingerprint };
  }

  private presentation(ctx: PayContext, one: Exclude<Awaited<ReturnType<PayrollCalcService['computeEmployee']>>, { error: string }>): Record<string, unknown> {
    return {
      periodId: ctx.period.id, periodLabel: ctx.period.label,
      periodStart: ctx.period.period_start, periodEnd: ctx.period.period_end, payDate: ctx.period.pay_date,
      employeeId: one.employeeId, currency: one.comp.currency,
      engineVersion: PAYROLL_ENGINE_VERSION,
      timeCloseId: ctx.timeCloseId, leaveCloseId: ctx.leaveCloseId,
      roundingDp: ctx.roundingDp,
      gross: one.gross.gross, taxableBase: one.gross.taxableBase, contributableBase: one.gross.contributableBase,
      lines: one.gross.lines, skipped: one.gross.skipped, errors: one.gross.errors,
      variables: one.variables, paramsUsed: one.gross.paramsUsed, inputsSha256: one.fingerprint,
    };
  }

  // ==================================================================
  // Exécution VERSIONNÉE
  // ==================================================================

  async run(tenantId: string, actor: string, input: { periodId: string; employeeId?: string; reason: string }): Promise<TimeOutcome<{
    runId: string; status: string; employeesCount: number; resultsCount: number; errors: unknown[]; fingerprint: string;
  }>> {
    if (!input.reason || input.reason.trim().length < 1) return { kind: 'invalid', reason: 'motif obligatoire' };
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'payroll.run'))) {
        return { kind: 'forbidden', reason: 'permission requise : payroll.run' };
      }
      // Sérialisation DÉTERMINISTE : deux calculs concurrents ne produisent
      // jamais deux paies vivantes (verrou + index partiel unique en base).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}::text || ':payroll:' || ${input.periodId}::text))`;
      const ctx = await this.context(tx, tenantId, input.periodId, true);
      if ('error' in ctx) {
        return ctx.error === 'not_found' ? { kind: 'not_found' } : { kind: 'invalid', reason: ctx.error };
      }
      if (!['open', 'locked', 'reopened'].includes(ctx.period.status)) {
        return { kind: 'conflict', reason: `période au statut « ${ctx.period.status} » — une paie validée exige une réouverture contrôlée` };
      }

      const targets = input.employeeId
        ? [{ id: input.employeeId }]
        : await tx.$queryRaw<Array<{ id: string }>>`
            SELECT DISTINCT e.id FROM core.employees e
              JOIN payroll.compensations c ON c.employee_id = e.id AND c.effective_from <= ${ctx.period.period_end}::date
             WHERE e.deleted_at IS NULL ORDER BY e.id`;

      const runRows = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO payroll.runs (tenant_id, period_id, period_revision, scope_kind, scope_employee_id, reason,
          engine_version, time_close_id, leave_close_id, params_snapshot, started_by)
        VALUES (${tenantId}::uuid, ${input.periodId}::uuid, ${ctx.period.revision},
                ${input.employeeId ? 'employee' : 'tenant'}, ${input.employeeId ?? null}::uuid, ${input.reason},
                ${PAYROLL_ENGINE_VERSION}, ${ctx.timeCloseId}::uuid, ${ctx.leaveCloseId}::uuid,
                ${JSON.stringify(ctx.params)}::jsonb, ${actor}::uuid)
        RETURNING id`;
      const runId = runRows[0]!.id;

      const errors: Array<{ employeeId: string; reason: string }> = [];
      const fingerprints: string[] = [];
      let resultsCount = 0;

      for (const t of targets) {
        const one = await this.computeEmployee(tx, ctx, t.id);
        if ('error' in one) { errors.push({ employeeId: t.id, reason: one.error }); continue; }
        if (one.gross.errors.length > 0) {
          errors.push({ employeeId: t.id, reason: one.gross.errors.map((x) => `${x.code} : ${x.reason}`).join(' ; ') });
          continue;
        }
        const prev = await tx.$queryRaw<Array<{ version: number }>>`
          SELECT max(version) AS version FROM payroll.results
           WHERE period_id = ${input.periodId}::uuid AND employee_id = ${t.id}::uuid`;
        const version = Number(prev[0]?.version ?? 0) + 1;
        // Une version dépassée n'est jamais réécrite : seul son drapeau tombe.
        await tx.$executeRaw`
          UPDATE payroll.results SET is_current = false
           WHERE period_id = ${input.periodId}::uuid AND employee_id = ${t.id}::uuid AND is_current`;
        const res = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO payroll.results (tenant_id, run_id, period_id, employee_id, version, is_current,
            compensation_id, structure_id, currency, gross_amount, taxable_base, contributable_base,
            lines_count, inputs_sha256, time_close_id, leave_close_id, params_used, inputs_used, engine_version)
          VALUES (${tenantId}::uuid, ${runId}::uuid, ${input.periodId}::uuid, ${t.id}::uuid, ${version}, true,
            ${one.comp.id}::uuid, ${one.comp.structure_id}::uuid, ${one.comp.currency},
            ${one.gross.gross}, ${one.gross.taxableBase}, ${one.gross.contributableBase},
            ${one.gross.lines.length}, ${one.fingerprint}, ${ctx.timeCloseId}::uuid, ${ctx.leaveCloseId}::uuid,
            ${JSON.stringify(one.gross.paramsUsed)}::jsonb, ${JSON.stringify(one.variables)}::jsonb,
            ${PAYROLL_ENGINE_VERSION})
          RETURNING id`;
        const resultId = res[0]!.id;
        for (const l of one.gross.lines) {
          await tx.$executeRaw`
            INSERT INTO payroll.result_lines (tenant_id, result_id, sequence, rubric_id, rubric_version_id,
              rubric_code, label_fr, label_en, kind, taxable, cotisable, valuation, base, rate, quantity,
              amount, trace, inputs_used, params_used)
            VALUES (${tenantId}::uuid, ${resultId}::uuid, ${l.sequence}, ${l.rubricId}::uuid, ${l.rubricVersionId}::uuid,
              ${l.code}, ${l.labelFr}, ${l.labelEn}, ${l.kind}, ${l.taxable}, ${l.cotisable}, ${l.valuation},
              ${l.base}, ${l.rate}, ${l.quantity}, ${l.amount},
              ${JSON.stringify(l.trace)}::jsonb, ${JSON.stringify(l.inputsUsed)}::jsonb,
              ${JSON.stringify(l.paramsUsed)}::jsonb)`;
        }
        fingerprints.push(`${t.id}:${one.fingerprint}`);
        resultsCount += 1;
      }

      const datasetSha = createDatasetSha(fingerprints);
      const status = errors.length > 0 ? (resultsCount > 0 ? 'completed_with_errors' : 'failed') : 'completed';
      await tx.$executeRaw`
        UPDATE payroll.runs SET status = ${status}, employees_count = ${targets.length},
               results_count = ${resultsCount}, errors = ${JSON.stringify(errors)}::jsonb,
               dataset_sha256 = ${datasetSha}, finished_at = now()
         WHERE id = ${runId}::uuid`;
      await auditAuth(tx, tenantId, {
        action: 'payroll_run_executed', actorUserId: actor, module: 'payroll',
        recordType: 'payroll_run', recordId: runId,
        newValue: { periodId: input.periodId, status, results: resultsCount, errors: errors.length, fingerprint: datasetSha },
        reason: input.reason, result: 'success',
      });
      await this.notify.publishEventTx(tx, tenantId, {
        eventKey: `paie-calcul-${runId}`, templateKey: 'paie_calcul_termine',
        payload: { periode: ctx.period.label, resultats: String(resultsCount) },
        recipients: [{ userId: actor }], source: 'business',
        subjectType: 'payroll_run', subjectId: runId, createdBy: actor,
      });
      return { kind: 'ok', runId, status, employeesCount: targets.length, resultsCount, errors, fingerprint: datasetSha };
    }, { timeoutMs: 120000 });
  }

  // ==================================================================
  // Consultation, explication, comparaison
  // ==================================================================

  async results(tenantId: string, actor: string, periodId: string): Promise<TimeOutcome<{ items: unknown[] }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'payroll.results_view', 'payroll.run'))) {
        return { kind: 'forbidden', reason: 'permission requise : payroll.results_view' };
      }
      const items = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT r.id, r.employee_id AS "employeeId", e.matricule, e.first_name AS "firstName", e.last_name AS "lastName",
               r.version, r.is_current AS "isCurrent", r.currency, r.gross_amount AS "grossAmount",
               r.taxable_base AS "taxableBase", r.contributable_base AS "contributableBase",
               r.lines_count AS "linesCount", r.inputs_sha256 AS "inputsSha256",
               r.engine_version AS "engineVersion", r.computed_at AS "computedAt", r.run_id AS "runId"
          FROM payroll.results r JOIN core.employees e ON e.id = r.employee_id
         WHERE r.period_id = ${periodId}::uuid
         ORDER BY e.matricule, r.version DESC`;
      await auditAuth(tx, tenantId, {
        action: 'payroll_results_accessed', actorUserId: actor, module: 'payroll',
        recordType: 'pay_period', recordId: periodId, result: 'success',
      });
      return { kind: 'ok', items };
    });
  }

  /** Détail EXPLIQUÉ : chaque montant, sa rubrique, sa formule, ses entrées. */
  async resultDetail(tenantId: string, actor: string, resultId: string): Promise<TimeOutcome<{ result: unknown }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'payroll.results_view', 'payroll.run'))) {
        return { kind: 'forbidden', reason: 'permission requise : payroll.results_view' };
      }
      const rows = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT r.id, r.period_id AS "periodId", p.label AS "periodLabel", p.period_start::text AS "periodStart",
               p.period_end::text AS "periodEnd", p.pay_date::text AS "payDate",
               r.employee_id AS "employeeId", e.matricule, r.version, r.is_current AS "isCurrent",
               r.currency, r.gross_amount AS "grossAmount", r.taxable_base AS "taxableBase",
               r.contributable_base AS "contributableBase", r.inputs_sha256 AS "inputsSha256",
               r.engine_version AS "engineVersion", r.time_close_id AS "timeCloseId",
               r.leave_close_id AS "leaveCloseId", r.params_used AS "paramsUsed",
               r.inputs_used AS "inputsUsed", r.computed_at AS "computedAt"
          FROM payroll.results r
          JOIN core.employees e ON e.id = r.employee_id
          JOIN payroll.pay_periods p ON p.id = r.period_id
         WHERE r.id = ${resultId}::uuid`;
      if (!rows[0]) return { kind: 'not_found' };
      const lines = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT sequence, rubric_code AS "code", label_fr AS "labelFr", label_en AS "labelEn", kind,
               taxable, cotisable, valuation, base, rate, quantity, amount, trace,
               inputs_used AS "inputsUsed", params_used AS "paramsUsed"
          FROM payroll.result_lines WHERE result_id = ${resultId}::uuid ORDER BY sequence`;
      await auditAuth(tx, tenantId, {
        action: 'payroll_result_explained', actorUserId: actor, module: 'payroll',
        recordType: 'payroll_result', recordId: resultId, result: 'success',
      });
      return { kind: 'ok', result: { ...rows[0], lines } };
    });
  }

  async compare(tenantId: string, actor: string, aId: string, bId: string): Promise<TimeOutcome<{ comparison: unknown }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'payroll.results_view', 'payroll.run'))) {
        return { kind: 'forbidden', reason: 'permission requise : payroll.results_view' };
      }
      const head = await tx.$queryRaw<Array<{ id: string; version: number; gross_amount: string; inputs_sha256: string; employee_id: string }>>`
        SELECT id, version, gross_amount::text, inputs_sha256, employee_id
          FROM payroll.results WHERE id IN (${aId}::uuid, ${bId}::uuid)`;
      if (head.length !== 2) return { kind: 'not_found' };
      const a = head.find((h) => h.id === aId)!;
      const b = head.find((h) => h.id === bId)!;
      if (a.employee_id !== b.employee_id) {
        return { kind: 'invalid', reason: 'comparaison réservée à DEUX calculs du MÊME salarié' };
      }
      const linesOf = async (id: string): Promise<Array<{ code: string; amount: number }>> => {
        const rows = await tx.$queryRaw<Array<{ code: string; amount: string }>>`
          SELECT rubric_code AS code, amount::text FROM payroll.result_lines WHERE result_id = ${id}::uuid`;
        return rows.map((r) => ({ code: r.code, amount: Number(r.amount) }));
      };
      const differences = diffLines(await linesOf(aId), await linesOf(bId));
      await auditAuth(tx, tenantId, {
        action: 'payroll_results_compared', actorUserId: actor, module: 'payroll',
        recordType: 'payroll_result', recordId: aId, newValue: { with: bId, differences: differences.length }, result: 'success',
      });
      return {
        kind: 'ok',
        comparison: {
          from: { id: a.id, version: a.version, gross: Number(a.gross_amount), inputsSha256: a.inputs_sha256 },
          to: { id: b.id, version: b.version, gross: Number(b.gross_amount), inputsSha256: b.inputs_sha256 },
          grossDelta: Math.round((Number(b.gross_amount) - Number(a.gross_amount)) * 10000) / 10000,
          sameInputs: a.inputs_sha256 === b.inputs_sha256,
          differences,
        },
      };
    });
  }

  async listRuns(tenantId: string, actor: string, periodId: string): Promise<TimeOutcome<{ items: unknown[] }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'payroll.results_view', 'payroll.run'))) {
        return { kind: 'forbidden', reason: 'permission requise : payroll.results_view' };
      }
      const items = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT id, period_revision AS "periodRevision", scope_kind AS "scopeKind", reason, status,
               engine_version AS "engineVersion", employees_count AS "employeesCount",
               results_count AS "resultsCount", errors, dataset_sha256 AS "fingerprint",
               time_close_id AS "timeCloseId", leave_close_id AS "leaveCloseId",
               started_at AS "startedAt", finished_at AS "finishedAt"
          FROM payroll.runs WHERE period_id = ${periodId}::uuid ORDER BY started_at`;
      return { kind: 'ok', items };
    });
  }

  // ==================================================================
  // Cycle de la période : verrouillage, validation, réouverture
  // ==================================================================

  async setStatus(tenantId: string, actor: string, periodId: string, status: string): Promise<TimeOutcome<{ status: string }>> {
    if (!['open', 'locked', 'validated'].includes(status)) {
      return { kind: 'invalid', reason: 'status : open, locked ou validated' };
    }
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'payroll.run'))) {
        return { kind: 'forbidden', reason: 'permission requise : payroll.run' };
      }
      const period = await this.periodRow(tx, periodId, true);
      if (!period) return { kind: 'not_found' };
      if (status === 'validated') {
        const pending = await tx.$queryRaw<Array<{ n: unknown }>>`
          SELECT count(*)::int AS n FROM core.employees e
            JOIN payroll.compensations c ON c.employee_id = e.id AND c.effective_from <= ${period.period_end}::date
           WHERE e.deleted_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM payroll.results r
                              WHERE r.period_id = ${periodId}::uuid AND r.employee_id = e.id AND r.is_current)`;
        if (Number(pending[0]?.n ?? 0) > 0) {
          return { kind: 'conflict', reason: `validation refusée : ${Number(pending[0]!.n)} salarié(s) rémunéré(s) sans résultat courant` };
        }
      }
      try {
        await tx.$executeRaw`UPDATE payroll.pay_periods SET status = ${status} WHERE id = ${periodId}::uuid`;
      } catch (e) {
        if (pgCode(e) === 'P0001') return { kind: 'conflict', reason: (e as Error).message.split('\n')[0] ?? 'transition refusée' };
        throw e;
      }
      await auditAuth(tx, tenantId, {
        action: 'payroll_period_status', actorUserId: actor, module: 'payroll',
        recordType: 'pay_period', recordId: periodId, oldValue: { status: period.status },
        newValue: { status }, result: 'success',
      });
      return { kind: 'ok', status };
    });
  }

  async requestReopen(tenantId: string, actor: string, periodId: string, reason: string): Promise<TimeOutcome<{ instanceId: string }>> {
    if (!reason || reason.trim().length < 3) return { kind: 'invalid', reason: 'motif de réouverture obligatoire' };
    const prep = await this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'payroll.run'))) {
        return { kind: 'forbidden' as const, reason: 'permission requise : payroll.run' };
      }
      const period = await this.periodRow(tx, periodId);
      if (!period) return { kind: 'not_found' as const };
      if (period.status !== 'validated') {
        return { kind: 'conflict' as const, reason: `période au statut « ${period.status} » — seule une paie VALIDÉE se rouvre` };
      }
      return { kind: 'ok' as const };
    });
    if (prep.kind !== 'ok') return prep;
    const submitted = await this.wf.submit(tenantId, actor, {
      definitionKey: 'paie_periode_reouverture', subjectType: 'payroll_period_reopen', subjectId: periodId,
      context: { periodId, reason },
    });
    if (submitted.kind === 'no_active_definition') {
      return { kind: 'conflict', reason: 'aucun circuit « paie_periode_reouverture » actif — configurez le workflow' };
    }
    if (submitted.kind !== 'ok') return { kind: 'invalid', reason: 'workflow vide' };
    await this.prisma.withTenant(tenantId, (tx) => auditAuth(tx, tenantId, {
      action: 'payroll_reopen_requested', actorUserId: actor, module: 'payroll',
      recordType: 'pay_period', recordId: periodId, reason, result: 'success',
    }));
    return { kind: 'ok', instanceId: submitted.instanceId };
  }
}

/** Empreinte d'exécution : concaténation CANONIQUE des empreintes d'entrées. */
function createDatasetSha(fingerprints: string[]): string {
  return createHash('sha256').update([...fingerprints].sort().join('\n'), 'utf8').digest('hex');
}
