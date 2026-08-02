-- 0017 — Temps & pointage, tranche E10.2 : moteur de calcul de présence et anomalies.
-- Réf : Blueprint §14, PRD US-E10. Principes portés ICI :
--  - le moteur TRANSFORME sans jamais MODIFIER : pointages bruts, événements
--    normalisés, horaires historiques, affectations E9 et paramètres E4 restent
--    intouchés — AUCUN trigger, AUCUNE colonne ne leur est ajouté par ce fichier ;
--  - RÉSULTATS JOURNALIERS VERSIONNÉS : un recalcul n'écrase JAMAIS — il crée une
--    nouvelle version et bascule l'ancienne hors « courante » ; UNE SEULE version
--    courante par (salarié, date) est garantie PAR LA BASE (index partiel unique) :
--    deux calculs concurrents ne peuvent pas produire deux courantes incompatibles ;
--  - REPRODUCTIBILITÉ : chaque résultat emporte son INSTANTANÉ — horaire appliqué
--    (modèle, version, jour de cycle, plages), affectation à la date, fuseau,
--    paramètres E4 résolus (valeurs ET identifiants de version), version du moteur ;
--  - DURÉES en MINUTES entières (unité technique non ambiguë) ; les valeurs BRUTES
--    (avant tolérance/arrondi) sont conservées à côté des valeurs retenues ;
--  - ANOMALIES : code STABLE d'un catalogue fermé, sévérité, références aux faits,
--    états contrôlés (resolved RÉSERVÉ au circuit de correction E10.3) ;
--  - EXÉCUTIONS : idempotentes, relançables, AUDITÉES ; deux exécutions ACTIVES du
--    même tenant ne peuvent pas se chevaucher en période (contrainte d'exclusion) ;
--  - AUCUN taux de majoration, AUCUN montant : les heures supplémentaires sont
--    CANDIDATES — la validation et la paie sont des modules ultérieurs.

-- ---------------------------------------------------------------------------
-- Exécutions de calcul
-- ---------------------------------------------------------------------------
CREATE TABLE time.calc_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES admin.tenants(id),
  period_start     date NOT NULL,
  period_end       date NOT NULL CHECK (period_end >= period_start),
  -- Périmètre EXPLICITE : tout le tenant, une société, un site, une unité ou un salarié.
  scope_kind       text NOT NULL CHECK (scope_kind IN ('tenant', 'company', 'site', 'unit', 'employee')),
  scope_company_id uuid,
  scope_site_id    uuid,
  scope_unit_id    uuid,
  scope_employee_id uuid,
  reason           text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 300),
  is_recalc        boolean NOT NULL DEFAULT false,
  engine_version   text NOT NULL,
  status           text NOT NULL DEFAULT 'running'
                   CHECK (status IN ('queued', 'running', 'completed', 'completed_with_errors', 'failed', 'cancelled')),
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  employees_count  int NOT NULL DEFAULT 0,
  days_count       int NOT NULL DEFAULT 0,
  results_written  int NOT NULL DEFAULT 0,
  results_unchanged int NOT NULL DEFAULT 0,
  results_error    int NOT NULL DEFAULT 0,
  anomalies_count  int NOT NULL DEFAULT 0,
  duration_ms      int,
  error_note       text CHECK (error_note IS NULL OR char_length(error_note) <= 500),
  created_by       uuid,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, scope_company_id)  REFERENCES org.companies (tenant_id, id),
  FOREIGN KEY (tenant_id, scope_site_id)     REFERENCES org.sites (tenant_id, id),
  FOREIGN KEY (tenant_id, scope_unit_id)     REFERENCES org.units (tenant_id, id),
  FOREIGN KEY (tenant_id, scope_employee_id) REFERENCES core.employees (tenant_id, id),
  CONSTRAINT calc_scope_shape CHECK (
    (scope_kind = 'tenant'   AND scope_company_id IS NULL AND scope_site_id IS NULL AND scope_unit_id IS NULL AND scope_employee_id IS NULL) OR
    (scope_kind = 'company'  AND scope_company_id IS NOT NULL AND scope_site_id IS NULL AND scope_unit_id IS NULL AND scope_employee_id IS NULL) OR
    (scope_kind = 'site'     AND scope_site_id IS NOT NULL AND scope_company_id IS NULL AND scope_unit_id IS NULL AND scope_employee_id IS NULL) OR
    (scope_kind = 'unit'     AND scope_unit_id IS NOT NULL AND scope_company_id IS NULL AND scope_site_id IS NULL AND scope_employee_id IS NULL) OR
    (scope_kind = 'employee' AND scope_employee_id IS NOT NULL AND scope_company_id IS NULL AND scope_site_id IS NULL AND scope_unit_id IS NULL)
  ),
  -- Anti-concurrence PAR LA BASE : deux exécutions ACTIVES d'un même tenant ne se
  -- chevauchent jamais en période (v1 volontairement prudente : le périmètre fin
  -- viendra avec le worker asynchrone — documenté au README).
  CONSTRAINT calc_runs_no_concurrent_overlap EXCLUDE USING gist (
    tenant_id WITH =,
    daterange(period_start, period_end, '[]') WITH &&
  ) WHERE (status IN ('queued', 'running'))
);
CREATE INDEX calc_runs_tenant_idx ON time.calc_runs (tenant_id, started_at DESC);
CREATE TRIGGER trg_calc_runs_nodelete BEFORE DELETE ON time.calc_runs
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

