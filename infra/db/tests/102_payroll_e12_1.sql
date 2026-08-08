-- TEST 102 — Paie E12.1 : ce que PostgreSQL garantit SEUL. Grammaire de formule
-- FERMÉE (aucune exécution arbitraire admise en base), versions de rubriques et
-- rémunérations IMMUABLES, nature de rubrique figée dès le premier calcul,
-- périodes de paie anti-chevauchement au cycle contrôlé, résultat de paie
-- IMMUABLE (un recalcul crée une version), UN SEUL résultat courant par
-- (période, salarié), écriture interdite dans une paie VALIDÉE, lignes figées,
-- FK inter-tenant rejetées, RLS étanche, aucun DELETE applicatif.
\set QUIET on
\set appurl `echo "$DATABASE_URL_APP"`

DO $$
BEGIN
  IF (SELECT count(*) FROM admin.permissions WHERE key IN
      ('payroll.calendar_manage','payroll.structures_manage','payroll.rubrics_manage',
       'payroll.compensation_view','payroll.compensation_manage','payroll.simulate',
       'payroll.run','payroll.results_view','payroll.levies_manage')) <> 9 THEN
    RAISE EXCEPTION 'permissions E12.1 incomplètes au catalogue';
  END IF;
END $$;

-- ---------- Grammaire des formules : la BASE refuse tout ce qui n'est pas un nœud ----------
DO $$
DECLARE hostile jsonb;
BEGIN
  FOREACH hostile IN ARRAY ARRAY[
    '{"k":"call","fn":"process.exit"}'::jsonb,
    '{"k":"eval","src":"1+1"}'::jsonb,
    '{"k":"require","m":"fs"}'::jsonb,
    '{"k":"var","name":"__proto__"}'::jsonb,
    '{"k":"param","key":"PAIE.TAUX"}'::jsonb,
    '{"k":"num","v":"douze"}'::jsonb,
    '{"k":"add","a":{"k":"num","v":1},"b":{"k":"call"}}'::jsonb,
    '"une chaîne"'::jsonb,
    '[1,2,3]'::jsonb
  ] LOOP
    IF payroll.node_is_safe(hostile, false, 0) THEN
      RAISE EXCEPTION 'formule hostile ACCEPTÉE par la base : %', hostile;
    END IF;
  END LOOP;
  IF NOT payroll.node_is_safe(
      '{"k":"if","cond":{"k":"gte","a":{"k":"var","name":"emp.anciennete_mois"},"b":{"k":"num","v":36}},
        "then":{"k":"mul","a":{"k":"var","name":"base.montant"},"b":{"k":"param","key":"paie.prime.anciennete"}},
        "else":{"k":"num","v":0}}'::jsonb, false, 0) THEN
    RAISE EXCEPTION 'formule légitime refusée par la base';
  END IF;
END $$;

-- ---------- Fixtures ----------
SELECT substr(md5(random()::text), 1, 8) AS rid \gset
INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('test-pay-a-' || :'rid', 'PAY A', true) RETURNING id AS tenant_a \gset
INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('test-pay-b-' || :'rid', 'PAY B', true) RETURNING id AS tenant_b \gset
INSERT INTO admin.users (tenant_id, email, password_hash)
VALUES (:'tenant_a', 'pay-' || :'rid' || '@t.bj', 'x') RETURNING id AS user_a \gset
INSERT INTO core.employees (tenant_id, matricule, first_name, last_name, status, hire_date)
VALUES (:'tenant_a', 'PAY-0001', 'Awa', 'Sossou', 'active', '2023-01-01') RETURNING id AS emp_a \gset
INSERT INTO payroll.pay_calendars (tenant_id, code, label_fr, label_en, frequency, created_by)
VALUES (:'tenant_a', 'MENS', 'Mensuel', 'Monthly', 'monthly', :'user_a') RETURNING id AS cal_a \gset
INSERT INTO payroll.pay_periods (tenant_id, calendar_id, label, period_start, period_end, pay_date, created_by)
VALUES (:'tenant_a', :'cal_a', 'Mars 2026', '2026-03-01', '2026-03-31', '2026-03-31', :'user_a') RETURNING id AS per_a \gset
INSERT INTO payroll.salary_structures (tenant_id, code, label_fr, label_en, status, created_by)
VALUES (:'tenant_a', 'CADRE', 'Cadre', 'Staff', 'active', :'user_a') RETURNING id AS str_a \gset
INSERT INTO payroll.rubrics (tenant_id, code, label_fr, label_en, kind, taxable, cotisable, status, created_by)
VALUES (:'tenant_a', 'BASE', 'Salaire de base', 'Base salary', 'gain', true, true, 'active', :'user_a') RETURNING id AS rub_a \gset
INSERT INTO payroll.rubric_versions (tenant_id, rubric_id, version, effective_from, valuation, fixed_value, created_by)
VALUES (:'tenant_a', :'rub_a', 1, '2025-01-01', 'fixed', 300000, :'user_a') RETURNING id AS rv_a \gset
INSERT INTO payroll.compensations (tenant_id, employee_id, structure_id, effective_from, base_amount, currency, periodicity, reason, created_by)
VALUES (:'tenant_a', :'emp_a', :'str_a', '2025-01-01', 300000, 'XOF', 'monthly', 'embauche', :'user_a') RETURNING id AS comp_a \gset

