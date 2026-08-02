-- 0016 — Temps & pointage, tranche E10.1 : horaires, rotations, collecte BRUTE.
-- Réf : Blueprint §14 (Présence), PRD US-E10. Principes portés ICI :
--  - SÉPARATION STRICTE des natures de données : le pointage BRUT reçu d'une source
--    (time.raw_punches, APPEND-ONLY, jamais réécrit ni supprimé) est distinct de
--    l'ÉVÉNEMENT NORMALISÉ dérivé (time.punch_events, recalculable) ; le RÉSULTAT
--    quotidien, la CORRECTION, la DÉCISION et l'IMPACT PAIE sont des tranches
--    ultérieures (E10.2/E10.3) — AUCUNE table de résultat n'existe encore ;
--  - HISTORISATION des horaires : un modèle est porté par des VERSIONS append-only à
--    date d'effet ; une version nouvelle ne peut JAMAIS s'insérer dans le passé — le
--    planning applicable à une date passée est immuable par construction ;
--  - NUITS TRAVERSANT MINUIT sans ambiguïté : les plages sont en minutes depuis le
--    début du jour de cycle ; end_minute > 1440 signifie « le lendemain » (22:00→06:00
--    = 1320→1800) — aucune interprétation, une seule représentation possible ;
--  - AUCUNE règle juridique en dur : durées normales, tolérances, seuils, arrondis,
--    majorations sont des PARAMÈTRES E4 (famille temps.*) résolus à la date de l'événement
--    par le moteur E10.2 ; cette migration ne fixe AUCUN taux ni seuil ;
--  - AUCUNE donnée biométrique : KORA ne stocke ni gabarit, ni empreinte, ni image —
--    seulement l'identifiant externe, l'horodatage, le dispositif et la référence
--    technique (registre des traitements : voir README) ;
--  - isolation tenant : RLS sur TOUTES les tables + FK COMPOSITES (tenant_id, id) —
--    une référence inter-tenant est rejetée par PostgreSQL lui-même.

CREATE SCHEMA time;

-- ---------------------------------------------------------------------------
-- Fuseau horaire par SITE (E8 reste la source de vérité des sites).
-- Résolution effective : dispositif → site → paramètre tenant temps.fuseau.defaut → 'UTC'.
-- ---------------------------------------------------------------------------
ALTER TABLE org.sites ADD COLUMN time_zone text
  CHECK (time_zone IS NULL OR time_zone ~ '^[A-Za-z_]+(/[A-Za-z0-9_+-]+){0,2}$');

-- Lien utilisateur ↔ salarié (portée « self » : consulter SES propres événements).
ALTER TABLE core.employees ADD COLUMN user_id uuid,
  ADD CONSTRAINT employees_user_fk FOREIGN KEY (tenant_id, user_id)
    REFERENCES admin.users (tenant_id, id);
CREATE UNIQUE INDEX employees_user_unique ON core.employees (tenant_id, user_id)
  WHERE user_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Modèles d'horaires : fixes ou rotations, portés par des VERSIONS datées.
-- ---------------------------------------------------------------------------
CREATE TABLE time.schedule_models (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES admin.tenants(id),
  code       text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,29}$'),
  label_fr   text NOT NULL CHECK (char_length(label_fr) BETWEEN 1 AND 200),
  label_en   text NOT NULL CHECK (char_length(label_en) BETWEEN 1 AND 200),
  kind       text NOT NULL CHECK (kind IN ('fixed', 'rotation')),
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);
CREATE TRIGGER trg_schedule_models_touch BEFORE UPDATE ON time.schedule_models
  FOR EACH ROW EXECUTE FUNCTION admin.touch_updated_at();

-- Versions : APPEND-ONLY, à date d'effet strictement croissante et jamais passée
-- (sauf la PREMIÈRE version, libre — mise en place initiale d'un horaire existant).
CREATE TABLE time.schedule_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  model_id       uuid NOT NULL,
  version        int  NOT NULL CHECK (version >= 1),
  effective_from date NOT NULL,
  cycle_days     int  NOT NULL CHECK (cycle_days BETWEEN 1 AND 42),
  notes          text CHECK (notes IS NULL OR char_length(notes) <= 500),
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, model_id, version),
  UNIQUE (tenant_id, model_id, effective_from),
  FOREIGN KEY (tenant_id, model_id) REFERENCES time.schedule_models (tenant_id, id)
);

