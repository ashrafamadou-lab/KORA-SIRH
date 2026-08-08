-- 0022 — E12.1 Paie : référentiel de rémunération, rubriques versionnées et
-- moteur de calcul BRUT reproductible.
--
-- RÈGLE JURIDIQUE IMPÉRATIVE, tenue PAR LA BASE : aucune valeur légale (taux
-- CNSS, barème ITS, VPS, SMIG, plafond, majoration) n'existe dans ce schéma.
-- Une rubrique qui dépend d'une telle valeur porte une CLÉ de paramètre E4 ; la
-- valeur est résolue À LA DATE DE PAIE avec sa provenance (source, date d'effet,
-- contreseing) et figée dans le résultat. Un paramètre introuvable fait ÉCHOUER
-- le calcul — il n'existe aucun repli, aucune valeur par défaut.
--
-- REPRODUCTIBILITÉ : Salarié + Période + Version de rémunération + Clôture E10 +
-- Clôture E11 + Versions de paramètres E4 + Version du moteur → Résultat. Les
-- mêmes entrées donnent toujours le même résultat ; une règle nouvelle ne touche
-- JAMAIS une paie historique sans recalcul explicite et versionné.
--
-- AUCUNE EXÉCUTION ARBITRAIRE : une formule est un ARBRE de nœuds à grammaire
-- FERMÉE, validé par la base elle-même (payroll.node_is_safe) — jamais du code.

CREATE SCHEMA IF NOT EXISTS payroll;

-- ---------------------------------------------------------------------------
-- Grammaire FERMÉE des formules et des conditions — validée PAR LA BASE.
-- Un nœud inconnu, un identifiant hors motif, une profondeur excessive : refusé.
-- ---------------------------------------------------------------------------
CREATE FUNCTION payroll.node_is_safe(node jsonb, as_cond boolean, depth int)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE k text;
BEGIN
  IF depth > 24 THEN RETURN false; END IF;
  IF node IS NULL OR jsonb_typeof(node) <> 'object' THEN RETURN false; END IF;
  k := node->>'k';
  IF k IS NULL THEN RETURN false; END IF;

  IF as_cond THEN
    IF k IN ('lt', 'lte', 'gt', 'gte', 'eq', 'ne') THEN
      RETURN payroll.node_is_safe(node->'a', false, depth + 1)
         AND payroll.node_is_safe(node->'b', false, depth + 1);
    ELSIF k IN ('and', 'or') THEN
      RETURN payroll.node_is_safe(node->'a', true, depth + 1)
         AND payroll.node_is_safe(node->'b', true, depth + 1);
    ELSIF k = 'not' THEN
      RETURN payroll.node_is_safe(node->'a', true, depth + 1);
    ELSIF k = 'always' THEN
      RETURN true;
    END IF;
    RETURN false;
  END IF;

  IF k = 'num' THEN
    RETURN jsonb_typeof(node->'v') = 'number';
  ELSIF k = 'var' THEN
    RETURN (node->>'name') ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$';
  ELSIF k = 'param' THEN
    -- Clé E4 dotée en minuscules : la VALEUR n'est jamais ici, seulement la clé.
    RETURN (node->>'key') ~ '^[a-z0-9]+(\.[a-z0-9_]+)+$';
  ELSIF k IN ('add', 'sub', 'mul', 'div', 'min', 'max') THEN
    RETURN payroll.node_is_safe(node->'a', false, depth + 1)
       AND payroll.node_is_safe(node->'b', false, depth + 1);
  ELSIF k = 'round' THEN
    RETURN jsonb_typeof(node->'dp') = 'number'
       AND payroll.node_is_safe(node->'a', false, depth + 1);
  ELSIF k = 'if' THEN
    RETURN payroll.node_is_safe(node->'cond', true, depth + 1)
       AND payroll.node_is_safe(node->'then', false, depth + 1)
       AND payroll.node_is_safe(node->'else', false, depth + 1);
  END IF;
  RETURN false;
END $$;

