/**
 * E10.1 — lecteur XLSX minimal : le test CONSTRUIT de vrais classeurs (ZIP écrit à la
 * main : entrées stockées ET déflatées, CRC-32) puis vérifie la lecture — chaînes
 * partagées, chaînes en ligne, nombres (séries de dates), REFUS des formules et des
 * classeurs à macros, erreurs franches sur archives invalides.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { columnIndex, readXlsx } from './xlsx-lite.ts';

// ---------------------------------------------------------------------------
// Constructeur ZIP de test (stored + deflate)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function buildZip(files: Array<{ name: string; content: string | Buffer; deflate?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const raw = Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, 'utf8');
    const data = f.deflate ? deflateRawSync(raw) : raw;
    const method = f.deflate ? 8 : 0;
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(Buffer.concat([local, name, data]));
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));
    offset += 30 + name.length + data.length;
  }
  const cdir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdir, eocd]);
}

const WORKBOOK = `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Pointages" sheetId="1" r:id="rId1"/></sheets></workbook>`;
const RELS = `<?xml version="1.0"?><Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;

function sheetXml(rowsXml: string): string {
  return `<?xml version="1.0"?><worksheet><sheetData>${rowsXml}</sheetData></worksheet>`;
}

function workbook(sheet: string, opts: { shared?: string; extraFiles?: Array<{ name: string; content: string }>; deflate?: boolean } = {}): Buffer {
  const files: Array<{ name: string; content: string; deflate?: boolean }> = [
    { name: '[Content_Types].xml', content: '<Types/>' },
    { name: 'xl/workbook.xml', content: WORKBOOK, deflate: opts.deflate },
    { name: 'xl/_rels/workbook.xml.rels', content: RELS },
    { name: 'xl/worksheets/sheet1.xml', content: sheet, deflate: opts.deflate },
  ];
  if (opts.shared) files.push({ name: 'xl/sharedStrings.xml', content: opts.shared, deflate: opts.deflate });
  for (const f of opts.extraFiles ?? []) files.push(f);
  return buildZip(files);
}

// ---------------------------------------------------------------------------

test('lecture : chaînes partagées, en-tête, nombres et texte — entrées STOCKÉES', () => {
  const shared = `<?xml version="1.0"?><sst><si><t>Matricule</t></si><si><t>DateHeure</t></si><si><t>Sens</t></si><si><t>B-1</t></si><si><r><t>E</t></r></si></sst>`;
  const sheet = sheetXml(
    `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>` +
    `<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" t="str"><v>2026-07-01 08:00</v></c><c r="C2" t="s"><v>4</v></c></row>` +
    `<row r="3"><c r="A3" t="inlineStr"><is><t>B-2</t></is></c><c r="B3"><v>46204.918784722</v></c><c r="C3" t="str"><v>S</v></c></row>`,
  );
  const r = readXlsx(workbook(sheet, { shared }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.sheetName, 'Pointages');
  assert.deepEqual(r.header, ['Matricule', 'DateHeure', 'Sens']);
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0]![0]!.text, 'B-1');
  assert.equal(r.rows[0]![1]!.text, '2026-07-01 08:00');
  assert.equal(r.rows[0]![2]!.text, 'E'); // chaîne riche (<r><t>)
  assert.equal(r.rows[1]![0]!.text, 'B-2'); // inlineStr
  assert.ok(Math.abs(r.rows[1]![1]!.num! - 46204.918784722) < 1e-9); // série de date
});

test('lecture : entrées DÉFLATÉES (compression réelle)', () => {
  const shared = `<sst><si><t>Matricule</t></si><si><t>DateHeure</t></si><si><t>B-9</t></si></sst>`;
  const sheet = sheetXml(
    `<row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row>` +
    `<row><c t="s"><v>2</v></c><c t="str"><v>2026-07-02 06:00</v></c></row>`,
  );
  const r = readXlsx(workbook(sheet, { shared, deflate: true }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.header, ['Matricule', 'DateHeure']);
  assert.equal(r.rows[0]![0]!.text, 'B-9');
});

test('FORMULES : marquées, jamais évaluées — et cellules éparses réalignées par référence', () => {
  const sheet = sheetXml(
    `<row r="1"><c r="A1" t="str"><v>Matricule</v></c><c r="C1" t="str"><v>Sens</v></c></row>` +
    `<row r="2"><c r="A2" t="str"><v>B-1</v></c><c r="C2"><f>SUM(A1:A9)</f><v>42</v></c></row>`,
  );
  const r = readXlsx(workbook(sheet));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.header[0], 'Matricule');
  assert.equal(r.header[1], ''); // B1 absente → trou comblé
  assert.equal(r.header[2], 'Sens');
  assert.equal(r.rows[0]![2]!.formula, true, 'la cellule à formule est SIGNALÉE');
  assert.equal(r.rows[0]![2]!.text, '42'); // valeur en cache exposée mais l'import la REFUSE
});

test('classeur à MACROS : refusé d’emblée', () => {
  const sheet = sheetXml(`<row><c t="str"><v>x</v></c></row>`);
  const r = readXlsx(workbook(sheet, { extraFiles: [{ name: 'xl/vbaProject.bin', content: 'MACRO' }] }));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(r.error.includes('macros'));
});

test('erreurs franches : signature absente, feuille vide, échappements XML', () => {
  assert.equal(readXlsx(Buffer.from('pas un zip du tout — vraiment pas')).ok, false);
  const empty = readXlsx(workbook(sheetXml('')));
  assert.equal(empty.ok, false);
  const esc = readXlsx(workbook(sheetXml(
    `<row><c t="str"><v>A&amp;B &lt;ok&gt;</v></c><c t="str"><v>x</v></c></row><row><c t="str"><v>=1+1</v></c><c t="str"><v>&#233;t&#xE9;</v></c></row>`,
  )));
  assert.equal(esc.ok, true);
  if (!esc.ok) return;
  assert.equal(esc.header[0], 'A&B <ok>');
  assert.equal(esc.rows[0]![0]!.text, '=1+1'); // texte INERTE, jamais interprété
  assert.equal(esc.rows[0]![1]!.text, 'été');
});

test('columnIndex : A=0, Z=25, AA=26, BC12=54', () => {
  assert.equal(columnIndex('A1'), 0);
  assert.equal(columnIndex('Z9'), 25);
  assert.equal(columnIndex('AA3'), 26);
  assert.equal(columnIndex('BC12'), 54);
});
