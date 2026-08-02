-- TEST 96 — Moteur de présence E10.2 : UNE seule version COURANTE par (salarié,
-- date) garantie par la base, contenu des résultats FIGÉ (seule la bascule de
-- version est permise), anomalies au cycle de vie contrôlé (resolved réservé au
-- circuit E10.3), exécutions actives sans chevauchement de période, FK inter-tenant
-- rejetées, RLS étanche, privilèges minimaux, catalogue des permissions.
\set QUIET on
\set appurl `echo "$DATABASE_URL_APP"`

DO $$
BEGIN
  IF (SELECT count(*) FROM admin.permissions WHERE key IN
      ('time.results_view_own','time.results_view','time.anomalies_view','time.anomalies_manage',
       'time.calc_run','time.calc_recalc','time.calc_view')) <> 7 THEN
    RAISE EXCEPTION 'permissions E10.2 incomplètes au catalogue';
  END IF;
END $$;

-- ---------- Fixtures (migrator) ----------
SELECT substr(md5(random()::text), 1, 8) AS rid \gset
INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('test-tc-a-' || :'rid', 'TC A', true) RETURNING id AS tenant_a \gset
INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('test-tc-b-' || :'rid', 'TC B', true) RETURNING id AS tenant_b \gset
INSERT INTO core.employees (tenant_id, matricule, first_name, last_name, status, hire_date)
VALUES (:'tenant_a', 'TC-0001', 'Awa', 'Sossou', 'active', '2025-01-01') RETURNING id AS emp_a \gset
INSERT INTO core.employees (tenant_id, matricule, first_name, last_name, status, hire_date)
VALUES (:'tenant_b', 'TC-B001', 'Bio', 'Kassim', 'active', '2025-01-01') RETURNING id AS emp_b \gset

INSERT INTO time.calc_runs (tenant_id, period_start, period_end, scope_kind, reason, engine_version, status)
VALUES (:'tenant_a', '2026-07-01', '2026-07-31', 'tenant', 'calcul initial', 'e10.2-test', 'completed') RETURNING id AS run_a \gset

SET test.tenant_a = :'tenant_a';
SET test.tenant_b = :'tenant_b';
SET test.emp_a = :'emp_a';
SET test.emp_b = :'emp_b';
SET test.run_a = :'run_a';

-- ---------- Résultats : version courante UNIQUE, contenu figé ----------
INSERT INTO time.day_results (tenant_id, employee_id, work_date, version, is_current, calc_run_id,
                              engine_version, tz, worked_minutes, day_status)
VALUES (:'tenant_a', :'emp_a', '2026-07-01', 1, true, :'run_a', 'e10.2-test', 'Africa/Porto-Novo', 480, 'present')
RETURNING id AS res_v1 \gset
SET test.res_v1 = :'res_v1';

DO $$
DECLARE t uuid := current_setting('test.tenant_a')::uuid;
        e uuid := current_setting('test.emp_a')::uuid;
        r uuid := current_setting('test.run_a')::uuid;
        v1 uuid := current_setting('test.res_v1')::uuid;
