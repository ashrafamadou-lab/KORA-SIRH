-- 0018 — Temps & pointage, tranche E10.3 : corrections, workflow, clôture, préparation paie.
-- Réf : Blueprint §14, PRD US-E10. Principes portés ICI :
--  - une correction ne REMPLACE JAMAIS le brut : elle est une DEMANDE versionnée,
--    approuvée via E3, puis une SURCOUCHE append-only (time.correction_events)
--    consommée par le recalcul E10.2 — bruts, événements normalisés, anciennes
--    versions de résultats, paramètres et décisions de workflow restent intacts ;
--  - ANTI DOUBLE APPLICATION PAR LA BASE : une demande ne peut produire qu'UN SEUL
--    événement correctif (contrainte UNIQUE) — une approbation rejouée est inerte ;
--  - une anomalie ne passe à « resolved » QUE référencée : correction appliquée
--    (événement correctif lié) ou classement motivé — le trigger l'impose ;
--  - PÉRIODES : une seule période active compatible par périmètre et intervalle
--    (contrainte d'exclusion) ; une période verrouillée/clôturée REFUSE toute
--    écriture de résultat ou de correction PAR LA BASE (trigger) ;
--  - CLÔTURES VERSIONNÉES : chaque clôture fige les résultats retenus (lignes),
--    les totaux préparatoires paie et une EMPREINTE reproductible ; une
--    réouverture n'efface jamais — la clôture précédente devient « superseded » ;
--  - EXPORTS PAIE : contenu immuable, schéma versionné, révisions explicites,
--    un export remplacé est MARQUÉ, jamais supprimé ;
--  - AUCUN taux, AUCUN montant : variables temps PRÉPARATOIRES uniquement.

-- ---------------------------------------------------------------------------
-- Demandes de correction — versionnées, à états contrôlés.
-- ---------------------------------------------------------------------------
CREATE TABLE time.correction_requests (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES admin.tenants(id),
  employee_id          uuid NOT NULL,
  work_date            date NOT NULL,
  kind                 text NOT NULL CHECK (kind IN (
                         'add_in', 'add_out', 'fix_type', 'exclude_event', 'reattach_event',
                         'fix_site_device', 'justify_absence', 'justify_late',
                         'justify_early_departure', 'offsite_presence',
                         'reference_correction', 'import_historical')),
  origin               text NOT NULL CHECK (origin IN ('self', 'manager', 'hr', 'admin', 'auto_anomaly', 'import')),
  status               text NOT NULL DEFAULT 'draft' CHECK (status IN (
                         'draft', 'submitted', 'returned', 'cancelled', 'rejected',
                         'approved', 'applied', 'application_failed')),
  version              int  NOT NULL DEFAULT 1 CHECK (version >= 1),
  requester_user_id    uuid NOT NULL,
  motive               text NOT NULL CHECK (char_length(motive) BETWEEN 1 AND 500),
  -- Proposition NORMALISÉE (valeurs avant/après incluses) — jamais appliquée telle
  -- quelle : l'application passe par l'événement correctif approuvé.
  payload              jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload) = 'object'),
  before_snapshot      jsonb,
  after_snapshot       jsonb,
  anomaly_id           uuid,
  workflow_instance_id uuid,
  applied_event_id     uuid,
  application_error    text CHECK (application_error IS NULL OR char_length(application_error) <= 500),
  submitted_at         timestamptz,
  decided_at           timestamptz,
  applied_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES core.employees (tenant_id, id),
  FOREIGN KEY (tenant_id, anomaly_id)  REFERENCES time.day_anomalies (tenant_id, id)
);
CREATE INDEX correction_requests_emp_idx    ON time.correction_requests (tenant_id, employee_id, work_date);
CREATE INDEX correction_requests_status_idx ON time.correction_requests (tenant_id, status, created_at DESC);