CREATE FUNCTION time.guard_schedule_version_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  last_from date;
  last_ver  int;
BEGIN
  SELECT max(effective_from), max(version) INTO last_from, last_ver
    FROM time.schedule_versions WHERE model_id = NEW.model_id;
  IF last_from IS NOT NULL THEN
    -- Le PASSÉ est figé : toute évolution est une version FUTURE (ou du jour),
    -- postérieure à la dernière date d'effet connue.
    IF NEW.effective_from < current_date THEN
      RAISE EXCEPTION 'version d''horaire dans le passé interdite : le planning passé est immuable'
        USING ERRCODE = 'raise_exception';
    END IF;
    IF NEW.effective_from <= last_from THEN
      RAISE EXCEPTION 'date d''effet % non postérieure à la dernière version (%)', NEW.effective_from, last_from
        USING ERRCODE = 'raise_exception';
    END IF;
    IF NEW.version <> last_ver + 1 THEN
      RAISE EXCEPTION 'numéro de version attendu : %', last_ver + 1 USING ERRCODE = 'raise_exception';
    END IF;
  ELSIF NEW.version <> 1 THEN
    RAISE EXCEPTION 'première version d''un modèle : version = 1' USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_schedule_versions_guard BEFORE INSERT ON time.schedule_versions
  FOR EACH ROW EXECUTE FUNCTION time.guard_schedule_version_insert();
CREATE TRIGGER trg_schedule_versions_immutable BEFORE UPDATE OR DELETE ON time.schedule_versions
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

-- Jours du cycle : travail ou repos, plages en minutes, pause planifiée facultative.
-- end_minute ≤ start_minute + 1440 : une plage ne peut JAMAIS excéder 24 h ni être
-- ambiguë — la traversée de minuit est end_minute > 1440, un fait, pas une convention.
CREATE TABLE time.schedule_version_days (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  version_id         uuid NOT NULL,
  day_index          int  NOT NULL CHECK (day_index BETWEEN 0 AND 41),
  is_rest            boolean NOT NULL DEFAULT false,
  start_minute       int CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute         int,
  break_start_minute int,
  break_end_minute   int,
  label              text CHECK (label IS NULL OR char_length(label) <= 100),
  UNIQUE (tenant_id, version_id, day_index),
  FOREIGN KEY (tenant_id, version_id) REFERENCES time.schedule_versions (tenant_id, id),
  CONSTRAINT day_shape CHECK (
    (is_rest AND start_minute IS NULL AND end_minute IS NULL
             AND break_start_minute IS NULL AND break_end_minute IS NULL)
    OR
    (NOT is_rest AND start_minute IS NOT NULL AND end_minute IS NOT NULL
                 AND end_minute > start_minute AND end_minute <= start_minute + 1440)
  ),
  CONSTRAINT break_shape CHECK (
    (break_start_minute IS NULL AND break_end_minute IS NULL)
    OR (break_start_minute IS NOT NULL AND break_end_minute IS NOT NULL
        AND break_start_minute >= start_minute AND break_end_minute > break_start_minute
        AND break_end_minute <= end_minute)
  )
);
CREATE TRIGGER trg_schedule_version_days_immutable BEFORE UPDATE OR DELETE ON time.schedule_version_days
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

