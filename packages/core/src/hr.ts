/**
 * Core HR (E9) — domaine pur, zéro dépendance.
 *
 *  - cycle de vie salarié : draft → pre_hire → active ⇄ (suspended | on_leave) →
 *    terminated → archived, avec RÉINTÉGRATION (terminated → active) — miroir du
 *    trigger SQL ;
 *  - masquage d'identifiants administratifs : seuls les 3 derniers caractères
 *    apparaissent dans les journaux et l'audit (minimisation à l'ÉCRITURE) ;
 *  - état à une date : reconstruit depuis les événements de carrière (append-only) ;
 *  - validation d'import CSV salariés : matricules, doublons, dates, codes
 *    organisationnels requis — les identifiants sont acceptés mais JAMAIS recopiés
 *    dans les rapports d'erreurs.
 */
import { ORG_CODE_RE } from './org.ts';

// ---------------------------------------------------------------------------
// Cycle de vie
// ---------------------------------------------------------------------------

export type EmployeeStatus =
  | 'draft' | 'pre_hire' | 'active' | 'suspended' | 'on_leave' | 'terminated' | 'archived';

export const EMPLOYEE_STATUS_TRANSITIONS: Readonly<Record<EmployeeStatus, readonly EmployeeStatus[]>> = {
  draft: ['pre_hire', 'active', 'archived'],
  pre_hire: ['active', 'archived'],
  active: ['suspended', 'on_leave', 'terminated'],
  suspended: ['active', 'terminated'],
  on_leave: ['active', 'terminated'],
  terminated: ['active', 'archived'],   // réintégration possible, archived terminal
  archived: [],
};

export function canTransitionEmployeeStatus(from: EmployeeStatus, to: EmployeeStatus): boolean {
  return EMPLOYEE_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Type d'événement de carrière induit par une transition de statut. */
export function careerEventForTransition(from: EmployeeStatus, to: EmployeeStatus): string {
  if (to === 'active' && (from === 'draft' || from === 'pre_hire')) return 'hire';
  if (to === 'active' && from === 'terminated') return 'reinstatement';
  if (to === 'active' && (from === 'suspended' || from === 'on_leave')) return 'return';
  if (to === 'suspended') return 'suspension';
  if (to === 'terminated') return 'termination';
  return 'status_change';
}

// ---------------------------------------------------------------------------
// Masquage des identifiants (minimisation à l'écriture)
// ---------------------------------------------------------------------------

/** « •••789 » — jamais la valeur complète dans un journal ou un audit. */
export function maskIdentifier(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.length === 0) return null;
  const tail = value.slice(-3);
  return `•••${tail}`;
}

/**
 * Champs d'identifiants/privés dont la valeur est masquée avant TOUT audit :
 * identifiants administratifs (CNSS, IFU/fiscal, numéro de pièce, IBAN/banque),
 * contact d'urgence et coordonnées personnelles. Le type de pièce reste lisible
 * (c'est le numéro qui est sensible).
 */
// NB : les objets audités portent des clés camelCase (idDocumentNumber, personalPhone…) —
// les séparateurs sont donc OPTIONNELS dans le motif (leçon du run CI 30706100687).
const MASK_ON_WRITE_RE =
  /(cnss|tax_?id|ifu|id_?document_?number|iban|bank|banque|passport|emergency|personal_?phone|personal_?email)/i;

