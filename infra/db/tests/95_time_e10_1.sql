-- TEST 95 — Temps & pointage E10.1 : registre brut APPEND-ONLY (aucune modification,
-- aucune suppression), déduplication idempotente par empreinte, versions d'horaires
-- immuables (le passé est figé), nuits traversant minuit représentées SANS ambiguïté,
-- chevauchements d'affectations d'horaires rejetés par PostgreSQL, FK inter-tenant
-- rejetées, RLS étanche, privilèges minimaux du rôle applicatif, catalogue permissions.
\set QUIET on
\set appurl `echo "$DATABASE_URL_APP"`

-- ---------- Catalogue (migrator) ----------
DO $$
BEGIN
  IF (SELECT count(*) FROM admin.permissions WHERE key IN
      ('time.schedules_view','time.schedules_manage','time.schedules_assign','time.punches_import',
       'time.punches_view','time.punches_view_errors','time.punches_view_own','time.devices_manage')) <> 8 THEN
    RAISE EXCEPTION 'permissions time.* incomplètes au catalogue';
  END IF;
END $$;

-- ---------- Fixtures (migrator) ----------
SELECT substr(md5(random()::text), 1, 8) AS rid \gset
INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('test-tm-a-' || :'rid', 'TM A', true) RETURNING id AS tenant_a \gset
INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('test-tm-b-' || :'rid', 'TM B', true) RETURNING id AS tenant_b \gset

INSERT INTO org.companies (tenant_id, code, label_fr, label_en, status) VALUES (:'tenant_a', 'TMA-CO', 'A', 'A', 'active') RETURNING id AS co_a \gset
INSERT INTO org.sites (tenant_id, company_id, code, label_fr, label_en, status, time_zone)
VALUES (:'tenant_a', :'co_a', 'TMA-SITE', 'Site A', 'Site A', 'active', 'Africa/Porto-Novo') RETURNING id AS site_a \gset
INSERT INTO org.units (tenant_id, unit_type, code, label_fr, label_en, status) VALUES (:'tenant_a', 'direction', 'TMA-DIR', 'A', 'A', 'active') RETURNING id AS unit_a \gset
INSERT INTO core.employees (tenant_id, matricule, first_name, last_name, status, hire_date)
VALUES (:'tenant_a', 'TM-0001', 'Awa', 'Sossou', 'active', '2025-01-01') RETURNING id AS emp_a \gset

INSERT INTO org.companies (tenant_id, code, label_fr, label_en, status) VALUES (:'tenant_b', 'TMB-CO', 'B', 'B', 'active') RETURNING id AS co_b \gset
INSERT INTO core.employees (tenant_id, matricule, first_name, last_name, status, hire_date)
VALUES (:'tenant_b', 'TM-B001', 'Bio', 'Kassim', 'active', '2025-01-01') RETURNING id AS emp_b \gset

-- ---------- Modèle d'horaire + version 1 (mise en place initiale : date libre) ----------
INSERT INTO time.schedule_models (tenant_id, code, label_fr, label_en, kind)
VALUES (:'tenant_a', 'TM-NUIT', 'Rotation nuit', 'Night rotation', 'rotation') RETURNING id AS model_a \gset
INSERT INTO time.schedule_versions (tenant_id, model_id, version, effective_from, cycle_days)
VALUES (:'tenant_a', :'model_a', 1, '2025-06-01', 4) RETURNING id AS ver1 \gset

-- Nuit traversant minuit : 22:00 → 06:00 = 1320 → 1800 (end > 1440 EST le lendemain).
INSERT INTO time.schedule_version_days (tenant_id, version_id, day_index, is_rest, start_minute, end_minute)
VALUES (:'tenant_a', :'ver1', 0, false, 1320, 1800);
INSERT INTO time.schedule_version_days (tenant_id, version_id, day_index, is_rest, start_minute, end_minute, break_start_minute, break_end_minute)
VALUES (:'tenant_a', :'ver1', 1, false, 480, 1020, 720, 780);
INSERT INTO time.schedule_version_days (tenant_id, version_id, day_index, is_rest)
VALUES (:'tenant_a', :'ver1', 2, true);
INSERT INTO time.schedule_version_days (tenant_id, version_id, day_index, is_rest)
VALUES (:'tenant_a', :'ver1', 3, true);