-- ---------------------------------------------------------------------------
-- Affectation DATÉE d'un salarié à un modèle d'horaire.
-- anchor_date = jour 0 du cycle (rotations) ; UN SEUL horaire par salarié et par
-- période : le chevauchement est rejeté par PostgreSQL (contrainte d'exclusion).
-- close-only : on CLÔT une affectation, on ne la réécrit pas ; changement futur
-- d'horaire = clôture + nouvelle ligne à date d'effet future.
-- ---------------------------------------------------------------------------
CREATE TABLE time.employee_schedules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  employee_id    uuid NOT NULL,
  model_id       uuid NOT NULL,
  anchor_date    date NOT NULL,
  effective_from date NOT NULL,
  effective_to   date CHECK (effective_to IS NULL OR effective_to >= effective_from),
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES core.employees (tenant_id, id),
  FOREIGN KEY (tenant_id, model_id)    REFERENCES time.schedule_models (tenant_id, id),
  CONSTRAINT employee_schedule_no_overlap EXCLUDE USING gist (
    employee_id WITH =,
    daterange(effective_from, effective_to, '[)') WITH &&
  )
);
CREATE INDEX employee_schedules_emp_idx ON time.employee_schedules (tenant_id, employee_id, effective_from);
CREATE TRIGGER trg_employee_schedules_close_only BEFORE UPDATE ON time.employee_schedules
  FOR EACH ROW EXECUTE FUNCTION org.guard_period_close_only();
CREATE TRIGGER trg_employee_schedules_nodelete BEFORE DELETE ON time.employee_schedules
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

-- Exceptions de planning, individuelles OU collectives (site/unité/société), datées.
-- EXACTEMENT une cible ; kind 'closed'/'rest' = pas de travail ce jour, 'special_hours'
-- = plage dérogatoire (mêmes règles de représentation que les jours de cycle).
CREATE TABLE time.schedule_exceptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  exception_date date NOT NULL,
  employee_id   uuid,
  unit_id       uuid,
  site_id       uuid,
  company_id    uuid,
  kind          text NOT NULL CHECK (kind IN ('closed', 'rest', 'special_hours')),
  start_minute  int CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute    int,
  label_fr      text NOT NULL CHECK (char_length(label_fr) BETWEEN 1 AND 200),
  label_en      text NOT NULL CHECK (char_length(label_en) BETWEEN 1 AND 200),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES core.employees (tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id)     REFERENCES org.units (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id)     REFERENCES org.sites (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id)  REFERENCES org.companies (tenant_id, id),
  CONSTRAINT exception_one_target CHECK (
    (employee_id IS NOT NULL)::int + (unit_id IS NOT NULL)::int
    + (site_id IS NOT NULL)::int + (company_id IS NOT NULL)::int = 1
  ),
  CONSTRAINT exception_hours_shape CHECK (
    (kind <> 'special_hours' AND start_minute IS NULL AND end_minute IS NULL)
    OR (kind = 'special_hours' AND start_minute IS NOT NULL AND end_minute IS NOT NULL
        AND end_minute > start_minute AND end_minute <= start_minute + 1440)
  )
);
CREATE INDEX schedule_exceptions_date_idx ON time.schedule_exceptions (tenant_id, exception_date);
CREATE TRIGGER trg_schedule_exceptions_touch BEFORE UPDATE ON time.schedule_exceptions
  FOR EACH ROW EXECUTE FUNCTION admin.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Jours fériés : calendriers à portée (tenant, société, site ou unité), VERSIONNÉS —
-- les lignes ne sont JAMAIS supprimées : retrait = status 'retired' (audité), le
-- moteur E10.2 fige de toute façon les paramètres applicables au jour calculé.
-- ---------------------------------------------------------------------------
CREATE TABLE time.holiday_calendars (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES admin.tenants(id),
  code       text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,29}$'),
  label_fr   text NOT NULL CHECK (char_length(label_fr) BETWEEN 1 AND 200),
  label_en   text NOT NULL CHECK (char_length(label_en) BETWEEN 1 AND 200),
  company_id uuid,
  site_id    uuid,
  unit_id    uuid,
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES org.companies (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id)    REFERENCES org.sites (tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id)    REFERENCES org.units (tenant_id, id),
  CONSTRAINT calendar_scope CHECK (
    (company_id IS NOT NULL)::int + (site_id IS NOT NULL)::int + (unit_id IS NOT NULL)::int <= 1
  )
);
CREATE TRIGGER trg_holiday_calendars_touch BEFORE UPDATE ON time.holiday_calendars
  FOR EACH ROW EXECUTE FUNCTION admin.touch_updated_at();

