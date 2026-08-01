-- 0015 — Core HR : dossier salarié (E9)
-- Réf : Blueprint §12/§13, PRD US-E9. Principes portés ICI :
--  - MINIMISATION et zonage des données : le dossier est découpé en trois zones à
--    permissions distinctes — professionnelle (core.employees), personnelle
--    (core.employee_private : naissance, nationalité, sexe, coordonnées, adresse,
--    urgence) et administrative (core.employee_identifiers : CNSS, fiscal, pièce
--    d'identité). Chaque champ sensible a une finalité déclarée en commentaire ;
--  - cycle de vie contrôlé : draft → pre_hire → active ⇄ (suspended | on_leave)
--    → terminated → archived, avec RÉINTÉGRATION possible (terminated → active) ;
--    une cessation ne supprime rien et ne réécrit rien ;
--  - affectations organisationnelles DATÉES vers l'organisation E8 (FK composites :
--    l'inter-tenant est rejeté par PostgreSQL) ; UNE SEULE affectation PRINCIPALE
--    applicable à une date (contrainte d'exclusion partielle) ; close-only ;
--  - historique de carrière APPEND-ONLY : chaque événement est un fait daté, jamais
--    écrasé ; l'état et l'affectation se consultent à une date donnée ;
--  - documents : MÉTADONNÉES uniquement (le stockage binaire est un module ultérieur —
--    NOT IMPLEMENTED) ; jamais exposés dans les réponses ordinaires.

-- ---------- Cycle de vie : migration des anciens statuts ----------
ALTER TABLE core.employees DROP CONSTRAINT employees_status_check;
UPDATE core.employees SET status = CASE status
  WHEN 'probation'  THEN 'pre_hire'
  WHEN 'long_leave' THEN 'on_leave'
  WHEN 'exited'     THEN 'terminated'
  ELSE status END
WHERE status IN ('probation', 'long_leave', 'exited');
ALTER TABLE core.employees ADD CONSTRAINT employees_status_check
  CHECK (status IN ('draft', 'pre_hire', 'active', 'suspended', 'on_leave', 'terminated', 'archived'));

CREATE FUNCTION core.guard_employee_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.matricule <> OLD.matricule THEN
    RAISE EXCEPTION 'le matricule est immuable' USING ERRCODE = 'raise_exception';
  END IF;
  IF NEW.status <> OLD.status THEN
    IF NOT (
      (OLD.status = 'draft'      AND NEW.status IN ('pre_hire', 'active', 'archived')) OR
      (OLD.status = 'pre_hire'   AND NEW.status IN ('active', 'archived')) OR
      (OLD.status = 'active'     AND NEW.status IN ('suspended', 'on_leave', 'terminated')) OR
      (OLD.status = 'suspended'  AND NEW.status IN ('active', 'terminated')) OR
      (OLD.status = 'on_leave'   AND NEW.status IN ('active', 'terminated')) OR
      (OLD.status = 'terminated' AND NEW.status IN ('active', 'archived'))   -- réintégration auditée
    ) THEN
      RAISE EXCEPTION 'transition de statut salarié interdite : % -> %', OLD.status, NEW.status
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_employees_guard BEFORE UPDATE ON core.employees
  FOR EACH ROW EXECUTE FUNCTION core.guard_employee_update();

-- ---------- Zone PROFESSIONNELLE : extension du dossier ----------
ALTER TABLE core.employees
  ADD COLUMN usage_first_name text,        -- identité d'usage (facultative)
  ADD COLUMN usage_last_name  text,
  ADD COLUMN hire_date        date,        -- date d'entrée
  ADD COLUMN professional_status text CHECK (professional_status IS NULL OR char_length(professional_status) <= 100),
  ADD COLUMN employer_company_id uuid,     -- société employeur (E8 = source de vérité)
  ADD COLUMN main_site_id     uuid,        -- site principal
  ADD COLUMN work_email       citext,
  ADD COLUMN work_phone       text CHECK (work_phone IS NULL OR char_length(work_phone) <= 30),
  ADD COLUMN photo_ref        text,        -- référence de photo (facultative) — jamais le binaire
  ADD CONSTRAINT employees_company_fk FOREIGN KEY (tenant_id, employer_company_id) REFERENCES org.companies (tenant_id, id),
  ADD CONSTRAINT employees_site_fk    FOREIGN KEY (tenant_id, main_site_id)        REFERENCES org.sites (tenant_id, id);

-- ---------- Zone PERSONNELLE (permission employees.view_private, lectures AUDITÉES) ----------
-- Finalités : naissance/nationalité = obligations déclaratives CNSS et fiscales (CNS-07,
-- registre v2) ; sexe = UNIQUEMENT déclarations sociales légales (jamais décisionnel —
-- Blueprint IA/équité) ; coordonnées/adresse = gestion administrative ; urgence = sécurité.
CREATE TABLE core.employee_private (
  employee_id        uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL,
  birth_date         date CHECK (birth_date IS NULL OR birth_date < now()::date),
  birth_place        text CHECK (birth_place IS NULL OR char_length(birth_place) <= 200),
  nationality        char(2),                        -- ISO 3166-1 alpha-2
  sex                text CHECK (sex IS NULL OR sex IN ('f', 'm')),
  personal_email     citext,
  personal_phone     text CHECK (personal_phone IS NULL OR char_length(personal_phone) <= 30),
  address_line       text CHECK (address_line IS NULL OR char_length(address_line) <= 300),
  address_city       text,
  address_country    char(2) DEFAULT 'BJ',
  emergency_name     text CHECK (emergency_name IS NULL OR char_length(emergency_name) <= 200),
  emergency_relation text CHECK (emergency_relation IS NULL OR char_length(emergency_relation) <= 100),
  emergency_phone    text CHECK (emergency_phone IS NULL OR char_length(emergency_phone) <= 30),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, employee_id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES core.employees (tenant_id, id)
);
CREATE TRIGGER trg_employee_private_touch BEFORE UPDATE ON core.employee_private
  FOR EACH ROW EXECUTE FUNCTION admin.touch_updated_at();

-- ---------- Zone ADMINISTRATIVE (permission employees.view_identifiers, lectures AUDITÉES) ----------
-- Finalités : CNSS = immatriculation et déclarations (CNS-02/07) ; IFU = obligations
-- fiscales ; pièce d'identité = vérification légale d'identité à l'embauche.
CREATE TABLE core.employee_identifiers (
  employee_id        uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL,
  cnss_number        text,        -- format contrôlé par paramètre (CNS-06), jamais en dur
  tax_id             text,        -- IFU
  id_document_type   text CHECK (id_document_type IS NULL OR id_document_type IN ('cni', 'passeport', 'cip', 'autre')),
  id_document_number text,
  id_document_expiry date,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, employee_id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES core.employees (tenant_id, id)
);
CREATE UNIQUE INDEX employee_identifiers_cnss_unique
  ON core.employee_identifiers (tenant_id, cnss_number) WHERE cnss_number IS NOT NULL;
CREATE TRIGGER trg_employee_identifiers_touch BEFORE UPDATE ON core.employee_identifiers
  FOR EACH ROW EXECUTE FUNCTION admin.touch_updated_at();

-- Migration des données existantes vers les zones, puis retrait des colonnes legacy.
INSERT INTO core.employee_private (employee_id, tenant_id, birth_date)
SELECT id, tenant_id, birth_date FROM core.employees WHERE birth_date IS NOT NULL;
INSERT INTO core.employee_identifiers (employee_id, tenant_id, cnss_number)
SELECT id, tenant_id, cnss_number FROM core.employees WHERE cnss_number IS NOT NULL
ON CONFLICT (employee_id) DO UPDATE SET cnss_number = EXCLUDED.cnss_number;
DROP INDEX core.employees_cnss_unique;
ALTER TABLE core.employees DROP COLUMN birth_date, DROP COLUMN cnss_number;

-- ---------- Documents : MÉTADONNÉES uniquement ----------
CREATE TABLE core.employee_documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  employee_id uuid NOT NULL,
  doc_type    text NOT NULL CHECK (doc_type IN ('contrat', 'avenant', 'piece_identite', 'diplome', 'certificat', 'autre')),
  label       text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 200),
  -- Référence de stockage externe (module documentaire ultérieur — NOT IMPLEMENTED).
  -- JAMAIS le contenu, JAMAIS d'URL signée persistée.
  file_ref    text CHECK (file_ref IS NULL OR char_length(file_ref) <= 300),
  sensitive   boolean NOT NULL DEFAULT true,
  uploaded_by uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES core.employees (tenant_id, id)
);
CREATE INDEX employee_documents_emp_idx ON core.employee_documents (tenant_id, employee_id);

