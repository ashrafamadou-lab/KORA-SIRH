import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { auditAuth } from '../auth/audit.util';
import {
  mapOrgImportRows,
  parseCsv,
  validateOrgImportRows,
  type OrgImportError,
  type OrgImportKind,
  type OrgImportRow,
} from '../../../../packages/core/src/org.ts';

/**
 * Import initial CSV de l'organisation (E8) — permission org.import, audité.
 *
 * ATOMICITÉ : la validation COMPLÈTE (structure du fichier, cycles, doublons,
 * références internes ET externes, collisions avec l'existant) se fait AVANT toute
 * écriture. La moindre erreur ⇒ rapport détaillé par ligne et ZÉRO insertion — jamais
 * d'insertion partielle silencieuse. Le mode 'preview' rend le même rapport sans écrire.
 *
 * ISOLATION : les références se font PAR CODE, résolues sous RLS dans le tenant
 * courant — le fichier d'un autre tenant ne peut par construction créer aucune
 * référence croisée (ses codes inconnus donnent des erreurs, ses objets restent à lui).
 */

const MAX_CSV_CHARS = 512_000;
const MAX_ROWS = 2000;
const MAX_REPORT_ERRORS = 200;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type ImportOutcome =
  | { kind: 'invalid'; errors: OrgImportError[]; counts: Record<string, number> }
  | { kind: 'preview_ok'; counts: Record<string, number> }
  | { kind: 'applied'; counts: Record<string, number> };

const KIND_TABLE: Record<OrgImportKind, string> = {
  company: 'companies', site: 'sites', cost_center: 'cost_centers',
  job: 'jobs', unit: 'units', position: 'positions',
};

@Injectable()
export class OrgImportService {
  constructor(private readonly prisma: PrismaService) {}