SET test.tenant_a = :'tenant_a';
SET test.tenant_b = :'tenant_b';
SET test.user_a   = :'user_a';
SET test.emp_a    = :'emp_a';
SET test.cal_a    = :'cal_a';
SET test.per_a    = :'per_a';
SET test.str_a    = :'str_a';
SET test.rub_a    = :'rub_a';
SET test.rv_a     = :'rv_a';
SET test.comp_a   = :'comp_a';

-- ---------- Formule hostile REFUSÉE à l'insertion d'une version ----------
DO $$
DECLARE t uuid := current_setting('test.tenant_a')::uuid;
BEGIN
  BEGIN
    INSERT INTO payroll.rubric_versions (tenant_id, rubric_id, version, effective_from, valuation, formula)
    VALUES (t, current_setting('test.rub_a')::uuid, 99, '2027-01-01', 'formula', '{"k":"call","fn":"rm -rf"}'::jsonb);
    RAISE EXCEPTION 'version à formule hostile acceptée';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- Forme incohérente : « rate » sans base ni taux.
  BEGIN
    INSERT INTO payroll.rubric_versions (tenant_id, rubric_id, version, effective_from, valuation)
    VALUES (t, current_setting('test.rub_a')::uuid, 98, '2027-02-01', 'rate');
    RAISE EXCEPTION 'version « rate » sans base ni taux acceptée';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- Un taux ne peut pas être À LA FOIS une valeur interne et une clé E4.
  BEGIN
    INSERT INTO payroll.rubric_versions (tenant_id, rubric_id, version, effective_from, valuation, rate_base, rate_value, rate_param_key)
    VALUES (t, current_setting('test.rub_a')::uuid, 97, '2027-03-01', 'rate', 'base.montant', 0.1, 'paie.taux.x');
    RAISE EXCEPTION 'taux ambigu (valeur ET clé) accepté';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- ---------- Versions de rubriques et rémunérations : IMMUABLES ----------
DO $$
BEGIN
  BEGIN
    UPDATE payroll.rubric_versions SET fixed_value = 999999 WHERE id = current_setting('test.rv_a')::uuid;
    RAISE EXCEPTION 'version de rubrique modifiée';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%version de rubrique modifiée%' THEN RAISE; END IF;
  END;
  BEGIN
    DELETE FROM payroll.rubric_versions WHERE id = current_setting('test.rv_a')::uuid;
    RAISE EXCEPTION 'version de rubrique supprimée';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%version de rubrique supprimée%' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE payroll.compensations SET base_amount = 1 WHERE id = current_setting('test.comp_a')::uuid;
    RAISE EXCEPTION 'rémunération réécrite';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%rémunération réécrite%' THEN RAISE; END IF;
  END;
END $$;

-- ---------- Périodes de paie : anti-chevauchement et cycle contrôlé ----------
DO $$
DECLARE t uuid := current_setting('test.tenant_a')::uuid;
        c uuid := current_setting('test.cal_a')::uuid;
        p uuid := current_setting('test.per_a')::uuid;