-- ---------- Affectations organisationnelles DATÉES ----------
-- E8 reste la source de vérité : toutes les cibles sont des FK COMPOSITES vers org.
-- UNE SEULE affectation PRINCIPALE applicable à une date (EXCLUDE partiel) ; les
-- affectations secondaires (partage de poste, intérim) peuvent coexister avec un
-- pourcentage. Le responsable hiérarchique se RÉSOUT par la structure des postes
-- (org.position_managers) ; manager_override ne sert qu'aux cas explicitement dérogatoires.
CREATE TABLE core.employee_assignments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL,
  employee_id           uuid NOT NULL,
  company_id            uuid NOT NULL,
  site_id               uuid,
  unit_id               uuid NOT NULL,
  position_id           uuid,
  job_id                uuid,
  cost_center_id        uuid,
  manager_override_employee_id uuid,
  is_primary            boolean NOT NULL DEFAULT true,
  assignment_kind       text NOT NULL DEFAULT 'standard' CHECK (assignment_kind IN ('standard', 'interim', 'temporary')),
  allocation_pct        int NOT NULL DEFAULT 100 CHECK (allocation_pct BETWEEN 1 AND 100),
  effective_from        date NOT NULL,
  effective_to          date CHECK (effective_to IS NULL OR effective_to >= effective_from),
  created_by            uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id)    REFERENCES core.employees (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id)     REFERENCES org.companies (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id)        REFERENCES org.sites (tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id)        REFERENCES org.units (tenant_id, id),
  FOREIGN KEY (tenant_id, position_id)    REFERENCES org.positions (tenant_id, id),
  FOREIGN KEY (tenant_id, job_id)         REFERENCES org.jobs (tenant_id, id),
  FOREIGN KEY (tenant_id, cost_center_id) REFERENCES org.cost_centers (tenant_id, id),
  FOREIGN KEY (tenant_id, manager_override_employee_id) REFERENCES core.employees (tenant_id, id),
  CONSTRAINT assignment_primary_no_overlap EXCLUDE USING gist (
    employee_id WITH =,
    daterange(effective_from, effective_to, '[)') WITH &&
  ) WHERE (is_primary)
);
CREATE INDEX employee_assignments_emp_idx  ON core.employee_assignments (tenant_id, employee_id, effective_from);
CREATE INDEX employee_assignments_unit_idx ON core.employee_assignments (tenant_id, unit_id, effective_from) WHERE is_primary;
CREATE INDEX employee_assignments_site_idx ON core.employee_assignments (tenant_id, site_id, effective_from) WHERE is_primary;
CREATE INDEX employee_assignments_pos_idx  ON core.employee_assignments (tenant_id, position_id, effective_from);
CREATE TRIGGER trg_employee_assignments_close_only BEFORE UPDATE ON core.employee_assignments
  FOR EACH ROW EXECUTE FUNCTION org.guard_period_close_only();
