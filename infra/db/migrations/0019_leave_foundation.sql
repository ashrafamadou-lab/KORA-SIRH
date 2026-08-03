-- 0019 — Congés & absences, tranche E11.1 : référentiel, politiques, droits, compteurs.
-- Réf : Blueprint §15, PRD US-E11. Principes portés ICI :
--  - le SOLDE n'est JAMAIS un nombre modifiable : c'est la somme d'un LEDGER
--    append-only (leave.entitlement_ledger) — toute correction est un mouvement
--    COMPENSATOIRE, jamais une réécriture (triggers anti-UPDATE/DELETE + grants) ;
--  - ANTI DOUBLE ACQUISITION PAR LA BASE : chaque mouvement porte une clé
--    d'idempotence UNIQUE — relancer une acquisition n'écrit rien de neuf ;
--  - types d'absence : sémantique FIGÉE dès le premier usage (trigger) — un type
--    déjà consommé par un mouvement ou une politique ne change plus de nature ;
--  - politiques VERSIONNÉES et datées ; une même population (signature de
--    sélecteurs identique) n'a qu'UNE politique active par type (index partiel
--    unique) ; l'ambiguïté résiduelle à la résolution est un CONFLIT explicite ;
--  - AUCUNE valeur légale ici : les rythmes, plafonds, reports, prorata sont soit
--    des clés E4 résolues à la date du fait générateur, soit des valeurs choisies
--    par le tenant et PORTÉES PAR LA VERSION de politique — le moteur n'a aucun
--    défaut juridique ;
--  - confidentialité : les types confidentiels cloisonnent motifs et références
--    (le serveur masque sans permission dédiée) — rien de médical dans ce schéma.

CREATE SCHEMA IF NOT EXISTS leave;

-- ---------------------------------------------------------------------------
-- Référentiel des types d'absence.
-- ---------------------------------------------------------------------------
CREATE TABLE leave.absence_types (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES admin.tenants(id),
  code                  text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,29}$'),
  label_fr              text NOT NULL CHECK (char_length(label_fr) BETWEEN 1 AND 120),
  label_en              text NOT NULL CHECK (char_length(label_en) BETWEEN 1 AND 120),
  category              text NOT NULL CHECK (category IN ('legal', 'conventional', 'internal')),
  paid                  boolean NOT NULL,
  unit                  text NOT NULL CHECK (unit IN ('open_days', 'working_days', 'calendar_days', 'half_days', 'hours')),
  -- Effets FUTURS (E11.3) : déclarés dès maintenant, consommés plus tard — jamais simulés.
  affects_presence      boolean NOT NULL DEFAULT true,
  affects_payroll_prep  boolean NOT NULL DEFAULT true,
  justification         text NOT NULL DEFAULT 'none' CHECK (justification IN ('required', 'optional', 'none')),
  deposit_delay_days    int CHECK (deposit_delay_days IS NULL OR deposit_delay_days BETWEEN 0 AND 365),
  retroactive_allowed   boolean NOT NULL DEFAULT false,
  negative_allowed      boolean NOT NULL DEFAULT false,
  confidential          boolean NOT NULL DEFAULT false,
  retention_note        text CHECK (retention_note IS NULL OR char_length(retention_note) <= 500),
  workflow_required     boolean NOT NULL DEFAULT true,
  status                text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'inactive', 'archived')),
  effective_from        date NOT NULL DEFAULT CURRENT_DATE,
  effective_to          date CHECK (effective_to IS NULL OR effective_to >= effective_from),
  created_by            uuid NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);

