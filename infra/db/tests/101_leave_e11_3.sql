-- TEST 101 — Congés E11.3 : ce que PostgreSQL garantit SEUL. Faits d'absence
-- versionnés (contenu figé, transitions contrôlées, un seul fait vivant par
-- journée, jamais de DELETE), catégorie paie FIGÉE dès l'usage du type, périodes
-- de congés anti-chevauchement au cycle contrôlé, mouvement rétroactif REFUSÉ
-- sur période close (réouverture = seule voie), clôtures et lignes FIGÉES
-- (active → superseded seul), exports préparatoires immuables et versionnés,
-- résolution d'anomalie par application d'absence admise, RLS étanche.
\set QUIET on
\set appurl `echo "$DATABASE_URL_APP"`

DO $$
BEGIN
  IF (SELECT count(*) FROM admin.permissions WHERE key IN
      ('leave.period_manage','leave.close_run','leave.close_view','leave.reopen',
       'leave.export_create','leave.export_download','leave.reports_view','leave.integration_run')) <> 8 THEN
    RAISE EXCEPTION 'permissions E11.3 incomplètes au catalogue';
  END IF;
END $$;

-- ---------- Fixtures ----------
SELECT substr(md5(random()::text), 1, 8) AS rid \gset
INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('test-li-a-' || :'rid', 'LI A', true) RETURNING id AS tenant_a \gset
INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('test-li-b-' || :'rid', 'LI B', true) RETURNING id AS tenant_b \gset
INSERT INTO core.employees (tenant_id, matricule, first_name, last_name, status, hire_date)
VALUES (:'tenant_a', 'LI-0001', 'Awa', 'Sossou', 'active', '2025-01-01') RETURNING id AS emp_a \gset
INSERT INTO admin.users (tenant_id, email, password_hash)
VALUES (:'tenant_a', 'li-' || :'rid' || '@t.bj', 'x') RETURNING id AS user_a \gset
INSERT INTO leave.absence_types (tenant_id, code, label_fr, label_en, category, paid, unit, prep_category, created_by, status)
VALUES (:'tenant_a', 'CAP', 'Congé annuel payé', 'Paid annual leave', 'legal', true, 'open_days', 'conge_paye', :'user_a', 'active')
RETURNING id AS type_a \gset
INSERT INTO leave.requests (tenant_id, employee_id, absence_type_id, created_by, status, current_version)
VALUES (:'tenant_a', :'emp_a', :'type_a', :'user_a', 'draft', 0) RETURNING id AS req_a \gset
INSERT INTO leave.request_versions (tenant_id, request_id, version, start_date, end_date, quantity, unit, created_by)
VALUES (:'tenant_a', :'req_a', 1, '2026-03-02', '2026-03-03', 2, 'open_days', :'user_a');
INSERT INTO leave.absences (tenant_id, employee_id, absence_type_id, request_id, request_version,
  start_date, end_date, quantity, unit, applied_by)
VALUES (:'tenant_a', :'emp_a', :'type_a', :'req_a', 1, '2026-03-02', '2026-03-03', 2, 'open_days', :'user_a')
RETURNING id AS abs_a \gset

SET test.tenant_a = :'tenant_a';
SET test.tenant_b = :'tenant_b';
SET test.emp_a  = :'emp_a';
SET test.user_a = :'user_a';
SET test.type_a = :'type_a';
SET test.req_a  = :'req_a';
SET test.abs_a  = :'abs_a';

-- ---------- Catégorie paie : FIGÉE dès le premier usage du type ----------
DO $$
DECLARE t uuid := current_setting('test.tenant_a')::uuid;
        ty uuid := current_setting('test.type_a')::uuid;
BEGIN
  -- Un mouvement référence le type ⇒ prep_category rejoint la sémantique figée.
  INSERT INTO leave.entitlement_ledger (tenant_id, employee_id, absence_type_id,
    reference_period_start, reference_period_end, entry_kind, quantity, unit, effective_on, origin, idempotency_key)
  VALUES (t, current_setting('test.emp_a')::uuid, ty, '2026-01-01', '2026-12-31',
          'grant', 2, 'open_days', '2026-01-31', 'admin', 'li-acc-' || t);
  BEGIN
    UPDATE leave.absence_types SET prep_category = 'maladie' WHERE id = ty;
    RAISE EXCEPTION 'catégorie paie modifiée sur un type utilisé';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%catégorie paie modifiée%' THEN RAISE; END IF;
  END;