CREATE TABLE time.holidays (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  calendar_id  uuid NOT NULL,
  holiday_date date NOT NULL,
  label_fr     text NOT NULL CHECK (char_length(label_fr) BETWEEN 1 AND 200),
  label_en     text NOT NULL CHECK (char_length(label_en) BETWEEN 1 AND 200),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, calendar_id, holiday_date),
  FOREIGN KEY (tenant_id, calendar_id) REFERENCES time.holiday_calendars (tenant_id, id)
);
CREATE TRIGGER trg_holidays_touch BEFORE UPDATE ON time.holidays
  FOR EACH ROW EXECUTE FUNCTION admin.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Dispositifs et correspondances d'identifiants externes.
-- Un identifiant externe ne relie JAMAIS un pointage au salarié d'un autre tenant :
-- la correspondance est une table du tenant (RLS) avec FK composites.
-- ---------------------------------------------------------------------------
CREATE TABLE time.devices (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES admin.tenants(id),
  code       text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,29}$'),
  label      text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 200),
  kind       text NOT NULL CHECK (kind IN ('clock', 'csv', 'xlsx', 'manual', 'api', 'external')),
  site_id    uuid,
  time_zone  text CHECK (time_zone IS NULL OR time_zone ~ '^[A-Za-z_]+(/[A-Za-z0-9_+-]+){0,2}$'),
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'retired')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES org.sites (tenant_id, id)
);
CREATE TRIGGER trg_devices_touch BEFORE UPDATE ON time.devices
  FOR EACH ROW EXECUTE FUNCTION admin.touch_updated_at();

CREATE TABLE time.employee_device_ids (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  external_id text NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 100),
  employee_id uuid NOT NULL,
  device_id   uuid,          -- NULL = valable pour toute source du tenant
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES core.employees (tenant_id, id),
  FOREIGN KEY (tenant_id, device_id)   REFERENCES time.devices (tenant_id, id)
);
CREATE UNIQUE INDEX employee_device_ids_dev_unique ON time.employee_device_ids
  (tenant_id, device_id, external_id) WHERE device_id IS NOT NULL AND status = 'active';
CREATE UNIQUE INDEX employee_device_ids_any_unique ON time.employee_device_ids
  (tenant_id, external_id) WHERE device_id IS NULL AND status = 'active';
CREATE TRIGGER trg_employee_device_ids_touch BEFORE UPDATE ON time.employee_device_ids
  FOR EACH ROW EXECUTE FUNCTION admin.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Lots d'import : chaque arrivée de pointages (fichier, saisie, API) est un LOT
-- tracé avec ses compteurs et son rapport d'erreurs par ligne. Le fichier original
-- peut être conservé (référence documentaire) — JAMAIS exposé sans permission.
-- ---------------------------------------------------------------------------
CREATE TABLE time.punch_batches (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES admin.tenants(id),
  source            text NOT NULL CHECK (source IN ('csv', 'xlsx', 'manual', 'api', 'external')),
  filename          text CHECK (filename IS NULL OR char_length(filename) <= 300),
  file_sha256       text CHECK (file_sha256 IS NULL OR file_sha256 ~ '^[0-9a-f]{64}$'),
  file_size         int CHECK (file_size IS NULL OR file_size >= 0),
  file_bytes        bytea,       -- référence documentaire, accès gardé par permission
  -- La PRÉVISUALISATION n'écrit RIEN : un lot n'existe qu'à l'application (réussie,
  -- partielle explicite, ou rejetée — le rejet aussi laisse sa trace).
  atomic            boolean NOT NULL DEFAULT true,
  status            text NOT NULL CHECK (status IN ('applied', 'partial', 'rejected')),
  default_site_id   uuid,
  default_device_id uuid,
  column_mapping    jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(column_mapping) = 'object'),
  lines_received    int NOT NULL DEFAULT 0,
  lines_accepted    int NOT NULL DEFAULT 0,
  lines_duplicated  int NOT NULL DEFAULT 0,
  lines_rejected    int NOT NULL DEFAULT 0,
  lines_unmatched   int NOT NULL DEFAULT 0,
  error_report      jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(error_report) = 'array'),
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, default_site_id)   REFERENCES org.sites (tenant_id, id),
  FOREIGN KEY (tenant_id, default_device_id) REFERENCES time.devices (tenant_id, id)
);
CREATE INDEX punch_batches_created_idx ON time.punch_batches (tenant_id, created_at DESC);
CREATE TRIGGER trg_punch_batches_nodelete BEFORE DELETE ON time.punch_batches
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