CREATE TRIGGER trg_employee_assignments_nodelete BEFORE DELETE ON core.employee_assignments
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

-- ---------- Historique de carrière : APPEND-ONLY ----------
CREATE TABLE core.career_events (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id            uuid NOT NULL,
  employee_id          uuid NOT NULL,
  event_type           text NOT NULL CHECK (event_type IN (
                         'hire', 'confirmation', 'transfer', 'promotion', 'position_change',
                         'site_change', 'unit_change', 'manager_change', 'suspension', 'return',
                         'termination', 'reinstatement', 'status_change')),
  effective_date       date NOT NULL,
  -- Détails MINIMISÉS (identifiants org, ancien/nouveau statut…) — jamais de données
  -- personnelles sensibles ici : l'événement est un fait de carrière, pas un dossier.
  details              jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(details) = 'object'),
  assignment_id        uuid,
  workflow_instance_id uuid,
  created_by           uuid,
  occurred_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES core.employees (tenant_id, id)
);
CREATE INDEX career_events_emp_idx ON core.career_events (tenant_id, employee_id, effective_date, id);
CREATE TRIGGER trg_career_events_immutable BEFORE UPDATE OR DELETE ON core.career_events
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

-- ---------- Changements RH soumis au Workflow Engine ----------
CREATE TABLE core.hr_pending_changes (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES admin.tenants(id),
  change_type          text NOT NULL CHECK (change_type IN ('status_change', 'assignment')),
  employee_id          uuid NOT NULL,
  payload              jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status               text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'applied', 'rejected', 'cancelled', 'conflict')),
  workflow_instance_id uuid,
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES core.employees (tenant_id, id)
);
CREATE TRIGGER trg_hr_pending_touch BEFORE UPDATE ON core.hr_pending_changes
  FOR EACH ROW EXECUTE FUNCTION admin.touch_updated_at();

