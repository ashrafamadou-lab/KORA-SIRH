-- Seed de développement — exécuté par kora_migrator (jamais en production telle quelle).
-- Contenu : catalogue de permissions (extrait), 2 tenants DEMO, les 16 rôles seed du
-- Blueprint (§6) pour le tenant de démo industriel, et les paramètres Bénin du registre
-- juridique v2 : TOUS en statut « draft » (inactifs) tant que le contreseing du conseil
-- n'est pas enregistré — règle D8, verdict d'audit « à recadrer avant validation ».

BEGIN;

-- ---------- Catalogue de permissions (extrait fondateur ; complété par module) ----------
INSERT INTO admin.permissions (key, description) VALUES
  ('employees.view',   'Consulter les dossiers salariés de sa portée'),
  ('employees.create', 'Créer un dossier salarié'),
  ('employees.edit',   'Modifier un dossier salarié'),
  ('salaries.view',    'Consulter les salaires (journalisé en lecture)'),
  ('salaries.edit',    'Modifier un salaire (workflow obligatoire)'),
  ('parameters.view',  'Consulter le Config Center'),
  ('parameters.manage','Gérer les paramètres légaux (source obligatoire)'),
  ('audit.view',       'Consulter l''audit trail de sa portée'),
  ('audit.export',     'Exporter l''audit trail (scellé, journalisé)')
ON CONFLICT (key) DO NOTHING;

-- ---------- Tenants de démonstration (purgeables, marqués DEMO) ----------
INSERT INTO admin.tenants (id, slug, name, country_code, is_demo) VALUES
  ('11111111-1111-4111-8111-111111111111', 'demo-industrie', 'Demo Industrie SA (DEMO DATA)', 'BJ', true),
  ('22222222-2222-4222-8222-222222222222', 'demo-services',  'Demo Services SARL (DEMO DATA)', 'BJ', true)
ON CONFLICT (slug) DO NOTHING;

-- ---------- Les 16 rôles seed (Blueprint §6) — tenant demo-industrie ----------
INSERT INTO admin.roles (tenant_id, key, name, is_system)
SELECT '11111111-1111-4111-8111-111111111111', r.key, r.name, true
FROM (VALUES
  ('super_admin',    'Super Admin'),
  ('system_admin',   'System Admin'),
  ('hr_director',    'HR Director'),
  ('hr_manager',     'HR Manager'),
  ('hr_officer',     'HR Officer'),
  ('hr_assistant',   'HR Assistant'),
  ('payroll_officer','Payroll Officer'),
  ('recruiter',      'Recruiter'),
  ('training_officer','Training Officer'),
  ('hse_officer',    'HSE Officer'),
  ('finance',        'Finance'),
  ('manager',        'Manager'),
  ('employee',       'Employee'),
  ('auditor',        'Auditor'),
  ('expat_admin',    'Expat Admin'),
  ('dpo',            'DPO')
) AS r(key, name)
ON CONFLICT (tenant_id, key) DO NOTHING;

-- ---------- Paramètres Bénin pré-validés par l'audit (registre v2) — statut DRAFT ----------
-- Ils deviendront « active » un par un via le Config Center, quand « Validé par » sera
-- renseigné avec le contreseing du conseil (colonne legal_ref = réf du registre).
INSERT INTO compliance.legal_parameters
  (country_code, key, value, unit, effective_from, source_text, confidence, status, legal_ref, notes)
