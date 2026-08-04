/**
 * E11.3 — Intégration Présence : une absence APPLIQUÉE produit des FAITS
 * D'ABSENCE par journée décomptée (versionnés, jamais réécrits), le moteur
 * E10.2 les consomme au recalcul MOTIVÉ et idempotent — sans toucher les
 * pointages bruts, les demandes, le ledger, les anciens résultats ni les
 * clôtures. Période E10 verrouillée/close : l'impact est mis EN ATTENTE
 * (aucune modification automatique d'une clôture) et repris explicitement
 * après la réouverture contrôlée E10.3. L'annulation SUPERSÈDE les faits
 * (motivée, datée) puis un recalcul retire la qualification — l'histoire
 * complète demeure. Les anomalies d'appariement expliquées (missing_in /
 * missing_out) des journées couvertes se résolvent AUTOMATIQUEMENT, référence
 * probante à l'appui, UNIQUEMENT après application réussie.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { auditAuth } from '../auth/audit.util';
import { CalcService } from '../time/calc.service';
import { holdsPermission, type TimeOutcome } from './leave-access';

type Tx = Prisma.TransactionClient;

interface AbsenceRow {
  id: string; employee_id: string; absence_type_id: string; request_id: string; request_version: number;
  start_date: string; end_date: string; quantity: string; unit: string; status: string;
  presence_impact: string; policy_id: string | null; policy_version: number | null;
  params_used: Record<string, unknown>; count_detail: Array<{ date: string; counted: number; why: string }>;
  hours_requested: string | null;
}

@Injectable()
export class LeaveIntegrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly calc: CalcService,
  ) {}

  /**
   * Pose les faits d'absence (DANS la transaction d'application) : une ligne par
   * journée DÉCOMPTÉE (counted > 0 — la rotation de nuit vit sur sa journée).
   * Période E10 verrouillée/close couvrante ⇒ faits EN ATTENTE : aucune clôture
   * n'est modifiée automatiquement. Idempotent PAR LA BASE (unicité par version).
   */
  async postFactsTx(tx: Tx, tenantId: string, actor: string | null, absenceId: string): Promise<{
    posted: number; pending: boolean; dates: string[];
  }> {
    const abs = await this.absenceRow(tx, absenceId);
    if (!abs) return { posted: 0, pending: false, dates: [] };
    const type = await tx.$queryRaw<Array<{
      code: string; prep_category: string; paid: boolean; confidential: boolean;
    }>>`
      SELECT code, prep_category, paid, confidential FROM leave.absence_types WHERE id = ${abs.absence_type_id}::uuid`;
    const t = type[0]!;
    const days = (abs.count_detail ?? []).filter((d) => Number(d.counted) > 0);
    if (days.length === 0) return { posted: 0, pending: false, dates: [] };
    // Période E10 verrouillée/close couvrant AU MOINS une journée (portée réelle).
    const locked = await tx.$queryRaw<Array<{ n: unknown }>>`
      SELECT count(*) AS n FROM time.periods p
       WHERE p.status IN ('locked', 'closed', 'archived')
         AND daterange(p.period_start, p.period_end, '[]') && daterange(${abs.start_date}::date, ${abs.end_date}::date, '[]')
         AND (p.scope_kind = 'tenant'
           OR EXISTS (SELECT 1 FROM core.employee_assignments a
                       WHERE a.employee_id = ${abs.employee_id}::uuid AND a.is_primary
                         AND daterange(a.effective_from, a.effective_to, '[)') @> p.period_start
                         AND ((p.scope_kind = 'company' AND a.company_id = p.company_id)
                           OR (p.scope_kind = 'site'    AND a.site_id    = p.site_id))))`;
    const pending = Number(locked[0]?.n ?? 0) > 0;
    const status = pending ? 'pending_closed_period' : 'active';
    const hours = abs.hours_requested === null ? null : Math.round(Number(abs.hours_requested) * 60);
    let posted = 0;
    for (const d of days) {
      const counted = Number(d.counted);
      const portion = hours !== null ? 'hours' : counted === 0.5 ? 'half' : 'full';
      const wrote = await tx.$executeRaw`
        INSERT INTO time.absence_facts (tenant_id, employee_id, work_date, absence_id, request_id,
          request_version, absence_type_id, prep_category, type_code, confidential, paid, portion,
          minutes, counted, unit, policy_id, policy_version, params_used, status, created_by)
        VALUES (${tenantId}::uuid, ${abs.employee_id}::uuid, ${d.date}::date, ${absenceId}::uuid,
          ${abs.request_id}::uuid, ${abs.request_version}, ${abs.absence_type_id}::uuid,
          ${t.prep_category}, ${t.code}, ${t.confidential}, ${t.paid}, ${portion},
          ${portion === 'hours' ? hours : null}, ${counted}, ${abs.unit},
          ${abs.policy_id}::uuid, ${abs.policy_version}, ${JSON.stringify(abs.params_used ?? {})}::jsonb,
          ${status}, ${actor}::uuid)
        ON CONFLICT (tenant_id, absence_id, work_date, version) DO NOTHING`;
      posted += wrote;
    }
    await tx.$executeRaw`
      UPDATE leave.absences SET presence_impact = ${pending ? 'pending_closed_period' : 'deferred'}
       WHERE id = ${absenceId}::uuid AND presence_impact IN ('deferred', 'pending_closed_period')`;
    return { posted, pending, dates: days.map((d) => d.date) };
  }

  /**
   * Supersède les faits d'une absence (annulation approuvée) — motivé, daté,
   * JAMAIS supprimé. Le recalcul qui retire la qualification court ensuite,
   * hors de la transaction de décision (relançable par l'intégration).
   */
  async supersedeFactsTx(tx: Tx, tenantId: string, absenceId: string, reason: string): Promise<number> {
    const n = await tx.$executeRaw`
      UPDATE time.absence_facts
         SET status = 'superseded', superseded_at = now(), supersede_reason = ${reason.slice(0, 490)}
       WHERE tenant_id = ${tenantId}::uuid AND absence_id = ${absenceId}::uuid
         AND status IN ('active', 'pending_closed_period')`;
    await tx.$executeRaw`
      UPDATE leave.absences SET presence_impact = 'superseded' WHERE id = ${absenceId}::uuid`;
    return n;
  }

  /**
   * Après application : recalcul E10 MOTIVÉ et idempotent de la fenêtre, puis
   * constat (impact appliqué + anomalies d'appariement EXPLIQUÉES résolues).
   * Un échec de recalcul ne remet JAMAIS en cause l'application : l'impact
   * reste « deferred », la reprise est explicite.
   */
  async integrateAbsence(tenantId: string, actor: string, absenceId: string): Promise<{
    recalculated: boolean; resolvedAnomalies: number;
  }> {
    const abs = await this.prisma.withTenant(tenantId, (tx) => this.absenceRow(tx, absenceId));
    if (!abs) return { recalculated: false, resolvedAnomalies: 0 };
    const hasActive = await this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ n: unknown }>>`
        SELECT count(*) AS n FROM time.absence_facts
         WHERE absence_id = ${absenceId}::uuid AND status = 'active'`;
      return Number(rows[0]?.n ?? 0) > 0;
    });
    if (!hasActive) return { recalculated: false, resolvedAnomalies: 0 };
    const run = await this.calc.run(tenantId, actor, {
      periodStart: abs.start_date, periodEnd: abs.end_date,
      scopeKind: 'employee', scopeId: abs.employee_id,
      reason: `intégration absence ${absenceId} (demande ${abs.request_id} v${abs.request_version})`,
    }, { recalc: true });
    const ok = run.kind === 'ok' && typeof run.run['status'] === 'string'
      && (run.run['status'] as string).startsWith('completed');
    if (!ok) return { recalculated: false, resolvedAnomalies: 0 };
    const resolved = await this.prisma.withTenant(tenantId, async (tx) => {
      await tx.$executeRaw`
        UPDATE leave.absences SET presence_impact = 'applied'
         WHERE id = ${absenceId}::uuid AND presence_impact IN ('deferred', 'pending_closed_period')`;
      const n = await this.resolveExplainedAnomalies(tx, tenantId, actor, abs);
      await auditAuth(tx, tenantId, {
        action: 'leave_absence_integrated', actorUserId: actor, module: 'leave',
        recordType: 'leave_absence', recordId: absenceId,
        newValue: { from: abs.start_date, to: abs.end_date, resolvedAnomalies: n }, result: 'success',
      });
      return n;
    });
    return { recalculated: true, resolvedAnomalies: resolved };
  }

  /**
   * Anomalies d'appariement EXPLIQUÉES par l'absence (missing_in / missing_out) :
   * résolues APRÈS le recalcul réussi, avec référence probante — le FAIT ACTIF
   * couvrant exactement la journée (une sortie manquante l'après-midi s'explique
   * par la demi-journée approuvée ; le moteur, lui, n'a inventé AUCUNE minute :
   * une journée incomplète reste incomplète, seule l'anomalie est soldée).
   */
  private async resolveExplainedAnomalies(tx: Tx, tenantId: string, actor: string, abs: AbsenceRow): Promise<number> {
    return tx.$executeRaw`
      UPDATE time.day_anomalies an
         SET state = 'resolved', resolution_kind = 'absence_applied',
             state_note = ${'expliquée par l’absence appliquée ' + abs.id + ' (demande ' + abs.request_id + ' v' + abs.request_version + ')'},
             state_by = ${actor}::uuid, state_at = now()
       WHERE an.tenant_id = ${tenantId}::uuid
         AND an.employee_id = ${abs.employee_id}::uuid
         AND an.work_date BETWEEN ${abs.start_date}::date AND ${abs.end_date}::date
         AND an.state = 'open'
         AND an.code IN ('missing_in', 'missing_out')
         AND EXISTS (SELECT 1 FROM time.absence_facts f
                      WHERE f.absence_id = ${abs.id}::uuid AND f.employee_id = an.employee_id
                        AND f.work_date = an.work_date AND f.status = 'active')
         AND EXISTS (SELECT 1 FROM time.day_results r
                      WHERE r.employee_id = an.employee_id AND r.work_date = an.work_date AND r.is_current)`;
  }

  /**
   * Reprise EXPLICITE de l'intégration (permission dédiée) :
   *  1. faits EN ATTENTE dont la période E10 est redevenue ouverte/rouverte ⇒ activés ;
   *  2. absences approuvées à impact différé ⇒ recalcul + constat + anomalies ;
   *  3. absences annulées aux faits supersédés ⇒ recalcul (la qualification tombe).
   * Idempotente de bout en bout (relance = zéro nouvel effet).
   */
  async runIntegration(tenantId: string, actor: string, opts: { from: string; to: string; employeeId?: string }): Promise<TimeOutcome<{
    activated: number; integrated: number; recalculated: number; resolvedAnomalies: number; stillPending: number;
  }>> {
    const allowed = await this.prisma.withTenant(tenantId, (tx) => holdsPermission(tx, actor, 'leave.integration_run'));
    if (!allowed) return { kind: 'forbidden', reason: 'permission requise : leave.integration_run' };
    // 1. Activation des faits en attente dont la période E10 n'est plus verrouillée.
    const activated = await this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; absence_id: string }>>`
        SELECT f.id, f.absence_id FROM time.absence_facts f
         WHERE f.tenant_id = ${tenantId}::uuid AND f.status = 'pending_closed_period'
           AND f.work_date BETWEEN ${opts.from}::date AND ${opts.to}::date
           AND (${opts.employeeId ?? null}::uuid IS NULL OR f.employee_id = ${opts.employeeId ?? null}::uuid)
           AND NOT EXISTS (
             SELECT 1 FROM time.periods p
              WHERE p.status IN ('locked', 'closed', 'archived')
                AND f.work_date BETWEEN p.period_start AND p.period_end
                AND (p.scope_kind = 'tenant'
                  OR EXISTS (SELECT 1 FROM core.employee_assignments a
                              WHERE a.employee_id = f.employee_id AND a.is_primary
                                AND daterange(a.effective_from, a.effective_to, '[)') @> p.period_start
                                AND ((p.scope_kind = 'company' AND a.company_id = p.company_id)
                                  OR (p.scope_kind = 'site'    AND a.site_id    = p.site_id)))))`;
      for (const r of rows) {
        await tx.$executeRaw`UPDATE time.absence_facts SET status = 'active' WHERE id = ${r.id}::uuid`;
      }
      if (rows.length > 0) {
        await auditAuth(tx, tenantId, {
          action: 'leave_facts_activated', actorUserId: actor, module: 'leave',
          recordType: 'absence_fact', newValue: { count: rows.length }, result: 'success',
        });
      }
      return rows;
    });
    // 2. Absences à intégrer (impact différé/en attente avec faits actifs) ou à
    //    DÉQUALIFIER (faits supersédés plus récents que le résultat courant).
    const targets = await this.prisma.withTenant<Array<{ id: string; kind: string }>>(tenantId, (tx) => tx.$queryRaw<Array<{ id: string; kind: string }>>`
      SELECT DISTINCT a.id, 'apply' AS kind FROM leave.absences a
        JOIN time.absence_facts f ON f.absence_id = a.id AND f.status = 'active'
       WHERE a.tenant_id = ${tenantId}::uuid AND a.presence_impact IN ('deferred', 'pending_closed_period')
         AND f.work_date BETWEEN ${opts.from}::date AND ${opts.to}::date
         AND (${opts.employeeId ?? null}::uuid IS NULL OR a.employee_id = ${opts.employeeId ?? null}::uuid)
      UNION
      SELECT DISTINCT a.id, 'unapply' AS kind FROM leave.absences a
        JOIN time.absence_facts f ON f.absence_id = a.id AND f.status = 'superseded'
        JOIN time.day_results r ON r.employee_id = a.employee_id AND r.work_date = f.work_date AND r.is_current
       WHERE a.tenant_id = ${tenantId}::uuid AND a.status = 'cancelled'
         AND f.work_date BETWEEN ${opts.from}::date AND ${opts.to}::date
         AND (${opts.employeeId ?? null}::uuid IS NULL OR a.employee_id = ${opts.employeeId ?? null}::uuid)
         AND r.justified_category IS NOT NULL`);
    let integrated = 0;
    let recalculated = 0;
    let resolvedAnomalies = 0;
    for (const tgt of targets) {
      if (tgt.kind === 'apply') {
        const out = await this.integrateAbsence(tenantId, actor, tgt.id);
        if (out.recalculated) { integrated += 1; recalculated += 1; resolvedAnomalies += out.resolvedAnomalies; }
      } else {
        const abs = await this.prisma.withTenant(tenantId, (tx) => this.absenceRow(tx, tgt.id));
        if (!abs) continue;
        const run = await this.calc.run(tenantId, actor, {
          periodStart: abs.start_date, periodEnd: abs.end_date,
          scopeKind: 'employee', scopeId: abs.employee_id,
          reason: `retrait d'intégration : absence annulée ${abs.id}`,
        }, { recalc: true });
        if (run.kind === 'ok' && typeof run.run['status'] === 'string'
          && (run.run['status'] as string).startsWith('completed')) recalculated += 1;
      }
    }
    const stillPending = await this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ n: unknown }>>`
        SELECT count(*) AS n FROM time.absence_facts
         WHERE tenant_id = ${tenantId}::uuid AND status = 'pending_closed_period'
           AND work_date BETWEEN ${opts.from}::date AND ${opts.to}::date`;
      return Number(rows[0]?.n ?? 0);
    });
    return {
      kind: 'ok', activated: activated.length, integrated, recalculated, resolvedAnomalies, stillPending,
    };
  }

  /** Suivi de l'intégration (écran + e2e) : faits par statut, absences par impact. */
  async status(tenantId: string, actor: string, opts: { from: string; to: string }): Promise<TimeOutcome<{ integration: unknown }>> {
    const allowed = await this.prisma.withTenant(tenantId, (tx) =>
      holdsPermission(tx, actor, 'leave.integration_run', 'leave.close_run', 'leave.close_view', 'leave.requests_admin'));
    if (!allowed) return { kind: 'forbidden', reason: 'permission requise : leave.integration_run ou leave.close_view' };
    return this.prisma.withTenant(tenantId, async (tx) => {
      const facts = await tx.$queryRaw<Array<{ status: string; n: unknown }>>`
        SELECT status, count(*) AS n FROM time.absence_facts
         WHERE work_date BETWEEN ${opts.from}::date AND ${opts.to}::date
         GROUP BY status ORDER BY status`;
      const impacts = await tx.$queryRaw<Array<{ presence_impact: string; n: unknown }>>`
        SELECT presence_impact, count(*) AS n FROM leave.absences a
         WHERE daterange(a.start_date, a.end_date, '[]') && daterange(${opts.from}::date, ${opts.to}::date, '[]')
         GROUP BY presence_impact ORDER BY presence_impact`;
      const pendingList = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT f.absence_id AS "absenceId", f.employee_id AS "employeeId", e.matricule,
               min(f.work_date)::text AS "from", max(f.work_date)::text AS "to", count(*)::int AS days
          FROM time.absence_facts f JOIN core.employees e ON e.id = f.employee_id
         WHERE f.status = 'pending_closed_period'
           AND f.work_date BETWEEN ${opts.from}::date AND ${opts.to}::date
         GROUP BY f.absence_id, f.employee_id, e.matricule ORDER BY min(f.work_date)`;
      return {
        kind: 'ok',
        integration: {
          facts: facts.map((f) => ({ status: f.status, count: Number(f.n) })),
          impacts: impacts.map((i) => ({ impact: i.presence_impact, count: Number(i.n) })),
          pending: pendingList,
        },
      };
    });
  }

  private async absenceRow(tx: Tx, absenceId: string): Promise<AbsenceRow | null> {
    const rows = await tx.$queryRaw<AbsenceRow[]>`
      SELECT id, employee_id, absence_type_id, request_id, request_version,
             start_date::text, end_date::text, quantity::text, unit, status, presence_impact,
             policy_id, policy_version, params_used, count_detail, hours_requested::text
        FROM leave.absences WHERE id = ${absenceId}::uuid`;
    return rows[0] ?? null;
  }
}
