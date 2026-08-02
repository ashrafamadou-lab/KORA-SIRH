/**
 * Lecteur XLSX MINIMAL (E10.1) — zéro dépendance : node:zlib uniquement.
 *
 * Un .xlsx est une archive ZIP de fichiers XML. Ce lecteur, volontairement borné :
 *  - lit le RÉPERTOIRE CENTRAL du ZIP (méthodes 'stored' et 'deflate' seulement) ;
 *  - extrait la PREMIÈRE feuille (ordre du classeur) et les chaînes partagées ;
 *  - rend les cellules en TEXTE : chaînes partagées (t="s"), chaînes en ligne
 *    (t="inlineStr"/is), texte brut (t="str"), booléens, nombres (le mappage amont
 *    convertit les séries de dates SEULEMENT dans les colonnes date/heure) ;
 *  - REFUSE toute cellule porteuse de FORMULE (<f>) : les données d'un fichier ne
 *    sont JAMAIS interprétées comme des formules exécutables — pas d'évaluation,
 *    pas de valeur en cache : un refus explicite par ligne ;
 *  - ne touche ni styles, ni fusions, ni macros (un .xlsm est refusé d'emblée).
 *
 * Limites ASSUMÉES (documentées au README) : ZIP64 non géré, chiffrement non géré,
 * une seule feuille lue. Pour ces cas : exporter en CSV.
 */
import { inflateRawSync } from 'node:zlib';

export interface XlsxCell {
  /** Valeur textuelle (les nombres gardent leur forme numérique en texte). */
  text: string;
  /** Nombre si la cellule est numérique (série de date potentielle). */
  num: number | null;
  /** true si la cellule portait une formule (refusée en amont). */
  formula: boolean;
}

export type XlsxResult =
  | { ok: true; header: string[]; rows: XlsxCell[][]; sheetName: string }
  | { ok: false; error: string };

const EOCD_SIG = 0x06054b50;
const CDIR_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

function readZipEntries(buf: Buffer): ZipEntry[] | null {
  // Fin de répertoire central : signature cherchée depuis la fin (commentaire ≤ 64 Ko).
  const minEocd = 22;
  const start = Math.max(0, buf.length - minEocd - 65_536);
  let eocd = -1;
  for (let i = buf.length - minEocd; i >= start; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd === -1) return null;
  const count = buf.readUInt16LE(eocd + 10);
  const cdirOffset = buf.readUInt32LE(eocd + 16);
  if (cdirOffset === 0xffffffff) return null; // ZIP64 : hors périmètre
  const entries: ZipEntry[] = [];
  let p = cdirOffset;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CDIR_SIG) return null;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

const MAX_UNCOMPRESSED = 20 * 1024 * 1024;

function readZipFile(buf: Buffer, entry: ZipEntry): Buffer | null {
  const p = entry.localOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== LOCAL_SIG) return null;
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const dataStart = p + 30 + nameLen + extraLen;
  const data = buf.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.uncompressedSize > MAX_UNCOMPRESSED) return null;
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) {
    try {
      return inflateRawSync(data, { maxOutputLength: MAX_UNCOMPRESSED });
    } catch {
      return null;
    }
  }
  return null; // méthode exotique : hors périmètre
}

// ---------------------------------------------------------------------------
// XML minimal : extraction d'éléments par balise (les XML d'Excel sont réguliers).
// ---------------------------------------------------------------------------

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

/** Texte concaténé de tous les <t> d'un fragment (chaînes riches comprises). */
function textOfSharedItem(fragment: string): string {
  let out = '';
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fragment)) !== null) out += decodeXml(m[1] ?? '');
  return out;
}

function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const re = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(textOfSharedItem(m[1]!));
  return out;
}

/** 'BC12' → index de colonne 0-based (54). */
export function columnIndex(cellRef: string): number {
  let col = 0;
  for (const ch of cellRef) {
    if (ch >= 'A' && ch <= 'Z') col = col * 26 + (ch.charCodeAt(0) - 64);
    else break;
  }
  return col - 1;
}

const MAX_ROWS = 20_000;
const MAX_COLS = 64;