-- Sémantique FIGÉE dès le premier usage : un type référencé par un mouvement ou
-- une politique ne change plus de code, d'unité, de catégorie, de nature payée,
-- ni de confidentialité — libellés, statut, dates d'effet et notes restent gérables.
CREATE FUNCTION leave.guard_absence_type_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  used boolean;
BEGIN
  IF OLD.code <> NEW.code THEN
    RAISE EXCEPTION 'type d''absence : le code est IMMUABLE';
  END IF;
  IF (OLD.unit, OLD.category, OLD.paid, OLD.confidential, OLD.negative_allowed)
     IS DISTINCT FROM (NEW.unit, NEW.category, NEW.paid, NEW.confidential, NEW.negative_allowed) THEN
    SELECT EXISTS (SELECT 1 FROM leave.entitlement_ledger l WHERE l.absence_type_id = OLD.id)
        OR EXISTS (SELECT 1 FROM leave.policies p WHERE p.absence_type_id = OLD.id)
      INTO used;
    IF used THEN
      RAISE EXCEPTION 'type d''absence % : déjà utilisé — sa sémantique (unité, catégorie, payé, confidentiel, négatif) est FIGÉE ; créez un nouveau type', OLD.code;
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER trg_absence_types_guard BEFORE UPDATE ON leave.absence_types
  FOR EACH ROW EXECUTE FUNCTION leave.guard_absence_type_update();
CREATE TRIGGER trg_absence_types_nodelete BEFORE DELETE ON leave.absence_types
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

-- ---------------------------------------------------------------------------
-- Politiques : tête (population ciblée) + versions datées (règles).
-- ---------------------------------------------------------------------------
CREATE TABLE leave.policies (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES admin.tenants(id),
  absence_type_id       uuid NOT NULL,
  code                  text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,29}$'),
  label_fr              text NOT NULL CHECK (char_length(label_fr) BETWEEN 1 AND 120),
  label_en              text NOT NULL CHECK (char_length(label_en) BETWEEN 1 AND 120),
  -- Sélecteurs de POPULATION (NULL = tous) : pays, société, site, convention,
  -- catégorie professionnelle, type de contrat, statut, ancienneté minimale,
  -- temps de travail, clé de population libre.
  country_code          text CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$'),
  company_id            uuid,
  site_id               uuid,
  collective_agreement  text CHECK (collective_agreement IS NULL OR char_length(collective_agreement) <= 60),
  professional_category text CHECK (professional_category IS NULL OR char_length(professional_category) <= 60),
  contract_type         text CHECK (contract_type IS NULL OR char_length(contract_type) <= 40),
  employee_status       text CHECK (employee_status IS NULL OR employee_status IN ('active', 'on_leave', 'suspended', 'pre_hire')),
  seniority_min_months  int CHECK (seniority_min_months IS NULL OR seniority_min_months BETWEEN 0 AND 600),
  work_time             text NOT NULL DEFAULT 'any' CHECK (work_time IN ('any', 'full_time', 'part_time')),
  population_key        text CHECK (population_key IS NULL OR population_key ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  -- Signature de population : deux politiques ACTIVES du même type et de même
  -- signature seraient INCOMPATIBLES — l'index partiel unique l'interdit.
  selector_sig          text GENERATED ALWAYS AS (
    md5(coalesce(country_code, '·') || '|' || coalesce(company_id::text, '·') || '|' ||
        coalesce(site_id::text, '·') || '|' || coalesce(collective_agreement, '·') || '|' ||
        coalesce(professional_category, '·') || '|' || coalesce(contract_type, '·') || '|' ||
        coalesce(employee_status, '·') || '|' || coalesce(seniority_min_months::text, '·') || '|' ||
        work_time || '|' || coalesce(population_key, '·'))
  ) STORED,
  status                text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  created_by            uuid NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, absence_type_id) REFERENCES leave.absence_types (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id)      REFERENCES org.companies (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id)         REFERENCES org.sites (tenant_id, id)
);
CREATE UNIQUE INDEX policies_one_active_per_population ON leave.policies
  (tenant_id, absence_type_id, selector_sig) WHERE (status = 'active');
CREATE TRIGGER trg_policies_nodelete BEFORE DELETE ON leave.policies
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

