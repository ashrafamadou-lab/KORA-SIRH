-- TEST 40 — Parameter Engine : résolution « à la date de l'événement » (US-E4-01/02)
-- Versions datées, statuts, priorité surcharge tenant > profil pays, recalcul du passé
-- stable, contreseing structurel (pas d'« active » sans source + vérificateur).
\set QUIET on
\set appurl `echo "$DATABASE_URL_APP"`

-- ---------- Fixtures (migrator : gère les paramètres de profil pays) ----------
SELECT substr(md5(random()::text), 1, 8) AS rid \gset
SELECT 'test.param_' || :'rid' AS pkey \gset
INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('test-par-a-' || :'rid', 'Test PAR A', true) RETURNING id AS tenant_a \gset
INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('test-par-b-' || :'rid', 'Test PAR B', true) RETURNING id AS tenant_b \gset

-- v1 pays, active du 01/01/2023 au 30/06/2026 inclus (borne [) au 01/07/2026)
INSERT INTO compliance.legal_parameters
  (country_code, key, value, effective_from, effective_to, source_text, verified_by, verified_at, confidence, status)
VALUES ('BJ', :'pkey', '2',   DATE '2023-01-01', DATE '2026-07-01',
        'Texte test v1', 'Juriste Test', DATE '2026-07-15', 'verified', 'active');
-- v2 pays, active à partir du 01/07/2026 (le « changement de barème daté »)
INSERT INTO compliance.legal_parameters
  (country_code, key, value, effective_from, source_text, verified_by, verified_at, confidence, status)
VALUES ('BJ', :'pkey', '2.5', DATE '2026-07-01',
        'Texte test v2', 'Juriste Test', DATE '2026-07-15', 'verified', 'active');
-- v3 en DRAFT : ne doit JAMAIS être résolue.
INSERT INTO compliance.legal_parameters (country_code, key, value, effective_from, status)
VALUES ('BJ', :'pkey', '9', DATE '2026-07-01', 'draft');
-- Surcharge du tenant A (plus favorable), active dès le 01/01/2026.
INSERT INTO compliance.legal_parameters
  (tenant_id, country_code, key, value, effective_from, source_text, verified_by, verified_at, confidence, status)
VALUES (:'tenant_a', 'BJ', :'pkey', '3', DATE '2026-01-01',
        'Accord d''entreprise test', 'Juriste Test', DATE '2026-07-15', 'verified', 'active');

-- Un « active » sans source ni vérificateur est structurellement impossible (règle D8).
DO $$
BEGIN
  BEGIN
    INSERT INTO compliance.legal_parameters (country_code, key, value, effective_from, status)
    VALUES ('BJ', 'test.sans_source', '1', DATE '2026-01-01', 'active');
    RAISE EXCEPTION 'active_requires_source : un actif sans source aurait dû être rejeté';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- Deux versions actives qui se chevauchent sur la même portée : rejet.
SET test.pkey = :'pkey';
DO $$
BEGIN
  BEGIN
    INSERT INTO compliance.legal_parameters
      (country_code, key, value, effective_from, source_text, verified_by, verified_at, status)
    VALUES ('BJ', current_setting('test.pkey'), '4', DATE '2026-03-01',
            'Chevauchement', 'Juriste Test', DATE '2026-07-15', 'active');
    RAISE EXCEPTION 'parameter_no_overlap : le chevauchement de versions actives aurait dû être rejeté';
  EXCEPTION WHEN exclusion_violation THEN NULL;
  END;
END $$;

-- ---------- Résolution côté application (kora_app) ----------
\connect :"appurl"
\set QUIET on
SET app.tenant_id = :'tenant_b';
SET test.pkey = :'pkey';
SET test.tenant_b = :'tenant_b';

-- Tenant B (sans surcharge) : le 15/05/2026 → v1 (2) ; le 01/08/2026 → v2 (2.5).
-- Le draft (9) n'apparaît jamais. C'est le recalcul du passé stable : changer le
-- paramètre en juillet ne réécrit pas mai.
DO $$
DECLARE v jsonb; s text;
BEGIN
  SELECT value, scope INTO v, s FROM compliance.parameter_value_at(
    current_setting('test.pkey'), 'BJ', current_setting('test.tenant_b')::uuid, DATE '2026-05-15');
  IF v IS DISTINCT FROM '2'::jsonb OR s <> 'country' THEN
    RAISE EXCEPTION 'résolution passée : attendu 2/country au 15/05/2026, obtenu %/%', v, s;
  END IF;
  SELECT value INTO v FROM compliance.parameter_value_at(
    current_setting('test.pkey'), 'BJ', current_setting('test.tenant_b')::uuid, DATE '2026-08-01');
  IF v IS DISTINCT FROM '2.5'::jsonb THEN
    RAISE EXCEPTION 'résolution courante : attendu 2.5 au 01/08/2026, obtenu %', v;
  END IF;
END $$;

-- Tenant A : sa surcharge (3) prime sur le profil pays à toute date couverte.
\connect :"appurl"
\set QUIET on
SET app.tenant_id = :'tenant_a';
SET test.pkey = :'pkey';
SET test.tenant_a = :'tenant_a';
DO $$
DECLARE v jsonb; s text;
BEGIN
  SELECT value, scope INTO v, s FROM compliance.parameter_value_at(
    current_setting('test.pkey'), 'BJ', current_setting('test.tenant_a')::uuid, DATE '2026-08-01');
  IF v IS DISTINCT FROM '3'::jsonb OR s <> 'tenant' THEN
    RAISE EXCEPTION 'priorité tenant : attendu 3/tenant, obtenu %/%', v, s;
  END IF;
END $$;

-- Défense RLS dans la fonction : demander la résolution « pour » un autre tenant ne
-- donne que le profil pays — les surcharges d'autrui restent invisibles.
DO $$
DECLARE v jsonb;
BEGIN
  SELECT value INTO v FROM compliance.parameter_value_at(
    current_setting('test.pkey'), 'BJ', gen_random_uuid(), DATE '2026-08-01');
  IF v IS DISTINCT FROM '2.5'::jsonb THEN
    RAISE EXCEPTION 'défense RLS : attendu la valeur pays (2.5), obtenu %', v;
  END IF;
END $$;

-- Le rapport « attention » signale bien les drafts en attente de contreseing.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM compliance.parameters_requiring_attention
   WHERE key = current_setting('test.pkey') AND attention_reason = 'draft_awaiting_countersign';
  IF n < 1 THEN RAISE EXCEPTION 'parameters_requiring_attention : le draft aurait dû être signalé'; END IF;
END $$;
