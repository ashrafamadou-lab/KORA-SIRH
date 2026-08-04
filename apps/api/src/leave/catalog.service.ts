/**
 * E11.1 — Référentiel des congés : types d'absence (sémantique figée par la base
 * dès le premier usage), politiques versionnées datées, RÉSOLUTION de la politique
 * applicable à un salarié et une date (score de spécificité, égalité = CONFLIT
 * explicite — jamais un choix silencieux), aperçu de population éligible.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { auditAuth } from '../auth/audit.util';
import {
  DATE_RE, OPERATING_COUNTRY, holdsPermission, numericParam, paramsAt, pgCode, type TimeOutcome,
} from './leave-access';
import { PREP_CATEGORIES, isPrepCategory } from '../../../../packages/core/src/leave-close.ts';

const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{1,29}$/;
const UNITS = ['open_days', 'working_days', 'calendar_days', 'half_days', 'hours'];
const PARAM_KEY_RE = /^[a-z0-9]+(\.[a-z0-9_]+)+$/;

export interface TypeInput {
  code: string; labelFr: string; labelEn: string;
  category: string; paid: boolean; unit: string;
  affectsPresence?: boolean; affectsPayrollPrep?: boolean;
  justification?: string; depositDelayDays?: number | null;
  retroactiveAllowed?: boolean; negativeAllowed?: boolean; confidential?: boolean;
  retentionNote?: string | null; workflowRequired?: boolean;
  effectiveFrom?: string;
  /** Catégorie préparatoire paie (E11.3) — catalogue FERMÉ, figée dès le premier usage. */
  prepCategory?: string;
}

export interface PolicyVersionInput {
  effectiveFrom: string;
  accrualMode: string;
  accrualRateParam?: string | null;
  accrualRateValue?: number | null;
  referencePeriod?: string; refStartMonth?: number | null; refStartDay?: number | null;
  eligibilityMinMonthsParam?: string | null; eligibilityMinMonths?: number | null;
  accrualRequiresService?: boolean;
  prorataHire?: boolean; prorataTermination?: boolean; prorataPartTime?: boolean;
  rounding?: string;
  capParam?: string | null; capValue?: number | null;
  carryOverMaxParam?: string | null; carryOverMaxValue?: number | null;
  carryOverExpiryMonths?: number | null;
  minBlock?: number | null; maxPerRequest?: number | null; noticeDays?: number | null;
  anticipationAllowed?: boolean; approvalLevels?: number; notes?: string | null;
}

/** Politique + version RÉSOLUES pour un salarié à une date (avec provenance du rythme). */
export interface ResolvedPolicyRow {
  policyId: string; policyCode: string; policyVersion: number; versionId: string;
  absenceTypeId: string; typeCode: string; unit: string;
  score: number;
  content: Record<string, unknown>;
}

@Injectable()
export class LeaveCatalogService {
  constructor(private readonly prisma: PrismaService) {}

  // ================= Types d'absence =================