-- Machine à états + immuabilité après soumission : le CONTENU (payload, motive,
-- work_date, kind) n'est modifiable qu'en 'draft' ou 'returned', et toute
-- resoumission INCRÉMENTE la version — la décision E3 est liée à la version exacte.
CREATE FUNCTION time.guard_correction_request_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> OLD.status THEN
    IF NOT (
      (OLD.status = 'draft'              AND NEW.status IN ('submitted', 'cancelled')) OR
      (OLD.status = 'submitted'          AND NEW.status IN ('approved', 'rejected', 'returned', 'cancelled')) OR
      (OLD.status = 'returned'           AND NEW.status IN ('submitted', 'cancelled')) OR
      (OLD.status = 'approved'           AND NEW.status IN ('applied', 'application_failed')) OR
      (OLD.status = 'application_failed' AND NEW.status = 'applied')
    ) THEN
      RAISE EXCEPTION 'transition de demande interdite : % -> %', OLD.status, NEW.status
        USING ERRCODE = 'raise_exception';
    END IF;
    IF OLD.status = 'returned' AND NEW.status = 'submitted' AND NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'resoumission : la version doit être incrémentée (attendu %)', OLD.version + 1
        USING ERRCODE = 'raise_exception';
    END IF;
  ELSIF NEW.version <> OLD.version THEN
    RAISE EXCEPTION 'la version ne change qu''à la resoumission' USING ERRCODE = 'raise_exception';
  END IF;
  -- Contenu figé hors brouillon/retour.
  IF OLD.status NOT IN ('draft', 'returned')
     AND (NEW.payload IS DISTINCT FROM OLD.payload
       OR NEW.motive IS DISTINCT FROM OLD.motive
       OR NEW.work_date IS DISTINCT FROM OLD.work_date
       OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.employee_id IS DISTINCT FROM OLD.employee_id) THEN
    RAISE EXCEPTION 'demande soumise : contenu FIGÉ — toute modification passe par un retour puis une resoumission versionnée'
      USING ERRCODE = 'raise_exception';
  END IF;
  NEW.updated_at = now();
  RETURN NEW;
END $$;
CREATE TRIGGER trg_correction_requests_guard BEFORE UPDATE ON time.correction_requests
  FOR EACH ROW EXECUTE FUNCTION time.guard_correction_request_update();
CREATE TRIGGER trg_correction_requests_nodelete BEFORE DELETE ON time.correction_requests
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

-- ---------------------------------------------------------------------------
-- Événements correctifs — la SURCOUCHE append-only consommée par le moteur.
-- ---------------------------------------------------------------------------
CREATE TABLE time.correction_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  request_id   uuid NOT NULL,
  employee_id  uuid NOT NULL,
  work_date    date NOT NULL,
  kind         text NOT NULL CHECK (kind IN (
                 'add_in', 'add_out', 'fix_type', 'exclude_event', 'reattach_event',
                 'fix_site_device', 'justify_absence', 'justify_late',
                 'justify_early_departure', 'offsite_presence', 'reference_correction')),
  -- Effet NORMALISÉ : { addEvent:{localMinute,type,siteId?} } | { excludeEventId }
  -- | { retype:{eventId,type} } | { reattach:{eventId,targetDate} }
  -- | { overrideSite:{eventId,siteId} } | { justify:{target,category,minutes?} }
  -- | { offsite:{category,startMinute?,endMinute?} } | { reference:{...} }
  effect       jsonb NOT NULL CHECK (jsonb_typeof(effect) = 'object'),
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  -- LA garantie : une demande = AU PLUS un événement correctif. Une approbation
  -- rejouée, un double clic, deux workers — la base ne laisse passer qu'UNE application.
  UNIQUE (tenant_id, request_id),
  FOREIGN KEY (tenant_id, request_id)  REFERENCES time.correction_requests (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES core.employees (tenant_id, id)
);
CREATE INDEX correction_events_emp_idx ON time.correction_events (tenant_id, employee_id, work_date);
CREATE TRIGGER trg_correction_events_frozen BEFORE UPDATE OR DELETE ON time.correction_events
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

