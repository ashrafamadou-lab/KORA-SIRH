-- 0014 — Organisation (E8) : référentiel organisationnel historisé
-- Réf : Blueprint §13 (Organisation), PRD US-E8. Principes non négociables :
--  - Tenant = frontière de sécurité ; Company = entité organisationnelle/juridique
--    À L'INTÉRIEUR d'un tenant — jamais confondue avec lui ;
--  - toute relation tenantée passe par des FK COMPOSITES (tenant_id, id) : une
--    référence inter-tenant est rejetée PAR POSTGRESQL, pas seulement par l'API ;
--  - l'organisation est HISTORISÉE par dates d'effet : une réorganisation ferme la
--    période courante et ouvre une nouvelle ligne datée — l'histoire ne se réécrit
--    JAMAIS (garde « close-only » par trigger, chevauchements exclus par contrainte) ;
--  - aucune suppression physique : les statuts (draft → active ⇄ inactive → archived)
--    portent le retrait ; AUCUN grant DELETE n'existe sur le schéma org.

CREATE SCHEMA org;

-- ---------- Gardes génériques ----------
CREATE FUNCTION org.forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% est protégé : % interdit', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'raise_exception';
END $$;

-- Statuts : draft → active ⇄ inactive → archived ; draft → archived ; archived TERMINAL.
CREATE FUNCTION org.guard_status_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.code <> OLD.code THEN
    RAISE EXCEPTION 'le code « % » est immuable (réutilisation historique contrôlée : un code reste réservé)', OLD.code
      USING ERRCODE = 'raise_exception';
  END IF;
  IF NEW.status <> OLD.status THEN
    IF NOT (
      (OLD.status = 'draft'    AND NEW.status IN ('active', 'archived')) OR
      (OLD.status = 'active'   AND NEW.status IN ('inactive', 'archived')) OR
      (OLD.status = 'inactive' AND NEW.status IN ('active', 'archived'))
    ) THEN
      RAISE EXCEPTION 'transition de statut interdite : % -> %', OLD.status, NEW.status
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Historisation « close-only » : sur une ligne datée, SEULE la clôture est permise —
-- effective_to passe de NULL à une date ≥ effective_from ; tout le reste est figé.
-- (La réorganisation = clôture + NOUVELLE ligne ; jamais une réécriture.)
CREATE FUNCTION org.guard_period_close_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.effective_to IS NOT NULL THEN
    RAISE EXCEPTION 'période close : ligne historique figée' USING ERRCODE = 'raise_exception';
  END IF;
  IF NEW.effective_to IS NULL OR NEW.effective_to < OLD.effective_from THEN
    RAISE EXCEPTION 'clôture invalide : effective_to requis et ≥ effective_from' USING ERRCODE = 'raise_exception';
  END IF;
  IF to_jsonb(NEW) - 'effective_to' IS DISTINCT FROM to_jsonb(OLD) - 'effective_to' THEN
    RAISE EXCEPTION 'ligne historique : seule la clôture (effective_to) est modifiable'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END $$;

-- ---------- Sociétés (entités juridiques DANS le tenant) ----------
CREATE TABLE org.companies (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES admin.tenants(id),
  code       text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,29}$'),
  label_fr   text NOT NULL CHECK (char_length(label_fr) BETWEEN 1 AND 200),
  label_en   text NOT NULL CHECK (char_length(label_en) BETWEEN 1 AND 200),
  legal_form text,
  status     text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'inactive', 'archived')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);
CREATE TRIGGER trg_companies_touch BEFORE UPDATE ON org.companies
  FOR EACH ROW EXECUTE FUNCTION admin.touch_updated_at();
CREATE TRIGGER trg_companies_guard BEFORE UPDATE ON org.companies
  FOR EACH ROW EXECUTE FUNCTION org.guard_status_update();

