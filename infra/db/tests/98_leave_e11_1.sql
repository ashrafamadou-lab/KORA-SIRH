-- TEST 98 — Congés E11.1 : catalogue des permissions, types à sémantique FIGÉE dès
-- le premier usage, politiques versionnées immuables avec UNE politique active par
-- population et par type (index partiel), LEDGER append-only absolu (ni UPDATE ni
-- DELETE), clé d'idempotence UNIQUE (anti double acquisition PAR LA BASE), mouvement
-- de reversement référencé, acquisition/report/expiration adossées à une politique,
-- vue des soldes = somme exacte des mouvements, exécutions actives sans chevauchement,
-- FK inter-tenant rejetées par PostgreSQL, RLS étanche, aucun DELETE pour le rôle app.
\set QUIET on
\set appurl `echo "$DATABASE_URL_APP"`

DO $$
BEGIN
  IF (SELECT count(*) FROM admin.permissions WHERE key IN
      ('leave.balance_view_own','leave.balance_view_team','leave.balance_view',
       'leave.ledger_view','leave.types_admin','leave.policies_admin',
       'leave.accrual_run','leave.balance_adjust','leave.openings_import',
       'leave.sensitive_view')) <> 10 THEN
    RAISE EXCEPTION 'permissions E11.1 incomplètes au catalogue';
  END IF;
END $$;

-- ---------- Fixtures (migrator) ----------
SELECT substr(md5(random()::text), 1, 8) AS rid \gset
INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('test-lv-a-' || :'rid', 'LV A', true) RETURNING id AS tenant_a \gset
INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('test-lv-b-' || :'rid', 'LV B', true) RETURNING id AS tenant_b \gset
INSERT INTO core.employees (tenant_id, matricule, first_name, last_name, status, hire_date)
VALUES (:'tenant_a', 'LV-0001', 'Awa', 'Sossou', 'active', '2025-01-01') RETURNING id AS emp_a \gset
INSERT INTO core.employees (tenant_id, matricule, first_name, last_name, status, hire_date)
VALUES (:'tenant_b', 'LV-B001', 'Bio', 'Kassim', 'active', '2025-01-01') RETURNING id AS emp_b \gset
INSERT INTO admin.users (tenant_id, email, password_hash)
VALUES (:'tenant_a', 'lv-' || :'rid' || '@t.bj', 'x') RETURNING id AS user_a \gset

INSERT INTO leave.absence_types (tenant_id, code, label_fr, label_en, category, paid, unit, created_by, status)
VALUES (:'tenant_a', 'CAP', 'Congé annuel payé', 'Paid annual leave', 'legal', true, 'open_days', :'user_a', 'active')
RETURNING id AS type_cap \gset
INSERT INTO leave.absence_types (tenant_id, code, label_fr, label_en, category, paid, unit, confidential, created_by, status)
VALUES (:'tenant_a', 'MAL', 'Maladie', 'Sickness', 'legal', true, 'calendar_days', true, :'user_a', 'active')
RETURNING id AS type_mal \gset
INSERT INTO leave.absence_types (tenant_id, code, label_fr, label_en, category, paid, unit, created_by, status)
VALUES (:'tenant_b', 'CAP', 'Congé annuel payé', 'Paid annual leave', 'legal', true, 'open_days', :'user_a', 'active')
RETURNING id AS type_b \gset

INSERT INTO leave.policies (tenant_id, absence_type_id, code, label_fr, label_en, country_code, created_by, status)
VALUES (:'tenant_a', :'type_cap', 'POL-CAP', 'Politique CAP', 'CAP policy', 'BJ', :'user_a', 'active')
RETURNING id AS pol_a \gset
INSERT INTO leave.policy_versions (tenant_id, policy_id, version, effective_from, accrual_mode,
                                   accrual_rate_param, reference_period, created_by)
VALUES (:'tenant_a', :'pol_a', 1, '2025-01-01', 'monthly', 'conges.acquisition.taux_mensuel', 'calendar_year', :'user_a')
RETURNING id AS polv_a \gset