-- Le lien demande → événement appliqué (posé à l'application).
ALTER TABLE time.correction_requests
  ADD CONSTRAINT correction_requests_applied_event_fk
  FOREIGN KEY (tenant_id, applied_event_id) REFERENCES time.correction_events (tenant_id, id);

-- ---------------------------------------------------------------------------
-- Pièces justificatives — métadonnées + contenu, accès contrôlé, suppression LOGIQUE.
-- ---------------------------------------------------------------------------
CREATE TABLE time.correction_attachments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  request_id  uuid NOT NULL,
  filename    text NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 200),
  mime        text NOT NULL CHECK (mime IN ('application/pdf', 'image/png', 'image/jpeg')),
  byte_size   int  NOT NULL CHECK (byte_size BETWEEN 1 AND 5000000),
  sha256      char(64) NOT NULL,
  -- Pièce SENSIBLE (médicale…) : cloisonnée — jamais de détail dans les listes
  -- générales ; l'administration du temps ne voit que l'existence d'un justificatif.
  sensitive   boolean NOT NULL DEFAULT false,
  content     bytea NOT NULL,
  -- Analyse antivirus EXTENSIBLE : transport simulé assumé à ce stade (README).
  av_status   text NOT NULL DEFAULT 'skipped' CHECK (av_status IN ('skipped', 'pending', 'clean', 'infected')),
  uploaded_by uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, request_id) REFERENCES time.correction_requests (tenant_id, id)
);
CREATE INDEX correction_attachments_req_idx ON time.correction_attachments (tenant_id, request_id);

-- Seuls l'état antivirus et la suppression logique sont mutables ; jamais de DELETE.
CREATE FUNCTION time.guard_attachment_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF to_jsonb(NEW) - 'av_status' - 'deleted_at'
     IS DISTINCT FROM to_jsonb(OLD) - 'av_status' - 'deleted_at' THEN
    RAISE EXCEPTION 'pièce justificative : contenu et métadonnées FIGÉS (seuls av_status et deleted_at évoluent)'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_correction_attachments_guard BEFORE UPDATE ON time.correction_attachments
  FOR EACH ROW EXECUTE FUNCTION time.guard_attachment_update();
CREATE TRIGGER trg_correction_attachments_nodelete BEFORE DELETE ON time.correction_attachments
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

-- Journal des CONSULTATIONS de pièces (qui a vu quoi, quand) — append-only.
CREATE TABLE time.attachment_access_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  attachment_id uuid NOT NULL,
  viewed_by     uuid NOT NULL,
  viewed_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, attachment_id) REFERENCES time.correction_attachments (tenant_id, id)
);
CREATE INDEX attachment_access_log_idx ON time.attachment_access_log (tenant_id, attachment_id, viewed_at DESC);
CREATE TRIGGER trg_attachment_access_log_frozen BEFORE UPDATE OR DELETE ON time.attachment_access_log
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

-- ---------------------------------------------------------------------------
-- Anomalies (extension E10.3) : affectation, échéance, résolution RÉFÉRENCÉE.
-- ---------------------------------------------------------------------------
ALTER TABLE time.day_anomalies
  ADD COLUMN assigned_to         uuid,
  ADD COLUMN due_at              timestamptz,
  ADD COLUMN resolution_kind     text CHECK (resolution_kind IS NULL OR resolution_kind IN ('correction_applied', 'classified')),
  ADD COLUMN resolution_event_id uuid;
ALTER TABLE time.day_anomalies
  ADD CONSTRAINT day_anomalies_resolution_event_fk
  FOREIGN KEY (tenant_id, resolution_event_id) REFERENCES time.correction_events (tenant_id, id);