SET test.tenant_a = :'tenant_a';
SET test.tenant_b = :'tenant_b';
SET test.model_a = :'model_a';
SET test.ver1 = :'ver1';
SET test.emp_a = :'emp_a';
SET test.emp_b = :'emp_b';
SET test.site_a = :'site_a';
SET test.co_a = :'co_a';
SET test.unit_a = :'unit_a';

-- ---------- Représentation des plages : les formes ambiguës sont IMPOSSIBLES ----------
DO $$
DECLARE t uuid := current_setting('test.tenant_a')::uuid;
        v uuid := current_setting('test.ver1')::uuid;
BEGIN
  -- end <= start (sans marquage de lendemain) : refusé.
  BEGIN
    INSERT INTO time.schedule_version_days (tenant_id, version_id, day_index, is_rest, start_minute, end_minute)
    VALUES (t, v, 9, false, 1320, 360);
    RAISE EXCEPTION 'plage : end<=start aurait dû être refusé (représentation ambiguë)';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- Plus de 24 h : refusé (1320 → 2761 dépasserait le lendemain 22:01).
  BEGIN
    INSERT INTO time.schedule_version_days (tenant_id, version_id, day_index, is_rest, start_minute, end_minute)
    VALUES (t, v, 9, false, 1320, 2761);
    RAISE EXCEPTION 'plage : durée > 24 h aurait dû être refusée';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- Jour de repos avec des heures : refusé.
  BEGIN
    INSERT INTO time.schedule_version_days (tenant_id, version_id, day_index, is_rest, start_minute, end_minute)
    VALUES (t, v, 9, true, 480, 1020);
    RAISE EXCEPTION 'repos : des heures sur un jour de repos auraient dû être refusées';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- Pause hors de la plage : refusée.
  BEGIN
    INSERT INTO time.schedule_version_days (tenant_id, version_id, day_index, is_rest, start_minute, end_minute, break_start_minute, break_end_minute)
    VALUES (t, v, 9, false, 480, 1020, 300, 400);
    RAISE EXCEPTION 'pause : une pause hors plage aurait dû être refusée';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- ---------- Versions : le PASSÉ est figé ----------
DO $$
DECLARE t uuid := current_setting('test.tenant_a')::uuid;
        m uuid := current_setting('test.model_a')::uuid;
BEGIN
  -- Version 2 dans le passé : refusée (le planning passé est immuable).
  BEGIN
    INSERT INTO time.schedule_versions (tenant_id, model_id, version, effective_from, cycle_days)
    VALUES (t, m, 2, current_date - 30, 4);
    RAISE EXCEPTION 'version passée : aurait dû être refusée';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  -- Mauvais numéro de version : refusé.
  BEGIN
    INSERT INTO time.schedule_versions (tenant_id, model_id, version, effective_from, cycle_days)
    VALUES (t, m, 5, current_date + 30, 4);
    RAISE EXCEPTION 'numérotation : le saut de version aurait dû être refusé';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  -- Version 2 future : acceptée.
  INSERT INTO time.schedule_versions (tenant_id, model_id, version, effective_from, cycle_days)
  VALUES (t, m, 2, current_date + 30, 7);
  -- Une version existante ne se réécrit JAMAIS.
  BEGIN
    UPDATE time.schedule_versions SET cycle_days = 5 WHERE model_id = m AND version = 1;
    RAISE EXCEPTION 'version : la réécriture aurait dû être refusée';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  BEGIN
    DELETE FROM time.schedule_version_days WHERE version_id = current_setting('test.ver1')::uuid;
    RAISE EXCEPTION 'jours de cycle : la suppression aurait dû être refusée';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
END $$;

-- ---------- Affectations d'horaires : chevauchement rejeté, close-only ----------
INSERT INTO time.employee_schedules (tenant_id, employee_id, model_id, anchor_date, effective_from)
VALUES (:'tenant_a', :'emp_a', :'model_a', '2026-01-05', '2026-01-05') RETURNING id AS sched1 \gset
SET test.sched1 = :'sched1';

DO $$
DECLARE t uuid := current_setting('test.tenant_a')::uuid;
        e uuid := current_setting('test.emp_a')::uuid;
        m uuid := current_setting('test.model_a')::uuid;
