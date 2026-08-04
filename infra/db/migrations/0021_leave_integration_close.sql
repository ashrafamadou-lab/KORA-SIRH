-- ============================================================================
-- 0021 — E11.3 : intégration Présence, clôture des congés, préparation paie.
--
-- Principes portés PAR LA BASE :
--   * une absence appliquée produit des FAITS D'ABSENCE par journée décomptée,
--     versionnés et supersédés — JAMAIS modifiés ni supprimés ; les pointages
--     bruts, les anciens résultats E10 et les clôtures antérieures restent
--     intacts (le moteur les consomme, il ne les réécrit pas) ;
--   * la clôture des congés fige des LIGNES par salarié et type (photographie
--     exacte du ledger), porte une empreinte SHA-256 reproductible, ne se
--     modifie jamais (active → superseded uniquement) et interdit les clôtures
--     CONCURRENTES par contrainte d'exclusion ;
--   * une période de congés CLOSE refuse tout mouvement ordinaire rétroactif
--     du ledger (trigger) — la correction passe par la réouverture contrôlée ;
--   * les exports préparatoires paie sont IMMUABLES, versionnés, remplacés
--     jamais supprimés — et ne contiennent AUCUN montant (contrat de schéma) ;
--   * les catégories préparatoires paie des types d'absence sont configurées
--     (catalogue fermé) et FIGÉES dès le premier usage, comme le reste de la
--     sémantique du type.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Catégorie préparatoire paie du type d'absence (catalogue FERMÉ, configurable).
-- ---------------------------------------------------------------------------
ALTER TABLE leave.absence_types
  ADD COLUMN prep_category text NOT NULL DEFAULT 'autre' CHECK (prep_category IN (
    'conge_paye', 'absence_autorisee_payee', 'sans_solde', 'maladie',
    'maternite_paternite', 'accident_travail', 'mission_formation',
    'non_autorisee', 'repos_compensateur', 'autre'));

-- La catégorie paie rejoint la sémantique FIGÉE dès le premier usage.
CREATE OR REPLACE FUNCTION leave.guard_absence_type_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  used boolean;
BEGIN
  IF OLD.code <> NEW.code THEN
    RAISE EXCEPTION 'type d''absence : le code est IMMUABLE';
  END IF;
  IF (OLD.unit, OLD.category, OLD.paid, OLD.confidential, OLD.negative_allowed, OLD.prep_category)
     IS DISTINCT FROM (NEW.unit, NEW.category, NEW.paid, NEW.confidential, NEW.negative_allowed, NEW.prep_category) THEN
    SELECT EXISTS (SELECT 1 FROM leave.entitlement_ledger l WHERE l.absence_type_id = OLD.id)
        OR EXISTS (SELECT 1 FROM leave.policies p WHERE p.absence_type_id = OLD.id)
      INTO used;
    IF used THEN
      RAISE EXCEPTION 'type d''absence % : déjà utilisé — sa sémantique (unité, catégorie, payé, confidentiel, négatif, catégorie paie) est FIGÉE ; créez un nouveau type', OLD.code;
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Faits d'absence consommés par le moteur E10 — versionnés, jamais réécrits.
-- Une ligne PAR JOURNÉE DÉCOMPTÉE (la rotation de nuit vit sur SA journée).
-- ---------------------------------------------------------------------------
CREATE TABLE time.absence_facts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES admin.tenants(id),
  employee_id      uuid NOT NULL,
  work_date        date NOT NULL,
  absence_id       uuid NOT NULL,
  request_id       uuid NOT NULL,
  request_version  int  NOT NULL,
  absence_type_id  uuid NOT NULL,
  -- Ce que le moteur consomme : catégorie paie, nature payée, portion du jour.
  prep_category    text NOT NULL,
  type_code        text NOT NULL,
  confidential     boolean NOT NULL DEFAULT false,
  paid             boolean NOT NULL,
  portion          text NOT NULL CHECK (portion IN ('full', 'half', 'hours')),
  minutes          int CHECK (minutes IS NULL OR minutes BETWEEN 1 AND 1440),
  CONSTRAINT minutes_only_for_hours CHECK ((portion = 'hours') = (minutes IS NOT NULL)),
  counted          numeric(9,3) NOT NULL CHECK (counted > 0),
  unit             text NOT NULL,
  policy_id        uuid,
  policy_version   int,
  params_used      jsonb NOT NULL DEFAULT '{}',
  -- Versionnement : l'annulation SUPERSÈDE, ne supprime jamais.
  version          int NOT NULL DEFAULT 1 CHECK (version >= 1),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending_closed_period', 'superseded')),
  superseded_at    timestamptz,
  supersede_reason text CHECK (supersede_reason IS NULL OR char_length(supersede_reason) <= 500),
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, absence_id, work_date, version),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id)     REFERENCES core.employees (tenant_id, id),
  FOREIGN KEY (tenant_id, absence_id)      REFERENCES leave.absences (tenant_id, id),
  FOREIGN KEY (tenant_id, request_id)      REFERENCES leave.requests (tenant_id, id),
  FOREIGN KEY (tenant_id, absence_type_id) REFERENCES leave.absence_types (tenant_id, id)
);
CREATE INDEX absence_facts_day_idx ON time.absence_facts (tenant_id, employee_id, work_date) WHERE status = 'active';
CREATE INDEX absence_facts_absence_idx ON time.absence_facts (tenant_id, absence_id, version);