-- Nouvelle machine à états : « resolved » N'EXISTE qu'avec une référence probante —
-- correction appliquée (événement correctif lié) ou classement explicitement motivé.
-- Réouverture contrôlée depuis resolved. Jamais de résolution silencieuse.
CREATE OR REPLACE FUNCTION time.guard_anomaly_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF to_jsonb(NEW) - 'state' - 'state_note' - 'state_by' - 'state_at'
       - 'assigned_to' - 'due_at' - 'resolution_kind' - 'resolution_event_id'
     IS DISTINCT FROM
     to_jsonb(OLD) - 'state' - 'state_note' - 'state_by' - 'state_at'
       - 'assigned_to' - 'due_at' - 'resolution_kind' - 'resolution_event_id' THEN
    RAISE EXCEPTION 'anomalie : seuls état, note, affectation, échéance et référence de résolution sont modifiables'
      USING ERRCODE = 'raise_exception';
  END IF;
  IF NEW.state <> OLD.state THEN
    IF NOT (
      (OLD.state = 'open'         AND NEW.state IN ('acknowledged', 'dismissed', 'resolved')) OR
      (OLD.state = 'acknowledged' AND NEW.state IN ('dismissed', 'open', 'resolved')) OR
      (OLD.state = 'dismissed'    AND NEW.state = 'open') OR
      (OLD.state = 'resolved'     AND NEW.state = 'open')
    ) THEN
      RAISE EXCEPTION 'transition d''état d''anomalie interdite : % -> %', OLD.state, NEW.state
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;
  IF NEW.state = 'resolved' THEN
    IF NOT (
      (NEW.resolution_kind = 'correction_applied' AND NEW.resolution_event_id IS NOT NULL) OR
      (NEW.resolution_kind = 'classified' AND NEW.state_note IS NOT NULL AND char_length(NEW.state_note) > 0)
    ) THEN
      RAISE EXCEPTION 'résolution sans référence probante interdite : correction appliquée (événement lié) ou classement motivé'
        USING ERRCODE = 'raise_exception';
    END IF;
  ELSE
    -- Hors resolved, aucune référence de résolution ne subsiste (réouverture = purge).
    IF NEW.resolution_kind IS NOT NULL OR NEW.resolution_event_id IS NOT NULL THEN
      RAISE EXCEPTION 'référence de résolution réservée à l''état resolved' USING ERRCODE = 'raise_exception';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Résultats journaliers : colonnes de JUSTIFICATION (versions nouvelles seulement —
-- le contenu des versions existantes reste figé par le trigger E10.2).
-- ---------------------------------------------------------------------------
ALTER TABLE time.day_results
  ADD COLUMN justified_category text CHECK (justified_category IS NULL OR char_length(justified_category) <= 50),
  ADD COLUMN justified_minutes  int NOT NULL DEFAULT 0 CHECK (justified_minutes >= 0),
  ADD COLUMN late_justified     boolean NOT NULL DEFAULT false,
  ADD COLUMN early_justified    boolean NOT NULL DEFAULT false,
  ADD COLUMN corrections_applied int NOT NULL DEFAULT 0 CHECK (corrections_applied >= 0);

