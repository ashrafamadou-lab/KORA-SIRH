-- TEST 97 — Corrections & clôture E10.3 : demandes à états contrôlés et contenu
-- figé après soumission, resoumission VERSIONNÉE, événements correctifs append-only
-- avec UNE SEULE application par demande (anti-rejeu PAR LA BASE), pièces figées à
-- suppression logique, anomalies résolubles UNIQUEMENT avec référence probante,
-- périodes sans chevauchement au cycle contrôlé, verrou de période sur les
-- résultats ET les corrections, clôtures et exports figés (remplacés, jamais
-- réécrits), FK inter-tenant rejetées, RLS étanche, catalogue des permissions.
\set QUIET on
\set appurl `echo "$DATABASE_URL_APP"`

DO $$
BEGIN
  IF (SELECT count(*) FROM admin.permissions WHERE key IN
      ('time.correction_request_self','time.correction_request','time.correction_view',
       'time.correction_admin','time.attachments_view','time.preclose_view',
       'time.period_manage','time.period_close','time.period_reopen',
       'time.payroll_view','time.payroll_export','time.rules_admin')) <> 12 THEN
    RAISE EXCEPTION 'permissions E10.3 incomplètes au catalogue';
  END IF;
END $$;

-- ---------- Fixtures (migrator) ----------
SELECT substr(md5(random()::text), 1, 8) AS rid \gset
INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('test-cx-a-' || :'rid', 'CX A', true) RETURNING id AS tenant_a \gset
INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('test-cx-b-' || :'rid', 'CX B', true) RETURNING id AS tenant_b \gset
INSERT INTO core.employees (tenant_id, matricule, first_name, last_name, status, hire_date)
VALUES (:'tenant_a', 'CX-0001', 'Awa', 'Sossou', 'active', '2025-01-01') RETURNING id AS emp_a \gset
INSERT INTO core.employees (tenant_id, matricule, first_name, last_name, status, hire_date)
VALUES (:'tenant_b', 'CX-B001', 'Bio', 'Kassim', 'active', '2025-01-01') RETURNING id AS emp_b \gset
INSERT INTO admin.users (tenant_id, email, password_hash)
VALUES (:'tenant_a', 'cx-' || :'rid' || '@t.bj', 'x') RETURNING id AS user_a \gset

INSERT INTO time.calc_runs (tenant_id, period_start, period_end, scope_kind, reason, engine_version, status)
VALUES (:'tenant_a', '2026-07-01', '2026-07-31', 'tenant', 'fixture', 'e10.3-test', 'completed') RETURNING id AS run_a \gset
INSERT INTO time.day_results (tenant_id, employee_id, work_date, version, is_current, calc_run_id,
                              engine_version, tz, worked_minutes, day_status)
VALUES (:'tenant_a', :'emp_a', '2026-07-06', 1, true, :'run_a', 'e10.3-test', 'Africa/Porto-Novo', 0, 'absent')
RETURNING id AS res_a \gset
INSERT INTO time.day_anomalies (tenant_id, day_result_id, employee_id, work_date, code, severity)
VALUES (:'tenant_a', :'res_a', :'emp_a', '2026-07-06', 'missing_out', 'warning') RETURNING id AS anom_a \gset

SET test.tenant_a = :'tenant_a';
SET test.tenant_b = :'tenant_b';
SET test.emp_a = :'emp_a';
SET test.emp_b = :'emp_b';
SET test.user_a = :'user_a';
SET test.run_a = :'run_a';
SET test.res_a = :'res_a';
SET test.anom_a = :'anom_a';

-- ---------- Demandes : états, contenu figé, resoumission versionnée ----------
INSERT INTO time.correction_requests (tenant_id, employee_id, work_date, kind, origin, requester_user_id, motive, payload)
VALUES (:'tenant_a', :'emp_a', '2026-07-06', 'add_out', 'self', :'user_a', 'sortie oubliée', '{"localTime":"17:00"}')
RETURNING id AS req_a \gset
SET test.req_a = :'req_a';

DO $$
DECLARE t uuid := current_setting('test.tenant_a')::uuid;
        rq uuid := current_setting('test.req_a')::uuid;