-- ---------- Sites / établissements ----------
CREATE TABLE org.sites (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES admin.tenants(id),
  company_id uuid NOT NULL,
  code       text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,29}$'),
  label_fr   text NOT NULL CHECK (char_length(label_fr) BETWEEN 1 AND 200),
  label_en   text NOT NULL CHECK (char_length(label_en) BETWEEN 1 AND 200),
  city       text,
  status     text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'inactive', 'archived')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES org.companies (tenant_id, id)
);
CREATE TRIGGER trg_sites_touch BEFORE UPDATE ON org.sites
  FOR EACH ROW EXECUTE FUNCTION admin.touch_updated_at();
CREATE TRIGGER trg_sites_guard BEFORE UPDATE ON org.sites
  FOR EACH ROW EXECUTE FUNCTION org.guard_status_update();

-- ---------- Centres de coûts ----------
CREATE TABLE org.cost_centers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES admin.tenants(id),
  code       text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,29}$'),
  label_fr   text NOT NULL CHECK (char_length(label_fr) BETWEEN 1 AND 200),
  label_en   text NOT NULL CHECK (char_length(label_en) BETWEEN 1 AND 200),
  status     text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'inactive', 'archived')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);
CREATE TRIGGER trg_cost_centers_touch BEFORE UPDATE ON org.cost_centers
  FOR EACH ROW EXECUTE FUNCTION admin.touch_updated_at();
CREATE TRIGGER trg_cost_centers_guard BEFORE UPDATE ON org.cost_centers
  FOR EACH ROW EXECUTE FUNCTION org.guard_status_update();

-- ---------- Emplois génériques (jobs) ----------
CREATE TABLE org.jobs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES admin.tenants(id),
  code       text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,29}$'),
  label_fr   text NOT NULL CHECK (char_length(label_fr) BETWEEN 1 AND 200),
  label_en   text NOT NULL CHECK (char_length(label_en) BETWEEN 1 AND 200),
  category   text,
  status     text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'inactive', 'archived')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);
CREATE TRIGGER trg_jobs_touch BEFORE UPDATE ON org.jobs
  FOR EACH ROW EXECUTE FUNCTION admin.touch_updated_at();
CREATE TRIGGER trg_jobs_guard BEFORE UPDATE ON org.jobs
  FOR EACH ROW EXECUTE FUNCTION org.guard_status_update();

-- ---------- Unités organisationnelles ----------
CREATE TABLE org.units (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES admin.tenants(id),
  company_id uuid,
  unit_type  text NOT NULL CHECK (unit_type IN ('direction', 'department', 'service', 'unit', 'team')),
  code       text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,29}$'),
  label_fr   text NOT NULL CHECK (char_length(label_fr) BETWEEN 1 AND 200),
  label_en   text NOT NULL CHECK (char_length(label_en) BETWEEN 1 AND 200),
  status     text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'inactive', 'archived')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES org.companies (tenant_id, id)
);
CREATE TRIGGER trg_units_touch BEFORE UPDATE ON org.units
  FOR EACH ROW EXECUTE FUNCTION admin.touch_updated_at();
CREATE TRIGGER trg_units_guard BEFORE UPDATE ON org.units
  FOR EACH ROW EXECUTE FUNCTION org.guard_status_update();

-- ---------- Hiérarchie des unités, DATÉE ----------
-- Pas de ligne = racine sur la période. Une ligne = « unit est enfant de parent sur
-- [effective_from, effective_to) ». FK composites : parent et enfant du MÊME tenant,
-- structurellement. Chevauchements interdits par contrainte d'exclusion (gist).
CREATE TABLE org.unit_parents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  unit_id        uuid NOT NULL,
  parent_unit_id uuid NOT NULL,
  effective_from date NOT NULL,
  effective_to   date CHECK (effective_to IS NULL OR effective_to >= effective_from),
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (unit_id <> parent_unit_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id)        REFERENCES org.units (tenant_id, id),
  FOREIGN KEY (tenant_id, parent_unit_id) REFERENCES org.units (tenant_id, id),
  EXCLUDE USING gist (
    unit_id WITH =,
    daterange(effective_from, effective_to, '[)') WITH &&
  )
);
CREATE INDEX unit_parents_unit_idx   ON org.unit_parents (tenant_id, unit_id, effective_from);
CREATE INDEX unit_parents_parent_idx ON org.unit_parents (tenant_id, parent_unit_id, effective_from);
CREATE TRIGGER trg_unit_parents_close_only BEFORE UPDATE ON org.unit_parents
  FOR EACH ROW EXECUTE FUNCTION org.guard_period_close_only();
