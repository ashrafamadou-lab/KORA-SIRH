/**
 * E10.1 — domaine temps : fuseaux (ok/ambigu/invalide), horodatages sources,
 * rotations, empreinte d'idempotence, correspondance de colonnes. Le Bénin n'a pas
 * d'heure d'été : les cas ambigus/invalides sont prouvés sur Europe/Paris — le code
 * est GÉNÉRIQUE, rien n'est supposé.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  excelSerialToDateTime,
  localToUtc,
  mapPunchRows,
  normalizeEventType,
  parseSourceDateAndTime,
  parseSourceDateTime,
  punchFingerprint,
  rotationDayIndex,
  tzOffsetMinutes,
} from './time.ts';

// ---------------------------------------------------------------------------
// Fuseaux
// ---------------------------------------------------------------------------

test('Africa/Porto-Novo : +01:00 toute l’année, conversion exacte', () => {
  assert.equal(tzOffsetMinutes('Africa/Porto-Novo', Date.UTC(2026, 0, 15)), 60);
  assert.equal(tzOffsetMinutes('Africa/Porto-Novo', Date.UTC(2026, 6, 15)), 60);
  const r = localToUtc({ y: 2026, mo: 7, d: 1 }, { h: 22, mi: 3 }, 'Africa/Porto-Novo');
  assert.equal(r.status, 'ok');
  assert.equal(new Date(r.utcMs!).toISOString(), '2026-07-01T21:03:00.000Z');
});

test('heure INEXISTANTE (trou du passage à l’heure d’été) : statut invalid, aucun instant', () => {
  // Europe/Paris, 29 mars 2026 : 02:00 → 03:00 ; 02:30 n'existe pas.
  const r = localToUtc({ y: 2026, mo: 3, d: 29 }, { h: 2, mi: 30 }, 'Europe/Paris');
  assert.equal(r.status, 'invalid');
  assert.equal(r.utcMs, null);
  assert.deepEqual(r.candidates, []);
});

test('heure AMBIGUË (repli d’automne) : deux instants candidats, le premier retenu', () => {
  // Europe/Paris, 25 octobre 2026 : 03:00 → 02:00 ; 02:30 existe DEUX fois.
  const r = localToUtc({ y: 2026, mo: 10, d: 25 }, { h: 2, mi: 30 }, 'Europe/Paris');
  assert.equal(r.status, 'ambiguous');
  assert.equal(r.candidates.length, 2);
  assert.equal(new Date(r.candidates[0]!).toISOString(), '2026-10-25T00:30:00.000Z'); // été (+02)
  assert.equal(new Date(r.candidates[1]!).toISOString(), '2026-10-25T01:30:00.000Z'); // hiver (+01)
  assert.equal(r.utcMs, r.candidates[0]);
});

test('UTC : identité', () => {
  const r = localToUtc({ y: 2026, mo: 1, d: 1 }, { h: 0, mi: 0 }, 'UTC');
  assert.equal(r.status, 'ok');
  assert.equal(new Date(r.utcMs!).toISOString(), '2026-01-01T00:00:00.000Z');
});

// ---------------------------------------------------------------------------
// Horodatages sources
// ---------------------------------------------------------------------------

test('horodatages : ISO et JJ/MM/AAAA acceptés, formes canoniques stables', () => {
  assert.equal(parseSourceDateTime('2026-07-01 22:03')!.canonical, '2026-07-01T22:03:00');
  assert.equal(parseSourceDateTime('2026-07-01T05:07:09')!.canonical, '2026-07-01T05:07:09');
  assert.equal(parseSourceDateTime('01/07/2026 22:03:15')!.canonical, '2026-07-01T22:03:15');
  assert.equal(parseSourceDateAndTime('2026-07-01', '8:05')!.canonical, '2026-07-01T08:05:00');
  assert.equal(parseSourceDateAndTime('1/7/2026', '22:03')!.canonical, '2026-07-01T22:03:00');
});

test('horodatages : les dates inexistantes et le texte inerte sont REFUSÉS, jamais devinés', () => {
  assert.equal(parseSourceDateTime('2026-02-30 10:00'), null);
  assert.equal(parseSourceDateTime('31/02/2026 08:00'), null);
  assert.equal(parseSourceDateTime('2026-07-01 24:00'), null);
  assert.equal(parseSourceDateTime('demain 08:00'), null);
  assert.equal(parseSourceDateTime('=1+1'), null); // une formule n'est QUE du texte, donc invalide ici
  assert.equal(parseSourceDateAndTime('2026-07-01', '8h05'), null);
});

test('série Excel → date-heure (système 1900), bornes plausibles', () => {
  const serial = (Date.UTC(2026, 6, 1) - Date.UTC(1899, 11, 30)) / 86_400_000 + ((22 * 60 + 3) * 60) / 86_400;
  assert.equal(excelSerialToDateTime(serial)!.canonical, '2026-07-01T22:03:00');
  assert.equal(excelSerialToDateTime(0), null);
  assert.equal(excelSerialToDateTime(-5), null);
  assert.equal(excelSerialToDateTime(999_999), null);
});

// ---------------------------------------------------------------------------
// Rotations
// ---------------------------------------------------------------------------

test('jour de cycle : ancre = jour 0, modulo positif même AVANT l’ancre', () => {
  assert.equal(rotationDayIndex('2026-01-05', '2026-01-05', 4), 0);
  assert.equal(rotationDayIndex('2026-01-08', '2026-01-05', 4), 3);
  assert.equal(rotationDayIndex('2026-01-09', '2026-01-05', 4), 0);
  assert.equal(rotationDayIndex('2026-01-04', '2026-01-05', 4), 3);
  assert.equal(rotationDayIndex('2025-12-31', '2026-01-05', 4), 3);
  assert.equal(rotationDayIndex('2026-03-01', '2026-01-05', 1), 0);
});

// ---------------------------------------------------------------------------
// Empreinte
// ---------------------------------------------------------------------------

test('empreinte : stable pour le même événement, indifférente à la casse du type', () => {
  const a = punchFingerprint({ externalEmployeeId: 'BADGE-77', dateTimeCanonical: '2026-07-01T22:03:00', deviceCode: 'PTR-1', eventTypeRaw: 'e' });
  const b = punchFingerprint({ externalEmployeeId: 'BADGE-77', dateTimeCanonical: '2026-07-01T22:03:00', deviceCode: 'PTR-1', eventTypeRaw: 'E' });
  const c = punchFingerprint({ externalEmployeeId: 'BADGE-77', dateTimeCanonical: '2026-07-01T22:03:01', deviceCode: 'PTR-1', eventTypeRaw: 'E' });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('types d’événements : synonymes FR/EN, l’inconnu RESTE inconnu', () => {
  assert.equal(normalizeEventType('E'), 'in');
  assert.equal(normalizeEventType('Entrée'), 'in');
  assert.equal(normalizeEventType('SORTIE'), 'out');
  assert.equal(normalizeEventType('out'), 'out');
  assert.equal(normalizeEventType('break'), 'break_start');
  assert.equal(normalizeEventType('reprise'), 'break_end');
  assert.equal(normalizeEventType(''), 'unknown');
  assert.equal(normalizeEventType('XZ'), 'unknown');
  assert.equal(normalizeEventType(null), 'unknown');
});

// ---------------------------------------------------------------------------
// Correspondance de colonnes
// ---------------------------------------------------------------------------

test('colonnes FR auto-détectées : Matricule;Date;Heure;Sens', () => {
  const r = mapPunchRows(
    ['Matricule', 'Date', 'Heure', 'Sens'],
    [['B-1', '2026-07-01', '08:00', 'E'], ['B-2', '01/07/2026', '17:30:10', 'S']],
  );
  assert.deepEqual(r.errors, []);
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0]!.externalEmployeeId, 'B-1');
  assert.equal(r.rows[0]!.parsed!.canonical, '2026-07-01T08:00:00');
  assert.equal(r.rows[1]!.parsed!.canonical, '2026-07-01T17:30:10');
  assert.equal(r.rows[1]!.eventTypeRaw, 'S');
});

test('colonne inconnue SANS correspondance explicite : erreur — jamais d’interprétation', () => {
  const r = mapPunchRows(['Matricule', 'DateHeure', 'Salaire'], [['B-1', '2026-07-01 08:00', '999']]);
  assert.ok(r.errors.some((e) => e.error.includes('Salaire')));
  assert.equal(r.rows.length, 0);
});

test('correspondance explicite : renommage et ignore', () => {
  const r = mapPunchRows(
    ['ID Pointeuse', 'Quand', 'Commentaire'],
    [['77', '2026-07-01 22:03', 'rien']],
    { 'ID Pointeuse': 'external_id', 'Quand': 'datetime', 'Commentaire': 'ignore' },
  );
  assert.deepEqual(r.errors, []);
  assert.equal(r.rows[0]!.externalEmployeeId, '77');
  assert.equal(r.rows[0]!.sourceDateTimeRaw, '2026-07-01 22:03');
});

test('erreurs PAR LIGNE : identifiant vide, horodatage inanalysable (texte inerte compris)', () => {
  const r = mapPunchRows(
    ['Matricule', 'DateHeure'],
    [['', '2026-07-01 08:00'], ['B-2', '=SOMME(A1:A9)'], ['B-3', '2026-07-01 08:00']],
  );
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0]!.externalEmployeeId, 'B-3');
  assert.equal(r.errors.length, 2);
  assert.ok(r.errors[0]!.error.includes('identifiant'));
  assert.ok(r.errors[1]!.error.includes('inanalysable'));
});

test('en-tête sans identifiant ou sans horodatage : refus global', () => {
  assert.ok(mapPunchRows(['Date', 'Heure'], []).errors.some((e) => e.error.includes('identifiant')));
  assert.ok(mapPunchRows(['Matricule'], []).errors.some((e) => e.error.includes('datetime')));
  // Double attribution du même rôle : refusée.
  assert.ok(mapPunchRows(['Matricule', 'Badge', 'DateHeure'], []).errors.some((e) => e.error.includes('déjà attribué')));
});