BEGIN
  -- draft → applied : transition interdite (il faut soumettre puis approuver).
  BEGIN
    UPDATE time.correction_requests SET status = 'applied' WHERE id = rq;
    RAISE EXCEPTION 'draft -> applied aurait dû être refusé';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  UPDATE time.correction_requests SET status = 'submitted', submitted_at = now() WHERE id = rq;
  -- Contenu FIGÉ après soumission.
  BEGIN
    UPDATE time.correction_requests SET payload = '{"localTime":"18:00"}' WHERE id = rq;
    RAISE EXCEPTION 'payload d''une demande SOUMISE aurait dû être figé';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  -- Retour pour complément, puis resoumission SANS incrément de version : refusée.
  UPDATE time.correction_requests SET status = 'returned' WHERE id = rq;
  UPDATE time.correction_requests SET payload = '{"localTime":"17:30"}' WHERE id = rq; -- éditable en 'returned'
  BEGIN
    UPDATE time.correction_requests SET status = 'submitted' WHERE id = rq;
    RAISE EXCEPTION 'resoumission sans version+1 aurait dû être refusée';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  UPDATE time.correction_requests SET status = 'submitted', version = 2 WHERE id = rq;
  -- Saut de version hors resoumission : refusé.
  BEGIN
    UPDATE time.correction_requests SET version = 5 WHERE id = rq;
    RAISE EXCEPTION 'changement de version hors resoumission aurait dû être refusé';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  -- DELETE : jamais.
  BEGIN
    DELETE FROM time.correction_requests WHERE id = rq;
    RAISE EXCEPTION 'DELETE de demande aurait dû être refusé';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  UPDATE time.correction_requests SET status = 'approved', decided_at = now() WHERE id = rq;
END $$;

-- ---------- Événements correctifs : append-only, UNE application par demande ----------
INSERT INTO time.correction_events (tenant_id, request_id, employee_id, work_date, kind, effect, created_by)
VALUES (:'tenant_a', :'req_a', :'emp_a', '2026-07-06', 'add_out',
        '{"addEvent":{"localMinute":1050,"type":"out"}}', :'user_a')
RETURNING id AS evt_a \gset
SET test.evt_a = :'evt_a';

DO $$
DECLARE t uuid := current_setting('test.tenant_a')::uuid;
        rq uuid := current_setting('test.req_a')::uuid;
        e uuid := current_setting('test.emp_a')::uuid;
        ev uuid := current_setting('test.evt_a')::uuid;
        u uuid := current_setting('test.user_a')::uuid;
BEGIN
  -- Rejeu de l'application : la MÊME demande ne peut pas produire un 2e événement.
  BEGIN
    INSERT INTO time.correction_events (tenant_id, request_id, employee_id, work_date, kind, effect, created_by)
    VALUES (t, rq, e, '2026-07-06', 'add_out', '{"addEvent":{"localMinute":1051,"type":"out"}}', u);
    RAISE EXCEPTION 'double application d''une demande aurait dû être refusée';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  -- L'événement correctif est FIGÉ.
  BEGIN
    UPDATE time.correction_events SET effect = '{"addEvent":{"localMinute":1,"type":"out"}}' WHERE id = ev;
    RAISE EXCEPTION 'réécriture d''un événement correctif aurait dû être refusée';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  BEGIN
    DELETE FROM time.correction_events WHERE id = ev;
    RAISE EXCEPTION 'DELETE d''un événement correctif aurait dû être refusé';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  -- FK inter-tenant : un événement du tenant B ne peut pas viser la demande du tenant A.
  BEGIN
    INSERT INTO time.correction_events (tenant_id, request_id, employee_id, work_date, kind, effect, created_by)
    VALUES (current_setting('test.tenant_b')::uuid, rq, current_setting('test.emp_b')::uuid,
            '2026-07-06', 'add_out', '{}', u);
    RAISE EXCEPTION 'FK inter-tenant (événement correctif) aurait dû être rejetée';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  UPDATE time.correction_requests SET status = 'applied', applied_at = now(), applied_event_id = ev WHERE id = rq;
END $$;

-- ---------- Pièces : figées, suppression LOGIQUE seulement ----------
INSERT INTO time.correction_attachments (tenant_id, request_id, filename, mime, byte_size, sha256, sensitive, content, uploaded_by)
VALUES (:'tenant_a', :'req_a', 'certificat.pdf', 'application/pdf', 10, repeat('a', 64), true, '\x25504446'::bytea, :'user_a')
RETURNING id AS att_a \gset
SET test.att_a = :'att_a';

