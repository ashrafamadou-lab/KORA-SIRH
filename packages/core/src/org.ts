/**
 * Organisation (E8) — domaine pur, zéro dépendance.
 *
 * Porte les décisions testables hors base :
 *  - transitions de statut du référentiel (draft → active ⇄ inactive → archived,
 *    archived TERMINAL) — miroir du trigger SQL ;
 *  - parseur CSV RFC 4180 (guillemets, guillemets échappés, CRLF/LF, délimiteur ';'
 *    ou ',' détecté sur l'en-tête, BOM toléré) pour l'import initial ;
 *  - validation STRUCTURELLE d'un fichier d'import : sortes connues, codes conformes,
 *    libellés bilingues, références internes au fichier, DOUBLONS, CYCLES dans la
 *    hiérarchie des unités déclarée par le fichier, dates. Les références absentes du
 *    fichier sont remontées comme « références externes » que le service vérifie en
 *    base (codes du tenant uniquement — l'import ne peut par construction référencer
 *    aucun objet d'un autre tenant).
 */

// ---------------------------------------------------------------------------
// Statuts
// ---------------------------------------------------------------------------

export type OrgStatus = 'draft' | 'active' | 'inactive' | 'archived';

export const ORG_STATUS_TRANSITIONS: Readonly<Record<OrgStatus, readonly OrgStatus[]>> = {
  draft: ['active', 'archived'],
  active: ['inactive', 'archived'],
  inactive: ['active', 'archived'],
  archived: [],
};

export function canTransitionOrgStatus(from: OrgStatus, to: OrgStatus): boolean {
  return ORG_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

export const ORG_CODE_RE = /^[A-Z0-9][A-Z0-9_-]{0,29}$/;
export const UNIT_TYPES = ['direction', 'department', 'service', 'unit', 'team'] as const;
export type UnitType = (typeof UNIT_TYPES)[number];

// ---------------------------------------------------------------------------
// Parseur CSV — RFC 4180
// ---------------------------------------------------------------------------

export type CsvParseResult =
  | { ok: true; header: string[]; rows: string[][]; delimiter: string }
  | { ok: false; error: string; line?: number };

/**
 * Parse un CSV complet. Délimiteur détecté sur la ligne d'en-tête (';' privilégié —
 * convention Excel FR — sinon ','). Champs entre guillemets : délimiteurs, retours à
 * la ligne et guillemets doublés autorisés à l'intérieur.
 */
export function parseCsv(input: string, opts: { maxRows?: number } = {}): CsvParseResult {
  const maxRows = opts.maxRows ?? 5000;
  const text = input.startsWith('﻿') ? input.slice(1) : input;
  if (text.trim().length === 0) return { ok: false, error: 'fichier vide' };

  const firstLineEnd = text.search(/\r\n|\n|\r/);
  const firstLine = firstLineEnd === -1 ? text : text.slice(0, firstLineEnd);
  const delimiter = (firstLine.match(/;/g)?.length ?? 0) >= (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';

  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let line = 1;

  const pushField = () => { record.push(field); field = ''; };
  const pushRecord = () => { pushField(); records.push(record); record = []; };

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        if (c === '\n') line++;
        field += c;
      }
      continue;
    }
    if (c === '"') {
      if (field.length > 0) return { ok: false, error: 'guillemet inattendu au milieu d’un champ', line };
      inQuotes = true;
    } else if (c === delimiter) {
      pushField();
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      // ignore les lignes entièrement vides
      if (!(record.length === 0 && field === '')) pushRecord();
      line++;
      if (records.length > maxRows) return { ok: false, error: `trop de lignes (max ${maxRows})` };
    } else {
      field += c;
    }
  }
  if (inQuotes) return { ok: false, error: 'guillemet non refermé', line };
  if (!(record.length === 0 && field === '')) pushRecord();

  if (records.length === 0) return { ok: false, error: 'fichier vide' };
  const header = records[0]!.map((h) => h.trim().toLowerCase());
  const rows = records.slice(1);
  for (const [idx, r] of rows.entries()) {
    if (r.length !== header.length) {
      return { ok: false, error: `ligne ${idx + 2} : ${r.length} colonne(s) au lieu de ${header.length}`, line: idx + 2 };
    }
  }
  return { ok: true, header, rows, delimiter };
}

// ---------------------------------------------------------------------------
// Import organisation : structure du fichier
// ---------------------------------------------------------------------------

export const ORG_IMPORT_KINDS = ['company', 'site', 'cost_center', 'job', 'unit', 'position'] as const;
export type OrgImportKind = (typeof ORG_IMPORT_KINDS)[number];

