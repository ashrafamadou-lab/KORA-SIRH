/**
 * E10.1 — Pointages : dispositifs, correspondances d'identifiants, NORMALISATION
 * (brut → événement), listes à portées réelles, file des non-appariés,
 * renormalisation, saisie manuelle.
 *
 * La normalisation ne touche JAMAIS le brut : elle écrit/réécrit l'événement dérivé
 * (1:1). Résolution du fuseau : dispositif → site → paramètre E4 « TIME-01 » à la
 * date de l'événement → 'UTC' (noté). Un identifiant externe ne peut par
 * construction viser que les salariés DU tenant (RLS + FK composites).
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { auditAuth } from '../auth/audit.util';
import {
  localToUtc,
  normalizeEventType,
  parseSourceDateTime,
  punchFingerprint,
  TZ_RE,
  type ParsedDateTime,
} from '../../../../packages/core/src/time.ts';
import {
  CODE_RE, DATE_RE, holdsPermission, scopeSetFor, scopeCsv, type TimeOutcome,
} from './time-access';

const pad = (n: number) => String(n).padStart(2, '0');

@Injectable()
export class PunchesService {
  constructor(private readonly prisma: PrismaService) {}

  // ------------------------------------------------------------------
  // Dispositifs
  // ------------------------------------------------------------------

  async listDevices(tenantId: string, actor: string): Promise<TimeOutcome<{ items: unknown[] }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'time.devices_manage', 'time.punches_import', 'time.punches_view', 'time.punches_view_errors'))) {
        return { kind: 'forbidden', reason: 'permission requise : time.devices_manage ou time.punches_view' };
      }
      const items = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT d.id, d.code, d.label, d.kind, d.status, d.site_id AS "siteId", d.time_zone AS "timeZone",
               s.code AS "siteCode",
               (SELECT count(*)::int FROM time.employee_device_ids m WHERE m.device_id = d.id AND m.status = 'active') AS "mappingCount"
          FROM time.devices d LEFT JOIN org.sites s ON s.id = d.site_id
         ORDER BY d.code`;
      return { kind: 'ok', items };
    });
  }

  async createDevice(
    tenantId: string, actor: string,
    input: { code: string; label: string; kind: string; siteId?: string; timeZone?: string },
  ): Promise<TimeOutcome<{ id: string }>> {
    if (!CODE_RE.test(input.code)) return { kind: 'invalid', reason: 'code invalide (A-Z 0-9 _ -, 30 max)' };
    if (!['clock', 'csv', 'xlsx', 'manual', 'api', 'external'].includes(input.kind)) {
      return { kind: 'invalid', reason: 'kind : clock, csv, xlsx, manual, api ou external' };
    }
    if (input.timeZone !== undefined && !TZ_RE.test(input.timeZone)) {
      return { kind: 'invalid', reason: 'timeZone : identifiant IANA (Africa/Porto-Novo…)' };
    }
    return this.prisma.withTenant(tenantId, async (tx) => {
      const dup = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM time.devices WHERE code = ${input.code}`;
      if (dup.length > 0) return { kind: 'conflict', reason: `code « ${input.code} » déjà utilisé` };
      try {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO time.devices (tenant_id, code, label, kind, site_id, time_zone, created_by)
          VALUES (${tenantId}::uuid, ${input.code}, ${input.label}, ${input.kind},
                  ${input.siteId ?? null}::uuid, ${input.timeZone ?? null}, ${actor}::uuid)
          RETURNING id`;
        const id = rows[0]!.id;
        await auditAuth(tx, tenantId, {
          action: 'time_device_created', actorUserId: actor, module: 'time',
          recordType: 'device', recordId: id, newValue: input, result: 'success',
        });
        return { kind: 'ok', id };
      } catch (e) {
        return { kind: 'invalid', reason: (e as Error).message.split('\n')[0] ?? 'dispositif refusé' };
      }
    });
  }

  async patchDevice(
    tenantId: string, actor: string, id: string,
    input: { label?: string; status?: string; siteId?: string | null; timeZone?: string | null },
  ): Promise<TimeOutcome<Record<never, never>>> {
    if (input.status !== undefined && !['active', 'inactive', 'retired'].includes(input.status)) {
      return { kind: 'invalid', reason: 'status : active, inactive ou retired' };
    }
    if (input.timeZone !== undefined && input.timeZone !== null && !TZ_RE.test(input.timeZone)) {
      return { kind: 'invalid', reason: 'timeZone : identifiant IANA' };
    }
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ label: string; status: string; site_id: string | null; time_zone: string | null }>>`
        SELECT label, status, site_id, time_zone FROM time.devices WHERE id = ${id}::uuid`;
      const cur = rows[0];
      if (!cur) return { kind: 'not_found' };
      // Sémantique PATCH : champ ABSENT = inchangé ; null EXPLICITE = effacement.
      const next = {
        label: input.label ?? cur.label,
        status: input.status ?? cur.status,
        siteId: input.siteId === undefined ? cur.site_id : input.siteId,
        timeZone: input.timeZone === undefined ? cur.time_zone : input.timeZone,
      };
      try {
        await tx.$executeRaw`
          UPDATE time.devices SET label = ${next.label}, status = ${next.status},
                 site_id = ${next.siteId}::uuid, time_zone = ${next.timeZone}
           WHERE id = ${id}::uuid`;
      } catch (e) {
        return { kind: 'invalid', reason: (e as Error).message.split('\n')[0] ?? 'modification refusée' };
      }
      await auditAuth(tx, tenantId, {
        action: 'time_device_updated', actorUserId: actor, module: 'time',
        recordType: 'device', recordId: id, newValue: input, result: 'success',
      });
      return { kind: 'ok' };
    });
  }

  // ------------------------------------------------------------------
  // Correspondances
  // ------------------------------------------------------------------

  async listMappings(
    tenantId: string, actor: string, opts: { externalId?: string; employeeId?: string },
  ): Promise<TimeOutcome<{ items: unknown[] }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'time.devices_manage', 'time.punches_import', 'time.punches_view_errors'))) {
        return { kind: 'forbidden', reason: 'permission requise : time.devices_manage' };
      }
      const items = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT m.id, m.external_id AS "externalId", m.employee_id AS "employeeId",
               e.matricule, e.first_name AS "firstName", e.last_name AS "lastName",
               m.device_id AS "deviceId", d.code AS "deviceCode", m.status
          FROM time.employee_device_ids m
          JOIN core.employees e ON e.id = m.employee_id
          LEFT JOIN time.devices d ON d.id = m.device_id
         WHERE (${opts.externalId ?? null}::text IS NULL OR m.external_id = ${opts.externalId ?? null})
           AND (${opts.employeeId ?? null}::uuid IS NULL OR m.employee_id = ${opts.employeeId ?? null}::uuid)
         ORDER BY m.external_id LIMIT 500`;
      return { kind: 'ok', items };
    });
  }

  async createMapping(
    tenantId: string, actor: string,
    input: { externalId: string; employeeId: string; deviceId?: string },
  ): Promise<TimeOutcome<{ id: string }>> {
    if (input.externalId.trim().length === 0 || input.externalId.length > 100) {
      return { kind: 'invalid', reason: 'externalId : 1 à 100 caractères' };
    }
    return this.prisma.withTenant(tenantId, async (tx) => {
      const emp = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM core.employees WHERE id = ${input.employeeId}::uuid AND deleted_at IS NULL`;
      if (emp.length === 0) return { kind: 'not_found' };
      try {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO time.employee_device_ids (tenant_id, external_id, employee_id, device_id, created_by)
          VALUES (${tenantId}::uuid, ${input.externalId.trim()}, ${input.employeeId}::uuid,
                  ${input.deviceId ?? null}::uuid, ${actor}::uuid)
          RETURNING id`;
        const id = rows[0]!.id;
        await auditAuth(tx, tenantId, {
          action: 'time_mapping_created', actorUserId: actor, module: 'time',
          recordType: 'employee_device_id', recordId: id,
          newValue: { externalId: input.externalId, employeeId: input.employeeId, deviceId: input.deviceId ?? null },
          result: 'success',
        });
        return { kind: 'ok', id };
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes('employee_device_ids_dev_unique') || msg.includes('employee_device_ids_any_unique')) {
          return { kind: 'conflict', reason: 'identifiant externe déjà relié (retirer l’ancienne correspondance d’abord)' };
        }
        return { kind: 'invalid', reason: msg.split('\n')[0] ?? 'correspondance refusée' };
      }
    });
  }

  async retireMapping(tenantId: string, actor: string, id: string): Promise<TimeOutcome<Record<never, never>>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT status FROM time.employee_device_ids WHERE id = ${id}::uuid`;
      if (rows.length === 0) return { kind: 'not_found' };
      if (rows[0]!.status === 'retired') return { kind: 'conflict', reason: 'correspondance déjà retirée' };
      await tx.$executeRaw`UPDATE time.employee_device_ids SET status = 'retired' WHERE id = ${id}::uuid`;
      await auditAuth(tx, tenantId, {
        action: 'time_mapping_retired', actorUserId: actor, module: 'time',
        recordType: 'employee_device_id', recordId: id, result: 'success',
      });
      return { kind: 'ok' };
    });
  }

  // ------------------------------------------------------------------
  // NORMALISATION (partagée : import, saisie manuelle, renormalisation)
  // ------------------------------------------------------------------

  /** Fuseau par défaut du tenant, résolu E4 à la date de l'événement (TIME-01), sinon UTC. */
  private async tenantDefaultTz(tx: Prisma.TransactionClient, tenantId: string, date: string): Promise<{ tz: string; fromParam: boolean }> {
    const rows = await tx.$queryRaw<Array<{ value: unknown }>>`
      SELECT value FROM compliance.parameter_value_at('TIME-01', 'BJ'::char(2), ${tenantId}::uuid, ${date}::date)`;
    const raw = rows[0]?.value;
    const v = typeof raw === 'string' ? raw : (raw !== null && typeof raw === 'object' && 'value' in (raw as object))
      ? String((raw as Record<string, unknown>)['value']) : null;
    if (v && TZ_RE.test(v)) return { tz: v, fromParam: true };
    return { tz: 'UTC', fromParam: false };
  }

  /**
   * Normalise UN pointage brut → écrit (ou réécrit) l'événement dérivé.
   * Retourne le match_status produit.
   */
  async normalizeRawPunchTx(tx: Prisma.TransactionClient, tenantId: string, rawPunchId: string): Promise<string> {
    const raws = await tx.$queryRaw<Array<{
      id: string; batch_id: string; device_id: string | null; site_id: string | null;
      external_employee_id: string; source_datetime_raw: string; source_tz: string | null; event_type_raw: string | null;
      default_site_id: string | null;
    }>>`
      SELECT r.id, r.batch_id, r.device_id, r.site_id, r.external_employee_id,
             r.source_datetime_raw, r.source_tz, r.event_type_raw, b.default_site_id
        FROM time.raw_punches r JOIN time.punch_batches b ON b.id = r.batch_id
       WHERE r.id = ${rawPunchId}::uuid`;
    const raw = raws[0];
    if (!raw) return 'not_found';

    // 1. Site et dispositif effectifs.
    const device = raw.device_id === null ? null : (await tx.$queryRaw<Array<{ site_id: string | null; time_zone: string | null }>>`
      SELECT site_id, time_zone FROM time.devices WHERE id = ${raw.device_id}::uuid`)[0] ?? null;
    const siteId = raw.site_id ?? device?.site_id ?? raw.default_site_id ?? null;
    const site = siteId === null ? null : (await tx.$queryRaw<Array<{ time_zone: string | null }>>`
      SELECT time_zone FROM org.sites WHERE id = ${siteId}::uuid`)[0] ?? null;

    // 2. Horodatage.
    const parsed: ParsedDateTime | null = parseSourceDateTime(raw.source_datetime_raw);
    let note: string | null = null;
    let status = 'matched';
    let tz = 'UTC';
    let occurredAtIso: string | null = null;
    let localDate: string | null = null;
    let localTime: string | null = null;

    if (parsed === null) {
      status = 'invalid_datetime';
      note = 'horodatage source inanalysable';
    } else {
      localDate = `${parsed.y}-${pad(parsed.mo)}-${pad(parsed.d)}`;
      localTime = `${pad(parsed.h)}:${pad(parsed.mi)}:${pad(parsed.s)}`;
      // 3. Fuseau : source explicite → dispositif → site → paramètre tenant (à la date) → UTC.
      if (raw.source_tz && TZ_RE.test(raw.source_tz)) tz = raw.source_tz;
      else if (device?.time_zone) tz = device.time_zone;
      else if (site?.time_zone) tz = site.time_zone;
      else {
        const d = await this.tenantDefaultTz(tx, tenantId, localDate);
        tz = d.tz;
        if (!d.fromParam) note = 'fuseau par défaut UTC (ni dispositif, ni site, ni paramètre TIME-01)';
      }
      const conv = localToUtc({ y: parsed.y, mo: parsed.mo, d: parsed.d }, { h: parsed.h, mi: parsed.mi, s: parsed.s }, tz);
      if (conv.status === 'invalid') {
        status = 'invalid_datetime';
        note = `heure locale inexistante dans ${tz} (passage à l'heure d'été)`;
      } else {
        occurredAtIso = new Date(conv.utcMs!).toISOString();
        if (conv.status === 'ambiguous') {
          status = 'ambiguous_datetime';
          note = `heure locale ambiguë dans ${tz} (repli d'heure) — premier instant retenu`;
        }
      }
    }

    // 4. Salarié : correspondance dédiée au dispositif > correspondance globale > matricule.
    let employeeId: string | null = null;
    const mapped = await tx.$queryRaw<Array<{ employee_id: string }>>`
      SELECT employee_id FROM time.employee_device_ids
       WHERE external_id = ${raw.external_employee_id} AND status = 'active'
         AND (device_id = ${raw.device_id}::uuid OR device_id IS NULL)
       ORDER BY device_id NULLS LAST LIMIT 1`;
    if (mapped.length > 0) employeeId = mapped[0]!.employee_id;
    else {
      const byMatricule = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM core.employees WHERE matricule = ${raw.external_employee_id} AND deleted_at IS NULL`;
      if (byMatricule.length > 0) employeeId = byMatricule[0]!.id;
    }

    let assignmentId: string | null = null;
    if (employeeId === null) {
      if (status === 'matched') status = 'unmatched_employee';
      if (status === 'ambiguous_datetime' || status === 'invalid_datetime') {
        note = `${note ?? ''} ; identifiant externe non apparié`.trim();
      }
    } else if (status === 'matched' || status === 'ambiguous_datetime') {
      // 5. État du salarié À LA DATE de l'événement.
      const emp = (await tx.$queryRaw<Array<{ status: string; hire_date: string | null }>>`
        SELECT status, hire_date::text FROM core.employees WHERE id = ${employeeId}::uuid`)[0]!;
      if (localDate !== null && emp.hire_date !== null && emp.hire_date > localDate) {
        status = 'not_yet_hired';
        note = `pointage antérieur à la date d'embauche (${emp.hire_date})`;
      } else if (emp.status === 'terminated' || emp.status === 'archived' || emp.status === 'suspended') {
        status = 'inactive_employee';
        note = `salarié au statut « ${emp.status} » au moment du traitement`;
      } else if (localDate !== null) {
        // 6. Affectation E9 applicable à la date du pointage.
        const asg = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM core.employee_assignments
           WHERE employee_id = ${employeeId}::uuid AND is_primary
             AND daterange(effective_from, effective_to, '[)') @> ${localDate}::date
           LIMIT 1`;
        if (asg.length > 0) assignmentId = asg[0]!.id;
        else if (status === 'matched') {
          status = 'no_assignment';
          note = 'aucune affectation organisationnelle applicable à la date du pointage';
        }
      }
    }

    const eventType = normalizeEventType(raw.event_type_raw);
    await tx.$executeRaw`
      INSERT INTO time.punch_events
        (tenant_id, raw_punch_id, employee_id, assignment_id, site_id, device_id, tz,
         occurred_at, local_date, local_time, event_type, match_status, note)
      VALUES (${tenantId}::uuid, ${raw.id}::uuid, ${employeeId}::uuid, ${assignmentId}::uuid,
              ${siteId}::uuid, ${raw.device_id}::uuid, ${tz},
              ${occurredAtIso}::timestamptz, ${localDate}::date, ${localTime}::time,
              ${eventType}, ${status}, ${note})
      ON CONFLICT (tenant_id, raw_punch_id) DO UPDATE SET
        employee_id = EXCLUDED.employee_id, assignment_id = EXCLUDED.assignment_id,
        site_id = EXCLUDED.site_id, tz = EXCLUDED.tz, occurred_at = EXCLUDED.occurred_at,
        local_date = EXCLUDED.local_date, local_time = EXCLUDED.local_time,
        event_type = EXCLUDED.event_type, match_status = EXCLUDED.match_status,
        note = EXCLUDED.note, normalized_at = now()`;
    return status;
  }

  // ------------------------------------------------------------------
  // Consultations (portées réelles)
  // ------------------------------------------------------------------

  async listRawPunches(
    tenantId: string, actor: string,
    opts: { batchId?: string; deviceId?: string; from?: string; to?: string; limit?: number; offset?: number },
  ): Promise<TimeOutcome<{ items: unknown[] }>> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const set = await scopeSetFor(tx, actor, 'time.punches_view');
      if (set.kind === 'none') return { kind: 'forbidden', reason: 'permission requise : time.punches_view (avec une portée)' };
      const scoped = set.kind === 'scoped';
      const csv = scopeCsv(set);
      // Portée fine : on ne voit que les bruts dont l'ÉVÉNEMENT vise un salarié du
      // périmètre (les non-appariés restent l'affaire des opérateurs d'import).
      const items = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT r.id, r.batch_id AS "batchId", r.line_no AS "lineNo",
               r.external_employee_id AS "externalEmployeeId", r.source_datetime_raw AS "sourceDateTimeRaw",
               r.source_tz AS "sourceTz", r.event_type_raw AS "eventTypeRaw", r.device_ref AS "deviceRef",
               d.code AS "deviceCode", r.received_at AS "receivedAt",
               ev.match_status AS "matchStatus", ev.event_type AS "eventType",
               ev.occurred_at AS "occurredAt", ev.local_date::text AS "localDate", ev.local_time::text AS "localTime",
               ev.tz, ev.note, e.matricule, e.first_name AS "firstName", e.last_name AS "lastName"
          FROM time.raw_punches r
          LEFT JOIN time.devices d ON d.id = r.device_id
          LEFT JOIN time.punch_events ev ON ev.raw_punch_id = r.id
          LEFT JOIN core.employees e ON e.id = ev.employee_id
         WHERE (${opts.batchId ?? null}::uuid IS NULL OR r.batch_id = ${opts.batchId ?? null}::uuid)
           AND (${opts.deviceId ?? null}::uuid IS NULL OR r.device_id = ${opts.deviceId ?? null}::uuid)
           AND (${opts.from ?? null}::date IS NULL OR ev.local_date >= ${opts.from ?? null}::date)
           AND (${opts.to ?? null}::date IS NULL OR ev.local_date <= ${opts.to ?? null}::date)
           AND (${!scoped} OR (ev.employee_id IS NOT NULL AND EXISTS (
                 SELECT 1 FROM core.employee_assignments sa
                  WHERE sa.employee_id = ev.employee_id AND sa.is_primary
                    AND daterange(sa.effective_from, sa.effective_to, '[)') @> COALESCE(ev.local_date, current_date)
                    AND (sa.company_id = ANY(string_to_array(${csv.companies}, ',')::uuid[])
                      OR sa.site_id    = ANY(string_to_array(${csv.sites}, ',')::uuid[])
                      OR sa.unit_id    = ANY(string_to_array(${csv.units}, ',')::uuid[])))))
         ORDER BY r.received_at DESC, r.line_no
         LIMIT ${limit} OFFSET ${offset}`;
      return { kind: 'ok', items };
    });
  }

  /** SES propres événements (portée self) — via le lien utilisateur ↔ salarié. */
  async listMyEvents(
    tenantId: string, actor: string, opts: { from?: string; to?: string; limit?: number },
  ): Promise<TimeOutcome<{ linked: boolean; items: unknown[] }>> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'time.punches_view_own'))) {
        return { kind: 'forbidden', reason: 'permission requise : time.punches_view_own' };
      }
      const me = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM core.employees WHERE user_id = ${actor}::uuid AND deleted_at IS NULL`;
      if (me.length === 0) return { kind: 'ok', linked: false, items: [] };
      const items = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT ev.id, ev.occurred_at AS "occurredAt", ev.local_date::text AS "localDate",
               ev.local_time::text AS "localTime", ev.tz, ev.event_type AS "eventType",
               ev.match_status AS "matchStatus", d.code AS "deviceCode", s.code AS "siteCode"
          FROM time.punch_events ev
          LEFT JOIN time.devices d ON d.id = ev.device_id
          LEFT JOIN org.sites s ON s.id = ev.site_id
         WHERE ev.employee_id = ${me[0]!.id}::uuid
           AND (${opts.from ?? null}::date IS NULL OR ev.local_date >= ${opts.from ?? null}::date)
           AND (${opts.to ?? null}::date IS NULL OR ev.local_date <= ${opts.to ?? null}::date)
         ORDER BY ev.occurred_at DESC NULLS LAST LIMIT ${limit}`;
      return { kind: 'ok', linked: true, items };
    });
  }

  async listUnmatched(
    tenantId: string, actor: string, opts: { limit?: number; offset?: number },
  ): Promise<TimeOutcome<{ items: unknown[] }>> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'time.punches_view_errors', 'time.punches_import', 'time.devices_manage'))) {
        return { kind: 'forbidden', reason: 'permission requise : time.punches_view_errors' };
      }
      const items = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT ev.id, ev.raw_punch_id AS "rawPunchId", ev.match_status AS "matchStatus", ev.note,
               ev.local_date::text AS "localDate", ev.local_time::text AS "localTime", ev.tz,
               r.external_employee_id AS "externalEmployeeId", r.source_datetime_raw AS "sourceDateTimeRaw",
               r.batch_id AS "batchId", d.code AS "deviceCode",
               e.matricule, e.first_name AS "firstName", e.last_name AS "lastName"
          FROM time.punch_events ev
          JOIN time.raw_punches r ON r.id = ev.raw_punch_id
          LEFT JOIN time.devices d ON d.id = ev.device_id
          LEFT JOIN core.employees e ON e.id = ev.employee_id
         WHERE ev.match_status <> 'matched'
         ORDER BY ev.normalized_at DESC
         LIMIT ${limit} OFFSET ${offset}`;
      return { kind: 'ok', items };
    });
  }

  /**
   * Renormalisation : rejoue la normalisation des événements NON appariés (ou d'un
   * lot ciblé) — après ajout d'une correspondance, typiquement. Le brut reste intact.
   */
  async renormalize(
    tenantId: string, actor: string, opts: { batchId?: string },
  ): Promise<TimeOutcome<{ processed: number; matched: number }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const targets = await tx.$queryRaw<Array<{ raw_punch_id: string }>>`
        SELECT ev.raw_punch_id FROM time.punch_events ev
          JOIN time.raw_punches r ON r.id = ev.raw_punch_id
         WHERE ev.match_status <> 'matched'
           AND (${opts.batchId ?? null}::uuid IS NULL OR r.batch_id = ${opts.batchId ?? null}::uuid)
         LIMIT 5000`;
      let matched = 0;
      for (const t of targets) {
        const s = await this.normalizeRawPunchTx(tx, tenantId, t.raw_punch_id);
        if (s === 'matched') matched += 1;
      }
      await auditAuth(tx, tenantId, {
        action: 'time_punches_renormalized', actorUserId: actor, module: 'time',
        recordType: 'punch_batch', recordId: opts.batchId ?? undefined,
        newValue: { processed: targets.length, matched }, result: 'success',
      });
      return { kind: 'ok', processed: targets.length, matched };
    });
  }

  // ------------------------------------------------------------------
  // Saisie manuelle (source à part entière, tracée comme lot 'manual')
  // ------------------------------------------------------------------

  async manualPunch(
    tenantId: string, actor: string,
    input: { employeeId: string; dateTime: string; eventType?: string; siteId?: string; note?: string },
  ): Promise<TimeOutcome<{ batchId: string; rawPunchId: string; matchStatus: string }>> {
    const parsed = parseSourceDateTime(input.dateTime);
    if (parsed === null) return { kind: 'invalid', reason: 'dateTime : AAAA-MM-JJ HH:MM[:SS]' };
    return this.prisma.withTenant(tenantId, async (tx) => {
      const emp = await tx.$queryRaw<Array<{ matricule: string }>>`
        SELECT matricule FROM core.employees WHERE id = ${input.employeeId}::uuid AND deleted_at IS NULL`;
      if (emp.length === 0) return { kind: 'not_found' };
      const batch = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO time.punch_batches
          (tenant_id, source, atomic, status, default_site_id, lines_received, lines_accepted, created_by)
        VALUES (${tenantId}::uuid, 'manual', true, 'applied', ${input.siteId ?? null}::uuid, 1, 1, ${actor}::uuid)
        RETURNING id`;
      const batchId = batch[0]!.id;
      const fingerprint = punchFingerprint({
        externalEmployeeId: emp[0]!.matricule,
        dateTimeCanonical: parsed.canonical,
        deviceCode: 'MANUEL',
        eventTypeRaw: input.eventType ?? null,
      });
      const raw = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO time.raw_punches
          (tenant_id, batch_id, line_no, site_id, external_employee_id, source_datetime_raw, event_type_raw, fingerprint)
        VALUES (${tenantId}::uuid, ${batchId}::uuid, 1, ${input.siteId ?? null}::uuid,
                ${emp[0]!.matricule}, ${input.dateTime.trim()}, ${input.eventType ?? null}, ${fingerprint})
        ON CONFLICT (tenant_id, fingerprint) DO NOTHING
        RETURNING id`;
      if (raw.length === 0) {
        await tx.$executeRaw`
          UPDATE time.punch_batches SET lines_accepted = 0, lines_duplicated = 1 WHERE id = ${batchId}::uuid`;
        return { kind: 'conflict', reason: 'pointage identique déjà enregistré (idempotence)' };
      }
      const matchStatus = await this.normalizeRawPunchTx(tx, tenantId, raw[0]!.id);
      const unmatched = matchStatus === 'matched' ? 0 : 1;
      await tx.$executeRaw`
        UPDATE time.punch_batches SET lines_unmatched = ${unmatched} WHERE id = ${batchId}::uuid`;
      await auditAuth(tx, tenantId, {
        action: 'time_manual_punch_created', actorUserId: actor, module: 'time',
        recordType: 'raw_punch', recordId: raw[0]!.id,
        newValue: { employeeId: input.employeeId, dateTime: input.dateTime, eventType: input.eventType ?? null, note: input.note ?? null },
        result: 'success',
      });
      return { kind: 'ok', batchId, rawPunchId: raw[0]!.id, matchStatus };
    });
  }
}