DO $$
DECLARE a uuid := current_setting('test.att_a')::uuid;
BEGIN
  BEGIN
    UPDATE time.correction_attachments SET filename = 'autre.pdf' WHERE id = a;
    RAISE EXCEPTION 'métadonnées de pièce auraient dû être figées';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  UPDATE time.correction_attachments SET av_status = 'clean' WHERE id = a;      -- permis
  UPDATE time.correction_attachments SET deleted_at = now() WHERE id = a;       -- suppression LOGIQUE
  BEGIN
    DELETE FROM time.correction_attachments WHERE id = a;
    RAISE EXCEPTION 'DELETE physique d''une pièce aurait dû être refusé';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
END $$;

-- ---------- Anomalies : résolution RÉFÉRENCÉE ou classement motivé, jamais silencieuse ----------
DO $$
DECLARE an uuid := current_setting('test.anom_a')::uuid;
        ev uuid := current_setting('test.evt_a')::uuid;
        u uuid := current_setting('test.user_a')::uuid;
BEGIN
  -- resolved SANS référence : refusé.
  BEGIN
    UPDATE time.day_anomalies SET state = 'resolved', state_by = u, state_at = now() WHERE id = an;
    RAISE EXCEPTION 'résolution SANS référence probante aurait dû être refusée';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  -- resolved « correction appliquée » sans événement lié : refusé.
  BEGIN
    UPDATE time.day_anomalies SET state = 'resolved', resolution_kind = 'correction_applied',
           state_by = u, state_at = now() WHERE id = an;
    RAISE EXCEPTION 'resolution_kind sans événement lié aurait dû être refusé';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  -- resolved AVEC événement correctif : accepté.
  UPDATE time.day_anomalies SET state = 'resolved', resolution_kind = 'correction_applied',
         resolution_event_id = ev, state_by = u, state_at = now() WHERE id = an;
  -- Réouverture contrôlée : la référence est PURGÉE en quittant resolved.
  BEGIN
    UPDATE time.day_anomalies SET state = 'open' WHERE id = an;
    RAISE EXCEPTION 'réouverture sans purge de la référence aurait dû être refusée';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  UPDATE time.day_anomalies SET state = 'open', resolution_kind = NULL, resolution_event_id = NULL,
         state_note = 'réouverture de contrôle', state_by = u, state_at = now() WHERE id = an;
  -- Classement motivé SANS correction : accepté (décision explicite, note obligatoire).
  UPDATE time.day_anomalies SET state = 'resolved', resolution_kind = 'classified',
         state_note = 'doublon de badgeage confirmé par le site', state_by = u, state_at = now() WHERE id = an;
  -- Affectation à un gestionnaire : champ mutable dédié.
  UPDATE time.day_anomalies SET assigned_to = u, due_at = now() + interval '3 days' WHERE id = an;
END $$;

-- ---------- Périodes : chevauchement interdit, cycle contrôlé, verrou d'écriture ----------
INSERT INTO time.periods (tenant_id, scope_kind, label, period_start, period_end, created_by)
VALUES (:'tenant_a', 'tenant', 'Juillet 2026', '2026-07-01', '2026-07-31', :'user_a') RETURNING id AS per_a \gset
SET test.per_a = :'per_a';

DO $$
DECLARE t uuid := current_setting('test.tenant_a')::uuid;
        p uuid := current_setting('test.per_a')::uuid;
        u uuid := current_setting('test.user_a')::uuid;
        e uuid := current_setting('test.emp_a')::uuid;
        r uuid := current_setting('test.run_a')::uuid;
        rq2 uuid;