CREATE TRIGGER trg_unit_parents_nodelete BEFORE DELETE ON org.unit_parents
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

-- Parent d'une unité à une date (NULL = racine).
CREATE FUNCTION org.unit_parent_at(p_unit uuid, p_date date) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT parent_unit_id FROM org.unit_parents
   WHERE unit_id = p_unit AND daterange(effective_from, effective_to, '[)') @> p_date
   LIMIT 1
$$;

-- Y a-t-il un cycle si p_unit prenait p_parent pour parent à p_date ? (borne : 100 niveaux)
CREATE FUNCTION org.unit_chain_would_cycle(p_unit uuid, p_parent uuid, p_date date) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE
  cur   uuid := p_parent;
  depth int  := 0;
BEGIN
  WHILE cur IS NOT NULL LOOP
    IF cur = p_unit THEN RETURN true; END IF;
    depth := depth + 1;
    IF depth > 100 THEN
      RAISE EXCEPTION 'hiérarchie d''unités trop profonde (> 100 niveaux)' USING ERRCODE = 'raise_exception';
    END IF;
    cur := org.unit_parent_at(cur, p_date);
  END LOOP;
  RETURN false;
END $$;

CREATE FUNCTION org.guard_unit_parent_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF org.unit_chain_would_cycle(NEW.unit_id, NEW.parent_unit_id, NEW.effective_from) THEN
    RAISE EXCEPTION 'cycle organisationnel refusé (unités)' USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_unit_parents_nocycle BEFORE INSERT ON org.unit_parents
  FOR EACH ROW EXECUTE FUNCTION org.guard_unit_parent_insert();

-- ---------- Postes organisationnels (positions) ----------
CREATE TABLE org.positions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES admin.tenants(id),
  code       text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,29}$'),
  label_fr   text NOT NULL CHECK (char_length(label_fr) BETWEEN 1 AND 200),
  label_en   text NOT NULL CHECK (char_length(label_en) BETWEEN 1 AND 200),
  status     text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'inactive', 'archived')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);
CREATE TRIGGER trg_positions_touch BEFORE UPDATE ON org.positions
  FOR EACH ROW EXECUTE FUNCTION admin.touch_updated_at();
CREATE TRIGGER trg_positions_guard BEFORE UPDATE ON org.positions
  FOR EACH ROW EXECUTE FUNCTION org.guard_status_update();

-- ---------- Rattachements de poste, DATÉS ----------
-- Un poste est rattaché à une unité, une société, un emploi (obligatoires), un site et
-- un centre de coûts (optionnels) sur une période. Tout est du MÊME tenant (FK
-- composites) ; une seule ligne applicable à une date (EXCLUDE).
CREATE TABLE org.position_assignments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  position_id    uuid NOT NULL,
  unit_id        uuid NOT NULL,
  company_id     uuid NOT NULL,
  job_id         uuid NOT NULL,
  site_id        uuid,
  cost_center_id uuid,
  effective_from date NOT NULL,
  effective_to   date CHECK (effective_to IS NULL OR effective_to >= effective_from),
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, position_id)    REFERENCES org.positions   (tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id)        REFERENCES org.units       (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id)     REFERENCES org.companies   (tenant_id, id),
  FOREIGN KEY (tenant_id, job_id)         REFERENCES org.jobs        (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id)        REFERENCES org.sites       (tenant_id, id),
  FOREIGN KEY (tenant_id, cost_center_id) REFERENCES org.cost_centers (tenant_id, id),
  EXCLUDE USING gist (
    position_id WITH =,
    daterange(effective_from, effective_to, '[)') WITH &&
  )
);
CREATE INDEX position_assignments_pos_idx  ON org.position_assignments (tenant_id, position_id, effective_from);
CREATE INDEX position_assignments_unit_idx ON org.position_assignments (tenant_id, unit_id, effective_from);
CREATE TRIGGER trg_position_assignments_close_only BEFORE UPDATE ON org.position_assignments
  FOR EACH ROW EXECUTE FUNCTION org.guard_period_close_only();