-- Un seul fait ACTIF ou EN ATTENTE par salarié et journée (les absences
-- approuvées ne se chevauchent pas ; la base le redit ici).
CREATE UNIQUE INDEX absence_facts_one_live_per_day
  ON time.absence_facts (tenant_id, employee_id, work_date)
  WHERE status IN ('active', 'pending_closed_period');

-- Contenu FIGÉ : seules les transitions de statut (intégration d'un fait en
-- attente, supersession datée et motivée) sont permises. Jamais de DELETE.
CREATE FUNCTION time.guard_absence_fact_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF to_jsonb(NEW) - 'status' - 'superseded_at' - 'supersede_reason'
     IS DISTINCT FROM to_jsonb(OLD) - 'status' - 'superseded_at' - 'supersede_reason' THEN
    RAISE EXCEPTION 'fait d''absence % : contenu FIGÉ (statut seul)', OLD.id USING ERRCODE = 'raise_exception';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'pending_closed_period' AND NEW.status IN ('active', 'superseded')) OR
    (OLD.status = 'active' AND NEW.status = 'superseded')
  ) THEN
    RAISE EXCEPTION 'fait d''absence % : transition interdite % -> %', OLD.id, OLD.status, NEW.status;
  END IF;
  IF NEW.status = 'superseded' AND (NEW.supersede_reason IS NULL OR char_length(NEW.supersede_reason) < 3) THEN
    RAISE EXCEPTION 'fait d''absence % : supersession sans motif', OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_absence_facts_guard BEFORE UPDATE ON time.absence_facts
  FOR EACH ROW EXECUTE FUNCTION time.guard_absence_fact_update();
CREATE TRIGGER trg_absence_facts_nodelete BEFORE DELETE ON time.absence_facts
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

-- L'impact présence d'une absence suit désormais un cycle de vie explicite.
ALTER TABLE leave.absences DROP CONSTRAINT absences_presence_impact_check;
ALTER TABLE leave.absences ADD CONSTRAINT absences_presence_impact_check
  CHECK (presence_impact IN ('deferred', 'applied', 'pending_closed_period', 'superseded'));

-- Le garde des absences autorise MAINTENANT l'évolution de presence_impact
-- (en plus de l'annulation motivée) — le reste demeure figé.
CREATE OR REPLACE FUNCTION leave.guard_absence_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF to_jsonb(NEW) - 'status' - 'cancelled_at' - 'cancelled_by' - 'cancel_reason' - 'presence_impact'
     IS DISTINCT FROM to_jsonb(OLD) - 'status' - 'cancelled_at' - 'cancelled_by' - 'cancel_reason' - 'presence_impact' THEN
    RAISE EXCEPTION 'absence % : contenu FIGÉ (seuls l''annulation motivée et l''impact présence évoluent)', OLD.id
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

-- L'anomalie de présence peut désormais se résoudre par APPLICATION D'ABSENCE
-- (référence probante = le fait, jamais une résolution silencieuse).
ALTER TABLE time.day_anomalies DROP CONSTRAINT day_anomalies_resolution_kind_check;
ALTER TABLE time.day_anomalies ADD CONSTRAINT day_anomalies_resolution_kind_check
  CHECK (resolution_kind IS NULL OR resolution_kind IN ('correction_applied', 'classified', 'absence_applied'));

-- ---------------------------------------------------------------------------
-- Périodes de CONGÉS : cycle contrôlé, réouverture versionnée, anti-chevauchement.
-- ---------------------------------------------------------------------------
CREATE TABLE leave.periods (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES admin.tenants(id),
  label        text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 100),
  period_start date NOT NULL,
  period_end   date NOT NULL CHECK (period_end >= period_start),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'reopened', 'archived')),
  revision     int NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CONSTRAINT leave_periods_no_overlap EXCLUDE USING gist (
    tenant_id WITH =,
    daterange(period_start, period_end, '[]') WITH &&
  ) WHERE (status <> 'archived')
);
CREATE INDEX leave_periods_idx ON leave.periods (tenant_id, status, period_start);