export function maskSensitiveFields(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === null || v === undefined) {
      out[k] = v;
    } else if (MASK_ON_WRITE_RE.test(k)) {
      // Valeur non textuelle sous une clé sensible : rien ne filtre non plus.
      out[k] = typeof v === 'string' ? maskIdentifier(v) : '•••';
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// État à une date (depuis la carrière append-only)
// ---------------------------------------------------------------------------

export interface CareerStatusEvent {
  effectiveDate: string;            // AAAA-MM-JJ
  /** Statut résultant si l'événement en induit un (details.status). */
  resultingStatus?: EmployeeStatus | null;
}

/**
 * Statut applicable à une date : dernier événement porteur de statut dont la date
 * d'effet est ≤ la date demandée (les événements arrivent triés par (date, id)).
 */
export function statusAtDate(events: CareerStatusEvent[], date: string): EmployeeStatus | null {
  let current: EmployeeStatus | null = null;
  for (const e of events) {
    if (e.effectiveDate > date) break;
    if (e.resultingStatus) current = e.resultingStatus;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Import CSV salariés
// ---------------------------------------------------------------------------

export const HR_IMPORT_COLUMNS = [
  'matricule', 'last_name', 'first_name', 'hire_date',
  'company_code', 'site_code', 'unit_code', 'position_code', 'job_code', 'cost_center_code',
  'effective_from', 'professional_status', 'work_email',
  'birth_date', 'nationality', 'personal_email', 'personal_phone',
  'cnss_number', 'tax_id',
] as const;

export interface HrImportRow {
  line: number;
  matricule: string;
  lastName: string;
  firstName: string;
  hireDate?: string;
  companyCode?: string;
  siteCode?: string;
  unitCode?: string;
  positionCode?: string;
  jobCode?: string;
  costCenterCode?: string;
  effectiveFrom?: string;
  professionalStatus?: string;
  workEmail?: string;
  birthDate?: string;
  nationality?: string;
  personalEmail?: string;
  personalPhone?: string;
  cnssNumber?: string;
  taxId?: string;
}

export interface HrImportError {
  line: number;
  matricule?: string;
  error: string;
}

export const MATRICULE_RE = /^[A-Z0-9][A-Z0-9._-]{0,29}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function mapHrImportRows(header: string[], records: string[][]): { rows: HrImportRow[]; errors: HrImportError[] } {
  const errors: HrImportError[] = [];
  const col = new Map<string, number>();
  header.forEach((h, i) => col.set(h, i));
  for (const required of ['matricule', 'last_name', 'first_name', 'company_code', 'unit_code']) {
    if (!col.has(required)) {
      return { rows: [], errors: [{ line: 1, error: `colonne obligatoire absente de l'en-tête : ${required}` }] };
    }
  }
  const cell = (r: string[], name: string): string | undefined => {
    const i = col.get(name);
    if (i === undefined) return undefined;
    const v = (r[i] ?? '').trim();
    return v === '' ? undefined : v;
  };
  const rows: HrImportRow[] = [];
  records.forEach((r, idx) => {
    const line = idx + 2;
    rows.push({
      line,
      matricule: (cell(r, 'matricule') ?? '').toUpperCase(),
      lastName: cell(r, 'last_name') ?? '',
      firstName: cell(r, 'first_name') ?? '',
      hireDate: cell(r, 'hire_date'),
      companyCode: cell(r, 'company_code')?.toUpperCase(),
      siteCode: cell(r, 'site_code')?.toUpperCase(),
      unitCode: cell(r, 'unit_code')?.toUpperCase(),
      positionCode: cell(r, 'position_code')?.toUpperCase(),
      jobCode: cell(r, 'job_code')?.toUpperCase(),
      costCenterCode: cell(r, 'cost_center_code')?.toUpperCase(),
      effectiveFrom: cell(r, 'effective_from'),
      professionalStatus: cell(r, 'professional_status'),
      workEmail: cell(r, 'work_email'),
      birthDate: cell(r, 'birth_date'),
      nationality: cell(r, 'nationality')?.toUpperCase(),
      personalEmail: cell(r, 'personal_email'),
      personalPhone: cell(r, 'personal_phone'),
      cnssNumber: cell(r, 'cnss_number'),
      taxId: cell(r, 'tax_id'),
    });
  });
  return { rows, errors };
}

/**
 * Validation structurelle : matricules conformes et uniques dans le fichier, noms
 * présents, dates AAAA-MM-JJ, société+unité requises. Les VALEURS d'identifiants ne
 * figurent jamais dans les erreurs (seuls ligne + matricule).
 */
export function validateHrImportRows(rows: HrImportRow[]): HrImportError[] {
  const errors: HrImportError[] = [];
  const seen = new Map<string, number>();
  const seenCnss = new Map<string, number>();
  for (const row of rows) {
    if (!MATRICULE_RE.test(row.matricule)) {
      errors.push({ line: row.line, matricule: row.matricule, error: 'matricule invalide (A-Z, 0-9, . _ -, 30 max)' });
    }
    if (row.lastName.length === 0 || row.lastName.length > 200) errors.push({ line: row.line, matricule: row.matricule, error: 'last_name requis (≤ 200)' });
    if (row.firstName.length === 0 || row.firstName.length > 200) errors.push({ line: row.line, matricule: row.matricule, error: 'first_name requis (≤ 200)' });
    for (const [label, v] of [['hire_date', row.hireDate], ['effective_from', row.effectiveFrom], ['birth_date', row.birthDate]] as const) {
      if (v && !DATE_RE.test(v)) errors.push({ line: row.line, matricule: row.matricule, error: `${label} invalide (AAAA-MM-JJ)` });
    }
    if (!row.companyCode || !ORG_CODE_RE.test(row.companyCode)) {
      errors.push({ line: row.line, matricule: row.matricule, error: 'company_code requis (code organisation valide)' });
    }
    if (!row.unitCode || !ORG_CODE_RE.test(row.unitCode)) {
      errors.push({ line: row.line, matricule: row.matricule, error: 'unit_code requis (code organisation valide)' });
    }
    if (row.nationality && !/^[A-Z]{2}$/.test(row.nationality)) {
      errors.push({ line: row.line, matricule: row.matricule, error: 'nationality invalide (ISO alpha-2)' });
    }
    const dup = seen.get(row.matricule);
    if (dup !== undefined) {
      errors.push({ line: row.line, matricule: row.matricule, error: `matricule en doublon dans le fichier (ligne ${dup})` });
    } else {
      seen.set(row.matricule, row.line);
    }
    if (row.cnssNumber) {
      const dupC = seenCnss.get(row.cnssNumber);
      if (dupC !== undefined) {
        // La VALEUR CNSS ne sort jamais dans le rapport — seulement les lignes.
        errors.push({ line: row.line, matricule: row.matricule, error: `numéro CNSS en doublon dans le fichier (ligne ${dupC})` });
      } else {
        seenCnss.set(row.cnssNumber, row.line);
      }
    }
  }
  return errors;
}