CREATE TABLE leave.policy_versions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL,
  policy_id             uuid NOT NULL,
  version               int  NOT NULL CHECK (version >= 1),
  effective_from        date NOT NULL,
  -- Acquisition : mode + SOURCE du rythme — clé E4 (résolue à la date du fait
  -- générateur) OU valeur explicite du tenant. JAMAIS un défaut du moteur.
  accrual_mode          text NOT NULL CHECK (accrual_mode IN ('monthly', 'annual', 'anniversary', 'one_time', 'none')),
  accrual_rate_param    text CHECK (accrual_rate_param IS NULL OR accrual_rate_param ~ '^[a-z0-9]+(\.[a-z0-9_]+)+$'),
  accrual_rate_value    numeric(9,3) CHECK (accrual_rate_value IS NULL OR accrual_rate_value > 0),
  CONSTRAINT accrual_rate_single_source CHECK (
    accrual_mode = 'none' OR (accrual_rate_param IS NULL) <> (accrual_rate_value IS NULL)
  ),
  -- Période de référence du droit.
  reference_period      text NOT NULL DEFAULT 'calendar_year'
                        CHECK (reference_period IN ('calendar_year', 'anniversary', 'custom')),
  ref_start_month       int CHECK (ref_start_month IS NULL OR ref_start_month BETWEEN 1 AND 12),
  ref_start_day         int CHECK (ref_start_day IS NULL OR ref_start_day BETWEEN 1 AND 28),
  CONSTRAINT custom_ref_complete CHECK (
    reference_period <> 'custom' OR (ref_start_month IS NOT NULL AND ref_start_day IS NOT NULL)
  ),
  -- Conditions et règles (source E4 ou valeur tenant, même discipline).
  eligibility_min_months_param text CHECK (eligibility_min_months_param IS NULL OR eligibility_min_months_param ~ '^[a-z0-9]+(\.[a-z0-9_]+)+$'),
  eligibility_min_months       int  CHECK (eligibility_min_months IS NULL OR eligibility_min_months BETWEEN 0 AND 600),
  accrual_requires_service     boolean NOT NULL DEFAULT false,  -- acquisition conditionnée au service effectif (suspension ⇒ pas d'acquisition)
  prorata_hire          boolean NOT NULL DEFAULT true,
  prorata_termination   boolean NOT NULL DEFAULT true,
  prorata_part_time     boolean NOT NULL DEFAULT false,
  rounding              text NOT NULL DEFAULT 'none' CHECK (rounding IN ('none', 'half_up_0_5', 'up_0_5', 'up_1')),
  cap_param             text CHECK (cap_param IS NULL OR cap_param ~ '^[a-z0-9]+(\.[a-z0-9_]+)+$'),
  cap_value             numeric(9,3) CHECK (cap_value IS NULL OR cap_value > 0),
  carry_over_max_param  text CHECK (carry_over_max_param IS NULL OR carry_over_max_param ~ '^[a-z0-9]+(\.[a-z0-9_]+)+$'),
  carry_over_max_value  numeric(9,3) CHECK (carry_over_max_value IS NULL OR carry_over_max_value >= 0),
  carry_over_expiry_months int CHECK (carry_over_expiry_months IS NULL OR carry_over_expiry_months BETWEEN 1 AND 60),
  min_block             numeric(9,3) CHECK (min_block IS NULL OR min_block > 0),   -- consommation minimale (fractionnement)
  max_per_request       numeric(9,3) CHECK (max_per_request IS NULL OR max_per_request > 0),
  notice_days           int CHECK (notice_days IS NULL OR notice_days BETWEEN 0 AND 365),
  anticipation_allowed  boolean NOT NULL DEFAULT false,
  approval_levels       int NOT NULL DEFAULT 1 CHECK (approval_levels BETWEEN 0 AND 3),
  notes                 text CHECK (notes IS NULL OR char_length(notes) <= 500),
  created_by            uuid NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, policy_id, version),
  UNIQUE (tenant_id, policy_id, effective_from),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, policy_id) REFERENCES leave.policies (tenant_id, id)
);
-- Une version publiée est IMMUABLE (l'histoire ne se réécrit pas) ; on n'en
-- supprime jamais. Une règle nouvelle = une version nouvelle, datée.
CREATE TRIGGER trg_policy_versions_immutable BEFORE UPDATE OR DELETE ON leave.policy_versions
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

-- ---------------------------------------------------------------------------
-- LEDGER des droits — append-only ABSOLU, cœur du module.
-- ---------------------------------------------------------------------------
CREATE TABLE leave.entitlement_ledger (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES admin.tenants(id),
  employee_id            uuid NOT NULL,
  absence_type_id        uuid NOT NULL,
  policy_id              uuid,
  policy_version         int CHECK (policy_version IS NULL OR policy_version >= 1),
  reference_period_start date NOT NULL,
  reference_period_end   date NOT NULL CHECK (reference_period_end >= reference_period_start),
  entry_kind             text NOT NULL CHECK (entry_kind IN (
                           'opening_balance', 'accrual', 'grant', 'reservation', 'release',
                           'consumption', 'adjustment_credit', 'adjustment_debit',
                           'carry_over', 'expiry', 'reversal')),
  quantity               numeric(9,3) NOT NULL CHECK (quantity > 0),
  unit                   text NOT NULL CHECK (unit IN ('open_days', 'working_days', 'calendar_days', 'half_days', 'hours')),
  effective_on           date NOT NULL,
  origin                 text NOT NULL CHECK (origin IN (
                           'system_accrual', 'carry_over_job', 'import', 'admin', 'workflow', 'migration', 'reversal')),
  business_ref           text CHECK (business_ref IS NULL OR char_length(business_ref) <= 200),
  reason                 text CHECK (reason IS NULL OR char_length(reason) <= 500),
  reversal_of            uuid,
  CONSTRAINT reversal_referenced CHECK (entry_kind <> 'reversal' OR reversal_of IS NOT NULL),
  -- Acquisition/report/expiration : toujours adossées à une politique versionnée.
  CONSTRAINT policy_required CHECK (
    entry_kind NOT IN ('accrual', 'carry_over', 'expiry') OR (policy_id IS NOT NULL AND policy_version IS NOT NULL)
  ),
  params_used            jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(params_used) = 'object'),
  idempotency_key        text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  created_by             uuid,        -- NULL = processus système (l'origine dit lequel)
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id)     REFERENCES core.employees (tenant_id, id),
  FOREIGN KEY (tenant_id, absence_type_id) REFERENCES leave.absence_types (tenant_id, id),
  FOREIGN KEY (tenant_id, policy_id)       REFERENCES leave.policies (tenant_id, id),
  FOREIGN KEY (tenant_id, reversal_of)     REFERENCES leave.entitlement_ledger (tenant_id, id)
);
CREATE INDEX entitlement_ledger_emp_idx ON leave.entitlement_ledger
  (tenant_id, employee_id, absence_type_id, reference_period_start);