-- ---------------------------------------------------------------------------
-- REGISTRE BRUT — APPEND-ONLY ABSOLU.
-- Chaque ligne est le fait source VERBATIM (horodatage texte d'origine conservé).
-- Déduplication IDEMPOTENTE par empreinte canonique : rejouer le même fichier, ou
-- recevoir le même événement par deux fichiers, ne crée qu'UNE ligne logique.
-- ---------------------------------------------------------------------------
CREATE TABLE time.raw_punches (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL,
  batch_id             uuid NOT NULL,
  line_no              int CHECK (line_no IS NULL OR line_no >= 1),
  device_id            uuid,
  device_ref           text CHECK (device_ref IS NULL OR char_length(device_ref) <= 100),
  site_id              uuid,
  external_employee_id text NOT NULL CHECK (char_length(external_employee_id) BETWEEN 1 AND 100),
  source_datetime_raw  text NOT NULL CHECK (char_length(source_datetime_raw) BETWEEN 1 AND 60),
  source_tz            text CHECK (source_tz IS NULL OR source_tz ~ '^[A-Za-z_]+(/[A-Za-z0-9_+-]+){0,2}$'),
  event_type_raw       text CHECK (event_type_raw IS NULL OR char_length(event_type_raw) <= 30),
  external_unique_id   text CHECK (external_unique_id IS NULL OR char_length(external_unique_id) <= 120),
  fingerprint          text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  received_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, fingerprint),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, batch_id)  REFERENCES time.punch_batches (tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES time.devices (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id)   REFERENCES org.sites (tenant_id, id)
);
CREATE UNIQUE INDEX raw_punches_external_unique ON time.raw_punches
  (tenant_id, device_id, external_unique_id) WHERE external_unique_id IS NOT NULL;
CREATE INDEX raw_punches_batch_idx ON time.raw_punches (tenant_id, batch_id, line_no);
CREATE TRIGGER trg_raw_punches_immutable BEFORE UPDATE OR DELETE ON time.raw_punches
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

-- ---------------------------------------------------------------------------
-- ÉVÉNEMENTS NORMALISÉS — dérivés 1:1 du brut, RECALCULABLES (la renormalisation
-- après ajout d'une correspondance met à jour CES lignes, jamais le brut).
-- ---------------------------------------------------------------------------
CREATE TABLE time.punch_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  raw_punch_id   uuid NOT NULL,
  employee_id    uuid,
  assignment_id  uuid,
  site_id        uuid,
  device_id      uuid,
  tz             text NOT NULL,
  occurred_at    timestamptz,
  local_date     date,
  local_time     time,
  event_type     text NOT NULL DEFAULT 'unknown'
                 CHECK (event_type IN ('in', 'out', 'break_start', 'break_end', 'unknown')),
  match_status   text NOT NULL CHECK (match_status IN (
                   'matched', 'unmatched_employee', 'inactive_employee', 'not_yet_hired',
                   'no_assignment', 'invalid_datetime', 'ambiguous_datetime')),
  note           text CHECK (note IS NULL OR char_length(note) <= 300),
  normalized_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, raw_punch_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, raw_punch_id)  REFERENCES time.raw_punches (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id)   REFERENCES core.employees (tenant_id, id),
  FOREIGN KEY (tenant_id, assignment_id) REFERENCES core.employee_assignments (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id)       REFERENCES org.sites (tenant_id, id),
  FOREIGN KEY (tenant_id, device_id)     REFERENCES time.devices (tenant_id, id)
);
CREATE INDEX punch_events_emp_idx   ON time.punch_events (tenant_id, employee_id, local_date);
CREATE INDEX punch_events_match_idx ON time.punch_events (tenant_id, match_status) WHERE match_status <> 'matched';
CREATE TRIGGER trg_punch_events_nodelete BEFORE DELETE ON time.punch_events
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

