-- TEST 20 — Contraintes en base : anti-chevauchement salarial, unicités par tenant,
-- intégrité référentielle inter-tenant (Blueprint §12.1/§12.3, PRD US-E9-05).
\set QUIET on
\set appurl `echo "$DATABASE_URL_APP"`

-- ---------- Fixtures (migrator) ----------
SELECT substr(md5(random()::text), 1, 8) AS rid \gset
INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('test-cst-a-' || :'rid', 'Test CST A', true) RETURNING id AS tenant_a \gset
INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('test-cst-b-' || :'rid', 'Test CST B', true) RETURNING id AS tenant_b \gset
INSERT INTO core.employees (tenant_id, matricule, first_name, last_name, cnss_number)
VALUES (:'tenant_a', 'M-0001', 'Afi', 'Houngbo', 'CNSS-TEST-1') RETURNING id AS emp_a \gset
INSERT INTO core.employees (tenant_id, matricule, first_name, last_name)
VALUES (:'tenant_b', 'M-0001', 'Sena', 'Agbodjan');   -- même matricule, autre tenant : DOIT passer

-- Intégrité inter-tenant : un salaire du tenant B ne peut référencer un salarié de A
-- (FK composite (tenant_id, employee_id) — exécuté côté migrator, donc hors RLS :
-- c'est bien la contrainte qui refuse, pas la politique).
SET test.emp_a = :'emp_a';
SET test.tenant_b = :'tenant_b';
DO $$
BEGIN
  BEGIN
    INSERT INTO core.salary_history (tenant_id, employee_id, amount, effective_from)
    VALUES (current_setting('test.tenant_b')::uuid, current_setting('test.emp_a')::uuid, 100000, DATE '2026-01-01');
    RAISE EXCEPTION 'FK composite : le mélange tenant B / salarié A aurait dû être rejeté';
  EXCEPTION WHEN foreign_key_violation THEN NULL; -- attendu
  END;
END $$;

-- ---------- Assertions applicatives (kora_app, tenant A) ----------
\connect :"appurl"
\set QUIET on
SET app.tenant_id = :'tenant_a';
SET test.emp_a = :'emp_a';
SET test.tenant_a = :'tenant_a';

-- Salaire initial ouvert (courant).
INSERT INTO core.salary_history (tenant_id, employee_id, amount, effective_from)
VALUES (:'tenant_a', :'emp_a', 250000, DATE '2026-01-01');

-- Chevauchement interdit : une 2e ligne ouverte sur la même période doit être rejetée.
DO $$
BEGIN
  BEGIN
    INSERT INTO core.salary_history (tenant_id, employee_id, amount, effective_from)
    VALUES (current_setting('test.tenant_a')::uuid, current_setting('test.emp_a')::uuid, 300000, DATE '2026-06-01');
    RAISE EXCEPTION 'salary_no_overlap : le chevauchement aurait dû être rejeté';
  EXCEPTION WHEN exclusion_violation THEN NULL; -- attendu (23P01)
  END;
END $$;

-- Bon geste métier : clore la période courante, puis ouvrir la suivante — accepté,
-- et l'historique de janvier reste intact (recalcul du passé stable, §12.3).
UPDATE core.salary_history SET effective_to = DATE '2026-06-01'
 WHERE employee_id = :'emp_a' AND effective_to IS NULL;
INSERT INTO core.salary_history (tenant_id, employee_id, amount, effective_from, reason)
VALUES (:'tenant_a', :'emp_a', 300000, DATE '2026-06-01', 'increment');

DO $$
DECLARE n int; old_amount numeric;
BEGIN
  SELECT count(*) INTO n FROM core.salary_history WHERE employee_id = current_setting('test.emp_a')::uuid;
  IF n <> 2 THEN RAISE EXCEPTION 'historique : attendu 2 périodes, obtenu %', n; END IF;
  -- La valeur en vigueur au 15/03/2026 reste 250 000 : l'augmentation de juin ne réécrit pas mars.
  SELECT amount INTO old_amount FROM core.salary_history
   WHERE employee_id = current_setting('test.emp_a')::uuid
     AND daterange(effective_from, effective_to, '[)') @> DATE '2026-03-15';
  IF old_amount <> 250000 THEN RAISE EXCEPTION 'historisation : salaire au 15/03 = %, attendu 250000', old_amount; END IF;
END $$;

-- Unicité du matricule par tenant.
DO $$
BEGIN
  BEGIN
    INSERT INTO core.employees (tenant_id, matricule, first_name, last_name)
    VALUES (current_setting('test.tenant_a')::uuid, 'M-0001', 'Doublon', 'Doublon');
    RAISE EXCEPTION 'unicité matricule : le doublon intra-tenant aurait dû être rejeté';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;

-- Unicité du numéro CNSS par tenant (index partiel).
DO $$
BEGIN
  BEGIN
    INSERT INTO core.employees (tenant_id, matricule, first_name, last_name, cnss_number)
    VALUES (current_setting('test.tenant_a')::uuid, 'M-0002', 'Doublon', 'CNSS', 'CNSS-TEST-1');
    RAISE EXCEPTION 'unicité CNSS : le doublon intra-tenant aurait dû être rejeté';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;