SET test.tenant_a = :'tenant_a';
SET test.tenant_b = :'tenant_b';
SET test.emp_a = :'emp_a';
SET test.emp_b = :'emp_b';
SET test.user_a = :'user_a';
SET test.type_cap = :'type_cap';
SET test.type_mal = :'type_mal';
SET test.type_b = :'type_b';
SET test.pol_a = :'pol_a';

-- ---------- Types : sémantique figée dès le premier usage ----------
DO $$
DECLARE t uuid := current_setting('test.tenant_a')::uuid;
        ty uuid := current_setting('test.type_cap')::uuid;
BEGIN
  -- Libellé modifiable même après usage (le type est référencé par la politique).
  UPDATE leave.absence_types SET label_fr = 'Congé annuel payé (Bénin)' WHERE id = ty;
  -- Unité : FIGÉE (une politique référence déjà ce type).
  BEGIN
    UPDATE leave.absence_types SET unit = 'hours' WHERE id = ty;
    RAISE EXCEPTION 'unité modifiée sur un type utilisé';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%unité modifiée%' THEN RAISE; END IF;
  END;
  -- Code : immuable TOUJOURS.
  BEGIN
    UPDATE leave.absence_types SET code = 'CAP2' WHERE id = ty;
    RAISE EXCEPTION 'code modifié';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%code modifié%' THEN RAISE; END IF;
  END;
  -- Suppression : jamais.
  BEGIN
    DELETE FROM leave.absence_types WHERE id = ty;
    RAISE EXCEPTION 'type supprimé';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%type supprimé%' THEN RAISE; END IF;
  END;
END $$;

-- ---------- Politiques : une seule active par population et par type ----------
DO $$
DECLARE t uuid := current_setting('test.tenant_a')::uuid;
        ty uuid := current_setting('test.type_cap')::uuid;
        u uuid := current_setting('test.user_a')::uuid;
BEGIN
  -- Même type + mêmes sélecteurs (BJ, tous) + active ⇒ REFUSÉE par l'index partiel.
  BEGIN
    INSERT INTO leave.policies (tenant_id, absence_type_id, code, label_fr, label_en, country_code, created_by, status)
    VALUES (t, ty, 'POL-CAP-DUP', 'Doublon', 'Duplicate', 'BJ', u, 'active');
    RAISE EXCEPTION 'deux politiques actives sur la même population';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  -- Population DIFFÉRENTE (clé de population) : acceptée — la résolution départage.
  INSERT INTO leave.policies (tenant_id, absence_type_id, code, label_fr, label_en, country_code, population_key, created_by, status)
  VALUES (t, ty, 'POL-CAP-CADRES', 'CAP cadres', 'CAP managers', 'BJ', 'cadres', u, 'active');
END $$;

-- Versions de politique : IMMUABLES (ni UPDATE ni DELETE).
DO $$
DECLARE pv uuid;
BEGIN
  SELECT id INTO pv FROM leave.policy_versions LIMIT 1;
  BEGIN
    UPDATE leave.policy_versions SET notes = 'retouche interdite' WHERE id = pv;
    RAISE EXCEPTION 'version de politique modifiée';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%version de politique modifiée%' THEN RAISE; END IF;
  END;
  BEGIN
    DELETE FROM leave.policy_versions WHERE id = pv;
    RAISE EXCEPTION 'version de politique supprimée';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%version de politique supprimée%' THEN RAISE; END IF;
  END;
END $$;

-- ---------- Ledger : append-only absolu + idempotence PAR LA BASE ----------
INSERT INTO leave.entitlement_ledger (tenant_id, employee_id, absence_type_id, policy_id, policy_version,
  reference_period_start, reference_period_end, entry_kind, quantity, unit, effective_on, origin, idempotency_key)
VALUES (:'tenant_a', :'emp_a', :'type_cap', :'pol_a', 1,
  '2026-01-01', '2026-12-31', 'accrual', 2.0, 'open_days', '2026-01-31', 'system_accrual',
  'accrual:' || :'rid' || ':2026-01')
RETURNING id AS led_1 \gset
SET test.led_1 = :'led_1';

DO $$
DECLARE t uuid := current_setting('test.tenant_a')::uuid;
        e uuid := current_setting('test.emp_a')::uuid;
        ty uuid := current_setting('test.type_cap')::uuid;
        po uuid := current_setting('test.pol_a')::uuid;
        l1 uuid := current_setting('test.led_1')::uuid;
        rid text := substr(md5(random()::text), 1, 8);