  async run(
    tenantId: string,
    actorUserId: string,
    input: { csv: string; mode: 'preview' | 'apply'; defaultEffectiveFrom?: string },
  ): Promise<ImportOutcome> {
    const defaultFrom = input.defaultEffectiveFrom ?? new Date().toISOString().slice(0, 10);
    if (!DATE_RE.test(defaultFrom)) {
      return { kind: 'invalid', errors: [{ line: 0, error: 'defaultEffectiveFrom invalide (AAAA-MM-JJ)' }], counts: {} };
    }
    if (input.csv.length > MAX_CSV_CHARS) {
      return { kind: 'invalid', errors: [{ line: 0, error: `fichier trop volumineux (max ${MAX_CSV_CHARS} caractères)` }], counts: {} };
    }
    const parsed = parseCsv(input.csv, { maxRows: MAX_ROWS });
    if (!parsed.ok) return { kind: 'invalid', errors: [{ line: parsed.line ?? 0, error: parsed.error }], counts: {} };
    const mapped = mapOrgImportRows(parsed.header, parsed.rows);
    const validation = validateOrgImportRows(mapped.rows);
    const errors: OrgImportError[] = [...mapped.errors, ...validation.errors];

    const counts: Record<string, number> = {};
    for (const r of validation.rows) counts[r.kind] = (counts[r.kind] ?? 0) + 1;

    return this.prisma.withTenant<ImportOutcome>(tenantId, async (tx) => {
      // Références externes au fichier : chaque code doit exister DANS CE TENANT.
      const externalIds = new Map<string, string>(); // "kind:CODE" -> id
      for (const ref of validation.externalRefs) {
        const key = `${ref.refKind}:${ref.code}`;
        if (externalIds.has(key)) continue;
        const id = await this.findByCode(tx, ref.refKind, ref.code);
        if (id === null) {
          errors.push({ line: ref.line, code: ref.code, error: `référence inconnue dans ce tenant : ${ref.refKind} « ${ref.code} »` });
        } else {
          externalIds.set(key, id);
        }
      }
      // Collisions avec l'existant : l'import INITIAL crée, il n'écrase jamais.
      for (const row of validation.rows) {
        const existing = await this.findByCode(tx, row.kind, row.code);
        if (existing !== null) {
          errors.push({ line: row.line, code: row.code, error: `code déjà utilisé dans ce tenant (${row.kind}) — l'import initial ne modifie pas l'existant` });
        }
      }

      if (errors.length > 0) {
        errors.sort((a, b) => a.line - b.line);
        await auditAuth(tx, tenantId, {
          action: 'org_import_rejected', actorUserId, recordType: 'org_import', module: 'org',
          reason: `mode=${input.mode};lignes=${validation.rows.length};erreurs=${errors.length}`, result: 'denied',
        });
        return { kind: 'invalid', errors: errors.slice(0, MAX_REPORT_ERRORS), counts };
      }

      if (input.mode === 'preview') {
        await auditAuth(tx, tenantId, {
          action: 'org_import_previewed', actorUserId, recordType: 'org_import', module: 'org',
          reason: `lignes=${validation.rows.length}`, result: 'success',
        });
        return { kind: 'preview_ok', counts };
      }

      // ---------- APPLICATION (une seule transaction : tout ou rien) ----------
      const ids = new Map<string, string>(externalIds); // "kind:CODE" -> id
      const idOf = (kind: OrgImportKind, code: string | undefined): string | null =>
        code === undefined ? null : ids.get(`${kind}:${code}`) ?? null;
      const byKind = (k: OrgImportKind): OrgImportRow[] => validation.rows.filter((r) => r.kind === k);

      for (const row of byKind('company')) {
        const r = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO org.companies (tenant_id, code, label_fr, label_en, legal_form, status, created_by)
          VALUES (${tenantId}::uuid, ${row.code}, ${row.labelFr}, ${row.labelEn}, ${row.legalForm ?? null}, 'active', ${actorUserId}::uuid)
          RETURNING id`;
        ids.set(`company:${row.code}`, r[0]!.id);
      }
      for (const row of byKind('site')) {
        const r = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO org.sites (tenant_id, company_id, code, label_fr, label_en, city, status, created_by)
          VALUES (${tenantId}::uuid, ${idOf('company', row.companyCode)}::uuid, ${row.code}, ${row.labelFr}, ${row.labelEn}, ${row.city ?? null}, 'active', ${actorUserId}::uuid)
          RETURNING id`;
        ids.set(`site:${row.code}`, r[0]!.id);
      }
      for (const row of byKind('cost_center')) {
        const r = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO org.cost_centers (tenant_id, code, label_fr, label_en, status, created_by)
          VALUES (${tenantId}::uuid, ${row.code}, ${row.labelFr}, ${row.labelEn}, 'active', ${actorUserId}::uuid)
          RETURNING id`;
        ids.set(`cost_center:${row.code}`, r[0]!.id);
      }
      for (const row of byKind('job')) {
        const r = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO org.jobs (tenant_id, code, label_fr, label_en, category, status, created_by)
          VALUES (${tenantId}::uuid, ${row.code}, ${row.labelFr}, ${row.labelEn}, ${row.category ?? null}, 'active', ${actorUserId}::uuid)
          RETURNING id`;
        ids.set(`job:${row.code}`, r[0]!.id);
      }
      for (const row of byKind('unit')) {
        const r = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO org.units (tenant_id, unit_type, code, label_fr, label_en, company_id, status, created_by)
          VALUES (${tenantId}::uuid, ${row.unitType}, ${row.code}, ${row.labelFr}, ${row.labelEn},
                  ${idOf('company', row.companyCode)}::uuid, 'active', ${actorUserId}::uuid)
          RETURNING id`;
        ids.set(`unit:${row.code}`, r[0]!.id);
      }
      // Hiérarchie des unités (les cycles internes au fichier sont déjà exclus ; les
      // triggers SQL restent l'ultime barrière).
      for (const row of byKind('unit')) {
        if (!row.parentCode) continue;
        await tx.$executeRaw`
          INSERT INTO org.unit_parents (tenant_id, unit_id, parent_unit_id, effective_from, created_by)
          VALUES (${tenantId}::uuid, ${idOf('unit', row.code)}::uuid, ${idOf('unit', row.parentCode)}::uuid,
                  ${row.effectiveFrom ?? defaultFrom}::date, ${actorUserId}::uuid)`;
      }
      for (const row of byKind('position')) {
        const r = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO org.positions (tenant_id, code, label_fr, label_en, status, created_by)
          VALUES (${tenantId}::uuid, ${row.code}, ${row.labelFr}, ${row.labelEn}, 'active', ${actorUserId}::uuid)
          RETURNING id`;
        ids.set(`position:${row.code}`, r[0]!.id);
      }
      for (const row of byKind('position')) {
        await tx.$executeRaw`
          INSERT INTO org.position_assignments
            (tenant_id, position_id, unit_id, company_id, job_id, site_id, cost_center_id, effective_from, created_by)
          VALUES (${tenantId}::uuid, ${idOf('position', row.code)}::uuid, ${idOf('unit', row.unitCode)}::uuid,
                  ${idOf('company', row.companyCode)}::uuid, ${idOf('job', row.jobCode)}::uuid,
                  ${idOf('site', row.siteCode)}::uuid, ${idOf('cost_center', row.costCenterCode)}::uuid,
                  ${row.effectiveFrom ?? defaultFrom}::date, ${actorUserId}::uuid)`;
        if (row.managerPositionCode) {
          await tx.$executeRaw`
            INSERT INTO org.position_managers (tenant_id, position_id, manager_position_id, effective_from, created_by)
            VALUES (${tenantId}::uuid, ${idOf('position', row.code)}::uuid, ${idOf('position', row.managerPositionCode)}::uuid,
                    ${row.effectiveFrom ?? defaultFrom}::date, ${actorUserId}::uuid)`;
        }
      }

      await auditAuth(tx, tenantId, {
        action: 'org_import_applied', actorUserId, recordType: 'org_import', module: 'org',
        newValue: counts, reason: `lignes=${validation.rows.length}`, result: 'success',
      });
      return { kind: 'applied', counts };
    });
  }

  private async findByCode(tx: Prisma.TransactionClient, kind: OrgImportKind, code: string): Promise<string | null> {
    let rows: Array<{ id: string }> = [];
    switch (KIND_TABLE[kind]) {
      case 'companies': rows = await tx.$queryRaw`SELECT id FROM org.companies WHERE code = ${code}`; break;
      case 'sites': rows = await tx.$queryRaw`SELECT id FROM org.sites WHERE code = ${code}`; break;
      case 'cost_centers': rows = await tx.$queryRaw`SELECT id FROM org.cost_centers WHERE code = ${code}`; break;
      case 'jobs': rows = await tx.$queryRaw`SELECT id FROM org.jobs WHERE code = ${code}`; break;
      case 'units': rows = await tx.$queryRaw`SELECT id FROM org.units WHERE code = ${code}`; break;
      case 'positions': rows = await tx.$queryRaw`SELECT id FROM org.positions WHERE code = ${code}`; break;
    }
    return rows[0]?.id ?? null;
  }
}