CREATE INDEX entitlement_ledger_kind_idx ON leave.entitlement_ledger (tenant_id, entry_kind, effective_on);
CREATE TRIGGER trg_entitlement_ledger_immutable BEFORE UPDATE OR DELETE ON leave.entitlement_ledger
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

-- SOLDES : une VUE (security_invoker : la RLS du lecteur s'applique), jamais une
-- table. disponible = acquis − débits − expiré − réservé − consommé.
CREATE VIEW leave.balances_v WITH (security_invoker = true) AS
SELECT
  tenant_id, employee_id, absence_type_id, unit,
  reference_period_start, reference_period_end,
  sum(quantity) FILTER (WHERE entry_kind IN ('opening_balance', 'accrual', 'grant', 'adjustment_credit', 'carry_over')) AS accrued,
  sum(quantity) FILTER (WHERE entry_kind = 'adjustment_debit')                                                          AS adjusted_out,
  sum(quantity) FILTER (WHERE entry_kind = 'carry_over')                                                                AS carried_in,
  sum(quantity) FILTER (WHERE entry_kind = 'expiry')                                                                    AS expired,
  sum(quantity) FILTER (WHERE entry_kind = 'reservation') - coalesce(sum(quantity) FILTER (WHERE entry_kind = 'release'), 0) AS reserved,
  sum(quantity) FILTER (WHERE entry_kind = 'consumption') - coalesce(sum(quantity) FILTER (WHERE entry_kind = 'reversal'), 0) AS consumed,
  coalesce(sum(quantity) FILTER (WHERE entry_kind IN ('opening_balance', 'accrual', 'grant', 'adjustment_credit', 'carry_over')), 0)
    - coalesce(sum(quantity) FILTER (WHERE entry_kind = 'adjustment_debit'), 0)
    - coalesce(sum(quantity) FILTER (WHERE entry_kind = 'expiry'), 0)
    - (coalesce(sum(quantity) FILTER (WHERE entry_kind = 'reservation'), 0) - coalesce(sum(quantity) FILTER (WHERE entry_kind = 'release'), 0))
    - (coalesce(sum(quantity) FILTER (WHERE entry_kind = 'consumption'), 0) - coalesce(sum(quantity) FILTER (WHERE entry_kind = 'reversal'), 0)) AS available
FROM leave.entitlement_ledger
GROUP BY tenant_id, employee_id, absence_type_id, unit, reference_period_start, reference_period_end;

-- ---------------------------------------------------------------------------
-- Exécutions d'acquisition — bornées, idempotentes, anti-concurrentes.
-- ---------------------------------------------------------------------------
CREATE TABLE leave.accrual_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES admin.tenants(id),
  period_start     date NOT NULL,
  period_end       date NOT NULL CHECK (period_end >= period_start),
  scope_kind       text NOT NULL CHECK (scope_kind IN ('tenant', 'company', 'site', 'employee')),
  scope_company_id uuid,
  scope_site_id    uuid,
  scope_employee_id uuid,
  reason           text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 300),
  kind             text NOT NULL DEFAULT 'accrual' CHECK (kind IN ('accrual', 'carry_over', 'recompute')),
  status           text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'completed_with_errors', 'failed')),
  engine_version   text NOT NULL,
  employees_count  int NOT NULL DEFAULT 0,
  entries_written  int NOT NULL DEFAULT 0,
  entries_skipped  int NOT NULL DEFAULT 0,   -- idempotence : déjà au ledger
  errors_count     int NOT NULL DEFAULT 0,
  error_report     jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(error_report) = 'array'),
  started_by       uuid NOT NULL,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, scope_company_id)  REFERENCES org.companies (tenant_id, id),
  FOREIGN KEY (tenant_id, scope_site_id)     REFERENCES org.sites (tenant_id, id),
  FOREIGN KEY (tenant_id, scope_employee_id) REFERENCES core.employees (tenant_id, id),
  -- Deux exécutions ACTIVES d'un même tenant ne se chevauchent jamais en période.
  CONSTRAINT accrual_runs_no_concurrent_overlap EXCLUDE USING gist (
    tenant_id WITH =,
    daterange(period_start, period_end, '[]') WITH &&
  ) WHERE (status = 'running')
);
CREATE INDEX accrual_runs_tenant_idx ON leave.accrual_runs (tenant_id, started_at DESC);
CREATE TRIGGER trg_accrual_runs_nodelete BEFORE DELETE ON leave.accrual_runs
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