  async listTypes(tenantId: string, actor: string): Promise<TimeOutcome<{ items: unknown[] }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor,
        'leave.types_admin', 'leave.policies_admin', 'leave.balance_view', 'leave.balance_view_team',
        'leave.balance_view_own', 'leave.accrual_run', 'leave.balance_adjust', 'leave.openings_import', 'leave.ledger_view'))) {
        return { kind: 'forbidden', reason: 'permission congés requise' };
      }
      const items = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT t.id, t.code, t.label_fr AS "labelFr", t.label_en AS "labelEn", t.category, t.paid, t.unit,
               t.affects_presence AS "affectsPresence", t.affects_payroll_prep AS "affectsPayrollPrep",
               t.justification, t.deposit_delay_days AS "depositDelayDays",
               t.retroactive_allowed AS "retroactiveAllowed", t.negative_allowed AS "negativeAllowed",
               t.confidential, t.workflow_required AS "workflowRequired", t.status,
               t.prep_category AS "prepCategory",
               t.effective_from::text AS "effectiveFrom", t.effective_to::text AS "effectiveTo",
               (SELECT count(*)::int FROM leave.policies p WHERE p.absence_type_id = t.id) AS "policyCount",
               EXISTS (SELECT 1 FROM leave.entitlement_ledger l WHERE l.absence_type_id = t.id) AS "used"
          FROM leave.absence_types t ORDER BY t.code`;
      return { kind: 'ok', items };
    });
  }

  async createType(tenantId: string, actor: string, input: TypeInput): Promise<TimeOutcome<{ id: string }>> {
    const err = this.validateType(input);
    if (err) return { kind: 'invalid', reason: err };
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'leave.types_admin'))) {
        return { kind: 'forbidden', reason: 'permission requise : leave.types_admin' };
      }
      try {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO leave.absence_types
            (tenant_id, code, label_fr, label_en, category, paid, unit, affects_presence, affects_payroll_prep,
             justification, deposit_delay_days, retroactive_allowed, negative_allowed, confidential,
             retention_note, workflow_required, effective_from, created_by, prep_category)
          VALUES (${tenantId}::uuid, ${input.code}, ${input.labelFr}, ${input.labelEn}, ${input.category},
                  ${input.paid}, ${input.unit}, ${input.affectsPresence ?? true}, ${input.affectsPayrollPrep ?? true},
                  ${input.justification ?? 'none'}, ${input.depositDelayDays ?? null},
                  ${input.retroactiveAllowed ?? false}, ${input.negativeAllowed ?? false}, ${input.confidential ?? false},
                  ${input.retentionNote ?? null}, ${input.workflowRequired ?? true},
                  ${input.effectiveFrom ?? new Date().toISOString().slice(0, 10)}::date, ${actor}::uuid,
                  ${input.prepCategory ?? 'autre'})
          RETURNING id`;
        await auditAuth(tx, tenantId, {
          action: 'leave_type_created', actorUserId: actor, module: 'leave',
          recordType: 'absence_type', recordId: rows[0]!.id, newValue: { code: input.code, unit: input.unit }, result: 'success',
        });
        return { kind: 'ok', id: rows[0]!.id };
      } catch (e) {
        if (pgCode(e) === '23505') {
          return { kind: 'conflict', reason: `code « ${input.code} » déjà utilisé` };
        }
        throw e;
      }
    });
  }

  /** Mise à jour BORNÉE : libellés, statut, dates, notes — la sémantique est gardée par la base. */
  async updateType(
    tenantId: string, actor: string, typeId: string,
    input: Partial<Pick<TypeInput, 'labelFr' | 'labelEn' | 'retentionNote' | 'depositDelayDays' | 'justification' | 'workflowRequired' | 'retroactiveAllowed' | 'prepCategory'>> & { status?: string; effectiveTo?: string | null },
  ): Promise<TimeOutcome<{ updated: boolean }>> {
    if (input.status !== undefined && !['draft', 'active', 'inactive', 'archived'].includes(input.status)) {
      return { kind: 'invalid', reason: 'status : draft, active, inactive ou archived' };
    }
    if (input.prepCategory !== undefined && !isPrepCategory(input.prepCategory)) {
      return { kind: 'invalid', reason: `prepCategory : ${PREP_CATEGORIES.join(', ')}` };
    }
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'leave.types_admin'))) {
        return { kind: 'forbidden', reason: 'permission requise : leave.types_admin' };
      }
      const rows = await tx.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT id, status FROM leave.absence_types WHERE id = ${typeId}::uuid FOR UPDATE`;
      if (rows.length === 0) return { kind: 'not_found' };
      try {
        await tx.$executeRaw`
          UPDATE leave.absence_types SET
            label_fr = coalesce(${input.labelFr ?? null}, label_fr),
            label_en = coalesce(${input.labelEn ?? null}, label_en),
            retention_note = coalesce(${input.retentionNote ?? null}, retention_note),
            deposit_delay_days = coalesce(${input.depositDelayDays ?? null}, deposit_delay_days),
            justification = coalesce(${input.justification ?? null}, justification),
            workflow_required = coalesce(${input.workflowRequired ?? null}, workflow_required),
            retroactive_allowed = coalesce(${input.retroactiveAllowed ?? null}, retroactive_allowed),
            prep_category = coalesce(${input.prepCategory ?? null}, prep_category),
            status = coalesce(${input.status ?? null}, status),
            effective_to = coalesce(${input.effectiveTo ?? null}::date, effective_to)
          WHERE id = ${typeId}::uuid`;
      } catch (e) {
        return { kind: 'conflict', reason: (e as Error).message.split('\n')[0] ?? 'modification refusée' };
      }
      await auditAuth(tx, tenantId, {
        action: 'leave_type_updated', actorUserId: actor, module: 'leave',
        recordType: 'absence_type', recordId: typeId, newValue: input as Record<string, unknown>, result: 'success',
      });
      return { kind: 'ok', updated: true };
    });
  }

  private validateType(input: TypeInput): string | null {
    if (!CODE_RE.test(input.code)) return 'code : 2 à 30 caractères A-Z 0-9 _ -';
    if (!input.labelFr || !input.labelEn) return 'libellés FR et EN obligatoires';
    if (!['legal', 'conventional', 'internal'].includes(input.category)) return 'category : legal, conventional ou internal';
    if (!UNITS.includes(input.unit)) return `unit : ${UNITS.join(', ')}`;
    if (typeof input.paid !== 'boolean') return 'paid : booléen requis';
    if (input.justification !== undefined && !['required', 'optional', 'none'].includes(input.justification)) {
      return 'justification : required, optional ou none';
    }
    if (input.prepCategory !== undefined && !isPrepCategory(input.prepCategory)) {
      return `prepCategory : ${PREP_CATEGORIES.join(', ')}`;
    }
    return null;
  }

  // ================= Politiques =================

  async listPolicies(tenantId: string, actor: string): Promise<TimeOutcome<{ items: unknown[] }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'leave.policies_admin', 'leave.accrual_run', 'leave.balance_view'))) {
        return { kind: 'forbidden', reason: 'permission requise : leave.policies_admin' };
      }
      const items = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT p.id, p.code, p.label_fr AS "labelFr", p.label_en AS "labelEn", p.status,
               p.absence_type_id AS "absenceTypeId", t.code AS "typeCode", t.unit,
               p.country_code AS "countryCode", p.company_id AS "companyId", p.site_id AS "siteId",
               p.collective_agreement AS "collectiveAgreement", p.professional_category AS "professionalCategory",
               p.contract_type AS "contractType", p.employee_status AS "employeeStatus",
               p.seniority_min_months AS "seniorityMinMonths", p.work_time AS "workTime",
               p.population_key AS "populationKey",
               (SELECT count(*)::int FROM leave.policy_versions v WHERE v.policy_id = p.id) AS "versionCount",
               (SELECT max(v.effective_from)::text FROM leave.policy_versions v WHERE v.policy_id = p.id) AS "lastEffectiveFrom",
               (SELECT jsonb_agg(jsonb_build_object(
                  'version', v.version, 'effectiveFrom', v.effective_from::text,
                  'accrualMode', v.accrual_mode, 'accrualRateParam', v.accrual_rate_param,
                  'accrualRateValue', v.accrual_rate_value, 'referencePeriod', v.reference_period,
                  'rounding', v.rounding, 'carryOverMaxParam', v.carry_over_max_param,
                  'carryOverMaxValue', v.carry_over_max_value, 'accrualRequiresService', v.accrual_requires_service,
                  'prorataHire', v.prorata_hire, 'prorataTermination', v.prorata_termination,
                  'approvalLevels', v.approval_levels, 'noticeDays', v.notice_days,
                  'minBlock', v.min_block, 'anticipationAllowed', v.anticipation_allowed
                ) ORDER BY v.version) FROM leave.policy_versions v WHERE v.policy_id = p.id) AS versions
          FROM leave.policies p JOIN leave.absence_types t ON t.id = p.absence_type_id
         ORDER BY p.code`;
      return { kind: 'ok', items };
    });
  }

  async createPolicy(tenantId: string, actor: string, input: {
    absenceTypeId: string; code: string; labelFr: string; labelEn: string;
    countryCode?: string | null; companyId?: string | null; siteId?: string | null;
    collectiveAgreement?: string | null; professionalCategory?: string | null;
    contractType?: string | null; employeeStatus?: string | null;
    seniorityMinMonths?: number | null; workTime?: string; populationKey?: string | null;
  }): Promise<TimeOutcome<{ id: string }>> {
    if (!CODE_RE.test(input.code)) return { kind: 'invalid', reason: 'code : 2 à 30 caractères A-Z 0-9 _ -' };
    if (!input.labelFr || !input.labelEn) return { kind: 'invalid', reason: 'libellés FR et EN obligatoires' };
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'leave.policies_admin'))) {
        return { kind: 'forbidden', reason: 'permission requise : leave.policies_admin' };
      }
      try {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO leave.policies
            (tenant_id, absence_type_id, code, label_fr, label_en, country_code, company_id, site_id,
             collective_agreement, professional_category, contract_type, employee_status,
             seniority_min_months, work_time, population_key, created_by)
          VALUES (${tenantId}::uuid, ${input.absenceTypeId}::uuid, ${input.code}, ${input.labelFr}, ${input.labelEn},
                  ${input.countryCode ?? null}, ${input.companyId ?? null}::uuid, ${input.siteId ?? null}::uuid,
                  ${input.collectiveAgreement ?? null}, ${input.professionalCategory ?? null},
                  ${input.contractType ?? null}, ${input.employeeStatus ?? null},
                  ${input.seniorityMinMonths ?? null}, ${input.workTime ?? 'any'}, ${input.populationKey ?? null},
                  ${actor}::uuid)
          RETURNING id`;
        await auditAuth(tx, tenantId, {
          action: 'leave_policy_created', actorUserId: actor, module: 'leave',
          recordType: 'leave_policy', recordId: rows[0]!.id, newValue: { code: input.code }, result: 'success',
        });
        return { kind: 'ok', id: rows[0]!.id };
      } catch (e) {
        const code = pgCode(e);
        if (code === '23505') return { kind: 'conflict', reason: `code « ${input.code} » déjà utilisé` };
        if (code === '23503') return { kind: 'invalid', reason: 'type d\'absence, société ou site inconnu dans ce tenant' };
        throw e;
      }
    });
  }

  async addPolicyVersion(
    tenantId: string, actor: string, policyId: string, input: PolicyVersionInput,
  ): Promise<TimeOutcome<{ version: number }>> {
    const err = this.validateVersion(input);
    if (err) return { kind: 'invalid', reason: err };
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'leave.policies_admin'))) {
        return { kind: 'forbidden', reason: 'permission requise : leave.policies_admin' };
      }
      const pol = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM leave.policies WHERE id = ${policyId}::uuid FOR UPDATE`;
      if (pol.length === 0) return { kind: 'not_found' };
      const last = await tx.$queryRaw<Array<{ v: number | null; last_from: string | null }>>`
        SELECT max(version)::int AS v, max(effective_from)::text AS last_from
          FROM leave.policy_versions WHERE policy_id = ${policyId}::uuid`;
      const version = (last[0]?.v ?? 0) + 1;
      if (last[0]?.last_from && input.effectiveFrom <= last[0].last_from) {
        return { kind: 'conflict', reason: `effectiveFrom doit être POSTÉRIEUR à la dernière version (${last[0].last_from}) — l'histoire ne se réécrit pas` };
      }
      await tx.$executeRaw`
        INSERT INTO leave.policy_versions
          (tenant_id, policy_id, version, effective_from, accrual_mode, accrual_rate_param, accrual_rate_value,
           reference_period, ref_start_month, ref_start_day,
           eligibility_min_months_param, eligibility_min_months, accrual_requires_service,
           prorata_hire, prorata_termination, prorata_part_time, rounding,
           cap_param, cap_value, carry_over_max_param, carry_over_max_value, carry_over_expiry_months,
           min_block, max_per_request, notice_days, anticipation_allowed, approval_levels, notes, created_by)
        VALUES (${tenantId}::uuid, ${policyId}::uuid, ${version}, ${input.effectiveFrom}::date,
                ${input.accrualMode}, ${input.accrualRateParam ?? null}, ${input.accrualRateValue ?? null},
                ${input.referencePeriod ?? 'calendar_year'}, ${input.refStartMonth ?? null}, ${input.refStartDay ?? null},
                ${input.eligibilityMinMonthsParam ?? null}, ${input.eligibilityMinMonths ?? null}, ${input.accrualRequiresService ?? false},
                ${input.prorataHire ?? true}, ${input.prorataTermination ?? true}, ${input.prorataPartTime ?? false},
                ${input.rounding ?? 'none'},
                ${input.capParam ?? null}, ${input.capValue ?? null},
                ${input.carryOverMaxParam ?? null}, ${input.carryOverMaxValue ?? null}, ${input.carryOverExpiryMonths ?? null},
                ${input.minBlock ?? null}, ${input.maxPerRequest ?? null}, ${input.noticeDays ?? null},
                ${input.anticipationAllowed ?? false}, ${input.approvalLevels ?? 1}, ${input.notes ?? null}, ${actor}::uuid)`;
      await auditAuth(tx, tenantId, {
        action: 'leave_policy_version_added', actorUserId: actor, module: 'leave',
        recordType: 'leave_policy', recordId: policyId,
        newValue: { version, effectiveFrom: input.effectiveFrom, accrualMode: input.accrualMode }, result: 'success',
      });
      return { kind: 'ok', version };
    });
  }

  async setPolicyStatus(
    tenantId: string, actor: string, policyId: string, status: string,
  ): Promise<TimeOutcome<{ updated: boolean }>> {
    if (!['active', 'retired', 'draft'].includes(status)) return { kind: 'invalid', reason: 'status : draft, active ou retired' };
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'leave.policies_admin'))) {
        return { kind: 'forbidden', reason: 'permission requise : leave.policies_admin' };
      }
      const rows = await tx.$queryRaw<Array<{ id: string; n: number }>>`
        SELECT p.id, (SELECT count(*)::int FROM leave.policy_versions v WHERE v.policy_id = p.id) AS n
          FROM leave.policies p WHERE p.id = ${policyId}::uuid FOR UPDATE`;
      if (rows.length === 0) return { kind: 'not_found' };
      if (status === 'active' && rows[0]!.n === 0) {
        return { kind: 'conflict', reason: 'aucune version : une politique sans règles ne s\'active pas' };
      }
      try {
        await tx.$executeRaw`UPDATE leave.policies SET status = ${status}, updated_at = now() WHERE id = ${policyId}::uuid`;
      } catch (e) {
        if (pgCode(e) === '23505') {
          return { kind: 'conflict', reason: 'une politique ACTIVE du même type couvre déjà exactement cette population (une seule politique active par population — garanti par la base)' };
        }
        throw e;
      }
      await auditAuth(tx, tenantId, {
        action: 'leave_policy_status_changed', actorUserId: actor, module: 'leave',
        recordType: 'leave_policy', recordId: policyId, newValue: { status }, result: 'success',
      });
      return { kind: 'ok', updated: true };
    });
  }

  private validateVersion(input: PolicyVersionInput): string | null {
    if (!DATE_RE.test(input.effectiveFrom)) return 'effectiveFrom : date AAAA-MM-JJ requise';
    if (!['monthly', 'annual', 'anniversary', 'one_time', 'none'].includes(input.accrualMode)) {
      return 'accrualMode : monthly, annual, anniversary, one_time ou none';
    }
    if (input.accrualMode !== 'none') {
      const hasParam = !!input.accrualRateParam;
      const hasValue = input.accrualRateValue !== undefined && input.accrualRateValue !== null;
      if (hasParam === hasValue) {
        return 'rythme : EXACTEMENT une source — clé E4 (accrualRateParam) OU valeur du tenant (accrualRateValue) ; le moteur n\'a aucun défaut juridique';
      }
      if (hasParam && !PARAM_KEY_RE.test(input.accrualRateParam!)) return 'accrualRateParam : clé pointée minuscule (ex. conges.acquisition.taux_mensuel)';
      if (hasValue && !(input.accrualRateValue! > 0)) return 'accrualRateValue : strictement positif';
    }
    if (input.referencePeriod !== undefined && !['calendar_year', 'anniversary', 'custom'].includes(input.referencePeriod)) {
      return 'referencePeriod : calendar_year, anniversary ou custom';
    }
    if (input.referencePeriod === 'custom' && (!input.refStartMonth || !input.refStartDay)) {
      return 'période custom : refStartMonth et refStartDay requis';
    }
    if (input.rounding !== undefined && !['none', 'half_up_0_5', 'up_0_5', 'up_1'].includes(input.rounding)) {
      return 'rounding : none, half_up_0_5, up_0_5 ou up_1';
    }
    return null;
  }

  // ================= Résolution =================

  /**
   * Politique applicable à un salarié pour un type à une date : candidates ACTIVES
   * dont TOUS les sélecteurs non nuls correspondent ; la plus SPÉCIFIQUE gagne ;
   * une égalité de score est un CONFLIT explicite. Renvoie aussi la version datée.
   */
  async resolveFor(
    tx: Prisma.TransactionClient, tenantId: string, employeeId: string, absenceTypeId: string, date: string,
  ): Promise<
    | { kind: 'ok'; row: ResolvedPolicyRow }
    | { kind: 'none' }
    | { kind: 'ambiguous'; codes: string[] }
  > {
    const emp = await tx.$queryRaw<Array<{
      status: string; hire_date: string | null; professional_status: string | null;
      company_id: string | null; site_id: string | null;
    }>>`
      SELECT e.status, e.hire_date::text, e.professional_status, a.company_id, a.site_id
        FROM core.employees e
        LEFT JOIN core.employee_assignments a ON a.employee_id = e.id AND a.is_primary
         AND daterange(a.effective_from, a.effective_to, '[)') @> ${date}::date
       WHERE e.id = ${employeeId}::uuid AND e.deleted_at IS NULL`;
    const empRow = emp[0];
    if (!empRow) return { kind: 'none' };
    const candidates = await tx.$queryRaw<Array<{
      id: string; code: string; country_code: string | null; company_id: string | null; site_id: string | null;
      collective_agreement: string | null; professional_category: string | null; contract_type: string | null;
      employee_status: string | null; seniority_min_months: number | null; work_time: string; population_key: string | null;
      absence_type_id: string; type_code: string; unit: string;
      version: number; version_id: string; content: Record<string, unknown>;
    }>>`
      SELECT p.id, p.code, p.country_code, p.company_id, p.site_id, p.collective_agreement,
             p.professional_category, p.contract_type, p.employee_status, p.seniority_min_months,
             p.work_time, p.population_key, p.absence_type_id, t.code AS type_code, t.unit,
             v.version, v.id AS version_id,
             to_jsonb(v.*) AS content
        FROM leave.policies p
        JOIN leave.absence_types t ON t.id = p.absence_type_id
        JOIN LATERAL (
          SELECT * FROM leave.policy_versions v0
           WHERE v0.policy_id = p.id AND v0.effective_from <= ${date}::date
           ORDER BY v0.effective_from DESC LIMIT 1
        ) v ON true
       WHERE p.status = 'active' AND p.absence_type_id = ${absenceTypeId}::uuid`;
    const matches: Array<{ row: ResolvedPolicyRow; code: string }> = [];
    for (const c of candidates) {
      let score = 0;
      if (c.country_code !== null) {
        if (c.country_code !== OPERATING_COUNTRY) continue;
        score += 1;
      }
      if (c.company_id !== null) {
        if (c.company_id !== empRow.company_id) continue;
        score += 4;
      }
      if (c.site_id !== null) {
        if (c.site_id !== empRow.site_id) continue;
        score += 8;
      }
      if (c.professional_category !== null) {
        if (c.professional_category !== empRow.professional_status) continue;
        score += 2;
      }
      if (c.employee_status !== null) {
        if (c.employee_status !== empRow.status) continue;
        score += 1;
      }
      if (c.seniority_min_months !== null) {
        if (!empRow.hire_date) continue;
        const months = monthsBetween(empRow.hire_date, date);
        if (months < c.seniority_min_months) continue;
        score += 1;
      }
      // Sélecteurs SANS attribut E9 correspondant en v1 : ne matchent jamais quand renseignés (limite assumée).
      if (c.collective_agreement !== null || c.contract_type !== null || c.work_time !== 'any' || c.population_key !== null) continue;
      matches.push({
        code: c.code,
        row: {
          policyId: c.id, policyCode: c.code, policyVersion: c.version, versionId: c.version_id,
          absenceTypeId: c.absence_type_id, typeCode: c.type_code, unit: c.unit,
          score, content: c.content,
        },
      });
    }
    if (matches.length === 0) return { kind: 'none' };
    matches.sort((a, b) => b.row.score - a.row.score);
    if (matches.length > 1 && matches[0]!.row.score === matches[1]!.row.score) {
      return { kind: 'ambiguous', codes: matches.filter((m) => m.row.score === matches[0]!.row.score).map((m) => m.code) };
    }
    return { kind: 'ok', row: matches[0]!.row };
  }

  async resolve(
    tenantId: string, actor: string, employeeId: string, absenceTypeId: string, date: string,
  ): Promise<TimeOutcome<{ resolution: unknown }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'leave.policies_admin', 'leave.accrual_run', 'leave.balance_view'))) {
        return { kind: 'forbidden', reason: 'permission requise : leave.policies_admin' };
      }
      const r = await this.resolveFor(tx, tenantId, employeeId, absenceTypeId, date);
      if (r.kind === 'ambiguous') {
        return { kind: 'conflict', reason: `politiques AMBIGUËS à cette date (spécificité égale) : ${r.codes.join(', ')} — corrigez les populations, aucun choix silencieux` };
      }
      return { kind: 'ok', resolution: r.kind === 'ok' ? r.row : null };
    });
  }

  /** Aperçu de la population couverte par une politique à une date. */
  async population(
    tenantId: string, actor: string, policyId: string, date: string,
  ): Promise<TimeOutcome<{ count: number; sample: unknown[] }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'leave.policies_admin', 'leave.accrual_run'))) {
        return { kind: 'forbidden', reason: 'permission requise : leave.policies_admin' };
      }
      const pol = await tx.$queryRaw<Array<{ absence_type_id: string }>>`
        SELECT absence_type_id FROM leave.policies WHERE id = ${policyId}::uuid`;
      if (pol.length === 0) return { kind: 'not_found' };
      const emps = await tx.$queryRaw<Array<{ id: string; matricule: string; first_name: string; last_name: string }>>`
        SELECT id, matricule, first_name, last_name FROM core.employees
         WHERE deleted_at IS NULL AND status IN ('active', 'on_leave', 'suspended') ORDER BY matricule LIMIT 500`;
      let count = 0;
      const sample: unknown[] = [];
      for (const e of emps) {
        const r = await this.resolveFor(tx, tenantId, e.id, pol[0]!.absence_type_id, date);
        if (r.kind === 'ok' && r.row.policyId === policyId) {
          count += 1;
          if (sample.length < 20) sample.push({ employeeId: e.id, matricule: e.matricule, firstName: e.first_name, lastName: e.last_name });
        }
      }
      return { kind: 'ok', count, sample };
    });
  }

  /** Rythme et bornes RÉSOLUS (E4 à la date OU valeur de version) avec provenance. */
  async resolveRates(
    tx: Prisma.TransactionClient, tenantId: string, row: ResolvedPolicyRow, date: string,
  ): Promise<{
    accrualRate: number | null; rateSource: Record<string, unknown>;
    carryOverMax: number | null; capValue: number | null;
    paramsUsed: Record<string, unknown>;
  }> {
    const c = row.content;
    const keys: string[] = [];
    for (const k of ['accrual_rate_param', 'carry_over_max_param', 'cap_param', 'eligibility_min_months_param']) {
      if (typeof c[k] === 'string' && c[k]) keys.push(c[k] as string);
    }
    const resolved = await paramsAt(tx, tenantId, date, keys);
    const paramsUsed: Record<string, unknown> = {};
    const pick = (paramKey: unknown, value: unknown): number | null => {
      if (typeof paramKey === 'string' && paramKey) {
        const p = resolved[paramKey];
        const n = numericParam(p);
        paramsUsed[paramKey] = p ?? { source: 'absent' };
        return n;
      }
      return typeof value === 'number' ? value : value === null || value === undefined ? null : Number(value);
    };
    const accrualRate = pick(c['accrual_rate_param'], c['accrual_rate_value']);
    const carryOverMax = pick(c['carry_over_max_param'], c['carry_over_max_value']);
    const capValue = pick(c['cap_param'], c['cap_value']);
    const rateSource = typeof c['accrual_rate_param'] === 'string' && c['accrual_rate_param']
      ? { kind: 'parameter', key: c['accrual_rate_param'], ...(resolved[c['accrual_rate_param'] as string] ?? {}) }
      : { kind: 'policy_value', value: c['accrual_rate_value'] };
    return { accrualRate, rateSource, carryOverMax, capValue, paramsUsed };
  }
}

export function monthsBetween(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.split('-').map(Number);
  const [ty, tm, td] = toIso.split('-').map(Number);
  let months = (ty! - fy!) * 12 + (tm! - fm!);
  if (td! < fd!) months -= 1;
  return months;
}