BEGIN
  BEGIN
    INSERT INTO payroll.pay_periods (tenant_id, calendar_id, label, period_start, period_end, pay_date)
    VALUES (t, c, 'Chevauche', '2026-03-15', '2026-04-15', '2026-04-15');
    RAISE EXCEPTION 'périodes de paie chevauchantes acceptées';
  EXCEPTION WHEN exclusion_violation THEN NULL;
  END;
  BEGIN
    UPDATE payroll.pay_periods SET period_end = '2026-04-30' WHERE id = p;
    RAISE EXCEPTION 'bornes de période modifiées';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%bornes de période modifiées%' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE payroll.pay_periods SET status = 'validated' WHERE id = p;   -- open → validated
    RAISE EXCEPTION 'transition open→validated acceptée';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%open→validated acceptée%' THEN RAISE; END IF;
  END;
  UPDATE payroll.pay_periods SET status = 'locked' WHERE id = p;
END $$;

-- ---------- Résultats : versionnés, un seul courant, immuables ----------
INSERT INTO payroll.runs (tenant_id, period_id, period_revision, scope_kind, reason, engine_version, started_by)
VALUES (:'tenant_a', :'per_a', 1, 'tenant', 'test 102', 'kora-payroll-gross-1.0.0', :'user_a') RETURNING id AS run_a \gset
SET test.run_a = :'run_a';

INSERT INTO payroll.results (tenant_id, run_id, period_id, employee_id, version, is_current, compensation_id,
  structure_id, currency, gross_amount, taxable_base, contributable_base, lines_count, inputs_sha256, engine_version)
VALUES (:'tenant_a', :'run_a', :'per_a', :'emp_a', 1, true, :'comp_a', :'str_a', 'XOF',
        300000, 300000, 300000, 1, repeat('a', 64), 'kora-payroll-gross-1.0.0') RETURNING id AS res_a \gset
SET test.res_a = :'res_a';

INSERT INTO payroll.result_lines (tenant_id, result_id, sequence, rubric_id, rubric_version_id, rubric_code,
  label_fr, label_en, kind, taxable, cotisable, valuation, amount, trace)
VALUES (:'tenant_a', :'res_a', 1, :'rub_a', :'rv_a', 'BASE', 'Salaire de base', 'Base salary',
        'gain', true, true, 'fixed', 300000, '[{"step":1,"op":"montant fixe","detail":"version","value":300000}]'::jsonb);

DO $$
DECLARE t uuid := current_setting('test.tenant_a')::uuid;
        r uuid := current_setting('test.res_a')::uuid;
BEGIN
  -- Un résultat ne se modifie pas : un recalcul crée une VERSION.
  BEGIN
    UPDATE payroll.results SET gross_amount = 999999 WHERE id = r;
    RAISE EXCEPTION 'montant de paie modifié directement';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%modifié directement%' THEN RAISE; END IF;
  END;
  -- DEUX résultats courants pour (période, salarié) : impossible.
  BEGIN
    INSERT INTO payroll.results (tenant_id, run_id, period_id, employee_id, version, is_current, compensation_id,
      structure_id, currency, gross_amount, taxable_base, contributable_base, lines_count, inputs_sha256, engine_version)
    VALUES (t, current_setting('test.run_a')::uuid, current_setting('test.per_a')::uuid,
            current_setting('test.emp_a')::uuid, 2, true, current_setting('test.comp_a')::uuid,
            current_setting('test.str_a')::uuid, 'XOF', 310000, 310000, 310000, 1, repeat('b', 64), 'kora-payroll-gross-1.0.0');
    RAISE EXCEPTION 'deux résultats COURANTS acceptés';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  -- Le recalcul EN RÈGLE : l'ancienne version cède son drapeau, elle demeure.
  UPDATE payroll.results SET is_current = false WHERE id = r;
  INSERT INTO payroll.results (tenant_id, run_id, period_id, employee_id, version, is_current, compensation_id,
    structure_id, currency, gross_amount, taxable_base, contributable_base, lines_count, inputs_sha256, engine_version)
  VALUES (t, current_setting('test.run_a')::uuid, current_setting('test.per_a')::uuid,
          current_setting('test.emp_a')::uuid, 2, true, current_setting('test.comp_a')::uuid,
          current_setting('test.str_a')::uuid, 'XOF', 310000, 310000, 310000, 1, repeat('b', 64), 'kora-payroll-gross-1.0.0');
  IF (SELECT count(*) FROM payroll.results WHERE period_id = current_setting('test.per_a')::uuid) <> 2 THEN
    RAISE EXCEPTION 'l''ancienne version de paie n''a pas été conservée';
  END IF;
  -- Une version dépassée ne redevient JAMAIS courante.
  BEGIN
    UPDATE payroll.results SET is_current = true WHERE id = r;
    RAISE EXCEPTION 'version dépassée redevenue courante';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%redevenue courante%' THEN RAISE; END IF;
  END;
  -- Lignes de paie FIGÉES, jamais supprimées.
  BEGIN
    UPDATE payroll.result_lines SET amount = 1 WHERE result_id = r;
    RAISE EXCEPTION 'ligne de paie modifiée';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%ligne de paie modifiée%' THEN RAISE; END IF;
  END;
  BEGIN
    DELETE FROM payroll.result_lines WHERE result_id = r;
    RAISE EXCEPTION 'ligne de paie supprimée';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%ligne de paie supprimée%' THEN RAISE; END IF;
  END;