END $$;

-- ---------- Faits d'absence : figés, versionnés, UN SEUL vivant par journée ----------
INSERT INTO time.absence_facts (tenant_id, employee_id, work_date, absence_id, request_id, request_version,
  absence_type_id, prep_category, type_code, paid, portion, counted, unit, created_by)
VALUES (:'tenant_a', :'emp_a', '2026-03-02', :'abs_a', :'req_a', 1,
        :'type_a', 'conge_paye', 'CAP', true, 'full', 1, 'open_days', :'user_a')
RETURNING id AS fact_1 \gset
SET test.fact_1 = :'fact_1';

DO $$
DECLARE t uuid := current_setting('test.tenant_a')::uuid;
        f uuid := current_setting('test.fact_1')::uuid;
BEGIN
  -- Contenu FIGÉ (la portion ne se retouche pas).
  BEGIN
    UPDATE time.absence_facts SET portion = 'half' WHERE id = f;
    RAISE EXCEPTION 'fait d''absence retouché';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%fait d''absence retouché%' THEN RAISE; END IF;
  END;
  -- Un volume d'heures exige la portion « hours » (et réciproquement).
  BEGIN
    INSERT INTO time.absence_facts (tenant_id, employee_id, work_date, absence_id, request_id, request_version,
      absence_type_id, prep_category, type_code, paid, portion, minutes, counted, unit)
    VALUES (t, current_setting('test.emp_a')::uuid, '2026-03-04', current_setting('test.abs_a')::uuid,
            current_setting('test.req_a')::uuid, 1, current_setting('test.type_a')::uuid,
            'conge_paye', 'CAP', true, 'full', 240, 1, 'open_days');
    RAISE EXCEPTION 'minutes sans portion heures acceptées';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- UN SEUL fait vivant par salarié et journée.
  BEGIN
    INSERT INTO time.absence_facts (tenant_id, employee_id, work_date, absence_id, request_id, request_version,
      absence_type_id, prep_category, type_code, paid, portion, counted, unit, version)
    VALUES (t, current_setting('test.emp_a')::uuid, '2026-03-02', current_setting('test.abs_a')::uuid,
            current_setting('test.req_a')::uuid, 1, current_setting('test.type_a')::uuid,
            'conge_paye', 'CAP', true, 'full', 1, 'open_days', 2);
    RAISE EXCEPTION 'deux faits VIVANTS le même jour';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  -- Supersession : motivée, datée — puis une nouvelle version peut vivre.
  BEGIN
    UPDATE time.absence_facts SET status = 'superseded' WHERE id = f;
    RAISE EXCEPTION 'supersession sans motif acceptée';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%supersession sans motif acceptée%' THEN RAISE; END IF;
  END;
  UPDATE time.absence_facts
     SET status = 'superseded', superseded_at = now(), supersede_reason = 'annulation approuvée (test)'
   WHERE id = f;
  INSERT INTO time.absence_facts (tenant_id, employee_id, work_date, absence_id, request_id, request_version,
    absence_type_id, prep_category, type_code, paid, portion, counted, unit, version)
  VALUES (t, current_setting('test.emp_a')::uuid, '2026-03-02', current_setting('test.abs_a')::uuid,
          current_setting('test.req_a')::uuid, 1, current_setting('test.type_a')::uuid,
          'conge_paye', 'CAP', true, 'half', 0.5, 'open_days', 2);
  -- Jamais de DELETE.
  BEGIN
    DELETE FROM time.absence_facts WHERE id = f;
    RAISE EXCEPTION 'fait d''absence supprimé';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%fait d''absence supprimé%' THEN RAISE; END IF;
  END;
END $$;

-- ---------- Périodes de congés : anti-chevauchement, cycle, mouvement rétroactif refusé ----------
INSERT INTO leave.periods (tenant_id, label, period_start, period_end, created_by)
VALUES (:'tenant_a', 'CONGES-2026-03', '2026-03-01', '2026-03-31', :'user_a') RETURNING id AS per_1 \gset
SET test.per_1 = :'per_1';

DO $$
DECLARE t uuid := current_setting('test.tenant_a')::uuid;
        p uuid := current_setting('test.per_1')::uuid;
        u uuid := current_setting('test.user_a')::uuid;
