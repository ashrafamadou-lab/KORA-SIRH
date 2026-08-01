import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canTransitionEmployeeStatus,
  careerEventForTransition,
  EMPLOYEE_STATUS_TRANSITIONS,
  type EmployeeStatus,
  HR_IMPORT_COLUMNS,
  mapHrImportRows,
  maskIdentifier,
  maskSensitiveFields,
  statusAtDate,
  validateHrImportRows,
} from './hr.ts';

// ---------- Cycle de vie ----------

test('cycle de vie : parcours nominal permis, raccourcis et retours interdits', () => {
  // Parcours nominal complet.
  for (const [from, to] of [
    ['draft', 'pre_hire'], ['pre_hire', 'active'], ['active', 'on_leave'],
    ['on_leave', 'active'], ['active', 'suspended'], ['suspended', 'active'],
    ['active', 'terminated'], ['terminated', 'archived'],
  ] as const) {
    assert.ok(canTransitionEmployeeStatus(from, to), `${from} → ${to} doit être permis`);
  }
  // Raccourcis et régressions interdits.
  for (const [from, to] of [
    ['draft', 'terminated'], ['draft', 'suspended'], ['pre_hire', 'on_leave'],
    ['active', 'draft'], ['active', 'pre_hire'], ['active', 'archived'],
    ['suspended', 'on_leave'], ['terminated', 'suspended'], ['on_leave', 'archived'],
  ] as const) {
    assert.ok(!canTransitionEmployeeStatus(from, to), `${from} → ${to} doit être refusé`);
  }
});

test('cycle de vie : réintégration permise, archived strictement terminal', () => {
  assert.ok(canTransitionEmployeeStatus('terminated', 'active'), 'réintégration terminated → active');
  const statuses = Object.keys(EMPLOYEE_STATUS_TRANSITIONS) as EmployeeStatus[];
  for (const to of statuses) {
    assert.ok(!canTransitionEmployeeStatus('archived', to), `archived → ${to} doit être refusé`);
  }
  // Aucune transition ne SUPPRIME : « terminated » reste un état consultable, jamais
  // une sortie du référentiel (la cessation ne détruit pas le dossier).
  assert.ok(statuses.includes('terminated'));
});

test('événement de carrière induit par la transition', () => {
  assert.equal(careerEventForTransition('draft', 'active'), 'hire');
  assert.equal(careerEventForTransition('pre_hire', 'active'), 'hire');
  assert.equal(careerEventForTransition('terminated', 'active'), 'reinstatement');
  assert.equal(careerEventForTransition('suspended', 'active'), 'return');
  assert.equal(careerEventForTransition('on_leave', 'active'), 'return');
  assert.equal(careerEventForTransition('active', 'suspended'), 'suspension');
  assert.equal(careerEventForTransition('active', 'terminated'), 'termination');
  assert.equal(careerEventForTransition('draft', 'pre_hire'), 'status_change');
  assert.equal(careerEventForTransition('active', 'on_leave'), 'status_change');
  assert.equal(careerEventForTransition('terminated', 'archived'), 'status_change');
});

// ---------- Masquage des identifiants ----------

test('maskIdentifier : trois derniers caractères seulement, vide ⇒ null', () => {
  assert.equal(maskIdentifier('1234567890'), '•••890');
  assert.equal(maskIdentifier('AB'), '•••AB');
  assert.equal(maskIdentifier(''), null);
  assert.equal(maskIdentifier(null), null);
  assert.equal(maskIdentifier(undefined), null);
  const masked = maskIdentifier('CNSS-0099887766');
  assert.ok(masked !== null && !masked.includes('0099887'), 'le corps du numéro disparaît');
});

test('maskSensitiveFields : identifiants et urgence masqués, champs métier intacts', () => {
  const out = maskSensitiveFields({
    matricule: 'HR-0001',
    status: 'active',
    cnss_number: 'CNSS-0099887766',
    tax_id: 'IFU-12345678',
    id_document_type: 'cni',
    id_document_number: 'CNI-987654321',
    iban: 'BJ0610100100144390000769',
    emergency_phone: '+2290197000001',
    personal_email: 'a.sossou@example.bj',
    effective_from: '2026-01-01',
    montant: 125000,
    note: null,
  });
  assert.equal(out['matricule'], 'HR-0001');
  assert.equal(out['status'], 'active');
  assert.equal(out['id_document_type'], 'cni', 'le TYPE de pièce reste lisible');
  assert.equal(out['effective_from'], '2026-01-01');
  assert.equal(out['montant'], 125000);
  assert.equal(out['note'], null);
  assert.equal(out['cnss_number'], '•••766');
  assert.equal(out['tax_id'], '•••678');
  assert.equal(out['id_document_number'], '•••321');
  assert.equal(out['iban'], '•••769');
  assert.equal(out['emergency_phone'], '•••001');
  assert.equal(out['personal_email'], '•••.bj');
  const s = JSON.stringify(out);
  for (const leaked of ['0099887', 'IFU-12345', 'CNI-98765', '014439', '9700000', 'a.sossou']) {
    assert.ok(!s.includes(leaked), `la valeur ${leaked}… ne doit pas fuiter`);
  }
});

test('maskSensitiveFields : valeur non textuelle sous clé sensible ⇒ rien ne filtre', () => {
  const out = maskSensitiveFields({ cnss_number: 99887766, emergency: { phone: '+229x' } });
  assert.equal(out['cnss_number'], '•••');
  assert.equal(out['emergency'], '•••');
});

// ---------- État à une date ----------