-- ---------------------------------------------------------------------------
-- Import de soldes d'ouverture — atomique par défaut, idempotent, tracé.
-- ---------------------------------------------------------------------------
CREATE TABLE leave.opening_imports (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES admin.tenants(id),
  filename         text CHECK (filename IS NULL OR char_length(filename) <= 200),
  as_of_date       date NOT NULL,
  status           text NOT NULL DEFAULT 'applied' CHECK (status IN ('applied', 'rejected')),
  atomic           boolean NOT NULL DEFAULT true,
  lines_received   int NOT NULL DEFAULT 0,
  lines_accepted   int NOT NULL DEFAULT 0,
  lines_duplicated int NOT NULL DEFAULT 0,
  lines_rejected   int NOT NULL DEFAULT 0,
  error_report     jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(error_report) = 'array'),
  file_sha256      char(64),
  source_note      text CHECK (source_note IS NULL OR char_length(source_note) <= 300),
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE TRIGGER trg_opening_imports_immutable BEFORE UPDATE OR DELETE ON leave.opening_imports
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

-- ---------------------------------------------------------------------------
-- Ajustements SENSIBLES en attente de circuit E3 — le ledger ne porte JAMAIS
-- d'écriture technique : la demande vit ici, le mouvement naît à l'approbation.
-- ---------------------------------------------------------------------------
CREATE TABLE leave.pending_adjustments (
  id                     uuid PRIMARY KEY,
  tenant_id              uuid NOT NULL REFERENCES admin.tenants(id),
  employee_id            uuid NOT NULL,
  absence_type_id        uuid NOT NULL,
  reference_period_start date NOT NULL,
  reference_period_end   date NOT NULL CHECK (reference_period_end >= reference_period_start),
  direction              text NOT NULL CHECK (direction IN ('credit', 'debit')),
  quantity               numeric(9,3) NOT NULL CHECK (quantity > 0),
  reason                 text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  business_ref           text CHECK (business_ref IS NULL OR char_length(business_ref) <= 200),
  before_available       numeric(9,3) NOT NULL,
  status                 text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'rejected', 'cancelled')),
  workflow_instance_id   uuid,
  created_by             uuid NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  decided_at             timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id)     REFERENCES core.employees (tenant_id, id),
  FOREIGN KEY (tenant_id, absence_type_id) REFERENCES leave.absence_types (tenant_id, id)
);
CREATE TRIGGER trg_pending_adjustments_nodelete BEFORE DELETE ON leave.pending_adjustments
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