BEGIN
  -- Une SECONDE version courante pour la même journée : REFUSÉE par la base.
  BEGIN
    INSERT INTO time.day_results (tenant_id, employee_id, work_date, version, is_current, calc_run_id,
                                  engine_version, tz, worked_minutes, day_status)
    VALUES (t, e, '2026-07-01', 2, true, r, 'e10.2-test', 'Africa/Porto-Novo', 470, 'late');
    RAISE EXCEPTION 'deux versions COURANTES pour la même journée auraient dû être refusées';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  -- Le CONTENU d'un résultat est figé : modifier une durée est refusé.
  BEGIN
    UPDATE time.day_results SET worked_minutes = 999 WHERE id = v1;
    RAISE EXCEPTION 'résultat : la réécriture du contenu aurait dû être refusée';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  -- Rebasculer une version vers « courante » : refusé (seul true→false est permis).
  BEGIN
    UPDATE time.day_results SET is_current = true WHERE id = v1;  -- true -> true : contenu identique
    RAISE EXCEPTION 'résultat : l''UPDATE sans bascule aurait dû être refusé';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  -- SUPERSESSION propre : v1 quitte « courante », v2 arrive — l'histoire est conservée.
  UPDATE time.day_results SET is_current = false WHERE id = v1;
  INSERT INTO time.day_results (tenant_id, employee_id, work_date, version, is_current, calc_run_id,
                                engine_version, tz, worked_minutes, late_minutes, day_status)
  VALUES (t, e, '2026-07-01', 2, true, r, 'e10.2-test', 'Africa/Porto-Novo', 470, 10, 'late');
  IF (SELECT count(*) FROM time.day_results WHERE employee_id = e AND work_date = '2026-07-01') <> 2 THEN
    RAISE EXCEPTION 'les DEUX versions doivent coexister (historique)';
  END IF;
  -- La suppression d'un résultat est interdite.
  BEGIN
    DELETE FROM time.day_results WHERE id = v1;
    RAISE EXCEPTION 'résultat : la suppression aurait dû être refusée';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  -- FK inter-tenant : un résultat du tenant A ne peut pas viser le salarié de B.
  BEGIN
    INSERT INTO time.day_results (tenant_id, employee_id, work_date, version, is_current, calc_run_id,
                                  engine_version, tz, day_status)
    VALUES (t, current_setting('test.emp_b')::uuid, '2026-07-02', 1, true, r, 'e10.2-test', 'UTC', 'absent');
    RAISE EXCEPTION 'FK inter-tenant : le salarié de B aurait dû être rejeté';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;

-- ---------- Anomalies : cycle de vie contrôlé, resolved réservé ----------
INSERT INTO time.day_results (tenant_id, employee_id, work_date, version, is_current, calc_run_id,
                              engine_version, tz, day_status, calc_state)
VALUES (:'tenant_a', :'emp_a', '2026-07-03', 1, true, :'run_a', 'e10.2-test', 'Africa/Porto-Novo', 'incomplete_punches', 'ok')
RETURNING id AS res_anom \gset
INSERT INTO time.day_anomalies (tenant_id, day_result_id, employee_id, work_date, code, severity)
VALUES (:'tenant_a', :'res_anom', :'emp_a', '2026-07-03', 'missing_out', 'warning') RETURNING id AS anom1 \gset
SET test.anom1 = :'anom1';

DO $$
DECLARE a uuid := current_setting('test.anom1')::uuid;
BEGIN
  -- Un code hors catalogue est refusé.
  BEGIN
    INSERT INTO time.day_anomalies (tenant_id, day_result_id, employee_id, work_date, code, severity)
    SELECT tenant_id, day_result_id, employee_id, work_date, 'invention_maison', 'info'
      FROM time.day_anomalies WHERE id = a;
    RAISE EXCEPTION 'anomalie : un code hors catalogue aurait dû être refusé';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- resolved est RÉSERVÉ au circuit de correction (E10.3).
  BEGIN
    UPDATE time.day_anomalies SET state = 'resolved' WHERE id = a;
    RAISE EXCEPTION 'anomalie : open→resolved aurait dû être refusé';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  -- Le fond d'une anomalie est figé (seuls état/note d'état bougent).
  BEGIN
    UPDATE time.day_anomalies SET code = 'missing_in' WHERE id = a;
    RAISE EXCEPTION 'anomalie : la réécriture du code aurait dû être refusée';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  -- Prise en charge puis écartement : permis.
  UPDATE time.day_anomalies SET state = 'acknowledged', state_note = 'vu' WHERE id = a;
  UPDATE time.day_anomalies SET state = 'dismissed', state_note = 'badge visiteur' WHERE id = a;
  BEGIN
    DELETE FROM time.day_anomalies WHERE id = a;
    RAISE EXCEPTION 'anomalie : la suppression aurait dû être refusée';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