BEGIN
  -- Chevauchement : rejeté par la CONTRAINTE D'EXCLUSION (PostgreSQL, pas l'API).
  BEGIN
    INSERT INTO time.employee_schedules (tenant_id, employee_id, model_id, anchor_date, effective_from)
    VALUES (t, e, m, '2026-03-01', '2026-03-01');
    RAISE EXCEPTION 'affectation : le chevauchement aurait dû être refusé';
  EXCEPTION WHEN exclusion_violation THEN NULL;
  END;
  -- Close-only : changer le modèle sur une ligne existante est interdit.
  BEGIN
    UPDATE time.employee_schedules SET anchor_date = '2026-02-01'
     WHERE id = current_setting('test.sched1')::uuid;
    RAISE EXCEPTION 'affectation : la réécriture aurait dû être refusée (close-only)';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  BEGIN
    DELETE FROM time.employee_schedules WHERE id = current_setting('test.sched1')::uuid;
    RAISE EXCEPTION 'affectation : la suppression aurait dû être refusée';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  -- CHANGEMENT FUTUR PROPRE : clôture puis nouvelle ligne — le passé reste intact.
  UPDATE time.employee_schedules SET effective_to = '2026-06-01'
   WHERE id = current_setting('test.sched1')::uuid;
  INSERT INTO time.employee_schedules (tenant_id, employee_id, model_id, anchor_date, effective_from)
  VALUES (t, e, m, '2026-06-01', '2026-06-01');
  -- FK inter-tenant : salarié du tenant B refusé PAR LA BASE.
  BEGIN
    INSERT INTO time.employee_schedules (tenant_id, employee_id, model_id, anchor_date, effective_from)
    VALUES (t, current_setting('test.emp_b')::uuid, m, '2026-01-01', '2026-01-01');
    RAISE EXCEPTION 'FK inter-tenant : le salarié de B aurait dû être rejeté';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;

-- ---------- Correspondances : un identifiant externe ne traverse JAMAIS les tenants ----------
INSERT INTO time.devices (tenant_id, code, label, kind, site_id)
VALUES (:'tenant_a', 'TM-PTR-1', 'Pointeuse hall', 'clock', :'site_a') RETURNING id AS dev_a \gset
SET test.dev_a = :'dev_a';

DO $$
DECLARE t uuid := current_setting('test.tenant_a')::uuid;
BEGIN
  INSERT INTO time.employee_device_ids (tenant_id, external_id, employee_id)
  VALUES (t, 'BADGE-77', current_setting('test.emp_a')::uuid);
  -- Doublon actif du même identifiant global : refusé.
  BEGIN
    INSERT INTO time.employee_device_ids (tenant_id, external_id, employee_id)
    VALUES (t, 'BADGE-77', current_setting('test.emp_a')::uuid);
    RAISE EXCEPTION 'correspondance : le doublon actif aurait dû être refusé';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  -- Correspondance vers le salarié d'un AUTRE tenant : rejetée PAR LA BASE.
  BEGIN
    INSERT INTO time.employee_device_ids (tenant_id, external_id, employee_id)
    VALUES (t, 'BADGE-B', current_setting('test.emp_b')::uuid);
    RAISE EXCEPTION 'FK inter-tenant : la correspondance vers B aurait dû être rejetée';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;

-- ---------- Registre brut : APPEND-ONLY + idempotence ----------
INSERT INTO time.punch_batches (tenant_id, source, filename, atomic, status, created_by)
VALUES (:'tenant_a', 'csv', 'pointages.csv', true, 'applied', NULL) RETURNING id AS batch_a \gset
SET test.batch_a = :'batch_a';

INSERT INTO time.raw_punches (tenant_id, batch_id, line_no, device_id, external_employee_id, source_datetime_raw, source_tz, event_type_raw, fingerprint)
VALUES (:'tenant_a', :'batch_a', 1, :'dev_a', 'BADGE-77', '2026-07-01 22:03', 'Africa/Porto-Novo', 'E',
        '1111111111111111111111111111111111111111111111111111111111111111') RETURNING id AS raw1 \gset
SET test.raw1 = :'raw1';

DO $$
DECLARE t uuid := current_setting('test.tenant_a')::uuid;
        b uuid := current_setting('test.batch_a')::uuid;
        r uuid := current_setting('test.raw1')::uuid;
        n int;