-- ---------------------------------------------------------------------------
-- Résultats journaliers de présence — VERSIONNÉS, une seule version COURANTE.
-- ---------------------------------------------------------------------------
CREATE TABLE time.day_results (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL,
  employee_id            uuid NOT NULL,
  work_date              date NOT NULL,
  version                int  NOT NULL CHECK (version >= 1),
  is_current             boolean NOT NULL DEFAULT true,
  calc_run_id            uuid NOT NULL,
  engine_version         text NOT NULL,
  computed_at            timestamptz NOT NULL DEFAULT now(),
  -- Instantané du CONTEXTE (reproductibilité — le passé reste explicable même si
  -- les référentiels évoluent ensuite) :
  tz                     text NOT NULL,
  schedule_model_code    text,
  schedule_model_version int,
  cycle_day_index        int,
  planned_start_minute   int,
  planned_end_minute     int,
  planned_break_start_minute int,
  planned_break_end_minute   int,
  planned_rest           boolean NOT NULL DEFAULT false,
  holiday                boolean NOT NULL DEFAULT false,
  exception_kind         text CHECK (exception_kind IS NULL OR exception_kind IN ('closed', 'rest', 'special_hours')),
  assignment_id          uuid,
  company_id             uuid,
  site_id                uuid,
  unit_id                uuid,
  -- Paramètres E4 réellement APPLIQUÉS à cette date : { cle: { value, parameterId,
  --   effectiveFrom, source: 'parametre'|'defaut' } } — versions exactes.
  params_used            jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(params_used) = 'object'),
  -- Faits retenus :
  first_in               timestamptz,
  last_out               timestamptz,
  work_periods           jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(work_periods) = 'array'),
  used_event_ids         jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(used_event_ids) = 'array'),
  -- Durées en MINUTES entières ; les _raw sont AVANT tolérance/arrondi (jamais perdues).
  presence_minutes       int NOT NULL DEFAULT 0 CHECK (presence_minutes >= 0),
  worked_minutes         int NOT NULL DEFAULT 0 CHECK (worked_minutes >= 0),
  break_minutes          int NOT NULL DEFAULT 0 CHECK (break_minutes >= 0),
  late_minutes_raw       int NOT NULL DEFAULT 0 CHECK (late_minutes_raw >= 0),
  late_minutes           int NOT NULL DEFAULT 0 CHECK (late_minutes >= 0),
  early_departure_minutes_raw int NOT NULL DEFAULT 0 CHECK (early_departure_minutes_raw >= 0),
  early_departure_minutes int NOT NULL DEFAULT 0 CHECK (early_departure_minutes >= 0),
  absence_minutes        int NOT NULL DEFAULT 0 CHECK (absence_minutes >= 0),
  night_minutes          int NOT NULL DEFAULT 0 CHECK (night_minutes >= 0),
  rest_day_minutes       int NOT NULL DEFAULT 0 CHECK (rest_day_minutes >= 0),
  holiday_minutes        int NOT NULL DEFAULT 0 CHECK (holiday_minutes >= 0),
  overtime_candidate_minutes int NOT NULL DEFAULT 0 CHECK (overtime_candidate_minutes >= 0),
  day_status             text NOT NULL CHECK (day_status IN (
                           'present', 'late', 'early_departure', 'late_and_early_departure',
                           'absent', 'partial_presence', 'incomplete_punches',
                           'rest_day', 'public_holiday', 'worked_rest_day', 'worked_public_holiday',
                           'not_scheduled', 'not_employed', 'suspended', 'unresolved')),
  calc_state             text NOT NULL DEFAULT 'ok' CHECK (calc_state IN ('ok', 'error')),
  calc_note              text CHECK (calc_note IS NULL OR char_length(calc_note) <= 500),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, employee_id, work_date, version),
  FOREIGN KEY (tenant_id, employee_id)   REFERENCES core.employees (tenant_id, id),
  FOREIGN KEY (tenant_id, calc_run_id)   REFERENCES time.calc_runs (tenant_id, id),
  FOREIGN KEY (tenant_id, assignment_id) REFERENCES core.employee_assignments (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id)    REFERENCES org.companies (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id)       REFERENCES org.sites (tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id)       REFERENCES org.units (tenant_id, id)
);
-- LA garantie centrale : une seule version COURANTE par salarié et par date.
CREATE UNIQUE INDEX day_results_current_unique ON time.day_results
  (tenant_id, employee_id, work_date) WHERE is_current;