-- ---------------------------------------------------------------------------
-- Périodes de présence — UNE SEULE période active compatible par périmètre.
-- ---------------------------------------------------------------------------
CREATE TABLE time.periods (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES admin.tenants(id),
  scope_kind   text NOT NULL CHECK (scope_kind IN ('tenant', 'company', 'site')),
  company_id   uuid,
  site_id      uuid,
  label        text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 100),
  period_start date NOT NULL,
  period_end   date NOT NULL CHECK (period_end >= period_start),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN (
                 'open', 'in_review', 'locked', 'closed', 'reopened', 'archived')),
  revision     int NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES org.companies (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id)    REFERENCES org.sites (tenant_id, id),
  CONSTRAINT period_scope_shape CHECK (
    (scope_kind = 'tenant'  AND company_id IS NULL AND site_id IS NULL) OR
    (scope_kind = 'company' AND company_id IS NOT NULL AND site_id IS NULL) OR
    (scope_kind = 'site'    AND site_id IS NOT NULL AND company_id IS NULL)
  ),
  -- Une seule période NON ARCHIVÉE par périmètre et intervalle — par la base.
  CONSTRAINT periods_no_overlap EXCLUDE USING gist (
    tenant_id WITH =,
    scope_kind WITH =,
    COALESCE(company_id, '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
    COALESCE(site_id,    '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
    daterange(period_start, period_end, '[]') WITH &&
  ) WHERE (status <> 'archived')
);
CREATE INDEX periods_tenant_idx ON time.periods (tenant_id, status, period_start);

-- Cycle de vie contrôlé ; la réouverture INCRÉMENTE la révision ; bornes immuables.
CREATE FUNCTION time.guard_period_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.period_start <> OLD.period_start OR NEW.period_end <> OLD.period_end
     OR NEW.scope_kind <> OLD.scope_kind
     OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.site_id IS DISTINCT FROM OLD.site_id THEN
    RAISE EXCEPTION 'période : périmètre et bornes IMMUABLES' USING ERRCODE = 'raise_exception';
  END IF;
  IF NEW.status <> OLD.status THEN
    IF NOT (
      (OLD.status = 'open'      AND NEW.status = 'in_review') OR
      (OLD.status = 'in_review' AND NEW.status IN ('open', 'locked')) OR
      (OLD.status = 'locked'    AND NEW.status IN ('in_review', 'closed')) OR
      (OLD.status = 'closed'    AND NEW.status IN ('reopened', 'archived')) OR
      (OLD.status = 'reopened'  AND NEW.status IN ('in_review', 'locked'))
    ) THEN
      RAISE EXCEPTION 'transition de période interdite : % -> %', OLD.status, NEW.status
        USING ERRCODE = 'raise_exception';
    END IF;
    IF OLD.status = 'closed' AND NEW.status = 'reopened' AND NEW.revision <> OLD.revision + 1 THEN
      RAISE EXCEPTION 'réouverture : la révision doit être incrémentée (attendu %)', OLD.revision + 1
        USING ERRCODE = 'raise_exception';
    END IF;
  ELSIF NEW.revision <> OLD.revision THEN
    RAISE EXCEPTION 'la révision ne change qu''à la réouverture' USING ERRCODE = 'raise_exception';
  END IF;
  NEW.updated_at = now();
  RETURN NEW;
END $$;
CREATE TRIGGER trg_periods_guard BEFORE UPDATE ON time.periods
  FOR EACH ROW EXECUTE FUNCTION time.guard_period_update();
CREATE TRIGGER trg_periods_nodelete BEFORE DELETE ON time.periods
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

-- ---------------------------------------------------------------------------
-- Le VERROU DE PÉRIODE, par la base : une période verrouillée ou clôturée refuse
-- toute nouvelle version de résultat et tout événement correctif sur son périmètre.
-- (La réouverture — status 'reopened' — lève le verrou ; l'archivage le scelle.)
-- ---------------------------------------------------------------------------
CREATE FUNCTION time.assert_period_writable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  blocked text;
BEGIN
  SELECT p.status INTO blocked
    FROM time.periods p
   WHERE p.tenant_id = NEW.tenant_id
     AND p.status IN ('locked', 'closed', 'archived')
     AND NEW.work_date BETWEEN p.period_start AND p.period_end
     AND (p.scope_kind = 'tenant'
       OR EXISTS (SELECT 1 FROM core.employee_assignments a
                   WHERE a.tenant_id = NEW.tenant_id AND a.employee_id = NEW.employee_id AND a.is_primary
                     AND daterange(a.effective_from, a.effective_to, '[)') @> NEW.work_date
                     AND ((p.scope_kind = 'company' AND a.company_id = p.company_id)
                       OR (p.scope_kind = 'site'    AND a.site_id    = p.site_id))))
   LIMIT 1;
  IF blocked IS NOT NULL THEN
    RAISE EXCEPTION 'période % : écriture refusée sur la journée % (verrouillée pour clôture ou clôturée — réouverture contrôlée requise)',
      blocked, NEW.work_date USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_day_results_period_lock BEFORE INSERT ON time.day_results
  FOR EACH ROW EXECUTE FUNCTION time.assert_period_writable();
CREATE TRIGGER trg_correction_events_period_lock BEFORE INSERT ON time.correction_events
  FOR EACH ROW EXECUTE FUNCTION time.assert_period_writable();

-- ---------------------------------------------------------------------------
-- Clôtures — chaque clôture est une VERSION conservée, avec EMPREINTE.
-- ---------------------------------------------------------------------------
CREATE TABLE time.period_closes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  period_id       uuid NOT NULL,
  close_no        int  NOT NULL CHECK (close_no >= 1),
  period_revision int  NOT NULL,
  engine_version  text NOT NULL,
  params_snapshot jsonb NOT NULL DEFAULT '{}',
  dataset_sha256  char(64) NOT NULL,
  employees_count int NOT NULL DEFAULT 0,
  days_count      int NOT NULL DEFAULT 0,
  results_count   int NOT NULL DEFAULT 0,
  totals          jsonb NOT NULL DEFAULT '{}',
  warnings        jsonb NOT NULL DEFAULT '[]',
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded')),
  closed_by       uuid NOT NULL,
  closed_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, period_id, close_no),
  FOREIGN KEY (tenant_id, period_id) REFERENCES time.periods (tenant_id, id)
);
-- Contenu FIGÉ : seule la bascule active → superseded est permise.
CREATE FUNCTION time.guard_close_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (OLD.status = 'active' AND NEW.status = 'superseded') THEN
    RAISE EXCEPTION 'clôture : seule la bascule active -> superseded est permise' USING ERRCODE = 'raise_exception';
  END IF;
  IF to_jsonb(NEW) - 'status' IS DISTINCT FROM to_jsonb(OLD) - 'status' THEN
    RAISE EXCEPTION 'clôture : contenu FIGÉ' USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_period_closes_guard BEFORE UPDATE ON time.period_closes
  FOR EACH ROW EXECUTE FUNCTION time.guard_close_update();
