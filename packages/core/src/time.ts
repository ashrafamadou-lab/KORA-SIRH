/**
 * Temps & pointage (E10.1) — domaine pur, zéro dépendance.
 *
 * Porte les décisions testables hors base :
 *  - conversion heure LOCALE → UTC par fuseau IANA avec statut explicite : 'ok',
 *    'ambiguous' (repli d'heure — deux instants possibles) ou 'invalid' (trou de
 *    passage à l'heure d'été — l'heure n'existe pas). Le Bénin n'a pas d'heure d'été,
 *    mais KORA est générique : rien n'est supposé, tout est calculé ;
 *  - analyse des horodatages sources (formats ISO et jour/mois/année) SANS jamais
 *    évaluer quoi que ce soit — une valeur inattendue est une erreur, pas une devinette ;
 *  - jour de cycle d'une rotation (arithmétique de dates en UTC, insensible aux
 *    fuseaux) ;
 *  - EMPREINTE d'idempotence d'un pointage brut : le rejeu d'un même fichier, ou le
 *    même événement reçu par deux fichiers, produit la même empreinte ;
 *  - correspondance de colonnes d'un fichier de pointages (auto-détection FR/EN ou
 *    correspondance explicite) et validation STRUCTURELLE par ligne. Les valeurs
 *    commençant par '=', '+', '-' ou '@' restent du TEXTE INERTE : rien n'est jamais
 *    interprété comme une formule.
 */
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Fuseaux horaires
// ---------------------------------------------------------------------------

export const TZ_RE = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/;

const offsetCache = new Map<string, Intl.DateTimeFormat>();

function offsetFormatter(tz: string): Intl.DateTimeFormat {
  let f = offsetCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' });
    offsetCache.set(tz, f);
  }
  return f;
}

/** Décalage (minutes à AJOUTER à UTC pour obtenir l'heure locale) à un instant donné. */
export function tzOffsetMinutes(tz: string, utcMs: number): number {
  const parts = offsetFormatter(tz).formatToParts(new Date(utcMs));
  const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (!m) return 0; // 'GMT' sec = UTC
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

export interface LocalToUtcResult {
  status: 'ok' | 'ambiguous' | 'invalid';
  /** Instant retenu (premier candidat chronologique pour 'ambiguous', null si 'invalid'). */
  utcMs: number | null;
  /** Tous les instants candidats (2 si repli d'heure). */
  candidates: number[];
}

/**
 * Convertit une heure murale locale en instant UTC, en QUALIFIANT le résultat.
 * Méthode : candidats par double estimation du décalage, puis VÉRIFICATION stricte
 * de l'aller-retour — 0 candidat = heure inexistante, 2 = heure ambiguë.
 */
export function localToUtc(
  date: { y: number; mo: number; d: number },
  time: { h: number; mi: number; s?: number },
  tz: string,
): LocalToUtcResult {
  const wall = Date.UTC(date.y, date.mo - 1, date.d, time.h, time.mi, time.s ?? 0);
  // Décalages plausibles : à l'instant lui-même, après première correction, et à
  // ±24 h — nécessaire autour d'un repli d'heure, où DEUX décalages coexistent.
  const o1 = tzOffsetMinutes(tz, wall);
  const offsets = new Set([
    o1,
    tzOffsetMinutes(tz, wall - o1 * 60_000),
    tzOffsetMinutes(tz, wall - 86_400_000),
    tzOffsetMinutes(tz, wall + 86_400_000),
  ]);
  const guesses = [...new Set([...offsets].map((o) => wall - o * 60_000))];
  const candidates = guesses
    .filter((utc) => utc + tzOffsetMinutes(tz, utc) * 60_000 === wall)
    .sort((a, b) => a - b);
  if (candidates.length === 0) return { status: 'invalid', utcMs: null, candidates: [] };
  if (candidates.length > 1) return { status: 'ambiguous', utcMs: candidates[0]!, candidates };
  return { status: 'ok', utcMs: candidates[0]!, candidates };
}

// ---------------------------------------------------------------------------
// Horodatages sources
// ---------------------------------------------------------------------------

export interface ParsedDateTime {
  y: number; mo: number; d: number; h: number; mi: number; s: number;
  /** Forme canonique 'AAAA-MM-JJTHH:MM:SS' — sert d'assiette à l'empreinte. */
  canonical: string;
}

const ISO_DT_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/;
const FR_DT_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FR_DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function buildParsed(y: number, mo: number, d: number, h: number, mi: number, s: number): ParsedDateTime | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  // Rejet des dates inexistantes (30 février…) : l'aller-retour UTC doit être exact.
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return { y, mo, d, h, mi, s, canonical: `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}` };
}

