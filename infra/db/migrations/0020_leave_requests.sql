-- ============================================================================
-- 0020 — E11.2 : demandes de congés et d'absences (ESS), workflow, calendrier.
--
-- Principes portés PAR LA BASE (le code ne peut pas les contourner) :
--   * une demande ne modifie JAMAIS un solde : toute réservation, libération ou
--     consommation est un mouvement append-only du ledger E11.1 (0019) ;
--   * une demande soumise est FIGÉE : le contenu soumis vit dans
--     request_versions, table immuable — modifier = resoumettre une version ;
--   * les transitions d'état sont contrôlées par trigger (machine à états) et
--     historisées dans request_events (append-only) ;
--   * deux absences APPROUVÉES d'un même salarié ne se chevauchent jamais :
--     contrainte d'EXCLUSION PostgreSQL, pas une promesse applicative ;
--   * les justificatifs (souvent médicaux) sont cloisonnés : contenu figé,
--     consultations journalisées ligne à ligne, sensibilité héritée du type ;
--   * aucune règle légale codée en dur : préavis, plafonds, seuils d'équipe et
--     délais viennent des politiques versionnées (0019) et des paramètres E4
--     résolus à la date du fait générateur.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Demandes : tête vivante (le contenu ÉDITABLE n'existe qu'avant soumission).
-- ---------------------------------------------------------------------------
CREATE TABLE leave.requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES admin.tenants(id),
  employee_id      uuid NOT NULL,
  absence_type_id  uuid NOT NULL,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN (
                     'draft', 'submitted', 'in_review', 'returned', 'approved',
                     'rejected', 'cancelled', 'approved_pending_application',
                     'applied', 'application_failed', 'expired')),
  -- 0 = jamais soumise ; N = dernière version SOUMISE (le contenu figé est
  -- dans request_versions, la décision E3 est liée exactement à une version).
  current_version  int NOT NULL DEFAULT 0 CHECK (current_version >= 0),
  -- Brouillon ÉDITABLE (dates, demi-journées, heures, commentaire) — jamais
  -- une donnée décisionnelle : tout ce qui compte est recalculé et FIGÉ côté
  -- serveur à la soumission, dans la version.
  draft_payload    jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(draft_payload) = 'object'),
  -- Demande pour un TIERS (§11) : auteur, motif, permission utilisée, source
  -- et confirmation du salarié conservés.
  on_behalf        boolean NOT NULL DEFAULT false,
  on_behalf_reason text CHECK (on_behalf_reason IS NULL OR char_length(on_behalf_reason) <= 500),
  on_behalf_permission text,
  source           text NOT NULL DEFAULT 'ess' CHECK (source IN ('ess', 'manager', 'rh')),
  employee_confirmed_at timestamptz,
  -- Instance E3 de la version COURANTE (une resoumission crée une nouvelle
  -- instance ; l'ancienne reste consultable via les versions).
  workflow_instance_id uuid,
  -- Circuit DISTINCT d'annulation après approbation (§12).
  cancel_workflow_instance_id uuid,
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id)     REFERENCES core.employees (tenant_id, id),
  FOREIGN KEY (tenant_id, absence_type_id) REFERENCES leave.absence_types (tenant_id, id),
  CONSTRAINT on_behalf_shape CHECK (on_behalf = false OR (on_behalf_reason IS NOT NULL AND on_behalf_permission IS NOT NULL))
);
CREATE INDEX requests_emp_idx    ON leave.requests (tenant_id, employee_id, status);
CREATE INDEX requests_status_idx ON leave.requests (tenant_id, status, updated_at DESC);

