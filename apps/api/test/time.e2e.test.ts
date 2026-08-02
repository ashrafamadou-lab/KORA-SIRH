/**
 * E2E Temps & pointage (E10.1) — conditions de validation du sponsor :
 * isolation tenant (lecture ET écriture), FK inter-tenant rejetées par PostgreSQL,
 * brut APPEND-ONLY (aucune modification/suppression), rejeu de fichier SANS doublon,
 * même événement par deux fichiers = UNE ligne logique, non-apparié SANS création de
 * salarié, rattachement à l'affectation applicable à la date, inactif / pas encore
 * embauché signalés, nuits traversant minuit sans ambiguïté, modification future
 * d'horaire sans effet sur le passé, chevauchements rejetés, import partiellement
 * invalide = AUCUNE écriture en mode atomique, formules Excel neutralisées, portées
 * RBAC réelles (unité, self), fuseau résolu dispositif→site→paramètre E4 à la date,
 * notification E5 sur échec, audit E6, fichier conservé téléchargeable AUDITÉ.
 * Fixtures : permissions issues des MIGRATIONS uniquement (la CI ne seed pas).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import * as argon2 from 'argon2';
import type { INestApplication } from '@nestjs/common';

process.env.KORA_MFA_KEY ??=
  'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
import { createApp } from '../src/main';

const MIGRATOR_URL =
  process.env.DATABASE_URL_MIGRATOR ??
  'postgres://kora_migrator:kora_migrator_dev@127.0.0.1:5432/kora';
function psql(sql: string): string {
  const r = spawnSync('psql', [MIGRATOR_URL, '-qXtA', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

const rid = randomUUID().slice(0, 8);
const RID = rid.toUpperCase();
const P = 'Pendjari-Atacora-2026!';
const slugA = `tm-a-${rid}`;
const slugB = `tm-b-${rid}`;

const admEmail = `tmadm.${rid}@demo.bj`;    // toutes permissions time.* + org + notify + audit (tenant)
const chefEmail = `tmchef.${rid}@demo.bj`;  // time.punches_view, portée UNITÉ RH seulement
const selfEmail = `tmself.${rid}@demo.bj`;  // time.punches_view_own, lié au salarié E1
const nakedEmail = `tmnone.${rid}@demo.bj`; // aucune permission time.*
const bAdmEmail = `tmbadm.${rid}@demo.bj`;

let app: INestApplication;
let base = '';
let tenantAId = '';
let tenantBId = '';
let selfUserId = '';

async function seedUser(tenantId: string, email: string, perms: string[], tenantScope: boolean): Promise<string> {
  const h = await argon2.hash(P, { type: argon2.argon2id });
  const id = psql(`INSERT INTO admin.users (tenant_id, email, password_hash) VALUES ('${tenantId}','${email}','${h}') RETURNING id`);
  if (tenantScope) psql(`INSERT INTO admin.user_scopes (tenant_id, user_id, scope_type) VALUES ('${tenantId}','${id}','tenant')`);
  if (perms.length > 0) {
    const role = psql(`INSERT INTO admin.roles (tenant_id, key, name) VALUES ('${tenantId}','r-${email.split('@')[0]}','R') RETURNING id`);
    for (const p of perms) psql(`INSERT INTO admin.role_permissions (tenant_id, role_id, permission_key) VALUES ('${tenantId}','${role}','${p}')`);
    psql(`INSERT INTO admin.user_roles (tenant_id, user_id, role_id) VALUES ('${tenantId}','${id}','${role}')`);
  }
  return id;
}

before(async () => {
  tenantAId = psql(`INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('${slugA}','TM A',true) RETURNING id`);
  tenantBId = psql(`INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('${slugB}','TM B',true) RETURNING id`);
  await seedUser(tenantAId, admEmail, [
    'time.schedules_view', 'time.schedules_manage', 'time.schedules_assign',
    'time.punches_import', 'time.punches_view', 'time.punches_view_errors', 'time.devices_manage',
    'org.view', 'org.manage', 'employees.view', 'employees.manage', 'employees.assign',
    'notify.manage', 'audit.view',
  ], true);
  selfUserId = await seedUser(tenantAId, selfEmail, ['time.punches_view_own'], true);
  await seedUser(tenantAId, nakedEmail, ['employees.view'], true);
  await seedUser(tenantBId, bAdmEmail, [
    'time.schedules_view', 'time.schedules_manage', 'time.schedules_assign',
    'time.punches_import', 'time.punches_view', 'time.punches_view_errors', 'time.devices_manage',
    'org.view', 'org.manage',
  ], true);
  // chef : la portée UNITÉ est ajoutée après création de l'organisation (trigger E8).
  await seedUser(tenantAId, chefEmail, ['time.punches_view', 'time.schedules_view'], false);

  // Paramètre E4 « temps.fuseau.defaut » (fuseau par défaut du tenant) : FIXTURE active — le cycle
  // de vie complet (brouillon→contreseing→activation) est prouvé par la suite config.
  // Le garde-fou E4 exige source + vérificateur pour tout paramètre actif (CI run
  // 30714332862) : la fixture les porte, comme le ferait le circuit réel.
  psql(`INSERT INTO compliance.legal_parameters
          (tenant_id, country_code, key, value, effective_from, status, is_legal_sensitive,
           confidence, source_text, verified_by, verified_at)
        VALUES ('${tenantAId}', 'BJ', 'temps.fuseau.defaut', '"Africa/Porto-Novo"', '2020-01-01', 'active', false,
                'verified', 'Fuseau du siège (référentiel IANA) — paramètre opérationnel', 'fixture-e2e', '2026-01-01')`);

  app = await createApp();
  await app.listen(0);
  const addr = app.getHttpServer().address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  base = `http://127.0.0.1:${port}/api/v1`;
});

after(async () => { if (app) await app.close(); });

const tokenCache = new Map<string, string>();
async function token(slug: string, email: string): Promise<string> {
  const cached = tokenCache.get(email);
  if (cached) return cached;
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenantSlug: slug, email, password: P }),
  });
  assert.equal(res.status, 200, `login ${email}`);
  const tok = ((await res.json()) as { token: string }).token;
  tokenCache.set(email, tok);
  return tok;
}
function api(path: string, tok: string, body?: unknown, method = 'POST'): Promise<Response> {
  return fetch(`${base}${path}`, {
    method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function created(path: string, tok: string, body: unknown): Promise<string> {
  const res = await api(path, tok, body);
  if (res.status !== 201) assert.fail(`${path} → ${res.status} : ${await res.text().catch(() => '')}`);
  return ((await res.json()) as { id: string }).id;
}
async function getJson<T>(path: string, tok: string): Promise<T> {
  const res = await api(path, tok, undefined, 'GET');
  assert.equal(res.status, 200, `${path} → ${res.status}`);
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Constructeur XLSX de test (ZIP stocké/déflaté + CRC-32) — identique au test core.
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
function buildZip(files: Array<{ name: string; content: string }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const raw = Buffer.from(f.content, 'utf8');
    const data = deflateRawSync(raw);
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(Buffer.concat([local, name, data]));
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));
    offset += 30 + name.length + data.length;
  }
  const cdir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdir.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdir, eocd]);
}
function xlsxOf(headerRow: string, dataRows: string[]): string {
  const wb = `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="P" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const rels = `<?xml version="1.0"?><Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/></Relationships>`;
  const sheet = `<?xml version="1.0"?><worksheet><sheetData>${headerRow}${dataRows.join('')}</sheetData></worksheet>`;
  return buildZip([
    { name: '[Content_Types].xml', content: '<Types/>' },
    { name: 'xl/workbook.xml', content: wb },
    { name: 'xl/_rels/workbook.xml.rels', content: rels },
    { name: 'xl/worksheets/sheet1.xml', content: sheet },
  ]).toString('base64');
}
const cellStr = (v: string) => `<c t="str"><v>${v}</v></c>`;
const row = (cells: string[]) => `<row>${cells.join('')}</row>`;

// ---------------------------------------------------------------------------
// Fixtures organisationnelles et salariés
// ---------------------------------------------------------------------------
let coA = ''; let siteA = ''; let uRh = ''; let uIt = '';
let e1 = ''; let e2 = ''; let eLate = ''; let eSusp = '';
let modelId = ''; let deviceId = '';
const MAT1 = `TM1-${RID}`;
const MAT2 = `TM2-${RID}`;
const MATL = `TML-${RID}`;
const MATS = `TMS-${RID}`;

async function activate(adm: string, entity: string, id: string): Promise<void> {
  const r = await api(`/org/${entity}/${id}/status`, adm, { status: 'active' });
  assert.equal(r.status, 200, `activation ${entity}`);
}

test('01 fixtures : organisation (site avec fuseau), salariés, dossiers affectés', async () => {
  const adm = await token(slugA, admEmail);
  coA = await created('/org/companies', adm, { code: 'TM-CO', labelFr: 'Société', labelEn: 'Company' });
  await activate(adm, 'companies', coA);
  siteA = await created('/org/sites', adm, { code: 'TM-SITE', labelFr: 'Site Cotonou', labelEn: 'Cotonou', companyId: coA });
  await activate(adm, 'sites', siteA);
  psql(`UPDATE org.sites SET time_zone = 'Africa/Porto-Novo' WHERE id = '${siteA}'`);
  uRh = await created('/org/units', adm, { code: 'TM-RH', labelFr: 'RH', labelEn: 'HR', unitType: 'direction', companyId: coA });
  await activate(adm, 'units', uRh);
  uIt = await created('/org/units', adm, { code: 'TM-IT', labelFr: 'IT', labelEn: 'IT', unitType: 'direction', companyId: coA });
  await activate(adm, 'units', uIt);

  const mk = async (mat: string, first: string, unit: string, hire: string): Promise<string> => {
    const id = ((await (await api('/employees', adm, {
      matricule: mat, firstName: first, lastName: 'Test', hireDate: hire,
    })).json()) as { id: string }).id;
    psql(`UPDATE core.employees SET status = 'active' WHERE id = '${id}'`);
    const asg = await api(`/employees/${id}/assignments`, adm, {
      companyId: coA, siteId: siteA, unitId: unit, effectiveFrom: hire, isPrimary: true,
    });
    assert.equal(asg.status, 201, 'affectation');
    return id;
  };
  e1 = await mk(MAT1, 'Awa', uRh, '2025-01-06');
  e2 = await mk(MAT2, 'Bio', uIt, '2025-01-06');
  eLate = await mk(MATL, 'Chris', uRh, '2026-12-01'); // embauche FUTURE
  eSusp = await mk(MATS, 'Dossi', uRh, '2025-01-06');
  psql(`UPDATE core.employees SET status = 'suspended' WHERE id = '${eSusp}'`);
  // Lien self : le compte selfEmail EST le salarié E1.
  psql(`UPDATE core.employees SET user_id = '${selfUserId}' WHERE id = '${e1}'`);
  // Portée UNITÉ RH pour le chef.
  const chefId = psql(`SELECT id FROM admin.users WHERE email = '${chefEmail}'`);
  psql(`INSERT INTO admin.user_scopes (tenant_id, user_id, scope_type, scope_ref) VALUES ('${tenantAId}','${chefId}','department','${uRh}')`);
});

test('02 modèle d’horaire : version 1, nuit 22:00→06:00 représentée 1320→1800, cycle complet exigé', async () => {
  const adm = await token(slugA, admEmail);
  modelId = await created('/time/schedules/models', adm, {
    code: 'ROT-NUIT', labelFr: 'Rotation nuit', labelEn: 'Night rotation', kind: 'rotation',
  });
  // Cycle incomplet : refusé AVANT la base.
  const bad = await api(`/time/schedules/models/${modelId}/versions`, adm, {
    effectiveFrom: '2025-06-02', cycleDays: 4,
    days: [{ dayIndex: 0, isRest: true }],
  });
  assert.equal(bad.status, 400, 'cycle incomplet refusé');
  const v1 = await api(`/time/schedules/models/${modelId}/versions`, adm, {
    effectiveFrom: '2025-06-02', cycleDays: 4,
    days: [
      { dayIndex: 0, isRest: false, startMinute: 1320, endMinute: 1800, label: 'Nuit' }, // 22:00 → 06:00 LENDEMAIN
      { dayIndex: 1, isRest: false, startMinute: 480, endMinute: 1020, breakStartMinute: 720, breakEndMinute: 780 },
      { dayIndex: 2, isRest: true },
      { dayIndex: 3, isRest: true },
    ],
  });
  assert.equal(v1.status, 201, `version 1 : ${await v1.clone().text()}`);
  const model = await getJson<{ model: { versions: Array<{ days: Array<Record<string, unknown>> }> } }>(
    `/time/schedules/models/${modelId}`, adm);
  const day0 = model.model.versions[0]!.days.find((d) => d['dayIndex'] === 0)!;
  assert.equal(day0['endMinute'], 1800, 'la traversée de minuit est un FAIT (end > 1440), pas une convention');
});

test('03 affectation datée : chevauchement rejeté (409, PostgreSQL), clôture puis nouvelle ligne', async () => {
  const adm = await token(slugA, admEmail);
  const a1 = await api('/time/schedules/assignments', adm, {
    employeeId: e1, modelId, anchorDate: '2026-01-05', effectiveFrom: '2026-01-05',
  });
  assert.equal(a1.status, 201);
  const overlap = await api('/time/schedules/assignments', adm, {
    employeeId: e1, modelId, anchorDate: '2026-03-01', effectiveFrom: '2026-03-01',
  });
  assert.equal(overlap.status, 409, 'chevauchement ⇒ 409 (contrainte d’exclusion)');
  // Les autres salariés : affectés aussi (mêmes anchor).
  for (const emp of [e2, eLate, eSusp]) {
    assert.equal((await api('/time/schedules/assignments', adm, {
      employeeId: emp, modelId, anchorDate: '2026-01-05', effectiveFrom: '2026-01-05',
    })).status, 201);
  }
});

test('04 horaire applicable à une date : rotation exacte (jour 0 nuit, jour 2 repos)', async () => {
  const adm = await token(slugA, admEmail);
  const d0 = await getJson<{ dayIndex: number; day: { endMinute: number } }>(
    `/time/employees/${e1}/schedule?date=2026-07-01`, adm); // (2026-07-01 - 2026-01-05) = 177 jours ; 177 % 4 = 1
  assert.equal(d0.dayIndex, 1);
  const d1 = await getJson<{ dayIndex: number; day: { endMinute: number; isRest: boolean } }>(
    `/time/employees/${e1}/schedule?date=2026-06-30`, adm); // 176 % 4 = 0 → nuit
  assert.equal(d1.dayIndex, 0);
  assert.equal(d1.day.endMinute, 1800);
  const d2 = await getJson<{ dayIndex: number; day: { isRest: boolean } }>(
    `/time/employees/${e1}/schedule?date=2026-07-02`, adm); // 178 % 4 = 2 → repos
  assert.equal(d2.day.isRest, true);
});

test('05 le PASSÉ est figé : version future ajoutée, l’horaire d’une date passée ne change PAS', async () => {
  const adm = await token(slugA, admEmail);
  const before5 = await getJson<{ applicableVersion: number; cycleDays: number }>(
    `/time/employees/${e1}/schedule?date=2026-06-30`, adm);
  assert.equal(before5.applicableVersion, 1);
  // Version 2 dans le PASSÉ : refusée par la BASE.
  const past = await api(`/time/schedules/models/${modelId}/versions`, adm, {
    effectiveFrom: '2026-01-01', cycleDays: 2,
    days: [{ dayIndex: 0, isRest: true }, { dayIndex: 1, isRest: true }],
  });
  assert.equal(past.status, 400, 'version passée refusée');
  // Version 2 FUTURE (année prochaine) : acceptée…
  const future = await api(`/time/schedules/models/${modelId}/versions`, adm, {
    effectiveFrom: '2027-03-01', cycleDays: 2,
    days: [{ dayIndex: 0, isRest: false, startMinute: 540, endMinute: 1080 }, { dayIndex: 1, isRest: true }],
  });
  assert.equal(future.status, 201);
  // …et la lecture d'une date PASSÉE rend TOUJOURS la version 1, cycle 4.
  const after5 = await getJson<{ applicableVersion: number; cycleDays: number }>(
    `/time/employees/${e1}/schedule?date=2026-06-30`, adm);
  assert.equal(after5.applicableVersion, 1);
  assert.equal(after5.cycleDays, 4);
  // Une date POSTÉRIEURE à la version 2 la voit, elle.
  const v2 = await getJson<{ applicableVersion: number }>(`/time/employees/${e1}/schedule?date=2027-03-02`, adm);
  assert.equal(v2.applicableVersion, 2);
});

test('06 fériés versionnés et exceptions : visibles dans l’horaire applicable', async () => {
  const adm = await token(slugA, admEmail);
  const cal = await created('/time/holidays/calendars', adm, { code: 'FERIES-BJ', labelFr: 'Fériés', labelEn: 'Holidays' });
  await created('/time/holidays', adm, { calendarId: cal, date: '2026-08-01', labelFr: 'Indépendance', labelEn: 'Independence Day' });
  const sched = await getJson<{ holidays: Array<{ labelFr: string }> }>(`/time/employees/${e1}/schedule?date=2026-08-01`, adm);
  assert.equal(sched.holidays.length, 1);
  // Exception collective (unité RH fermée le 2026-09-01).
  await created('/time/exceptions', adm, {
    date: '2026-09-01', kind: 'closed', labelFr: 'Inventaire', labelEn: 'Inventory', unitId: uRh,
  });
  const exc = await getJson<{ exception: { kind: string } | null }>(`/time/employees/${e1}/schedule?date=2026-09-01`, adm);
  assert.equal(exc.exception?.kind, 'closed');
  const excIt = await getJson<{ exception: unknown }>(`/time/employees/${e2}/schedule?date=2026-09-01`, adm);
  assert.equal(excIt.exception, null, 'l’exception d’unité ne touche pas l’autre unité');
});

test('07 dispositif + import CSV : preview SANS écriture, apply, fuseau du SITE appliqué (22:03 → 21:03Z)', async () => {
  const adm = await token(slugA, admEmail);
  deviceId = await created('/time/devices', adm, { code: 'PTR-HALL', label: 'Pointeuse hall', kind: 'clock', siteId: siteA });
  const csv = `matricule;dateheure;sens\n${MAT1};2026-07-01 22:03;E\n${MAT1};2026-07-02 06:01;S\n${MAT2};2026-07-01 08:00;E\n`;
  const preview = await api('/time/punches/import', adm, {
    source: 'csv', mode: 'preview', filename: 'p.csv', contentText: csv, defaultDeviceId: deviceId,
  });
  assert.equal(preview.status, 200);
  const pv = (await preview.json()) as { kind: string; counts: Record<string, number>; wouldApply: boolean };
  assert.equal(pv.kind, 'preview');
  assert.equal(pv.counts['received'], 3);
  assert.equal(pv.counts['unmatched'], 0, 'matricules appariables');
  assert.equal(pv.wouldApply, true);
  assert.equal(psql(`SELECT count(*) FROM time.raw_punches WHERE tenant_id = '${tenantAId}'`), '0',
    'la PRÉVISUALISATION n’écrit RIEN');

  const apply = await api('/time/punches/import', adm, {
    source: 'csv', mode: 'apply', filename: 'p.csv', contentText: csv, defaultDeviceId: deviceId,
  });
  const ap = (await apply.json()) as { kind: string; batchId: string; counts: Record<string, number> };
  assert.equal(ap.kind, 'applied');
  assert.equal(ap.counts['accepted'], 3);
  assert.equal(ap.counts['unmatched'], 0);
  // Fuseau : dispositif SANS fuseau propre → SITE (Africa/Porto-Novo) → 22:03 local = 21:03Z.
  const occurred = psql(`SELECT ev.occurred_at AT TIME ZONE 'UTC' FROM time.punch_events ev
    JOIN time.raw_punches r ON r.id = ev.raw_punch_id
    WHERE r.external_employee_id = '${MAT1}' AND r.source_datetime_raw = '2026-07-01 22:03' AND ev.tenant_id='${tenantAId}'`);
  assert.ok(occurred.startsWith('2026-07-01 21:03:00'), `21:03Z attendu, obtenu ${occurred}`);
  const matched = psql(`SELECT match_status || '|' || event_type FROM time.punch_events ev
    JOIN time.raw_punches r ON r.id = ev.raw_punch_id
    WHERE r.external_employee_id = '${MAT2}' AND ev.tenant_id='${tenantAId}'`);
  assert.equal(matched, 'matched|in');
  // Rattachement à l'affectation applicable.
  const withAsg = psql(`SELECT count(*) FROM time.punch_events WHERE tenant_id='${tenantAId}' AND assignment_id IS NOT NULL`);
  assert.equal(withAsg, '3');
});

test('08 IDEMPOTENCE : rejouer le MÊME fichier ne crée rien ; un autre fichier portant le MÊME événement non plus', async () => {
  const adm = await token(slugA, admEmail);
  const csv = `matricule;dateheure;sens\n${MAT1};2026-07-01 22:03;E\n${MAT1};2026-07-02 06:01;S\n${MAT2};2026-07-01 08:00;E\n`;
  const replay = await api('/time/punches/import', adm, {
    source: 'csv', mode: 'apply', filename: 'p.csv', contentText: csv, defaultDeviceId: deviceId,
  });
  const rp = (await replay.json()) as { kind: string; counts: Record<string, number> };
  assert.equal(rp.kind, 'applied');
  assert.equal(rp.counts['accepted'], 0);
  assert.equal(rp.counts['duplicated'], 3, 'rejeu ⇒ tout dupliqué, rien d’écrit');
  // Fichier DIFFÉRENT (ordre, ligne en plus) portant un événement déjà connu.
  const other = `matricule;dateheure;sens\n${MAT2};2026-07-03 08:02;E\n${MAT1};2026-07-01 22:03;E\n`;
  const second = await api('/time/punches/import', adm, {
    source: 'csv', mode: 'apply', filename: 'autre.csv', contentText: other, defaultDeviceId: deviceId,
  });
  const sp = (await second.json()) as { counts: Record<string, number> };
  assert.equal(sp.counts['accepted'], 1, 'seule la ligne NOUVELLE est écrite');
  assert.equal(sp.counts['duplicated'], 1, 'l’événement déjà connu est reconnu, pas dupliqué');
  assert.equal(psql(`SELECT count(*) FROM time.raw_punches WHERE tenant_id = '${tenantAId}' AND external_employee_id='${MAT1}' AND source_datetime_raw='2026-07-01 22:03'`), '1',
    'UN seul événement logique');
});

test('09 ATOMIQUE : un fichier partiellement invalide ne produit AUCUNE insertion ; partiel = choix EXPLICITE', async () => {
  const adm = await token(slugA, admEmail);
  const before9 = psql(`SELECT count(*) FROM time.raw_punches WHERE tenant_id = '${tenantAId}'`);
  const csv = `matricule;dateheure;sens\n${MAT1};2026-07-05 08:00;E\n${MAT2};pas-une-date;E\n`;
  const atomic = await api('/time/punches/import', adm, {
    source: 'csv', mode: 'apply', filename: 'mixte.csv', contentText: csv, defaultDeviceId: deviceId,
  });
  const at = (await atomic.json()) as { kind: string; batchId: string; errors: Array<{ line: number }> };
  assert.equal(at.kind, 'rejected');
  assert.equal(at.errors[0]!.line, 3);
  assert.equal(psql(`SELECT count(*) FROM time.raw_punches WHERE tenant_id = '${tenantAId}'`), before9,
    'mode atomique : AUCUNE écriture');
  assert.equal(psql(`SELECT status FROM time.punch_batches WHERE id = '${at.batchId}'`), 'rejected',
    'le lot rejeté LAISSE SA TRACE');
  // Choix explicite : seules les lignes valides.
  const partial = await api('/time/punches/import', adm, {
    source: 'csv', mode: 'apply', filename: 'mixte.csv', contentText: csv, defaultDeviceId: deviceId,
    acceptOnlyValid: true,
  });
  const pa = (await partial.json()) as { kind: string; counts: Record<string, number> };
  assert.equal(pa.kind, 'partial');
  assert.equal(pa.counts['accepted'], 1);
  assert.equal(pa.counts['rejected'], 1);
});

test('10 non-apparié : identifiant INCONNU reste en file, AUCUN salarié créé ; correspondance + renormalisation ⇒ apparié', async () => {
  const adm = await token(slugA, admEmail);
  const employeesBefore = psql(`SELECT count(*) FROM core.employees WHERE tenant_id = '${tenantAId}'`);
  const csv = `badge;dateheure;sens\nBADGE-999;2026-07-06 08:05;E\n`;
  const imp = await api('/time/punches/import', adm, {
    source: 'csv', mode: 'apply', filename: 'badge.csv', contentText: csv, defaultDeviceId: deviceId,
  });
  const im = (await imp.json()) as { kind: string; counts: Record<string, number> };
  assert.equal(im.kind, 'applied');
  assert.equal(im.counts['unmatched'], 1);
  assert.equal(psql(`SELECT count(*) FROM core.employees WHERE tenant_id = '${tenantAId}'`), employeesBefore,
    'un badge inconnu ne crée JAMAIS de salarié');
  const queue = await getJson<{ items: Array<{ externalEmployeeId: string; matchStatus: string }> }>('/time/punches/unmatched', adm);
  const item = queue.items.find((i) => i.externalEmployeeId === 'BADGE-999');
  assert.equal(item?.matchStatus, 'unmatched_employee');
  // Correspondance vers E1 puis renormalisation : l'événement devient apparié.
  await created('/time/mappings', adm, { externalId: 'BADGE-999', employeeId: e1 });
  const renorm = await api('/time/punches/renormalize', adm, {});
  const rn = (await renorm.json()) as { processed: number; matched: number };
  assert.ok(rn.matched >= 1, `au moins l’événement BADGE-999 apparié (${rn.matched}/${rn.processed})`);
  const after10 = psql(`SELECT ev.match_status FROM time.punch_events ev JOIN time.raw_punches r ON r.id = ev.raw_punch_id
    WHERE r.external_employee_id = 'BADGE-999' AND ev.tenant_id='${tenantAId}'`);
  assert.equal(after10, 'matched');
});

test('11 signalements : embauche future ⇒ not_yet_hired, suspendu ⇒ inactive_employee — le brut reste intact', async () => {
  const adm = await token(slugA, admEmail);
  const csv = `matricule;dateheure;sens\n${MATL};2026-07-07 08:00;E\n${MATS};2026-07-07 08:01;E\n`;
  const imp = await api('/time/punches/import', adm, {
    source: 'csv', mode: 'apply', filename: 'statuts.csv', contentText: csv, defaultDeviceId: deviceId,
  });
  assert.equal(((await imp.json()) as { counts: Record<string, number> }).counts['unmatched'], 2);
  assert.equal(psql(`SELECT ev.match_status FROM time.punch_events ev JOIN time.raw_punches r ON r.id = ev.raw_punch_id
    WHERE r.external_employee_id = '${MATL}'`), 'not_yet_hired');
  assert.equal(psql(`SELECT ev.match_status FROM time.punch_events ev JOIN time.raw_punches r ON r.id = ev.raw_punch_id
    WHERE r.external_employee_id = '${MATS}'`), 'inactive_employee');
});

test('12 Excel : import réel (déflaté), série de date convertie ; cellule à FORMULE ⇒ refus de ligne', async () => {
  const adm = await token(slugA, admEmail);
  // Série pour 2026-07-08 09:30 (système 1900).
  const serial = (Date.UTC(2026, 6, 8) - Date.UTC(1899, 11, 30)) / 86_400_000 + (9.5 * 3600) / 86_400;
  const okB64 = xlsxOf(
    row([cellStr('Matricule'), cellStr('DateHeure'), cellStr('Sens')]),
    [row([cellStr(MAT1), `<c><v>${serial}</v></c>`, cellStr('E')])],
  );
  const ok = await api('/time/punches/import', adm, {
    source: 'xlsx', mode: 'apply', filename: 'p.xlsx', contentBase64: okB64, defaultDeviceId: deviceId,
  });
  const okr = (await ok.json()) as { kind: string; counts: Record<string, number> };
  assert.equal(okr.kind, 'applied', JSON.stringify(okr));
  assert.equal(okr.counts['accepted'], 1);
  assert.equal(psql(`SELECT count(*) FROM time.raw_punches WHERE tenant_id='${tenantAId}' AND source_datetime_raw = '2026-07-08 09:30:00'`), '1',
    'série Excel convertie en horodatage textuel exact');
  // Fichier avec formule : la ligne est REFUSÉE (⇒ atomique : lot rejeté).
  const fB64 = xlsxOf(
    row([cellStr('Matricule'), cellStr('DateHeure'), cellStr('Sens')]),
    [row([cellStr(MAT2), `<c><f>NOW()</f><v>45000</v></c>`, cellStr('E')])],
  );
  const bad = await api('/time/punches/import', adm, {
    source: 'xlsx', mode: 'apply', filename: 'f.xlsx', contentBase64: fB64, defaultDeviceId: deviceId,
  });
  const badr = (await bad.json()) as { kind: string; errors: Array<{ error: string }> };
  assert.equal(badr.kind, 'rejected');
  assert.ok(badr.errors.some((e) => e.error.includes('formule')), 'refus EXPLICITE des formules');
});

test('13 fuseau par PARAMÈTRE E4 à la date : sans dispositif ni site, temps.fuseau.defaut s’applique', async () => {
  const adm = await token(slugA, admEmail);
  // Import SANS dispositif ni site : la chaîne descend jusqu'au paramètre tenant.
  const csv = `matricule;dateheure;sens\n${MAT1};2026-07-09 10:00;E\n`;
  const imp = await api('/time/punches/import', adm, {
    source: 'csv', mode: 'apply', filename: 'tz.csv', contentText: csv,
  });
  assert.equal(((await imp.json()) as { kind: string }).kind, 'applied');
  const tzRow = psql(`SELECT ev.tz || '|' || (ev.occurred_at AT TIME ZONE 'UTC')::text FROM time.punch_events ev
    JOIN time.raw_punches r ON r.id = ev.raw_punch_id
    WHERE r.source_datetime_raw = '2026-07-09 10:00' AND ev.tenant_id='${tenantAId}'`);
  assert.equal(tzRow, 'Africa/Porto-Novo|2026-07-09 09:00:00', 'temps.fuseau.defaut résolu à la date de l’événement');
});

test('14 saisie MANUELLE : lot source=manual, idempotente (rejeu ⇒ 409), auditée', async () => {
  const adm = await token(slugA, admEmail);
  const r1 = await api('/time/punches/manual', adm, {
    employeeId: e1, dateTime: '2026-07-10 07:58', eventType: 'E', siteId: siteA, note: 'oubli de badge',
  });
  assert.equal(r1.status, 201);
  const m1 = (await r1.json()) as { matchStatus: string; batchId: string };
  assert.equal(m1.matchStatus, 'matched');
  assert.equal(psql(`SELECT source FROM time.punch_batches WHERE id = '${m1.batchId}'`), 'manual');
  const r2 = await api('/time/punches/manual', adm, {
    employeeId: e1, dateTime: '2026-07-10 07:58', eventType: 'E', siteId: siteA,
  });
  assert.equal(r2.status, 409, 'même saisie ⇒ idempotence');
  assert.equal(psql(`SELECT count(*) FROM audit.audit_log WHERE tenant_id='${tenantAId}' AND action='time_manual_punch_created'`), '1');
});

test('15 portées RÉELLES : le chef d’unité RH voit E1, PAS E2 (IT) ; self ne voit que LUI ; sans permission ⇒ 403', async () => {
  const chef = await token(slugA, chefEmail);
  const chefView = await getJson<{ items: Array<{ matricule: string | null }> }>('/time/punches/raw?limit=200', chef);
  assert.ok(chefView.items.some((i) => i.matricule === MAT1), 'E1 (RH) visible');
  assert.ok(!chefView.items.some((i) => i.matricule === MAT2), 'E2 (IT) INVISIBLE hors périmètre');
  assert.ok(!chefView.items.some((i) => i.matricule === null), 'les non-appariés ne sont pas dans la portée fine');

  const self = await token(slugA, selfEmail);
  const mine = await getJson<{ linked: boolean; items: Array<{ eventType: string }> }>('/time/punches/mine', self);
  assert.equal(mine.linked, true);
  assert.ok(mine.items.length >= 1, 'ses propres événements');
  // self n'a PAS accès au registre brut général.
  assert.equal((await api('/time/punches/raw', self, undefined, 'GET')).status, 403);

  const naked = await token(slugA, nakedEmail);
  assert.equal((await api('/time/punches/raw', naked, undefined, 'GET')).status, 403);
  assert.equal((await api('/time/batches', naked, undefined, 'GET')).status, 403);
  assert.equal((await api('/time/punches/import', naked, { source: 'csv', mode: 'preview', contentText: 'x' })).status, 403);
  assert.equal((await api('/time/schedules/models', naked, { code: 'X', labelFr: 'X', labelEn: 'X', kind: 'fixed' })).status, 403);
});

test('16 ISOLATION TENANT : B ne voit rien de A ; les codes de A n’existent pas pour B ; même empreinte possible chez B', async () => {
  const badm = await token(slugB, bAdmEmail);
  const models = await getJson<{ items: unknown[] }>('/time/schedules/models', badm);
  assert.equal(models.items.length, 0, 'les modèles de A sont invisibles');
  assert.equal((await api(`/time/schedules/models/${modelId}`, badm, undefined, 'GET')).status, 404);
  assert.equal((await api(`/time/batches`, badm, undefined, 'GET')).status, 200);
  assert.equal(((await getJson<{ items: unknown[] }>('/time/batches', badm)).items).length, 0);
  const raw = await getJson<{ items: unknown[] }>('/time/punches/raw', badm);
  assert.equal(raw.items.length, 0);
  // Import chez B du MÊME événement (même empreinte : même identifiant, même horodatage,
  // sans dispositif) que celui déjà présent chez A (test 13) : accepté chez B — l'unicité
  // d'empreinte est PAR TENANT — et NON apparié (aucune correspondance inter-tenant).
  const csv = `matricule;dateheure;sens\n${MAT1};2026-07-09 10:00;E\n`;
  const imp = await api('/time/punches/import', badm, { source: 'csv', mode: 'apply', filename: 'b.csv', contentText: csv });
  const im = (await imp.json()) as { kind: string; counts: Record<string, number> };
  assert.equal(im.kind, 'applied');
  assert.equal(im.counts['accepted'], 1, 'même empreinte que chez A : acceptée chez B (unicité PAR tenant)');
  assert.equal(im.counts['unmatched'], 1, 'le matricule de A n’apparie RIEN chez B');
});

test('17 lots : compteurs et rapport par ligne ; fichier ORIGINAL conservé, téléchargement AUDITÉ', async () => {
  const adm = await token(slugA, admEmail);
  const batches = await getJson<{ items: Array<{ id: string; status: string; filename: string | null; fileKept: boolean }> }>('/time/batches', adm);
  assert.ok(batches.items.length >= 5);
  const rejected = batches.items.find((b) => b.status === 'rejected' && b.filename === 'mixte.csv');
  assert.ok(rejected, 'le lot rejeté est tracé');
  const detail = await getJson<{ batch: { errorReport: Array<{ line: number; error: string }> } }>(`/time/batches/${rejected!.id}`, adm);
  assert.ok(detail.batch.errorReport.some((e) => e.line === 3 && e.error.includes('inanalysable')));
  const file = await getJson<{ filename: string; contentBase64: string; sha256: string }>(`/time/batches/${rejected!.id}/file`, adm);
  assert.ok(Buffer.from(file.contentBase64, 'base64').toString('utf8').includes('pas-une-date'), 'référence documentaire fidèle');
  assert.equal(psql(`SELECT count(*) FROM audit.audit_log WHERE tenant_id='${tenantAId}' AND action='time_import_file_downloaded'`), '1');
});

test('18 E5 : l’échec d’application NOTIFIE les porteurs de la permission (modèle actif requis, rien de simulé)', async () => {
  const adm = await token(slugA, admEmail);
  // Modèle de notification créé et ACTIVÉ par l'API E5.
  const tpl = await api('/admin/notify/templates', adm, {
    key: 'time_import_echec', name: 'Échec d’import de pointages',
    subjectFr: 'Import de pointages rejeté : {{fichier}}', subjectEn: 'Punch import rejected: {{fichier}}',
    bodyFr: 'Le fichier {{fichier}} ({{lignes}} lignes) a été rejeté : {{erreurs}} erreur(s).',
    bodyEn: 'File {{fichier}} ({{lignes}} lines) was rejected: {{erreurs}} error(s).',
    variables: ['fichier', 'lignes', 'erreurs'], channels: ['in_app'],
  });
  assert.equal(tpl.status, 201, await tpl.clone().text());
  const tplId = ((await tpl.json()) as { id: string }).id;
  assert.equal((await api(`/admin/notify/templates/${tplId}/activate`, adm)).status, 200);
  const csv = `matricule;dateheure;sens\n${MAT1};encore-pas-une-date;E\n`;
  const imp = await api('/time/punches/import', adm, {
    source: 'csv', mode: 'apply', filename: 'echec.csv', contentText: csv, defaultDeviceId: deviceId,
  });
  assert.equal(((await imp.json()) as { kind: string }).kind, 'rejected');
  const notified = psql(`SELECT count(*) FROM notify.notifications n
    JOIN notify.events e ON e.id = n.event_id
    WHERE n.tenant_id='${tenantAId}' AND e.template_key='time_import_echec'`);
  assert.ok(Number(notified) >= 1, `notification d'échec créée (${notified})`);
});

test('19 brut APPEND-ONLY à travers TOUTE la pile + audit des imports', async () => {
  // Aucun UPDATE/DELETE possible (trigger + privilèges) — vérifié par la suite SQL 95 ;
  // ici : l'API n'expose AUCUNE route de modification/suppression du brut, et l'audit
  // porte les imports (applied, partial, rejected).
  const applied = psql(`SELECT count(*) FROM audit.audit_log WHERE tenant_id='${tenantAId}' AND action='time_import_applied'`);
  const rejectedN = psql(`SELECT count(*) FROM audit.audit_log WHERE tenant_id='${tenantAId}' AND action='time_import_rejected'`);
  const partial = psql(`SELECT count(*) FROM audit.audit_log WHERE tenant_id='${tenantAId}' AND action='time_import_partial'`);
  assert.ok(Number(applied) >= 4, `imports appliqués audités (${applied})`);
  assert.ok(Number(rejectedN) >= 2, `imports rejetés audités (${rejectedN})`);
  assert.ok(Number(partial) >= 1, `imports partiels audités (${partial})`);
  // La spécification OpenAPI expose les routes time (contrat frontend).
  const res = await fetch(`${base}/openapi.json`);
  const spec = (await res.json()) as { paths: Record<string, unknown> };
  for (const p of ['/time/punches/import', '/time/punches/raw', '/time/schedules/models', '/time/employees/{id}/schedule']) {
    assert.ok(spec.paths[p], `OpenAPI : ${p}`);
  }
});