CREATE TRIGGER trg_period_closes_nodelete BEFORE DELETE ON time.period_closes
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

-- Lignes retenues : QUELLE version de résultat la clôture a figée, jour par jour.
CREATE TABLE time.period_close_lines (
  tenant_id     uuid NOT NULL,
  close_id      uuid NOT NULL,
  employee_id   uuid NOT NULL,
  work_date     date NOT NULL,
  day_result_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, close_id, employee_id, work_date),
  FOREIGN KEY (tenant_id, close_id)      REFERENCES time.period_closes (tenant_id, id),
  FOREIGN KEY (tenant_id, day_result_id) REFERENCES time.day_results (tenant_id, id)
);
CREATE TRIGGER trg_period_close_lines_frozen BEFORE UPDATE OR DELETE ON time.period_close_lines
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

-- Totaux par salarié : les VARIABLES TEMPS PRÉPARATOIRES PAIE (aucun montant).
CREATE TABLE time.period_close_totals (
  tenant_id                  uuid NOT NULL,
  close_id                   uuid NOT NULL,
  employee_id                uuid NOT NULL,
  expected_days              int NOT NULL DEFAULT 0,
  present_days               int NOT NULL DEFAULT 0,
  unjustified_absence_days   int NOT NULL DEFAULT 0,
  justified                  jsonb NOT NULL DEFAULT '{}',
  late_minutes               int NOT NULL DEFAULT 0,
  early_departure_minutes    int NOT NULL DEFAULT 0,
  worked_minutes             int NOT NULL DEFAULT 0,
  night_minutes              int NOT NULL DEFAULT 0,
  rest_day_minutes           int NOT NULL DEFAULT 0,
  holiday_minutes            int NOT NULL DEFAULT 0,
  overtime_candidate_minutes int NOT NULL DEFAULT 0,
  corrections_applied        int NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, close_id, employee_id),
  FOREIGN KEY (tenant_id, close_id)    REFERENCES time.period_closes (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES core.employees (tenant_id, id)
);
CREATE TRIGGER trg_period_close_totals_frozen BEFORE UPDATE OR DELETE ON time.period_close_totals
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

-- ---------------------------------------------------------------------------
-- Exports préparatoires paie — immuables, versionnés, remplacés JAMAIS supprimés.
-- ---------------------------------------------------------------------------
CREATE TABLE time.payroll_exports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  close_id        uuid NOT NULL,
  schema_version  text NOT NULL DEFAULT 'kora-paie-prep-1',
  format          text NOT NULL CHECK (format IN ('csv', 'json')),
  revision        int  NOT NULL DEFAULT 1 CHECK (revision >= 1),
  content         bytea NOT NULL,
  sha256          char(64) NOT NULL,
  employees_count int NOT NULL DEFAULT 0,
  error_report    jsonb NOT NULL DEFAULT '[]',
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded')),
  generated_by    uuid NOT NULL,
  generated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, close_id, schema_version, format, revision),
  FOREIGN KEY (tenant_id, close_id) REFERENCES time.period_closes (tenant_id, id)
);
CREATE FUNCTION time.guard_export_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (OLD.status = 'active' AND NEW.status = 'superseded') THEN
    RAISE EXCEPTION 'export : seule la bascule active -> superseded est permise' USING ERRCODE = 'raise_exception';
  END IF;
  IF to_jsonb(NEW) - 'status' IS DISTINCT FROM to_jsonb(OLD) - 'status' THEN
    RAISE EXCEPTION 'export : contenu FIGÉ — un remplacement crée une nouvelle révision' USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_payroll_exports_guard BEFORE UPDATE ON time.payroll_exports
  FOR EACH ROW EXECUTE FUNCTION time.guard_export_update();
