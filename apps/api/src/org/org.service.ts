import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { auditAuth } from '../auth/audit.util';
import { WorkflowService } from '../workflow/workflow.service';
import { NotificationService } from '../notify/notification.service';
import { canTransitionOrgStatus, ORG_CODE_RE, UNIT_TYPES, type OrgStatus } from '../../../../packages/core/src/org.ts';
import { can, type PrincipalAccess, type ScopeType } from '../../../../packages/core/src/rbac.ts';

/**
 * Référentiel organisationnel (E8). Tenant = frontière de sécurité ; Company = entité
 * juridique DANS le tenant. Historisation par dates d'effet : une réorganisation FERME
 * la période courante et OUVRE une nouvelle ligne — jamais de réécriture (gardes SQL).
 * Discipline transactionnelle : résultats métier, exceptions HTTP côté contrôleur.
 * Toute opération d'administration est auditée AVEC valeurs avant/après (module 'org',
 * couvertes par la chaîne de hachage, masquées à la lecture par E6).
 */

export type OrgEntity = 'company' | 'site' | 'cost_center' | 'job' | 'unit' | 'position';

export type CreateOutcome =
  | { kind: 'ok'; id: string }
  | { kind: 'invalid'; reason: string }
  | { kind: 'duplicate_code' }
  | { kind: 'ref_not_found'; ref: string };

export type StatusOutcome =
  | { kind: 'ok'; status: OrgStatus }
  | { kind: 'not_found' }
  | { kind: 'invalid_transition'; from: string }
  | { kind: 'children_active'; units: number; positions: number };

export type MoveOutcome =
  | { kind: 'ok'; effectiveFrom: string; parentUnitId: string | null }
  | { kind: 'submitted'; pendingChangeId: string; workflowInstanceId: string }
  | { kind: 'not_found' }
  | { kind: 'forbidden'; reason: string }
  | { kind: 'cycle' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'no_active_definition' };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LIMIT = (n: number | undefined, def = 50) => Math.min(Math.max(n ?? def, 1), 200);

interface LabelInput {
  code: string;
  labelFr: string;
  labelEn: string;
}

function checkBase(input: LabelInput): string | null {
  if (!ORG_CODE_RE.test(input.code)) return 'code invalide (A-Z, 0-9, _ et -, 30 max)';
  if (!input.labelFr || input.labelFr.length > 200) return 'label_fr requis (≤ 200)';
  if (!input.labelEn || input.labelEn.length > 200) return 'label_en requis (≤ 200)';
  return null;
}

