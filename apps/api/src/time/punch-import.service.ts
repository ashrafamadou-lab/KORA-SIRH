/**
 * E10.1 — Import de pointages CSV / Excel.
 *
 *  - PRÉVISUALISATION : analyse complète (structure, correspondance de colonnes,
 *    validation par ligne, doublons fichier ET base, appariement estimé) — ZÉRO
 *    écriture.
 *  - APPLICATION : ATOMIQUE par défaut (la moindre ligne invalide ⇒ lot 'rejected'
 *    tracé, AUCUN pointage écrit). L'import des seules lignes valides est une OPTION
 *    explicite (acceptOnlyValid) ⇒ lot 'partial'.
 *  - IDEMPOTENCE : empreinte canonique par événement + ON CONFLICT DO NOTHING —
 *    rejouer un fichier ou recevoir le même événement par deux fichiers ne crée
 *    qu'une ligne logique (compteur « dupliqué »).
 *  - SÉCURITÉ : les cellules Excel porteuses de FORMULES sont refusées ligne par
 *    ligne — rien n'est jamais évalué ; les valeurs restent du texte inerte.
 *  - Le fichier original peut être conservé (référence documentaire) — son contenu
 *    n'est restitué qu'aux porteurs de time.punches_import, et l'accès est AUDITÉ.
 *  - E5 : un échec d'application notifie les porteurs de time.punches_import
 *    (modèle 'time_import_echec' — s'il n'est pas configuré, rien n'est simulé).
 */
import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { auditAuth } from '../auth/audit.util';
import { NotificationService } from '../notify/notification.service';
import { PunchesService } from './punches.service';
import { parseCsv } from '../../../../packages/core/src/org.ts';
import { readXlsx } from '../../../../packages/core/src/xlsx-lite.ts';
import {
  excelSerialToDateTime,
  mapPunchRows,
  punchFingerprint,
  type PunchImportError,
  type PunchImportRow,
  type PunchMapping,
} from '../../../../packages/core/src/time.ts';
import { holdsPermission, type TimeOutcome } from './time-access';

const MAX_CSV_CHARS = 1_000_000;
const MAX_XLSX_BYTES = 3_000_000;
const MAX_ROWS = 10_000;
const MAX_REPORT_ERRORS = 200;

export interface ImportInput {
  source: 'csv' | 'xlsx';
  mode: 'preview' | 'apply';
  filename?: string;
  /** CSV : texte brut. */
  contentText?: string;
  /** XLSX : contenu en base64. */
  contentBase64?: string;
  mapping?: PunchMapping;
  defaultSiteId?: string;
  defaultDeviceId?: string;
  /** Import PARTIEL explicite : n'écrire que les lignes valides (défaut : atomique). */
  acceptOnlyValid?: boolean;
  /** Conserver le fichier original comme référence documentaire (défaut : oui). */
  keepFile?: boolean;
}

export interface ImportCounts {
  received: number;
  accepted: number;
  duplicated: number;
  rejected: number;
  unmatched: number;
}

export type ImportOutcome =
  | { kind: 'preview'; counts: ImportCounts; errors: PunchImportError[]; effective: Record<string, string>; wouldApply: boolean }
  | { kind: 'applied' | 'partial' | 'rejected'; batchId: string; counts: ImportCounts; errors: PunchImportError[] }
  | { kind: 'invalid'; reason: string }
  | { kind: 'not_found' };