BEGIN
  -- Périodes chevauchantes du même périmètre : REFUSÉES par la base.
  BEGIN
    INSERT INTO time.periods (tenant_id, scope_kind, label, period_start, period_end, created_by)
    VALUES (t, 'tenant', 'Chevauchante', '2026-07-15', '2026-08-15', u);
    RAISE EXCEPTION 'périodes chevauchantes auraient dû être refusées';
  EXCEPTION WHEN exclusion_violation THEN NULL;
  END;
  -- L'autre TENANT n'est pas gêné.
  INSERT INTO time.periods (tenant_id, scope_kind, label, period_start, period_end, created_by)
  VALUES (current_setting('test.tenant_b')::uuid, 'tenant', 'Juillet B', '2026-07-01', '2026-07-31', u);
  -- Cycle : open -> closed direct interdit.
  BEGIN
    UPDATE time.periods SET status = 'closed' WHERE id = p;
    RAISE EXCEPTION 'open -> closed direct aurait dû être refusé';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  UPDATE time.periods SET status = 'in_review' WHERE id = p;
  UPDATE time.periods SET status = 'locked' WHERE id = p;
  -- Période VERROUILLÉE : nouvelle version de résultat REFUSÉE par la base.
  BEGIN
    INSERT INTO time.day_results (tenant_id, employee_id, work_date, version, is_current, calc_run_id,
                                  engine_version, tz, worked_minutes, day_status)
    VALUES (t, e, '2026-07-07', 1, true, r, 'e10.3-test', 'Africa/Porto-Novo', 480, 'present');
    RAISE EXCEPTION 'écriture de résultat en période verrouillée aurait dû être refusée';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  -- Période VERROUILLÉE : événement correctif REFUSÉ par la base.
  INSERT INTO time.correction_requests (tenant_id, employee_id, work_date, kind, origin, requester_user_id, motive)
  VALUES (t, e, '2026-07-08', 'add_in', 'hr', u, 'test verrou') RETURNING id INTO rq2;
  UPDATE time.correction_requests SET status = 'submitted', submitted_at = now() WHERE id = rq2;
  UPDATE time.correction_requests SET status = 'approved', decided_at = now() WHERE id = rq2;
  BEGIN
    INSERT INTO time.correction_events (tenant_id, request_id, employee_id, work_date, kind, effect, created_by)
    VALUES (t, rq2, e, '2026-07-08', 'add_in', '{"addEvent":{"localMinute":480,"type":"in"}}', u);
    RAISE EXCEPTION 'événement correctif en période verrouillée aurait dû être refusé';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  -- Bornes immuables.
  BEGIN
    UPDATE time.periods SET period_end = '2026-08-15' WHERE id = p;
    RAISE EXCEPTION 'bornes de période auraient dû être immuables';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
END $$;

-- ---------- Clôtures : figées, réouverture versionnée, hors période rien ne bouge ----------
DO $$
DECLARE t uuid := current_setting('test.tenant_a')::uuid;
        p uuid := current_setting('test.per_a')::uuid;
        u uuid := current_setting('test.user_a')::uuid;
        e uuid := current_setting('test.emp_a')::uuid;
        res uuid := current_setting('test.res_a')::uuid;
        c1 uuid;
BEGIN
  UPDATE time.periods SET status = 'closed' WHERE id = p;
  INSERT INTO time.period_closes (tenant_id, period_id, close_no, period_revision, engine_version,
                                  dataset_sha256, employees_count, days_count, results_count, totals, closed_by)
  VALUES (t, p, 1, 1, 'e10.3-test', repeat('b', 64), 1, 31, 1, '{"workedMinutes":0}', u)
  RETURNING id INTO c1;
  INSERT INTO time.period_close_lines (tenant_id, close_id, employee_id, work_date, day_result_id)
  VALUES (t, c1, e, '2026-07-06', res);
  INSERT INTO time.period_close_totals (tenant_id, close_id, employee_id, expected_days, worked_minutes)
  VALUES (t, c1, e, 22, 0);
  -- Une clôture est FIGÉE (seul superseded est permis).
  BEGIN
    UPDATE time.period_closes SET dataset_sha256 = repeat('c', 64) WHERE id = c1;
    RAISE EXCEPTION 'empreinte de clôture aurait dû être figée';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  -- Une ligne retenue ne bouge jamais.
  BEGIN
    DELETE FROM time.period_close_lines WHERE close_id = c1;
    RAISE EXCEPTION 'lignes de clôture auraient dû être figées';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  -- Même close_no rejoué : refusé (idempotence par la base).
  BEGIN
    INSERT INTO time.period_closes (tenant_id, period_id, close_no, period_revision, engine_version,
                                    dataset_sha256, closed_by)
    VALUES (t, p, 1, 1, 'e10.3-test', repeat('d', 64), u);
    RAISE EXCEPTION 'double clôture n°1 aurait dû être refusée';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  -- Réouverture : révision +1 OBLIGATOIRE, la clôture précédente DEMEURE.
  BEGIN
    UPDATE time.periods SET status = 'reopened' WHERE id = p;
    RAISE EXCEPTION 'réouverture sans révision+1 aurait dû être refusée';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  UPDATE time.periods SET status = 'reopened', revision = 2 WHERE id = p;
  UPDATE time.period_closes SET status = 'superseded' WHERE id = c1;   -- marquée remplacée, jamais supprimée
  IF (SELECT count(*) FROM time.period_closes WHERE period_id = p) <> 1 THEN
    RAISE EXCEPTION 'la clôture précédente doit DEMEURER';
  END IF;
  -- Période rouverte : l'écriture de résultat fonctionne À NOUVEAU.
  INSERT INTO time.day_results (tenant_id, employee_id, work_date, version, is_current, calc_run_id,
                                engine_version, tz, worked_minutes, day_status)
  VALUES (t, e, '2026-07-07', 1, true, current_setting('test.run_a')::uuid, 'e10.3-test', 'Africa/Porto-Novo', 480, 'present');
  -- Nouvelle clôture (n°2) après nouvelles écritures.
  UPDATE time.periods SET status = 'locked' WHERE id = p;
  UPDATE time.periods SET status = 'closed' WHERE id = p;
  INSERT INTO time.period_closes (tenant_id, period_id, close_no, period_revision, engine_version,
                                  dataset_sha256, employees_count, days_count, results_count, totals, closed_by)
  VALUES (t, p, 2, 2, 'e10.3-test', repeat('e', 64), 1, 31, 2, '{"workedMinutes":480}', u);