CREATE TRIGGER trg_payroll_exports_nodelete BEFORE DELETE ON time.payroll_exports
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

-- ---------------------------------------------------------------------------
-- Permissions distinctes (portées réelles E8/E9 appliquées par les services).
-- ---------------------------------------------------------------------------
INSERT INTO admin.permissions (key, description) VALUES
  ('time.correction_request_self', 'Demander une correction ou une justification pour SOI (ESS) et suivre ses demandes'),
  ('time.correction_request',      'Demander ou proposer une correction pour un tiers de sa portée — audité'),
  ('time.correction_view',         'Consulter les demandes de correction de sa portée'),
  ('time.correction_admin',        'Administrer les corrections : corrections administratives, imports historiques, relances d''application — audité'),
  ('time.attachments_view',        'Consulter les pièces justificatives — chaque consultation est journalisée'),
  ('time.preclose_view',           'Consulter le contrôle de pré-clôture'),
  ('time.period_manage',           'Gérer les périodes de présence (créer, passer en revue, verrouiller) — audité'),
  ('time.period_close',            'CLÔTURER une période — audité'),
  ('time.period_reopen',           'ROUVRIR une période clôturée — motif et circuit dédiés, audité'),
  ('time.payroll_view',            'Consulter les variables temps préparatoires paie (aucun montant)'),
  ('time.payroll_export',          'Générer et télécharger les exports préparatoires paie — audité'),
  ('time.rules_admin',             'Administrer les règles opérationnelles du temps (bloqueurs de pré-clôture, bornes) — audité')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- RLS + privilèges : jamais de DELETE ; UPDATE borné par les triggers ci-dessus.
-- ---------------------------------------------------------------------------
ALTER TABLE time.correction_requests    ENABLE ROW LEVEL SECURITY;
ALTER TABLE time.correction_events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE time.correction_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE time.attachment_access_log  ENABLE ROW LEVEL SECURITY;
ALTER TABLE time.periods                ENABLE ROW LEVEL SECURITY;
ALTER TABLE time.period_closes          ENABLE ROW LEVEL SECURITY;
ALTER TABLE time.period_close_lines     ENABLE ROW LEVEL SECURITY;
ALTER TABLE time.period_close_totals    ENABLE ROW LEVEL SECURITY;
ALTER TABLE time.payroll_exports        ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_rows ON time.correction_requests    TO kora_app USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON time.correction_events      TO kora_app USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON time.correction_attachments TO kora_app USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON time.attachment_access_log  TO kora_app USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON time.periods                TO kora_app USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON time.period_closes          TO kora_app USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON time.period_close_lines     TO kora_app USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON time.period_close_totals    TO kora_app USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON time.payroll_exports        TO kora_app USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON time.correction_requests    TO kora_app;
GRANT SELECT, INSERT         ON time.correction_events      TO kora_app;  -- append-only
GRANT SELECT, INSERT, UPDATE ON time.correction_attachments TO kora_app;  -- av_status / deleted_at seuls
GRANT SELECT, INSERT         ON time.attachment_access_log  TO kora_app;  -- append-only
GRANT SELECT, INSERT, UPDATE ON time.periods                TO kora_app;  -- statuts contrôlés
GRANT SELECT, INSERT, UPDATE ON time.period_closes          TO kora_app;  -- bascule superseded seule
GRANT SELECT, INSERT         ON time.period_close_lines     TO kora_app;  -- append-only
GRANT SELECT, INSERT         ON time.period_close_totals    TO kora_app;  -- append-only
GRANT SELECT, INSERT, UPDATE ON time.payroll_exports        TO kora_app;  -- bascule superseded seule