-- Machine à états : SEULES ces transitions existent. Identité (salarié, type,
-- auteur) immuable. Le brouillon n'est éditable qu'avant soumission (draft /
-- returned). L'expiration administrative ne s'applique qu'à une demande
-- retournée non resoumise ou soumise dont le circuit est terminé — jamais une
-- décision silencieuse à la place d'un approbateur.
CREATE FUNCTION leave.guard_request_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.tenant_id, NEW.employee_id, NEW.absence_type_id, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.tenant_id, OLD.employee_id, OLD.absence_type_id, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'demande % : identité immuable (salarié, type, auteur)', OLD.id;
  END IF;
  IF NEW.status <> OLD.status THEN
    IF NOT (
      (OLD.status = 'draft'     AND NEW.status IN ('submitted', 'cancelled')) OR
      (OLD.status = 'submitted' AND NEW.status IN ('in_review', 'returned', 'approved',
                                                   'approved_pending_application', 'rejected',
                                                   'cancelled', 'expired')) OR
      (OLD.status = 'in_review' AND NEW.status IN ('returned', 'approved',
                                                   'approved_pending_application', 'rejected',
                                                   'cancelled', 'expired')) OR
      (OLD.status = 'returned'  AND NEW.status IN ('submitted', 'cancelled', 'expired')) OR
      (OLD.status = 'approved'  AND NEW.status IN ('applied', 'application_failed')) OR
      (OLD.status = 'approved_pending_application' AND NEW.status IN ('applied', 'application_failed')) OR
      (OLD.status = 'application_failed'           AND NEW.status IN ('applied', 'cancelled')) OR
      (OLD.status = 'applied'   AND NEW.status = 'cancelled')
    ) THEN
      RAISE EXCEPTION 'demande % : transition interdite % -> %', OLD.id, OLD.status, NEW.status
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;
  IF NEW.draft_payload IS DISTINCT FROM OLD.draft_payload
     AND NEW.status NOT IN ('draft', 'returned') THEN
    RAISE EXCEPTION 'demande % : contenu FIGÉ après soumission — resoumettre une nouvelle version', OLD.id
      USING ERRCODE = 'raise_exception';
  END IF;
  IF NEW.current_version < OLD.current_version THEN
    RAISE EXCEPTION 'demande % : le numéro de version ne régresse jamais', OLD.id;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER trg_requests_guard BEFORE UPDATE ON leave.requests
  FOR EACH ROW EXECUTE FUNCTION leave.guard_request_update();
CREATE TRIGGER trg_requests_nodelete BEFORE DELETE ON leave.requests
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

-- ---------------------------------------------------------------------------
-- Versions SOUMISES : immuables. La décision E3 porte exactement sur l'une
-- d'elles ; le décompte, la politique, les paramètres E4 et les contrôles du
-- moment y sont FIGÉS (reproductibilité, opposabilité).
-- ---------------------------------------------------------------------------
CREATE TABLE leave.request_versions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES admin.tenants(id),
  request_id       uuid NOT NULL,
  version          int  NOT NULL CHECK (version >= 1),
  start_date       date NOT NULL,
  end_date         date NOT NULL CHECK (end_date >= start_date),
  half_day_start   boolean NOT NULL DEFAULT false,
  half_day_end     boolean NOT NULL DEFAULT false,
  hours_requested  numeric(6,2) CHECK (hours_requested IS NULL OR hours_requested > 0),
  -- Un volume d'heures explicite ne se demande que sur UNE journée.
  CONSTRAINT hours_single_day CHECK (hours_requested IS NULL OR start_date = end_date),
  quantity         numeric(9,3) NOT NULL CHECK (quantity >= 0),
  unit             text NOT NULL CHECK (unit IN ('open_days', 'working_days', 'calendar_days', 'half_days', 'hours')),
  count_detail     jsonb NOT NULL DEFAULT '[]',
  checks           jsonb NOT NULL DEFAULT '[]',   -- rapport de vérification à la soumission
  policy_id        uuid,
  policy_version   int,
  params_used      jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(params_used) = 'object'),
  retroactive      boolean NOT NULL DEFAULT false,
  retro_reason     text CHECK (retro_reason IS NULL OR char_length(retro_reason) <= 500),
  negative_used    boolean NOT NULL DEFAULT false,
  comment          text CHECK (comment IS NULL OR char_length(comment) <= 1000),
  workflow_instance_id uuid,                      -- instance E3 créée POUR cette version
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, request_id, version),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, request_id) REFERENCES leave.requests (tenant_id, id),
  FOREIGN KEY (tenant_id, policy_id)  REFERENCES leave.policies (tenant_id, id)
);
CREATE TRIGGER trg_request_versions_immutable BEFORE UPDATE OR DELETE ON leave.request_versions
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