BEGIN
  -- Chevauchement de périodes : EXCLUSION.
  BEGIN
    INSERT INTO leave.periods (tenant_id, label, period_start, period_end, created_by)
    VALUES (t, 'CHEVAUCHE', '2026-03-15', '2026-04-15', u);
    RAISE EXCEPTION 'périodes de congés chevauchantes acceptées';
  EXCEPTION WHEN exclusion_violation THEN NULL;
  END;
  -- Bornes immuables.
  BEGIN
    UPDATE leave.periods SET period_end = '2026-04-30' WHERE id = p;
    RAISE EXCEPTION 'bornes de période modifiées';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%bornes de période modifiées%' THEN RAISE; END IF;
  END;
  -- Transition interdite : open → reopened.
  BEGIN
    UPDATE leave.periods SET status = 'reopened' WHERE id = p;
    RAISE EXCEPTION 'transition open→reopened acceptée';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%open→reopened acceptée%' THEN RAISE; END IF;
  END;
  -- Clôture : les mouvements ordinaires RÉTROACTIFS sont refusés PAR LA BASE.
  UPDATE leave.periods SET status = 'closed' WHERE id = p;
  BEGIN
    INSERT INTO leave.entitlement_ledger (tenant_id, employee_id, absence_type_id,
      reference_period_start, reference_period_end, entry_kind, quantity, unit, effective_on, origin, idempotency_key)
    VALUES (t, current_setting('test.emp_a')::uuid, current_setting('test.type_a')::uuid,
            '2026-01-01', '2026-12-31', 'adjustment_credit', 1, 'open_days', '2026-03-10', 'admin', 'li-retro-' || t);
    RAISE EXCEPTION 'mouvement rétroactif accepté sur période close';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%rétroactif accepté%' THEN RAISE; END IF;
  END;
  -- Réouverture : révision +1 exigée, puis le mouvement passe.
  BEGIN
    UPDATE leave.periods SET status = 'reopened' WHERE id = p;  -- sans révision
    RAISE EXCEPTION 'réouverture sans incrément de révision';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%sans incrément%' THEN RAISE; END IF;
  END;
  UPDATE leave.periods SET status = 'reopened', revision = revision + 1 WHERE id = p;
  INSERT INTO leave.entitlement_ledger (tenant_id, employee_id, absence_type_id,
    reference_period_start, reference_period_end, entry_kind, quantity, unit, effective_on, origin, idempotency_key)
  VALUES (t, current_setting('test.emp_a')::uuid, current_setting('test.type_a')::uuid,
          '2026-01-01', '2026-12-31', 'adjustment_credit', 1, 'open_days', '2026-03-10', 'admin', 'li-retro-ok-' || t);
END $$;

-- ---------- Clôtures : figées, lignes figées, exports immuables versionnés ----------
INSERT INTO leave.period_closes (tenant_id, period_id, close_no, period_revision, engine_version, dataset_sha256, closed_by)
VALUES (:'tenant_a', :'per_1', 1, 2, 'kora-leave-close-1.0.0', repeat('a', 64), :'user_a')
RETURNING id AS close_1 \gset
INSERT INTO leave.close_lines (tenant_id, close_id, employee_id, absence_type_id, period_start,
  accrued, available, unit, movements)
VALUES (:'tenant_a', :'close_1', :'emp_a', :'type_a', '2026-01-01', 3, 3, 'open_days', 3);
INSERT INTO leave.prep_exports (tenant_id, close_id, format, revision, content, sha256, generated_by)
VALUES (:'tenant_a', :'close_1', 'csv', 1, '\x6b6f7261'::bytea, repeat('b', 64), :'user_a')
RETURNING id AS exp_1 \gset
SET test.close_1 = :'close_1';
SET test.exp_1 = :'exp_1';

DO $$
DECLARE t uuid := current_setting('test.tenant_a')::uuid;
        c uuid := current_setting('test.close_1')::uuid;
        e uuid := current_setting('test.exp_1')::uuid;
        u uuid := current_setting('test.user_a')::uuid;