/** 'AAAA-MM-JJ[ T]HH:MM[:SS]' ou 'JJ/MM/AAAA HH:MM[:SS]' — sinon null (jamais deviné). */
export function parseSourceDateTime(raw: string): ParsedDateTime | null {
  const v = raw.trim();
  let m = ISO_DT_RE.exec(v);
  if (m) return buildParsed(+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0));
  m = FR_DT_RE.exec(v);
  if (m) return buildParsed(+m[3]!, +m[2]!, +m[1]!, +m[4]!, +m[5]!, +(m[6] ?? 0));
  return null;
}

/** Date seule + heure seule (colonnes séparées). */
export function parseSourceDateAndTime(rawDate: string, rawTime: string): ParsedDateTime | null {
  const dv = rawDate.trim();
  const tv = rawTime.trim();
  const tm = TIME_RE.exec(tv);
  if (!tm) return null;
  let m = ISO_DATE_RE.exec(dv);
  if (m) return buildParsed(+m[1]!, +m[2]!, +m[3]!, +tm[1]!, +tm[2]!, +(tm[3] ?? 0));
  m = FR_DATE_RE.exec(dv);
  if (m) return buildParsed(+m[3]!, +m[2]!, +m[1]!, +tm[1]!, +tm[2]!, +(tm[3] ?? 0));
  return null;
}

/**
 * Série Excel → date-heure (système 1900, base 1899-12-30 ; la fraction est l'heure,
 * arrondie à la seconde). Retourne null hors bornes plausibles (1990…2100).
 */
export function excelSerialToDateTime(serial: number): ParsedDateTime | null {
  if (!Number.isFinite(serial) || serial <= 0) return null;
  const days = Math.floor(serial);
  const secs = Math.round((serial - days) * 86_400);
  const ms = Date.UTC(1899, 11, 30) + days * 86_400_000 + secs * 1_000;
  const dt = new Date(ms);
  const y = dt.getUTCFullYear();
  if (y < 1990 || y > 2100) return null;
  return buildParsed(y, dt.getUTCMonth() + 1, dt.getUTCDate(), dt.getUTCHours(), dt.getUTCMinutes(), dt.getUTCSeconds());
}

// ---------------------------------------------------------------------------
// Rotations
// ---------------------------------------------------------------------------

/** Jour de cycle (0-based) d'une date pour une rotation ancrée à anchor (jour 0). */
export function rotationDayIndex(dateIso: string, anchorIso: string, cycleDays: number): number {
  const d = ISO_DATE_RE.exec(dateIso.trim());
  const a = ISO_DATE_RE.exec(anchorIso.trim());
  if (!d || !a || !Number.isInteger(cycleDays) || cycleDays < 1) {
    throw new Error('rotationDayIndex : entrées invalides');
  }
  const days = Math.round((Date.UTC(+d[1]!, +d[2]! - 1, +d[3]!) - Date.UTC(+a[1]!, +a[2]! - 1, +a[3]!)) / 86_400_000);
  return ((days % cycleDays) + cycleDays) % cycleDays;
}

// ---------------------------------------------------------------------------
// Empreinte d'idempotence
// ---------------------------------------------------------------------------