VALUES
  ('BJ', 'temps.duree_hebdo',                  '40',      'heures/semaine',      '2026-01-01', 'Code du travail, art. 142 (à contresigner)', 'high', 'draft', 'TRV-02', 'Pré-validé audit 01/08/2026'),
  ('BJ', 'temps.repos_hebdo',                  '24',      'heures consécutives', '2026-01-01', 'Code du travail, art. 156 (à contresigner)', 'high', 'draft', 'TRV-05', 'En principe le dimanche'),
  ('BJ', 'conges.annuel.taux',                 '2',       'jours ouvrables/mois','2026-01-01', 'Code du travail, art. 158 (à contresigner)', 'high', 'draft', 'TRV-06', 'Pré-validé audit'),
  ('BJ', 'conges.maternite.duree',             '14',      'semaines',            '2026-01-01', 'Code du travail, art. 170 (à contresigner)', 'high', 'draft', 'TRV-07', '6 avant + 8 après'),
  ('BJ', 'conges.evenements.plafond_annuel',   '10',      'jours/an',            '2026-01-01', 'Code du travail, art. 159 (à contresigner)', 'high', 'draft', 'TRV-08', 'Permissions exceptionnelles'),
  ('BJ', 'paie.hs_plafond_annuel',             '240',     'heures/an',           '2026-01-01', 'Code du travail, art. 145 et 147 (à contresigner)', 'high', 'draft', 'TRV-03', 'Majorations à sourcer'),
  ('BJ', 'paie.smig',                          '52000',   'FCFA/mois',           '2023-01-01', 'Décret n° 2022-692 du 07/12/2022 ; DCC 25-161 (à contresigner)', 'high', 'draft', 'TRV-15', 'Pré-validé audit'),
  ('BJ', 'cnss.taux.pf.employeur',             '9',       '%',                   '2026-01-01', 'CNSS — procédure de recouvrement (à contresigner)', 'high', 'draft', 'CNS-02', 'Prestations familiales'),
  ('BJ', 'cnss.taux.rp.employeur',             '{"min": 1, "max": 4}', '% selon activité', '2026-01-01', 'CNSS — risques professionnels (à contresigner)', 'high', 'draft', 'CNS-03', 'Classe de risque par entreprise'),
  ('BJ', 'cnss.taux.pension.employeur',        '6.4',     '%',                   '2026-01-01', 'CNSS — procédure de recouvrement (à contresigner)', 'high', 'draft', 'CNS-02', ''),
  ('BJ', 'cnss.taux.pension.salarie',          '3.6',     '%',                   '2026-01-01', 'CNSS — procédure de recouvrement (à contresigner)', 'high', 'draft', 'CNS-02', ''),
  ('BJ', 'cnss.declaration.seuil_mensuel',     '20',      'salariés',            '2026-01-01', 'CNSS — déclaration et paiement (à contresigner)', 'high', 'draft', 'CNS-07', 'Mensuel ≥ 20, trimestriel < 20'),
  ('BJ', 'cnss.paiement.delai',                '15',      'jours',               '2026-01-01', 'CNSS — déclaration et paiement (à contresigner)', 'high', 'draft', 'CNS-08', ''),
  ('BJ', 'cnss.penalite.retard',               '1.5',     '%/mois ou fraction',  '2026-01-01', 'CNSS — déclaration et paiement (à contresigner)', 'high', 'draft', 'CNS-08', ''),
  ('BJ', 'hse.atmp.delai_declaration_employeur','48',     'heures',              '2026-01-01', 'CNSS — risques professionnels (à contresigner)', 'high', 'draft', 'CNS-09', 'Victime : 24 h'),
  ('BJ', 'conformite.reglement_interieur.seuil','15',     'salariés',            '2026-01-01', 'Code du travail, art. 137-140 (à contresigner)', 'high', 'draft', 'TRV-16', ''),
  ('BJ', 'conformite.irp.seuil_delegues',      '11',      'salariés',            '2026-01-01', 'Code du travail, art. 93-121 (à contresigner)', 'high', 'draft', 'TRV-18', ''),
  ('BJ', 'hse.service_autonome.seuil',         '100',     'travailleurs',        '2026-01-01', 'Code du travail, art. 194 (à contresigner)', 'high', 'draft', 'TRV-19', 'Établissements industriels')
ON CONFLICT DO NOTHING;

COMMIT;