BEGIN
  -- Rejeu de la MÊME clé d'idempotence ⇒ unique_violation : jamais deux acquisitions.
  BEGIN
    INSERT INTO leave.entitlement_ledger (tenant_id, employee_id, absence_type_id, policy_id, policy_version,
      reference_period_start, reference_period_end, entry_kind, quantity, unit, effective_on, origin, idempotency_key)
    SELECT tenant_id, employee_id, absence_type_id, policy_id, policy_version,
      reference_period_start, reference_period_end, entry_kind, quantity, unit, effective_on, origin, idempotency_key
      FROM leave.entitlement_ledger WHERE id = l1;
    RAISE EXCEPTION 'double acquisition acceptée';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  -- Mouvement : ni UPDATE ni DELETE, JAMAIS.
  BEGIN
    UPDATE leave.entitlement_ledger SET quantity = 99 WHERE id = l1;
    RAISE EXCEPTION 'mouvement modifié';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%mouvement modifié%' THEN RAISE; END IF;
  END;
  BEGIN
    DELETE FROM leave.entitlement_ledger WHERE id = l1;
    RAISE EXCEPTION 'mouvement supprimé';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%mouvement supprimé%' THEN RAISE; END IF;
  END;
  -- Reversement SANS référence ⇒ refusé par contrainte.
  BEGIN
    INSERT INTO leave.entitlement_ledger (tenant_id, employee_id, absence_type_id,
      reference_period_start, reference_period_end, entry_kind, quantity, unit, effective_on, origin, idempotency_key)
    VALUES (t, e, ty, '2026-01-01', '2026-12-31', 'reversal', 1, 'open_days', '2026-02-01', 'reversal', 'rev:' || rid);
    RAISE EXCEPTION 'reversal sans référence accepté';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- Acquisition SANS politique ⇒ refusée (accrual/carry_over/expiry sont adossées).
  BEGIN
    INSERT INTO leave.entitlement_ledger (tenant_id, employee_id, absence_type_id,
      reference_period_start, reference_period_end, entry_kind, quantity, unit, effective_on, origin, idempotency_key)
    VALUES (t, e, ty, '2026-01-01', '2026-12-31', 'accrual', 1, 'open_days', '2026-02-28', 'system_accrual', 'acc-nopol:' || rid);
    RAISE EXCEPTION 'acquisition sans politique acceptée';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- Quantité nulle ou négative ⇒ refusée (les sens sont portés par le TYPE de mouvement).
  BEGIN
    INSERT INTO leave.entitlement_ledger (tenant_id, employee_id, absence_type_id,
      reference_period_start, reference_period_end, entry_kind, quantity, unit, effective_on, origin, idempotency_key)
    VALUES (t, e, ty, '2026-01-01', '2026-12-31', 'grant', -1, 'open_days', '2026-02-01', 'admin', 'neg:' || rid);
    RAISE EXCEPTION 'quantité négative acceptée';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- ---------- Soldes : la vue = somme EXACTE des mouvements ----------
INSERT INTO leave.entitlement_ledger (tenant_id, employee_id, absence_type_id, policy_id, policy_version,
  reference_period_start, reference_period_end, entry_kind, quantity, unit, effective_on, origin, idempotency_key)
VALUES
  (:'tenant_a', :'emp_a', :'type_cap', :'pol_a', 1, '2026-01-01', '2026-12-31', 'accrual',           2.0, 'open_days', '2026-02-28', 'system_accrual', 'acc2:' || :'rid'),
  (:'tenant_a', :'emp_a', :'type_cap', NULL, NULL, '2026-01-01', '2026-12-31', 'opening_balance',    5.5, 'open_days', '2026-01-01', 'import',         'open:' || :'rid'),
  (:'tenant_a', :'emp_a', :'type_cap', NULL, NULL, '2026-01-01', '2026-12-31', 'adjustment_credit',  1.0, 'open_days', '2026-03-01', 'admin',          'adjc:' || :'rid'),
  (:'tenant_a', :'emp_a', :'type_cap', NULL, NULL, '2026-01-01', '2026-12-31', 'adjustment_debit',   0.5, 'open_days', '2026-03-02', 'admin',          'adjd:' || :'rid'),
  (:'tenant_a', :'emp_a', :'type_cap', NULL, NULL, '2026-01-01', '2026-12-31', 'reservation',        3.0, 'open_days', '2026-03-10', 'workflow',       'resv:' || :'rid'),
  (:'tenant_a', :'emp_a', :'type_cap', NULL, NULL, '2026-01-01', '2026-12-31', 'release',            1.0, 'open_days', '2026-03-12', 'workflow',       'rels:' || :'rid'),
  (:'tenant_a', :'emp_a', :'type_cap', NULL, NULL, '2026-01-01', '2026-12-31', 'consumption',        2.0, 'open_days', '2026-03-15', 'workflow',       'cons:' || :'rid');