CREATE FUNCTION leave.guard_period_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.period_start <> OLD.period_start OR NEW.period_end <> OLD.period_end THEN
    RAISE EXCEPTION 'période congés % : bornes IMMUABLES', OLD.label;
  END IF;
  IF NEW.status <> OLD.status THEN
    IF NOT (
      (OLD.status = 'open'     AND NEW.status IN ('closed', 'archived')) OR
      (OLD.status = 'closed'   AND NEW.status = 'reopened') OR
      (OLD.status = 'reopened' AND NEW.status IN ('closed', 'archived'))
    ) THEN
      RAISE EXCEPTION 'période congés % : transition interdite % -> %', OLD.label, OLD.status, NEW.status
        USING ERRCODE = 'raise_exception';
    END IF;
    IF OLD.status = 'closed' AND NEW.status = 'reopened' AND NEW.revision <> OLD.revision + 1 THEN
      RAISE EXCEPTION 'période congés % : la réouverture INCRÉMENTE la révision', OLD.label;
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER trg_leave_periods_guard BEFORE UPDATE ON leave.periods
  FOR EACH ROW EXECUTE FUNCTION leave.guard_period_update();
CREATE TRIGGER trg_leave_periods_nodelete BEFORE DELETE ON leave.periods
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

-- Une période CLOSE refuse tout mouvement ordinaire rétroactif du ledger :
-- la correction d'une période close passe par la RÉOUVERTURE contrôlée.
CREATE FUNCTION leave.guard_ledger_closed_period() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lbl text;
BEGIN
  SELECT p.label INTO lbl FROM leave.periods p
   WHERE p.tenant_id = NEW.tenant_id AND p.status = 'closed'
     AND NEW.effective_on BETWEEN p.period_start AND p.period_end
   LIMIT 1;
  IF lbl IS NOT NULL THEN
    RAISE EXCEPTION 'période congés close (%) : mouvement rétroactif refusé — réouverture contrôlée requise', lbl
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_ledger_closed_period BEFORE INSERT ON leave.entitlement_ledger
  FOR EACH ROW EXECUTE FUNCTION leave.guard_ledger_closed_period();

-- ---------------------------------------------------------------------------
-- Clôtures de congés : photographie du ledger, empreinte reproductible.
-- ---------------------------------------------------------------------------
CREATE TABLE leave.period_closes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  period_id        uuid NOT NULL,
  close_no         int  NOT NULL CHECK (close_no >= 1),
  period_revision  int  NOT NULL,
  engine_version   text NOT NULL,
  params_snapshot  jsonb NOT NULL DEFAULT '{}',
  policies_snapshot jsonb NOT NULL DEFAULT '[]',
  dataset_sha256   char(64) NOT NULL,
  employees_count  int NOT NULL DEFAULT 0,
  lines_count      int NOT NULL DEFAULT 0,
  movements_count  int NOT NULL DEFAULT 0,
  totals           jsonb NOT NULL DEFAULT '{}',
  warnings         jsonb NOT NULL DEFAULT '[]',
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded')),
  closed_by        uuid NOT NULL,
  closed_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, period_id, close_no),
  FOREIGN KEY (tenant_id, period_id) REFERENCES leave.periods (tenant_id, id)
);
CREATE TRIGGER trg_leave_closes_guard BEFORE UPDATE ON leave.period_closes
  FOR EACH ROW EXECUTE FUNCTION time.guard_close_update();
CREATE TRIGGER trg_leave_closes_nodelete BEFORE DELETE ON leave.period_closes
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