BEGIN
  -- Clôture : contenu figé, seule la bascule active → superseded est permise.
  BEGIN
    UPDATE leave.period_closes SET dataset_sha256 = repeat('c', 64) WHERE id = c;
    RAISE EXCEPTION 'empreinte de clôture réécrite';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%empreinte de clôture réécrite%' THEN RAISE; END IF;
  END;
  -- Ligne figée.
  BEGIN
    UPDATE leave.close_lines SET available = 99 WHERE close_id = c;
    RAISE EXCEPTION 'ligne de clôture retouchée';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%ligne de clôture retouchée%' THEN RAISE; END IF;
  END;
  -- Export : contenu immuable ; le remplacement est une NOUVELLE révision.
  BEGIN
    UPDATE leave.prep_exports SET content = '\x00'::bytea WHERE id = e;
    RAISE EXCEPTION 'export préparatoire réécrit';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%export préparatoire réécrit%' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO leave.prep_exports (tenant_id, close_id, format, revision, content, sha256, generated_by)
    VALUES (t, c, 'csv', 1, '\x00'::bytea, repeat('d', 64), u);
    RAISE EXCEPTION 'deux exports de même révision acceptés';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  UPDATE leave.prep_exports SET status = 'superseded' WHERE id = e;
  INSERT INTO leave.prep_exports (tenant_id, close_id, format, revision, content, sha256, generated_by)
  VALUES (t, c, 'csv', 2, '\x6b6f726132'::bytea, repeat('e', 64), u);
  BEGIN
    DELETE FROM leave.prep_exports WHERE id = e;
    RAISE EXCEPTION 'export supprimé';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%export supprimé%' THEN RAISE; END IF;
  END;
END $$;

-- ---------- Anomalie résolue par APPLICATION D'ABSENCE : admise et bornée ----------
DO $$
DECLARE t uuid := current_setting('test.tenant_a')::uuid;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'time.day_anomalies'::regclass
       AND conname = 'day_anomalies_resolution_kind_check'
       AND pg_get_constraintdef(oid) NOT LIKE '%absence_applied%'
  ) THEN
    RAISE EXCEPTION 'resolution_kind absence_applied absent de la contrainte';
  END IF;
END $$;

-- ---------- Inter-tenant : un fait B ne référence JAMAIS l'absence du tenant A ----------
DO $$
DECLARE tb uuid := current_setting('test.tenant_b')::uuid;
        eb uuid;
BEGIN
  INSERT INTO core.employees (tenant_id, matricule, first_name, last_name, status, hire_date)
  VALUES (tb, 'LI-B001', 'Bio', 'Kassim', 'active', '2025-01-01') RETURNING id INTO eb;
  BEGIN
    INSERT INTO time.absence_facts (tenant_id, employee_id, work_date, absence_id, request_id, request_version,
      absence_type_id, prep_category, type_code, paid, portion, counted, unit)
    VALUES (tb, eb, '2026-03-02', current_setting('test.abs_a')::uuid,
            current_setting('test.req_a')::uuid, 1, current_setting('test.type_a')::uuid,
            'conge_paye', 'CAP', true, 'full', 1, 'open_days');
    RAISE EXCEPTION 'fait B lié à l''absence du tenant A';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;

-- ---------- RLS + privilèges applicatifs ----------
\connect :appurl
SET app.tenant_id = '';
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM time.absence_facts;
  IF n <> 0 THEN RAISE EXCEPTION 'RLS : faits lisibles sans contexte tenant (%)', n; END IF;
  SELECT count(*) INTO n FROM leave.period_closes;
  IF n <> 0 THEN RAISE EXCEPTION 'RLS : clôtures lisibles sans contexte tenant (%)', n; END IF;
  SELECT count(*) INTO n FROM leave.prep_exports;
  IF n <> 0 THEN RAISE EXCEPTION 'RLS : exports lisibles sans contexte tenant (%)', n; END IF;
END $$;

DO $$
BEGIN
  BEGIN
    DELETE FROM time.absence_facts WHERE true;
    RAISE EXCEPTION 'DELETE faits autorisé au rôle applicatif';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE leave.close_lines SET available = 0 WHERE true;
    RAISE EXCEPTION 'UPDATE lignes de clôture autorisé au rôle applicatif';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM leave.prep_exports WHERE true;
    RAISE EXCEPTION 'DELETE exports autorisé au rôle applicatif';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

SELECT 'OK 101 — E11.3 : faits versionnés, période close = mouvements refusés, clôtures/exports figés' AS resultat;