DO $$
DECLARE t uuid := current_setting('test.tenant_a')::uuid;
        e uuid := current_setting('test.emp_a')::uuid;
        b record;
BEGIN
  SELECT * INTO b FROM leave.balances_v
   WHERE tenant_id = t AND employee_id = e AND reference_period_start = '2026-01-01'
     AND unit = 'open_days';
  -- acquis = 2 + 2 + 5.5 + 1 = 10.5 ; débit 0.5 ; réservé = 3 − 1 = 2 ; consommé 2
  -- disponible = 10.5 − 0.5 − 0 − 2 − 2 = 6.0
  IF b.accrued <> 10.5 THEN RAISE EXCEPTION 'acquis attendu 10.5, obtenu %', b.accrued; END IF;
  IF b.adjusted_out <> 0.5 THEN RAISE EXCEPTION 'débit attendu 0.5, obtenu %', b.adjusted_out; END IF;
  IF b.reserved <> 2.0 THEN RAISE EXCEPTION 'réservé attendu 2.0, obtenu %', b.reserved; END IF;
  IF b.consumed <> 2.0 THEN RAISE EXCEPTION 'consommé attendu 2.0, obtenu %', b.consumed; END IF;
  IF b.available <> 6.0 THEN RAISE EXCEPTION 'disponible attendu 6.0, obtenu %', b.available; END IF;
END $$;

-- Report/expiration : mouvements DISTINCTS, l'ancienne période garde son histoire.
INSERT INTO leave.entitlement_ledger (tenant_id, employee_id, absence_type_id, policy_id, policy_version,
  reference_period_start, reference_period_end, entry_kind, quantity, unit, effective_on, origin, idempotency_key)
VALUES
  (:'tenant_a', :'emp_a', :'type_cap', :'pol_a', 1, '2026-01-01', '2026-12-31', 'expiry',     6.0, 'open_days', '2026-12-31', 'carry_over_job', 'exp26:' || :'rid'),
  (:'tenant_a', :'emp_a', :'type_cap', :'pol_a', 1, '2027-01-01', '2027-12-31', 'carry_over', 6.0, 'open_days', '2027-01-01', 'carry_over_job', 'co27:' || :'rid');

DO $$
DECLARE t uuid := current_setting('test.tenant_a')::uuid;
        e uuid := current_setting('test.emp_a')::uuid;
        avail26 numeric; avail27 numeric; carried27 numeric;
BEGIN
  SELECT available INTO avail26 FROM leave.balances_v
   WHERE tenant_id = t AND employee_id = e AND reference_period_start = '2026-01-01' AND unit = 'open_days';
  SELECT available, carried_in INTO avail27, carried27 FROM leave.balances_v
   WHERE tenant_id = t AND employee_id = e AND reference_period_start = '2027-01-01' AND unit = 'open_days';
  IF avail26 <> 0 THEN RAISE EXCEPTION '2026 après expiration : disponible attendu 0, obtenu %', avail26; END IF;
  IF avail27 <> 6.0 OR carried27 <> 6.0 THEN RAISE EXCEPTION '2027 : report attendu 6.0 (obtenu % / %)', avail27, carried27; END IF;
END $$;

-- ---------- FK inter-tenant : rejetées PAR POSTGRESQL ----------
DO $$
DECLARE ta uuid := current_setting('test.tenant_a')::uuid;
        eb uuid := current_setting('test.emp_b')::uuid;
        tyb uuid := current_setting('test.type_b')::uuid;
        tya uuid := current_setting('test.type_cap')::uuid;
        ea uuid := current_setting('test.emp_a')::uuid;
        rid text := substr(md5(random()::text), 1, 8);