END $$;

-- ---------- Nature d'une rubrique : FIGÉE dès le premier calcul ----------
DO $$
BEGIN
  BEGIN
    UPDATE payroll.rubrics SET taxable = false WHERE id = current_setting('test.rub_a')::uuid;
    RAISE EXCEPTION 'nature de rubrique requalifiée après usage';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%requalifiée après usage%' THEN RAISE; END IF;
  END;
  -- Le libellé, lui, reste corrigeable : il ne change AUCUN calcul.
  UPDATE payroll.rubrics SET label_fr = 'Salaire de base (corrigé)' WHERE id = current_setting('test.rub_a')::uuid;
END $$;

-- ---------- Paie VALIDÉE : plus aucune écriture sans réouverture ----------
DO $$
DECLARE t uuid := current_setting('test.tenant_a')::uuid;
        p uuid := current_setting('test.per_a')::uuid;
BEGIN
  UPDATE payroll.pay_periods SET status = 'validated' WHERE id = p;   -- locked → validated
  BEGIN
    INSERT INTO payroll.results (tenant_id, run_id, period_id, employee_id, version, is_current, compensation_id,
      structure_id, currency, gross_amount, taxable_base, contributable_base, lines_count, inputs_sha256, engine_version)
    VALUES (t, current_setting('test.run_a')::uuid, p, current_setting('test.emp_a')::uuid, 3, false,
            current_setting('test.comp_a')::uuid, current_setting('test.str_a')::uuid, 'XOF',
            1, 1, 1, 0, repeat('c', 64), 'kora-payroll-gross-1.0.0');
    RAISE EXCEPTION 'écriture acceptée dans une paie VALIDÉE';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%dans une paie VALIDÉE%' THEN RAISE; END IF;
  END;
  -- Réouverture : révision +1 exigée, puis l'écriture redevient possible.
  BEGIN
    UPDATE payroll.pay_periods SET status = 'reopened' WHERE id = p;  -- sans révision
    -- Sentinelle DISTINCTE du message du garde (« sans incrément de révision ») :
    -- sinon le refus légitime serait pris pour l'échec du test.
    RAISE EXCEPTION 'SENTINELLE reouverture acceptee sans revision';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%SENTINELLE reouverture%' THEN RAISE; END IF;
  END;
  UPDATE payroll.pay_periods SET status = 'reopened', revision = revision + 1 WHERE id = p;
  INSERT INTO payroll.results (tenant_id, run_id, period_id, employee_id, version, is_current, compensation_id,
    structure_id, currency, gross_amount, taxable_base, contributable_base, lines_count, inputs_sha256, engine_version)
  VALUES (t, current_setting('test.run_a')::uuid, p, current_setting('test.emp_a')::uuid, 3, false,
          current_setting('test.comp_a')::uuid, current_setting('test.str_a')::uuid, 'XOF',
          1, 1, 1, 0, repeat('c', 64), 'kora-payroll-gross-1.0.0');
