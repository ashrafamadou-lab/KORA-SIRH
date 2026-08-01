import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { auditAuth } from '../auth/audit.util';
import { WorkflowService } from '../workflow/workflow.service';
import { NotificationService } from '../notify/notification.service';
import {
  canTransitionEmployeeStatus,
  careerEventForTransition,
  maskSensitiveFields,
  MATRICULE_RE,
  statusAtDate,
  type EmployeeStatus,
} from '../../../../packages/core/src/hr.ts';

/**
 * Dossier salarié (E9 — Core HR). Décisions structurantes :
 *  - ZONAGE : professionnel (employees.view), personnel (view_private, lectures
 *    AUDITÉES), administratif (view_identifiers, lectures AUDITÉES), documents en
 *    métadonnées (view_documents, lectures AUDITÉES). Les listes générales n'exposent
 *    JAMAIS identifiants complets, coordonnées personnelles, urgence ou documents.
 *  - PORTÉES RÉELLES (E2×E8) : la visibilité d'un salarié découle de son affectation
 *    PRINCIPALE applicable — portée tenant = tout ; legal_entity = sa société ;
 *    site = son site ; department/team = son unité. Les routes par salarié font leur
 *    contrôle ICI (la garde v1 est de niveau tenant) : lectures hors périmètre = 404
 *    (pas de divulgation d'existence), écritures hors périmètre = 403.
 *  - MINIMISATION à l'écriture : les valeurs d'identifiants sont masquées (•••+3)
 *    AVANT toute écriture d'audit ; E6 les masque aussi à la lecture (double barrière).
 *  - HISTORISATION : affectations datées close-only (EXCLUDE + triggers SQL),
 *    carrière append-only ; une cessation CLÔT les affectations et ne supprime rien.
 *  - Discipline transactionnelle : résultats métier, exceptions HTTP côté contrôleur.
 */

export type HrOutcome<T> =
  | ({ kind: 'ok' } & T)
  | { kind: 'not_found' }
  | { kind: 'forbidden'; reason: string }
  | { kind: 'invalid'; reason: string };

export type StatusChangeOutcome =
  | { kind: 'ok'; status: EmployeeStatus; effectiveDate: string; careerEvent: string }
  | { kind: 'submitted'; pendingChangeId: string; workflowInstanceId: string }
  | { kind: 'not_found' }
  | { kind: 'forbidden'; reason: string }
  | { kind: 'invalid_transition'; from: string }
  | { kind: 'invalid'; reason: string }
  | { kind: 'no_active_definition' };

export type AssignmentOutcome =
  | { kind: 'ok'; id: string; careerEvent: string | null }
  | { kind: 'submitted'; pendingChangeId: string; workflowInstanceId: string }
  | { kind: 'not_found' }
  | { kind: 'forbidden'; reason: string }
  | { kind: 'ref_not_found'; ref: string }
  | { kind: 'position_not_active' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'no_active_definition' };

export type CreateEmployeeOutcome =
  | { kind: 'ok'; id: string }
  | { kind: 'duplicate_matricule' }
  | { kind: 'ref_not_found'; ref: string }
  | { kind: 'invalid'; reason: string };

/** Périmètre effectif d'un acteur pour UNE permission (anti-élévation E2). */
interface ScopeSet {
  kind: 'none' | 'all' | 'scoped';
  companies: string[];
  sites: string[];
  units: string[];
}