function parseSheet(xml: string, shared: string[]): XlsxCell[][] | { error: string } {
  const rows: XlsxCell[][] = [];
  const rowRe = /<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g;
  // Attributs OPTIONNELS : une cellule sans attribut s'écrit « <c><v>…</v></c> » —
  // l'exiger décalait les colonnes (CI run 30753141804, colonne de série sautée).
  const cellRe = /<c(\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/c>)/g;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(xml)) !== null) {
    if (rows.length >= MAX_ROWS) return { error: `fichier trop long (max ${MAX_ROWS} lignes)` };
    const cells: XlsxCell[] = [];
    let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(rm[1]!)) !== null) {
      const attrs = cm[1] ?? '';
      const inner = cm[2] ?? '';
      const refMatch = /r="([A-Z]+)\d+"/.exec(attrs);
      const idx = refMatch ? columnIndex(refMatch[1]!) : cells.length;
      if (idx < 0 || idx >= MAX_COLS) continue;
      const type = /t="([a-zA-Z]+)"/.exec(attrs)?.[1] ?? 'n';
      const formula = /<f[\s>/]/.test(inner);
      const vMatch = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(inner);
      const rawV = vMatch ? decodeXml(vMatch[1]!) : '';
      let text = '';
      let num: number | null = null;
      if (type === 's') {
        text = shared[Number(rawV)] ?? '';
      } else if (type === 'inlineStr') {
        text = textOfSharedItem(inner);
      } else if (type === 'str') {
        text = rawV;
      } else if (type === 'b') {
        text = rawV === '1' ? 'true' : 'false';
      } else {
        text = rawV;
        if (rawV !== '' && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(rawV)) num = Number(rawV);
      }
      while (cells.length < idx) cells.push({ text: '', num: null, formula: false });
      cells[idx] = { text: text.trim(), num, formula };
    }
    rows.push(cells);
  }
  return rows;
}

/**
 * Lit la PREMIÈRE feuille d'un classeur .xlsx. L'en-tête est la première ligne non
 * vide ; les lignes suivantes sont rendues telles quelles (cellules typées).
 */
export function readXlsx(buf: Buffer): XlsxResult {
  if (buf.length < 100 || buf.readUInt32LE(0) !== LOCAL_SIG) {
    return { ok: false, error: 'fichier .xlsx invalide (signature ZIP absente)' };
  }
  const entries = readZipEntries(buf);
  if (!entries) return { ok: false, error: 'archive .xlsx illisible (répertoire central)' };
  const byName = new Map(entries.map((e) => [e.name, e]));
  if (byName.has('xl/vbaProject.bin')) {
    return { ok: false, error: 'classeur à macros refusé (.xlsm) — exporter en .xlsx ou .csv' };
  }
  const workbookEntry = byName.get('xl/workbook.xml');
  if (!workbookEntry) return { ok: false, error: 'classeur sans xl/workbook.xml' };
  const workbook = readZipFile(buf, workbookEntry)?.toString('utf8');
  if (!workbook) return { ok: false, error: 'xl/workbook.xml illisible' };

  const sheetTag = /<sheet\s[^>]*>/.exec(workbook)?.[0] ?? '';
  const sheetName = decodeXml(/name="([^"]*)"/.exec(sheetTag)?.[1] ?? 'Feuil1');
  const sheetRid = /r:id="([^"]*)"/.exec(sheetTag)?.[1] ?? null;

  let sheetPath = 'xl/worksheets/sheet1.xml';
  const relsEntry = byName.get('xl/_rels/workbook.xml.rels');
  if (sheetRid && relsEntry) {
    const rels = readZipFile(buf, relsEntry)?.toString('utf8') ?? '';
    const relRe = new RegExp(`<Relationship\\s[^>]*Id="${sheetRid}"[^>]*>`);
    const target = /Target="([^"]*)"/.exec(relRe.exec(rels)?.[0] ?? '')?.[1];
    if (target) sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  }
  const sheetEntry = byName.get(sheetPath);
  if (!sheetEntry) return { ok: false, error: `feuille introuvable : ${sheetPath}` };
  const sheetXml = readZipFile(buf, sheetEntry)?.toString('utf8');
  if (!sheetXml) return { ok: false, error: 'feuille illisible (compression non gérée ?)' };

  let shared: string[] = [];
  const sharedEntry = byName.get('xl/sharedStrings.xml');
  if (sharedEntry) {
    const sharedXml = readZipFile(buf, sharedEntry)?.toString('utf8');
    if (sharedXml === undefined || sharedXml === null) return { ok: false, error: 'chaînes partagées illisibles' };
    shared = parseSharedStrings(sharedXml);
  }

  const parsed = parseSheet(sheetXml, shared);
  if (!Array.isArray(parsed)) return { ok: false, error: parsed.error };

  const firstIdx = parsed.findIndex((r) => r.some((c) => c.text !== ''));
  if (firstIdx === -1) return { ok: false, error: 'feuille vide' };
  const header = parsed[firstIdx]!.map((c) => c.text);
  const rows = parsed.slice(firstIdx + 1).filter((r) => r.some((c) => c.text !== ''));
  return { ok: true, header, rows, sheetName };
}