BEGIN
  -- Salarié d'un AUTRE tenant.
  BEGIN
    INSERT INTO leave.entitlement_ledger (tenant_id, employee_id, absence_type_id,
      reference_period_start, reference_period_end, entry_kind, quantity, unit, effective_on, origin, idempotency_key)
    VALUES (ta, eb, tya, '2026-01-01', '2026-12-31', 'grant', 1, 'open_days', '2026-01-01', 'admin', 'xt1:' || rid);
    RAISE EXCEPTION 'salarié inter-tenant accepté';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  -- Type d'absence d'un AUTRE tenant.
  BEGIN
    INSERT INTO leave.entitlement_ledger (tenant_id, employee_id, absence_type_id,
      reference_period_start, reference_period_end, entry_kind, quantity, unit, effective_on, origin, idempotency_key)
    VALUES (ta, ea, tyb, '2026-01-01', '2026-12-31', 'grant', 1, 'open_days', '2026-01-01', 'admin', 'xt2:' || rid);
    RAISE EXCEPTION 'type inter-tenant accepté';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;

-- ---------- Exécutions : deux actives ne se chevauchent pas ----------
INSERT INTO leave.accrual_runs (tenant_id, period_start, period_end, scope_kind, reason, engine_version, started_by)
VALUES (:'tenant_a', '2026-01-01', '2026-01-31', 'tenant', 'acquisition janvier', 'kora-leave-test', :'user_a')
RETURNING id AS runlv \gset
SET test.runlv = :'runlv';

DO $$
DECLARE t uuid := current_setting('test.tenant_a')::uuid;
        u uuid := current_setting('test.user_a')::uuid;
        r uuid := current_setting('test.runlv')::uuid;
BEGIN
  BEGIN
    INSERT INTO leave.accrual_runs (tenant_id, period_start, period_end, scope_kind, reason, engine_version, started_by)
    VALUES (t, '2026-01-15', '2026-02-15', 'tenant', 'chevauchement', 'kora-leave-test', u);
    RAISE EXCEPTION 'exécutions actives chevauchantes acceptées';
  EXCEPTION WHEN exclusion_violation THEN NULL;
  END;
  -- Terminée, une nouvelle exécution passe.
  UPDATE leave.accrual_runs SET status = 'completed', finished_at = now() WHERE id = r;
  INSERT INTO leave.accrual_runs (tenant_id, period_start, period_end, scope_kind, reason, engine_version, started_by, status, finished_at)
  VALUES (t, '2026-01-15', '2026-02-15', 'tenant', 'après clôture de la première', 'kora-leave-test', u, 'completed', now());
END $$;

-- ---------- RLS + interdiction de DELETE pour le rôle applicatif ----------
\connect :appurl
SET app.tenant_id = '';
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM leave.entitlement_ledger;
  IF n <> 0 THEN RAISE EXCEPTION 'RLS : ledger lisible sans contexte tenant (%)', n; END IF;
  SELECT count(*) INTO n FROM leave.absence_types;
  IF n <> 0 THEN RAISE EXCEPTION 'RLS : types lisibles sans contexte tenant (%)', n; END IF;
  SELECT count(*) INTO n FROM leave.balances_v;
  IF n <> 0 THEN RAISE EXCEPTION 'RLS : vue des soldes lisible sans contexte tenant (%)', n; END IF;
END $$;

DO $$
BEGIN
  BEGIN
    DELETE FROM leave.entitlement_ledger WHERE true;
    RAISE EXCEPTION 'DELETE ledger autorisé au rôle applicatif';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM leave.policy_versions WHERE true;
    RAISE EXCEPTION 'DELETE versions autorisé au rôle applicatif';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE leave.entitlement_ledger SET reason = 'x' WHERE true;
    RAISE EXCEPTION 'UPDATE ledger autorisé au rôle applicatif';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

SELECT 'TEST 98 OK — référentiel figé, politiques uniques par population, ledger append-only idempotent, soldes exacts, report/expiration distincts, FK inter-tenant rejetées, RLS étanche' AS resultat;