-- ---------------------------------------------------------------------------
-- Calendriers et périodes de paie.
-- ---------------------------------------------------------------------------
CREATE TABLE payroll.pay_calendars (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES admin.tenants(id),
  code       text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,29}$'),
  label_fr   text NOT NULL CHECK (char_length(label_fr) BETWEEN 1 AND 120),
  label_en   text NOT NULL CHECK (char_length(label_en) BETWEEN 1 AND 120),
  frequency  text NOT NULL CHECK (frequency IN ('monthly', 'biweekly', 'weekly')),
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE payroll.pay_periods (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES admin.tenants(id),
  calendar_id  uuid NOT NULL,
  label        text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 100),
  period_start date NOT NULL,
  period_end   date NOT NULL,
  -- Date de paie : c'est ELLE qui date la résolution des paramètres E4.
  pay_date     date NOT NULL,
  status       text NOT NULL DEFAULT 'open'
               CHECK (status IN ('open', 'locked', 'validated', 'reopened', 'archived')),
  revision     int  NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start),
  CHECK (pay_date >= period_start),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, calendar_id) REFERENCES payroll.pay_calendars (tenant_id, id),
  -- Deux périodes du MÊME calendrier ne se chevauchent jamais.
  EXCLUDE USING gist (
    tenant_id WITH =, calendar_id WITH =,
    daterange(period_start, period_end, '[]') WITH &&
  ) WHERE (status <> 'archived')
);

CREATE FUNCTION payroll.guard_pay_period_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.period_start, NEW.period_end, NEW.calendar_id) IS DISTINCT FROM
     (OLD.period_start, OLD.period_end, OLD.calendar_id) THEN
    RAISE EXCEPTION 'période de paie % : bornes et calendrier IMMUABLES', OLD.id
      USING ERRCODE = 'raise_exception';
  END IF;
  IF NEW.status <> OLD.status THEN
    IF NOT (
      (OLD.status = 'open'      AND NEW.status IN ('locked', 'archived')) OR
      (OLD.status = 'locked'    AND NEW.status IN ('open', 'validated')) OR
      (OLD.status = 'validated' AND NEW.status = 'reopened') OR
      (OLD.status = 'reopened'  AND NEW.status IN ('locked', 'validated', 'archived'))
    ) THEN
      RAISE EXCEPTION 'période de paie % : transition interdite % -> %', OLD.id, OLD.status, NEW.status
        USING ERRCODE = 'raise_exception';
    END IF;
    -- La réouverture d'une paie VALIDÉE est versionnée : l'histoire demeure.
    IF OLD.status = 'validated' AND NEW.status = 'reopened' AND NEW.revision <> OLD.revision + 1 THEN
      RAISE EXCEPTION 'réouverture de paie sans incrément de révision' USING ERRCODE = 'raise_exception';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER trg_pay_periods_guard BEFORE UPDATE ON payroll.pay_periods
  FOR EACH ROW EXECUTE FUNCTION payroll.guard_pay_period_update();
CREATE TRIGGER trg_pay_periods_nodelete BEFORE DELETE ON payroll.pay_periods
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

-- ---------------------------------------------------------------------------
-- Structures salariales et rubriques.
-- ---------------------------------------------------------------------------
CREATE TABLE payroll.salary_structures (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES admin.tenants(id),
  code       text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,29}$'),
  label_fr   text NOT NULL,
  label_en   text NOT NULL,
  status     text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

-- Nature d'une rubrique : le SENS (gain/retenue, imposable, cotisable) est figé
-- dès qu'un résultat de paie la référence — une requalification rétroactive
-- changerait des paies déjà calculées.
CREATE TABLE payroll.rubrics (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES admin.tenants(id),
  code       text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,29}$'),
  label_fr   text NOT NULL,
  label_en   text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('gain', 'prime', 'indemnite', 'avantage', 'retenue')),
  taxable    boolean NOT NULL,
  cotisable  boolean NOT NULL,
  sequence   int NOT NULL DEFAULT 100,
  status     text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  notes      text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE FUNCTION payroll.guard_rubric_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE used boolean;
