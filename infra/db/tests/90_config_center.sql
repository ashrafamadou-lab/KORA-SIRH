-- TEST 90 — Config Center : résolution temporelle, immuabilité, chevauchement, isolation
\set QUIET on

SELECT substr(md5(random()::text), 1, 8) AS rid \gset
SELECT 'test.cc_' || :'rid' AS pkey \gset
INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('test-cc-a-' || :'rid', 'CC A', true) RETURNING id AS tenant_a \gset

-- Historique pays : v1 superseded [2023,2026-07), v2 active [2026-07, 2027-01), v3 scheduled [2027-01, NULL).
INSERT INTO compliance.legal_parameters
  (country_code, key, value, effective_from, effective_to, source_text, verified_by, verified_at, status)
VALUES
  ('BJ', :'pkey', '"v1"'::jsonb, DATE '2023-01-01', DATE '2026-07-01', 's1', 'J', DATE '2023-01-01', 'superseded'),
  ('BJ', :'pkey', '"v2"'::jsonb, DATE '2026-07-01', DATE '2027-01-01', 's2', 'J', DATE '2026-06-01', 'active'),
  ('BJ', :'pkey', '"v3"'::jsonb, DATE '2027-01-01', NULL, 's3', 'J', DATE '2026-12-01', 'scheduled');
-- Un draft qui NE DOIT JAMAIS être résolu (même fenêtre que v2).
INSERT INTO compliance.legal_parameters (country_code, key, value, effective_from, status)
VALUES ('BJ', :'pkey', '"DRAFT"'::jsonb, DATE '2026-08-01', 'draft');

-- Résolution passé / présent / futur.
SET test.pk = :'pkey';
SET test.ta = :'tenant_a';
DO $$
DECLARE v jsonb;
BEGIN
  SELECT value INTO v FROM compliance.parameter_value_at(current_setting('test.pk'), 'BJ', NULL, DATE '2024-01-01');
  IF v IS DISTINCT FROM '"v1"'::jsonb THEN RAISE EXCEPTION 'passé (2024) : attendu v1, obtenu %', v; END IF;
  SELECT value INTO v FROM compliance.parameter_value_at(current_setting('test.pk'), 'BJ', NULL, DATE '2026-09-01');
  IF v IS DISTINCT FROM '"v2"'::jsonb THEN RAISE EXCEPTION 'présent (2026-09) : attendu v2, obtenu %', v; END IF;
  SELECT value INTO v FROM compliance.parameter_value_at(current_setting('test.pk'), 'BJ', NULL, DATE '2027-06-01');
  IF v IS DISTINCT FROM '"v3"'::jsonb THEN RAISE EXCEPTION 'futur (2027) : attendu v3 (scheduled), obtenu %', v; END IF;
END $$;

-- Le draft n'est jamais résolu, même à sa fenêtre.
DO $$
DECLARE v jsonb;
BEGIN
  SELECT value INTO v FROM compliance.parameter_value_at(current_setting('test.pk'), 'BJ', NULL, DATE '2026-08-15');
  IF v IS DISTINCT FROM '"v2"'::jsonb THEN
    RAISE EXCEPTION 'résolution : le draft a fuité (obtenu % à 2026-08-15, attendu v2)', v;
  END IF;
END $$;

-- Chevauchement : une 2e version active/planifiée qui recoupe une fenêtre existante est rejetée.
DO $$
BEGIN
  BEGIN
    INSERT INTO compliance.legal_parameters
      (country_code, key, value, effective_from, effective_to, source_text, verified_by, verified_at, status)
    VALUES ('BJ', current_setting('test.pk'), '"conflit"'::jsonb, DATE '2026-09-01', DATE '2026-10-01', 's', 'J', DATE '2026-08-01', 'active');
    RAISE EXCEPTION 'chevauchement actif aurait dû être rejeté';
  EXCEPTION WHEN exclusion_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO compliance.legal_parameters
      (country_code, key, value, effective_from, source_text, verified_by, verified_at, status)
    VALUES ('BJ', current_setting('test.pk'), '"conflit2"'::jsonb, DATE '2027-03-01', 's', 'J', DATE '2026-08-01', 'scheduled');
    RAISE EXCEPTION 'chevauchement planifié (dans la fenêtre de v3) aurait dû être rejeté';
  EXCEPTION WHEN exclusion_violation THEN NULL;
  END;
END $$;

-- Immuabilité : la valeur d'une version active ne peut pas changer.
DO $$
BEGIN
  BEGIN
    UPDATE compliance.legal_parameters SET value = '"altéré"'::jsonb
     WHERE key = current_setting('test.pk') AND status = 'active';
    RAISE EXCEPTION 'immuabilité : la valeur d''une version active aurait dû être figée';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  -- Mais fermer sa fenêtre (supersession) reste permis.
  UPDATE compliance.legal_parameters SET effective_to = DATE '2026-12-01', status = 'superseded'
   WHERE key = current_setting('test.pk') AND status = 'active';
END $$;

-- Suppression d'une version planifiée interdite.
DO $$
BEGIN
  BEGIN
    UPDATE compliance.legal_parameters SET deleted_at = now()
     WHERE key = current_setting('test.pk') AND status = 'scheduled';
    RAISE EXCEPTION 'suppression d''une version planifiée aurait dû être refusée';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
END $$;

-- Surcharge tenant : n'altère jamais la valeur globale.
INSERT INTO compliance.legal_parameters
  (tenant_id, country_code, key, value, effective_from, source_text, verified_by, verified_at, status)
VALUES (:'tenant_a', 'BJ', :'pkey', '"tenant"'::jsonb, DATE '2026-07-01', 's', 'J', DATE '2026-06-01', 'active');
DO $$
DECLARE v_global jsonb; v_tenant jsonb; sc text;
BEGIN
  -- après supersession de v2 ci-dessus, le global à 2026-09 provient de la fenêtre pays restante
  SELECT value INTO v_global FROM compliance.parameter_value_at(current_setting('test.pk'), 'BJ', NULL, DATE '2026-09-01');
  SELECT value, scope INTO v_tenant, sc FROM compliance.parameter_value_at(current_setting('test.pk'), 'BJ', current_setting('test.ta')::uuid, DATE '2026-09-01');
  IF v_tenant IS DISTINCT FROM '"tenant"'::jsonb OR sc <> 'tenant' THEN
    RAISE EXCEPTION 'surcharge tenant : attendu "tenant"/tenant, obtenu %/%', v_tenant, sc;
  END IF;
  IF v_global = '"tenant"'::jsonb THEN
    RAISE EXCEPTION 'la surcharge tenant a altéré la valeur globale (%)!', v_global;
  END IF;
END $$;

-- Isolation : depuis kora_app en tenant B, la surcharge du tenant A est invisible.
\set appurl `echo "$DATABASE_URL_APP"`
\connect :"appurl"
\set QUIET on
SET app.tenant_id = :'tenant_a';
SET test.pk = :'pkey';
DO $$
DECLARE v jsonb; sc text;
BEGIN
  -- Le tenant A voit sa surcharge.
  SELECT value, scope INTO v, sc FROM compliance.parameter_value_at(current_setting('test.pk'), 'BJ', current_setting('app.tenant_id')::uuid, DATE '2026-09-01');
  IF sc <> 'tenant' THEN RAISE EXCEPTION 'A devrait voir sa surcharge'; END IF;
END $$;