-- ---------- Permissions distinctes (protection des données) ----------
INSERT INTO admin.permissions (key, description) VALUES
  ('employees.view',             'Consulter l''identité PROFESSIONNELLE des salariés de sa portée'),
  ('employees.view_private',     'Consulter les coordonnées personnelles (lecture auditée)'),
  ('employees.view_identifiers', 'Consulter les identifiants administratifs — CNSS, fiscal, pièce (lecture auditée)'),
  ('employees.view_documents',   'Consulter les métadonnées des documents du dossier (lecture auditée)'),
  ('employees.manage',           'Gérer le dossier salarié (création, zones, statuts) — audité'),
  ('employees.assign',           'Gérer les affectations organisationnelles — audité'),
  ('employees.view_history',     'Consulter l''historique de carrière et des affectations'),
  ('employees.import',           'Importer des salariés par CSV (atomique) — audité')
ON CONFLICT (key) DO NOTHING;

-- ---------- RLS + privilèges ----------
ALTER TABLE core.employee_private     ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.employee_identifiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.employee_documents   ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.employee_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.career_events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.hr_pending_changes   ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_rows ON core.employee_private TO kora_app
  USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON core.employee_identifiers TO kora_app
  USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON core.employee_documents TO kora_app
  USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON core.employee_assignments TO kora_app
  USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON core.career_events TO kora_app
  USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON core.hr_pending_changes TO kora_app
  USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());

-- Aucun DELETE : cessation = statut + clôture d'affectation, jamais l'effacement.
GRANT SELECT, INSERT, UPDATE ON core.employee_private     TO kora_app;
GRANT SELECT, INSERT, UPDATE ON core.employee_identifiers TO kora_app;
GRANT SELECT, INSERT, UPDATE ON core.employee_documents   TO kora_app;
GRANT SELECT, INSERT, UPDATE ON core.employee_assignments TO kora_app;
GRANT SELECT, INSERT         ON core.career_events        TO kora_app;  -- append-only
GRANT SELECT, INSERT, UPDATE ON core.hr_pending_changes   TO kora_app;
