import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canTransitionOrgStatus,
  mapOrgImportRows,
  parseCsv,
  validateOrgImportRows,
  type OrgImportRow,
} from './org.ts';

// ---------- Statuts ----------

test('statuts : draft→active⇄inactive→archived, archived terminal', () => {
  assert.ok(canTransitionOrgStatus('draft', 'active'));
  assert.ok(canTransitionOrgStatus('active', 'inactive'));
  assert.ok(canTransitionOrgStatus('inactive', 'active'));
  assert.ok(canTransitionOrgStatus('inactive', 'archived'));
  assert.ok(canTransitionOrgStatus('draft', 'archived'));
  assert.ok(!canTransitionOrgStatus('archived', 'active'), 'archived est terminal');
  assert.ok(!canTransitionOrgStatus('draft', 'inactive'));
});

// ---------- Parseur CSV ----------

test('csv : délimiteur ; détecté, guillemets échappés, CRLF, BOM toléré', () => {
  const r = parseCsv('﻿kind;code;label_fr\r\nunit;DIR-A;"Direction ""Générale"";\nsuite"\r\n');
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.delimiter, ';');
    assert.deepEqual(r.header, ['kind', 'code', 'label_fr']);
    assert.deepEqual(r.rows, [['unit', 'DIR-A', 'Direction "Générale";\nsuite']]);
  }
});

test('csv : délimiteur virgule, lignes vides ignorées', () => {
  const r = parseCsv('a,b\n1,2\n\n3,4\n');
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.rows, [['1', '2'], ['3', '4']]);
});

test('csv : guillemet non refermé et colonnes incohérentes refusés', () => {
  assert.equal(parseCsv('a;b\n"ouvert;2\n').ok, false);
  const bad = parseCsv('a;b\n1;2;3\n');
  assert.equal(bad.ok, false);
});

// ---------- Import : mapping et validation ----------

const HEADER = ['kind', 'code', 'label_fr', 'label_en', 'unit_type', 'parent_code', 'unit_code',
  'company_code', 'site_code', 'job_code', 'cost_center_code', 'manager_position_code', 'effective_from'];

function rowsOf(...recs: string[][]): OrgImportRow[] {
  const { rows, errors } = mapOrgImportRows(HEADER, recs);
  assert.deepEqual(errors, []);
  return rows;
}

test('mapping : en-tête libre, casse ignorée, colonne obligatoire absente signalée', () => {
  const bad = mapOrgImportRows(['kind', 'code', 'label_fr'], [['unit', 'X', 'x']]);
  assert.equal(bad.rows.length, 0);
  assert.ok(bad.errors[0]!.error.includes('label_en'));
  const kindErr = mapOrgImportRows(HEADER, [['galaxie', 'X', 'x', 'x', '', '', '', '', '', '', '', '', '']]);
  assert.ok(kindErr.errors[0]!.error.includes('kind inconnu'));
});

test('validation : fichier cohérent accepté, références externes remontées', () => {
  const v = validateOrgImportRows(rowsOf(
    ['company', 'CO-A', 'Société', 'Company', '', '', '', '', '', '', '', '', ''],
    ['unit', 'DIR', 'Direction', 'Directorate', 'direction', '', '', 'CO-A', '', '', '', '', ''],
    ['unit', 'FIN', 'Finance', 'Finance', 'department', 'DIR', '', '', '', '', '', '', '2026-01-01'],
    ['unit', 'EXT', 'Externe', 'External', 'team', 'HORS-FICHIER', '', '', '', '', '', '', ''],
  ));
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.externalRefs, [{ line: 5, refKind: 'unit', code: 'HORS-FICHIER' }]);
});

test('validation : code invalide, libellés manquants, doublon, date invalide', () => {
  const v = validateOrgImportRows(rowsOf(
    ['unit', '-BAD', 'X', 'X', 'team', '', '', '', '', '', '', '', ''],
    ['job', 'JOB-1', '', 'Y', '', '', '', '', '', '', '', '', ''],
    ['job', 'JOB-2', 'Z', 'Z', '', '', '', '', '', '', '', '', '31/12/2026'],
    ['company', 'CO-A', 'A', 'A', '', '', '', '', '', '', '', '', ''],
    ['company', 'CO-A', 'B', 'B', '', '', '', '', '', '', '', '', ''],
  ));
  const msgs = v.errors.map((e) => e.error).join(' | ');
  assert.ok(msgs.includes('code invalide'));
  assert.ok(msgs.includes('label_fr requis'));
  assert.ok(msgs.includes('effective_from invalide'));
  assert.ok(msgs.includes('doublon'));
});

test('validation : cycle d’unités déclaré par le fichier détecté', () => {
  const v = validateOrgImportRows(rowsOf(
    ['unit', 'A1', 'A', 'A', 'direction', 'C1', '', '', '', '', '', '', ''],
    ['unit', 'B1', 'B', 'B', 'department', 'A1', '', '', '', '', '', '', ''],
    ['unit', 'C1', 'C', 'C', 'service', 'B1', '', '', '', '', '', '', ''],
  ));
  assert.ok(v.errors.some((e) => e.error.includes('cycle dans la hiérarchie')));
});

test('validation : cycle managérial du fichier détecté ; auto-références refusées', () => {
  const v = validateOrgImportRows(rowsOf(
    ['unit', 'U1', 'U', 'U', 'team', '', '', '', '', '', '', '', ''],
    ['company', 'CO', 'C', 'C', '', '', '', '', '', '', '', '', ''],
    ['job', 'J1', 'J', 'J', '', '', '', '', '', '', '', '', ''],
    ['position', 'P1', 'P1', 'P1', '', '', 'U1', 'CO', '', 'J1', '', 'P2', ''],
    ['position', 'P2', 'P2', 'P2', '', '', 'U1', 'CO', '', 'J1', '', 'P1', ''],
    ['position', 'P3', 'P3', 'P3', '', '', 'U1', 'CO', '', 'J1', '', 'P3', ''],
    ['unit', 'SELF', 'S', 'S', 'team', 'SELF', '', '', '', '', '', '', ''],
  ));
  const msgs = v.errors.map((e) => e.error).join(' | ');
  assert.ok(msgs.includes('cycle dans la ligne managériale'));
  assert.ok(msgs.includes('propre manager'));
  assert.ok(msgs.includes('propre parent'));
});

test('validation : position sans unité/société/emploi refusée ; site sans société refusé', () => {
  const v = validateOrgImportRows(rowsOf(
    ['position', 'P1', 'P', 'P', '', '', '', '', '', '', '', '', ''],
    ['site', 'S1', 'S', 'S', '', '', '', '', '', '', '', '', ''],
  ));
  const msgs = v.errors.map((e) => e.error).join(' | ');
  assert.ok(msgs.includes('unit_code requis'));
  assert.ok(msgs.includes('company_code requis'));
  assert.ok(msgs.includes('job_code requis'));
});