test('statusAtDate : dernier événement porteur de statut à la date, bornes incluses', () => {
  const events = [
    { effectiveDate: '2026-01-01', resultingStatus: 'active' as const },
    { effectiveDate: '2026-03-10', resultingStatus: null },            // transfert sans statut
    { effectiveDate: '2026-04-01', resultingStatus: 'on_leave' as const },
    { effectiveDate: '2026-06-01', resultingStatus: 'active' as const },
    { effectiveDate: '2026-09-30', resultingStatus: 'terminated' as const },
  ];
  assert.equal(statusAtDate(events, '2025-12-31'), null, 'avant l’embauche : aucun statut');
  assert.equal(statusAtDate(events, '2026-01-01'), 'active', 'date d’effet incluse');
  assert.equal(statusAtDate(events, '2026-03-15'), 'active', 'l’événement sans statut ne change rien');
  assert.equal(statusAtDate(events, '2026-04-01'), 'on_leave');
  assert.equal(statusAtDate(events, '2026-05-20'), 'on_leave');
  assert.equal(statusAtDate(events, '2026-07-14'), 'active');
  assert.equal(statusAtDate(events, '2026-12-31'), 'terminated', 'la cessation reste un état consultable');
  // Une mutation FUTURE ne réécrit pas la lecture passée.
  const withFuture = [...events, { effectiveDate: '2027-01-01', resultingStatus: 'active' as const }];
  assert.equal(statusAtDate(withFuture, '2026-12-31'), 'terminated');
});

// ---------- Import CSV ----------

const HEADER = [...HR_IMPORT_COLUMNS] as string[];
function row(values: Partial<Record<(typeof HR_IMPORT_COLUMNS)[number], string>>): string[] {
  return HR_IMPORT_COLUMNS.map((c) => values[c] ?? '');
}

test('import : en-tête incomplet refusé d’emblée', () => {
  const { rows, errors } = mapHrImportRows(['matricule', 'last_name'], [['M-1', 'X']]);
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 1);
  assert.ok(errors[0]!.error.includes('first_name'));
});

test('import : normalisation (majuscules, blancs), cellules vides ⇒ absentes', () => {
  const { rows, errors } = mapHrImportRows(HEADER, [
    row({ matricule: ' hr-0001 ', last_name: 'Sossou', first_name: 'Awa', company_code: 'co-a', unit_code: 'dir', nationality: 'bj' }),
  ]);
  assert.equal(errors.length, 0);
  const r = rows[0]!;
  assert.equal(r.line, 2, 'la ligne 1 est l’en-tête');
  assert.equal(r.matricule, 'HR-0001');
  assert.equal(r.companyCode, 'CO-A');
  assert.equal(r.unitCode, 'DIR');
  assert.equal(r.nationality, 'BJ');
  assert.equal(r.hireDate, undefined);
  assert.equal(r.cnssNumber, undefined);
});

test('import : lignes valides ⇒ aucune erreur', () => {
  const { rows } = mapHrImportRows(HEADER, [
    row({ matricule: 'HR-1', last_name: 'A', first_name: 'B', company_code: 'CO', unit_code: 'U1', hire_date: '2026-02-01', cnss_number: 'CNSS-1' }),
    row({ matricule: 'HR-2', last_name: 'C', first_name: 'D', company_code: 'CO', unit_code: 'U1', nationality: 'NE' }),
  ]);
  assert.deepEqual(validateHrImportRows(rows), []);
});

test('import : matricule invalide, noms manquants, dates et nationalité contrôlées', () => {
  const { rows } = mapHrImportRows(HEADER, [
    row({ matricule: 'hé-1', last_name: '', first_name: 'X', company_code: 'CO', unit_code: 'U1', hire_date: '01/02/2026', nationality: 'BEN' }),
    row({ matricule: 'HR-9', last_name: 'OK', first_name: 'OK', company_code: '', unit_code: 'U1' }),
  ]);
  const errors = validateHrImportRows(rows);
  const texts = errors.map((e) => `${e.line}:${e.error}`);
  assert.ok(texts.some((t) => t.startsWith('2:') && t.includes('matricule invalide')));
  assert.ok(texts.some((t) => t.startsWith('2:') && t.includes('last_name')));
  assert.ok(texts.some((t) => t.startsWith('2:') && t.includes('hire_date')));
  assert.ok(texts.some((t) => t.startsWith('2:') && t.includes('nationality')));
  assert.ok(texts.some((t) => t.startsWith('3:') && t.includes('company_code')));
});

test('import : doublons de matricule dans le fichier signalés avec la ligne d’origine', () => {
  const { rows } = mapHrImportRows(HEADER, [
    row({ matricule: 'HR-1', last_name: 'A', first_name: 'B', company_code: 'CO', unit_code: 'U1' }),
    row({ matricule: 'hr-1', last_name: 'C', first_name: 'D', company_code: 'CO', unit_code: 'U1' }),
  ]);
  const errors = validateHrImportRows(rows);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.line, 3);
  assert.ok(errors[0]!.error.includes('ligne 2'));
});

test('import : doublon CNSS signalé SANS jamais recopier le numéro', () => {
  const cnss = 'CNSS-SECRET-424242';
  const { rows } = mapHrImportRows(HEADER, [
    row({ matricule: 'HR-1', last_name: 'A', first_name: 'B', company_code: 'CO', unit_code: 'U1', cnss_number: cnss }),
    row({ matricule: 'HR-2', last_name: 'C', first_name: 'D', company_code: 'CO', unit_code: 'U1', cnss_number: cnss }),
  ]);
  const errors = validateHrImportRows(rows);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.line, 3);
  assert.ok(errors[0]!.error.includes('CNSS'));
  assert.ok(errors[0]!.error.includes('ligne 2'));
  assert.ok(!JSON.stringify(errors).includes('424242'), 'la valeur CNSS ne sort jamais dans le rapport');
});