BEGIN
  -- Un pointage brut ne se MODIFIE jamais.
  BEGIN
    UPDATE time.raw_punches SET external_employee_id = 'AUTRE' WHERE id = r;
    RAISE EXCEPTION 'brut : la modification aurait dû être refusée';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  -- Un pointage brut ne se SUPPRIME jamais.
  BEGIN
    DELETE FROM time.raw_punches WHERE id = r;
    RAISE EXCEPTION 'brut : la suppression aurait dû être refusée';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  -- Rejeu du même événement (même empreinte) : REFUSÉ par l'unicité — l'import
  -- applicatif transforme ce conflit en compteur « dupliqué » (ON CONFLICT DO NOTHING).
  BEGIN
    INSERT INTO time.raw_punches (tenant_id, batch_id, line_no, external_employee_id, source_datetime_raw, fingerprint)
    VALUES (t, b, 2, 'BADGE-77', '2026-07-01 22:03',
            '1111111111111111111111111111111111111111111111111111111111111111');
    RAISE EXCEPTION 'empreinte : le doublon aurait dû être refusé';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  -- ON CONFLICT DO NOTHING : le rejeu idempotent ne crée RIEN.
  INSERT INTO time.raw_punches (tenant_id, batch_id, line_no, external_employee_id, source_datetime_raw, fingerprint)
  VALUES (t, b, 2, 'BADGE-77', '2026-07-01 22:03',
          '1111111111111111111111111111111111111111111111111111111111111111')
  ON CONFLICT (tenant_id, fingerprint) DO NOTHING;
  SELECT count(*) INTO n FROM time.raw_punches WHERE tenant_id = t;
  IF n <> 1 THEN RAISE EXCEPTION 'idempotence : % ligne(s) brute(s), 1 attendue', n; END IF;
  -- Le LOT ne se supprime pas non plus.
  BEGIN
    DELETE FROM time.punch_batches WHERE id = b;
    RAISE EXCEPTION 'lot : la suppression aurait dû être refusée';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
END $$;

-- La MÊME empreinte chez le tenant B reste possible : l'unicité est PAR TENANT.
INSERT INTO time.punch_batches (tenant_id, source, atomic, status) VALUES (:'tenant_b', 'csv', true, 'applied') RETURNING id AS batch_b \gset
INSERT INTO time.raw_punches (tenant_id, batch_id, external_employee_id, source_datetime_raw, fingerprint)
VALUES (:'tenant_b', :'batch_b', 'BADGE-77', '2026-07-01 22:03',
        '1111111111111111111111111111111111111111111111111111111111111111');

-- ---------- Événement normalisé : dérivé 1:1, jamais supprimé, FK inter-tenant ----------
DO $$
DECLARE t uuid := current_setting('test.tenant_a')::uuid;
        r uuid := current_setting('test.raw1')::uuid;
BEGIN
  INSERT INTO time.punch_events (tenant_id, raw_punch_id, employee_id, tz, occurred_at, local_date, local_time, event_type, match_status)
  VALUES (t, r, current_setting('test.emp_a')::uuid, 'Africa/Porto-Novo',
          '2026-07-01 21:03+00', '2026-07-01', '22:03', 'in', 'matched');
  -- 1:1 : un second événement pour le même brut est refusé.
  BEGIN
    INSERT INTO time.punch_events (tenant_id, raw_punch_id, tz, event_type, match_status)
    VALUES (t, r, 'UTC', 'unknown', 'unmatched_employee');
    RAISE EXCEPTION 'normalisé : le doublon 1:1 aurait dû être refusé';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    DELETE FROM time.punch_events WHERE raw_punch_id = r;
    RAISE EXCEPTION 'normalisé : la suppression aurait dû être refusée';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  -- Rattachement au salarié d'un autre tenant : rejeté PAR LA BASE.
  BEGIN
    UPDATE time.punch_events SET employee_id = current_setting('test.emp_b')::uuid WHERE raw_punch_id = r;
    RAISE EXCEPTION 'FK inter-tenant : le salarié de B aurait dû être rejeté (normalisé)';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;