interface EmployeeTargets {
  companyId: string;
  siteId: string | null;
  unitId: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LIMIT = (n: number | undefined, def = 50) => Math.min(Math.max(n ?? def, 1), 200);
const today = () => new Date().toISOString().slice(0, 10);

const DOC_TYPES = ['contrat', 'avenant', 'piece_identite', 'diplome', 'certificat', 'autre'] as const;
const ASSIGNMENT_KINDS = ['standard', 'interim', 'temporary'] as const;
/** Événements de carrière qu'un gestionnaire peut qualifier explicitement. */
const ASSIGNMENT_EVENT_TYPES = ['transfer', 'promotion', 'position_change', 'site_change', 'unit_change', 'manager_change', 'confirmation'] as const;

const PROFESSIONAL_COLUMNS = `
  e.id, e.matricule, e.first_name AS "firstName", e.last_name AS "lastName",
  e.usage_first_name AS "usageFirstName", e.usage_last_name AS "usageLastName",
  e.status, e.hire_date::text AS "hireDate", e.professional_status AS "professionalStatus",
  e.employer_company_id AS "employerCompanyId", e.main_site_id AS "mainSiteId",
  e.work_email AS "workEmail", e.work_phone AS "workPhone", e.photo_ref AS "photoRef"`;

@Injectable()
export class HrService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wf: WorkflowService,
    private readonly notify: NotificationService,
  ) {
    // Pont E3→E9 : à l'issue de l'approbation, le Workflow Engine applique (ou clôt)
    // le changement RH — via le registre de sujets, sans cycle DI.
    this.wf.registerSubjectHandler('hr_change', (tx, tenantId, subjectId, status) =>
      this.applyHrPendingChangeTx(tx, tenantId, subjectId, status));
  }

  // ------------------------------------------------------------------
  // Portées réelles (E2 × E8)
  // ------------------------------------------------------------------

  private async scopeSetFor(tx: Prisma.TransactionClient, userId: string, permission: string): Promise<ScopeSet> {
    const perms = await tx.$queryRaw<Array<{ permission_key: string }>>`
      SELECT rp.permission_key FROM admin.user_roles ur
        JOIN admin.role_permissions rp ON rp.role_id = ur.role_id
       WHERE ur.user_id = ${userId}::uuid`;
    if (!perms.some((p) => p.permission_key === permission)) {
      return { kind: 'none', companies: [], sites: [], units: [] };
    }
    const scopes = await tx.$queryRaw<Array<{ scope_type: string; scope_ref: string | null }>>`
      SELECT scope_type, scope_ref FROM admin.user_scopes WHERE user_id = ${userId}::uuid`;
    if (scopes.some((s) => s.scope_type === 'tenant')) {
      return { kind: 'all', companies: [], sites: [], units: [] };
    }
    const companies = scopes.filter((s) => s.scope_type === 'legal_entity' && s.scope_ref).map((s) => s.scope_ref!);
    const sites = scopes.filter((s) => s.scope_type === 'site' && s.scope_ref).map((s) => s.scope_ref!);
    const units = scopes.filter((s) => (s.scope_type === 'department' || s.scope_type === 'team') && s.scope_ref).map((s) => s.scope_ref!);
    if (companies.length + sites.length + units.length === 0) {
      return { kind: 'none', companies: [], sites: [], units: [] };
    }
    return { kind: 'scoped', companies, sites, units };
  }

  /** Cibles organisationnelles du salarié = son affectation PRINCIPALE applicable. */
  private async employeeTargetsAt(
    tx: Prisma.TransactionClient, employeeId: string, date: string,
  ): Promise<EmployeeTargets | null> {
    const rows = await tx.$queryRaw<Array<{ company_id: string; site_id: string | null; unit_id: string }>>`
      SELECT company_id, site_id, unit_id FROM core.employee_assignments
       WHERE employee_id = ${employeeId}::uuid AND is_primary
         AND daterange(effective_from, effective_to, '[)') @> ${date}::date
       LIMIT 1`;
    const r = rows[0];
    return r ? { companyId: r.company_id, siteId: r.site_id, unitId: r.unit_id } : null;
  }

  private covers(set: ScopeSet, targets: EmployeeTargets | null): boolean {
    if (set.kind === 'all') return true;
    if (set.kind === 'none') return false;
    // Un dossier SANS affectation (brouillon) n'appartient à aucun périmètre fin :
    // seule la portée tenant le couvre — anti-élévation.
    if (!targets) return false;
    return set.companies.includes(targets.companyId)
      || (targets.siteId !== null && set.sites.includes(targets.siteId))
      || set.units.includes(targets.unitId);
  }

  /** Contrôle de LECTURE par salarié : périmètre non couvrant ⇒ not_found (aucune divulgation). */
  private async readAccess(
    tx: Prisma.TransactionClient, actor: string, employeeId: string, permission: string,
  ): Promise<{ ok: true } | { kind: 'not_found' } | { kind: 'forbidden'; reason: string }> {
    const set = await this.scopeSetFor(tx, actor, permission);
    if (set.kind === 'none') return { kind: 'forbidden', reason: `permission requise : ${permission} (avec une portée applicable)` };
    const exists = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM core.employees WHERE id = ${employeeId}::uuid AND deleted_at IS NULL`;
    if (exists.length === 0) return { kind: 'not_found' };
    if (set.kind === 'all') return { ok: true };
    const targets = await this.employeeTargetsAt(tx, employeeId, today());
    if (!this.covers(set, targets)) return { kind: 'not_found' };
    return { ok: true };
  }

  /** Contrôle d'ÉCRITURE par salarié : périmètre non couvrant ⇒ forbidden (explicite). */
  private async writeAccess(
    tx: Prisma.TransactionClient, actor: string, employeeId: string, permission: string,
  ): Promise<{ ok: true } | { kind: 'not_found' } | { kind: 'forbidden'; reason: string }> {
    const set = await this.scopeSetFor(tx, actor, permission);
    if (set.kind === 'none') return { kind: 'forbidden', reason: `permission requise : ${permission} (avec une portée applicable)` };
    const exists = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM core.employees WHERE id = ${employeeId}::uuid AND deleted_at IS NULL`;
    if (exists.length === 0) return { kind: 'not_found' };
    if (set.kind === 'all') return { ok: true };
    const targets = await this.employeeTargetsAt(tx, employeeId, today());
    if (!this.covers(set, targets)) {
      return { kind: 'forbidden', reason: `${permission} requis avec une portée couvrant ce salarié` };
    }
    return { ok: true };
  }

  // ------------------------------------------------------------------
  // Zone professionnelle : liste et détail (employees.view, portée filtrante)
  // ------------------------------------------------------------------

  async list(
    tenantId: string, actor: string,
    opts: { query?: string; status?: string; companyId?: string; siteId?: string; unitId?: string; limit?: number; offset?: number },
  ): Promise<HrOutcome<{ items: unknown[] }>> {
    const q = opts.query ? `%${opts.query}%` : null;
    const status = opts.status ?? null;
    const limit = LIMIT(opts.limit);
    const offset = Math.max(opts.offset ?? 0, 0);
    const date = today();
    return this.prisma.withTenant<HrOutcome<{ items: unknown[] }>>(tenantId, async (tx) => {
      const set = await this.scopeSetFor(tx, actor, 'employees.view');
      if (set.kind === 'none') {
        return { kind: 'forbidden', reason: 'permission requise : employees.view (avec une portée applicable)' };
      }
      const scoped = set.kind === 'scoped';
      const companiesCsv = set.companies.join(',');
      const sitesCsv = set.sites.join(',');
      const unitsCsv = set.units.join(',');
      // La liste générale n'expose QUE la zone professionnelle : jamais d'identifiants,
      // de coordonnées personnelles, d'urgence, de documents ni de données médicales.
      const items = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT ${Prisma.raw(PROFESSIONAL_COLUMNS)}
          FROM core.employees e
         WHERE e.deleted_at IS NULL
           AND (${status}::text IS NULL OR e.status = ${status})
           AND (${q}::text IS NULL OR e.matricule ILIKE ${q} OR e.first_name ILIKE ${q} OR e.last_name ILIKE ${q}
                OR e.usage_first_name ILIKE ${q} OR e.usage_last_name ILIKE ${q})
           AND (${opts.companyId ?? null}::uuid IS NULL OR EXISTS (
                 SELECT 1 FROM core.employee_assignments fa WHERE fa.employee_id = e.id AND fa.is_primary
                   AND daterange(fa.effective_from, fa.effective_to, '[)') @> ${date}::date
                   AND fa.company_id = ${opts.companyId ?? null}::uuid))
           AND (${opts.siteId ?? null}::uuid IS NULL OR EXISTS (
                 SELECT 1 FROM core.employee_assignments fa WHERE fa.employee_id = e.id AND fa.is_primary
                   AND daterange(fa.effective_from, fa.effective_to, '[)') @> ${date}::date
                   AND fa.site_id = ${opts.siteId ?? null}::uuid))
           AND (${opts.unitId ?? null}::uuid IS NULL OR EXISTS (
                 SELECT 1 FROM core.employee_assignments fa WHERE fa.employee_id = e.id AND fa.is_primary
                   AND daterange(fa.effective_from, fa.effective_to, '[)') @> ${date}::date
                   AND fa.unit_id = ${opts.unitId ?? null}::uuid))
           AND (${!scoped} OR EXISTS (
                 SELECT 1 FROM core.employee_assignments sa
                  WHERE sa.employee_id = e.id AND sa.is_primary
                    AND daterange(sa.effective_from, sa.effective_to, '[)') @> ${date}::date
                    AND (sa.company_id = ANY(string_to_array(${companiesCsv}, ',')::uuid[])
                      OR sa.site_id    = ANY(string_to_array(${sitesCsv}, ',')::uuid[])
                      OR sa.unit_id    = ANY(string_to_array(${unitsCsv}, ',')::uuid[]))))
         ORDER BY e.matricule
         LIMIT ${limit} OFFSET ${offset}`;
      return { kind: 'ok', items };
    });
  }

  async get(tenantId: string, actor: string, id: string): Promise<HrOutcome<{ employee: Record<string, unknown> }>> {
    return this.prisma.withTenant<HrOutcome<{ employee: Record<string, unknown> }>>(tenantId, async (tx) => {
      const access = await this.readAccess(tx, actor, id, 'employees.view');
      if (!('ok' in access)) return access;
      const rows = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT ${Prisma.raw(PROFESSIONAL_COLUMNS)}, e.created_at AS "createdAt",
               (SELECT count(*)::int FROM core.employee_documents d WHERE d.employee_id = e.id) AS "documentCount"
          FROM core.employees e WHERE e.id = ${id}::uuid AND e.deleted_at IS NULL`;
      if (rows.length === 0) return { kind: 'not_found' };
      const current = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT a.id, a.company_id AS "companyId", a.site_id AS "siteId", a.unit_id AS "unitId",
               a.position_id AS "positionId", a.job_id AS "jobId", a.cost_center_id AS "costCenterId",
               a.assignment_kind AS "assignmentKind", a.allocation_pct AS "allocationPct",
               a.effective_from::text AS "effectiveFrom", a.effective_to::text AS "effectiveTo",
               u.code AS "unitCode", c.code AS "companyCode"
          FROM core.employee_assignments a
          JOIN org.units u ON u.tenant_id = a.tenant_id AND u.id = a.unit_id
          JOIN org.companies c ON c.tenant_id = a.tenant_id AND c.id = a.company_id
         WHERE a.employee_id = ${id}::uuid AND a.is_primary
           AND daterange(a.effective_from, a.effective_to, '[)') @> ${today()}::date
         LIMIT 1`;
      return { kind: 'ok', employee: { ...rows[0], currentAssignment: current[0] ?? null } };
    });
  }

  // ------------------------------------------------------------------
  // Création et zone professionnelle (employees.manage)
  // ------------------------------------------------------------------

  async create(
    tenantId: string, actor: string,
    input: {
      matricule: string; firstName: string; lastName: string;
      usageFirstName?: string; usageLastName?: string; hireDate?: string; professionalStatus?: string;
      employerCompanyId?: string; mainSiteId?: string; workEmail?: string; workPhone?: string; photoRef?: string;
    },
  ): Promise<CreateEmployeeOutcome> {
    if (!MATRICULE_RE.test(input.matricule)) return { kind: 'invalid', reason: 'matricule invalide (A-Z, 0-9, . _ -, 30 max)' };
    if (input.hireDate && !DATE_RE.test(input.hireDate)) return { kind: 'invalid', reason: 'hireDate invalide (AAAA-MM-JJ)' };
    if (input.workEmail && !EMAIL_RE.test(input.workEmail)) return { kind: 'invalid', reason: 'workEmail invalide' };
    return this.prisma.withTenant<CreateEmployeeOutcome>(tenantId, async (tx) => {
      if (input.employerCompanyId) {
        const co = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM org.companies WHERE id = ${input.employerCompanyId}::uuid AND status <> 'archived'`;
        if (co.length === 0) return { kind: 'ref_not_found', ref: 'employerCompanyId' };
      }
      if (input.mainSiteId) {
        const si = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM org.sites WHERE id = ${input.mainSiteId}::uuid AND status <> 'archived'`;
        if (si.length === 0) return { kind: 'ref_not_found', ref: 'mainSiteId' };
      }
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO core.employees
          (tenant_id, matricule, first_name, last_name, usage_first_name, usage_last_name, status,
           hire_date, professional_status, employer_company_id, main_site_id, work_email, work_phone, photo_ref)
        VALUES (${tenantId}::uuid, ${input.matricule}, ${input.firstName}, ${input.lastName},
                ${input.usageFirstName ?? null}, ${input.usageLastName ?? null}, 'draft',
                ${input.hireDate ?? null}::date, ${input.professionalStatus ?? null},
                ${input.employerCompanyId ?? null}::uuid, ${input.mainSiteId ?? null}::uuid,
                ${input.workEmail ?? null}, ${input.workPhone ?? null}, ${input.photoRef ?? null})
        ON CONFLICT (tenant_id, matricule) DO NOTHING RETURNING id`;
      if (rows.length === 0) return { kind: 'duplicate_matricule' };
      await auditAuth(tx, tenantId, {
        action: 'hr_employee_created', actorUserId: actor, recordId: rows[0]!.id, recordType: 'employee',
        module: 'hr', newValue: { matricule: input.matricule, firstName: input.firstName, lastName: input.lastName, status: 'draft' },
        result: 'success',
      });
      return { kind: 'ok', id: rows[0]!.id };
    });
  }

  async updateProfessional(
    tenantId: string, actor: string, id: string,
    patch: Partial<Record<'firstName' | 'lastName' | 'usageFirstName' | 'usageLastName' | 'hireDate'
      | 'professionalStatus' | 'employerCompanyId' | 'mainSiteId' | 'workEmail' | 'workPhone' | 'photoRef', string | null>>,
  ): Promise<HrOutcome<{ employee: Record<string, unknown> }>> {
    if (patch.hireDate != null && !DATE_RE.test(patch.hireDate)) return { kind: 'invalid', reason: 'hireDate invalide (AAAA-MM-JJ)' };
    if (patch.workEmail != null && !EMAIL_RE.test(patch.workEmail)) return { kind: 'invalid', reason: 'workEmail invalide' };
    if (patch.firstName === null || patch.lastName === null || patch.firstName === '' || patch.lastName === '') {
      return { kind: 'invalid', reason: 'firstName et lastName ne peuvent pas être vides' };
    }
    return this.prisma.withTenant<HrOutcome<{ employee: Record<string, unknown> }>>(tenantId, async (tx) => {
      const access = await this.writeAccess(tx, actor, id, 'employees.manage');
      if (!('ok' in access)) return access;
      const curRows = await tx.$queryRaw<Array<Record<string, string | null>>>`
        SELECT first_name AS "firstName", last_name AS "lastName", usage_first_name AS "usageFirstName",
               usage_last_name AS "usageLastName", hire_date::text AS "hireDate",
               professional_status AS "professionalStatus", employer_company_id AS "employerCompanyId",
               main_site_id AS "mainSiteId", work_email AS "workEmail", work_phone AS "workPhone", photo_ref AS "photoRef"
          FROM core.employees WHERE id = ${id}::uuid AND deleted_at IS NULL FOR UPDATE`;
      const cur = curRows[0];
      if (!cur) return { kind: 'not_found' };
      if (patch.employerCompanyId) {
        const co = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM org.companies WHERE id = ${patch.employerCompanyId}::uuid AND status <> 'archived'`;
        if (co.length === 0) return { kind: 'invalid', reason: 'employerCompanyId introuvable' };
      }
      if (patch.mainSiteId) {
        const si = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM org.sites WHERE id = ${patch.mainSiteId}::uuid AND status <> 'archived'`;
        if (si.length === 0) return { kind: 'invalid', reason: 'mainSiteId introuvable' };
      }
      const merged = { ...cur };
      const changed: Record<string, { old: string | null; new: string | null }> = {};
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        if (merged[k] !== v) changed[k] = { old: merged[k] ?? null, new: v };
        merged[k] = v;
      }
      await tx.$executeRaw`
        UPDATE core.employees SET
          first_name = ${merged['firstName']}, last_name = ${merged['lastName']},
          usage_first_name = ${merged['usageFirstName']}, usage_last_name = ${merged['usageLastName']},
          hire_date = ${merged['hireDate']}::date, professional_status = ${merged['professionalStatus']},
          employer_company_id = ${merged['employerCompanyId']}::uuid, main_site_id = ${merged['mainSiteId']}::uuid,
          work_email = ${merged['workEmail']}, work_phone = ${merged['workPhone']}, photo_ref = ${merged['photoRef']}
        WHERE id = ${id}::uuid`;
      if (Object.keys(changed).length > 0) {
        await auditAuth(tx, tenantId, {
          action: 'hr_employee_updated', actorUserId: actor, recordId: id, recordType: 'employee', module: 'hr',
          oldValue: Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v.old])),
          newValue: Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v.new])),
          result: 'success',
        });
      }
      return { kind: 'ok', employee: merged };
    });
  }

  // ------------------------------------------------------------------
  // Zones personnelle et administrative (lectures AUDITÉES, écritures masquées)
  // ------------------------------------------------------------------

  async getPrivate(tenantId: string, actor: string, id: string): Promise<HrOutcome<{ private: Record<string, unknown> | null }>> {
    return this.prisma.withTenant<HrOutcome<{ private: Record<string, unknown> | null }>>(tenantId, async (tx) => {
      const access = await this.readAccess(tx, actor, id, 'employees.view_private');
      if (!('ok' in access)) return access;
      const rows = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT birth_date::text AS "birthDate", birth_place AS "birthPlace", nationality, sex,
               personal_email AS "personalEmail", personal_phone AS "personalPhone",
               address_line AS "addressLine", address_city AS "addressCity", address_country AS "addressCountry",
               emergency_name AS "emergencyName", emergency_relation AS "emergencyRelation", emergency_phone AS "emergencyPhone",
               updated_at AS "updatedAt"
          FROM core.employee_private WHERE employee_id = ${id}::uuid`;
      // Chaque consultation de la zone personnelle laisse une trace nominative.
      await auditAuth(tx, tenantId, {
        action: 'employee_private_viewed', actorUserId: actor, recordId: id, recordType: 'employee',
        module: 'hr', result: 'success',
      });
      return { kind: 'ok', private: rows[0] ?? null };
    });
  }

  async putPrivate(
    tenantId: string, actor: string, id: string,
    patch: Partial<Record<'birthDate' | 'birthPlace' | 'nationality' | 'sex' | 'personalEmail' | 'personalPhone'
      | 'addressLine' | 'addressCity' | 'addressCountry' | 'emergencyName' | 'emergencyRelation' | 'emergencyPhone', string | null>>,
  ): Promise<HrOutcome<Record<never, never>>> {
    if (patch.birthDate != null && !DATE_RE.test(patch.birthDate)) return { kind: 'invalid', reason: 'birthDate invalide (AAAA-MM-JJ)' };
    if (patch.nationality != null && !/^[A-Z]{2}$/.test(patch.nationality)) return { kind: 'invalid', reason: 'nationality : code ISO 3166-1 alpha-2' };
    if (patch.addressCountry != null && !/^[A-Z]{2}$/.test(patch.addressCountry)) return { kind: 'invalid', reason: 'addressCountry : code ISO 3166-1 alpha-2' };
    // Le sexe n'est collecté QUE pour les déclarations sociales légales (finalité
    // documentée en base) — jamais utilisé par une règle décisionnelle.
    if (patch.sex != null && patch.sex !== 'f' && patch.sex !== 'm') return { kind: 'invalid', reason: 'sex : f ou m (finalité déclarative uniquement)' };
    if (patch.personalEmail != null && !EMAIL_RE.test(patch.personalEmail)) return { kind: 'invalid', reason: 'personalEmail invalide' };
    return this.prisma.withTenant<HrOutcome<Record<never, never>>>(tenantId, async (tx) => {
      // Écrire une zone exige la gestion ET le droit de la voir.
      const manage = await this.writeAccess(tx, actor, id, 'employees.manage');
      if (!('ok' in manage)) return manage;
      const view = await this.scopeSetFor(tx, actor, 'employees.view_private');
      if (view.kind === 'none') return { kind: 'forbidden', reason: 'employees.view_private requis pour modifier cette zone' };
      const curRows = await tx.$queryRaw<Array<Record<string, string | null>>>`
        SELECT birth_date::text AS "birthDate", birth_place AS "birthPlace", nationality, sex,
               personal_email AS "personalEmail", personal_phone AS "personalPhone",
               address_line AS "addressLine", address_city AS "addressCity", address_country AS "addressCountry",
               emergency_name AS "emergencyName", emergency_relation AS "emergencyRelation", emergency_phone AS "emergencyPhone"
          FROM core.employee_private WHERE employee_id = ${id}::uuid FOR UPDATE`;
      const cur = curRows[0] ?? {};
      const merged: Record<string, string | null> = { ...cur };
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) merged[k] = v;
      await tx.$executeRaw`
        INSERT INTO core.employee_private
          (employee_id, tenant_id, birth_date, birth_place, nationality, sex, personal_email, personal_phone,
           address_line, address_city, address_country, emergency_name, emergency_relation, emergency_phone)
        VALUES (${id}::uuid, ${tenantId}::uuid, ${merged['birthDate'] ?? null}::date, ${merged['birthPlace'] ?? null},
                ${merged['nationality'] ?? null}, ${merged['sex'] ?? null}, ${merged['personalEmail'] ?? null},
                ${merged['personalPhone'] ?? null}, ${merged['addressLine'] ?? null}, ${merged['addressCity'] ?? null},
                ${merged['addressCountry'] ?? 'BJ'}, ${merged['emergencyName'] ?? null}, ${merged['emergencyRelation'] ?? null},
                ${merged['emergencyPhone'] ?? null})
        ON CONFLICT (employee_id) DO UPDATE SET
          birth_date = EXCLUDED.birth_date, birth_place = EXCLUDED.birth_place, nationality = EXCLUDED.nationality,
          sex = EXCLUDED.sex, personal_email = EXCLUDED.personal_email, personal_phone = EXCLUDED.personal_phone,
          address_line = EXCLUDED.address_line, address_city = EXCLUDED.address_city, address_country = EXCLUDED.address_country,
          emergency_name = EXCLUDED.emergency_name, emergency_relation = EXCLUDED.emergency_relation,
          emergency_phone = EXCLUDED.emergency_phone`;
      // MINIMISATION à l'écriture : l'audit ne reçoit que des valeurs déjà masquées.
      await auditAuth(tx, tenantId, {
        action: 'employee_private_updated', actorUserId: actor, recordId: id, recordType: 'employee', module: 'hr',
        oldValue: maskSensitiveFields(cur), newValue: maskSensitiveFields(merged), result: 'success',
      });
      return { kind: 'ok' };
    });
  }

  async getIdentifiers(tenantId: string, actor: string, id: string): Promise<HrOutcome<{ identifiers: Record<string, unknown> | null }>> {
    return this.prisma.withTenant<HrOutcome<{ identifiers: Record<string, unknown> | null }>>(tenantId, async (tx) => {
      const access = await this.readAccess(tx, actor, id, 'employees.view_identifiers');
      if (!('ok' in access)) return access;
      const rows = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT cnss_number AS "cnssNumber", tax_id AS "taxId", id_document_type AS "idDocumentType",
               id_document_number AS "idDocumentNumber", id_document_expiry::text AS "idDocumentExpiry",
               updated_at AS "updatedAt"
          FROM core.employee_identifiers WHERE employee_id = ${id}::uuid`;
      await auditAuth(tx, tenantId, {
        action: 'employee_identifiers_viewed', actorUserId: actor, recordId: id, recordType: 'employee',
        module: 'hr', result: 'success',
      });
      return { kind: 'ok', identifiers: rows[0] ?? null };
    });
  }

  async putIdentifiers(
    tenantId: string, actor: string, id: string,
    patch: Partial<Record<'cnssNumber' | 'taxId' | 'idDocumentType' | 'idDocumentNumber' | 'idDocumentExpiry', string | null>>,
  ): Promise<HrOutcome<Record<never, never>> | { kind: 'duplicate_cnss' }> {
    // Le FORMAT du numéro CNSS est un paramètre juridique (CNS-06) : AUCUNE regex en
    // dur ici — seule une borne de taille défensive s'applique.
    if (patch.cnssNumber != null && patch.cnssNumber.length > 50) return { kind: 'invalid', reason: 'cnssNumber trop long (≤ 50)' };
    if (patch.taxId != null && patch.taxId.length > 50) return { kind: 'invalid', reason: 'taxId trop long (≤ 50)' };
    if (patch.idDocumentType != null && !['cni', 'passeport', 'cip', 'autre'].includes(patch.idDocumentType)) {
      return { kind: 'invalid', reason: 'idDocumentType : cni, passeport, cip ou autre' };
    }
    if (patch.idDocumentExpiry != null && !DATE_RE.test(patch.idDocumentExpiry)) return { kind: 'invalid', reason: 'idDocumentExpiry invalide (AAAA-MM-JJ)' };
    return this.prisma.withTenant<HrOutcome<Record<never, never>> | { kind: 'duplicate_cnss' }>(tenantId, async (tx) => {
      const manage = await this.writeAccess(tx, actor, id, 'employees.manage');
      if (!('ok' in manage)) return manage;
      const view = await this.scopeSetFor(tx, actor, 'employees.view_identifiers');
      if (view.kind === 'none') return { kind: 'forbidden', reason: 'employees.view_identifiers requis pour modifier cette zone' };
      if (patch.cnssNumber) {
        const dup = await tx.$queryRaw<Array<{ employee_id: string }>>`
          SELECT employee_id FROM core.employee_identifiers
           WHERE cnss_number = ${patch.cnssNumber} AND employee_id <> ${id}::uuid`;
        if (dup.length > 0) return { kind: 'duplicate_cnss' }; // la valeur ne sort JAMAIS dans la réponse
      }
      const curRows = await tx.$queryRaw<Array<Record<string, string | null>>>`
        SELECT cnss_number AS "cnssNumber", tax_id AS "taxId", id_document_type AS "idDocumentType",
               id_document_number AS "idDocumentNumber", id_document_expiry::text AS "idDocumentExpiry"
          FROM core.employee_identifiers WHERE employee_id = ${id}::uuid FOR UPDATE`;
      const cur = curRows[0] ?? {};
      const merged: Record<string, string | null> = { ...cur };
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) merged[k] = v;
      await tx.$executeRaw`
        INSERT INTO core.employee_identifiers
          (employee_id, tenant_id, cnss_number, tax_id, id_document_type, id_document_number, id_document_expiry)
        VALUES (${id}::uuid, ${tenantId}::uuid, ${merged['cnssNumber'] ?? null}, ${merged['taxId'] ?? null},
                ${merged['idDocumentType'] ?? null}, ${merged['idDocumentNumber'] ?? null}, ${merged['idDocumentExpiry'] ?? null}::date)
        ON CONFLICT (employee_id) DO UPDATE SET
          cnss_number = EXCLUDED.cnss_number, tax_id = EXCLUDED.tax_id, id_document_type = EXCLUDED.id_document_type,
          id_document_number = EXCLUDED.id_document_number, id_document_expiry = EXCLUDED.id_document_expiry`;
      await auditAuth(tx, tenantId, {
        action: 'employee_identifiers_updated', actorUserId: actor, recordId: id, recordType: 'employee', module: 'hr',
        oldValue: maskSensitiveFields(cur), newValue: maskSensitiveFields(merged), result: 'success',
      });
      return { kind: 'ok' };
    });
  }

  // ------------------------------------------------------------------
  // Documents : MÉTADONNÉES uniquement
  // ------------------------------------------------------------------

  async listDocuments(tenantId: string, actor: string, id: string): Promise<HrOutcome<{ documents: unknown[] }>> {
    return this.prisma.withTenant<HrOutcome<{ documents: unknown[] }>>(tenantId, async (tx) => {
      const access = await this.readAccess(tx, actor, id, 'employees.view_documents');
      if (!('ok' in access)) return access;
      // file_ref n'est JAMAIS exposé : le module documentaire (stockage, URLs signées)
      // est un incrément ultérieur — NOT IMPLEMENTED, pas de faux lien.
      const rows = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT id, doc_type AS "docType", label, sensitive, uploaded_by AS "uploadedBy", created_at AS "createdAt"
          FROM core.employee_documents WHERE employee_id = ${id}::uuid ORDER BY created_at DESC, id`;
      await auditAuth(tx, tenantId, {
        action: 'employee_documents_viewed', actorUserId: actor, recordId: id, recordType: 'employee',
        module: 'hr', result: 'success',
      });
      return { kind: 'ok', documents: rows };
    });
  }

  async addDocument(
    tenantId: string, actor: string, id: string,
    input: { docType: string; label: string; fileRef?: string; sensitive?: boolean },
  ): Promise<HrOutcome<{ id: string }>> {
    if (!DOC_TYPES.includes(input.docType as never)) return { kind: 'invalid', reason: `docType : ${DOC_TYPES.join(', ')}` };
    return this.prisma.withTenant<HrOutcome<{ id: string }>>(tenantId, async (tx) => {
      const manage = await this.writeAccess(tx, actor, id, 'employees.manage');
      if (!('ok' in manage)) return manage;
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO core.employee_documents (tenant_id, employee_id, doc_type, label, file_ref, sensitive, uploaded_by)
        VALUES (${tenantId}::uuid, ${id}::uuid, ${input.docType}, ${input.label}, ${input.fileRef ?? null},
                ${input.sensitive ?? true}, ${actor}::uuid)
        RETURNING id`;
      await auditAuth(tx, tenantId, {
        action: 'hr_document_added', actorUserId: actor, recordId: id, recordType: 'employee', module: 'hr',
        newValue: { documentId: rows[0]!.id, docType: input.docType, label: input.label, sensitive: input.sensitive ?? true },
        result: 'success',
      });
      return { kind: 'ok', id: rows[0]!.id };
    });
  }

  // ------------------------------------------------------------------
  // Cycle de vie : transitions contrôlées, direct ou via workflow (E3)
  // ------------------------------------------------------------------

  async changeStatus(
    tenantId: string, actor: string, id: string,
    input: { status: EmployeeStatus; effectiveDate?: string; reason?: string; workflowDefinitionKey?: string },
  ): Promise<StatusChangeOutcome> {
    const effectiveDate = input.effectiveDate ?? today();
    if (!DATE_RE.test(effectiveDate)) return { kind: 'invalid', reason: 'effectiveDate invalide (AAAA-MM-JJ)' };

    if (input.workflowDefinitionKey) {
      const pending = await this.prisma.withTenant<{ id: string } | { forbidden: string } | null>(tenantId, async (tx) => {
        const access = await this.writeAccess(tx, actor, id, 'employees.manage');
        if ('kind' in access) return access.kind === 'not_found' ? null : { forbidden: access.reason };
        const cur = await tx.$queryRaw<Array<{ status: string }>>`
          SELECT status FROM core.employees WHERE id = ${id}::uuid AND deleted_at IS NULL`;
        if (cur.length === 0) return null;
        if (!canTransitionEmployeeStatus(cur[0]!.status as EmployeeStatus, input.status)) {
          return { forbidden: `TRANSITION:${cur[0]!.status}` };
        }
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO core.hr_pending_changes (tenant_id, change_type, employee_id, payload, created_by)
          VALUES (${tenantId}::uuid, 'status_change', ${id}::uuid,
                  ${JSON.stringify({ status: input.status, effectiveDate, reason: input.reason ?? null })}::jsonb,
                  ${actor}::uuid)
          RETURNING id`;
        await auditAuth(tx, tenantId, {
          action: 'hr_change_submitted', actorUserId: actor, recordId: rows[0]!.id, recordType: 'hr_change',
          module: 'hr', newValue: { employeeId: id, changeType: 'status_change', status: input.status, effectiveDate },
          result: 'success',
        });
        return { id: rows[0]!.id };
      });
      if (pending === null) return { kind: 'not_found' };
      if ('forbidden' in pending) {
        if (pending.forbidden.startsWith('TRANSITION:')) {
          return { kind: 'invalid_transition', from: pending.forbidden.slice('TRANSITION:'.length) };
        }
        return { kind: 'forbidden', reason: pending.forbidden };
      }
      return this.submitToWorkflow(tenantId, actor, pending.id, input.workflowDefinitionKey);
    }

    return this.prisma.withTenant<StatusChangeOutcome>(tenantId, async (tx) => {
      const access = await this.writeAccess(tx, actor, id, 'employees.manage');
      if (!('ok' in access)) return access;
      const cur = await tx.$queryRaw<Array<{ status: string; matricule: string }>>`
        SELECT status, matricule FROM core.employees WHERE id = ${id}::uuid AND deleted_at IS NULL FOR UPDATE`;
      if (cur.length === 0) return { kind: 'not_found' };
      const from = cur[0]!.status as EmployeeStatus;
      if (!canTransitionEmployeeStatus(from, input.status)) return { kind: 'invalid_transition', from };
      const careerEvent = await this.applyStatusChangeTx(tx, tenantId, actor, id, {
        from, to: input.status, effectiveDate, reason: input.reason ?? null, workflowInstanceId: null,
      });
      return { kind: 'ok', status: input.status, effectiveDate, careerEvent };
    });
  }

  /**
   * Application EFFECTIVE d'une transition (directe ou approuvée) :
   * statut + événement de carrière + clôture des affectations si cessation + audit +
   * notification — le tout DANS LA MÊME transaction : rien ne part si rien ne s'applique.
   */
  private async applyStatusChangeTx(
    tx: Prisma.TransactionClient, tenantId: string, actor: string | null, employeeId: string,
    p: { from: EmployeeStatus; to: EmployeeStatus; effectiveDate: string; reason: string | null; workflowInstanceId: string | null },
  ): Promise<string> {
    await tx.$executeRaw`UPDATE core.employees SET status = ${p.to} WHERE id = ${employeeId}::uuid`;
    const eventType = careerEventForTransition(p.from, p.to);
    await tx.$executeRaw`
      INSERT INTO core.career_events (tenant_id, employee_id, event_type, effective_date, details, workflow_instance_id, created_by)
      VALUES (${tenantId}::uuid, ${employeeId}::uuid, ${eventType}, ${p.effectiveDate}::date,
              ${JSON.stringify({ from: p.from, to: p.to, ...(p.reason ? { reason: p.reason } : {}) })}::jsonb,
              ${p.workflowInstanceId}::uuid, ${actor}::uuid)`;
    if (p.to === 'terminated') {
      // La cessation CLÔT les affectations ouvertes à la date d'effet (les lignes
      // futures deviennent des périodes vides) — le dossier et l'historique RESTENT.
      await tx.$executeRaw`
        UPDATE core.employee_assignments
           SET effective_to = GREATEST(effective_from, ${p.effectiveDate}::date)
         WHERE employee_id = ${employeeId}::uuid AND effective_to IS NULL`;
    }
    await auditAuth(tx, tenantId, {
      action: 'hr_status_changed', actorUserId: actor ?? undefined, recordId: employeeId, recordType: 'employee',
      module: 'hr', oldValue: { status: p.from }, newValue: { status: p.to, effectiveDate: p.effectiveDate },
      result: 'success',
    });
    await this.notifyChangeApplied(tx, tenantId, employeeId, actor, `statut ${p.from} → ${p.to}`, p.effectiveDate);
    return eventType;
  }

  /** Notification APRÈS application effective — même transaction que l'application. */
  private async notifyChangeApplied(
    tx: Prisma.TransactionClient, tenantId: string, employeeId: string, requester: string | null,
    changeLabel: string, effectiveDate: string,
  ): Promise<void> {
    const emp = await tx.$queryRaw<Array<{ matricule: string }>>`
      SELECT matricule FROM core.employees WHERE id = ${employeeId}::uuid`;
    const linked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM admin.users WHERE employee_id = ${employeeId}::uuid AND is_active AND deleted_at IS NULL`;
    const recipients = [
      ...(requester ? [{ userId: requester }] : []),
      ...linked.map((u) => ({ userId: u.id })),
    ];
    if (recipients.length === 0) return;
    // Sans modèle actif 'hr.change_applied', rien n'est émis — jamais bloquant.
    await this.notify.publishEventTx(tx, tenantId, {
      eventKey: `hr.applied.${randomUUID()}`,
      templateKey: 'hr.change_applied',
      payload: { matricule: emp[0]?.matricule ?? '', type_changement: changeLabel, date_effet: effectiveDate },
      recipients,
      source: 'system', subjectType: 'employee', subjectId: employeeId, createdBy: requester,
      restrictToTemplateVariables: true,
    });
  }

  // ------------------------------------------------------------------
  // Affectations organisationnelles datées (employees.assign, portée réelle)
  // ------------------------------------------------------------------

  async createAssignment(
    tenantId: string, actor: string, employeeId: string,
    input: {
      companyId: string; unitId: string; siteId?: string; positionId?: string; jobId?: string;
      costCenterId?: string; managerOverrideEmployeeId?: string; isPrimary?: boolean;
      assignmentKind?: string; allocationPct?: number; effectiveFrom: string; effectiveTo?: string;
      careerEventType?: string; workflowDefinitionKey?: string;
    },
  ): Promise<AssignmentOutcome> {
    if (!DATE_RE.test(input.effectiveFrom)) return { kind: 'invalid', reason: 'effectiveFrom invalide (AAAA-MM-JJ)' };
    if (input.effectiveTo && (!DATE_RE.test(input.effectiveTo) || input.effectiveTo < input.effectiveFrom)) {
      return { kind: 'invalid', reason: 'effectiveTo invalide ou antérieure à effectiveFrom' };
    }
    const kind = input.assignmentKind ?? 'standard';
    if (!ASSIGNMENT_KINDS.includes(kind as never)) return { kind: 'invalid', reason: `assignmentKind : ${ASSIGNMENT_KINDS.join(', ')}` };
    const pct = input.allocationPct ?? 100;
    if (!Number.isInteger(pct) || pct < 1 || pct > 100) return { kind: 'invalid', reason: 'allocationPct : entier de 1 à 100' };
    if (input.careerEventType && !ASSIGNMENT_EVENT_TYPES.includes(input.careerEventType as never)) {
      return { kind: 'invalid', reason: `careerEventType : ${ASSIGNMENT_EVENT_TYPES.join(', ')}` };
    }

    if (input.workflowDefinitionKey) {
      const payload = { ...input, assignmentKind: kind, allocationPct: pct, workflowDefinitionKey: undefined };
      const pending = await this.prisma.withTenant<{ id: string } | { forbidden: string } | { refused: AssignmentOutcome } | null>(
        tenantId, async (tx) => {
          const access = await this.assignmentAccess(tx, actor, employeeId, input.companyId, input.siteId ?? null, input.unitId);
          if (access !== null) return access.kind === 'not_found' ? null : { forbidden: access.reason };
          const checked = await this.checkAssignmentRefs(tx, employeeId, input, kind);
          if (checked !== null) return { refused: checked };
          const rows = await tx.$queryRaw<Array<{ id: string }>>`
            INSERT INTO core.hr_pending_changes (tenant_id, change_type, employee_id, payload, created_by)
            VALUES (${tenantId}::uuid, 'assignment', ${employeeId}::uuid, ${JSON.stringify(payload)}::jsonb, ${actor}::uuid)
            RETURNING id`;
          await auditAuth(tx, tenantId, {
            action: 'hr_change_submitted', actorUserId: actor, recordId: rows[0]!.id, recordType: 'hr_change',
            module: 'hr', newValue: { employeeId, changeType: 'assignment', unitId: input.unitId, effectiveFrom: input.effectiveFrom },
            result: 'success',
          });
          return { id: rows[0]!.id };
        });
      if (pending === null) return { kind: 'not_found' };
      if ('refused' in pending) return pending.refused;
      if ('forbidden' in pending) return { kind: 'forbidden', reason: pending.forbidden };
      return this.submitToWorkflow(tenantId, actor, pending.id, input.workflowDefinitionKey);
    }

    return this.prisma.withTenant<AssignmentOutcome>(tenantId, async (tx) => {
      const access = await this.assignmentAccess(tx, actor, employeeId, input.companyId, input.siteId ?? null, input.unitId);
      if (access !== null) return access;
      const checked = await this.checkAssignmentRefs(tx, employeeId, input, kind);
      if (checked !== null) return checked;
      const applied = await this.applyAssignmentTx(tx, tenantId, actor, employeeId, {
        companyId: input.companyId, unitId: input.unitId, siteId: input.siteId ?? null,
        positionId: input.positionId ?? null, jobId: input.jobId ?? null, costCenterId: input.costCenterId ?? null,
        managerOverrideEmployeeId: input.managerOverrideEmployeeId ?? null,
        isPrimary: input.isPrimary ?? true, assignmentKind: kind, allocationPct: pct,
        effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo ?? null,
        careerEventType: input.careerEventType ?? null, workflowInstanceId: null,
      });
      if ('refused' in applied) return { kind: 'invalid', reason: applied.refused };
      return { kind: 'ok', id: applied.id, careerEvent: applied.careerEvent };
    });
  }

  /**
   * Portée d'affectation : l'acteur doit couvrir le salarié DANS SON état actuel
   * (pas de captation hors périmètre) ET la cible de la nouvelle affectation
   * (pas de projection hors périmètre). La portée tenant couvre tout.
   */
  private async assignmentAccess(
    tx: Prisma.TransactionClient, actor: string, employeeId: string,
    companyId: string, siteId: string | null, unitId: string,
  ): Promise<{ kind: 'not_found' } | { kind: 'forbidden'; reason: string } | null> {
    const set = await this.scopeSetFor(tx, actor, 'employees.assign');
    if (set.kind === 'none') return { kind: 'forbidden', reason: 'permission requise : employees.assign (avec une portée applicable)' };
    const exists = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM core.employees WHERE id = ${employeeId}::uuid AND deleted_at IS NULL`;
    if (exists.length === 0) return { kind: 'not_found' };
    if (set.kind === 'all') return null;
    const current = await this.employeeTargetsAt(tx, employeeId, today());
    if (current && !this.covers(set, current)) {
      return { kind: 'forbidden', reason: 'employees.assign requis avec une portée couvrant ce salarié' };
    }
    if (!this.covers(set, { companyId, siteId, unitId })) {
      return { kind: 'forbidden', reason: 'employees.assign requis avec une portée couvrant l’unité cible' };
    }
    return null;
  }

  /** Références vérifiées AVANT écriture ; les FK composites restent l'ultime barrière. */
  private async checkAssignmentRefs(
    tx: Prisma.TransactionClient, employeeId: string,
    input: { companyId: string; unitId: string; siteId?: string; positionId?: string; jobId?: string; costCenterId?: string; managerOverrideEmployeeId?: string; effectiveFrom: string },
    _kind: string,
  ): Promise<AssignmentOutcome | null> {
    const refs = await tx.$queryRaw<Array<{ ok: boolean }>>`
      SELECT (SELECT count(*) FROM org.companies WHERE id = ${input.companyId}::uuid AND status <> 'archived') = 1
         AND (SELECT count(*) FROM org.units WHERE id = ${input.unitId}::uuid AND status <> 'archived') = 1
         AND (${input.siteId ?? null}::uuid IS NULL OR (SELECT count(*) FROM org.sites WHERE id = ${input.siteId ?? null}::uuid AND status <> 'archived') = 1)
         AND (${input.jobId ?? null}::uuid IS NULL OR (SELECT count(*) FROM org.jobs WHERE id = ${input.jobId ?? null}::uuid AND status <> 'archived') = 1)
         AND (${input.costCenterId ?? null}::uuid IS NULL OR (SELECT count(*) FROM org.cost_centers WHERE id = ${input.costCenterId ?? null}::uuid AND status <> 'archived') = 1)
         AND (${input.managerOverrideEmployeeId ?? null}::uuid IS NULL OR (SELECT count(*) FROM core.employees WHERE id = ${input.managerOverrideEmployeeId ?? null}::uuid AND deleted_at IS NULL) = 1)
         AS ok`;
    if (!refs[0]!.ok) return { kind: 'ref_not_found', ref: 'companyId/unitId/siteId/jobId/costCenterId/managerOverrideEmployeeId' };
    if (input.managerOverrideEmployeeId === employeeId) return { kind: 'invalid', reason: 'un salarié ne peut pas être son propre responsable' };
    if (input.positionId) {
      // Le poste doit être ACTIF et rattaché à l'organisation À LA DATE D'EFFET.
      const pos = await tx.$queryRaw<Array<{ ok: boolean }>>`
        SELECT (p.status = 'active' AND EXISTS (
                 SELECT 1 FROM org.position_assignments pa
                  WHERE pa.position_id = p.id
                    AND daterange(pa.effective_from, pa.effective_to, '[)') @> ${input.effectiveFrom}::date)) AS ok
          FROM org.positions p WHERE p.id = ${input.positionId}::uuid`;
      if (pos.length === 0) return { kind: 'ref_not_found', ref: 'positionId' };
      if (!pos[0]!.ok) return { kind: 'position_not_active' };
    }
    return null;
  }

  /** Application EFFECTIVE d'une affectation (directe ou approuvée) — même transaction. */
  private async applyAssignmentTx(
    tx: Prisma.TransactionClient, tenantId: string, actor: string | null, employeeId: string,
    p: {
      companyId: string; unitId: string; siteId: string | null; positionId: string | null; jobId: string | null;
      costCenterId: string | null; managerOverrideEmployeeId: string | null; isPrimary: boolean;
      assignmentKind: string; allocationPct: number; effectiveFrom: string; effectiveTo: string | null;
      careerEventType: string | null; workflowInstanceId: string | null;
    },
  ): Promise<{ id: string; careerEvent: string | null } | { refused: string }> {
    let previous: { unit_id: string; site_id: string | null; position_id: string | null } | null = null;
    if (p.isPrimary) {
      const open = await tx.$queryRaw<Array<{ id: string; effective_from: Date; unit_id: string; site_id: string | null; position_id: string | null }>>`
        SELECT id, effective_from, unit_id, site_id, position_id FROM core.employee_assignments
         WHERE employee_id = ${employeeId}::uuid AND is_primary AND effective_to IS NULL FOR UPDATE`;
      const cur = open[0];
      if (cur) {
        const curFrom = cur.effective_from.toISOString().slice(0, 10);
        if (curFrom >= p.effectiveFrom) {
          return { refused: `une affectation principale démarre déjà le ${curFrom} : choisissez une date d'effet postérieure` };
        }
        // Mutation PROPRE : clôture de la période courante, l'histoire reste intacte.
        await tx.$executeRaw`
          UPDATE core.employee_assignments SET effective_to = ${p.effectiveFrom}::date WHERE id = ${cur.id}::uuid`;
        previous = { unit_id: cur.unit_id, site_id: cur.site_id, position_id: cur.position_id };
      }
    }
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO core.employee_assignments
        (tenant_id, employee_id, company_id, site_id, unit_id, position_id, job_id, cost_center_id,
         manager_override_employee_id, is_primary, assignment_kind, allocation_pct, effective_from, effective_to, created_by)
      VALUES (${tenantId}::uuid, ${employeeId}::uuid, ${p.companyId}::uuid, ${p.siteId}::uuid, ${p.unitId}::uuid,
              ${p.positionId}::uuid, ${p.jobId}::uuid, ${p.costCenterId}::uuid, ${p.managerOverrideEmployeeId}::uuid,
              ${p.isPrimary}, ${p.assignmentKind}, ${p.allocationPct}, ${p.effectiveFrom}::date, ${p.effectiveTo}::date,
              ${actor}::uuid)
      RETURNING id`;
    const assignmentId = rows[0]!.id;

    // Événement de carrière : PRINCIPALE = toujours tracée (type qualifié par le
    // gestionnaire ou déduit du changement) ; secondaire = tracée si qualifiée.
    let eventType: string | null = p.careerEventType;
    if (eventType === null && p.isPrimary) {
      if (previous === null) eventType = 'unit_change'; // premier rattachement organisationnel
      else if (previous.unit_id !== p.unitId) eventType = 'transfer';
      else if (previous.position_id !== p.positionId) eventType = 'position_change';
      else if (previous.site_id !== p.siteId) eventType = 'site_change';
      else eventType = 'unit_change';
    }
    if (eventType !== null) {
      await tx.$executeRaw`
        INSERT INTO core.career_events
          (tenant_id, employee_id, event_type, effective_date, details, assignment_id, workflow_instance_id, created_by)
        VALUES (${tenantId}::uuid, ${employeeId}::uuid, ${eventType}, ${p.effectiveFrom}::date,
                ${JSON.stringify({ unitId: p.unitId, companyId: p.companyId, siteId: p.siteId, positionId: p.positionId, isPrimary: p.isPrimary, kind: p.assignmentKind })}::jsonb,
                ${assignmentId}::uuid, ${p.workflowInstanceId}::uuid, ${actor}::uuid)`;
    }
    await auditAuth(tx, tenantId, {
      action: 'hr_assignment_created', actorUserId: actor ?? undefined, recordId: assignmentId, recordType: 'employee_assignment',
      module: 'hr', newValue: { employeeId, unitId: p.unitId, companyId: p.companyId, positionId: p.positionId, isPrimary: p.isPrimary, kind: p.assignmentKind, allocationPct: p.allocationPct, effectiveFrom: p.effectiveFrom },
      result: 'success',
    });
    await this.notifyChangeApplied(tx, tenantId, employeeId, actor, 'affectation organisationnelle', p.effectiveFrom);
    return { id: assignmentId, careerEvent: eventType };
  }

  // ------------------------------------------------------------------
  // Consultation : historique, état à une date, responsable
  // ------------------------------------------------------------------

  async listAssignments(tenantId: string, actor: string, id: string): Promise<HrOutcome<{ assignments: unknown[] }>> {
    return this.prisma.withTenant<HrOutcome<{ assignments: unknown[] }>>(tenantId, async (tx) => {
      const access = await this.readAccess(tx, actor, id, 'employees.view_history');
      if (!('ok' in access)) return access;
      const rows = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT a.id, a.company_id AS "companyId", a.site_id AS "siteId", a.unit_id AS "unitId",
               a.position_id AS "positionId", a.job_id AS "jobId", a.cost_center_id AS "costCenterId",
               a.manager_override_employee_id AS "managerOverrideEmployeeId",
               a.is_primary AS "isPrimary", a.assignment_kind AS "assignmentKind", a.allocation_pct AS "allocationPct",
               a.effective_from::text AS "effectiveFrom", a.effective_to::text AS "effectiveTo", a.created_at AS "createdAt"
          FROM core.employee_assignments a
         WHERE a.employee_id = ${id}::uuid
         ORDER BY a.effective_from, a.created_at`;
      return { kind: 'ok', assignments: rows };
    });
  }

  async listCareer(tenantId: string, actor: string, id: string): Promise<HrOutcome<{ events: unknown[] }>> {
    return this.prisma.withTenant<HrOutcome<{ events: unknown[] }>>(tenantId, async (tx) => {
      const access = await this.readAccess(tx, actor, id, 'employees.view_history');
      if (!('ok' in access)) return access;
      const rows = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT id::text AS id, event_type AS "eventType", effective_date::text AS "effectiveDate",
               details, assignment_id AS "assignmentId", workflow_instance_id AS "workflowInstanceId",
               created_by AS "createdBy", occurred_at AS "occurredAt"
          FROM core.career_events WHERE employee_id = ${id}::uuid
         ORDER BY effective_date, id`;
      return { kind: 'ok', events: rows };
    });
  }

  /** État et affectation CONSULTABLES À UNE DATE — les mutations futures n'y changent rien. */
  async atDate(tenantId: string, actor: string, id: string, date: string): Promise<HrOutcome<{ at: Record<string, unknown> }>> {
    return this.prisma.withTenant<HrOutcome<{ at: Record<string, unknown> }>>(tenantId, async (tx) => {
      const access = await this.readAccess(tx, actor, id, 'employees.view_history');
      if (!('ok' in access)) return access;
      const events = await tx.$queryRaw<Array<{ effectiveDate: string; resultingStatus: string | null }>>`
        SELECT effective_date::text AS "effectiveDate", details->>'to' AS "resultingStatus"
          FROM core.career_events WHERE employee_id = ${id}::uuid
         ORDER BY effective_date, id`;
      const status = statusAtDate(
        events.map((e) => ({ effectiveDate: e.effectiveDate, resultingStatus: (e.resultingStatus ?? null) as EmployeeStatus | null })),
        date,
      );
      const assignment = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT a.id, a.company_id AS "companyId", a.site_id AS "siteId", a.unit_id AS "unitId",
               a.position_id AS "positionId", a.job_id AS "jobId", a.assignment_kind AS "assignmentKind",
               a.allocation_pct AS "allocationPct",
               a.effective_from::text AS "effectiveFrom", a.effective_to::text AS "effectiveTo",
               u.code AS "unitCode", c.code AS "companyCode"
          FROM core.employee_assignments a
          JOIN org.units u ON u.tenant_id = a.tenant_id AND u.id = a.unit_id
          JOIN org.companies c ON c.tenant_id = a.tenant_id AND c.id = a.company_id
         WHERE a.employee_id = ${id}::uuid AND a.is_primary
           AND daterange(a.effective_from, a.effective_to, '[)') @> ${date}::date
         LIMIT 1`;
      const manager = await this.resolveManagerTx(tx, id, date);
      return { kind: 'ok', at: { date, status, assignment: assignment[0] ?? null, manager } };
    });
  }

  async getManager(tenantId: string, actor: string, id: string, date: string): Promise<HrOutcome<{ manager: Record<string, unknown> | null; date: string }>> {
    return this.prisma.withTenant<HrOutcome<{ manager: Record<string, unknown> | null; date: string }>>(tenantId, async (tx) => {
      const access = await this.readAccess(tx, actor, id, 'employees.view');
      if (!('ok' in access)) return access;
      const manager = await this.resolveManagerTx(tx, id, date);
      return { kind: 'ok', manager, date };
    });
  }

  /**
   * Résolution du responsable À UNE DATE : dérogation explicite d'abord, sinon la
   * STRUCTURE DES POSTES (E8) — poste de l'affectation principale → poste responsable
   * (org.position_manager_at) → titulaire principal de ce poste à la même date.
   */
  private async resolveManagerTx(
    tx: Prisma.TransactionClient, employeeId: string, date: string,
  ): Promise<Record<string, unknown> | null> {
    const asg = await tx.$queryRaw<Array<{ position_id: string | null; manager_override_employee_id: string | null }>>`
      SELECT position_id, manager_override_employee_id FROM core.employee_assignments
       WHERE employee_id = ${employeeId}::uuid AND is_primary
         AND daterange(effective_from, effective_to, '[)') @> ${date}::date
       LIMIT 1`;
    const a = asg[0];
    if (!a) return null;
    if (a.manager_override_employee_id) {
      const emp = await this.managerCard(tx, a.manager_override_employee_id);
      return emp ? { ...emp, via: 'override' } : null;
    }
    if (!a.position_id) return null;
    const mp = await tx.$queryRaw<Array<{ id: string | null }>>`
      SELECT org.position_manager_at(${a.position_id}::uuid, ${date}::date) AS id`;
    const managerPositionId = mp[0]?.id ?? null;
    if (!managerPositionId) return null;
    const occupant = await tx.$queryRaw<Array<{ employee_id: string }>>`
      SELECT employee_id FROM core.employee_assignments
       WHERE position_id = ${managerPositionId}::uuid AND is_primary
         AND daterange(effective_from, effective_to, '[)') @> ${date}::date
         AND employee_id <> ${employeeId}::uuid
       LIMIT 1`;
    if (occupant.length === 0) return { via: 'position', managerPositionId, employeeId: null };
    const emp = await this.managerCard(tx, occupant[0]!.employee_id);
    return emp ? { ...emp, via: 'position', managerPositionId } : null;
  }

  private async managerCard(tx: Prisma.TransactionClient, employeeId: string): Promise<Record<string, unknown> | null> {
    const rows = await tx.$queryRaw<Array<Record<string, unknown>>>`
      SELECT id AS "employeeId", matricule, first_name AS "firstName", last_name AS "lastName"
        FROM core.employees WHERE id = ${employeeId}::uuid AND deleted_at IS NULL`;
    return rows[0] ?? null;
  }

  // ------------------------------------------------------------------
  // Workflow (E3) : soumission et application des changements RH
  // ------------------------------------------------------------------

  private async submitToWorkflow(
    tenantId: string, actor: string, pendingId: string, definitionKey: string,
  ): Promise<{ kind: 'submitted'; pendingChangeId: string; workflowInstanceId: string } | { kind: 'no_active_definition' }> {
    const submitted = await this.wf.submit(tenantId, actor, {
      definitionKey, subjectType: 'hr_change', subjectId: pendingId,
    });
    if (submitted.kind !== 'ok') {
      await this.prisma.withTenant(tenantId, async (tx) => {
        await tx.$executeRaw`UPDATE core.hr_pending_changes SET status = 'cancelled' WHERE id = ${pendingId}::uuid`;
      });
      return { kind: 'no_active_definition' };
    }
    await this.prisma.withTenant(tenantId, async (tx) => {
      await tx.$executeRaw`
        UPDATE core.hr_pending_changes SET workflow_instance_id = ${submitted.instanceId}::uuid WHERE id = ${pendingId}::uuid`;
    });
    return { kind: 'submitted', pendingChangeId: pendingId, workflowInstanceId: submitted.instanceId };
  }

  /**
   * Application d'un changement RH décidé par le workflow (syncSubject E3). L'état a pu
   * bouger depuis la soumission : toute re-validation qui échoue passe la demande en
   * 'conflict' — rien n'est appliqué, rien ne casse, tout est audité.
   */
  async applyHrPendingChangeTx(tx: Prisma.TransactionClient, tenantId: string, pendingId: string, status: string): Promise<void> {
    const rows = await tx.$queryRaw<Array<{
      change_type: string; employee_id: string; payload: Record<string, unknown>;
      created_by: string | null; workflow_instance_id: string | null;
    }>>`
      SELECT change_type, employee_id, payload, created_by, workflow_instance_id
        FROM core.hr_pending_changes WHERE id = ${pendingId}::uuid AND status = 'pending' FOR UPDATE`;
    const change = rows[0];
    if (!change) return;
    if (status === 'rejected' || status === 'cancelled') {
      await tx.$executeRaw`UPDATE core.hr_pending_changes SET status = ${status} WHERE id = ${pendingId}::uuid`;
      return;
    }
    if (status !== 'approved') return;

    if (change.change_type === 'status_change') {
      const p = change.payload as { status: EmployeeStatus; effectiveDate: string; reason: string | null };
      const cur = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT status FROM core.employees WHERE id = ${change.employee_id}::uuid AND deleted_at IS NULL FOR UPDATE`;
      const from = cur[0]?.status as EmployeeStatus | undefined;
      if (!from || !canTransitionEmployeeStatus(from, p.status)) {
        await this.markConflict(tx, tenantId, pendingId, `transition devenue invalide (état actuel : ${from ?? 'introuvable'})`);
        return;
      }
      await this.applyStatusChangeTx(tx, tenantId, change.created_by, change.employee_id, {
        from, to: p.status, effectiveDate: p.effectiveDate, reason: p.reason ?? null,
        workflowInstanceId: change.workflow_instance_id,
      });
    } else if (change.change_type === 'assignment') {
      const p = change.payload as {
        companyId: string; unitId: string; siteId?: string; positionId?: string; jobId?: string; costCenterId?: string;
        managerOverrideEmployeeId?: string; isPrimary?: boolean; assignmentKind?: string; allocationPct?: number;
        effectiveFrom: string; effectiveTo?: string; careerEventType?: string;
      };
      const checked = await this.checkAssignmentRefs(tx, change.employee_id, p, p.assignmentKind ?? 'standard');
      if (checked !== null) {
        await this.markConflict(tx, tenantId, pendingId, `références devenues invalides (${checked.kind})`);
        return;
      }
      const applied = await this.applyAssignmentTx(tx, tenantId, change.created_by, change.employee_id, {
        companyId: p.companyId, unitId: p.unitId, siteId: p.siteId ?? null, positionId: p.positionId ?? null,
        jobId: p.jobId ?? null, costCenterId: p.costCenterId ?? null,
        managerOverrideEmployeeId: p.managerOverrideEmployeeId ?? null, isPrimary: p.isPrimary ?? true,
        assignmentKind: p.assignmentKind ?? 'standard', allocationPct: p.allocationPct ?? 100,
        effectiveFrom: p.effectiveFrom, effectiveTo: p.effectiveTo ?? null,
        careerEventType: p.careerEventType ?? null, workflowInstanceId: change.workflow_instance_id,
      });
      if ('refused' in applied) {
        await this.markConflict(tx, tenantId, pendingId, applied.refused);
        return;
      }
    } else {
      return;
    }
    await tx.$executeRaw`UPDATE core.hr_pending_changes SET status = 'applied' WHERE id = ${pendingId}::uuid`;
    await auditAuth(tx, tenantId, {
      action: 'hr_change_applied', recordId: pendingId, recordType: 'hr_change', module: 'hr',
      newValue: { changeType: change.change_type, employeeId: change.employee_id }, result: 'success',
    });
  }

  private async markConflict(tx: Prisma.TransactionClient, tenantId: string, pendingId: string, reason: string): Promise<void> {
    await tx.$executeRaw`UPDATE core.hr_pending_changes SET status = 'conflict' WHERE id = ${pendingId}::uuid`;
    await auditAuth(tx, tenantId, {
      action: 'hr_change_conflict', recordId: pendingId, recordType: 'hr_change', module: 'hr',
      reason, result: 'failure',
    });
  }

  async getPendingChange(tenantId: string, id: string): Promise<Record<string, unknown> | null> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT id, change_type AS "changeType", employee_id AS "employeeId", payload, status,
               workflow_instance_id AS "workflowInstanceId", created_by AS "createdBy",
               created_at AS "createdAt", updated_at AS "updatedAt"
          FROM core.hr_pending_changes WHERE id = ${id}::uuid`;
      return rows[0] ?? null;
    });
  }
}
