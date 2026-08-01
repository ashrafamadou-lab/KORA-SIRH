/**
 * Consultation d'audit (E6) — domaine pur, zéro dépendance.
 *
 * Décisions testables portées ici :
 *  - vues différenciées : la liste de permissions d'un acteur se résout en un accès
 *    {all | modules[] | own} — l'API n'invente jamais un périmètre, elle intersecte
 *    TOUJOURS les filtres demandés avec ce périmètre ;
 *  - masquage systématique : les clés à consonance de secret (mot de passe, jeton,
 *    hash, MFA…) sont remplacées par ‹masqué› dans old_value/new_value, et toute
 *    feuille texte passe par le masque anti-secrets (réutilisé de E5) — API, exports
 *    et journaux voient la MÊME sortie masquée ;
 *  - export CSV RFC 4180 : échappement complet + neutralisation de l'injection de
 *    formules tableur (préfixe apostrophe sur =, +, -, @) + BOM UTF-8 pour Excel ;
 *  - curseur de pagination STABLE : l'id (bigint croissant) — insensible aux
 *    insertions concurrentes, contrairement à un offset.
 */
import { scrubText } from './notify.ts';

// ---------------------------------------------------------------------------
// Vues différenciées par permission
// ---------------------------------------------------------------------------

export interface AuditAccess {
  /** audit.view : tout l'audit du tenant. */
  all: boolean;
  /** audit.view_<module> : modules consultables nommément. */
  modules: string[];
  /** audit.view_own : uniquement ses propres événements. */
  own: boolean;
  /** Au moins un droit de consultation. */
  any: boolean;
}

const MODULE_VIEW_PREFIX = 'audit.view_';
const MODULE_NAME_RE = /^[a-z_]+$/;

export function resolveAuditAccess(permissionKeys: string[]): AuditAccess {
  const all = permissionKeys.includes('audit.view');
  const own = permissionKeys.includes('audit.view_own');
  const modules: string[] = [];
  for (const key of permissionKeys) {
    if (!key.startsWith(MODULE_VIEW_PREFIX) || key === 'audit.view_own') continue;
    const m = key.slice(MODULE_VIEW_PREFIX.length);
    if (MODULE_NAME_RE.test(m) && !modules.includes(m)) modules.push(m);
  }
  return { all, modules, own, any: all || own || modules.length > 0 };
}

// ---------------------------------------------------------------------------
// Masquage systématique (API, exports, journaux)
// ---------------------------------------------------------------------------

export const MASKED = '‹masqué›';

/**
 * Clés dont la VALEUR est masquée d'office, quel que soit son contenu : secrets
 * techniques ET identifiants personnels du dossier salarié (E9 : CNSS, IFU/fiscal,
 * numéro de pièce, IBAN/banque, contact d'urgence) — défense en profondeur, en plus
 * du masquage à l'écriture côté RH.
 */
const SECRET_KEY_RE =
  /(password|passwd|mot_?de_?passe|secret|token|jeton|otp|totp|mfa|credential|api_?key|apikey|private_?key|cle_?privee|hash|cookie|authorization|cnss|ifu|tax_?id|id_document_number|passport|iban|bank|banque|emergency)/i;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

/** Masque anti-secrets pour texte libre (raison, erreurs) — sans troncature utile. */
export function maskAuditText(text: string): string {
  return scrubText(text, 10_000);
}

const MAX_DEPTH = 8;

/**
 * Masquage PROFOND d'une valeur JSON (old_value / new_value) : clé secrète ⇒ ‹masqué› ;
 * feuille texte ⇒ masque anti-secrets ; profondeur bornée (défense contre les
 * imbrications pathologiques).
 */
export function maskJsonDeep(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth >= MAX_DEPTH) return MASKED;
  if (typeof value === 'string') return maskAuditText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((v) => maskJsonDeep(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKey(k) ? MASKED : maskJsonDeep(v, depth + 1);
    }
    return out;
  }
  return MASKED; // types exotiques : rien ne passe
}

// ---------------------------------------------------------------------------
// Export CSV — RFC 4180 + anti-injection de formules
// ---------------------------------------------------------------------------

const NEEDS_QUOTING_RE = /[",;\r\n]/;
const FORMULA_INJECTION_RE = /^[=+\-@\t]/;

export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s: string;
  if (typeof value === 'string') s = value;
  else if (typeof value === 'number' || typeof value === 'boolean') s = String(value);
  else if (value instanceof Date) s = value.toISOString();
  else s = JSON.stringify(value);
  // Neutralise l'exécution de formules par un tableur (=SUM(...), @cmd, +/-).
  if (FORMULA_INJECTION_RE.test(s)) s = `'${s}`;
  if (NEEDS_QUOTING_RE.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Document CSV complet : BOM UTF-8 (Excel), en-tête, lignes CRLF (RFC 4180). */
export function toCsv(columns: string[], rows: Array<Record<string, unknown>>): string {
  const header = columns.map(csvEscape).join(';');
  const lines = rows.map((r) => columns.map((c) => csvEscape(r[c])).join(';'));
  return `${'\u{FEFF}'}${[header, ...lines].join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------------------
// Curseur de pagination stable
// ---------------------------------------------------------------------------

const CURSOR_RE = /^[1-9][0-9]{0,17}$/;

export type CursorParse = { ok: true; id: number | null } | { ok: false };

/** Curseur = id (bigint) de la dernière ligne vue ; absent = première page. */
export function parseAuditCursor(raw: string | undefined): CursorParse {
  if (raw === undefined || raw === '') return { ok: true, id: null };
  if (!CURSOR_RE.test(raw)) return { ok: false };
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) return { ok: false };
  return { ok: true, id: n };
}

// ---------------------------------------------------------------------------
// Empreinte compacte des filtres (pour la trace d'audit des consultations)
// ---------------------------------------------------------------------------

export function filtersDigest(filters: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(filters)) {
    if (v === undefined || v === null || v === '') continue;
    const s = String(v);
    parts.push(`${k}=${s.length > 40 ? `${s.slice(0, 39)}…` : s}`);
  }
  const digest = parts.join(';');
  return digest.length > 200 ? `${digest.slice(0, 199)}…` : digest;
}