@Injectable()
export class OrgService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wf: WorkflowService,
    private readonly notify: NotificationService,
  ) {
    // Pont E3→E8 : à l'issue du contreseing d'un changement sensible, le Workflow
    // Engine applique (ou clôt) le pending_change — via ce registre, sans cycle DI.
    this.wf.registerSubjectHandler('org_change', (tx, tenantId, subjectId, status) =>
      this.applyPendingChangeTx(tx, tenantId, subjectId, status));
  }

  // ---------------- création du référentiel (org.manage, audité) ----------------

  async createCompany(tenantId: string, actor: string, input: LabelInput & { legalForm?: string }): Promise<CreateOutcome> {
    const bad = checkBase(input);
    if (bad) return { kind: 'invalid', reason: bad };
    return this.prisma.withTenant<CreateOutcome>(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO org.companies (tenant_id, code, label_fr, label_en, legal_form, created_by)
        VALUES (${tenantId}::uuid, ${input.code}, ${input.labelFr}, ${input.labelEn}, ${input.legalForm ?? null}, ${actor}::uuid)
        ON CONFLICT (tenant_id, code) DO NOTHING RETURNING id`;
      if (rows.length === 0) return { kind: 'duplicate_code' };
      await auditAuth(tx, tenantId, {
        action: 'org_company_created', actorUserId: actor, recordId: rows[0]!.id, recordType: 'org_company',
        module: 'org', newValue: input, result: 'success',
      });
      return { kind: 'ok', id: rows[0]!.id };
    });
  }

  async createSite(tenantId: string, actor: string, input: LabelInput & { companyId: string; city?: string }): Promise<CreateOutcome> {
    const bad = checkBase(input);
    if (bad) return { kind: 'invalid', reason: bad };
    return this.prisma.withTenant<CreateOutcome>(tenantId, async (tx) => {
      const co = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM org.companies WHERE id = ${input.companyId}::uuid`;
      if (co.length === 0) return { kind: 'ref_not_found', ref: 'companyId' };
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO org.sites (tenant_id, company_id, code, label_fr, label_en, city, created_by)
        VALUES (${tenantId}::uuid, ${input.companyId}::uuid, ${input.code}, ${input.labelFr}, ${input.labelEn}, ${input.city ?? null}, ${actor}::uuid)
        ON CONFLICT (tenant_id, code) DO NOTHING RETURNING id`;
      if (rows.length === 0) return { kind: 'duplicate_code' };
      await auditAuth(tx, tenantId, {
        action: 'org_site_created', actorUserId: actor, recordId: rows[0]!.id, recordType: 'org_site',
        module: 'org', newValue: input, result: 'success',
      });
      return { kind: 'ok', id: rows[0]!.id };
    });
  }

  async createCostCenter(tenantId: string, actor: string, input: LabelInput): Promise<CreateOutcome> {
    const bad = checkBase(input);
    if (bad) return { kind: 'invalid', reason: bad };
    return this.prisma.withTenant<CreateOutcome>(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO org.cost_centers (tenant_id, code, label_fr, label_en, created_by)
        VALUES (${tenantId}::uuid, ${input.code}, ${input.labelFr}, ${input.labelEn}, ${actor}::uuid)
        ON CONFLICT (tenant_id, code) DO NOTHING RETURNING id`;
      if (rows.length === 0) return { kind: 'duplicate_code' };
      await auditAuth(tx, tenantId, {
        action: 'org_cost_center_created', actorUserId: actor, recordId: rows[0]!.id, recordType: 'org_cost_center',
        module: 'org', newValue: input, result: 'success',
      });
      return { kind: 'ok', id: rows[0]!.id };
    });
  }

  async createJob(tenantId: string, actor: string, input: LabelInput & { category?: string }): Promise<CreateOutcome> {
    const bad = checkBase(input);
    if (bad) return { kind: 'invalid', reason: bad };
    return this.prisma.withTenant<CreateOutcome>(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO org.jobs (tenant_id, code, label_fr, label_en, category, created_by)
        VALUES (${tenantId}::uuid, ${input.code}, ${input.labelFr}, ${input.labelEn}, ${input.category ?? null}, ${actor}::uuid)
        ON CONFLICT (tenant_id, code) DO NOTHING RETURNING id`;
      if (rows.length === 0) return { kind: 'duplicate_code' };
      await auditAuth(tx, tenantId, {
        action: 'org_job_created', actorUserId: actor, recordId: rows[0]!.id, recordType: 'org_job',
        module: 'org', newValue: input, result: 'success',
      });
      return { kind: 'ok', id: rows[0]!.id };
    });
  }

  async createUnit(
    tenantId: string, actor: string,
    input: LabelInput & { unitType: string; companyId?: string; parentUnitId?: string; effectiveFrom?: string },
  ): Promise<CreateOutcome> {
    const bad = checkBase(input);
    if (bad) return { kind: 'invalid', reason: bad };
    if (!UNIT_TYPES.includes(input.unitType as never)) return { kind: 'invalid', reason: 'unit_type invalide' };
    const from = input.effectiveFrom ?? new Date().toISOString().slice(0, 10);
    if (!DATE_RE.test(from)) return { kind: 'invalid', reason: 'effectiveFrom invalide (AAAA-MM-JJ)' };
    return this.prisma.withTenant<CreateOutcome>(tenantId, async (tx) => {
      if (input.parentUnitId) {
        const p = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM org.units WHERE id = ${input.parentUnitId}::uuid AND status <> 'archived'`;
        if (p.length === 0) return { kind: 'ref_not_found', ref: 'parentUnitId' };
      }
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO org.units (tenant_id, unit_type, code, label_fr, label_en, company_id, created_by)
        VALUES (${tenantId}::uuid, ${input.unitType}, ${input.code}, ${input.labelFr}, ${input.labelEn},
                ${input.companyId ?? null}::uuid, ${actor}::uuid)
        ON CONFLICT (tenant_id, code) DO NOTHING RETURNING id`;
      if (rows.length === 0) return { kind: 'duplicate_code' };
      const unitId = rows[0]!.id;
      if (input.parentUnitId) {
        await tx.$executeRaw`
          INSERT INTO org.unit_parents (tenant_id, unit_id, parent_unit_id, effective_from, created_by)
          VALUES (${tenantId}::uuid, ${unitId}::uuid, ${input.parentUnitId}::uuid, ${from}::date, ${actor}::uuid)`;
      }
      await auditAuth(tx, tenantId, {
        action: 'org_unit_created', actorUserId: actor, recordId: unitId, recordType: 'org_unit',
        module: 'org', newValue: { ...input, effectiveFrom: from }, result: 'success',
      });
      return { kind: 'ok', id: unitId };
    });
  }

  async createPosition(
    tenantId: string, actor: string,
    input: LabelInput & {
      unitId: string; companyId: string; jobId: string; siteId?: string; costCenterId?: string;
      managerPositionId?: string; effectiveFrom?: string;
    },
  ): Promise<CreateOutcome> {
    const bad = checkBase(input);
    if (bad) return { kind: 'invalid', reason: bad };
    const from = input.effectiveFrom ?? new Date().toISOString().slice(0, 10);
    if (!DATE_RE.test(from)) return { kind: 'invalid', reason: 'effectiveFrom invalide (AAAA-MM-JJ)' };
    return this.prisma.withTenant<CreateOutcome>(tenantId, async (tx) => {
      // Références vérifiées AVANT toute écriture (retours 400 propres) ; les FK
      // composites de la base restent l'ultime barrière anti-inter-tenant.
      const refs = await tx.$queryRaw<Array<{ ok: boolean }>>`
        SELECT (SELECT count(*) FROM org.units WHERE id = ${input.unitId}::uuid) = 1
           AND (SELECT count(*) FROM org.companies WHERE id = ${input.companyId}::uuid) = 1
           AND (SELECT count(*) FROM org.jobs WHERE id = ${input.jobId}::uuid) = 1
           AND (${input.siteId ?? null}::uuid IS NULL OR (SELECT count(*) FROM org.sites WHERE id = ${input.siteId ?? null}::uuid) = 1)
           AND (${input.costCenterId ?? null}::uuid IS NULL OR (SELECT count(*) FROM org.cost_centers WHERE id = ${input.costCenterId ?? null}::uuid) = 1)
           AND (${input.managerPositionId ?? null}::uuid IS NULL OR (SELECT count(*) FROM org.positions WHERE id = ${input.managerPositionId ?? null}::uuid) = 1)
           AS ok`;
      if (!refs[0]!.ok) return { kind: 'ref_not_found', ref: 'unitId/companyId/jobId/siteId/costCenterId/managerPositionId' };
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO org.positions (tenant_id, code, label_fr, label_en, created_by)
        VALUES (${tenantId}::uuid, ${input.code}, ${input.labelFr}, ${input.labelEn}, ${actor}::uuid)
        ON CONFLICT (tenant_id, code) DO NOTHING RETURNING id`;
      if (rows.length === 0) return { kind: 'duplicate_code' };
      const positionId = rows[0]!.id;
      await tx.$executeRaw`
        INSERT INTO org.position_assignments
          (tenant_id, position_id, unit_id, company_id, job_id, site_id, cost_center_id, effective_from, created_by)
        VALUES (${tenantId}::uuid, ${positionId}::uuid, ${input.unitId}::uuid, ${input.companyId}::uuid,
                ${input.jobId}::uuid, ${input.siteId ?? null}::uuid, ${input.costCenterId ?? null}::uuid,
                ${from}::date, ${actor}::uuid)`;
      if (input.managerPositionId) {
        await tx.$executeRaw`
          INSERT INTO org.position_managers (tenant_id, position_id, manager_position_id, effective_from, created_by)
          VALUES (${tenantId}::uuid, ${positionId}::uuid, ${input.managerPositionId}::uuid, ${from}::date, ${actor}::uuid)`;
      }
      await auditAuth(tx, tenantId, {
        action: 'org_position_created', actorUserId: actor, recordId: positionId, recordType: 'org_position',
        module: 'org', newValue: { ...input, effectiveFrom: from }, result: 'success',
      });
      return { kind: 'ok', id: positionId };
    });
  }

  // ---------------- statuts (org.manage, audité, anti-orphelins) ----------------

  async setStatus(tenantId: string, actor: string, entity: OrgEntity, id: string, status: OrgStatus): Promise<StatusOutcome> {
    return this.prisma.withTenant<StatusOutcome>(tenantId, async (tx) => {
      const current = await this.currentStatus(tx, entity, id);
      if (current === null) return { kind: 'not_found' };
      if (!canTransitionOrgStatus(current as OrgStatus, status)) return { kind: 'invalid_transition', from: current };
      if (entity === 'unit' && (status === 'inactive' || status === 'archived')) {
        // Aucun orphelin : une unité avec enfants ACTIFS ou postes rattachés AUJOURD'HUI
        // ne se désactive pas — on traite d'abord les enfants.
        const today = new Date().toISOString().slice(0, 10);
        const kids = await tx.$queryRaw<Array<{ units: number; positions: number }>>`
          SELECT (SELECT count(*)::int FROM org.unit_parents up
                    JOIN org.units cu ON cu.tenant_id = up.tenant_id AND cu.id = up.unit_id
                   WHERE up.parent_unit_id = ${id}::uuid
                     AND daterange(up.effective_from, up.effective_to, '[)') @> ${today}::date
                     AND cu.status = 'active') AS units,
                 (SELECT count(*)::int FROM org.position_assignments pa
                    JOIN org.positions p ON p.tenant_id = pa.tenant_id AND p.id = pa.position_id
                   WHERE pa.unit_id = ${id}::uuid
                     AND daterange(pa.effective_from, pa.effective_to, '[)') @> ${today}::date
                     AND p.status = 'active') AS positions`;
        const k = kids[0]!;
        if (k.units > 0 || k.positions > 0) return { kind: 'children_active', units: k.units, positions: k.positions };
      }
      await this.applyStatus(tx, entity, id, status);
      await auditAuth(tx, tenantId, {
        action: `org_${entity}_status`, actorUserId: actor, recordId: id, recordType: `org_${entity}`,
        module: 'org', oldValue: { status: current }, newValue: { status }, result: 'success',
      });
      return { kind: 'ok', status };
    });
  }

  private async currentStatus(tx: Prisma.TransactionClient, entity: OrgEntity, id: string): Promise<string | null> {
    let rows: Array<{ status: string }> = [];
    switch (entity) {
      case 'company': rows = await tx.$queryRaw`SELECT status FROM org.companies WHERE id = ${id}::uuid FOR UPDATE`; break;
      case 'site': rows = await tx.$queryRaw`SELECT status FROM org.sites WHERE id = ${id}::uuid FOR UPDATE`; break;
      case 'cost_center': rows = await tx.$queryRaw`SELECT status FROM org.cost_centers WHERE id = ${id}::uuid FOR UPDATE`; break;
      case 'job': rows = await tx.$queryRaw`SELECT status FROM org.jobs WHERE id = ${id}::uuid FOR UPDATE`; break;
      case 'unit': rows = await tx.$queryRaw`SELECT status FROM org.units WHERE id = ${id}::uuid FOR UPDATE`; break;
      case 'position': rows = await tx.$queryRaw`SELECT status FROM org.positions WHERE id = ${id}::uuid FOR UPDATE`; break;
    }
    return rows[0]?.status ?? null;
  }

  private async applyStatus(tx: Prisma.TransactionClient, entity: OrgEntity, id: string, status: OrgStatus): Promise<void> {
    switch (entity) {
      case 'company': await tx.$executeRaw`UPDATE org.companies SET status = ${status} WHERE id = ${id}::uuid`; break;
      case 'site': await tx.$executeRaw`UPDATE org.sites SET status = ${status} WHERE id = ${id}::uuid`; break;
      case 'cost_center': await tx.$executeRaw`UPDATE org.cost_centers SET status = ${status} WHERE id = ${id}::uuid`; break;
      case 'job': await tx.$executeRaw`UPDATE org.jobs SET status = ${status} WHERE id = ${id}::uuid`; break;
      case 'unit': await tx.$executeRaw`UPDATE org.units SET status = ${status} WHERE id = ${id}::uuid`; break;
      case 'position': await tx.$executeRaw`UPDATE org.positions SET status = ${status} WHERE id = ${id}::uuid`; break;
    }
  }

  // ---------------- consultation (org.view) ----------------

  async listSimple(
    tenantId: string, entity: Extract<OrgEntity, 'company' | 'site' | 'cost_center' | 'job'>,
    opts: { query?: string; status?: string; limit?: number; offset?: number },
  ): Promise<unknown[]> {
    const q = opts.query ? `%${opts.query}%` : null;
    const status = opts.status ?? null;
    const limit = LIMIT(opts.limit);
    const offset = Math.max(opts.offset ?? 0, 0);
    return this.prisma.withTenant(tenantId, async (tx) => {
      switch (entity) {
        case 'company':
          return tx.$queryRaw<Array<Record<string, unknown>>>`
            SELECT id, code, label_fr AS "labelFr", label_en AS "labelEn", legal_form AS "legalForm", status
              FROM org.companies c
             WHERE (${status}::text IS NULL OR c.status = ${status})
               AND (${q}::text IS NULL OR c.code ILIKE ${q} OR c.label_fr ILIKE ${q} OR c.label_en ILIKE ${q})
             ORDER BY c.code LIMIT ${limit} OFFSET ${offset}`;
        case 'site':
          return tx.$queryRaw<Array<Record<string, unknown>>>`
            SELECT id, code, label_fr AS "labelFr", label_en AS "labelEn", company_id AS "companyId", city, status
              FROM org.sites s
             WHERE (${status}::text IS NULL OR s.status = ${status})
               AND (${q}::text IS NULL OR s.code ILIKE ${q} OR s.label_fr ILIKE ${q} OR s.label_en ILIKE ${q})
             ORDER BY s.code LIMIT ${limit} OFFSET ${offset}`;
        case 'cost_center':
          return tx.$queryRaw<Array<Record<string, unknown>>>`
            SELECT id, code, label_fr AS "labelFr", label_en AS "labelEn", status
              FROM org.cost_centers cc
             WHERE (${status}::text IS NULL OR cc.status = ${status})
               AND (${q}::text IS NULL OR cc.code ILIKE ${q} OR cc.label_fr ILIKE ${q} OR cc.label_en ILIKE ${q})
             ORDER BY cc.code LIMIT ${limit} OFFSET ${offset}`;
        case 'job':
          return tx.$queryRaw<Array<Record<string, unknown>>>`
            SELECT id, code, label_fr AS "labelFr", label_en AS "labelEn", category, status
              FROM org.jobs j
             WHERE (${status}::text IS NULL OR j.status = ${status})
               AND (${q}::text IS NULL OR j.code ILIKE ${q} OR j.label_fr ILIKE ${q} OR j.label_en ILIKE ${q})
             ORDER BY j.code LIMIT ${limit} OFFSET ${offset}`;
      }
    });
  }

  async listUnits(
    tenantId: string,
    opts: { query?: string; type?: string; status?: string; limit?: number; offset?: number; date?: string },
  ): Promise<unknown[]> {
    const q = opts.query ? `%${opts.query}%` : null;
    const status = opts.status ?? null;
    const type = opts.type ?? null;
    const date = opts.date ?? new Date().toISOString().slice(0, 10);
    const limit = LIMIT(opts.limit);
    const offset = Math.max(opts.offset ?? 0, 0);
    return this.prisma.withTenant(tenantId, async (tx) =>
      tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT u.id, u.code, u.label_fr AS "labelFr", u.label_en AS "labelEn", u.unit_type AS "unitType",
               u.company_id AS "companyId", u.status,
               org.unit_parent_at(u.id, ${date}::date) AS "parentUnitId"
          FROM org.units u
         WHERE (${status}::text IS NULL OR u.status = ${status})
           AND (${type}::text IS NULL OR u.unit_type = ${type})
           AND (${q}::text IS NULL OR u.code ILIKE ${q} OR u.label_fr ILIKE ${q} OR u.label_en ILIKE ${q})
         ORDER BY u.code LIMIT ${limit} OFFSET ${offset}`);
  }

  async getUnit(tenantId: string, id: string): Promise<Record<string, unknown> | null> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const units = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT id, code, label_fr AS "labelFr", label_en AS "labelEn", unit_type AS "unitType",
               company_id AS "companyId", status, created_at AS "createdAt"
          FROM org.units WHERE id = ${id}::uuid`;
      if (units.length === 0) return null;
      const history = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT up.parent_unit_id AS "parentUnitId", pu.code AS "parentCode",
               up.effective_from AS "effectiveFrom", up.effective_to AS "effectiveTo"
          FROM org.unit_parents up
          JOIN org.units pu ON pu.tenant_id = up.tenant_id AND pu.id = up.parent_unit_id
         WHERE up.unit_id = ${id}::uuid
         ORDER BY up.effective_from`;
      return { ...units[0], parentHistory: history };
    });
  }

  async listPositions(
    tenantId: string,
    opts: { query?: string; unitId?: string; status?: string; date?: string; limit?: number; offset?: number },
  ): Promise<unknown[]> {
    const q = opts.query ? `%${opts.query}%` : null;
    const status = opts.status ?? null;
    const unitId = opts.unitId ?? null;
    const date = opts.date ?? new Date().toISOString().slice(0, 10);
    const limit = LIMIT(opts.limit);
    const offset = Math.max(opts.offset ?? 0, 0);
    return this.prisma.withTenant(tenantId, async (tx) =>
      tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT p.id, p.code, p.label_fr AS "labelFr", p.label_en AS "labelEn", p.status,
               pa.unit_id AS "unitId", pa.company_id AS "companyId", pa.job_id AS "jobId",
               pa.site_id AS "siteId", pa.cost_center_id AS "costCenterId",
               org.position_manager_at(p.id, ${date}::date) AS "managerPositionId"
          FROM org.positions p
          LEFT JOIN org.position_assignments pa
            ON pa.tenant_id = p.tenant_id AND pa.position_id = p.id
           AND daterange(pa.effective_from, pa.effective_to, '[)') @> ${date}::date
         WHERE (${status}::text IS NULL OR p.status = ${status})
           AND (${unitId}::uuid IS NULL OR pa.unit_id = ${unitId}::uuid)
           AND (${q}::text IS NULL OR p.code ILIKE ${q} OR p.label_fr ILIKE ${q} OR p.label_en ILIKE ${q})
         ORDER BY p.code LIMIT ${limit} OFFSET ${offset}`);
  }

  async getPosition(tenantId: string, id: string): Promise<Record<string, unknown> | null> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT id, code, label_fr AS "labelFr", label_en AS "labelEn", status, created_at AS "createdAt"
          FROM org.positions WHERE id = ${id}::uuid`;
      if (rows.length === 0) return null;
      const assignments = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT unit_id AS "unitId", company_id AS "companyId", job_id AS "jobId", site_id AS "siteId",
               cost_center_id AS "costCenterId", effective_from AS "effectiveFrom", effective_to AS "effectiveTo"
          FROM org.position_assignments WHERE position_id = ${id}::uuid ORDER BY effective_from`;
      const managers = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT manager_position_id AS "managerPositionId", effective_from AS "effectiveFrom", effective_to AS "effectiveTo"
          FROM org.position_managers WHERE position_id = ${id}::uuid ORDER BY effective_from`;
      return { ...rows[0], assignmentHistory: assignments, managerHistory: managers };
    });
  }

  /** Ligne managériale d'un poste à une date (E3 : résolution d'approbateur par ligne). */
  async managerLine(tenantId: string, positionId: string, date: string): Promise<unknown[] | null> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const exists = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM org.positions WHERE id = ${positionId}::uuid`;
      if (exists.length === 0) return null;
      const chain: Array<Record<string, unknown>> = [];
      let cur: string | null = positionId;
      for (let depth = 0; depth < 20 && cur; depth++) {
        const next: Array<{ id: string | null }> = await tx.$queryRaw<Array<{ id: string | null }>>`
          SELECT org.position_manager_at(${cur}::uuid, ${date}::date) AS id`;
        cur = next[0]?.id ?? null;
        if (!cur) break;
        const pos = await tx.$queryRaw<Array<Record<string, unknown>>>`
          SELECT p.id, p.code, p.label_fr AS "labelFr", p.label_en AS "labelEn",
                 pa.unit_id AS "unitId"
            FROM org.positions p
            LEFT JOIN org.position_assignments pa
              ON pa.tenant_id = p.tenant_id AND pa.position_id = p.id
             AND daterange(pa.effective_from, pa.effective_to, '[)') @> ${date}::date
           WHERE p.id = ${cur}::uuid`;
        if (pos[0]) chain.push(pos[0]);
      }
      return chain;
    });
  }

  /** Organigramme des unités À UNE DATE : arbre construit sur les liens applicables. */
  async chart(tenantId: string, date: string, rootUnitId: string | null): Promise<unknown> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const nodes = await tx.$queryRaw<Array<{
        id: string; code: string; label_fr: string; label_en: string; unit_type: string; status: string;
        parent_id: string | null;
      }>>`
        SELECT u.id, u.code, u.label_fr, u.label_en, u.unit_type, u.status,
               org.unit_parent_at(u.id, ${date}::date) AS parent_id
          FROM org.units u
         WHERE u.status <> 'archived'
         ORDER BY u.code
         LIMIT 2000`;
      interface TreeNode {
        id: string; code: string; labelFr: string; labelEn: string; unitType: string; status: string;
        children: TreeNode[];
      }
      const byId = new Map<string, TreeNode>();
      for (const n of nodes) {
        byId.set(n.id, { id: n.id, code: n.code, labelFr: n.label_fr, labelEn: n.label_en, unitType: n.unit_type, status: n.status, children: [] });
      }
      const roots: TreeNode[] = [];
      for (const n of nodes) {
        const me = byId.get(n.id)!;
        const parent = n.parent_id ? byId.get(n.parent_id) : undefined;
        if (parent) parent.children.push(me);
        else roots.push(me);
      }
      if (rootUnitId) {
        const sub = byId.get(rootUnitId);
        return { date, tree: sub ? [sub] : [] };
      }
      return { date, tree: roots };
    });
  }

  // ---------------- réorganisation (portée réelle exigée, direct ou via workflow) ----------------

  /**
   * PREMIÈRE évaluation RBAC PAR CIBLE (annoncée par la garde v1 « avec le module
   * Organisation ») : l'acteur doit détenir org.manage ET une portée qui COUVRE
   * l'unité déplacée — portée tenant, ou portée department/team sur CETTE unité.
   * Un gestionnaire borné à son département ne réorganise que son département.
   */
  private async canManageUnit(tx: Prisma.TransactionClient, actorUserId: string, unitId: string): Promise<boolean> {
    const perms = await tx.$queryRaw<Array<{ permission_key: string }>>`
      SELECT rp.permission_key FROM admin.user_roles ur
        JOIN admin.role_permissions rp ON rp.role_id = ur.role_id
       WHERE ur.user_id = ${actorUserId}::uuid`;
    const scopes = await tx.$queryRaw<Array<{ scope_type: string; scope_ref: string | null }>>`
      SELECT scope_type, scope_ref FROM admin.user_scopes WHERE user_id = ${actorUserId}::uuid`;
    const principal: PrincipalAccess = {
      roles: [{ roleKey: 'db', permissions: perms.map((p) => p.permission_key) }],
      scopes: scopes.map((s) => ({ type: s.scope_type as ScopeType, ref: s.scope_ref })),
    };
    return can(principal, 'org.manage', { type: 'department', ref: unitId })
      || can(principal, 'org.manage', { type: 'team', ref: unitId });
  }

  async moveUnit(
    tenantId: string, actorUserId: string, unitId: string,
    input: { newParentUnitId: string | null; effectiveFrom: string; workflowDefinitionKey?: string },
  ): Promise<MoveOutcome> {
    if (!DATE_RE.test(input.effectiveFrom)) return { kind: 'invalid', reason: 'effectiveFrom invalide (AAAA-MM-JJ)' };
    if (input.newParentUnitId === unitId) return { kind: 'invalid', reason: 'une unité ne peut pas être son propre parent' };

    if (input.workflowDefinitionKey) {
      // Changement sensible SOUMIS à approbation : pending_change + instance E3.
      const pending = await this.prisma.withTenant<{ id: string } | null>(tenantId, async (tx) => {
        const unit = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM org.units WHERE id = ${unitId}::uuid AND status <> 'archived'`;
        if (unit.length === 0) return null;
        if (!(await this.canManageUnit(tx, actorUserId, unitId))) return { id: 'FORBIDDEN' };
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO org.pending_changes (tenant_id, change_type, payload, created_by)
          VALUES (${tenantId}::uuid, 'unit_move',
                  ${JSON.stringify({ unitId, newParentUnitId: input.newParentUnitId, effectiveFrom: input.effectiveFrom })}::jsonb,
                  ${actorUserId}::uuid)
          RETURNING id`;
        await auditAuth(tx, tenantId, {
          action: 'org_change_submitted', actorUserId, recordId: rows[0]!.id, recordType: 'org_change',
          module: 'org', newValue: { unitId, newParentUnitId: input.newParentUnitId, effectiveFrom: input.effectiveFrom },
          result: 'success',
        });
        return { id: rows[0]!.id };
      });
      if (!pending) return { kind: 'not_found' };
      if (pending.id === 'FORBIDDEN') return { kind: 'forbidden', reason: 'portée organisationnelle insuffisante sur cette unité' };
      const submitted = await this.wf.submit(tenantId, actorUserId, {
        definitionKey: input.workflowDefinitionKey, subjectType: 'org_change', subjectId: pending.id,
      });
      if (submitted.kind !== 'ok') {
        // Pas de définition active : la demande reste 'pending' sans instance — on l'annule proprement.
        await this.prisma.withTenant(tenantId, async (tx) => {
          await tx.$executeRaw`UPDATE org.pending_changes SET status = 'cancelled' WHERE id = ${pending.id}::uuid`;
        });
        return { kind: 'no_active_definition' };
      }
      await this.prisma.withTenant(tenantId, async (tx) => {
        await tx.$executeRaw`
          UPDATE org.pending_changes SET workflow_instance_id = ${submitted.instanceId}::uuid
           WHERE id = ${pending.id}::uuid`;
      });
      return { kind: 'submitted', pendingChangeId: pending.id, workflowInstanceId: submitted.instanceId };
    }

    return this.prisma.withTenant<MoveOutcome>(tenantId, async (tx) => {
      const unit = await tx.$queryRaw<Array<{ id: string; code: string }>>`
        SELECT id, code FROM org.units WHERE id = ${unitId}::uuid AND status <> 'archived' FOR UPDATE`;
      if (unit.length === 0) return { kind: 'not_found' };
      if (!(await this.canManageUnit(tx, actorUserId, unitId))) {
        return { kind: 'forbidden', reason: 'org.manage requis avec une portée couvrant cette unité' };
      }
      if (input.newParentUnitId) {
        const parent = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM org.units WHERE id = ${input.newParentUnitId}::uuid AND status <> 'archived'`;
        if (parent.length === 0) return { kind: 'invalid', reason: 'nouveau parent introuvable ou archivé' };
        const cycle = await tx.$queryRaw<Array<{ c: boolean }>>`
          SELECT org.unit_chain_would_cycle(${unitId}::uuid, ${input.newParentUnitId}::uuid, ${input.effectiveFrom}::date) AS c`;
        if (cycle[0]!.c) return { kind: 'cycle' };
      }
      const applied = await this.applyUnitMove(tx, tenantId, actorUserId, unitId,
        input.newParentUnitId, input.effectiveFrom);
      if (applied !== null) return { kind: 'invalid', reason: applied };
      await auditAuth(tx, tenantId, {
        action: 'org_unit_moved', actorUserId, recordId: unitId, recordType: 'org_unit',
        module: 'org', newValue: { newParentUnitId: input.newParentUnitId, effectiveFrom: input.effectiveFrom },
        result: 'success',
      });
      await this.notify.publishEventTx(tx, tenantId, {
        eventKey: `org.move.${unitId}.${input.effectiveFrom}`,
        templateKey: 'org.unit_moved',
        payload: { unite: unit[0]!.code, date_effet: input.effectiveFrom },
        recipients: [{ userId: actorUserId }, { scopeType: 'department', scopeRef: unitId }],
        source: 'system', subjectType: 'org_unit', subjectId: unitId, createdBy: actorUserId,
        restrictToTemplateVariables: true,
      });
      return { kind: 'ok', effectiveFrom: input.effectiveFrom, parentUnitId: input.newParentUnitId };
    });
  }

  /**
   * Applique un déplacement : CLÔT la période ouverte à la date d'effet puis INSÈRE la
   * nouvelle ligne datée. Retourne null si appliqué, sinon la raison du refus.
   * L'histoire antérieure n'est JAMAIS réécrite (gardes SQL close-only + EXCLUDE).
   */
  private async applyUnitMove(
    tx: Prisma.TransactionClient, tenantId: string, actorUserId: string | null,
    unitId: string, newParentUnitId: string | null, effectiveFrom: string,
  ): Promise<string | null> {
    const open = await tx.$queryRaw<Array<{ id: string; effective_from: Date; parent_unit_id: string }>>`
      SELECT id, effective_from, parent_unit_id FROM org.unit_parents
       WHERE unit_id = ${unitId}::uuid AND effective_to IS NULL FOR UPDATE`;
    const cur = open[0];
    if (cur) {
      const curFrom = cur.effective_from.toISOString().slice(0, 10);
      if (curFrom >= effectiveFrom) {
        return `une ligne hiérarchique démarre déjà le ${curFrom} : choisissez une date d'effet postérieure`;
      }
      if (cur.parent_unit_id === newParentUnitId) return 'le poste de rattachement est inchangé';
      await tx.$executeRaw`
        UPDATE org.unit_parents SET effective_to = ${effectiveFrom}::date WHERE id = ${cur.id}::uuid`;
    } else if (newParentUnitId === null) {
      return 'l’unité est déjà racine';
    }
    if (newParentUnitId) {
      await tx.$executeRaw`
        INSERT INTO org.unit_parents (tenant_id, unit_id, parent_unit_id, effective_from, created_by)
        VALUES (${tenantId}::uuid, ${unitId}::uuid, ${newParentUnitId}::uuid, ${effectiveFrom}::date, ${actorUserId}::uuid)`;
    }
    return null;
  }

  /** Application d'un changement approuvé par le workflow (appelé par syncSubject E3). */
  async applyPendingChangeTx(tx: Prisma.TransactionClient, tenantId: string, pendingId: string, status: string): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ change_type: string; payload: { unitId: string; newParentUnitId: string | null; effectiveFrom: string }; created_by: string | null }>>`
      SELECT change_type, payload, created_by FROM org.pending_changes
       WHERE id = ${pendingId}::uuid AND status = 'pending' FOR UPDATE`;
    const change = rows[0];
    if (!change) return;
    if (status === 'rejected' || status === 'cancelled') {
      await tx.$executeRaw`UPDATE org.pending_changes SET status = ${status} WHERE id = ${pendingId}::uuid`;
      return;
    }
    if (status !== 'approved' || change.change_type !== 'unit_move') return;
    const p = change.payload;
    // Re-contrôle du cycle À L'APPLICATION (l'état a pu bouger depuis la soumission) :
    // en cas de conflit, la demande passe en 'conflict' — rien n'est appliqué, rien ne casse.
    if (p.newParentUnitId) {
      const cycle = await tx.$queryRaw<Array<{ c: boolean }>>`
        SELECT org.unit_chain_would_cycle(${p.unitId}::uuid, ${p.newParentUnitId}::uuid, ${p.effectiveFrom}::date) AS c`;
      if (cycle[0]!.c) {
        await tx.$executeRaw`UPDATE org.pending_changes SET status = 'conflict' WHERE id = ${pendingId}::uuid`;
        await auditAuth(tx, tenantId, {
          action: 'org_change_conflict', recordId: pendingId, recordType: 'org_change', module: 'org', result: 'failure',
        });
        return;
      }
    }
    const refused = await this.applyUnitMove(tx, tenantId, change.created_by, p.unitId, p.newParentUnitId, p.effectiveFrom);
    if (refused !== null) {
      await tx.$executeRaw`UPDATE org.pending_changes SET status = 'conflict' WHERE id = ${pendingId}::uuid`;
      await auditAuth(tx, tenantId, {
        action: 'org_change_conflict', recordId: pendingId, recordType: 'org_change', module: 'org',
        reason: refused, result: 'failure',
      });
      return;
    }
    await tx.$executeRaw`UPDATE org.pending_changes SET status = 'applied' WHERE id = ${pendingId}::uuid`;
    await auditAuth(tx, tenantId, {
      action: 'org_change_applied', recordId: pendingId, recordType: 'org_change', module: 'org',
      newValue: p, result: 'success',
    });
  }

  async getPendingChange(tenantId: string, id: string): Promise<Record<string, unknown> | null> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT id, change_type AS "changeType", payload, status,
               workflow_instance_id AS "workflowInstanceId", created_by AS "createdBy", created_at AS "createdAt"
          FROM org.pending_changes WHERE id = ${id}::uuid`;
      return rows[0] ?? null;
    });
  }
}