CREATE TRIGGER trg_position_assignments_nodelete BEFORE DELETE ON org.position_assignments
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

-- ---------- Hiérarchie managériale entre postes, DATÉE ----------
-- L'EXCLUDE garantit la règle sponsor : UN SEUL parent hiérarchique direct applicable
-- à une date donnée.
CREATE TABLE org.position_managers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  position_id         uuid NOT NULL,
  manager_position_id uuid NOT NULL,
  effective_from      date NOT NULL,
  effective_to        date CHECK (effective_to IS NULL OR effective_to >= effective_from),
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (position_id <> manager_position_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, position_id)         REFERENCES org.positions (tenant_id, id),
  FOREIGN KEY (tenant_id, manager_position_id) REFERENCES org.positions (tenant_id, id),
  EXCLUDE USING gist (
    position_id WITH =,
    daterange(effective_from, effective_to, '[)') WITH &&
  )
);
CREATE INDEX position_managers_pos_idx ON org.position_managers (tenant_id, position_id, effective_from);
CREATE TRIGGER trg_position_managers_close_only BEFORE UPDATE ON org.position_managers
  FOR EACH ROW EXECUTE FUNCTION org.guard_period_close_only();
CREATE TRIGGER trg_position_managers_nodelete BEFORE DELETE ON org.position_managers
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

CREATE FUNCTION org.position_manager_at(p_position uuid, p_date date) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT manager_position_id FROM org.position_managers
   WHERE position_id = p_position AND daterange(effective_from, effective_to, '[)') @> p_date
   LIMIT 1
$$;

CREATE FUNCTION org.position_chain_would_cycle(p_position uuid, p_manager uuid, p_date date) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE
  cur   uuid := p_manager;
  depth int  := 0;
BEGIN
  WHILE cur IS NOT NULL LOOP
    IF cur = p_position THEN RETURN true; END IF;
    depth := depth + 1;
    IF depth > 100 THEN
      RAISE EXCEPTION 'ligne managériale trop profonde (> 100 niveaux)' USING ERRCODE = 'raise_exception';
    END IF;
    cur := org.position_manager_at(cur, p_date);
  END LOOP;
  RETURN false;
END $$;

CREATE FUNCTION org.guard_position_manager_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF org.position_chain_would_cycle(NEW.position_id, NEW.manager_position_id, NEW.effective_from) THEN
    RAISE EXCEPTION 'cycle managérial refusé (postes)' USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_position_managers_nocycle BEFORE INSERT ON org.position_managers
  FOR EACH ROW EXECUTE FUNCTION org.guard_position_manager_insert();

-- ---------- Changements structurels sensibles soumis au workflow (E3) ----------
CREATE TABLE org.pending_changes (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES admin.tenants(id),
  change_type          text NOT NULL CHECK (change_type IN ('unit_move')),
  payload              jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status               text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'applied', 'rejected', 'cancelled', 'conflict')),
  workflow_instance_id uuid,
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE TRIGGER trg_pending_changes_touch BEFORE UPDATE ON org.pending_changes
  FOR EACH ROW EXECUTE FUNCTION admin.touch_updated_at();

