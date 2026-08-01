import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { auditAuth } from '../auth/audit.util';
import { parseCsv } from '../../../../packages/core/src/org.ts';
import {
  mapHrImportRows,
  validateHrImportRows,
  type HrImportError,
  type HrImportRow,
} from '../../../../packages/core/src/hr.ts';

/**
 * Import CSV de salariés (E9) — permission employees.import, audité.
 *
 * STRATÉGIE EXPLICITE : seule 'create_only' est implémentée — chaque ligne CRÉE un
 * dossier ; un matricule déjà présent est une ERREUR de ligne (jamais d'écrasement
 * silencieux). Les stratégies de mise à jour sont un incrément ultérieur (NOT
 * IMPLEMENTED — refusées explicitement, pas simulées).
 *
 * ATOMICITÉ : validation COMPLÈTE (structure, doublons fichier ET base, références
 * organisationnelles par code) AVANT toute écriture — la moindre erreur ⇒ rapport par
 * ligne et ZÉRO insertion. 'preview' rend le même rapport sans écrire.
 *
 * MINIMISATION : les valeurs CNSS/fiscales ne figurent JAMAIS dans les rapports
 * d'erreurs ni dans l'audit (lignes et matricules seulement).
 */

const MAX_CSV_CHARS = 512_000;
const MAX_ROWS = 2000;
const MAX_REPORT_ERRORS = 200;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type HrImportOutcome =
  | { kind: 'invalid'; errors: HrImportError[]; counts: Record<string, number> }
  | { kind: 'preview_ok'; counts: Record<string, number> }
  | { kind: 'applied'; counts: Record<string, number> };

@Injectable()
export class HrImportService {
  constructor(private readonly prisma: PrismaService) {}