-- ---------------------------------------------------------------------------
-- Événements : CHAQUE transition, réservation, consultation sensible —
-- append-only, daté, attribué.
-- ---------------------------------------------------------------------------
CREATE TABLE leave.request_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  request_id    uuid NOT NULL,
  version       int,
  event         text NOT NULL CHECK (event IN (
                  'created', 'draft_updated', 'confirmation_given', 'submitted',
                  'review_started', 'returned', 'resubmitted', 'approved', 'rejected',
                  'cancelled', 'withdrawn', 'expired',
                  'reservation_posted', 'reservation_released',
                  'applied', 'application_failed', 'application_retried',
                  'cancel_requested', 'cancel_approved', 'cancel_rejected',
                  'attachment_added', 'attachment_viewed', 'attachment_verified')),
  actor_user_id uuid,
  detail        jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, request_id) REFERENCES leave.requests (tenant_id, id)
);
CREATE INDEX request_events_req_idx ON leave.request_events (tenant_id, request_id, id);
CREATE TRIGGER trg_request_events_frozen BEFORE UPDATE OR DELETE ON leave.request_events
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

-- ---------------------------------------------------------------------------
-- Absences APPROUVÉES et appliquées : l'enregistrement opposable (§13).
-- L'impact présence/paie reste DÉCLARÉ et différé (E11.3) — jamais simulé ici.
-- ---------------------------------------------------------------------------
CREATE TABLE leave.absences (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES admin.tenants(id),
  employee_id      uuid NOT NULL,
  absence_type_id  uuid NOT NULL,
  request_id       uuid NOT NULL,
  request_version  int  NOT NULL,
  start_date       date NOT NULL,
  end_date         date NOT NULL CHECK (end_date >= start_date),
  half_day_start   boolean NOT NULL DEFAULT false,
  half_day_end     boolean NOT NULL DEFAULT false,
  hours_requested  numeric(6,2),
  quantity         numeric(9,3) NOT NULL CHECK (quantity >= 0),
  unit             text NOT NULL,
  status           text NOT NULL DEFAULT 'approved' CHECK (status IN ('approved', 'cancelled')),
  presence_impact  text NOT NULL DEFAULT 'deferred' CHECK (presence_impact = 'deferred'),
  policy_id        uuid,
  policy_version   int,
  params_used      jsonb NOT NULL DEFAULT '{}',
  count_detail     jsonb NOT NULL DEFAULT '[]',
  applied_by       uuid,
  applied_at       timestamptz NOT NULL DEFAULT now(),
  cancelled_at     timestamptz,
  cancelled_by     uuid,
  cancel_reason    text CHECK (cancel_reason IS NULL OR char_length(cancel_reason) <= 500),
  -- UNE absence par version de demande : l'application est idempotente PAR LA BASE.
  UNIQUE (tenant_id, request_id, request_version),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id)     REFERENCES core.employees (tenant_id, id),
  FOREIGN KEY (tenant_id, absence_type_id) REFERENCES leave.absence_types (tenant_id, id),
  FOREIGN KEY (tenant_id, request_id)      REFERENCES leave.requests (tenant_id, id),
  -- Deux absences APPROUVÉES d'un même salarié ne se chevauchent JAMAIS.
  CONSTRAINT absences_no_overlap EXCLUDE USING gist (
    tenant_id   WITH =,
    employee_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  ) WHERE (status = 'approved')
);
CREATE INDEX absences_emp_idx ON leave.absences (tenant_id, employee_id, start_date);