-- ---------------------------------------------------------------------------
-- Permissions distinctes (RBAC E2 ; les portées réelles s'appuient sur E8/E9).
-- ---------------------------------------------------------------------------
-- Catalogue module.action (contrainte : deux segments) — module « time ».
INSERT INTO admin.permissions (key, description) VALUES
  ('time.schedules_view',    'Consulter modèles d''horaires, rotations, affectations, fériés et exceptions'),
  ('time.schedules_manage',  'Administrer modèles, versions, fériés et exceptions — audité'),
  ('time.schedules_assign',  'Affecter un horaire à un salarié ou à une unité — audité'),
  ('time.punches_import',    'Importer des pointages (CSV/Excel/saisie manuelle) — audité'),
  ('time.punches_view',      'Consulter pointages bruts et événements normalisés de sa portée'),
  ('time.punches_view_errors', 'Consulter lots d''import et rapports d''erreurs'),
  ('time.punches_view_own',  'Consulter ses propres événements de pointage'),
  ('time.devices_manage',    'Gérer dispositifs de pointage et correspondances d''identifiants — audité')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- RLS + privilèges. Aucun DELETE nulle part ; le brut est INSERT-only.
-- ---------------------------------------------------------------------------
ALTER TABLE time.schedule_models      ENABLE ROW LEVEL SECURITY;
ALTER TABLE time.schedule_versions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE time.schedule_version_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE time.employee_schedules   ENABLE ROW LEVEL SECURITY;
ALTER TABLE time.schedule_exceptions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE time.holiday_calendars    ENABLE ROW LEVEL SECURITY;
ALTER TABLE time.holidays             ENABLE ROW LEVEL SECURITY;
ALTER TABLE time.devices              ENABLE ROW LEVEL SECURITY;
ALTER TABLE time.employee_device_ids  ENABLE ROW LEVEL SECURITY;
ALTER TABLE time.punch_batches        ENABLE ROW LEVEL SECURITY;
ALTER TABLE time.raw_punches          ENABLE ROW LEVEL SECURITY;
ALTER TABLE time.punch_events         ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_rows ON time.schedule_models TO kora_app
  USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON time.schedule_versions TO kora_app
  USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON time.schedule_version_days TO kora_app
  USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON time.employee_schedules TO kora_app
  USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON time.schedule_exceptions TO kora_app
  USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON time.holiday_calendars TO kora_app
  USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON time.holidays TO kora_app
  USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON time.devices TO kora_app
  USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON time.employee_device_ids TO kora_app
  USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON time.punch_batches TO kora_app
  USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON time.raw_punches TO kora_app
  USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON time.punch_events TO kora_app
  USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());

GRANT USAGE ON SCHEMA time TO kora_app;
GRANT SELECT, INSERT, UPDATE ON time.schedule_models       TO kora_app;
GRANT SELECT, INSERT         ON time.schedule_versions     TO kora_app;  -- append-only
GRANT SELECT, INSERT         ON time.schedule_version_days TO kora_app;  -- append-only
GRANT SELECT, INSERT, UPDATE ON time.employee_schedules    TO kora_app;  -- close-only (trigger)
GRANT SELECT, INSERT, UPDATE ON time.schedule_exceptions   TO kora_app;
GRANT SELECT, INSERT, UPDATE ON time.holiday_calendars     TO kora_app;
GRANT SELECT, INSERT, UPDATE ON time.holidays              TO kora_app;
GRANT SELECT, INSERT, UPDATE ON time.devices               TO kora_app;
GRANT SELECT, INSERT, UPDATE ON time.employee_device_ids   TO kora_app;
GRANT SELECT, INSERT, UPDATE ON time.punch_batches         TO kora_app;  -- statut/compteurs (jamais DELETE)
GRANT SELECT, INSERT         ON time.raw_punches           TO kora_app;  -- APPEND-ONLY absolu
GRANT SELECT, INSERT, UPDATE ON time.punch_events          TO kora_app;  -- renormalisation