END $$;

-- ---------- Exports : immuables, révisions, remplacé jamais supprimé ----------
DO $$
DECLARE t uuid := current_setting('test.tenant_a')::uuid;
        p uuid := current_setting('test.per_a')::uuid;
        u uuid := current_setting('test.user_a')::uuid;
        c2 uuid;
        x1 uuid;
BEGIN
  SELECT id INTO c2 FROM time.period_closes WHERE period_id = p AND close_no = 2;
  INSERT INTO time.payroll_exports (tenant_id, close_id, schema_version, format, revision, content, sha256, employees_count, generated_by)
  VALUES (t, c2, 'kora-paie-prep-1', 'csv', 1, 'matricule;jours'::bytea, repeat('f', 64), 1, u)
  RETURNING id INTO x1;
  -- Contenu FIGÉ.
  BEGIN
    UPDATE time.payroll_exports SET content = 'autre'::bytea WHERE id = x1;
    RAISE EXCEPTION 'contenu d''export aurait dû être figé';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  BEGIN
    DELETE FROM time.payroll_exports WHERE id = x1;
    RAISE EXCEPTION 'DELETE d''export aurait dû être refusé';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  -- Même (clôture, schéma, format, révision) rejoué : refusé — une nouvelle
  -- révision doit être EXPLICITE.
  BEGIN
    INSERT INTO time.payroll_exports (tenant_id, close_id, schema_version, format, revision, content, sha256, generated_by)
    VALUES (t, c2, 'kora-paie-prep-1', 'csv', 1, 'x'::bytea, repeat('0', 64), u);
    RAISE EXCEPTION 'révision d''export dupliquée aurait dû être refusée';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  UPDATE time.payroll_exports SET status = 'superseded' WHERE id = x1;
  INSERT INTO time.payroll_exports (tenant_id, close_id, schema_version, format, revision, content, sha256, generated_by)
  VALUES (t, c2, 'kora-paie-prep-1', 'csv', 2, 'matricule;jours;v2'::bytea, repeat('9', 64), u);
END $$;

-- ---------- RLS : l'applicatif ne voit que SON tenant ; jamais de DELETE ----------
\connect :appurl
SELECT set_config('app.tenant_id', current_setting('test.tenant_a', true), false) \gset
DO $$
BEGIN
  PERFORM set_config('app.tenant_id', (SELECT tenant_id::text FROM time.correction_requests LIMIT 1), true);
END $$;
\connect :appurl

DO $$
DECLARE n int;
BEGIN
  -- Sans contexte tenant : AUCUNE ligne.
  SELECT count(*) INTO n FROM time.correction_requests;
  IF n <> 0 THEN RAISE EXCEPTION 'RLS : demandes visibles sans contexte tenant (%)', n; END IF;
  SELECT count(*) INTO n FROM time.periods;
  IF n <> 0 THEN RAISE EXCEPTION 'RLS : périodes visibles sans contexte tenant (%)', n; END IF;
  SELECT count(*) INTO n FROM time.payroll_exports;
  IF n <> 0 THEN RAISE EXCEPTION 'RLS : exports visibles sans contexte tenant (%)', n; END IF;
END $$;

DO $$
DECLARE n int;
BEGIN
  BEGIN
    DELETE FROM time.correction_events WHERE true;
    RAISE EXCEPTION 'kora_app ne doit PAS pouvoir supprimer un événement correctif';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM time.period_close_lines WHERE true;
    RAISE EXCEPTION 'kora_app ne doit PAS pouvoir supprimer une ligne de clôture';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  n := 0;
END $$;
