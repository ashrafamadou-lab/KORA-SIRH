/**
 * E11.3 — Clôture des congés, exports préparatoires paie, reporting.
 *
 * La clôture PHOTOGRAPHIE le ledger (lignes figées par salarié, type et période
 * de référence), porte une empreinte SHA-256 REPRODUCTIBLE (recalculable depuis
 * les lignes figées), est idempotente, refuse les clôtures concurrentes
 * (verrou consultatif + unicité) et interdit — PAR LA BASE — les mouvements
 * ordinaires rétroactifs dans une période close. Réouverture : circuit E3
 * dédié, révision +1, l'ancienne clôture et ses exports DEMEURENT.
 * Les exports (CSV/JSON, schéma kora-conges-prep-1) ne portent JAMAIS un
 * montant (garde anti-montant par construction), sont idempotents (même
 * contenu ⇒ même export), immuables, remplacés jamais supprimés, téléchargés
 * sous permission et audités. Le reporting est agrégé, borné aux portées
 * réelles, sans AUCUN motif ni donnée médicale.
 */
import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { auditAuth } from '../auth/audit.util';
import { NotificationService } from '../notify/notification.service';
import { WorkflowService } from '../workflow/workflow.service';
import { LeaveCatalogService } from './catalog.service';
import {
  DATE_RE, holdsPermission, pgCode, scopeSetFor, paramsAt, type TimeOutcome,
} from './leave-access';
import {
  LEAVE_CLOSE_ENGINE_VERSION, LEAVE_PREP_SCHEMA_VERSION, closeFingerprint, prepVariables,
  assertNoAmounts, utilizationRate, type CloseLine,
} from '../../../../packages/core/src/leave-close.ts';
import { LEAVE_PARAM_KEYS } from '../../../../packages/core/src/leave.ts';

type Tx = Prisma.TransactionClient;

interface PrecloseCheck {
  code: string; level: 'blocking' | 'warning'; count: number; detail: string;
}