-- Seule l'annulation (motivée, datée, attribuée) est mutable ; jamais de DELETE.
CREATE FUNCTION leave.guard_absence_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF to_jsonb(NEW) - 'status' - 'cancelled_at' - 'cancelled_by' - 'cancel_reason'
     IS DISTINCT FROM to_jsonb(OLD) - 'status' - 'cancelled_at' - 'cancelled_by' - 'cancel_reason' THEN
    RAISE EXCEPTION 'absence % : contenu FIGÉ (seule l''annulation motivée est possible)', OLD.id
      USING ERRCODE = 'raise_exception';
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'approved' AND NEW.status = 'cancelled') THEN
    RAISE EXCEPTION 'absence % : transition interdite % -> %', OLD.id, OLD.status, NEW.status;
  END IF;
  IF NEW.status = 'cancelled' AND (NEW.cancel_reason IS NULL OR char_length(NEW.cancel_reason) < 3) THEN
    RAISE EXCEPTION 'absence % : annulation sans motif', OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_absences_guard BEFORE UPDATE ON leave.absences
  FOR EACH ROW EXECUTE FUNCTION leave.guard_absence_update();
CREATE TRIGGER trg_absences_nodelete BEFORE DELETE ON leave.absences
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

-- ---------------------------------------------------------------------------
-- Justificatifs : même discipline que les pièces E10.3 — contenu FIGÉ,
-- sensibilité, journal de consultation ligne à ligne. S'y ajoute la
-- VÉRIFICATION (§7 approbation médicale/HSE limitée au statut de la pièce).
-- ---------------------------------------------------------------------------
CREATE TABLE leave.request_attachments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  request_id  uuid NOT NULL,
  filename    text NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 200),
  mime        text NOT NULL CHECK (mime IN ('application/pdf', 'image/png', 'image/jpeg')),
  byte_size   int  NOT NULL CHECK (byte_size BETWEEN 1 AND 5000000),
  sha256      char(64) NOT NULL,
  sensitive   boolean NOT NULL DEFAULT false,
  content     bytea NOT NULL,
  av_status   text NOT NULL DEFAULT 'skipped' CHECK (av_status IN ('skipped', 'pending', 'clean', 'infected')),
  -- Vérification du justificatif : un STATUT, jamais un diagnostic.
  verified_status text NOT NULL DEFAULT 'unverified' CHECK (verified_status IN ('unverified', 'accepted', 'rejected')),
  verified_by uuid,
  verified_at timestamptz,
  uploaded_by uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, request_id) REFERENCES leave.requests (tenant_id, id)
);
CREATE INDEX request_attachments_req_idx ON leave.request_attachments (tenant_id, request_id);

CREATE FUNCTION leave.guard_request_attachment_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF to_jsonb(NEW) - 'av_status' - 'deleted_at' - 'verified_status' - 'verified_by' - 'verified_at'
     IS DISTINCT FROM to_jsonb(OLD) - 'av_status' - 'deleted_at' - 'verified_status' - 'verified_by' - 'verified_at' THEN
    RAISE EXCEPTION 'justificatif : contenu et métadonnées FIGÉS (seuls av_status, vérification et suppression logique évoluent)'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_request_attachments_guard BEFORE UPDATE ON leave.request_attachments
  FOR EACH ROW EXECUTE FUNCTION leave.guard_request_attachment_update();
CREATE TRIGGER trg_request_attachments_nodelete BEFORE DELETE ON leave.request_attachments
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