END $$;

-- ---------- Exécutions : pas de chevauchement ACTIF, périmètre bien formé ----------
DO $$
DECLARE t uuid := current_setting('test.tenant_a')::uuid;
        tb uuid := current_setting('test.tenant_b')::uuid;
BEGIN
  -- Une exécution ACTIVE sur juillet…
  INSERT INTO time.calc_runs (tenant_id, period_start, period_end, scope_kind, reason, engine_version, status)
  VALUES (t, '2026-07-10', '2026-07-20', 'tenant', 'relance', 'e10.2-test', 'running');
  -- …bloque toute autre exécution ACTIVE chevauchante du MÊME tenant.
  BEGIN
    INSERT INTO time.calc_runs (tenant_id, period_start, period_end, scope_kind, reason, engine_version, status)
    VALUES (t, '2026-07-15', '2026-07-25', 'tenant', 'concurrent', 'e10.2-test', 'running');
    RAISE EXCEPTION 'exécutions : le chevauchement ACTIF aurait dû être refusé';
  EXCEPTION WHEN exclusion_violation THEN NULL;
  END;
  -- Le MÊME chevauchement chez un AUTRE tenant passe (isolation).
  INSERT INTO time.calc_runs (tenant_id, period_start, period_end, scope_kind, reason, engine_version, status)
  VALUES (tb, '2026-07-15', '2026-07-25', 'tenant', 'autre tenant', 'e10.2-test', 'running');
  -- Une exécution TERMINÉE ne bloque pas (la contrainte ne vise que queued/running).
  INSERT INTO time.calc_runs (tenant_id, period_start, period_end, scope_kind, reason, engine_version, status)
  VALUES (t, '2026-07-01', '2026-07-31', 'tenant', 'nouveau calcul après fin', 'e10.2-test', 'completed');
  -- Périmètre : employee sans employee_id = refusé.
  BEGIN
    INSERT INTO time.calc_runs (tenant_id, period_start, period_end, scope_kind, reason, engine_version, status)
    VALUES (t, '2026-08-01', '2026-08-02', 'employee', 'mal formé', 'e10.2-test', 'completed');
    RAISE EXCEPTION 'exécutions : un périmètre employee sans salarié aurait dû être refusé';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- Suppression interdite.
  BEGIN
    DELETE FROM time.calc_runs WHERE tenant_id = t;
    RAISE EXCEPTION 'exécutions : la suppression aurait dû être refusée';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
END $$;

-- ---------- RLS + privilèges applicatifs ----------
\connect :"appurl"
\set QUIET on
SET app.tenant_id = :'tenant_a';
SET test.tenant_b = :'tenant_b';
SET test.res_v1 = :'res_v1';

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM time.day_results;
  IF n < 3 THEN RAISE EXCEPTION 'RLS : résultats de A invisibles (%)', n; END IF;
  SELECT count(*) INTO n FROM time.day_results WHERE tenant_id = current_setting('test.tenant_b')::uuid;
  IF n <> 0 THEN RAISE EXCEPTION 'RLS : les résultats de B fuient'; END IF;
  SELECT count(*) INTO n FROM time.calc_runs WHERE tenant_id = current_setting('test.tenant_b')::uuid;
  IF n <> 0 THEN RAISE EXCEPTION 'RLS : les exécutions de B fuient'; END IF;
  -- Le rôle applicatif ne peut PAS supprimer.
  BEGIN
    DELETE FROM time.day_results WHERE id = current_setting('test.res_v1')::uuid;
    RAISE EXCEPTION 'privilèges : DELETE résultat aurait dû être refusé';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM time.day_anomalies WHERE true;
    RAISE EXCEPTION 'privilèges : DELETE anomalie aurait dû être refusé';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

SELECT 'OK 96_time_e10_2' AS resultat;