-- ---------------------------------------------------------------------------
-- Permissions E11.1.
-- ---------------------------------------------------------------------------
INSERT INTO admin.permissions (key, description) VALUES
  ('leave.balance_view_own',  'Consulter SES soldes de congés, sa projection et son propre ledger'),
  ('leave.balance_view_team', 'Consulter les soldes des salariés dont on est le responsable résolu (E9) — audité'),
  ('leave.balance_view',      'Consulter les soldes de sa portée organisationnelle (RH) — audité'),
  ('leave.ledger_view',       'Consulter l''historique du ledger des droits de sa portée — audité'),
  ('leave.types_admin',       'Administrer le référentiel des types d''absence'),
  ('leave.policies_admin',    'Administrer les politiques de congés versionnées'),
  ('leave.accrual_run',       'Lancer une acquisition, un report/expiration ou une régularisation motivée'),
  ('leave.balance_adjust',    'Créer un ajustement administratif de droit (mouvement compensatoire motivé) — audité'),
  ('leave.openings_import',   'Importer des soldes d''ouverture (reprise) — atomique et idempotent'),
  ('leave.sensitive_view',    'Consulter les motifs et références des types confidentiels — chaque accès est journalisé');

-- ---------------------------------------------------------------------------
-- RLS + droits du rôle applicatif (jamais de DELETE ; ledger et versions sans UPDATE).
-- ---------------------------------------------------------------------------
ALTER TABLE leave.absence_types      ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave.policies           ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave.policy_versions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave.entitlement_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave.accrual_runs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave.opening_imports    ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave.pending_adjustments ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_rows ON leave.absence_types      TO kora_app USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON leave.policies           TO kora_app USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON leave.policy_versions    TO kora_app USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON leave.entitlement_ledger TO kora_app USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON leave.accrual_runs       TO kora_app USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON leave.opening_imports    TO kora_app USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON leave.pending_adjustments TO kora_app USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());

GRANT USAGE ON SCHEMA leave TO kora_app;
GRANT SELECT, INSERT, UPDATE ON leave.absence_types      TO kora_app;  -- gel sémantique par trigger
GRANT SELECT, INSERT, UPDATE ON leave.policies           TO kora_app;  -- statuts/libellés
GRANT SELECT, INSERT         ON leave.policy_versions    TO kora_app;  -- versions immuables
GRANT SELECT, INSERT         ON leave.entitlement_ledger TO kora_app;  -- APPEND-ONLY
GRANT SELECT ON leave.balances_v TO kora_app;
GRANT SELECT, INSERT, UPDATE ON leave.accrual_runs       TO kora_app;  -- compteurs/fin d'exécution
GRANT SELECT, INSERT         ON leave.opening_imports    TO kora_app;  -- rapport immuable
GRANT SELECT, INSERT, UPDATE ON leave.pending_adjustments TO kora_app; -- statut de la demande seule