@Injectable()
export class PunchImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly punches: PunchesService,
    private readonly notify: NotificationService,
  ) {}

  async run(tenantId: string, actor: string, input: ImportInput): Promise<ImportOutcome> {
    // ---------- 1. Décodage du fichier (hors transaction : pur calcul) ----------
    let header: string[];
    let rows: string[][];
    let fileBytes: Buffer | null = null;
    const formulaLines = new Set<number>();

    if (input.source === 'csv') {
      const text = input.contentText;
      if (typeof text !== 'string' || text.length === 0) return { kind: 'invalid', reason: 'contentText requis pour un CSV' };
      if (text.length > MAX_CSV_CHARS) return { kind: 'invalid', reason: `CSV trop volumineux (max ${MAX_CSV_CHARS} caractères)` };
      const parsed = parseCsv(text, { maxRows: MAX_ROWS });
      if (!parsed.ok) return { kind: 'invalid', reason: `CSV : ${parsed.error}` };
      header = parsed.header;
      rows = parsed.rows;
      fileBytes = Buffer.from(text, 'utf8');
    } else {
      const b64 = input.contentBase64;
      if (typeof b64 !== 'string' || b64.length === 0) return { kind: 'invalid', reason: 'contentBase64 requis pour un Excel' };
      let buf: Buffer;
      try {
        buf = Buffer.from(b64, 'base64');
      } catch {
        return { kind: 'invalid', reason: 'base64 invalide' };
      }
      if (buf.length > MAX_XLSX_BYTES) return { kind: 'invalid', reason: `Excel trop volumineux (max ${MAX_XLSX_BYTES} octets)` };
      const wb = readXlsx(buf);
      if (!wb.ok) return { kind: 'invalid', reason: `Excel : ${wb.error}` };
      header = wb.header;
      // Cellules → texte ; les NOMBRES des colonnes d'horodatage sont convertis via la
      // série Excel ; toute cellule à FORMULE invalide sa ligne (voir plus bas).
      rows = wb.rows.map((cells, i) => cells.map((c, j) => {
        if (c.formula) formulaLines.add(i + 2);
        if (c.num !== null) {
          const role = this.roleOfColumn(header[j] ?? '', input.mapping);
          if (role === 'datetime' || role === 'date') {
            const dt = excelSerialToDateTime(c.num);
            if (dt) return role === 'date' ? `${dt.canonical.slice(0, 10)}` : dt.canonical.replace('T', ' ');
          }
          if (role === 'time' && c.num >= 0 && c.num < 1) {
            const secs = Math.round(c.num * 86_400);
            const h = Math.floor(secs / 3600); const mi = Math.floor((secs % 3600) / 60); const s = secs % 60;
            return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
          }
        }
        return c.text;
      }));
      fileBytes = buf;
    }
    if (rows.length === 0) return { kind: 'invalid', reason: 'aucune ligne de données' };
    if (rows.length > MAX_ROWS) return { kind: 'invalid', reason: `trop de lignes (max ${MAX_ROWS})` };

    // ---------- 2. Correspondance + validation structurelle (pur calcul) ----------
    const mapped = mapPunchRows(header, rows, input.mapping);
    const errors: PunchImportError[] = [...mapped.errors];
    for (const line of [...formulaLines].sort((a, b) => a - b)) {
      errors.push({ line, error: 'cellule à formule refusée — les fichiers ne sont jamais interprétés' });
    }
    const structuralFatal = mapped.rows.length === 0 && errors.length > 0;

    const fileSha = fileBytes ? createHash('sha256').update(fileBytes).digest('hex') : null;

    return this.prisma.withTenant(tenantId, async (tx) => {
      // ---------- 3. Résolution des références (codes site/dispositif PAR tenant) ----------
      const siteIds = new Map<string, string>();
      const deviceIds = new Map<string, string>();
      if (input.defaultSiteId) {
        const s = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM org.sites WHERE id = ${input.defaultSiteId}::uuid`;
        if (s.length === 0) return { kind: 'invalid', reason: 'defaultSiteId inconnu dans ce tenant' };
      }
      if (input.defaultDeviceId) {
        const d = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM time.devices WHERE id = ${input.defaultDeviceId}::uuid`;
        if (d.length === 0) return { kind: 'invalid', reason: 'defaultDeviceId inconnu dans ce tenant' };
      }
      for (const row of mapped.rows) {
        if (row.siteCode && !siteIds.has(row.siteCode)) {
          const s = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM org.sites WHERE code = ${row.siteCode} AND status <> 'archived'`;
          if (s.length === 0) errors.push({ line: row.line, error: `site inconnu dans ce tenant : « ${row.siteCode} »` });
          else siteIds.set(row.siteCode, s[0]!.id);
        }
        if (row.deviceCode && !deviceIds.has(row.deviceCode)) {
          const d = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM time.devices WHERE code = ${row.deviceCode} AND status = 'active'`;
          if (d.length === 0) errors.push({ line: row.line, error: `dispositif inconnu ou inactif : « ${row.deviceCode} »` });
          else deviceIds.set(row.deviceCode, d[0]!.id);
        }
      }

      // ---------- 4. Clés d'idempotence : empreinte canonique + identifiant unique
      // externe — doublons DANS le fichier et EN base repérés AVANT toute écriture
      // (une transaction PostgreSQL avortée ne se rattrape pas ligne à ligne).
      const SEP = String.fromCharCode(1);
      const fingerprints = new Map<number, string>(); // line -> fp
      const dupLines = new Set<number>();
      const seenFps = new Map<string, number>();
      const seenUids = new Set<string>();
      for (const row of mapped.rows) {
        const fp = punchFingerprint({
          externalEmployeeId: row.externalEmployeeId,
          dateTimeCanonical: row.parsed!.canonical,
          deviceCode: row.deviceCode ?? (input.defaultDeviceId ? `#${input.defaultDeviceId}` : null),
          eventTypeRaw: row.eventTypeRaw,
          externalUniqueId: row.externalUniqueId,
        });
        fingerprints.set(row.line, fp);
        if (seenFps.has(fp)) dupLines.add(row.line);
        else seenFps.set(fp, row.line);
        if (row.externalUniqueId !== null) {
          const uidKey = `${row.deviceCode ?? input.defaultDeviceId ?? ''}|${row.externalUniqueId}`;
          if (seenUids.has(uidKey)) dupLines.add(row.line);
          else seenUids.add(uidKey);
        }
      }
      const uniqueFps = [...seenFps.keys()];
      const inDbFps = new Set<string>();
      for (let i = 0; i < uniqueFps.length; i += 500) {
        const chunk = uniqueFps.slice(i, i + 500).join(',');
        const found = await tx.$queryRaw<Array<{ fingerprint: string }>>`
          SELECT fingerprint FROM time.raw_punches
           WHERE fingerprint = ANY(string_to_array(${chunk}, ','))`;
        for (const f of found) inDbFps.add(f.fingerprint);
      }
      const uids = [...new Set(mapped.rows.map((r) => r.externalUniqueId).filter((u): u is string => u !== null))];
      const inDbUids = new Set<string>();
      for (let i = 0; i < uids.length; i += 500) {
        const chunk = uids.slice(i, i + 500).join(SEP);
        const found = await tx.$queryRaw<Array<{ external_unique_id: string }>>`
          SELECT external_unique_id FROM time.raw_punches
           WHERE external_unique_id = ANY(string_to_array(${chunk}, chr(1)))`;
        for (const f of found) inDbUids.add(f.external_unique_id);
      }

      // ---------- 5. Appariement ESTIMÉ (prévisualisation honnête) ----------
      const errorLines = new Set(errors.map((e) => e.line));
      const candidateRows = mapped.rows.filter((r) => !errorLines.has(r.line));
      let estimatedUnmatched = 0;
      const externalIds = [...new Set(candidateRows.map((r) => r.externalEmployeeId))];
      const matchable = new Set<string>();
      for (let i = 0; i < externalIds.length; i += 500) {
        const chunk = externalIds.slice(i, i + 500).join(SEP);
        const viaMapping = await tx.$queryRaw<Array<{ external_id: string }>>`
          SELECT external_id FROM time.employee_device_ids
           WHERE status = 'active' AND external_id = ANY(string_to_array(${chunk}, chr(1)))`;
        const viaMatricule = await tx.$queryRaw<Array<{ matricule: string }>>`
          SELECT matricule FROM core.employees
           WHERE deleted_at IS NULL AND matricule = ANY(string_to_array(${chunk}, chr(1)))`;
        for (const v of viaMapping) matchable.add(v.external_id);
        for (const v of viaMatricule) matchable.add(v.matricule);
      }
      for (const r of candidateRows) {
        if (!matchable.has(r.externalEmployeeId)) estimatedUnmatched += 1;
      }

      const isDup = (r: PunchImportRow): boolean =>
        dupLines.has(r.line) || inDbFps.has(fingerprints.get(r.line)!)
        || (r.externalUniqueId !== null && inDbUids.has(r.externalUniqueId));
      const dupCount = candidateRows.filter(isDup).length;
      const counts: ImportCounts = {
        received: rows.length,
        accepted: candidateRows.length - dupCount,
        duplicated: dupCount,
        rejected: rows.length - candidateRows.length,
        unmatched: estimatedUnmatched,
      };
      errors.sort((a, b) => a.line - b.line);
      const report = errors.slice(0, MAX_REPORT_ERRORS);
      const atomic = input.acceptOnlyValid !== true;
      const fatal = structuralFatal || (atomic && errors.length > 0);

      if (input.mode === 'preview') {
        // La prévisualisation N'ÉCRIT RIEN — ni lot, ni pointage, ni audit de données.
        return { kind: 'preview', counts, errors: report, effective: mapped.effective, wouldApply: !fatal };
      }

      // ---------- 6. APPLICATION ----------
      const status = fatal ? 'rejected' : errors.length > 0 ? 'partial' : 'applied';
      const keep = input.keepFile !== false && fileBytes !== null;
      const batch = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO time.punch_batches
          (tenant_id, source, filename, file_sha256, file_size, file_bytes, atomic, status,
           default_site_id, default_device_id, column_mapping,
           lines_received, lines_accepted, lines_duplicated, lines_rejected, lines_unmatched,
           error_report, created_by)
        VALUES (${tenantId}::uuid, ${input.source}, ${input.filename ?? null}, ${fileSha},
                ${fileBytes?.length ?? null}, ${keep ? fileBytes : null}, ${atomic}, ${status},
                ${input.defaultSiteId ?? null}::uuid, ${input.defaultDeviceId ?? null}::uuid,
                ${JSON.stringify(mapped.effective)}::jsonb,
                ${counts.received}, 0, 0, ${counts.rejected}, 0,
                ${JSON.stringify(report)}::jsonb, ${actor}::uuid)
        RETURNING id`;
      const batchId = batch[0]!.id;

      if (fatal) {
        await auditAuth(tx, tenantId, {
          action: 'time_import_rejected', actorUserId: actor, module: 'time',
          recordType: 'punch_batch', recordId: batchId,
          reason: `source=${input.source};lignes=${counts.received};erreurs=${errors.length};atomique=${atomic}`,
          newValue: { ...counts, accepted: 0, duplicated: 0, unmatched: 0 }, result: 'denied',
        });
        // E5 : échec d'application notifié aux porteurs de la permission d'import.
        await this.notifyImportFailure(tx, tenantId, actor, batchId, input, counts, errors.length);
        return { kind: 'rejected', batchId, counts: { ...counts, accepted: 0, duplicated: 0, unmatched: 0 }, errors: report };
      }

      let accepted = 0;
      let duplicated = 0;
      let unmatched = 0;
      for (const row of candidateRows) {
        const fp = fingerprints.get(row.line)!;
        const deviceId = row.deviceCode ? deviceIds.get(row.deviceCode)! : input.defaultDeviceId ?? null;
        const siteId = row.siteCode ? siteIds.get(row.siteCode)! : input.defaultSiteId ?? null;
        const inserted = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO time.raw_punches
            (tenant_id, batch_id, line_no, device_id, device_ref, site_id, external_employee_id,
             source_datetime_raw, event_type_raw, external_unique_id, fingerprint)
          VALUES (${tenantId}::uuid, ${batchId}::uuid, ${row.line}, ${deviceId}::uuid, ${row.deviceCode},
                  ${siteId}::uuid, ${row.externalEmployeeId}, ${row.sourceDateTimeRaw},
                  ${row.eventTypeRaw}, ${row.externalUniqueId}, ${fp})
          ON CONFLICT (tenant_id, fingerprint) DO NOTHING
          RETURNING id`;
        if (inserted.length === 0) {
          duplicated += 1;
          continue;
        }
        accepted += 1;
        const st = await this.punches.normalizeRawPunchTx(tx, tenantId, inserted[0]!.id);
        if (st !== 'matched') unmatched += 1;
      }
      await tx.$executeRaw`
        UPDATE time.punch_batches SET lines_accepted = ${accepted}, lines_duplicated = ${duplicated},
               lines_unmatched = ${unmatched}
         WHERE id = ${batchId}::uuid`;
      const finalCounts: ImportCounts = { ...counts, accepted, duplicated, unmatched };
      await auditAuth(tx, tenantId, {
        action: status === 'partial' ? 'time_import_partial' : 'time_import_applied',
        actorUserId: actor, module: 'time', recordType: 'punch_batch', recordId: batchId,
        reason: `source=${input.source};fichier=${input.filename ?? '-'}`,
        newValue: finalCounts, result: 'success',
      });
      return { kind: status, batchId, counts: finalCounts, errors: report };
    });
  }

  /** Rôle d'une colonne pour la conversion Excel (avant le mappage complet). */
  private roleOfColumn(header: string, mapping?: PunchMapping): string | null {
    const explicit = mapping?.[header.trim()];
    if (explicit) return explicit;
    // Auto-détection minimale locale (datetime / date / heure) — le mappage complet
    // revalide ensuite ; ici seule la CONVERSION de série est en jeu.
    if (/^(datetime|date_?heure|horodatage|timestamp|checktime|punch_?time)$/i.test(header.trim())) return 'datetime';
    if (/^(date|jour)$/i.test(header.trim())) return 'date';
    if (/^(heure|time|hour)$/i.test(header.trim())) return 'time';
    return null;
  }

  private pendingFormulaLines = new Set<number>();

  private async notifyImportFailure(
    tx: Prisma.TransactionClient, tenantId: string, actor: string, batchId: string,
    input: ImportInput, counts: ImportCounts, errorCount: number,
  ): Promise<void> {
    const holders = await tx.$queryRaw<Array<{ user_id: string }>>`
      SELECT DISTINCT ur.user_id FROM admin.user_roles ur
        JOIN admin.role_permissions rp ON rp.role_id = ur.role_id
        JOIN admin.users u ON u.id = ur.user_id
       WHERE rp.permission_key = 'time.punches_import' AND u.is_active`;
    const recipients = holders.length > 0 ? holders.map((h) => ({ userId: h.user_id })) : [{ userId: actor }];
    // Résultat IGNORÉ à dessein : sans modèle actif 'time_import_echec', rien n'est
    // envoyé ni simulé — le lot rejeté reste la source de vérité (E5 est un canal).
    await this.notify.publishEventTx(tx, tenantId, {
      eventKey: `time-import-echec-${batchId}`,
      templateKey: 'time_import_echec',
      payload: {
        fichier: input.filename ?? '(sans nom)',
        lignes: counts.received,
        erreurs: errorCount,
      },
      recipients,
      source: 'business',
      subjectType: 'punch_batch',
      subjectId: batchId,
      createdBy: actor,
    });
  }

  /** Fichier original d'un lot — permission d'import, accès AUDITÉ. */
  async batchFile(
    tenantId: string, actor: string, batchId: string,
  ): Promise<TimeOutcome<{ filename: string | null; contentBase64: string; sha256: string | null }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ filename: string | null; file_bytes: Buffer | null; file_sha256: string | null }>>`
        SELECT filename, file_bytes, file_sha256 FROM time.punch_batches WHERE id = ${batchId}::uuid`;
      const b = rows[0];
      if (!b) return { kind: 'not_found' };
      if (!b.file_bytes) return { kind: 'conflict', reason: 'fichier non conservé pour ce lot' };
      await auditAuth(tx, tenantId, {
        action: 'time_import_file_downloaded', actorUserId: actor, module: 'time',
        recordType: 'punch_batch', recordId: batchId, result: 'success',
      });
      return {
        kind: 'ok',
        filename: b.filename,
        contentBase64: Buffer.from(b.file_bytes).toString('base64'),
        sha256: b.file_sha256,
      };
    });
  }

  async listBatches(
    tenantId: string, actor: string, opts: { limit?: number; offset?: number },
  ): Promise<TimeOutcome<{ items: unknown[] }>> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'time.punches_view_errors', 'time.punches_import', 'time.devices_manage'))) {
        return { kind: 'forbidden', reason: 'permission requise : time.punches_view_errors' };
      }
      const items = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT b.id, b.source, b.filename, b.status, b.atomic, b.created_at AS "createdAt",
               b.lines_received AS "linesReceived", b.lines_accepted AS "linesAccepted",
               b.lines_duplicated AS "linesDuplicated", b.lines_rejected AS "linesRejected",
               b.lines_unmatched AS "linesUnmatched", b.file_sha256 AS "fileSha256",
               (b.file_bytes IS NOT NULL) AS "fileKept", u.email AS "createdByEmail"
          FROM time.punch_batches b LEFT JOIN admin.users u ON u.id = b.created_by
         ORDER BY b.created_at DESC LIMIT ${limit} OFFSET ${offset}`;
      return { kind: 'ok', items };
    });
  }

  async getBatch(tenantId: string, actor: string, id: string): Promise<TimeOutcome<{ batch: unknown }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await holdsPermission(tx, actor, 'time.punches_view_errors', 'time.punches_import', 'time.devices_manage'))) {
        return { kind: 'forbidden', reason: 'permission requise : time.punches_view_errors' };
      }
      const rows = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT b.id, b.source, b.filename, b.status, b.atomic, b.created_at AS "createdAt",
               b.lines_received AS "linesReceived", b.lines_accepted AS "linesAccepted",
               b.lines_duplicated AS "linesDuplicated", b.lines_rejected AS "linesRejected",
               b.lines_unmatched AS "linesUnmatched", b.error_report AS "errorReport",
               b.column_mapping AS "columnMapping", b.file_sha256 AS "fileSha256",
               (b.file_bytes IS NOT NULL) AS "fileKept", u.email AS "createdByEmail"
          FROM time.punch_batches b LEFT JOIN admin.users u ON u.id = b.created_by
         WHERE b.id = ${id}::uuid`;
      if (rows.length === 0) return { kind: 'not_found' };
      return { kind: 'ok', batch: rows[0] };
    });
  }
}
