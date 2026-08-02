/**
 * E10.1 — Horaires : modèles versionnés (le passé est figé PAR LA BASE), rotations,
 * affectations datées (chevauchement rejeté par PostgreSQL), fériés versionnés,
 * exceptions individuelles/collectives, horaire APPLICABLE à une date.
 *
 * AUCUNE règle juridique ici : durées, tolérances, seuils, majorations sont des
 * paramètres E4 (famille de clés temps.*) que le moteur E10.2 résoudra à la date de l'événement.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { auditAuth } from '../auth/audit.util';
import { rotationDayIndex } from '../../../../packages/core/src/time.ts';
import {
  CODE_RE, DATE_RE, holdsPermission, scopeSetFor, scopeCsv, type TimeOutcome,
} from './time-access';

export interface ScheduleDayInput {
  dayIndex: number;
  isRest: boolean;
  startMinute?: number | null;
  endMinute?: number | null;
  breakStartMinute?: number | null;
  breakEndMinute?: number | null;
  label?: string | null;
}

const today = () => new Date().toISOString().slice(0, 10);

@Injectable()
export class SchedulesService {
  constructor(private readonly prisma: PrismaService) {}

  // ------------------------------------------------------------------
  // Modèles et versions
  // ------------------------------------------------------------------

  async listModels(tenantId: string, actor: string): Promise<TimeOutcome<{ items: unknown[] }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'time.schedules_view', 'time.schedules_manage', 'time.schedules_assign'))) {
        return { kind: 'forbidden', reason: 'permission requise : time.schedules_view' };
      }
      const items = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT m.id, m.code, m.label_fr AS "labelFr", m.label_en AS "labelEn", m.kind, m.status,
               (SELECT count(*)::int FROM time.schedule_versions v WHERE v.model_id = m.id) AS "versionCount",
               (SELECT max(v.effective_from)::text FROM time.schedule_versions v WHERE v.model_id = m.id) AS "lastEffectiveFrom",
               (SELECT count(*)::int FROM time.employee_schedules es WHERE es.model_id = m.id
                 AND daterange(es.effective_from, es.effective_to, '[)') @> current_date) AS "assignedToday"
          FROM time.schedule_models m
         ORDER BY m.code`;
      return { kind: 'ok', items };
    });
  }

  async getModel(tenantId: string, actor: string, id: string): Promise<TimeOutcome<{ model: unknown }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'time.schedules_view', 'time.schedules_manage', 'time.schedules_assign'))) {
        return { kind: 'forbidden', reason: 'permission requise : time.schedules_view' };
      }
      const models = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT id, code, label_fr AS "labelFr", label_en AS "labelEn", kind, status
          FROM time.schedule_models WHERE id = ${id}::uuid`;
      const model = models[0];
      if (!model) return { kind: 'not_found' };
      const versions = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT v.id, v.version, v.effective_from::text AS "effectiveFrom", v.cycle_days AS "cycleDays", v.notes
          FROM time.schedule_versions v WHERE v.model_id = ${id}::uuid ORDER BY v.version`;
      const days = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT d.version_id AS "versionId", d.day_index AS "dayIndex", d.is_rest AS "isRest",
               d.start_minute AS "startMinute", d.end_minute AS "endMinute",
               d.break_start_minute AS "breakStartMinute", d.break_end_minute AS "breakEndMinute", d.label
          FROM time.schedule_version_days d
          JOIN time.schedule_versions v ON v.id = d.version_id
         WHERE v.model_id = ${id}::uuid
         ORDER BY d.day_index`;
      return {
        kind: 'ok',
        model: {
          ...model,
          versions: versions.map((v) => ({ ...v, days: days.filter((d) => d['versionId'] === v['id']) })),
        },
      };
    });
  }

  async createModel(
    tenantId: string, actor: string,
    input: { code: string; labelFr: string; labelEn: string; kind: 'fixed' | 'rotation' },
  ): Promise<TimeOutcome<{ id: string }>> {
    if (!CODE_RE.test(input.code)) return { kind: 'invalid', reason: 'code invalide (A-Z 0-9 _ -, 30 max)' };
    return this.prisma.withTenant(tenantId, async (tx) => {
      const dup = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM time.schedule_models WHERE code = ${input.code}`;
      if (dup.length > 0) return { kind: 'conflict', reason: `code « ${input.code} » déjà utilisé` };
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO time.schedule_models (tenant_id, code, label_fr, label_en, kind, created_by)
        VALUES (${tenantId}::uuid, ${input.code}, ${input.labelFr}, ${input.labelEn}, ${input.kind}, ${actor}::uuid)
        RETURNING id`;
      const id = rows[0]!.id;
      await auditAuth(tx, tenantId, {
        action: 'time_schedule_model_created', actorUserId: actor, module: 'time',
        recordType: 'schedule_model', recordId: id, newValue: input, result: 'success',
      });
      return { kind: 'ok', id };
    });
  }

  async retireModel(tenantId: string, actor: string, id: string): Promise<TimeOutcome<Record<never, never>>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT status FROM time.schedule_models WHERE id = ${id}::uuid`;
      if (rows.length === 0) return { kind: 'not_found' };
      if (rows[0]!.status === 'retired') return { kind: 'conflict', reason: 'modèle déjà retiré' };
      const active = await tx.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM time.employee_schedules
         WHERE model_id = ${id}::uuid AND daterange(effective_from, effective_to, '[)') @> current_date`;
      if ((active[0]?.n ?? 0) > 0) {
        return { kind: 'conflict', reason: `${active[0]!.n} affectation(s) en cours : clôturer d'abord` };
      }
      await tx.$executeRaw`UPDATE time.schedule_models SET status = 'retired' WHERE id = ${id}::uuid`;
      await auditAuth(tx, tenantId, {
        action: 'time_schedule_model_retired', actorUserId: actor, module: 'time',
        recordType: 'schedule_model', recordId: id, result: 'success',
      });
      return { kind: 'ok' };
    });
  }

  async addVersion(
    tenantId: string, actor: string, modelId: string,
    input: { effectiveFrom: string; cycleDays: number; days: ScheduleDayInput[]; notes?: string | null },
  ): Promise<TimeOutcome<{ id: string; version: number }>> {
    if (!DATE_RE.test(input.effectiveFrom)) return { kind: 'invalid', reason: 'effectiveFrom : AAAA-MM-JJ' };
    if (!Number.isInteger(input.cycleDays) || input.cycleDays < 1 || input.cycleDays > 42) {
      return { kind: 'invalid', reason: 'cycleDays : entier entre 1 et 42' };
    }
    // Le cycle doit être COMPLET et sans trou : un jour non décrit serait une ambiguïté.
    const seen = new Set<number>();
    for (const d of input.days) {
      if (!Number.isInteger(d.dayIndex) || d.dayIndex < 0 || d.dayIndex >= input.cycleDays) {
        return { kind: 'invalid', reason: `dayIndex ${d.dayIndex} hors du cycle (0..${input.cycleDays - 1})` };
      }
      if (seen.has(d.dayIndex)) return { kind: 'invalid', reason: `jour ${d.dayIndex} décrit deux fois` };
      seen.add(d.dayIndex);
    }
    if (seen.size !== input.cycleDays) {
      return { kind: 'invalid', reason: `cycle incomplet : ${seen.size}/${input.cycleDays} jours décrits` };
    }
    return this.prisma.withTenant(tenantId, async (tx) => {
      const model = await tx.$queryRaw<Array<{ status: string; kind: string }>>`
        SELECT status, kind FROM time.schedule_models WHERE id = ${modelId}::uuid`;
      if (model.length === 0) return { kind: 'not_found' };
      if (model[0]!.status !== 'active') return { kind: 'conflict', reason: 'modèle retiré' };
      const last = await tx.$queryRaw<Array<{ v: number | null }>>`
        SELECT max(version)::int AS v FROM time.schedule_versions WHERE model_id = ${modelId}::uuid`;
      const version = (last[0]?.v ?? 0) + 1;
      let versionId: string;
      try {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO time.schedule_versions (tenant_id, model_id, version, effective_from, cycle_days, notes, created_by)
          VALUES (${tenantId}::uuid, ${modelId}::uuid, ${version}, ${input.effectiveFrom}::date,
                  ${input.cycleDays}, ${input.notes ?? null}, ${actor}::uuid)
          RETURNING id`;
        versionId = rows[0]!.id;
        for (const d of input.days) {
          await tx.$executeRaw`
            INSERT INTO time.schedule_version_days
              (tenant_id, version_id, day_index, is_rest, start_minute, end_minute, break_start_minute, break_end_minute, label)
            VALUES (${tenantId}::uuid, ${versionId}::uuid, ${d.dayIndex}, ${d.isRest},
                    ${d.isRest ? null : d.startMinute ?? null}, ${d.isRest ? null : d.endMinute ?? null},
                    ${d.isRest ? null : d.breakStartMinute ?? null}, ${d.isRest ? null : d.breakEndMinute ?? null},
                    ${d.label ?? null})`;
        }
      } catch (e) {
        // Les gardes BASE parlent : date passée, numérotation, formes de plages.
        return { kind: 'invalid', reason: (e as Error).message.split('\n')[0] ?? 'version refusée par la base' };
      }
      await auditAuth(tx, tenantId, {
        action: 'time_schedule_version_added', actorUserId: actor, module: 'time',
        recordType: 'schedule_version', recordId: versionId,
        newValue: { modelId, version, effectiveFrom: input.effectiveFrom, cycleDays: input.cycleDays },
        result: 'success',
      });
      return { kind: 'ok', id: versionId, version };
    });
  }

  // ------------------------------------------------------------------
  // Affectations
  // ------------------------------------------------------------------

  async listAssignments(
    tenantId: string, actor: string,
    opts: { employeeId?: string; unitId?: string; at?: string; limit?: number; offset?: number },
  ): Promise<TimeOutcome<{ items: unknown[] }>> {
    const at = opts.at ?? today();
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'time.schedules_view', 'time.schedules_manage', 'time.schedules_assign'))) {
        return { kind: 'forbidden', reason: 'permission requise : time.schedules_view' };
      }
      const items = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT es.id, es.employee_id AS "employeeId", e.matricule,
               e.first_name AS "firstName", e.last_name AS "lastName",
               es.model_id AS "modelId", m.code AS "modelCode", m.label_fr AS "modelLabelFr", m.label_en AS "modelLabelEn",
               es.anchor_date::text AS "anchorDate", es.effective_from::text AS "effectiveFrom", es.effective_to::text AS "effectiveTo"
          FROM time.employee_schedules es
          JOIN core.employees e ON e.id = es.employee_id
          JOIN time.schedule_models m ON m.id = es.model_id
         WHERE (${opts.employeeId ?? null}::uuid IS NULL OR es.employee_id = ${opts.employeeId ?? null}::uuid)
           AND (${opts.at ?? null}::date IS NULL OR daterange(es.effective_from, es.effective_to, '[)') @> ${at}::date)
           AND (${opts.unitId ?? null}::uuid IS NULL OR EXISTS (
                 SELECT 1 FROM core.employee_assignments a
                  WHERE a.employee_id = es.employee_id AND a.is_primary
                    AND daterange(a.effective_from, a.effective_to, '[)') @> ${at}::date
                    AND a.unit_id = ${opts.unitId ?? null}::uuid))
         ORDER BY e.matricule, es.effective_from DESC
         LIMIT ${limit} OFFSET ${offset}`;
      return { kind: 'ok', items };
    });
  }

  async assign(
    tenantId: string, actor: string,
    input: { employeeId: string; modelId: string; anchorDate: string; effectiveFrom: string; closePrevious?: boolean },
  ): Promise<TimeOutcome<{ id: string }>> {
    if (!DATE_RE.test(input.anchorDate) || !DATE_RE.test(input.effectiveFrom)) {
      return { kind: 'invalid', reason: 'anchorDate/effectiveFrom : AAAA-MM-JJ' };
    }
    return this.prisma.withTenant(tenantId, async (tx) => {
      const emp = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM core.employees WHERE id = ${input.employeeId}::uuid AND deleted_at IS NULL`;
      if (emp.length === 0) return { kind: 'not_found' };
      const model = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT status FROM time.schedule_models WHERE id = ${input.modelId}::uuid`;
      if (model.length === 0) return { kind: 'not_found' };
      if (model[0]!.status !== 'active') return { kind: 'conflict', reason: 'modèle retiré' };
      if (input.closePrevious === true) {
        // Clôture EXPLICITE de l'affectation ouverte qui chevaucherait (jamais implicite).
        await tx.$executeRaw`
          UPDATE time.employee_schedules SET effective_to = ${input.effectiveFrom}::date
           WHERE employee_id = ${input.employeeId}::uuid AND effective_to IS NULL
             AND effective_from < ${input.effectiveFrom}::date`;
      }
      try {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO time.employee_schedules (tenant_id, employee_id, model_id, anchor_date, effective_from, created_by)
          VALUES (${tenantId}::uuid, ${input.employeeId}::uuid, ${input.modelId}::uuid,
                  ${input.anchorDate}::date, ${input.effectiveFrom}::date, ${actor}::uuid)
          RETURNING id`;
        const id = rows[0]!.id;
        await auditAuth(tx, tenantId, {
          action: 'time_schedule_assigned', actorUserId: actor, module: 'time',
          recordType: 'employee_schedule', recordId: id,
          newValue: { employeeId: input.employeeId, modelId: input.modelId, anchorDate: input.anchorDate, effectiveFrom: input.effectiveFrom },
          result: 'success',
        });
        return { kind: 'ok', id };
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes('employee_schedule_no_overlap')) {
          return { kind: 'conflict', reason: 'affectation horaire déjà présente sur la période — clôturer avant, ou closePrevious' };
        }
        throw e;
      }
    });
  }

  /** Affectation COLLECTIVE : tous les salariés dont l'affectation principale à la date vise l'unité. */
  async assignByUnit(
    tenantId: string, actor: string,
    input: { unitId: string; modelId: string; anchorDate: string; effectiveFrom: string; closePrevious?: boolean },
  ): Promise<TimeOutcome<{ assigned: number; skipped: number }>> {
    if (!DATE_RE.test(input.anchorDate) || !DATE_RE.test(input.effectiveFrom)) {
      return { kind: 'invalid', reason: 'anchorDate/effectiveFrom : AAAA-MM-JJ' };
    }
    return this.prisma.withTenant(tenantId, async (tx) => {
      const model = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT status FROM time.schedule_models WHERE id = ${input.modelId}::uuid`;
      if (model.length === 0) return { kind: 'not_found' };
      if (model[0]!.status !== 'active') return { kind: 'conflict', reason: 'modèle retiré' };
      const members = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT e.id FROM core.employees e
         WHERE e.deleted_at IS NULL AND e.status IN ('active', 'pre_hire')
           AND EXISTS (SELECT 1 FROM core.employee_assignments a
                        WHERE a.employee_id = e.id AND a.is_primary AND a.unit_id = ${input.unitId}::uuid
                          AND daterange(a.effective_from, a.effective_to, '[)') @> ${input.effectiveFrom}::date)`;
      let assigned = 0;
      let skipped = 0;
      for (const m of members) {
        if (input.closePrevious === true) {
          await tx.$executeRaw`
            UPDATE time.employee_schedules SET effective_to = ${input.effectiveFrom}::date
             WHERE employee_id = ${m.id}::uuid AND effective_to IS NULL
               AND effective_from < ${input.effectiveFrom}::date`;
        }
        try {
          await tx.$executeRaw`
            INSERT INTO time.employee_schedules (tenant_id, employee_id, model_id, anchor_date, effective_from, created_by)
            VALUES (${tenantId}::uuid, ${m.id}::uuid, ${input.modelId}::uuid,
                    ${input.anchorDate}::date, ${input.effectiveFrom}::date, ${actor}::uuid)`;
          assigned += 1;
        } catch (e) {
          if ((e as Error).message.includes('employee_schedule_no_overlap')) skipped += 1;
          else throw e;
        }
      }
      await auditAuth(tx, tenantId, {
        action: 'time_schedule_assigned_by_unit', actorUserId: actor, module: 'time',
        recordType: 'employee_schedule', recordId: input.unitId,
        newValue: { unitId: input.unitId, modelId: input.modelId, effectiveFrom: input.effectiveFrom, assigned, skipped },
        result: 'success',
      });
      return { kind: 'ok', assigned, skipped };
    });
  }

  async closeAssignment(
    tenantId: string, actor: string, id: string, effectiveTo: string,
  ): Promise<TimeOutcome<Record<never, never>>> {
    if (!DATE_RE.test(effectiveTo)) return { kind: 'invalid', reason: 'effectiveTo : AAAA-MM-JJ' };
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ effective_to: string | null }>>`
        SELECT effective_to::text FROM time.employee_schedules WHERE id = ${id}::uuid`;
      if (rows.length === 0) return { kind: 'not_found' };
      if (rows[0]!.effective_to !== null) return { kind: 'conflict', reason: 'affectation déjà close' };
      try {
        await tx.$executeRaw`
          UPDATE time.employee_schedules SET effective_to = ${effectiveTo}::date WHERE id = ${id}::uuid`;
      } catch (e) {
        return { kind: 'invalid', reason: (e as Error).message.split('\n')[0] ?? 'clôture refusée' };
      }
      await auditAuth(tx, tenantId, {
        action: 'time_schedule_assignment_closed', actorUserId: actor, module: 'time',
        recordType: 'employee_schedule', recordId: id, newValue: { effectiveTo }, result: 'success',
      });
      return { kind: 'ok' };
    });
  }

  // ------------------------------------------------------------------
  // Horaire APPLICABLE à une date (salarié) — rotation + exceptions + férié.
  // ------------------------------------------------------------------

  async employeeScheduleAt(
    tenantId: string, actor: string, employeeId: string, date: string, opts: { self?: boolean } = {},
  ): Promise<TimeOutcome<{ schedule: unknown }>> {
    if (!DATE_RE.test(date)) return { kind: 'invalid', reason: 'date : AAAA-MM-JJ' };
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!opts.self) {
        const set = await scopeSetFor(tx, actor, 'time.schedules_view');
        const alt = set.kind !== 'none' ? set : await scopeSetFor(tx, actor, 'time.schedules_assign');
        if (alt.kind === 'none') return { kind: 'forbidden', reason: 'permission requise : time.schedules_view' };
        if (alt.kind === 'scoped') {
          const csv = scopeCsv(alt);
          const covered = await tx.$queryRaw<Array<{ ok: boolean }>>`
            SELECT EXISTS (SELECT 1 FROM core.employee_assignments a
                            WHERE a.employee_id = ${employeeId}::uuid AND a.is_primary
                              AND daterange(a.effective_from, a.effective_to, '[)') @> ${date}::date
                              AND (a.company_id = ANY(string_to_array(${csv.companies}, ',')::uuid[])
                                OR a.site_id    = ANY(string_to_array(${csv.sites}, ',')::uuid[])
                                OR a.unit_id    = ANY(string_to_array(${csv.units}, ',')::uuid[]))) AS ok`;
          if (!covered[0]?.ok) return { kind: 'not_found' };
        }
      }
      return { kind: 'ok', schedule: await this.resolveScheduleAt(tx, employeeId, date) };
    });
  }

  /** Résolution PARTAGEABLE (aussi utilisée par l'écran salarié et E10.2 plus tard). */
  private async resolveScheduleAt(tx: Prisma.TransactionClient, employeeId: string, date: string): Promise<unknown> {
    const asg = await tx.$queryRaw<Array<{ id: string; model_id: string; anchor_date: string; code: string; label_fr: string; label_en: string; kind: string }>>`
      SELECT es.id, es.model_id, es.anchor_date::text, m.code, m.label_fr, m.label_en, m.kind
        FROM time.employee_schedules es JOIN time.schedule_models m ON m.id = es.model_id
       WHERE es.employee_id = ${employeeId}::uuid
         AND daterange(es.effective_from, es.effective_to, '[)') @> ${date}::date
       LIMIT 1`;
    if (asg.length === 0) return { assigned: false };
    const a = asg[0]!;
    // Version applicable : la plus récente dont la date d'effet est ≤ date.
    const ver = await tx.$queryRaw<Array<{ id: string; version: number; cycle_days: number; effective_from: string }>>`
      SELECT id, version, cycle_days, effective_from::text FROM time.schedule_versions
       WHERE model_id = ${a.model_id}::uuid AND effective_from <= ${date}::date
       ORDER BY effective_from DESC LIMIT 1`;
    if (ver.length === 0) return { assigned: true, modelCode: a.code, applicableVersion: null };
    const v = ver[0]!;
    const dayIndex = rotationDayIndex(date, a.anchor_date, v.cycle_days);
    const day = await tx.$queryRaw<Array<Record<string, unknown>>>`
      SELECT is_rest AS "isRest", start_minute AS "startMinute", end_minute AS "endMinute",
             break_start_minute AS "breakStartMinute", break_end_minute AS "breakEndMinute", label
        FROM time.schedule_version_days WHERE version_id = ${v.id}::uuid AND day_index = ${dayIndex}`;
    // Exceptions applicables : individuelle > unité > site > société (la plus précise gagne).
    const exceptions = await tx.$queryRaw<Array<Record<string, unknown>>>`
      SELECT x.kind, x.start_minute AS "startMinute", x.end_minute AS "endMinute",
             x.label_fr AS "labelFr", x.label_en AS "labelEn",
             CASE WHEN x.employee_id IS NOT NULL THEN 'employee'
                  WHEN x.unit_id IS NOT NULL THEN 'unit'
                  WHEN x.site_id IS NOT NULL THEN 'site' ELSE 'company' END AS target
        FROM time.schedule_exceptions x
       WHERE x.exception_date = ${date}::date AND x.status = 'active'
         AND (x.employee_id = ${employeeId}::uuid
           OR EXISTS (SELECT 1 FROM core.employee_assignments a2
                       WHERE a2.employee_id = ${employeeId}::uuid AND a2.is_primary
                         AND daterange(a2.effective_from, a2.effective_to, '[)') @> ${date}::date
                         AND (a2.unit_id = x.unit_id OR a2.site_id = x.site_id OR a2.company_id = x.company_id)))
       ORDER BY CASE WHEN x.employee_id IS NOT NULL THEN 0 WHEN x.unit_id IS NOT NULL THEN 1
                     WHEN x.site_id IS NOT NULL THEN 2 ELSE 3 END`;
    const holidays = await tx.$queryRaw<Array<Record<string, unknown>>>`
      SELECT h.label_fr AS "labelFr", h.label_en AS "labelEn", c.code AS "calendarCode"
        FROM time.holidays h JOIN time.holiday_calendars c ON c.id = h.calendar_id
       WHERE h.holiday_date = ${date}::date AND h.status = 'active' AND c.status = 'active'
         AND (c.company_id IS NULL AND c.site_id IS NULL AND c.unit_id IS NULL
           OR EXISTS (SELECT 1 FROM core.employee_assignments a3
                       WHERE a3.employee_id = ${employeeId}::uuid AND a3.is_primary
                         AND daterange(a3.effective_from, a3.effective_to, '[)') @> ${date}::date
                         AND (a3.company_id = c.company_id OR a3.site_id = c.site_id OR a3.unit_id = c.unit_id)))`;
    return {
      assigned: true,
      date,
      modelCode: a.code,
      modelLabelFr: a.label_fr,
      modelLabelEn: a.label_en,
      modelKind: a.kind,
      applicableVersion: v.version,
      versionEffectiveFrom: v.effective_from,
      cycleDays: v.cycle_days,
      anchorDate: a.anchor_date,
      dayIndex,
      day: day[0] ?? null,
      exception: exceptions[0] ?? null,
      holidays,
    };
  }

  // ------------------------------------------------------------------
  // Fériés et exceptions
  // ------------------------------------------------------------------

  async listHolidays(
    tenantId: string, actor: string, opts: { calendarId?: string; year?: number },
  ): Promise<TimeOutcome<{ calendars: unknown[]; holidays: unknown[] }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'time.schedules_view', 'time.schedules_manage'))) {
        return { kind: 'forbidden', reason: 'permission requise : time.schedules_view' };
      }
      const calendars = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT c.id, c.code, c.label_fr AS "labelFr", c.label_en AS "labelEn", c.status,
               c.company_id AS "companyId", c.site_id AS "siteId", c.unit_id AS "unitId"
          FROM time.holiday_calendars c ORDER BY c.code`;
      const holidays = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT h.id, h.calendar_id AS "calendarId", h.holiday_date::text AS "date",
               h.label_fr AS "labelFr", h.label_en AS "labelEn", h.status
          FROM time.holidays h
         WHERE (${opts.calendarId ?? null}::uuid IS NULL OR h.calendar_id = ${opts.calendarId ?? null}::uuid)
           AND (${opts.year ?? null}::int IS NULL OR EXTRACT(YEAR FROM h.holiday_date)::int = ${opts.year ?? null}::int)
         ORDER BY h.holiday_date`;
      return { kind: 'ok', calendars, holidays };
    });
  }

  async createCalendar(
    tenantId: string, actor: string,
    input: { code: string; labelFr: string; labelEn: string; companyId?: string; siteId?: string; unitId?: string },
  ): Promise<TimeOutcome<{ id: string }>> {
    if (!CODE_RE.test(input.code)) return { kind: 'invalid', reason: 'code invalide' };
    return this.prisma.withTenant(tenantId, async (tx) => {
      const dup = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM time.holiday_calendars WHERE code = ${input.code}`;
      if (dup.length > 0) return { kind: 'conflict', reason: `code « ${input.code} » déjà utilisé` };
      try {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO time.holiday_calendars (tenant_id, code, label_fr, label_en, company_id, site_id, unit_id, created_by)
          VALUES (${tenantId}::uuid, ${input.code}, ${input.labelFr}, ${input.labelEn},
                  ${input.companyId ?? null}::uuid, ${input.siteId ?? null}::uuid, ${input.unitId ?? null}::uuid, ${actor}::uuid)
          RETURNING id`;
        const id = rows[0]!.id;
        await auditAuth(tx, tenantId, {
          action: 'time_holiday_calendar_created', actorUserId: actor, module: 'time',
          recordType: 'holiday_calendar', recordId: id, newValue: input, result: 'success',
        });
        return { kind: 'ok', id };
      } catch (e) {
        return { kind: 'invalid', reason: (e as Error).message.split('\n')[0] ?? 'calendrier refusé' };
      }
    });
  }

  async addHoliday(
    tenantId: string, actor: string,
    input: { calendarId: string; date: string; labelFr: string; labelEn: string },
  ): Promise<TimeOutcome<{ id: string }>> {
    if (!DATE_RE.test(input.date)) return { kind: 'invalid', reason: 'date : AAAA-MM-JJ' };
    return this.prisma.withTenant(tenantId, async (tx) => {
      const cal = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM time.holiday_calendars WHERE id = ${input.calendarId}::uuid AND status = 'active'`;
      if (cal.length === 0) return { kind: 'not_found' };
      const dup = await tx.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT id, status FROM time.holidays WHERE calendar_id = ${input.calendarId}::uuid AND holiday_date = ${input.date}::date`;
      if (dup.length > 0) {
        if (dup[0]!.status === 'active') return { kind: 'conflict', reason: 'date déjà fériée dans ce calendrier' };
        // Réactivation VERSIONNÉE d'une date retirée (la ligne garde son histoire).
        await tx.$executeRaw`
          UPDATE time.holidays SET status = 'active', label_fr = ${input.labelFr}, label_en = ${input.labelEn}
           WHERE id = ${dup[0]!.id}::uuid`;
        await auditAuth(tx, tenantId, {
          action: 'time_holiday_reactivated', actorUserId: actor, module: 'time',
          recordType: 'holiday', recordId: dup[0]!.id, newValue: input, result: 'success',
        });
        return { kind: 'ok', id: dup[0]!.id };
      }
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO time.holidays (tenant_id, calendar_id, holiday_date, label_fr, label_en, created_by)
        VALUES (${tenantId}::uuid, ${input.calendarId}::uuid, ${input.date}::date, ${input.labelFr}, ${input.labelEn}, ${actor}::uuid)
        RETURNING id`;
      await auditAuth(tx, tenantId, {
        action: 'time_holiday_added', actorUserId: actor, module: 'time',
        recordType: 'holiday', recordId: rows[0]!.id, newValue: input, result: 'success',
      });
      return { kind: 'ok', id: rows[0]!.id };
    });
  }

  async retireHoliday(tenantId: string, actor: string, id: string): Promise<TimeOutcome<Record<never, never>>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT status FROM time.holidays WHERE id = ${id}::uuid`;
      if (rows.length === 0) return { kind: 'not_found' };
      if (rows[0]!.status === 'retired') return { kind: 'conflict', reason: 'férié déjà retiré' };
      await tx.$executeRaw`UPDATE time.holidays SET status = 'retired' WHERE id = ${id}::uuid`;
      await auditAuth(tx, tenantId, {
        action: 'time_holiday_retired', actorUserId: actor, module: 'time',
        recordType: 'holiday', recordId: id, result: 'success',
      });
      return { kind: 'ok' };
    });
  }

  async listExceptions(
    tenantId: string, actor: string, opts: { from?: string; to?: string },
  ): Promise<TimeOutcome<{ items: unknown[] }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'time.schedules_view', 'time.schedules_manage'))) {
        return { kind: 'forbidden', reason: 'permission requise : time.schedules_view' };
      }
      const items = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT x.id, x.exception_date::text AS "date", x.kind, x.status,
               x.start_minute AS "startMinute", x.end_minute AS "endMinute",
               x.label_fr AS "labelFr", x.label_en AS "labelEn",
               x.employee_id AS "employeeId", x.unit_id AS "unitId", x.site_id AS "siteId", x.company_id AS "companyId"
          FROM time.schedule_exceptions x
         WHERE (${opts.from ?? null}::date IS NULL OR x.exception_date >= ${opts.from ?? null}::date)
           AND (${opts.to ?? null}::date IS NULL OR x.exception_date <= ${opts.to ?? null}::date)
         ORDER BY x.exception_date DESC LIMIT 500`;
      return { kind: 'ok', items };
    });
  }

  async createException(
    tenantId: string, actor: string,
    input: { date: string; kind: 'closed' | 'rest' | 'special_hours'; labelFr: string; labelEn: string;
             employeeId?: string; unitId?: string; siteId?: string; companyId?: string;
             startMinute?: number | null; endMinute?: number | null },
  ): Promise<TimeOutcome<{ id: string }>> {
    if (!DATE_RE.test(input.date)) return { kind: 'invalid', reason: 'date : AAAA-MM-JJ' };
    return this.prisma.withTenant(tenantId, async (tx) => {
      try {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO time.schedule_exceptions
            (tenant_id, exception_date, kind, label_fr, label_en, employee_id, unit_id, site_id, company_id,
             start_minute, end_minute, created_by)
          VALUES (${tenantId}::uuid, ${input.date}::date, ${input.kind}, ${input.labelFr}, ${input.labelEn},
                  ${input.employeeId ?? null}::uuid, ${input.unitId ?? null}::uuid,
                  ${input.siteId ?? null}::uuid, ${input.companyId ?? null}::uuid,
                  ${input.kind === 'special_hours' ? input.startMinute ?? null : null},
                  ${input.kind === 'special_hours' ? input.endMinute ?? null : null}, ${actor}::uuid)
          RETURNING id`;
        const id = rows[0]!.id;
        await auditAuth(tx, tenantId, {
          action: 'time_schedule_exception_created', actorUserId: actor, module: 'time',
          recordType: 'schedule_exception', recordId: id, newValue: input, result: 'success',
        });
        return { kind: 'ok', id };
      } catch (e) {
        return { kind: 'invalid', reason: (e as Error).message.split('\n')[0] ?? 'exception refusée' };
      }
    });
  }

  async retireException(tenantId: string, actor: string, id: string): Promise<TimeOutcome<Record<never, never>>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT status FROM time.schedule_exceptions WHERE id = ${id}::uuid`;
      if (rows.length === 0) return { kind: 'not_found' };
      if (rows[0]!.status === 'retired') return { kind: 'conflict', reason: 'exception déjà retirée' };
      await tx.$executeRaw`UPDATE time.schedule_exceptions SET status = 'retired' WHERE id = ${id}::uuid`;
      await auditAuth(tx, tenantId, {
        action: 'time_schedule_exception_retired', actorUserId: actor, module: 'time',
        recordType: 'schedule_exception', recordId: id, result: 'success',
      });
      return { kind: 'ok' };
    });
  }
}