CREATE INDEX day_results_date_idx   ON time.day_results (tenant_id, work_date) WHERE is_current;
CREATE INDEX day_results_unit_idx   ON time.day_results (tenant_id, unit_id, work_date) WHERE is_current;
CREATE INDEX day_results_site_idx   ON time.day_results (tenant_id, site_id, work_date) WHERE is_current;
CREATE INDEX day_results_status_idx ON time.day_results (tenant_id, day_status, work_date) WHERE is_current;
CREATE INDEX day_results_run_idx    ON time.day_results (tenant_id, calc_run_id);

-- Historisation stricte : la SEULE modification permise est la bascule
-- is_current true → false (supersession par une version plus récente).
CREATE FUNCTION time.guard_day_result_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (OLD.is_current = true AND NEW.is_current = false) THEN
    RAISE EXCEPTION 'résultat journalier : seule la bascule hors « courante » est permise'
      USING ERRCODE = 'raise_exception';
  END IF;
  IF to_jsonb(NEW) - 'is_current' IS DISTINCT FROM to_jsonb(OLD) - 'is_current' THEN
    RAISE EXCEPTION 'résultat journalier : contenu FIGÉ — un recalcul crée une NOUVELLE version'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_day_results_guard BEFORE UPDATE ON time.day_results
  FOR EACH ROW EXECUTE FUNCTION time.guard_day_result_update();
CREATE TRIGGER trg_day_results_nodelete BEFORE DELETE ON time.day_results
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