BEGIN
  IF (NEW.kind, NEW.taxable, NEW.cotisable, NEW.code) IS DISTINCT FROM
     (OLD.kind, OLD.taxable, OLD.cotisable, OLD.code) THEN
    SELECT EXISTS (SELECT 1 FROM payroll.result_lines l WHERE l.rubric_id = OLD.id) INTO used;
    IF used THEN
      RAISE EXCEPTION 'rubrique % : nature FIGÉE dès le premier calcul (sens, imposable, cotisable, code)', OLD.code
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Version d'une rubrique : datée, IMMUABLE, jamais supprimée. La valorisation
-- est soit un montant fixe, soit un taux, soit une FORMULE (arbre fermé).
CREATE TABLE payroll.rubric_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES admin.tenants(id),
  rubric_id      uuid NOT NULL,
  version        int  NOT NULL CHECK (version >= 1),
  effective_from date NOT NULL,
  valuation      text NOT NULL CHECK (valuation IN ('fixed', 'rate', 'formula')),
  fixed_value    numeric(18,4),
  -- Un taux vient d'un PARAMÈTRE E4 (clé) ou d'une valeur INTERNE assumée
  -- (prime d'entreprise) : jamais un taux légal écrit en dur.
  rate_value     numeric(12,6),
  rate_param_key text CHECK (rate_param_key IS NULL OR rate_param_key ~ '^[a-z0-9]+(\.[a-z0-9_]+)+$'),
  rate_base      text CHECK (rate_base IS NULL OR rate_base ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$'),
  formula        jsonb,
  eligibility    jsonb,
  proration      text NOT NULL DEFAULT 'none' CHECK (proration IN ('none', 'worked_days', 'calendar_days')),
  cap_value      numeric(18,4),
  cap_param_key  text CHECK (cap_param_key IS NULL OR cap_param_key ~ '^[a-z0-9]+(\.[a-z0-9_]+)+$'),
  floor_value    numeric(18,4),
  rounding_dp    int CHECK (rounding_dp IS NULL OR rounding_dp BETWEEN 0 AND 6),
  notes          text,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, rubric_id, version),
  UNIQUE (tenant_id, rubric_id, effective_from),
  FOREIGN KEY (tenant_id, rubric_id) REFERENCES payroll.rubrics (tenant_id, id),
  -- Forme COHÉRENTE de la valorisation : rien d'implicite.
  CONSTRAINT rubric_valuation_shape CHECK (
    (valuation = 'fixed'   AND fixed_value IS NOT NULL AND formula IS NULL) OR
    (valuation = 'rate'    AND rate_base IS NOT NULL AND formula IS NULL
                           AND ((rate_value IS NOT NULL) <> (rate_param_key IS NOT NULL))) OR
    (valuation = 'formula' AND formula IS NOT NULL AND fixed_value IS NULL AND rate_value IS NULL)
  ),
  -- La BASE refuse une formule hors grammaire : aucune exécution arbitraire.
  CONSTRAINT rubric_formula_safe CHECK (valuation <> 'formula' OR payroll.node_is_safe(formula, false, 0)),
  CONSTRAINT rubric_eligibility_safe CHECK (eligibility IS NULL OR payroll.node_is_safe(eligibility, true, 0))
);
CREATE TRIGGER trg_rubric_versions_frozen BEFORE UPDATE OR DELETE ON payroll.rubric_versions
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

CREATE TABLE payroll.structure_rubrics (
  tenant_id    uuid NOT NULL,
  structure_id uuid NOT NULL,
  rubric_id    uuid NOT NULL,
  sequence     int  NOT NULL DEFAULT 100,
  PRIMARY KEY (tenant_id, structure_id, rubric_id),
  FOREIGN KEY (tenant_id, structure_id) REFERENCES payroll.salary_structures (tenant_id, id),
  FOREIGN KEY (tenant_id, rubric_id)    REFERENCES payroll.rubrics (tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- Rémunération HISTORISÉE : une version datée par salarié, jamais réécrite.
-- Un changement FUTUR ne touche aucune paie déjà calculée (la version applicable
-- se résout à la date de la période).
-- ---------------------------------------------------------------------------
CREATE TABLE payroll.compensations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES admin.tenants(id),
  employee_id    uuid NOT NULL,
  structure_id   uuid NOT NULL,
  effective_from date NOT NULL,
  base_amount    numeric(18,4) NOT NULL CHECK (base_amount >= 0),
  currency       char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  periodicity    text NOT NULL CHECK (periodicity IN ('monthly', 'hourly', 'daily')),
  reason         text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, employee_id, effective_from),
  FOREIGN KEY (tenant_id, employee_id)  REFERENCES core.employees (tenant_id, id),
  FOREIGN KEY (tenant_id, structure_id) REFERENCES payroll.salary_structures (tenant_id, id)
);
CREATE TRIGGER trg_compensations_frozen BEFORE UPDATE OR DELETE ON payroll.compensations
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