export interface FingerprintInput {
  externalEmployeeId: string;
  /** Forme canonique de l'horodatage source (ParsedDateTime.canonical), ou brut si inanalysable. */
  dateTimeCanonical: string;
  deviceCode?: string | null;
  eventTypeRaw?: string | null;
  externalUniqueId?: string | null;
}

/**
 * Empreinte STABLE d'un pointage brut. Deux fichiers portant le même événement
 * produisent la même empreinte ; l'unicité (tenant_id, fingerprint) fait le reste.
 */
export function punchFingerprint(input: FingerprintInput): string {
  const parts = [
    input.externalEmployeeId.trim(),
    input.dateTimeCanonical.trim(),
    (input.deviceCode ?? '').trim(),
    (input.eventTypeRaw ?? '').trim().toUpperCase(),
    (input.externalUniqueId ?? '').trim(),
  ];
  return createHash('sha256').update(parts.join(''), 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Types d'événements sources
// ---------------------------------------------------------------------------

export type PunchEventType = 'in' | 'out' | 'break_start' | 'break_end' | 'unknown';

const EVENT_SYNONYMS: Readonly<Record<string, PunchEventType>> = {
  e: 'in', in: 'in', entree: 'in', entrée: 'in', arrivee: 'in', arrivée: 'in', '0': 'in', i: 'in',
  s: 'out', out: 'out', sortie: 'out', depart: 'out', départ: 'out', '1': 'out', o: 'out',
  pause: 'break_start', break: 'break_start', break_start: 'break_start', debut_pause: 'break_start',
  reprise: 'break_end', break_end: 'break_end', fin_pause: 'break_end', resume: 'break_end',
};

/** Type normalisé — une valeur inconnue reste 'unknown', jamais devinée. */
export function normalizeEventType(raw: string | null | undefined): PunchEventType {
  if (raw === null || raw === undefined || raw.trim() === '') return 'unknown';
  return EVENT_SYNONYMS[raw.trim().toLowerCase()] ?? 'unknown';
}

// ---------------------------------------------------------------------------
// Correspondance de colonnes et validation d'un fichier de pointages
// ---------------------------------------------------------------------------

export type PunchColumn =
  | 'external_id' | 'datetime' | 'date' | 'time' | 'event_type'
  | 'device' | 'site' | 'unique_id' | 'ignore';

/** Correspondance EXPLICITE : nom de colonne (en-tête) → rôle. */
export type PunchMapping = Readonly<Record<string, PunchColumn>>;

const HEADER_SYNONYMS: ReadonlyArray<[RegExp, PunchColumn]> = [
  [/^(matricule|badge|external_?id|identifiant|employee_?id|emp_?id|id_?salarie|user_?id|pin)$/i, 'external_id'],
  [/^(datetime|date_?heure|horodatage|timestamp|checktime|punch_?time)$/i, 'datetime'],
  [/^(date|jour)$/i, 'date'],
  [/^(heure|time|hour)$/i, 'time'],
  [/^(type|sens|direction|event|evenement|événement|checktype|in_?out|es)$/i, 'event_type'],
  [/^(dispositif|device|pointeuse|terminal|machine|sn|device_?code)$/i, 'device'],
  [/^(site|site_?code|lieu|location)$/i, 'site'],
  [/^(uid|unique_?id|source_?id|record_?id|guid)$/i, 'unique_id'],
];

export function detectPunchColumn(header: string): PunchColumn | null {
  const h = header.trim();
  for (const [re, col] of HEADER_SYNONYMS) {
    if (re.test(h)) return col;
  }
  return null;
}

export interface PunchImportRow {
  line: number;
  externalEmployeeId: string;
  parsed: ParsedDateTime | null;
  /** Horodatage source VERBATIM (jamais retouché — le brut reste le brut). */
  sourceDateTimeRaw: string;
  eventTypeRaw: string | null;
  deviceCode: string | null;
  siteCode: string | null;
  externalUniqueId: string | null;
}

export interface PunchImportError {
  line: number;
  error: string;
}

export interface PunchMapResult {
  rows: PunchImportRow[];
  errors: PunchImportError[];
  /** Correspondance effective par colonne (auto-détection complétée du mapping fourni). */
  effective: Record<string, PunchColumn>;
}

/**
 * Applique la correspondance de colonnes (fournie, sinon auto-détectée) et produit
 * des lignes typées. EXIGENCES : une colonne identifiant, et soit 'datetime', soit
 * 'date' + 'time'. Les colonnes non reconnues sans mapping explicite sont une ERREUR
 * (jamais d'interprétation silencieuse).
 */
export function mapPunchRows(header: string[], rows: string[][], mapping?: PunchMapping): PunchMapResult {
  const errors: PunchImportError[] = [];
  const effective: Record<string, PunchColumn> = {};
  const roleByIndex: Array<PunchColumn | null> = [];

  header.forEach((name, idx) => {
    const explicit = mapping?.[name.trim()];
    const role = explicit ?? detectPunchColumn(name);
    if (role === undefined || role === null) {
      errors.push({ line: 1, error: `colonne inconnue : « ${name.trim()} » (préciser la correspondance ou 'ignore')` });
      roleByIndex.push(null);
      return;
    }
    if (role !== 'ignore' && Object.values(effective).includes(role)) {
      errors.push({ line: 1, error: `colonne « ${name.trim()} » : rôle ${role} déjà attribué` });
    }
    effective[name.trim()] = role;
    roleByIndex.push(role);
  });

  const roles = Object.values(effective);
  if (!roles.includes('external_id')) errors.push({ line: 1, error: 'colonne identifiant salarié requise (matricule/badge/external_id)' });
  const hasDateTime = roles.includes('datetime');
  const hasSplit = roles.includes('date') && roles.includes('time');
  if (!hasDateTime && !hasSplit) errors.push({ line: 1, error: "colonne 'datetime' (ou 'date' + 'heure') requise" });
  if (errors.length > 0) return { rows: [], errors, effective };

  const out: PunchImportRow[] = [];
  rows.forEach((cells, i) => {
    const line = i + 2; // 1 = en-tête
    const get = (role: PunchColumn): string | null => {
      const idx = roleByIndex.findIndex((r) => r === role);
      if (idx === -1) return null;
      const v = (cells[idx] ?? '').trim();
      return v === '' ? null : v;
    };
    const externalId = get('external_id');
    if (externalId === null) {
      errors.push({ line, error: 'identifiant salarié vide' });
      return;
    }
    if (externalId.length > 100) {
      errors.push({ line, error: 'identifiant salarié trop long (max 100)' });
      return;
    }
    let parsed: ParsedDateTime | null = null;
    let rawDt = '';
    if (hasDateTime) {
      const dt = get('datetime');
      if (dt === null) {
        errors.push({ line, error: 'horodatage vide' });
        return;
      }
      rawDt = dt;
      parsed = parseSourceDateTime(dt);
    } else {
      const d = get('date');
      const t = get('time');
      if (d === null || t === null) {
        errors.push({ line, error: 'date ou heure vide' });
        return;
      }
      rawDt = `${d} ${t}`;
      parsed = parseSourceDateAndTime(d, t);
    }
    if (parsed === null) {
      errors.push({ line, error: `horodatage inanalysable : « ${rawDt.slice(0, 40)} » (AAAA-MM-JJ HH:MM[:SS] ou JJ/MM/AAAA HH:MM[:SS])` });
      return;
    }
    if (rawDt.length > 60) {
      errors.push({ line, error: 'horodatage trop long' });
      return;
    }
    out.push({
      line,
      externalEmployeeId: externalId,
      parsed,
      sourceDateTimeRaw: rawDt,
      eventTypeRaw: get('event_type'),
      deviceCode: get('device'),
      siteCode: get('site'),
      externalUniqueId: get('unique_id'),
    });
  });
  return { rows: out, errors, effective };
}