@Injectable()
export class LeaveCloseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notify: NotificationService,
    private readonly wf: WorkflowService,
    private readonly catalog: LeaveCatalogService,
  ) {
    // Pont E3 : la réouverture APPROUVÉE bascule la période (révision +1) dans
    // la transaction de décision — clôtures et exports antérieurs DEMEURENT.
    this.wf.registerSubjectHandler('leave_period_reopen', async (tx, tenantId, subjectId, status) => {
      if (status !== 'approved') return;
      await tx.$executeRaw`
        UPDATE leave.periods SET status = 'reopened', revision = revision + 1
         WHERE id = ${subjectId}::uuid AND status = 'closed'`;
      await auditAuth(tx, tenantId, {
        action: 'leave_period_reopened', module: 'leave',
        recordType: 'leave_period', recordId: subjectId, result: 'success',
      });
    });
  }

  // ==================================================================
  // Périodes
  // ==================================================================

  async createPeriod(tenantId: string, actor: string, input: { label: string; periodStart: string; periodEnd: string }): Promise<TimeOutcome<{ id: string }>> {
    if (!DATE_RE.test(input.periodStart) || !DATE_RE.test(input.periodEnd) || input.periodEnd < input.periodStart) {
      return { kind: 'invalid', reason: 'période invalide (AAAA-MM-JJ, début ≤ fin)' };
    }
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'leave.period_manage'))) {
        return { kind: 'forbidden', reason: 'permission requise : leave.period_manage' };
      }
      try {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO leave.periods (tenant_id, label, period_start, period_end, created_by)
          VALUES (${tenantId}::uuid, ${input.label}, ${input.periodStart}::date, ${input.periodEnd}::date, ${actor}::uuid)
          RETURNING id`;
        await auditAuth(tx, tenantId, {
          action: 'leave_period_created', actorUserId: actor, module: 'leave',
          recordType: 'leave_period', recordId: rows[0]!.id,
          newValue: { label: input.label, start: input.periodStart, end: input.periodEnd }, result: 'success',
        });
        return { kind: 'ok', id: rows[0]!.id };
      } catch (e) {
        // Le CODE SQLSTATE est le seul contrat : le message d'une erreur brute
        // Prisma vaut « N/A » en CI (leçon run 30818155276). 23P01 = exclusion.
        if (pgCode(e) === '23P01' || (e as Error).message.includes('leave_periods_no_overlap')) {
          return { kind: 'conflict', reason: 'périodes de congés chevauchantes — la base refuse' };
        }
        throw e;
      }
    });
  }

  async listPeriods(tenantId: string, actor: string): Promise<TimeOutcome<{ items: unknown[] }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'leave.period_manage', 'leave.close_run', 'leave.close_view', 'leave.reopen'))) {
        return { kind: 'forbidden', reason: 'permission requise : leave.close_view' };
      }
      const rows = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT p.id, p.label, p.period_start::text AS "periodStart", p.period_end::text AS "periodEnd",
               p.status, p.revision,
               (SELECT count(*)::int FROM leave.period_closes c WHERE c.period_id = p.id) AS "closeCount",
               (SELECT c2.dataset_sha256 FROM leave.period_closes c2
                 WHERE c2.period_id = p.id AND c2.status = 'active' ORDER BY c2.close_no DESC LIMIT 1) AS "activeFingerprint"
          FROM leave.periods p ORDER BY p.period_start DESC`;
      return { kind: 'ok', items: rows };
    });
  }

  // ==================================================================
  // Pré-clôture : contrôles EXHAUSTIFS, niveaux explicites
  // ==================================================================

  async preclose(tenantId: string, actor: string, periodId: string): Promise<TimeOutcome<{ preclose: unknown }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'leave.close_run', 'leave.close_view'))) {
        return { kind: 'forbidden', reason: 'permission requise : leave.close_run' };
      }
      const period = await this.periodRow(tx, periodId);
      if (!period) return { kind: 'not_found' };
      const checks = await this.precloseChecks(tx, tenantId, period);
      await auditAuth(tx, tenantId, {
        action: 'leave_preclose_run', actorUserId: actor, module: 'leave',
        recordType: 'leave_period', recordId: periodId, result: 'success',
      });
      return {
        kind: 'ok',
        preclose: {
          periodId, label: period.label, status: period.status, revision: period.revision,
          blocking: checks.filter((c) => c.level === 'blocking'),
          warnings: checks.filter((c) => c.level === 'warning'),
        },
      };
    }, { timeoutMs: 30000 });
  }

  private async precloseChecks(tx: Tx, tenantId: string, period: { id: string; period_start: string; period_end: string }): Promise<PrecloseCheck[]> {
    const out: PrecloseCheck[] = [];
    const add = async (code: string, level: 'blocking' | 'warning', detail: string, sql: Prisma.Sql): Promise<void> => {
      const rows = await tx.$queryRaw<Array<{ n: unknown }>>(sql);
      const n = Number(rows[0]?.n ?? 0);
      if (n > 0) out.push({ code, level, count: n, detail });
    };
    const s = period.period_start;
    const e = period.period_end;
    await add('pending_requests', 'warning', 'demandes soumises ou en instruction sur la période',
      Prisma.sql`SELECT count(*) AS n FROM leave.requests r
        JOIN leave.request_versions v ON v.request_id = r.id AND v.version = r.current_version
       WHERE r.status IN ('submitted', 'in_review')
         AND daterange(v.start_date, v.end_date, '[]') && daterange(${s}::date, ${e}::date, '[]')`);
    await add('approved_not_applied', 'blocking', 'demandes approuvées non appliquées',
      Prisma.sql`SELECT count(*) AS n FROM leave.requests r
        JOIN leave.request_versions v ON v.request_id = r.id AND v.version = r.current_version
       WHERE r.status IN ('approved', 'approved_pending_application')
         AND daterange(v.start_date, v.end_date, '[]') && daterange(${s}::date, ${e}::date, '[]')`);
    await add('application_failed', 'blocking', 'applications en échec — reprise requise',
      Prisma.sql`SELECT count(*) AS n FROM leave.requests r
        JOIN leave.request_versions v ON v.request_id = r.id AND v.version = r.current_version
       WHERE r.status = 'application_failed'
         AND daterange(v.start_date, v.end_date, '[]') && daterange(${s}::date, ${e}::date, '[]')`);
    await add('missing_justification', 'warning', 'demandes appliquées dont le justificatif exigé manque',
      Prisma.sql`SELECT count(*) AS n FROM leave.requests r
        JOIN leave.absence_types t ON t.id = r.absence_type_id AND t.justification = 'required'
        JOIN leave.request_versions v ON v.request_id = r.id AND v.version = r.current_version
       WHERE r.status = 'applied'
         AND daterange(v.start_date, v.end_date, '[]') && daterange(${s}::date, ${e}::date, '[]')
         AND NOT EXISTS (SELECT 1 FROM leave.request_attachments a
                          WHERE a.request_id = r.id AND a.deleted_at IS NULL)`);
    await add('negative_unauthorized', 'blocking', 'soldes négatifs sur des types qui l’interdisent',
      Prisma.sql`SELECT count(*) AS n FROM leave.balances_v b
        JOIN leave.absence_types t ON t.id = b.absence_type_id
       WHERE b.available < 0 AND t.negative_allowed = false`);
    await add('ledger_anomalies', 'blocking', 'reversements sans mouvement cible (intégrité du ledger)',
      Prisma.sql`SELECT count(*) AS n FROM leave.entitlement_ledger l
       WHERE l.entry_kind = 'reversal' AND l.reversal_of IS NULL`);
    await add('unreconciled_reservations', 'warning', 'réservations vivantes de demandes déjà terminées (non rapprochées)',
      Prisma.sql`SELECT count(*) AS n FROM leave.requests r
       WHERE r.status IN ('rejected', 'cancelled', 'expired')
         AND (SELECT COALESCE(sum(CASE entry_kind WHEN 'reservation' THEN quantity ELSE -quantity END), 0)
                FROM leave.entitlement_ledger led
               WHERE led.request_id = r.id AND led.entry_kind IN ('reservation', 'release')) > 0`);
    await add('absences_not_integrated', 'blocking', 'absences approuvées non intégrées à la présence (impact différé ou en attente)',
      Prisma.sql`SELECT count(*) AS n FROM leave.absences a
       WHERE a.status = 'approved' AND a.presence_impact IN ('deferred', 'pending_closed_period')
         AND daterange(a.start_date, a.end_date, '[]') && daterange(${s}::date, ${e}::date, '[]')`);
    await add('time_periods_open', 'warning', 'présence non close sur la période : périodes E10 ouvertes/incohérentes ou journées sans clôture E10',
      Prisma.sql`SELECT (
        (SELECT count(*) FROM time.periods p
          WHERE p.status NOT IN ('closed', 'archived')
            AND daterange(p.period_start, p.period_end, '[]') && daterange(${s}::date, ${e}::date, '[]'))
        + (SELECT count(*) FROM generate_series(${s}::date, ${e}::date, interval '1 day') d(day)
            WHERE NOT EXISTS (SELECT 1 FROM time.periods p2
                               WHERE p2.status IN ('closed', 'archived')
                                 AND d.day::date BETWEEN p2.period_start AND p2.period_end))
      )::int AS n`);
    await add('draft_policies', 'warning', 'politiques non actives référencées par des types utilisés',
      Prisma.sql`SELECT count(*) AS n FROM leave.policies p
       WHERE p.status = 'draft'
         AND EXISTS (SELECT 1 FROM leave.entitlement_ledger l WHERE l.absence_type_id = p.absence_type_id)`);
    // Paramètres E4 du module : chacun doit être résoluble à la fin de période.
    const provenance = await paramsAt(tx, tenantId, e, [...LEAVE_PARAM_KEYS]);
    const missing = [...LEAVE_PARAM_KEYS].filter((k) => provenance[k]?.source !== 'parametre');
    if (missing.length > 0) {
      out.push({
        code: 'params_unresolved', level: 'warning', count: missing.length,
        detail: `paramètres E4 non résolus à la date de clôture : ${missing.join(', ')}`,
      });
    }
    return out;
  }

  // ==================================================================
  // Clôture : photographie du ledger + empreinte REPRODUCTIBLE
  // ==================================================================

  async close(tenantId: string, actor: string, periodId: string, opts: { confirmWarnings?: boolean }): Promise<TimeOutcome<{
    closeId: string; closeNo: number; fingerprint: string; linesCount: number; warnings: unknown[];
  }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'leave.close_run'))) {
        return { kind: 'forbidden', reason: 'permission requise : leave.close_run' };
      }
      // Sérialisation DÉTERMINISTE des clôtures concurrentes (leçon E10.2/E11.1) —
      // $executeRaw : pg_advisory_xact_lock renvoie void (leçon CI 30850506848).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}::text || ':leave_close'))`;
      const period = await this.periodRow(tx, periodId, true);
      if (!period) return { kind: 'not_found' };
      if (period.status !== 'open' && period.status !== 'reopened') {
        return { kind: 'conflict', reason: `période au statut « ${period.status} » — seule une période ouverte ou rouverte se clôt` };
      }
      const checks = await this.precloseChecks(tx, tenantId, period);
      const blocking = checks.filter((c) => c.level === 'blocking');
      if (blocking.length > 0) {
        return { kind: 'conflict', reason: `clôture refusée — bloquants : ${blocking.map((c) => `${c.code} (${c.count})`).join(', ')}` };
      }
      const warnings = checks.filter((c) => c.level === 'warning');
      if (warnings.length > 0 && opts.confirmWarnings !== true) {
        return { kind: 'invalid', reason: `avertissements à CONFIRMER : ${warnings.map((c) => c.code).join(', ')} (confirmWarnings=true)` };
      }
      // Photographie : tous les compteurs courants dont la période de référence
      // CROISE la période close — la clôture fige l'état du ledger, pas une copie.
      const lines = await tx.$queryRaw<Array<{
        employee_id: string; absence_type_id: string; period_start: string;
        accrued: unknown; adjusted_out: unknown; carried_in: unknown; expired: unknown;
        reserved: unknown; consumed: unknown; available: unknown; unit: string; movements: unknown;
      }>>`
        SELECT b.employee_id, b.absence_type_id, b.reference_period_start::text AS period_start,
               b.accrued, b.adjusted_out, b.carried_in, b.expired, b.reserved, b.consumed, b.available,
               b.unit,
               (SELECT count(*)::int FROM leave.entitlement_ledger l
                 WHERE l.employee_id = b.employee_id AND l.absence_type_id = b.absence_type_id
                   AND l.reference_period_start = b.reference_period_start) AS movements
          FROM leave.balances_v b
         WHERE b.reference_period_start <= ${period.period_end}::date
           AND b.reference_period_end >= ${period.period_start}::date
         ORDER BY b.employee_id, b.absence_type_id, b.reference_period_start`;
      const coreLines: CloseLine[] = lines.map((l) => ({
        employeeId: l.employee_id, absenceTypeId: l.absence_type_id, periodStart: l.period_start,
        accrued: Number(l.accrued), adjustedOut: Number(l.adjusted_out), carriedIn: Number(l.carried_in),
        expired: Number(l.expired), reserved: Number(l.reserved), consumed: Number(l.consumed),
        available: Number(l.available), unit: l.unit, movements: Number(l.movements),
      }));
      const fingerprint = closeFingerprint(coreLines);
      const provenance = await paramsAt(tx, tenantId, period.period_end, [...LEAVE_PARAM_KEYS]);
      const policies = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT p.code, v.version, v.effective_from::text AS "effectiveFrom"
          FROM leave.policies p JOIN leave.policy_versions v ON v.policy_id = p.id
         WHERE p.status = 'active' ORDER BY p.code, v.version`;
      const closeNoRows = await tx.$queryRaw<Array<{ n: unknown }>>`
        SELECT COALESCE(max(close_no), 0) + 1 AS n FROM leave.period_closes WHERE period_id = ${periodId}::uuid`;
      const closeNo = Number(closeNoRows[0]!.n);
      // La clôture précédente encore active est SUPERSÉDÉE (jamais supprimée).
      await tx.$executeRaw`
        UPDATE leave.period_closes SET status = 'superseded'
         WHERE period_id = ${periodId}::uuid AND status = 'active'`;
      const totals: Record<string, { accrued: number; consumed: number; available: number }> = {};
      for (const l of coreLines) {
        const t = totals[l.unit] ?? { accrued: 0, consumed: 0, available: 0 };
        t.accrued = Math.round((t.accrued + l.accrued) * 1000) / 1000;
        t.consumed = Math.round((t.consumed + l.consumed) * 1000) / 1000;
        t.available = Math.round((t.available + l.available) * 1000) / 1000;
        totals[l.unit] = t;
      }
      const ins = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO leave.period_closes (tenant_id, period_id, close_no, period_revision, engine_version,
          params_snapshot, policies_snapshot, dataset_sha256, employees_count, lines_count, movements_count,
          totals, warnings, closed_by)
        VALUES (${tenantId}::uuid, ${periodId}::uuid, ${closeNo}, ${period.revision}, ${LEAVE_CLOSE_ENGINE_VERSION},
          ${JSON.stringify(provenance)}::jsonb, ${JSON.stringify(policies)}::jsonb, ${fingerprint},
          ${new Set(coreLines.map((l) => l.employeeId)).size}, ${coreLines.length},
          ${coreLines.reduce((a, l) => a + l.movements, 0)},
          ${JSON.stringify(totals)}::jsonb, ${JSON.stringify(warnings)}::jsonb, ${actor}::uuid)
        RETURNING id`;
      const closeId = ins[0]!.id;
      for (const l of coreLines) {
        await tx.$executeRaw`
          INSERT INTO leave.close_lines (tenant_id, close_id, employee_id, absence_type_id, period_start,
            accrued, adjusted_out, carried_in, expired, reserved, consumed, available, unit, movements)
          VALUES (${tenantId}::uuid, ${closeId}::uuid, ${l.employeeId}::uuid, ${l.absenceTypeId}::uuid,
            ${l.periodStart}::date, ${l.accrued}, ${l.adjustedOut}, ${l.carriedIn}, ${l.expired},
            ${l.reserved}, ${l.consumed}, ${l.available}, ${l.unit}, ${l.movements})`;
      }
      await tx.$executeRaw`
        UPDATE leave.periods SET status = 'closed' WHERE id = ${periodId}::uuid`;
      await auditAuth(tx, tenantId, {
        action: 'leave_period_closed', actorUserId: actor, module: 'leave',
        recordType: 'leave_close', recordId: closeId,
        newValue: { periodId, closeNo, fingerprint, lines: coreLines.length, warnings: warnings.length },
        result: 'success',
      });
      await this.notify.publishEventTx(tx, tenantId, {
        eventKey: `conges-cloture-${periodId}-n${closeNo}`, templateKey: 'conges_cloture_effectuee',
        payload: { periode: period.label, numero: String(closeNo) },
        recipients: [{ userId: actor }], source: 'business',
        subjectType: 'leave_close', subjectId: closeId, createdBy: actor,
      });
      return { kind: 'ok', closeId, closeNo, fingerprint, linesCount: coreLines.length, warnings };
    }, { timeoutMs: 60000 });
  }

  /** Vérification : l'empreinte se RECALCULE depuis les lignes FIGÉES — identique. */
  async verify(tenantId: string, actor: string, closeId: string): Promise<TimeOutcome<{
    stored: string; recomputed: string; match: boolean;
  }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'leave.close_view', 'leave.close_run'))) {
        return { kind: 'forbidden', reason: 'permission requise : leave.close_view' };
      }
      const close = await tx.$queryRaw<Array<{ dataset_sha256: string }>>`
        SELECT dataset_sha256 FROM leave.period_closes WHERE id = ${closeId}::uuid`;
      if (!close[0]) return { kind: 'not_found' };
      const lines = await tx.$queryRaw<Array<{
        employee_id: string; absence_type_id: string; period_start: string;
        accrued: unknown; adjusted_out: unknown; carried_in: unknown; expired: unknown;
        reserved: unknown; consumed: unknown; available: unknown; unit: string; movements: number;
      }>>`
        SELECT employee_id, absence_type_id, period_start::text, accrued, adjusted_out, carried_in,
               expired, reserved, consumed, available, unit, movements
          FROM leave.close_lines WHERE close_id = ${closeId}::uuid`;
      const recomputed = closeFingerprint(lines.map((l) => ({
        employeeId: l.employee_id, absenceTypeId: l.absence_type_id, periodStart: l.period_start,
        accrued: Number(l.accrued), adjustedOut: Number(l.adjusted_out), carriedIn: Number(l.carried_in),
        expired: Number(l.expired), reserved: Number(l.reserved), consumed: Number(l.consumed),
        available: Number(l.available), unit: l.unit, movements: Number(l.movements),
      })));
      return {
        kind: 'ok', stored: close[0].dataset_sha256, recomputed,
        match: recomputed === close[0].dataset_sha256,
      };
    });
  }

  async listCloses(tenantId: string, actor: string, periodId: string): Promise<TimeOutcome<{ items: unknown[] }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'leave.close_view', 'leave.close_run'))) {
        return { kind: 'forbidden', reason: 'permission requise : leave.close_view' };
      }
      const rows = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT id, close_no AS "closeNo", period_revision AS "periodRevision", engine_version AS "engineVersion",
               dataset_sha256 AS fingerprint, employees_count AS "employeesCount", lines_count AS "linesCount",
               movements_count AS "movementsCount", totals, warnings, status, closed_at AS "closedAt"
          FROM leave.period_closes WHERE period_id = ${periodId}::uuid ORDER BY close_no`;
      return { kind: 'ok', items: rows };
    });
  }

  /** Réouverture par CIRCUIT dédié : motif obligatoire, l'histoire DEMEURE. */
  async requestReopen(tenantId: string, actor: string, periodId: string, reason: string): Promise<TimeOutcome<{ instanceId: string }>> {
    if (!reason || reason.trim().length < 3) return { kind: 'invalid', reason: 'motif de réouverture obligatoire' };
    const prep = await this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'leave.reopen'))) {
        return { kind: 'forbidden' as const, reason: 'permission requise : leave.reopen' };
      }
      const period = await this.periodRow(tx, periodId);
      if (!period) return { kind: 'not_found' as const };
      if (period.status !== 'closed') {
        return { kind: 'conflict' as const, reason: `période au statut « ${period.status} » — seule une période close se rouvre` };
      }
      return { kind: 'ok' as const, label: period.label };
    });
    if (prep.kind !== 'ok') return prep;
    const submitted = await this.wf.submit(tenantId, actor, {
      definitionKey: 'conges_periode_reouverture', subjectType: 'leave_period_reopen', subjectId: periodId,
      context: { periodId, reason },
    });
    if (submitted.kind === 'no_active_definition') {
      return { kind: 'conflict', reason: 'aucun circuit « conges_periode_reouverture » actif — configurez le workflow' };
    }
    if (submitted.kind !== 'ok') return { kind: 'invalid', reason: 'workflow vide' };
    await this.prisma.withTenant(tenantId, (tx) => auditAuth(tx, tenantId, {
      action: 'leave_reopen_requested', actorUserId: actor, module: 'leave',
      recordType: 'leave_period', recordId: periodId, reason, result: 'success',
    }));
    return { kind: 'ok', instanceId: submitted.instanceId };
  }

  // ==================================================================
  // Exports préparatoires paie — SANS montant, idempotents, immuables
  // ==================================================================

  async createExport(tenantId: string, actor: string, closeId: string, format: 'csv' | 'json'): Promise<TimeOutcome<{
    exportId: string; revision: number; sha256: string; reused: boolean;
  }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'leave.export_create'))) {
        return { kind: 'forbidden', reason: 'permission requise : leave.export_create' };
      }
      const close = await tx.$queryRaw<Array<{
        id: string; period_id: string; close_no: number; status: string; dataset_sha256: string;
        period_start: string; period_end: string; label: string;
      }>>`
        SELECT c.id, c.period_id, c.close_no, c.status, c.dataset_sha256,
               p.period_start::text, p.period_end::text, p.label
          FROM leave.period_closes c JOIN leave.periods p ON p.id = c.period_id
         WHERE c.id = ${closeId}::uuid`;
      const cl = close[0];
      if (!cl) return { kind: 'not_found' };
      if (cl.status !== 'active') {
        return { kind: 'conflict', reason: 'clôture supersédée — exporter depuis la clôture ACTIVE' };
      }
      // Faits de la période (actifs = volumes ; supersédés = corrections comptées).
      const facts = await tx.$queryRaw<Array<{
        employee_id: string; prep_category: string; paid: boolean; unit: string;
        counted: unknown; minutes: number | null; status: string;
      }>>`
        SELECT employee_id, prep_category, paid, unit, counted, minutes, status
          FROM time.absence_facts
         WHERE work_date BETWEEN ${cl.period_start}::date AND ${cl.period_end}::date
           AND status IN ('active', 'superseded')
         ORDER BY employee_id`;
      const employees = await tx.$queryRaw<Array<{ id: string; matricule: string }>>`
        SELECT id, matricule FROM core.employees WHERE deleted_at IS NULL`;
      const matriculeOf = new Map(employees.map((e) => [e.id, e.matricule]));
      const vars = prepVariables(facts.map((f) => ({
        employeeId: f.employee_id, category: f.prep_category, paid: f.paid, unit: f.unit,
        counted: Number(f.counted), minutes: f.minutes, superseded: f.status === 'superseded',
      })));
      const timeCloses = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT c.id, p.label, c.close_no AS "closeNo", c.dataset_sha256 AS fingerprint
          FROM time.period_closes c JOIN time.periods p ON p.id = c.period_id
         WHERE c.status = 'active'
           AND daterange(p.period_start, p.period_end, '[]') && daterange(${cl.period_start}::date, ${cl.period_end}::date, '[]')
         ORDER BY p.period_start`;
      const contract = {
        schema: LEAVE_PREP_SCHEMA_VERSION,
        module: 'conges',
        periode: { label: cl.label, debut: cl.period_start, fin: cl.period_end },
        cloture: { id: cl.id, numero: cl.close_no, empreinte: cl.dataset_sha256 },
        cloturesPresence: timeCloses,
        salaries: vars.map((v) => ({
          module: 'conges',
          origine: 'absence_appliquee',
          matricule: matriculeOf.get(v.employeeId) ?? v.employeeId,
          categories: v.categories,
          corrections: v.correctionsCount,
        })),
      };
      // Garde ANTI-MONTANT : refus par construction, jamais une promesse.
      const violation = assertNoAmounts(contract);
      if (violation) return { kind: 'invalid', reason: violation };
      let content: Buffer;
      if (format === 'json') {
        content = Buffer.from(JSON.stringify(contract, null, 1), 'utf8');
      } else {
        const lines = ['module;origine;matricule;categorie;jours;heures;corrections'];
        for (const v of contract.salaries) {
          for (const [cat, val] of Object.entries(v.categories)) {
            lines.push(`conges;absence_appliquee;${v.matricule};${cat};${val.days};${val.hours};${v.corrections}`);
          }
          if (Object.keys(v.categories).length === 0) {
            lines.push(`conges;absence_appliquee;${v.matricule};;0;0;${v.corrections}`);
          }
        }
        content = Buffer.from(lines.join('\n'), 'utf8');
      }
      const sha256 = createHash('sha256').update(content).digest('hex');
      // IDEMPOTENT : même contenu que l'export ACTIF du même format ⇒ réutilisé.
      const existing = await tx.$queryRaw<Array<{ id: string; revision: number; sha256: string }>>`
        SELECT id, revision, sha256 FROM leave.prep_exports
         WHERE close_id = ${closeId}::uuid AND format = ${format} AND status = 'active'
         ORDER BY revision DESC LIMIT 1`;
      if (existing[0] && existing[0].sha256 === sha256) {
        return { kind: 'ok', exportId: existing[0].id, revision: existing[0].revision, sha256, reused: true };
      }
      if (existing[0]) {
        await tx.$executeRaw`UPDATE leave.prep_exports SET status = 'superseded' WHERE id = ${existing[0].id}::uuid`;
      }
      const revRows = await tx.$queryRaw<Array<{ n: unknown }>>`
        SELECT COALESCE(max(revision), 0) + 1 AS n FROM leave.prep_exports
         WHERE close_id = ${closeId}::uuid AND format = ${format}`;
      const revision = Number(revRows[0]!.n);
      const ins = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO leave.prep_exports (tenant_id, close_id, schema_version, format, revision, content,
          sha256, time_closes, employees_count, generated_by)
        VALUES (${tenantId}::uuid, ${closeId}::uuid, ${LEAVE_PREP_SCHEMA_VERSION}, ${format}, ${revision},
          ${content}, ${sha256}, ${JSON.stringify(timeCloses)}::jsonb, ${vars.length}, ${actor}::uuid)
        RETURNING id`;
      await auditAuth(tx, tenantId, {
        action: 'leave_export_created', actorUserId: actor, module: 'leave',
        recordType: 'leave_export', recordId: ins[0]!.id,
        newValue: { closeId, format, revision, sha256, employees: vars.length }, result: 'success',
      });
      return { kind: 'ok', exportId: ins[0]!.id, revision, sha256, reused: false };
    }, { timeoutMs: 30000 });
  }

  async listExports(tenantId: string, actor: string, closeId: string): Promise<TimeOutcome<{ items: unknown[] }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'leave.export_create', 'leave.export_download', 'leave.close_view'))) {
        return { kind: 'forbidden', reason: 'permission requise : leave.export_download' };
      }
      const rows = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT id, schema_version AS "schemaVersion", format, revision, sha256, time_closes AS "timeCloses",
               employees_count AS "employeesCount", error_report AS "errorReport", status,
               generated_at AS "generatedAt"
          FROM leave.prep_exports WHERE close_id = ${closeId}::uuid ORDER BY format, revision`;
      return { kind: 'ok', items: rows };
    });
  }

  async downloadExport(tenantId: string, actor: string, exportId: string): Promise<TimeOutcome<{
    filename: string; format: string; contentBase64: string; sha256: string;
  }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'leave.export_download'))) {
        return { kind: 'forbidden', reason: 'permission requise : leave.export_download' };
      }
      const rows = await tx.$queryRaw<Array<{ id: string; format: string; revision: number; content: Buffer; sha256: string; close_id: string }>>`
        SELECT id, format, revision, content, sha256, close_id FROM leave.prep_exports WHERE id = ${exportId}::uuid`;
      const e = rows[0];
      if (!e) return { kind: 'not_found' };
      await auditAuth(tx, tenantId, {
        action: 'leave_export_downloaded', actorUserId: actor, module: 'leave',
        recordType: 'leave_export', recordId: exportId, result: 'success',
      });
      return {
        kind: 'ok',
        filename: `conges-prep-${e.close_id.slice(0, 8)}-r${e.revision}.${e.format}`,
        format: e.format, contentBase64: Buffer.from(e.content).toString('base64'), sha256: e.sha256,
      };
    });
  }

  // ==================================================================
  // Reporting — agrégé, borné aux portées, jamais un motif médical
  // ==================================================================

  async report(tenantId: string, actor: string, opts: { from: string; to: string }): Promise<TimeOutcome<{ report: unknown }>> {
    if (!DATE_RE.test(opts.from) || !DATE_RE.test(opts.to) || opts.to < opts.from) {
      return { kind: 'invalid', reason: 'plage invalide (AAAA-MM-JJ, from ≤ to)' };
    }
    return this.prisma.withTenant(tenantId, async (tx) => {
      const set = await scopeSetFor(tx, actor, 'leave.reports_view');
      if (set.kind === 'none') return { kind: 'forbidden', reason: 'permission requise : leave.reports_view' };
      const scoped = set.kind === 'scoped';
      const companies = scoped ? set.companies.join(',') : '';
      const sites = scoped ? set.sites.join(',') : '';
      const units = scoped ? set.units.join(',') : '';
      const empFilter = Prisma.sql`
        (${!scoped} OR EXISTS (SELECT 1 FROM core.employee_assignments sc
           WHERE sc.employee_id = X.employee_id AND sc.is_primary
             AND (sc.company_id = ANY(string_to_array(${companies}, ',')::uuid[])
               OR sc.site_id    = ANY(string_to_array(${sites}, ',')::uuid[])
               OR sc.unit_id    = ANY(string_to_array(${units}, ',')::uuid[]))))`;
      const balances = await tx.$queryRaw<Array<{ unit: string; accrued: unknown; reserved: unknown; consumed: unknown; expired: unknown; available: unknown }>>(Prisma.sql`
        SELECT b.unit, sum(b.accrued) AS accrued, sum(b.reserved) AS reserved, sum(b.consumed) AS consumed,
               sum(b.expired) AS expired, sum(b.available) AS available
          FROM leave.balances_v b, LATERAL (SELECT b.employee_id) X
         WHERE ${empFilter}
         GROUP BY b.unit ORDER BY b.unit`);
      const funnel = await tx.$queryRaw<Array<{ status: string; n: unknown }>>(Prisma.sql`
        SELECT r.status, count(*) AS n FROM leave.requests r
          JOIN leave.request_versions v ON v.request_id = r.id AND v.version = r.current_version,
          LATERAL (SELECT r.employee_id) X
         WHERE daterange(v.start_date, v.end_date, '[]') && daterange(${opts.from}::date, ${opts.to}::date, '[]')
           AND ${empFilter}
         GROUP BY r.status ORDER BY r.status`);
      const delays = await tx.$queryRaw<Array<{ avg_hours: unknown; n: unknown }>>(Prisma.sql`
        SELECT avg(EXTRACT(EPOCH FROM (r.updated_at - v.created_at)) / 3600.0) AS avg_hours, count(*) AS n
          FROM leave.requests r
          JOIN leave.request_versions v ON v.request_id = r.id AND v.version = r.current_version,
          LATERAL (SELECT r.employee_id) X
         WHERE r.status IN ('applied', 'rejected', 'cancelled')
           AND daterange(v.start_date, v.end_date, '[]') && daterange(${opts.from}::date, ${opts.to}::date, '[]')
           AND ${empFilter}`);
      const byCategory = await tx.$queryRaw<Array<{ prep_category: string; days: unknown; hours: unknown; n: unknown }>>(Prisma.sql`
        SELECT f.prep_category,
               sum(CASE WHEN f.portion = 'hours' THEN 0 ELSE f.counted END) AS days,
               sum(CASE WHEN f.portion = 'hours' THEN COALESCE(f.minutes, 0) / 60.0 ELSE 0 END) AS hours,
               count(DISTINCT f.absence_id) AS n
          FROM time.absence_facts f, LATERAL (SELECT f.employee_id) X
         WHERE f.status = 'active' AND f.work_date BETWEEN ${opts.from}::date AND ${opts.to}::date
           AND ${empFilter}
         GROUP BY f.prep_category ORDER BY f.prep_category`);
      const byUnit = await tx.$queryRaw<Array<{ unit_id: string | null; code: string | null; days: unknown }>>(Prisma.sql`
        SELECT a.unit_id, u.code, sum(CASE WHEN f.portion = 'hours' THEN 0 ELSE f.counted END) AS days
          FROM time.absence_facts f
          JOIN core.employee_assignments a ON a.employee_id = f.employee_id AND a.is_primary
            AND daterange(a.effective_from, a.effective_to, '[)') @> f.work_date
          LEFT JOIN org.units u ON u.id = a.unit_id,
          LATERAL (SELECT f.employee_id) X
         WHERE f.status = 'active' AND f.work_date BETWEEN ${opts.from}::date AND ${opts.to}::date
           AND ${empFilter}
         GROUP BY a.unit_id, u.code ORDER BY days DESC NULLS LAST`);
      const extras = await tx.$queryRaw<Array<{ retro: unknown; failed: unknown; carried: unknown }>>(Prisma.sql`
        SELECT
          (SELECT count(*) FROM leave.request_versions v2
             JOIN leave.requests r2 ON r2.id = v2.request_id AND r2.current_version = v2.version,
             LATERAL (SELECT r2.employee_id) X
            WHERE v2.retroactive AND ${empFilter}
              AND daterange(v2.start_date, v2.end_date, '[]') && daterange(${opts.from}::date, ${opts.to}::date, '[]')) AS retro,
          (SELECT count(*) FROM leave.requests r3, LATERAL (SELECT r3.employee_id) X
            WHERE r3.status = 'application_failed' AND ${empFilter}) AS failed,
          (SELECT COALESCE(sum(b2.carried_in), 0) FROM leave.balances_v b2, LATERAL (SELECT b2.employee_id) X
            WHERE b2.carried_in > 0 AND ${empFilter}) AS carried`);
      const accrued = balances.reduce((a, b) => a + Number(b.accrued), 0);
      const consumed = balances.reduce((a, b) => a + Number(b.consumed), 0);
      await auditAuth(tx, tenantId, {
        action: 'leave_report_accessed', actorUserId: actor, module: 'leave',
        recordType: 'leave_report', reason: `${opts.from}..${opts.to}`, result: 'success',
      });
      return {
        kind: 'ok',
        report: {
          from: opts.from, to: opts.to,
          balances: balances.map((b) => ({
            unit: b.unit, accrued: Number(b.accrued), reserved: Number(b.reserved),
            consumed: Number(b.consumed), expired: Number(b.expired), available: Number(b.available),
          })),
          utilization: utilizationRate(consumed, accrued),
          requests: funnel.map((f) => ({ status: f.status, count: Number(f.n) })),
          avgProcessingHours: delays[0] && delays[0].avg_hours !== null
            ? Math.round(Number(delays[0].avg_hours) * 10) / 10 : null,
          byCategory: byCategory.map((c) => ({
            category: c.prep_category, days: Number(c.days), hours: Math.round(Number(c.hours) * 100) / 100,
            absences: Number(c.n),
          })),
          byUnit: byUnit.map((u) => ({ unitId: u.unit_id, code: u.code, days: Number(u.days) })),
          retroRequests: Number(extras[0]?.retro ?? 0),
          failedApplications: Number(extras[0]?.failed ?? 0),
          carriedInExposure: Number(extras[0]?.carried ?? 0),
          note: 'Agrégats sans motif ni donnée médicale ; l’exposition au report signale les soldes reportés susceptibles d’expirer (échéancier automatique : limite assumée).',
        },
      };
    }, { timeoutMs: 30000 });
  }

  private async periodRow(tx: Tx, id: string, lock = false): Promise<{ id: string; label: string; period_start: string; period_end: string; status: string; revision: number } | null> {
    const rows = lock
      ? await tx.$queryRaw<Array<{ id: string; label: string; period_start: string; period_end: string; status: string; revision: number }>>`
          SELECT id, label, period_start::text, period_end::text, status, revision
            FROM leave.periods WHERE id = ${id}::uuid FOR UPDATE`
      : await tx.$queryRaw<Array<{ id: string; label: string; period_start: string; period_end: string; status: string; revision: number }>>`
          SELECT id, label, period_start::text, period_end::text, status, revision
            FROM leave.periods WHERE id = ${id}::uuid`;
    return rows[0] ?? null;
  }
}