END $$;

-- ---------- Exécution : entrées figées, statut définitif ----------
DO $$
BEGIN
  UPDATE payroll.runs SET status = 'completed', results_count = 1 WHERE id = current_setting('test.run_a')::uuid;
  BEGIN
    UPDATE payroll.runs SET status = 'failed' WHERE id = current_setting('test.run_a')::uuid;
    RAISE EXCEPTION 'statut d''exécution rejoué';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%rejoué%' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE payroll.runs SET reason = 'autre' WHERE id = current_setting('test.run_a')::uuid;
    RAISE EXCEPTION 'entrées d''exécution modifiées';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%entrées d''exécution modifiées%' THEN RAISE; END IF;
  END;
END $$;

-- ---------- Inter-tenant : aucune donnée de paie ne traverse ----------
DO $$
DECLARE tb uuid := current_setting('test.tenant_b')::uuid;
        cb uuid;
        pb uuid;
        sb uuid;
        rb uuid;
BEGIN
  INSERT INTO payroll.pay_calendars (tenant_id, code, label_fr, label_en, frequency)
  VALUES (tb, 'MENS', 'Mensuel', 'Monthly', 'monthly') RETURNING id INTO cb;
  INSERT INTO payroll.pay_periods (tenant_id, calendar_id, label, period_start, period_end, pay_date)
  VALUES (tb, cb, 'Mars 2026', '2026-03-01', '2026-03-31', '2026-03-31') RETURNING id INTO pb;
  INSERT INTO payroll.salary_structures (tenant_id, code, label_fr, label_en, status)
  VALUES (tb, 'CADRE', 'Cadre', 'Staff', 'active') RETURNING id INTO sb;
  INSERT INTO payroll.runs (tenant_id, period_id, period_revision, scope_kind, reason, engine_version)
  VALUES (tb, pb, 1, 'tenant', 'test B', 'kora-payroll-gross-1.0.0') RETURNING id INTO rb;
  -- Un résultat B ne référence JAMAIS le salarié ni la rémunération de A.
  BEGIN
    INSERT INTO payroll.results (tenant_id, run_id, period_id, employee_id, version, is_current, compensation_id,
      structure_id, currency, gross_amount, taxable_base, contributable_base, lines_count, inputs_sha256, engine_version)
    VALUES (tb, rb, pb, current_setting('test.emp_a')::uuid, 1, true, current_setting('test.comp_a')::uuid,
            sb, 'XOF', 1, 1, 1, 0, repeat('d', 64), 'kora-payroll-gross-1.0.0');
    RAISE EXCEPTION 'résultat B référençant un salarié A accepté';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;

-- ---------- RLS : sans contexte, le rôle applicatif ne voit RIEN ----------
\c :appurl
DO $$
BEGIN
  IF (SELECT count(*) FROM payroll.results) <> 0 THEN
    RAISE EXCEPTION 'RLS paie : des résultats visibles SANS contexte de tenant';
  END IF;
  IF (SELECT count(*) FROM payroll.compensations) <> 0 THEN
    RAISE EXCEPTION 'RLS paie : des rémunérations visibles SANS contexte de tenant';
  END IF;
END $$;

-- ---------- Aucun DELETE applicatif sur les objets de paie ----------
DO $$
DECLARE forbidden text;
BEGIN
  FOREACH forbidden IN ARRAY ARRAY['pay_periods', 'rubric_versions', 'compensations',
                                   'runs', 'results', 'result_lines', 'levy_versions'] LOOP
    IF has_table_privilege('kora_app', 'payroll.' || forbidden, 'DELETE') THEN
      RAISE EXCEPTION 'le rôle applicatif peut SUPPRIMER payroll.%', forbidden;
    END IF;
  END LOOP;
  FOREACH forbidden IN ARRAY ARRAY['rubric_versions', 'compensations', 'result_lines', 'levy_versions'] LOOP
    IF has_table_privilege('kora_app', 'payroll.' || forbidden, 'UPDATE') THEN
      RAISE EXCEPTION 'le rôle applicatif peut MODIFIER payroll.%', forbidden;
    END IF;
  END LOOP;
END $$;