CREATE TABLE leave.attachment_access_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  attachment_id uuid NOT NULL,
  viewed_by     uuid NOT NULL,
  viewed_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, attachment_id) REFERENCES leave.request_attachments (tenant_id, id)
);
CREATE INDEX leave_attachment_access_idx ON leave.attachment_access_log (tenant_id, attachment_id, viewed_at DESC);
CREATE TRIGGER trg_leave_attachment_access_frozen BEFORE UPDATE OR DELETE ON leave.attachment_access_log
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

-- ---------------------------------------------------------------------------
-- Lien ledger ↔ demande : les mouvements reservation/release/consumption/
-- reversal portent la demande et la version qui les justifient. Colonnes
-- NULLABLES : les mouvements E11.1 existants restent intacts (append-only).
-- ---------------------------------------------------------------------------
ALTER TABLE leave.entitlement_ledger
  ADD COLUMN request_id      uuid,
  ADD COLUMN request_version int;
ALTER TABLE leave.entitlement_ledger
  ADD CONSTRAINT entitlement_ledger_request_fk
  FOREIGN KEY (tenant_id, request_id) REFERENCES leave.requests (tenant_id, id);
CREATE INDEX entitlement_ledger_request_idx
  ON leave.entitlement_ledger (tenant_id, request_id) WHERE request_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Permissions (10 nouvelles ; « consulter les informations confidentielles »
-- réutilise leave.sensitive_view de 0019 ; APPROUVER n'est pas une permission
-- plate : c'est l'assignation d'étape E3 — rôle, manager résolu ou portée —
-- avec séparation des tâches par défaut).
-- ---------------------------------------------------------------------------
INSERT INTO admin.permissions (key, description) VALUES
  ('leave.request_self',            'Créer, soumettre et suivre SES demandes d''absence'),
  ('leave.request_for_others',      'Créer une demande pour un salarié de sa portée — motif obligatoire, tracé'),
  ('leave.requests_view_own',       'Consulter ses demandes, leurs décisions et leur historique'),
  ('leave.requests_view_team',      'Consulter et instruire les demandes de son équipe résolue — audité'),
  ('leave.requests_admin',          'Administrer les demandes de sa portée : file globale, échecs d''application, expiration — audité'),
  ('leave.attachments_verify',      'Vérifier les justificatifs (statut accepté/rejeté), sans exposer leur contenu aux tiers'),
  ('leave.calendar_view',           'Consulter le calendrier d''équipe (absences approuvées et demandes en attente de sa portée)'),
  ('leave.calendar_export',         'Exporter le calendrier d''équipe — chaque export est audité'),
  ('leave.request_cancel_approved', 'Ouvrir le circuit d''annulation d''une absence approuvée/appliquée'),
  ('leave.request_retroactive',     'Soumettre une demande rétroactive (circuit renforcé exigé)');

-- ---------------------------------------------------------------------------
-- RLS + droits applicatifs (jamais de DELETE ; versions, événements et journal
-- de consultation en INSERT-seul).
-- ---------------------------------------------------------------------------
ALTER TABLE leave.requests              ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave.request_versions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave.request_events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave.absences              ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave.request_attachments   ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave.attachment_access_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_rows ON leave.requests              TO kora_app USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON leave.request_versions      TO kora_app USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON leave.request_events        TO kora_app USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON leave.absences              TO kora_app USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON leave.request_attachments   TO kora_app USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON leave.attachment_access_log TO kora_app USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON leave.requests              TO kora_app;  -- transitions par trigger
GRANT SELECT, INSERT         ON leave.request_versions      TO kora_app;  -- IMMUABLES
GRANT SELECT, INSERT         ON leave.request_events        TO kora_app;  -- APPEND-ONLY
GRANT SELECT, INSERT, UPDATE ON leave.absences              TO kora_app;  -- annulation motivée seule
GRANT SELECT, INSERT, UPDATE ON leave.request_attachments   TO kora_app;  -- av/vérification/suppression logique
GRANT SELECT, INSERT         ON leave.attachment_access_log TO kora_app;  -- APPEND-ONLY