-- ---------- Fériés : versionnés (retrait = statut), unicité par calendrier ----------
INSERT INTO time.holiday_calendars (tenant_id, code, label_fr, label_en)
VALUES (:'tenant_a', 'TM-FERIES', 'Fériés nationaux', 'National holidays') RETURNING id AS cal_a \gset
INSERT INTO time.holidays (tenant_id, calendar_id, holiday_date, label_fr, label_en)
VALUES (:'tenant_a', :'cal_a', '2026-08-01', 'Fête nationale', 'National day');
SET test.cal_a = :'cal_a';
DO $$
DECLARE t uuid := current_setting('test.tenant_a')::uuid;
        c uuid := current_setting('test.cal_a')::uuid;
BEGIN
  BEGIN
    INSERT INTO time.holidays (tenant_id, calendar_id, holiday_date, label_fr, label_en)
    VALUES (t, c, '2026-08-01', 'Doublon', 'Duplicate');
    RAISE EXCEPTION 'férié : le doublon de date aurait dû être refusé';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  -- Un calendrier ne vise qu'UNE portée au plus.
  BEGIN
    INSERT INTO time.holiday_calendars (tenant_id, code, label_fr, label_en, company_id, site_id)
    VALUES (t, 'TM-DOUBLE', 'X', 'X', current_setting('test.co_a')::uuid, current_setting('test.site_a')::uuid);
    RAISE EXCEPTION 'calendrier : la double portée aurait dû être refusée';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- Exception de planning : EXACTEMENT une cible.
  BEGIN
    INSERT INTO time.schedule_exceptions (tenant_id, exception_date, kind, label_fr, label_en)
    VALUES (t, '2026-09-01', 'closed', 'Sans cible', 'No target');
    RAISE EXCEPTION 'exception : l''absence de cible aurait dû être refusée';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO time.schedule_exceptions (tenant_id, exception_date, unit_id, kind, label_fr, label_en)
  VALUES (t, '2026-09-01', current_setting('test.unit_a')::uuid, 'closed', 'Inventaire', 'Inventory');
END $$;

-- ---------- RLS + privilèges du rôle applicatif ----------
\connect :"appurl"
\set QUIET on
SET app.tenant_id = :'tenant_a';
SET test.tenant_b = :'tenant_b';
SET test.raw1 = :'raw1';
SET test.batch_a = :'batch_a';

DO $$
DECLARE n int;
BEGIN
  -- Le tenant A voit SES données…
  SELECT count(*) INTO n FROM time.schedule_models; IF n <> 1 THEN RAISE EXCEPTION 'RLS : modèle A invisible (%)', n; END IF;
  SELECT count(*) INTO n FROM time.raw_punches;     IF n <> 1 THEN RAISE EXCEPTION 'RLS : brut A invisible (%)', n; END IF;
  -- …et RIEN du tenant B (dont le brut à la même empreinte).
  SELECT count(*) INTO n FROM time.raw_punches WHERE tenant_id = current_setting('test.tenant_b')::uuid;
  IF n <> 0 THEN RAISE EXCEPTION 'RLS : le brut de B fuit (%)', n; END IF;
  -- Écrire CHEZ B depuis la session A : rejeté par la POLITIQUE.
  BEGIN
    INSERT INTO time.schedule_models (tenant_id, code, label_fr, label_en, kind)
    VALUES (current_setting('test.tenant_b')::uuid, 'TM-EVIL', 'X', 'X', 'fixed');
    RAISE EXCEPTION 'RLS : l''écriture chez B aurait dû être refusée';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN NULL;
  END;
  -- Le rôle applicatif n'a AUCUN droit de modification du brut (privilège retiré).
  BEGIN
    UPDATE time.raw_punches SET line_no = 99 WHERE id = current_setting('test.raw1')::uuid;
    RAISE EXCEPTION 'privilèges : UPDATE brut aurait dû être refusé au rôle applicatif';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM time.raw_punches WHERE id = current_setting('test.raw1')::uuid;
    RAISE EXCEPTION 'privilèges : DELETE brut aurait dû être refusé au rôle applicatif';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM time.punch_batches WHERE id = current_setting('test.batch_a')::uuid;
    RAISE EXCEPTION 'privilèges : DELETE lot aurait dû être refusé au rôle applicatif';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM time.schedule_versions WHERE true;
    RAISE EXCEPTION 'privilèges : DELETE versions aurait dû être refusé au rôle applicatif';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

SELECT 'OK 95_time_e10_1' AS resultat;