-- ---------- Portées RBAC réelles : validation de scope_ref ----------
-- Les identifiants de société / site / unité deviennent des portées RBAC RÉELLES :
-- une portée non-tenant doit référencer une ligne existante du BON tenant.
CREATE FUNCTION admin.guard_user_scope_ref() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE ok boolean;
BEGIN
  IF NEW.scope_type = 'tenant' THEN RETURN NEW; END IF;
  IF NEW.scope_ref IS NULL THEN
    RAISE EXCEPTION 'scope_ref requis pour la portée %', NEW.scope_type USING ERRCODE = 'raise_exception';
  END IF;
  IF NEW.scope_type = 'legal_entity' THEN
    SELECT EXISTS (SELECT 1 FROM org.companies c WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.scope_ref) INTO ok;
  ELSIF NEW.scope_type = 'site' THEN
    SELECT EXISTS (SELECT 1 FROM org.sites s WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.scope_ref) INTO ok;
  ELSE -- department / team → unités organisationnelles
    SELECT EXISTS (SELECT 1 FROM org.units u WHERE u.tenant_id = NEW.tenant_id AND u.id = NEW.scope_ref) INTO ok;
  END IF;
  IF NOT ok THEN
    RAISE EXCEPTION 'portée % : référence organisationnelle inconnue dans ce tenant', NEW.scope_type
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_user_scopes_ref BEFORE INSERT OR UPDATE ON admin.user_scopes
  FOR EACH ROW EXECUTE FUNCTION admin.guard_user_scope_ref();

-- ---------- Permissions ----------
INSERT INTO admin.permissions (key, description) VALUES
  ('org.view',   'Consulter le référentiel organisationnel et l''organigramme'),
  ('org.manage', 'Administrer l''organisation (création, statuts, réorganisations) — audité'),
  ('org.import', 'Importer l''organisation par CSV (prévisualisation + application atomique) — audité')
ON CONFLICT (key) DO NOTHING;

-- ---------- RLS + privilèges ----------
ALTER TABLE org.companies            ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.sites                ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.cost_centers         ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.jobs                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.units                ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.unit_parents         ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.positions            ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.position_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.position_managers    ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.pending_changes      ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_rows ON org.companies TO kora_app
  USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON org.sites TO kora_app
  USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON org.cost_centers TO kora_app
  USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON org.jobs TO kora_app
  USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON org.units TO kora_app
  USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON org.unit_parents TO kora_app
  USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON org.positions TO kora_app
  USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON org.position_assignments TO kora_app
  USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON org.position_managers TO kora_app
  USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON org.pending_changes TO kora_app
  USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());

GRANT USAGE ON SCHEMA org TO kora_app;
-- AUCUN DELETE : le retrait passe par les statuts (inactive/archived), jamais par l'effacement.
GRANT SELECT, INSERT, UPDATE ON org.companies            TO kora_app;
GRANT SELECT, INSERT, UPDATE ON org.sites                TO kora_app;
GRANT SELECT, INSERT, UPDATE ON org.cost_centers         TO kora_app;
GRANT SELECT, INSERT, UPDATE ON org.jobs                 TO kora_app;
GRANT SELECT, INSERT, UPDATE ON org.units                TO kora_app;
GRANT SELECT, INSERT, UPDATE ON org.unit_parents         TO kora_app;
GRANT SELECT, INSERT, UPDATE ON org.positions            TO kora_app;
GRANT SELECT, INSERT, UPDATE ON org.position_assignments TO kora_app;
GRANT SELECT, INSERT, UPDATE ON org.position_managers    TO kora_app;
GRANT SELECT, INSERT, UPDATE ON org.pending_changes      TO kora_app;

GRANT EXECUTE ON FUNCTION org.unit_parent_at(uuid, date)                       TO kora_app;
GRANT EXECUTE ON FUNCTION org.unit_chain_would_cycle(uuid, uuid, date)         TO kora_app;
GRANT EXECUTE ON FUNCTION org.position_manager_at(uuid, date)                  TO kora_app;
GRANT EXECUTE ON FUNCTION org.position_chain_would_cycle(uuid, uuid, date)     TO kora_app;
