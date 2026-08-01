-- 0011 — Config Center (E4) : cycle de vie complet des paramètres + contreseing
-- Étend le Parameter Engine (0004). États : draft → submitted → approved →
-- (active | scheduled) → superseded ; rejected ; retired. Le contreseing passe par le
-- Workflow Engine (E3) : la version soumise EST le sujet d'une instance de workflow.

-- ---------- Cycle de vie et traçabilité ----------
ALTER TABLE compliance.legal_parameters DROP CONSTRAINT legal_parameters_status_check;
ALTER TABLE compliance.legal_parameters
  ADD CONSTRAINT legal_parameters_status_check CHECK (
    status IN ('draft', 'submitted', 'approved', 'scheduled', 'active', 'superseded', 'rejected', 'retired')
  );

ALTER TABLE compliance.legal_parameters
  ADD COLUMN is_legal_sensitive  boolean NOT NULL DEFAULT true,   -- paramètre juridique = contrôles renforcés
  ADD COLUMN submitted_by         uuid,
  ADD COLUMN approved_by          uuid,
  ADD COLUMN activated_by         uuid,
  ADD COLUMN activated_at         timestamptz,
  ADD COLUMN workflow_instance_id uuid;   -- lien vers l'instance E3 (décision liée à CETTE version)

-- Un actif OU planifié exige source + vérificateur + date de vérification (contreseing).
ALTER TABLE compliance.legal_parameters DROP CONSTRAINT active_requires_source;
ALTER TABLE compliance.legal_parameters
  ADD CONSTRAINT active_requires_source CHECK (
    status NOT IN ('active', 'scheduled')
    OR (source_text IS NOT NULL AND verified_by IS NOT NULL AND verified_at IS NOT NULL)
  );

-- Anti-chevauchement étendu aux versions en vigueur ET planifiées (une seule valeur par
-- instant pour une portée donnée). Les superseded (fenêtres fermées, jointives) sont hors
-- contrainte : c'est l'historique.
ALTER TABLE compliance.legal_parameters DROP CONSTRAINT parameter_no_overlap;
ALTER TABLE compliance.legal_parameters
  ADD CONSTRAINT parameter_no_overlap EXCLUDE USING gist (
    key WITH =,
    country_code WITH =,
    COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
    daterange(effective_from, effective_to, '[)') WITH &&
  ) WHERE (status IN ('active', 'scheduled') AND deleted_at IS NULL);

-- ---------- Immuabilité : interdiction de modifier/supprimer une version non-draft ----------
CREATE FUNCTION compliance.guard_parameter_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' THEN
    -- Contenu figé hors draft (on crée une nouvelle version, on ne réécrit jamais).
    IF NEW.value IS DISTINCT FROM OLD.value
       OR NEW.effective_from <> OLD.effective_from
       OR NEW.key <> OLD.key
       OR NEW.country_code <> OLD.country_code
       OR NEW.unit IS DISTINCT FROM OLD.unit
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
      RAISE EXCEPTION 'paramètre % (%): contenu figé hors draft', OLD.key, OLD.status
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;
  -- Une version active ou planifiée ne peut pas être supprimée (soft-delete interdit).
  IF OLD.status IN ('active', 'scheduled') AND NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    RAISE EXCEPTION 'suppression d''une version % interdite', OLD.status
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_parameters_guard BEFORE UPDATE ON compliance.legal_parameters
  FOR EACH ROW EXECUTE FUNCTION compliance.guard_parameter_update();

-- ---------- Résolution temporelle (refonte) ----------
-- « La valeur en vigueur à la date de l'événement » — résout parmi active / scheduled /
-- superseded selon la FENÊTRE [effective_from, effective_to). Un draft / submitted /
-- approved / rejected / retired n'est JAMAIS résolu. Priorité surcharge tenant > pays.
-- Passé (superseded), présent (active), futur (scheduled) résolus uniformément.
-- DROP + CREATE : la signature de retour gagne une colonne `status` (CREATE OR REPLACE
-- ne peut pas changer le type de retour).
DROP FUNCTION IF EXISTS compliance.parameter_value_at(text, char, uuid, date);
CREATE FUNCTION compliance.parameter_value_at(
  p_key     text,
  p_country char(2),
  p_tenant  uuid,
  p_date    date
) RETURNS TABLE (
  parameter_id   uuid,
  value          jsonb,
  unit           text,
  scope          text,
  status         text,
  effective_from date,
  effective_to   date,
  source_text    text,
  legal_ref      text,
  confidence     text
)
LANGUAGE sql STABLE AS $$
  SELECT id, value, unit,
         CASE WHEN tenant_id IS NULL THEN 'country' ELSE 'tenant' END,
         status, effective_from, effective_to, source_text, legal_ref, confidence
    FROM compliance.legal_parameters
   WHERE key = p_key
     AND country_code = p_country
     AND status IN ('active', 'scheduled', 'superseded')
     AND deleted_at IS NULL
     AND (tenant_id IS NULL OR tenant_id = p_tenant)
     AND daterange(effective_from, effective_to, '[)') @> p_date
   ORDER BY (tenant_id IS NOT NULL) DESC, effective_from DESC
   LIMIT 1
$$;

-- ---------- Permissions : ordinaires vs juridiques sensibles ----------
INSERT INTO admin.permissions (key, description) VALUES
  ('parameters.view',       'Consulter les paramètres et leur historique'),
  ('parameters.create',     'Créer une version draft de paramètre ordinaire'),
  ('parameters.submit',     'Soumettre au contreseing un paramètre ordinaire'),
  ('parameters.activate',   'Activer un paramètre ordinaire approuvé'),
  ('legal_parameters.create',   'Créer une version draft de paramètre juridique sensible'),
  ('legal_parameters.submit',   'Soumettre au contreseing un paramètre juridique'),
  ('legal_parameters.activate', 'Activer un paramètre juridique approuvé (jamais son créateur)')
ON CONFLICT (key) DO NOTHING;

-- ---------- Privilèges : UPDATE des colonnes de cycle de vie ----------
GRANT UPDATE (status, confidence, verified_by, verified_at, source_text, source_url, notes,
              deleted_at, effective_to, submitted_by, approved_by, activated_by, activated_at,
              workflow_instance_id)
  ON compliance.legal_parameters TO kora_app;
GRANT EXECUTE ON FUNCTION compliance.parameter_value_at(text, char, uuid, date) TO kora_app;