-- ---------------------------------------------------------------------------
-- Anomalies journalières — catalogue FERMÉ, états contrôlés, faits référencés.
-- ---------------------------------------------------------------------------
CREATE TABLE time.day_anomalies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  day_result_id uuid NOT NULL,
  employee_id   uuid NOT NULL,
  work_date     date NOT NULL,
  code          text NOT NULL CHECK (code IN (
                  'missing_in', 'missing_out', 'sequence_error', 'odd_untyped_events',
                  'impossible_duration', 'excessive_presence', 'punch_outside_schedule',
                  'punch_other_site', 'no_schedule', 'no_assignment', 'not_yet_hired',
                  'terminated', 'suspended', 'overlapping_periods', 'break_too_short',
                  'ambiguous_local_time', 'unmatched_event_pending', 'calc_failed')),
  severity      text NOT NULL CHECK (severity IN ('info', 'warning', 'blocking')),
  refs          jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(refs) = 'object'),
  detail        text CHECK (detail IS NULL OR char_length(detail) <= 300),
  state         text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'acknowledged', 'resolved', 'dismissed')),
  state_note    text CHECK (state_note IS NULL OR char_length(state_note) <= 300),
  state_by      uuid,
  state_at      timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, day_result_id) REFERENCES time.day_results (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id)   REFERENCES core.employees (tenant_id, id)
);
CREATE INDEX day_anomalies_state_idx ON time.day_anomalies (tenant_id, state, severity, work_date);
CREATE INDEX day_anomalies_result_idx ON time.day_anomalies (tenant_id, day_result_id);

-- Cycle de vie : open → acknowledged | dismissed ; « resolved » est RÉSERVÉ au
-- circuit de correction E10.3 (une correction approuvée résout — jamais un clic).
CREATE FUNCTION time.guard_anomaly_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF to_jsonb(NEW) - 'state' - 'state_note' - 'state_by' - 'state_at'
     IS DISTINCT FROM to_jsonb(OLD) - 'state' - 'state_note' - 'state_by' - 'state_at' THEN
    RAISE EXCEPTION 'anomalie : seuls état et note d''état sont modifiables' USING ERRCODE = 'raise_exception';
  END IF;
  IF NEW.state <> OLD.state THEN
    IF NOT (
      (OLD.state = 'open'         AND NEW.state IN ('acknowledged', 'dismissed')) OR
      (OLD.state = 'acknowledged' AND NEW.state IN ('dismissed', 'open')) OR
      (OLD.state = 'dismissed'    AND NEW.state = 'open')
    ) THEN
      RAISE EXCEPTION 'transition d''état d''anomalie interdite : % -> % (resolved = correction E10.3)',
        OLD.state, NEW.state USING ERRCODE = 'raise_exception';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_day_anomalies_guard BEFORE UPDATE ON time.day_anomalies
  FOR EACH ROW EXECUTE FUNCTION time.guard_anomaly_update();
CREATE TRIGGER trg_day_anomalies_nodelete BEFORE DELETE ON time.day_anomalies
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

-- ---------------------------------------------------------------------------
-- Permissions distinctes (les portées réelles s'appuient sur E8/E9 à la date).
-- ---------------------------------------------------------------------------
INSERT INTO admin.permissions (key, description) VALUES
  ('time.results_view_own',  'Consulter SES propres résultats de présence'),
  ('time.results_view',      'Consulter les résultats de présence de sa portée (équipe, unité, site)'),
  ('time.anomalies_view',    'Consulter les anomalies de présence de sa portée'),
  ('time.anomalies_manage',  'Prendre en charge / écarter une anomalie — audité (la résolution passe par E10.3)'),
  ('time.calc_run',          'Déclencher un calcul de présence — audité'),
  ('time.calc_recalc',       'Déclencher un RECALCUL motivé (nouvelle version, historique conservé) — audité'),
  ('time.calc_view',         'Consulter les exécutions de calcul')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- RLS + privilèges : jamais de DELETE ; les résultats ne s'UPDATE que pour la
-- bascule de version, les anomalies que pour l'état.
-- ---------------------------------------------------------------------------
ALTER TABLE time.calc_runs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE time.day_results   ENABLE ROW LEVEL SECURITY;
ALTER TABLE time.day_anomalies ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_rows ON time.calc_runs TO kora_app
  USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON time.day_results TO kora_app
  USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON time.day_anomalies TO kora_app
  USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON time.calc_runs     TO kora_app;  -- statuts/compteurs
GRANT SELECT, INSERT, UPDATE ON time.day_results   TO kora_app;  -- bascule is_current SEULE (trigger)
GRANT SELECT, INSERT, UPDATE ON time.day_anomalies TO kora_app;  -- état SEUL (trigger)