-- Lignes FIGÉES : soldes par salarié, type et période de référence — la
-- photographie EXACTE du ledger au moment de la clôture (l'empreinte s'en déduit).
CREATE TABLE leave.close_lines (
  tenant_id       uuid NOT NULL,
  close_id        uuid NOT NULL,
  employee_id     uuid NOT NULL,
  absence_type_id uuid NOT NULL,
  period_start    date NOT NULL,
  accrued         numeric(12,3) NOT NULL DEFAULT 0,
  adjusted_out    numeric(12,3) NOT NULL DEFAULT 0,
  carried_in      numeric(12,3) NOT NULL DEFAULT 0,
  expired         numeric(12,3) NOT NULL DEFAULT 0,
  reserved        numeric(12,3) NOT NULL DEFAULT 0,
  consumed        numeric(12,3) NOT NULL DEFAULT 0,
  available       numeric(12,3) NOT NULL DEFAULT 0,
  unit            text NOT NULL,
  movements       int NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, close_id, employee_id, absence_type_id, period_start),
  FOREIGN KEY (tenant_id, close_id)        REFERENCES leave.period_closes (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id)     REFERENCES core.employees (tenant_id, id),
  FOREIGN KEY (tenant_id, absence_type_id) REFERENCES leave.absence_types (tenant_id, id)
);
CREATE TRIGGER trg_leave_close_lines_frozen BEFORE UPDATE OR DELETE ON leave.close_lines
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

-- ---------------------------------------------------------------------------
-- Exports préparatoires paie CONGÉS — immuables, versionnés, remplacés jamais
-- supprimés ; AUCUN montant (contrat kora-conges-prep-1).
-- ---------------------------------------------------------------------------
CREATE TABLE leave.prep_exports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  close_id        uuid NOT NULL,
  schema_version  text NOT NULL DEFAULT 'kora-conges-prep-1',
  format          text NOT NULL CHECK (format IN ('csv', 'json')),
  revision        int  NOT NULL DEFAULT 1 CHECK (revision >= 1),
  content         bytea NOT NULL,
  sha256          char(64) NOT NULL,
  time_closes     jsonb NOT NULL DEFAULT '[]',   -- clôtures E10 référencées (contrat cohérent, origine identifiable)
  employees_count int NOT NULL DEFAULT 0,
  error_report    jsonb NOT NULL DEFAULT '[]',
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded')),
  generated_by    uuid NOT NULL,
  generated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, close_id, format, revision),
  FOREIGN KEY (tenant_id, close_id) REFERENCES leave.period_closes (tenant_id, id)
);
CREATE TRIGGER trg_leave_prep_exports_guard BEFORE UPDATE ON leave.prep_exports
  FOR EACH ROW EXECUTE FUNCTION time.guard_close_update();
CREATE TRIGGER trg_leave_prep_exports_nodelete BEFORE DELETE ON leave.prep_exports
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

-- ---------------------------------------------------------------------------
-- Permissions (8 nouvelles).
-- ---------------------------------------------------------------------------
INSERT INTO admin.permissions (key, description) VALUES
  ('leave.period_manage',   'Créer et administrer les périodes de congés (bornes immuables, cycle contrôlé)'),
  ('leave.close_run',       'Exécuter le contrôle de pré-clôture et la clôture des congés (empreinte reproductible)'),
  ('leave.close_view',      'Consulter les clôtures de congés, leurs lignes figées et leurs empreintes'),
  ('leave.reopen',          'Demander la réouverture contrôlée d''une période de congés close (circuit E3)'),
  ('leave.export_create',   'Générer un export préparatoire paie congés (sans aucun montant) — idempotent, versionné'),
  ('leave.export_download', 'Télécharger un export préparatoire paie congés — chaque téléchargement est audité'),
  ('leave.reports_view',    'Consulter les indicateurs congés & absences de sa portée (jamais un motif médical)'),
  ('leave.integration_run', 'Relancer l''intégration présence : faits en attente, recalculs, résolutions d''anomalies');

-- ---------------------------------------------------------------------------
-- RLS + droits applicatifs.
-- ---------------------------------------------------------------------------
ALTER TABLE time.absence_facts   ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave.periods        ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave.period_closes  ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave.close_lines    ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave.prep_exports   ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_rows ON time.absence_facts  TO kora_app USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON leave.periods       TO kora_app USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON leave.period_closes TO kora_app USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON leave.close_lines   TO kora_app USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON leave.prep_exports  TO kora_app USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON time.absence_facts  TO kora_app;  -- statut seul (garde)
GRANT SELECT, INSERT, UPDATE ON leave.periods       TO kora_app;  -- cycle contrôlé (garde)
GRANT SELECT, INSERT, UPDATE ON leave.period_closes TO kora_app;  -- active → superseded seul
GRANT SELECT, INSERT         ON leave.close_lines   TO kora_app;  -- FIGÉES
GRANT SELECT, INSERT, UPDATE ON leave.prep_exports  TO kora_app;  -- active → superseded seul
