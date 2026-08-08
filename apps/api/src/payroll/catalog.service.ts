/**
 * E12.1 — Référentiel de paie : calendriers et périodes, structures salariales,
 * rubriques et leurs VERSIONS datées, rémunération HISTORISÉE, prélèvements
 * paramétriques (déclarés, non calculés en E12.1).
 *
 * Deux règles gouvernent tout ce fichier :
 *  - une version ne se modifie JAMAIS : on en ajoute une nouvelle, datée ; un
 *    changement futur ne touche donc aucune paie déjà calculée ;
 *  - une formule n'est admise que si elle appartient à la grammaire FERMÉE, que
 *    ses variables appartiennent au catalogue et que ses clés de paramètres sont
 *    des clés E4 — la base le revérifie ensuite pour son propre compte.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { auditAuth } from '../auth/audit.util';
import {
  DATE_RE, holdsPermission, pgCode, type TimeOutcome,
} from './payroll-access';
import {
  isKnownVariable, referencedParams, referencedVariables, validateNode,
} from '../../../../packages/core/src/payroll.ts';

type Tx = Prisma.TransactionClient;

const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{1,29}$/;
const PARAM_KEY_RE = /^[a-z0-9]+(\.[a-z0-9_]+)+$/;
const KINDS = ['gain', 'prime', 'indemnite', 'avantage', 'retenue'];

export interface RubricVersionInput {
  effectiveFrom: string;
  valuation: 'fixed' | 'rate' | 'formula';
  fixedValue?: number | null;
  rateValue?: number | null;
  rateParamKey?: string | null;
  rateBase?: string | null;
  formula?: unknown;
  eligibility?: unknown;
  proration?: 'none' | 'worked_days' | 'calendar_days';
  capValue?: number | null;
  capParamKey?: string | null;
  floorValue?: number | null;
  roundingDp?: number | null;
  notes?: string | null;
}

@Injectable()
export class PayrollCatalogService {
  constructor(private readonly prisma: PrismaService) {}

  // ==================================================================
  // Calendriers et périodes
  // ==================================================================

  async createCalendar(tenantId: string, actor: string, input: { code: string; labelFr: string; labelEn: string; frequency: string }): Promise<TimeOutcome<{ id: string }>> {
    if (!CODE_RE.test(input.code)) return { kind: 'invalid', reason: 'code : 2 à 30 caractères A-Z 0-9 _ -' };
    if (!['monthly', 'biweekly', 'weekly'].includes(input.frequency)) {
      return { kind: 'invalid', reason: 'frequency : monthly, biweekly ou weekly' };
    }
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'payroll.calendar_manage'))) {
        return { kind: 'forbidden', reason: 'permission requise : payroll.calendar_manage' };
      }
      try {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO payroll.pay_calendars (tenant_id, code, label_fr, label_en, frequency, created_by)
          VALUES (${tenantId}::uuid, ${input.code}, ${input.labelFr}, ${input.labelEn}, ${input.frequency}, ${actor}::uuid)
          RETURNING id`;
        await auditAuth(tx, tenantId, {
          action: 'payroll_calendar_created', actorUserId: actor, module: 'payroll',
          recordType: 'pay_calendar', recordId: rows[0]!.id, newValue: { code: input.code }, result: 'success',
        });
        return { kind: 'ok', id: rows[0]!.id };
      } catch (e) {
        if (pgCode(e) === '23505') return { kind: 'conflict', reason: `code « ${input.code} » déjà utilisé` };
        throw e;
      }
    });
  }

  async listCalendars(tenantId: string, actor: string): Promise<TimeOutcome<{ items: unknown[] }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'payroll.calendar_manage', 'payroll.run', 'payroll.simulate', 'payroll.results_view'))) {
        return { kind: 'forbidden', reason: 'permission paie requise' };
      }
      const items = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT c.id, c.code, c.label_fr AS "labelFr", c.label_en AS "labelEn", c.frequency, c.status,
               (SELECT count(*)::int FROM payroll.pay_periods p WHERE p.calendar_id = c.id) AS "periodCount"
          FROM payroll.pay_calendars c ORDER BY c.code`;
      return { kind: 'ok', items };
    });
  }

  async createPeriod(tenantId: string, actor: string, input: { calendarId: string; label: string; periodStart: string; periodEnd: string; payDate: string }): Promise<TimeOutcome<{ id: string }>> {
    for (const [k, v] of [['periodStart', input.periodStart], ['periodEnd', input.periodEnd], ['payDate', input.payDate]] as const) {
      if (!DATE_RE.test(v)) return { kind: 'invalid', reason: `${k} : AAAA-MM-JJ` };
    }
    if (input.periodEnd < input.periodStart) return { kind: 'invalid', reason: 'fin antérieure au début' };
    if (input.payDate < input.periodStart) return { kind: 'invalid', reason: 'date de paie antérieure au début de période' };
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'payroll.calendar_manage'))) {
        return { kind: 'forbidden', reason: 'permission requise : payroll.calendar_manage' };
      }
      try {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO payroll.pay_periods (tenant_id, calendar_id, label, period_start, period_end, pay_date, created_by)
          VALUES (${tenantId}::uuid, ${input.calendarId}::uuid, ${input.label}, ${input.periodStart}::date,
                  ${input.periodEnd}::date, ${input.payDate}::date, ${actor}::uuid)
          RETURNING id`;
        await auditAuth(tx, tenantId, {
          action: 'payroll_period_created', actorUserId: actor, module: 'payroll',
          recordType: 'pay_period', recordId: rows[0]!.id,
          newValue: { label: input.label, start: input.periodStart, end: input.periodEnd, payDate: input.payDate },
          result: 'success',
        });
        return { kind: 'ok', id: rows[0]!.id };
      } catch (e) {
        if (pgCode(e) === '23P01') return { kind: 'conflict', reason: 'périodes de paie chevauchantes sur ce calendrier — la base refuse' };
        if (pgCode(e) === '23503') return { kind: 'not_found' };
        throw e;
      }
    });
  }

  async listPeriods(tenantId: string, actor: string): Promise<TimeOutcome<{ items: unknown[] }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'payroll.calendar_manage', 'payroll.run', 'payroll.simulate', 'payroll.results_view'))) {
        return { kind: 'forbidden', reason: 'permission paie requise' };
      }
      const items = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT p.id, p.label, p.period_start::text AS "periodStart", p.period_end::text AS "periodEnd",
               p.pay_date::text AS "payDate", p.status, p.revision, c.code AS "calendarCode",
               (SELECT count(*)::int FROM payroll.runs r WHERE r.period_id = p.id) AS "runCount",
               (SELECT count(*)::int FROM payroll.results x WHERE x.period_id = p.id AND x.is_current) AS "currentResults"
          FROM payroll.pay_periods p JOIN payroll.pay_calendars c ON c.id = p.calendar_id
         ORDER BY p.period_start DESC`;
      return { kind: 'ok', items };
    });
  }

  // ==================================================================
  // Structures salariales
  // ==================================================================

  async createStructure(tenantId: string, actor: string, input: { code: string; labelFr: string; labelEn: string }): Promise<TimeOutcome<{ id: string }>> {
    if (!CODE_RE.test(input.code)) return { kind: 'invalid', reason: 'code : 2 à 30 caractères A-Z 0-9 _ -' };
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'payroll.structures_manage'))) {
        return { kind: 'forbidden', reason: 'permission requise : payroll.structures_manage' };
      }
      try {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO payroll.salary_structures (tenant_id, code, label_fr, label_en, created_by)
          VALUES (${tenantId}::uuid, ${input.code}, ${input.labelFr}, ${input.labelEn}, ${actor}::uuid)
          RETURNING id`;
        await auditAuth(tx, tenantId, {
          action: 'payroll_structure_created', actorUserId: actor, module: 'payroll',
          recordType: 'salary_structure', recordId: rows[0]!.id, newValue: { code: input.code }, result: 'success',
        });
        return { kind: 'ok', id: rows[0]!.id };
      } catch (e) {
        if (pgCode(e) === '23505') return { kind: 'conflict', reason: `code « ${input.code} » déjà utilisé` };
        throw e;
      }
    });
  }

  async setStructureStatus(tenantId: string, actor: string, id: string, status: string): Promise<TimeOutcome<{ updated: boolean }>> {
    if (!['draft', 'active', 'retired'].includes(status)) return { kind: 'invalid', reason: 'status : draft, active ou retired' };
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'payroll.structures_manage'))) {
        return { kind: 'forbidden', reason: 'permission requise : payroll.structures_manage' };
      }
      const n = await tx.$executeRaw`UPDATE payroll.salary_structures SET status = ${status} WHERE id = ${id}::uuid`;
      if (n === 0) return { kind: 'not_found' };
      await auditAuth(tx, tenantId, {
        action: 'payroll_structure_status', actorUserId: actor, module: 'payroll',
        recordType: 'salary_structure', recordId: id, newValue: { status }, result: 'success',
      });
      return { kind: 'ok', updated: true };
    });
  }

  async attachRubric(tenantId: string, actor: string, structureId: string, rubricId: string, sequence: number): Promise<TimeOutcome<{ attached: boolean }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'payroll.structures_manage'))) {
        return { kind: 'forbidden', reason: 'permission requise : payroll.structures_manage' };
      }
      try {
        await tx.$executeRaw`
          INSERT INTO payroll.structure_rubrics (tenant_id, structure_id, rubric_id, sequence)
          VALUES (${tenantId}::uuid, ${structureId}::uuid, ${rubricId}::uuid, ${sequence})
          ON CONFLICT (tenant_id, structure_id, rubric_id) DO UPDATE SET sequence = EXCLUDED.sequence`;
      } catch (e) {
        if (pgCode(e) === '23503') return { kind: 'not_found' };
        throw e;
      }
      await auditAuth(tx, tenantId, {
        action: 'payroll_structure_rubric_attached', actorUserId: actor, module: 'payroll',
        recordType: 'salary_structure', recordId: structureId, newValue: { rubricId, sequence }, result: 'success',
      });
      return { kind: 'ok', attached: true };
    });
  }

  async listStructures(tenantId: string, actor: string): Promise<TimeOutcome<{ items: unknown[] }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'payroll.structures_manage', 'payroll.simulate', 'payroll.run', 'payroll.results_view', 'payroll.compensation_manage'))) {
        return { kind: 'forbidden', reason: 'permission paie requise' };
      }
      const items = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT s.id, s.code, s.label_fr AS "labelFr", s.label_en AS "labelEn", s.status,
               COALESCE((SELECT json_agg(json_build_object('rubricId', sr.rubric_id, 'code', r.code, 'sequence', sr.sequence)
                                          ORDER BY sr.sequence, r.code)
                           FROM payroll.structure_rubrics sr JOIN payroll.rubrics r ON r.id = sr.rubric_id
                          WHERE sr.structure_id = s.id), '[]'::json) AS rubrics
          FROM payroll.salary_structures s ORDER BY s.code`;
      return { kind: 'ok', items };
    });
  }

  // ==================================================================
  // Rubriques et versions
  // ==================================================================

  async createRubric(tenantId: string, actor: string, input: {
    code: string; labelFr: string; labelEn: string; kind: string;
    taxable: boolean; cotisable: boolean; sequence?: number; notes?: string | null;
  }): Promise<TimeOutcome<{ id: string }>> {
    if (!CODE_RE.test(input.code)) return { kind: 'invalid', reason: 'code : 2 à 30 caractères A-Z 0-9 _ -' };
    if (!KINDS.includes(input.kind)) return { kind: 'invalid', reason: `kind : ${KINDS.join(', ')}` };
    if (typeof input.taxable !== 'boolean' || typeof input.cotisable !== 'boolean') {
      return { kind: 'invalid', reason: 'taxable et cotisable : booléens explicites (jamais implicites)' };
    }
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'payroll.rubrics_manage'))) {
        return { kind: 'forbidden', reason: 'permission requise : payroll.rubrics_manage' };
      }
      try {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO payroll.rubrics (tenant_id, code, label_fr, label_en, kind, taxable, cotisable, sequence, notes, created_by)
          VALUES (${tenantId}::uuid, ${input.code}, ${input.labelFr}, ${input.labelEn}, ${input.kind},
                  ${input.taxable}, ${input.cotisable}, ${input.sequence ?? 100}, ${input.notes ?? null}, ${actor}::uuid)
          RETURNING id`;
        await auditAuth(tx, tenantId, {
          action: 'payroll_rubric_created', actorUserId: actor, module: 'payroll',
          recordType: 'payroll_rubric', recordId: rows[0]!.id,
          newValue: { code: input.code, kind: input.kind, taxable: input.taxable, cotisable: input.cotisable },
          result: 'success',
        });
        return { kind: 'ok', id: rows[0]!.id };
      } catch (e) {
        if (pgCode(e) === '23505') return { kind: 'conflict', reason: `code « ${input.code} » déjà utilisé` };
        throw e;
      }
    });
  }

  async setRubricStatus(tenantId: string, actor: string, id: string, status: string): Promise<TimeOutcome<{ updated: boolean }>> {
    if (!['draft', 'active', 'retired'].includes(status)) return { kind: 'invalid', reason: 'status : draft, active ou retired' };
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'payroll.rubrics_manage'))) {
        return { kind: 'forbidden', reason: 'permission requise : payroll.rubrics_manage' };
      }
      if (status === 'active') {
        const versions = await tx.$queryRaw<Array<{ n: unknown }>>`
          SELECT count(*)::int AS n FROM payroll.rubric_versions WHERE rubric_id = ${id}::uuid`;
        if (Number(versions[0]?.n ?? 0) === 0) {
          return { kind: 'conflict', reason: 'aucune version : une rubrique sans règle datée ne s’active pas' };
        }
      }
      const n = await tx.$executeRaw`UPDATE payroll.rubrics SET status = ${status} WHERE id = ${id}::uuid`;
      if (n === 0) return { kind: 'not_found' };
      await auditAuth(tx, tenantId, {
        action: 'payroll_rubric_status', actorUserId: actor, module: 'payroll',
        recordType: 'payroll_rubric', recordId: id, newValue: { status }, result: 'success',
      });
      return { kind: 'ok', updated: true };
    });
  }

  /** Contrôle d'ADMISSIBILITÉ d'un arbre : grammaire, catalogue, clés E4. */
  private admissible(node: unknown, asCond: boolean, label: string): string | null {
    const bad = validateNode(node, asCond);
    if (bad !== null) return `${label} refusée : ${bad}`;
    for (const v of referencedVariables(node)) {
      if (!isKnownVariable(v)) return `${label} : variable « ${v} » hors catalogue de paie`;
    }
    for (const p of referencedParams(node)) {
      if (!PARAM_KEY_RE.test(p)) return `${label} : clé de paramètre « ${p} » hors motif E4`;
    }
    return null;
  }

  async addRubricVersion(tenantId: string, actor: string, rubricId: string, input: RubricVersionInput): Promise<TimeOutcome<{ id: string; version: number }>> {
    if (!DATE_RE.test(input.effectiveFrom)) return { kind: 'invalid', reason: 'effectiveFrom : AAAA-MM-JJ' };
    if (!['fixed', 'rate', 'formula'].includes(input.valuation)) {
      return { kind: 'invalid', reason: 'valuation : fixed, rate ou formula' };
    }
    if (input.proration !== undefined && !['none', 'worked_days', 'calendar_days'].includes(input.proration)) {
      return { kind: 'invalid', reason: 'proration : none, worked_days ou calendar_days' };
    }
    if (input.valuation === 'fixed' && typeof input.fixedValue !== 'number') {
      return { kind: 'invalid', reason: 'montant fixe requis' };
    }
    if (input.valuation === 'rate') {
      if (typeof input.rateBase !== 'string' || !isKnownVariable(input.rateBase)) {
        return { kind: 'invalid', reason: 'rateBase : variable du catalogue de paie requise' };
      }
      const hasValue = typeof input.rateValue === 'number';
      const hasKey = typeof input.rateParamKey === 'string' && input.rateParamKey.length > 0;
      if (hasValue === hasKey) {
        return { kind: 'invalid', reason: 'taux : soit une CLÉ E4 (valeur légale), soit une valeur interne assumée — jamais les deux' };
      }
      if (hasKey && !PARAM_KEY_RE.test(input.rateParamKey!)) {
        return { kind: 'invalid', reason: 'rateParamKey hors motif E4' };
      }
    }
    if (input.valuation === 'formula') {
      const bad = this.admissible(input.formula, false, 'formule');
      if (bad !== null) return { kind: 'invalid', reason: bad };
    }
    if (input.eligibility !== undefined && input.eligibility !== null) {
      const bad = this.admissible(input.eligibility, true, 'éligibilité');
      if (bad !== null) return { kind: 'invalid', reason: bad };
    }
    if (input.capParamKey && !PARAM_KEY_RE.test(input.capParamKey)) {
      return { kind: 'invalid', reason: 'capParamKey hors motif E4' };
    }
    if (input.roundingDp !== undefined && input.roundingDp !== null
      && (!Number.isInteger(input.roundingDp) || input.roundingDp < 0 || input.roundingDp > 6)) {
      return { kind: 'invalid', reason: 'roundingDp : entier de 0 à 6' };
    }

    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'payroll.rubrics_manage'))) {
        return { kind: 'forbidden', reason: 'permission requise : payroll.rubrics_manage' };
      }
      const rubric = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM payroll.rubrics WHERE id = ${rubricId}::uuid`;
      if (rubric.length === 0) return { kind: 'not_found' };
      const next = await tx.$queryRaw<Array<{ n: unknown }>>`
        SELECT COALESCE(max(version), 0) + 1 AS n FROM payroll.rubric_versions WHERE rubric_id = ${rubricId}::uuid`;
      const version = Number(next[0]!.n);
      try {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO payroll.rubric_versions (tenant_id, rubric_id, version, effective_from, valuation,
            fixed_value, rate_value, rate_param_key, rate_base, formula, eligibility, proration,
            cap_value, cap_param_key, floor_value, rounding_dp, notes, created_by)
          VALUES (${tenantId}::uuid, ${rubricId}::uuid, ${version}, ${input.effectiveFrom}::date, ${input.valuation},
            ${input.fixedValue ?? null}, ${input.rateValue ?? null}, ${input.rateParamKey ?? null}, ${input.rateBase ?? null},
            ${input.formula === undefined || input.formula === null ? null : JSON.stringify(input.formula)}::jsonb,
            ${input.eligibility === undefined || input.eligibility === null ? null : JSON.stringify(input.eligibility)}::jsonb,
            ${input.proration ?? 'none'}, ${input.capValue ?? null}, ${input.capParamKey ?? null},
            ${input.floorValue ?? null}, ${input.roundingDp ?? null}, ${input.notes ?? null}, ${actor}::uuid)
          RETURNING id`;
        await auditAuth(tx, tenantId, {
          action: 'payroll_rubric_version_added', actorUserId: actor, module: 'payroll',
          recordType: 'payroll_rubric', recordId: rubricId,
          newValue: { version, effectiveFrom: input.effectiveFrom, valuation: input.valuation }, result: 'success',
        });
        return { kind: 'ok', id: rows[0]!.id, version };
      } catch (e) {
        const code = pgCode(e);
        if (code === '23505') return { kind: 'conflict', reason: 'une version porte déjà cette date d’effet' };
        if (code === '23514') {
          return { kind: 'invalid', reason: 'la base refuse cette version : forme de valorisation incohérente ou formule hors grammaire' };
        }
        throw e;
      }
    });
  }

  async listRubrics(tenantId: string, actor: string): Promise<TimeOutcome<{ items: unknown[] }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'payroll.rubrics_manage', 'payroll.simulate', 'payroll.run', 'payroll.results_view'))) {
        return { kind: 'forbidden', reason: 'permission paie requise' };
      }
      const items = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT r.id, r.code, r.label_fr AS "labelFr", r.label_en AS "labelEn", r.kind, r.taxable, r.cotisable,
               r.sequence, r.status,
               EXISTS (SELECT 1 FROM payroll.result_lines l WHERE l.rubric_id = r.id) AS used,
               COALESCE((SELECT json_agg(json_build_object(
                          'id', v.id, 'version', v.version, 'effectiveFrom', v.effective_from::text,
                          'valuation', v.valuation, 'fixedValue', v.fixed_value, 'rateValue', v.rate_value,
                          'rateParamKey', v.rate_param_key, 'rateBase', v.rate_base, 'formula', v.formula,
                          'eligibility', v.eligibility, 'proration', v.proration,
                          'capValue', v.cap_value, 'capParamKey', v.cap_param_key,
                          'floorValue', v.floor_value, 'roundingDp', v.rounding_dp) ORDER BY v.version)
                           FROM payroll.rubric_versions v WHERE v.rubric_id = r.id), '[]'::json) AS versions
          FROM payroll.rubrics r ORDER BY r.sequence, r.code`;
      return { kind: 'ok', items };
    });
  }

  // ==================================================================
  // Rémunération HISTORISÉE
  // ==================================================================

  async addCompensation(tenantId: string, actor: string, input: {
    employeeId: string; structureId: string; effectiveFrom: string;
    baseAmount: number; currency: string; periodicity: string; reason: string;
  }): Promise<TimeOutcome<{ id: string }>> {
    if (!DATE_RE.test(input.effectiveFrom)) return { kind: 'invalid', reason: 'effectiveFrom : AAAA-MM-JJ' };
    if (!(typeof input.baseAmount === 'number' && Number.isFinite(input.baseAmount) && input.baseAmount >= 0)) {
      return { kind: 'invalid', reason: 'baseAmount : nombre positif ou nul' };
    }
    if (!/^[A-Z]{3}$/.test(input.currency)) return { kind: 'invalid', reason: 'currency : code ISO à 3 lettres' };
    if (!['monthly', 'hourly', 'daily'].includes(input.periodicity)) {
      return { kind: 'invalid', reason: 'periodicity : monthly, hourly ou daily' };
    }
    if (!input.reason || input.reason.trim().length < 3) return { kind: 'invalid', reason: 'motif OBLIGATOIRE (3 caractères minimum)' };
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'payroll.compensation_manage'))) {
        return { kind: 'forbidden', reason: 'permission requise : payroll.compensation_manage' };
      }
      try {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO payroll.compensations (tenant_id, employee_id, structure_id, effective_from,
            base_amount, currency, periodicity, reason, created_by)
          VALUES (${tenantId}::uuid, ${input.employeeId}::uuid, ${input.structureId}::uuid,
                  ${input.effectiveFrom}::date, ${input.baseAmount}, ${input.currency}, ${input.periodicity},
                  ${input.reason}, ${actor}::uuid)
          RETURNING id`;
        // La rémunération est une donnée SENSIBLE : le montant n'entre pas au
        // journal général, seule la date d'effet et l'auteur y figurent.
        await auditAuth(tx, tenantId, {
          action: 'payroll_compensation_added', actorUserId: actor, module: 'payroll',
          recordType: 'payroll_compensation', recordId: rows[0]!.id,
          newValue: { employeeId: input.employeeId, effectiveFrom: input.effectiveFrom, periodicity: input.periodicity },
          reason: input.reason, result: 'success',
        });
        return { kind: 'ok', id: rows[0]!.id };
      } catch (e) {
        const code = pgCode(e);
        if (code === '23505') return { kind: 'conflict', reason: 'une version de rémunération porte déjà cette date d’effet' };
        if (code === '23503') return { kind: 'not_found' };
        throw e;
      }
    });
  }

  async listCompensations(tenantId: string, actor: string, employeeId?: string): Promise<TimeOutcome<{ items: unknown[] }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'payroll.compensation_view', 'payroll.compensation_manage'))) {
        return { kind: 'forbidden', reason: 'permission requise : payroll.compensation_view' };
      }
      const items = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT c.id, c.employee_id AS "employeeId", e.matricule, c.structure_id AS "structureId",
               s.code AS "structureCode", c.effective_from::text AS "effectiveFrom",
               c.base_amount AS "baseAmount", c.currency, c.periodicity, c.reason, c.created_at AS "createdAt"
          FROM payroll.compensations c
          JOIN core.employees e ON e.id = c.employee_id
          JOIN payroll.salary_structures s ON s.id = c.structure_id
         WHERE (${employeeId ?? null}::uuid IS NULL OR c.employee_id = ${employeeId ?? null}::uuid)
         ORDER BY e.matricule, c.effective_from DESC`;
      await auditAuth(tx, tenantId, {
        action: 'payroll_compensation_accessed', actorUserId: actor, module: 'payroll',
        recordType: 'payroll_compensation', reason: employeeId ?? 'toutes', result: 'success',
      });
      return { kind: 'ok', items };
    });
  }

  // ==================================================================
  // Prélèvements : DÉCLARÉS et versionnés, JAMAIS calculés en E12.1
  // ==================================================================

  async createLevy(tenantId: string, actor: string, input: {
    code: string; labelFr: string; labelEn: string; kind: string; baseKind: string;
  }): Promise<TimeOutcome<{ id: string }>> {
    if (!CODE_RE.test(input.code)) return { kind: 'invalid', reason: 'code : 2 à 30 caractères A-Z 0-9 _ -' };
    if (!['salarial', 'patronal', 'impot'].includes(input.kind)) return { kind: 'invalid', reason: 'kind : salarial, patronal ou impot' };
    if (!['cotisable', 'imposable', 'brut'].includes(input.baseKind)) return { kind: 'invalid', reason: 'baseKind : cotisable, imposable ou brut' };
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'payroll.levies_manage'))) {
        return { kind: 'forbidden', reason: 'permission requise : payroll.levies_manage' };
      }
      try {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO payroll.levies (tenant_id, code, label_fr, label_en, kind, base_kind, created_by)
          VALUES (${tenantId}::uuid, ${input.code}, ${input.labelFr}, ${input.labelEn}, ${input.kind}, ${input.baseKind}, ${actor}::uuid)
          RETURNING id`;
        await auditAuth(tx, tenantId, {
          action: 'payroll_levy_created', actorUserId: actor, module: 'payroll',
          recordType: 'payroll_levy', recordId: rows[0]!.id, newValue: { code: input.code, kind: input.kind }, result: 'success',
        });
        return { kind: 'ok', id: rows[0]!.id };
      } catch (e) {
        if (pgCode(e) === '23505') return { kind: 'conflict', reason: `code « ${input.code} » déjà utilisé` };
        throw e;
      }
    });
  }

  async addLevyVersion(tenantId: string, actor: string, levyId: string, input: {
    effectiveFrom: string; rateParamKey: string; ceilingParamKey?: string | null;
    floorParamKey?: string | null; exemption?: unknown; notes?: string | null;
  }): Promise<TimeOutcome<{ id: string; version: number }>> {
    if (!DATE_RE.test(input.effectiveFrom)) return { kind: 'invalid', reason: 'effectiveFrom : AAAA-MM-JJ' };
    for (const [label, key] of [['rateParamKey', input.rateParamKey], ['ceilingParamKey', input.ceilingParamKey], ['floorParamKey', input.floorParamKey]] as const) {
      if (key !== undefined && key !== null && !PARAM_KEY_RE.test(key)) {
        return { kind: 'invalid', reason: `${label} : clé E4 attendue — un taux légal ne s’écrit JAMAIS ici` };
      }
    }
    if (!input.rateParamKey) return { kind: 'invalid', reason: 'rateParamKey obligatoire (clé E4)' };
    if (input.exemption !== undefined && input.exemption !== null) {
      const bad = this.admissible(input.exemption, true, 'exonération');
      if (bad !== null) return { kind: 'invalid', reason: bad };
    }
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'payroll.levies_manage'))) {
        return { kind: 'forbidden', reason: 'permission requise : payroll.levies_manage' };
      }
      const next = await tx.$queryRaw<Array<{ n: unknown }>>`
        SELECT COALESCE(max(version), 0) + 1 AS n FROM payroll.levy_versions WHERE levy_id = ${levyId}::uuid`;
      const version = Number(next[0]!.n);
      try {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO payroll.levy_versions (tenant_id, levy_id, version, effective_from, rate_param_key,
            ceiling_param_key, floor_param_key, exemption, notes, created_by)
          VALUES (${tenantId}::uuid, ${levyId}::uuid, ${version}, ${input.effectiveFrom}::date, ${input.rateParamKey},
            ${input.ceilingParamKey ?? null}, ${input.floorParamKey ?? null},
            ${input.exemption === undefined || input.exemption === null ? null : JSON.stringify(input.exemption)}::jsonb,
            ${input.notes ?? null}, ${actor}::uuid)
          RETURNING id`;
        await auditAuth(tx, tenantId, {
          action: 'payroll_levy_version_added', actorUserId: actor, module: 'payroll',
          recordType: 'payroll_levy', recordId: levyId,
          newValue: { version, effectiveFrom: input.effectiveFrom, rateParamKey: input.rateParamKey }, result: 'success',
        });
        return { kind: 'ok', id: rows[0]!.id, version };
      } catch (e) {
        const code = pgCode(e);
        if (code === '23503') return { kind: 'not_found' };
        if (code === '23505') return { kind: 'conflict', reason: 'version déjà enregistrée' };
        throw e;
      }
    });
  }

  async listLevies(tenantId: string, actor: string): Promise<TimeOutcome<{ items: unknown[]; note: string }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'payroll.levies_manage', 'payroll.results_view'))) {
        return { kind: 'forbidden', reason: 'permission paie requise' };
      }
      const items = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT l.id, l.code, l.label_fr AS "labelFr", l.label_en AS "labelEn", l.kind, l.base_kind AS "baseKind", l.status,
               COALESCE((SELECT json_agg(json_build_object('version', v.version, 'effectiveFrom', v.effective_from::text,
                          'rateParamKey', v.rate_param_key, 'ceilingParamKey', v.ceiling_param_key,
                          'floorParamKey', v.floor_param_key, 'exemption', v.exemption) ORDER BY v.version)
                           FROM payroll.levy_versions v WHERE v.levy_id = l.id), '[]'::json) AS versions
          FROM payroll.levies l ORDER BY l.code`;
      return {
        kind: 'ok', items,
        note: 'E12.1 déclare les prélèvements et leurs clés de paramètres ; AUCUN n’est calculé — seules les assiettes sont produites.',
      };
    });
  }
}