-- ---------------------------------------------------------------------------
-- Prélèvements (CNSS, ITS, VPS, autres) : INTERFACE paramétrique et versionnée.
-- E12.1 N'EN CALCULE AUCUN — seules les ASSIETTES sont produites. Les taux et
-- plafonds sont des CLÉS E4, jamais des valeurs.
-- ---------------------------------------------------------------------------
CREATE TABLE payroll.levies (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES admin.tenants(id),
  code       text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,29}$'),
  label_fr   text NOT NULL,
  label_en   text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('salarial', 'patronal', 'impot')),
  base_kind  text NOT NULL CHECK (base_kind IN ('cotisable', 'imposable', 'brut')),
  status     text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE payroll.levy_versions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES admin.tenants(id),
  levy_id           uuid NOT NULL,
  version           int  NOT NULL CHECK (version >= 1),
  effective_from    date NOT NULL,
  -- UNIQUEMENT des clés E4 : le taux, le plafond et le plancher vivent au
  -- Config Center, datés, sourcés et contresignés — jamais ici.
  rate_param_key    text NOT NULL CHECK (rate_param_key ~ '^[a-z0-9]+(\.[a-z0-9_]+)+$'),
  ceiling_param_key text CHECK (ceiling_param_key IS NULL OR ceiling_param_key ~ '^[a-z0-9]+(\.[a-z0-9_]+)+$'),
  floor_param_key   text CHECK (floor_param_key IS NULL OR floor_param_key ~ '^[a-z0-9]+(\.[a-z0-9_]+)+$'),
  exemption         jsonb,
  notes             text,
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, levy_id, version),
  FOREIGN KEY (tenant_id, levy_id) REFERENCES payroll.levies (tenant_id, id),
  CONSTRAINT levy_exemption_safe CHECK (exemption IS NULL OR payroll.node_is_safe(exemption, true, 0))
);
CREATE TRIGGER trg_levy_versions_frozen BEFORE UPDATE OR DELETE ON payroll.levy_versions
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

-- ---------------------------------------------------------------------------
-- Exécutions et RÉSULTATS de paie : append-only, versionnés, explicables.
-- ---------------------------------------------------------------------------
CREATE TABLE payroll.runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES admin.tenants(id),
  period_id       uuid NOT NULL,
  period_revision int  NOT NULL,
  scope_kind      text NOT NULL CHECK (scope_kind IN ('tenant', 'employee')),
  scope_employee_id uuid,
  reason          text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 300),
  engine_version  text NOT NULL,
  time_close_id   uuid,
  leave_close_id  uuid,
  params_snapshot jsonb NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running', 'completed', 'completed_with_errors', 'failed')),
  employees_count int NOT NULL DEFAULT 0,
  results_count   int NOT NULL DEFAULT 0,
  errors          jsonb NOT NULL DEFAULT '[]',
  dataset_sha256  char(64),
  started_by      uuid,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, period_id) REFERENCES payroll.pay_periods (tenant_id, id),
  CHECK ((scope_kind = 'employee') = (scope_employee_id IS NOT NULL))
);
CREATE FUNCTION payroll.guard_run_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.period_id, NEW.scope_kind, NEW.engine_version, NEW.started_by, NEW.reason)
     IS DISTINCT FROM (OLD.period_id, OLD.scope_kind, OLD.engine_version, OLD.started_by, OLD.reason) THEN
    RAISE EXCEPTION 'exécution de paie % : entrées FIGÉES', OLD.id USING ERRCODE = 'raise_exception';
  END IF;
  IF OLD.status <> 'running' AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'exécution de paie % : statut définitif (% -> %)', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_payroll_runs_guard BEFORE UPDATE ON payroll.runs
  FOR EACH ROW EXECUTE FUNCTION payroll.guard_run_update();
CREATE TRIGGER trg_payroll_runs_nodelete BEFORE DELETE ON payroll.runs
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