/** Colonnes reconnues (l'ordre est libre, la casse de l'en-tête est ignorée). */
export const ORG_IMPORT_COLUMNS = [
  'kind', 'code', 'label_fr', 'label_en', 'unit_type', 'parent_code', 'unit_code',
  'company_code', 'site_code', 'job_code', 'cost_center_code', 'manager_position_code',
  'effective_from', 'city', 'category', 'legal_form',
] as const;

export interface OrgImportRow {
  line: number;
  kind: OrgImportKind;
  code: string;
  labelFr: string;
  labelEn: string;
  unitType?: string;
  parentCode?: string;
  unitCode?: string;
  companyCode?: string;
  siteCode?: string;
  jobCode?: string;
  costCenterCode?: string;
  managerPositionCode?: string;
  effectiveFrom?: string;
  city?: string;
  category?: string;
  legalForm?: string;
}

export interface OrgImportError {
  line: number;
  code?: string;
  error: string;
}

export interface OrgExternalRef {
  line: number;
  refKind: OrgImportKind;
  code: string;
}

export interface OrgImportValidation {
  errors: OrgImportError[];
  rows: OrgImportRow[];
  /** Références de codes ABSENTES du fichier — à vérifier en base (même tenant). */
  externalRefs: OrgExternalRef[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function cell(row: string[], index: number | undefined): string | undefined {
  if (index === undefined || index < 0) return undefined;
  const v = (row[index] ?? '').trim();
  return v === '' ? undefined : v;
}

/** Projette les enregistrements CSV sur les colonnes reconnues (en-tête libre). */
export function mapOrgImportRows(header: string[], records: string[][]): { rows: OrgImportRow[]; errors: OrgImportError[] } {
  const errors: OrgImportError[] = [];
  const col = new Map<string, number>();
  header.forEach((h, i) => col.set(h, i));
  for (const required of ['kind', 'code', 'label_fr', 'label_en']) {
    if (!col.has(required)) {
      return { rows: [], errors: [{ line: 1, error: `colonne obligatoire absente de l'en-tête : ${required}` }] };
    }
  }
  const rows: OrgImportRow[] = [];
  records.forEach((r, i) => {
    const line = i + 2; // 1 = en-tête
    const kindRaw = (cell(r, col.get('kind')) ?? '').toLowerCase();
    if (!ORG_IMPORT_KINDS.includes(kindRaw as OrgImportKind)) {
      errors.push({ line, error: `kind inconnu : « ${kindRaw} » (attendu : ${ORG_IMPORT_KINDS.join(', ')})` });
      return;
    }
    rows.push({
      line,
      kind: kindRaw as OrgImportKind,
      code: (cell(r, col.get('code')) ?? '').toUpperCase(),
      labelFr: cell(r, col.get('label_fr')) ?? '',
      labelEn: cell(r, col.get('label_en')) ?? '',
      unitType: cell(r, col.get('unit_type'))?.toLowerCase(),
      parentCode: cell(r, col.get('parent_code'))?.toUpperCase(),
      unitCode: cell(r, col.get('unit_code'))?.toUpperCase(),
      companyCode: cell(r, col.get('company_code'))?.toUpperCase(),
      siteCode: cell(r, col.get('site_code'))?.toUpperCase(),
      jobCode: cell(r, col.get('job_code'))?.toUpperCase(),
      costCenterCode: cell(r, col.get('cost_center_code'))?.toUpperCase(),
      managerPositionCode: cell(r, col.get('manager_position_code'))?.toUpperCase(),
      effectiveFrom: cell(r, col.get('effective_from')),
      city: cell(r, col.get('city')),
      category: cell(r, col.get('category')),
      legalForm: cell(r, col.get('legal_form')),
    });
  });
  return { rows, errors };
}

/**
 * Validation structurelle complète du fichier : codes, libellés, sortes, doublons,
 * références internes, CYCLE dans la hiérarchie d'unités déclarée, dates.
 */
export function validateOrgImportRows(rows: OrgImportRow[]): OrgImportValidation {
  const errors: OrgImportError[] = [];
  const externalRefs: OrgExternalRef[] = [];
  const byKindCode = new Map<string, OrgImportRow>();

  for (const row of rows) {
    if (!ORG_CODE_RE.test(row.code)) {
      errors.push({ line: row.line, code: row.code, error: 'code invalide (A-Z, 0-9, _ et -, 30 max, commence par alphanumérique)' });
    }
    if (row.labelFr.length === 0 || row.labelFr.length > 200) errors.push({ line: row.line, code: row.code, error: 'label_fr requis (≤ 200)' });
    if (row.labelEn.length === 0 || row.labelEn.length > 200) errors.push({ line: row.line, code: row.code, error: 'label_en requis (≤ 200)' });
    if (row.effectiveFrom && !DATE_RE.test(row.effectiveFrom)) {
      errors.push({ line: row.line, code: row.code, error: 'effective_from invalide (AAAA-MM-JJ)' });
    }
    const key = `${row.kind}:${row.code}`;
    if (byKindCode.has(key)) {
      errors.push({ line: row.line, code: row.code, error: `doublon dans le fichier (déjà défini ligne ${byKindCode.get(key)!.line})` });
    } else {
      byKindCode.set(key, row);
    }
  }

  const has = (kind: OrgImportKind, code: string | undefined): boolean =>
    code !== undefined && byKindCode.has(`${kind}:${code}`);
  const requireRef = (row: OrgImportRow, refKind: OrgImportKind, code: string | undefined, label: string, required: boolean) => {
    if (code === undefined) {
      if (required) errors.push({ line: row.line, code: row.code, error: `${label} requis` });
      return;
    }
    if (!has(refKind, code)) externalRefs.push({ line: row.line, refKind, code });
  };

  for (const row of rows) {
    switch (row.kind) {
      case 'company':
        break;
      case 'site':
        requireRef(row, 'company', row.companyCode, 'company_code', true);
        break;
      case 'cost_center':
      case 'job':
        break;
      case 'unit':
        if (!row.unitType || !UNIT_TYPES.includes(row.unitType as UnitType)) {
          errors.push({ line: row.line, code: row.code, error: `unit_type invalide (${UNIT_TYPES.join(', ')})` });
        }
        if (row.parentCode === row.code) {
          errors.push({ line: row.line, code: row.code, error: 'une unité ne peut pas être son propre parent' });
        }
        requireRef(row, 'unit', row.parentCode, 'parent_code', false);
        requireRef(row, 'company', row.companyCode, 'company_code', false);
        break;
      case 'position':
        requireRef(row, 'unit', row.unitCode, 'unit_code', true);
        requireRef(row, 'company', row.companyCode, 'company_code', true);
        requireRef(row, 'job', row.jobCode, 'job_code', true);
        requireRef(row, 'site', row.siteCode, 'site_code', false);
        requireRef(row, 'cost_center', row.costCenterCode, 'cost_center_code', false);
        requireRef(row, 'position', row.managerPositionCode, 'manager_position_code', false);
        if (row.managerPositionCode === row.code) {
          errors.push({ line: row.line, code: row.code, error: 'un poste ne peut pas être son propre manager' });
        }
        break;
    }
  }

  // Cycle dans la hiérarchie d'unités DÉCLARÉE PAR LE FICHIER (DFS trois couleurs).
  const unitParent = new Map<string, string>();
  for (const row of rows) {
    if (row.kind === 'unit' && row.parentCode && has('unit', row.parentCode)) {
      unitParent.set(row.code, row.parentCode);
    }
  }
  const state = new Map<string, 1 | 2>(); // 1 = en cours, 2 = fait
  for (const start of unitParent.keys()) {
    if (state.get(start) === 2) continue;
    const path: string[] = [];
    let cur: string | undefined = start;
    while (cur !== undefined && !state.has(cur)) {
      state.set(cur, 1);
      path.push(cur);
      cur = unitParent.get(cur);
    }
    if (cur !== undefined && state.get(cur) === 1) {
      const row = rows.find((r) => r.kind === 'unit' && r.code === cur);
      errors.push({ line: row?.line ?? 1, code: cur, error: 'cycle dans la hiérarchie des unités du fichier' });
    }
    for (const p of path) state.set(p, 2);
  }

  // Même contrôle sur la ligne managériale déclarée par le fichier.
  const posManager = new Map<string, string>();
  for (const row of rows) {
    if (row.kind === 'position' && row.managerPositionCode && has('position', row.managerPositionCode)) {
      posManager.set(row.code, row.managerPositionCode);
    }
  }
  const pstate = new Map<string, 1 | 2>();
  for (const start of posManager.keys()) {
    if (pstate.get(start) === 2) continue;
    const path: string[] = [];
    let cur: string | undefined = start;
    while (cur !== undefined && !pstate.has(cur)) {
      pstate.set(cur, 1);
      path.push(cur);
      cur = posManager.get(cur);
    }
    if (cur !== undefined && pstate.get(cur) === 1) {
      const row = rows.find((r) => r.kind === 'position' && r.code === cur);
      errors.push({ line: row?.line ?? 1, code: cur, error: 'cycle dans la ligne managériale du fichier' });
    }
    for (const p of path) pstate.set(p, 2);
  }

  return { errors, rows, externalRefs };
}