  async run(
    tenantId: string,
    actorUserId: string,
    input: { csv: string; mode: 'preview' | 'apply'; defaultEffectiveFrom?: string },
  ): Promise<HrImportOutcome> {
    const defaultFrom = input.defaultEffectiveFrom ?? new Date().toISOString().slice(0, 10);
    if (!DATE_RE.test(defaultFrom)) {
      return { kind: 'invalid', errors: [{ line: 0, error: 'defaultEffectiveFrom invalide (AAAA-MM-JJ)' }], counts: {} };
    }
    if (input.csv.length > MAX_CSV_CHARS) {
      return { kind: 'invalid', errors: [{ line: 0, error: `fichier trop volumineux (max ${MAX_CSV_CHARS} caractères)` }], counts: {} };
    }
    const parsed = parseCsv(input.csv, { maxRows: MAX_ROWS });
    if (!parsed.ok) return { kind: 'invalid', errors: [{ line: parsed.line ?? 0, error: parsed.error }], counts: {} };
    const mapped = mapHrImportRows(parsed.header, parsed.rows);
    if (mapped.errors.length > 0 || mapped.rows.length === 0) {
      return {
        kind: 'invalid',
        errors: mapped.errors.length > 0 ? mapped.errors : [{ line: 0, error: 'aucune ligne à importer' }],
        counts: {},
      };
    }
    const errors: HrImportError[] = [...validateHrImportRows(mapped.rows)];
    const rows = mapped.rows;

    return this.prisma.withTenant<HrImportOutcome>(tenantId, async (tx) => {
      // Références organisationnelles PAR CODE, résolues sous RLS dans CE tenant : le
      // fichier d'un autre tenant ne peut par construction viser aucune de ses cibles.
      const orgIds = new Map<string, string>(); // "kind:CODE" -> id
      const resolve = async (kindLabel: string, code: string | undefined, line: number, matricule: string, required: boolean): Promise<void> => {
        if (!code) return;
        const key = `${kindLabel}:${code}`;
        if (orgIds.has(key)) return;
        const id = await this.findOrgByCode(tx, kindLabel, code);
        if (id === null) {
          if (required || code) errors.push({ line, matricule, error: `référence inconnue dans ce tenant : ${kindLabel} « ${code} »` });
        } else {
          orgIds.set(key, id);
        }
      };
      for (const row of rows) {
        await resolve('company', row.companyCode, row.line, row.matricule, true);
        await resolve('unit', row.unitCode, row.line, row.matricule, true);
        await resolve('site', row.siteCode, row.line, row.matricule, false);
        await resolve('position', row.positionCode, row.line, row.matricule, false);
        await resolve('job', row.jobCode, row.line, row.matricule, false);
        await resolve('cost_center', row.costCenterCode, row.line, row.matricule, false);
        // Un poste visé doit être ACTIF et rattaché à l'organisation à la date d'effet.
        if (row.positionCode && orgIds.has(`position:${row.positionCode}`)) {
          const at = row.effectiveFrom ?? row.hireDate ?? defaultFrom;
          const ok = await tx.$queryRaw<Array<{ ok: boolean }>>`
            SELECT (p.status = 'active' AND EXISTS (
                     SELECT 1 FROM org.position_assignments pa
                      WHERE pa.position_id = p.id
                        AND daterange(pa.effective_from, pa.effective_to, '[)') @> ${at}::date)) AS ok
              FROM org.positions p WHERE p.id = ${orgIds.get(`position:${row.positionCode}`)!}::uuid`;
          if (!ok[0]?.ok) {
            errors.push({ line: row.line, matricule: row.matricule, error: `poste « ${row.positionCode} » inactif ou non rattaché à la date d'effet` });
          }
        }
        // Stratégie create_only : les collisions avec l'existant sont des erreurs.
        const dupMat = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM core.employees WHERE matricule = ${row.matricule}`;
        if (dupMat.length > 0) {
          errors.push({ line: row.line, matricule: row.matricule, error: 'matricule déjà présent dans ce tenant (stratégie create_only)' });
        }
        if (row.cnssNumber) {
          const dupCnss = await tx.$queryRaw<Array<{ employee_id: string }>>`
            SELECT employee_id FROM core.employee_identifiers WHERE cnss_number = ${row.cnssNumber}`;
          if (dupCnss.length > 0) {
            // La VALEUR CNSS ne sort jamais — ligne et matricule suffisent.
            errors.push({ line: row.line, matricule: row.matricule, error: 'numéro CNSS déjà présent dans ce tenant' });
          }
        }
      }

      const counts: Record<string, number> = {
        employees: rows.length,
        private_zones: rows.filter((r) => r.birthDate || r.nationality || r.personalEmail || r.personalPhone).length,
        identifier_zones: rows.filter((r) => r.cnssNumber || r.taxId).length,
        assignments: rows.length,
      };

      if (errors.length > 0) {
        errors.sort((a, b) => a.line - b.line);
        await auditAuth(tx, tenantId, {
          action: 'hr_import_rejected', actorUserId, recordType: 'hr_import', module: 'hr',
          reason: `mode=${input.mode};lignes=${rows.length};erreurs=${errors.length}`, result: 'denied',
        });
        return { kind: 'invalid', errors: errors.slice(0, MAX_REPORT_ERRORS), counts };
      }

      if (input.mode === 'preview') {
        await auditAuth(tx, tenantId, {
          action: 'hr_import_previewed', actorUserId, recordType: 'hr_import', module: 'hr',
          reason: `lignes=${rows.length}`, result: 'success',
        });
        return { kind: 'preview_ok', counts };
      }

      // ---------- APPLICATION (une seule transaction : tout ou rien) ----------
      for (const row of rows) {
        await this.insertRow(tx, tenantId, actorUserId, row, orgIds, defaultFrom);
      }
      await auditAuth(tx, tenantId, {
        action: 'hr_import_applied', actorUserId, recordType: 'hr_import', module: 'hr',
        newValue: counts, reason: `lignes=${rows.length}`, result: 'success',
      });
      return { kind: 'applied', counts };
    });
  }

  private async insertRow(
    tx: Prisma.TransactionClient, tenantId: string, actor: string,
    row: HrImportRow, orgIds: Map<string, string>, defaultFrom: string,
  ): Promise<void> {
    const companyId = orgIds.get(`company:${row.companyCode}`)!;
    const unitId = orgIds.get(`unit:${row.unitCode}`)!;
    const siteId = row.siteCode ? orgIds.get(`site:${row.siteCode}`) ?? null : null;
    const positionId = row.positionCode ? orgIds.get(`position:${row.positionCode}`) ?? null : null;
    const jobId = row.jobCode ? orgIds.get(`job:${row.jobCode}`) ?? null : null;
    const costCenterId = row.costCenterCode ? orgIds.get(`cost_center:${row.costCenterCode}`) ?? null : null;
    const from = row.effectiveFrom ?? row.hireDate ?? defaultFrom;

    const emp = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO core.employees
        (tenant_id, matricule, first_name, last_name, status, hire_date, professional_status,
         employer_company_id, main_site_id, work_email)
      VALUES (${tenantId}::uuid, ${row.matricule}, ${row.firstName}, ${row.lastName}, 'active',
              ${row.hireDate ?? null}::date, ${row.professionalStatus ?? null},
              ${companyId}::uuid, ${siteId}::uuid, ${row.workEmail ?? null})
      RETURNING id`;
    const employeeId = emp[0]!.id;

    if (row.birthDate || row.nationality || row.personalEmail || row.personalPhone) {
      await tx.$executeRaw`
        INSERT INTO core.employee_private (employee_id, tenant_id, birth_date, nationality, personal_email, personal_phone)
        VALUES (${employeeId}::uuid, ${tenantId}::uuid, ${row.birthDate ?? null}::date, ${row.nationality ?? null},
                ${row.personalEmail ?? null}, ${row.personalPhone ?? null})`;
    }
    if (row.cnssNumber || row.taxId) {
      await tx.$executeRaw`
        INSERT INTO core.employee_identifiers (employee_id, tenant_id, cnss_number, tax_id)
        VALUES (${employeeId}::uuid, ${tenantId}::uuid, ${row.cnssNumber ?? null}, ${row.taxId ?? null})`;
    }
    await tx.$executeRaw`
      INSERT INTO core.employee_assignments
        (tenant_id, employee_id, company_id, site_id, unit_id, position_id, job_id, cost_center_id,
         is_primary, effective_from, created_by)
      VALUES (${tenantId}::uuid, ${employeeId}::uuid, ${companyId}::uuid, ${siteId}::uuid, ${unitId}::uuid,
              ${positionId}::uuid, ${jobId}::uuid, ${costCenterId}::uuid, true, ${from}::date, ${actor}::uuid)`;
    await tx.$executeRaw`
      INSERT INTO core.career_events (tenant_id, employee_id, event_type, effective_date, details, created_by)
      VALUES (${tenantId}::uuid, ${employeeId}::uuid, 'hire', ${row.hireDate ?? from}::date,
              ${JSON.stringify({ to: 'active', source: 'import' })}::jsonb, ${actor}::uuid)`;
  }

  private async findOrgByCode(tx: Prisma.TransactionClient, kind: string, code: string): Promise<string | null> {
    let rows: Array<{ id: string }> = [];
    switch (kind) {
      case 'company': rows = await tx.$queryRaw`SELECT id FROM org.companies WHERE code = ${code} AND status <> 'archived'`; break;
      case 'site': rows = await tx.$queryRaw`SELECT id FROM org.sites WHERE code = ${code} AND status <> 'archived'`; break;
      case 'unit': rows = await tx.$queryRaw`SELECT id FROM org.units WHERE code = ${code} AND status <> 'archived'`; break;
      case 'position': rows = await tx.$queryRaw`SELECT id FROM org.positions WHERE code = ${code}`; break;
      case 'job': rows = await tx.$queryRaw`SELECT id FROM org.jobs WHERE code = ${code} AND status <> 'archived'`; break;
      case 'cost_center': rows = await tx.$queryRaw`SELECT id FROM org.cost_centers WHERE code = ${code} AND status <> 'archived'`; break;
    }
    return rows[0]?.id ?? null;
  }
}