CREATE TABLE payroll.results (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES admin.tenants(id),
  run_id          uuid NOT NULL,
  period_id       uuid NOT NULL,
  employee_id     uuid NOT NULL,
  version         int  NOT NULL CHECK (version >= 1),
  is_current      boolean NOT NULL DEFAULT true,
  compensation_id uuid NOT NULL,
  structure_id    uuid NOT NULL,
  currency        char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- BRUT et ASSIETTES : E12.1 s'arrête là. Aucun net, aucune cotisation.
  gross_amount    numeric(18,4) NOT NULL,
  taxable_base    numeric(18,4) NOT NULL,
  contributable_base numeric(18,4) NOT NULL,
  lines_count     int NOT NULL DEFAULT 0,
  -- Empreinte des ENTRÉES (salarié, versions, clôtures, paramètres, moteur) :
  -- deux calculs d'empreinte identique DOIVENT donner le même brut.
  inputs_sha256   char(64) NOT NULL,
  time_close_id   uuid,
  leave_close_id  uuid,
  params_used     jsonb NOT NULL DEFAULT '{}',
  inputs_used     jsonb NOT NULL DEFAULT '{}',
  engine_version  text NOT NULL,
  computed_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, period_id, employee_id, version),
  FOREIGN KEY (tenant_id, run_id)          REFERENCES payroll.runs (tenant_id, id),
  FOREIGN KEY (tenant_id, period_id)       REFERENCES payroll.pay_periods (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id)     REFERENCES core.employees (tenant_id, id),
  FOREIGN KEY (tenant_id, compensation_id) REFERENCES payroll.compensations (tenant_id, id),
  FOREIGN KEY (tenant_id, structure_id)    REFERENCES payroll.salary_structures (tenant_id, id)
);
-- UN SEUL résultat courant par (période, salarié) : deux calculs concurrents ne
-- peuvent pas produire deux paies vivantes incompatibles — la base l'interdit.
CREATE UNIQUE INDEX payroll_results_one_current
  ON payroll.results (tenant_id, period_id, employee_id) WHERE is_current;

CREATE FUNCTION payroll.guard_result_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF to_jsonb(NEW) - 'is_current' IS DISTINCT FROM to_jsonb(OLD) - 'is_current' THEN
    RAISE EXCEPTION 'résultat de paie % : IMMUABLE (un recalcul crée une VERSION)', OLD.id
      USING ERRCODE = 'raise_exception';
  END IF;
  IF OLD.is_current = false AND NEW.is_current = true THEN
    RAISE EXCEPTION 'résultat de paie % : une version dépassée ne redevient pas courante', OLD.id
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_payroll_results_guard BEFORE UPDATE ON payroll.results
  FOR EACH ROW EXECUTE FUNCTION payroll.guard_result_update();
CREATE TRIGGER trg_payroll_results_nodelete BEFORE DELETE ON payroll.results
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

-- Une paie VALIDÉE reste historisée : plus aucun résultat ne s'écrit dans la
-- période tant qu'elle n'a pas été rouverte (révision +1, circuit contrôlé).
CREATE FUNCTION payroll.guard_result_period_open() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  SELECT p.status INTO st FROM payroll.pay_periods p
   WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.period_id;
  IF st IN ('validated', 'archived') THEN
    RAISE EXCEPTION 'période de paie % : paie validée — réouverture contrôlée requise', NEW.period_id
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_payroll_results_period BEFORE INSERT ON payroll.results
  FOR EACH ROW EXECUTE FUNCTION payroll.guard_result_period_open();

-- Ligne de paie : CHAQUE montant se relie à sa rubrique, sa valorisation, ses
-- entrées et ses paramètres — la trace d'évaluation est portée par la ligne.
CREATE TABLE payroll.result_lines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  result_id    uuid NOT NULL,
  sequence     int  NOT NULL,
  rubric_id    uuid NOT NULL,
  rubric_version_id uuid NOT NULL,
  rubric_code  text NOT NULL,
  label_fr     text NOT NULL,
  label_en     text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('gain', 'prime', 'indemnite', 'avantage', 'retenue')),
  taxable      boolean NOT NULL,
  cotisable    boolean NOT NULL,
  valuation    text NOT NULL CHECK (valuation IN ('fixed', 'rate', 'formula')),
  base         numeric(18,4),
  rate         numeric(12,6),
  quantity     numeric(18,4),
  amount       numeric(18,4) NOT NULL,
  -- Explication LIGNE PAR LIGNE : suite ordonnée des étapes d'évaluation.
  trace        jsonb NOT NULL DEFAULT '[]',
  inputs_used  jsonb NOT NULL DEFAULT '{}',
  params_used  jsonb NOT NULL DEFAULT '{}',
  UNIQUE (tenant_id, result_id, sequence),
  FOREIGN KEY (tenant_id, result_id)         REFERENCES payroll.results (tenant_id, id),
  FOREIGN KEY (tenant_id, rubric_id)         REFERENCES payroll.rubrics (tenant_id, id),
  FOREIGN KEY (tenant_id, rubric_version_id) REFERENCES payroll.rubric_versions (tenant_id, id)
);
CREATE TRIGGER trg_payroll_result_lines_frozen BEFORE UPDATE OR DELETE ON payroll.result_lines
  FOR EACH ROW EXECUTE FUNCTION org.forbid_mutation();

CREATE INDEX payroll_results_period_idx ON payroll.results (tenant_id, period_id, employee_id);
CREATE INDEX payroll_result_lines_result_idx ON payroll.result_lines (tenant_id, result_id, sequence);
CREATE INDEX payroll_compensations_emp_idx ON payroll.compensations (tenant_id, employee_id, effective_from DESC);
CREATE INDEX payroll_rubric_versions_idx ON payroll.rubric_versions (tenant_id, rubric_id, effective_from DESC);

-- ---------------------------------------------------------------------------
-- Permissions (9 nouvelles).
-- ---------------------------------------------------------------------------
INSERT INTO admin.permissions (key, description) VALUES
  ('payroll.calendar_manage',    'Créer et administrer les calendriers et périodes de paie (bornes immuables, cycle contrôlé)'),
  ('payroll.structures_manage',  'Administrer les structures salariales et leur composition'),
  ('payroll.rubrics_manage',     'Administrer les rubriques de paie et leurs versions datées (formules à grammaire fermée)'),
  ('payroll.compensation_view',  'Consulter la rémunération historisée des salariés de sa portée'),
  ('payroll.compensation_manage','Enregistrer une nouvelle version de rémunération (jamais une réécriture)'),
  ('payroll.simulate',           'Simuler un calcul de paie brut — aucune écriture'),
  ('payroll.run',                'Exécuter un calcul de paie brut versionné et verrouiller/valider une période'),
  ('payroll.results_view',       'Consulter les résultats de paie, leurs lignes expliquées et leurs versions'),
  ('payroll.levies_manage',      'Administrer les prélèvements paramétriques (CNSS, ITS, VPS) — non calculés en E12.1');

-- ---------------------------------------------------------------------------
-- RLS + droits applicatifs.
-- ---------------------------------------------------------------------------
ALTER TABLE payroll.pay_calendars      ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll.pay_periods        ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll.salary_structures  ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll.structure_rubrics  ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll.rubrics            ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll.rubric_versions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll.compensations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll.levies             ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll.levy_versions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll.runs               ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll.results            ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll.result_lines       ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_rows ON payroll.pay_calendars     TO kora_app USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON payroll.pay_periods       TO kora_app USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON payroll.salary_structures TO kora_app USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON payroll.structure_rubrics TO kora_app USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON payroll.rubrics           TO kora_app USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON payroll.rubric_versions   TO kora_app USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON payroll.compensations     TO kora_app USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON payroll.levies            TO kora_app USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON payroll.levy_versions     TO kora_app USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON payroll.runs              TO kora_app USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON payroll.results           TO kora_app USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON payroll.result_lines      TO kora_app USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());

GRANT USAGE ON SCHEMA payroll TO kora_app;
GRANT SELECT, INSERT, UPDATE ON payroll.pay_calendars     TO kora_app;
GRANT SELECT, INSERT, UPDATE ON payroll.pay_periods       TO kora_app;  -- cycle contrôlé (garde)
GRANT SELECT, INSERT, UPDATE ON payroll.salary_structures TO kora_app;
GRANT SELECT, INSERT, DELETE ON payroll.structure_rubrics TO kora_app;  -- composition ajustable
GRANT SELECT, INSERT, UPDATE ON payroll.rubrics           TO kora_app;  -- nature figée dès usage (garde)
GRANT SELECT, INSERT         ON payroll.rubric_versions   TO kora_app;  -- IMMUABLES
GRANT SELECT, INSERT         ON payroll.compensations     TO kora_app;  -- HISTORISÉES
GRANT SELECT, INSERT, UPDATE ON payroll.levies            TO kora_app;
GRANT SELECT, INSERT         ON payroll.levy_versions     TO kora_app;  -- IMMUABLES
GRANT SELECT, INSERT, UPDATE ON payroll.runs              TO kora_app;  -- statut définitif (garde)
GRANT SELECT, INSERT, UPDATE ON payroll.results           TO kora_app;  -- is_current seul (garde)
GRANT SELECT, INSERT         ON payroll.result_lines      TO kora_app;  -- FIGÉES

CREATE TRIGGER trg_payroll_rubrics_guard BEFORE UPDATE ON payroll.rubrics
  FOR EACH ROW EXECUTE FUNCTION payroll.guard_rubric_update();
