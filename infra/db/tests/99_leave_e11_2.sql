-- TEST 99 — Congés E11.2 : demandes ESS. Ce que PostgreSQL garantit SEUL :
-- machine à états des demandes (transitions contrôlées par trigger), contenu FIGÉ
-- après soumission (versions immuables, brouillon verrouillé), événements et journal
-- de consultation append-only, absences approuvées SANS chevauchement (EXCLUSION),
-- application idempotente PAR LA BASE (une absence par version), justificatifs figés,
-- lien ledger↔demande inter-tenant rejeté, demande pour tiers motivée (CHECK),
-- RLS étanche, aucun DELETE pour le rôle applicatif.
\set QUIET on
\set appurl `echo "$DATABASE_URL_APP"`

DO $$
BEGIN
  IF (SELECT count(*) FROM admin.permissions WHERE key IN
      ('leave.request_self','leave.request_for_others','leave.requests_view_own',
       'leave.requests_view_team','leave.requests_admin','leave.attachments_verify',
       'leave.calendar_view','leave.calendar_export','leave.request_cancel_approved',
       'leave.request_retroactive')) <> 10 THEN
    RAISE EXCEPTION 'permissions E11.2 incomplètes au catalogue';
  END IF;
END $$;

-- ---------- Fixtures (migrator) ----------
SELECT substr(md5(random()::text), 1, 8) AS rid \gset
INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('test-lr-a-' || :'rid', 'LR A', true) RETURNING id AS tenant_a \gset
INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('test-lr-b-' || :'rid', 'LR B', true) RETURNING id AS tenant_b \gset
INSERT INTO core.employees (tenant_id, matricule, first_name, last_name, status, hire_date)
VALUES (:'tenant_a', 'LR-0001', 'Awa', 'Sossou', 'active', '2025-01-01') RETURNING id AS emp_a \gset
INSERT INTO core.employees (tenant_id, matricule, first_name, last_name, status, hire_date)
VALUES (:'tenant_a', 'LR-0002', 'Sena', 'Dossou', 'active', '2025-01-01') RETURNING id AS emp_a2 \gset
INSERT INTO core.employees (tenant_id, matricule, first_name, last_name, status, hire_date)
VALUES (:'tenant_b', 'LR-B001', 'Bio', 'Kassim', 'active', '2025-01-01') RETURNING id AS emp_b \gset
INSERT INTO admin.users (tenant_id, email, password_hash)
VALUES (:'tenant_a', 'lr-' || :'rid' || '@t.bj', 'x') RETURNING id AS user_a \gset

INSERT INTO leave.absence_types (tenant_id, code, label_fr, label_en, category, paid, unit, created_by, status)
VALUES (:'tenant_a', 'CAP', 'Congé annuel payé', 'Paid annual leave', 'legal', true, 'open_days', :'user_a', 'active')
RETURNING id AS type_a \gset
INSERT INTO leave.absence_types (tenant_id, code, label_fr, label_en, category, paid, unit, created_by, status)
VALUES (:'tenant_b', 'CAP', 'Congé annuel payé', 'Paid annual leave', 'legal', true, 'open_days', :'user_a', 'active')
RETURNING id AS type_bt \gset

INSERT INTO leave.requests (tenant_id, employee_id, absence_type_id, created_by, draft_payload)
VALUES (:'tenant_a', :'emp_a', :'type_a', :'user_a', '{"startDate":"2026-09-07","endDate":"2026-09-11"}')
RETURNING id AS req_1 \gset
INSERT INTO leave.requests (tenant_id, employee_id, absence_type_id, created_by)
VALUES (:'tenant_b', :'emp_b', :'type_bt', :'user_a')
RETURNING id AS req_b \gset

SET test.tenant_a = :'tenant_a';
SET test.tenant_b = :'tenant_b';
SET test.emp_a  = :'emp_a';
SET test.emp_a2 = :'emp_a2';
SET test.emp_b  = :'emp_b';
SET test.user_a = :'user_a';
SET test.type_a = :'type_a';
SET test.type_bt = :'type_bt';
SET test.req_1  = :'req_1';
SET test.req_b  = :'req_b';

-- ---------- Machine à états : transitions contrôlées, brouillon verrouillé ----------
DO $$
DECLARE r uuid := current_setting('test.req_1')::uuid;
BEGIN
  -- draft → applied : transition INTERDITE (aucun raccourci vers l'application).
  BEGIN
    UPDATE leave.requests SET status = 'applied' WHERE id = r;
    RAISE EXCEPTION 'transition draft→applied acceptée';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%draft→applied acceptée%' THEN RAISE; END IF;
  END;
  -- draft → submitted : autorisée (avec version posée par ailleurs).
  UPDATE leave.requests SET status = 'submitted', current_version = 1 WHERE id = r;
  -- Brouillon FIGÉ après soumission.
  BEGIN
    UPDATE leave.requests SET draft_payload = '{"startDate":"2026-09-08"}' WHERE id = r;
    RAISE EXCEPTION 'brouillon modifié après soumission';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%brouillon modifié%' THEN RAISE; END IF;
  END;
  -- Identité immuable (salarié).
  BEGIN
    UPDATE leave.requests SET employee_id = current_setting('test.emp_a2')::uuid WHERE id = r;
    RAISE EXCEPTION 'salarié changé sur demande existante';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%salarié changé%' THEN RAISE; END IF;
  END;
  -- Le numéro de version ne régresse jamais.
  BEGIN
    UPDATE leave.requests SET current_version = 0 WHERE id = r;
    RAISE EXCEPTION 'version régressée';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%version régressée%' THEN RAISE; END IF;
  END;
  -- Suppression : jamais.
  BEGIN
    DELETE FROM leave.requests WHERE id = r;
    RAISE EXCEPTION 'demande supprimée';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%demande supprimée%' THEN RAISE; END IF;
  END;
END $$;

-- Demande pour tiers : motif + permission OBLIGATOIRES (CHECK on_behalf_shape).
DO $$
DECLARE t uuid := current_setting('test.tenant_a')::uuid;
        e uuid := current_setting('test.emp_a2')::uuid;
        ty uuid := current_setting('test.type_a')::uuid;
        u uuid := current_setting('test.user_a')::uuid;
BEGIN
  BEGIN
    INSERT INTO leave.requests (tenant_id, employee_id, absence_type_id, created_by, on_behalf, source)
    VALUES (t, e, ty, u, true, 'manager');
    RAISE EXCEPTION 'demande pour tiers sans motif acceptée';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- ---------- Versions soumises : IMMUABLES ----------
INSERT INTO leave.request_versions (tenant_id, request_id, version, start_date, end_date,
  quantity, unit, created_by)
VALUES (:'tenant_a', :'req_1', 1, '2026-09-07', '2026-09-11', 5, 'open_days', :'user_a')
RETURNING id AS ver_1 \gset
SET test.ver_1 = :'ver_1';

DO $$
DECLARE v uuid := current_setting('test.ver_1')::uuid;
BEGIN
  BEGIN
    UPDATE leave.request_versions SET quantity = 4 WHERE id = v;
    RAISE EXCEPTION 'version de demande modifiée';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%version de demande modifiée%' THEN RAISE; END IF;
  END;
  BEGIN
    DELETE FROM leave.request_versions WHERE id = v;
    RAISE EXCEPTION 'version de demande supprimée';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%version de demande supprimée%' THEN RAISE; END IF;
  END;
  -- Un volume d'heures explicite exige UNE seule journée (CHECK).
  BEGIN
    INSERT INTO leave.request_versions (tenant_id, request_id, version, start_date, end_date,
      hours_requested, quantity, unit, created_by)
    VALUES (current_setting('test.tenant_a')::uuid, current_setting('test.req_1')::uuid, 2,
            '2026-10-01', '2026-10-02', 4, 4, 'hours', current_setting('test.user_a')::uuid);
    RAISE EXCEPTION 'heures sur plusieurs jours acceptées';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- ---------- Événements : append-only ----------
INSERT INTO leave.request_events (tenant_id, request_id, version, event, actor_user_id)
VALUES (:'tenant_a', :'req_1', 1, 'submitted', :'user_a');
DO $$
BEGIN
  BEGIN
    UPDATE leave.request_events SET event = 'approved' WHERE true;
    RAISE EXCEPTION 'événement de demande réécrit';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%événement de demande réécrit%' THEN RAISE; END IF;
  END;
  BEGIN
    DELETE FROM leave.request_events WHERE true;
    RAISE EXCEPTION 'événement de demande supprimé';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%événement de demande supprimé%' THEN RAISE; END IF;
  END;
END $$;

-- ---------- Absences approuvées : JAMAIS de chevauchement, application idempotente ----------
INSERT INTO leave.absences (tenant_id, employee_id, absence_type_id, request_id, request_version,
  start_date, end_date, quantity, unit, applied_by)
VALUES (:'tenant_a', :'emp_a', :'type_a', :'req_1', 1, '2026-09-07', '2026-09-11', 5, 'open_days', :'user_a')
RETURNING id AS abs_1 \gset
SET test.abs_1 = :'abs_1';

DO $$
DECLARE t uuid := current_setting('test.tenant_a')::uuid;
        e uuid := current_setting('test.emp_a')::uuid;
        e2 uuid := current_setting('test.emp_a2')::uuid;
        ty uuid := current_setting('test.type_a')::uuid;
        r uuid := current_setting('test.req_1')::uuid;
        u uuid := current_setting('test.user_a')::uuid;
        a uuid := current_setting('test.abs_1')::uuid;
BEGIN
  -- Chevauchement pour le MÊME salarié ⇒ EXCLUSION PostgreSQL.
  BEGIN
    INSERT INTO leave.absences (tenant_id, employee_id, absence_type_id, request_id, request_version,
      start_date, end_date, quantity, unit, applied_by)
    VALUES (t, e, ty, r, 7, '2026-09-10', '2026-09-14', 3, 'open_days', u);
    RAISE EXCEPTION 'deux absences approuvées se chevauchent';
  EXCEPTION WHEN exclusion_violation THEN NULL;
  END;
  -- Même période pour un AUTRE salarié : évidemment permise.
  INSERT INTO leave.absences (tenant_id, employee_id, absence_type_id, request_id, request_version,
    start_date, end_date, quantity, unit, applied_by)
  VALUES (t, e2, ty, r, 8, '2026-09-07', '2026-09-11', 5, 'open_days', u);
  -- MÊME demande + MÊME version ⇒ UNIQUE : l'application est idempotente PAR LA BASE.
  BEGIN
    INSERT INTO leave.absences (tenant_id, employee_id, absence_type_id, request_id, request_version,
      start_date, end_date, quantity, unit, applied_by)
    VALUES (t, e, ty, r, 1, '2026-11-02', '2026-11-06', 5, 'open_days', u);
    RAISE EXCEPTION 'double application de la même version';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  -- Contenu FIGÉ : la quantité d'une absence ne se retouche pas.
  BEGIN
    UPDATE leave.absences SET quantity = 4 WHERE id = a;
    RAISE EXCEPTION 'absence approuvée retouchée';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%absence approuvée retouchée%' THEN RAISE; END IF;
  END;
  -- Annulation SANS motif : refusée.
  BEGIN
    UPDATE leave.absences SET status = 'cancelled', cancelled_at = now(), cancelled_by = u WHERE id = a;
    RAISE EXCEPTION 'annulation sans motif acceptée';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%annulation sans motif acceptée%' THEN RAISE; END IF;
  END;
  -- Annulation MOTIVÉE : acceptée, et l'exclusion ne bloque plus la période.
  UPDATE leave.absences
     SET status = 'cancelled', cancelled_at = now(), cancelled_by = u, cancel_reason = 'annulation motivée (test)'
   WHERE id = a;
  INSERT INTO leave.absences (tenant_id, employee_id, absence_type_id, request_id, request_version,
    start_date, end_date, quantity, unit, applied_by)
  VALUES (t, e, ty, r, 2, '2026-09-09', '2026-09-11', 3, 'open_days', u);
  -- Suppression : jamais.
  BEGIN
    DELETE FROM leave.absences WHERE id = a;
    RAISE EXCEPTION 'absence supprimée';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%absence supprimée%' THEN RAISE; END IF;
  END;
END $$;

-- ---------- Justificatifs : contenu figé, vérification seule mutable, journal append-only ----------
INSERT INTO leave.request_attachments (tenant_id, request_id, filename, mime, byte_size, sha256, sensitive, content, uploaded_by)
VALUES (:'tenant_a', :'req_1', 'certificat.pdf', 'application/pdf', 4, repeat('a', 64), true, '\x25504446'::bytea, :'user_a')
RETURNING id AS att_1 \gset
SET test.att_1 = :'att_1';

DO $$
DECLARE a uuid := current_setting('test.att_1')::uuid;
        u uuid := current_setting('test.user_a')::uuid;
BEGIN
  -- Vérification : mutation PERMISE (statut seul).
  UPDATE leave.request_attachments
     SET verified_status = 'accepted', verified_by = u, verified_at = now() WHERE id = a;
  -- Contenu : FIGÉ.
  BEGIN
    UPDATE leave.request_attachments SET content = '\x00'::bytea WHERE id = a;
    RAISE EXCEPTION 'contenu de justificatif réécrit';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%contenu de justificatif réécrit%' THEN RAISE; END IF;
  END;
  BEGIN
    DELETE FROM leave.request_attachments WHERE id = a;
    RAISE EXCEPTION 'justificatif supprimé';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%justificatif supprimé%' THEN RAISE; END IF;
  END;
  -- Journal de consultation : append-only.
  INSERT INTO leave.attachment_access_log (tenant_id, attachment_id, viewed_by)
  VALUES (current_setting('test.tenant_a')::uuid, a, u);
  BEGIN
    DELETE FROM leave.attachment_access_log WHERE attachment_id = a;
    RAISE EXCEPTION 'journal de consultation purgé';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%journal de consultation purgé%' THEN RAISE; END IF;
  END;
END $$;

-- ---------- Inter-tenant : le ledger ne référence JAMAIS la demande d'un autre tenant ----------
DO $$
DECLARE ta uuid := current_setting('test.tenant_a')::uuid;
        e uuid := current_setting('test.emp_a')::uuid;
        ty uuid := current_setting('test.type_a')::uuid;
        rb uuid := current_setting('test.req_b')::uuid;
BEGIN
  BEGIN
    INSERT INTO leave.entitlement_ledger (tenant_id, employee_id, absence_type_id,
      reference_period_start, reference_period_end, entry_kind, quantity, unit,
      effective_on, origin, idempotency_key, request_id, request_version)
    VALUES (ta, e, ty, '2026-01-01', '2026-12-31', 'reservation', 5, 'open_days',
            '2026-09-07', 'workflow', 'reserve:xt:' || rb, rb, 1);
    RAISE EXCEPTION 'réservation liée à la demande d''un AUTRE tenant';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  -- Lien LÉGITIME : accepté.
  INSERT INTO leave.entitlement_ledger (tenant_id, employee_id, absence_type_id,
    reference_period_start, reference_period_end, entry_kind, quantity, unit,
    effective_on, origin, idempotency_key, request_id, request_version)
  VALUES (ta, e, ty, '2026-01-01', '2026-12-31', 'reservation', 5, 'open_days',
          '2026-09-07', 'workflow', 'reserve:ok:' || current_setting('test.req_1'),
          current_setting('test.req_1')::uuid, 1);
END $$;

-- Demande inter-tenant directe : FK composite rejetée.
DO $$
DECLARE ta uuid := current_setting('test.tenant_a')::uuid;
        eb uuid := current_setting('test.emp_b')::uuid;
        ty uuid := current_setting('test.type_a')::uuid;
        u uuid := current_setting('test.user_a')::uuid;
BEGIN
  BEGIN
    INSERT INTO leave.requests (tenant_id, employee_id, absence_type_id, created_by)
    VALUES (ta, eb, ty, u);
    RAISE EXCEPTION 'demande créée pour le salarié d''un AUTRE tenant';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;

-- ---------- RLS + privilèges du rôle applicatif ----------
\connect :appurl
SET app.tenant_id = '';
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM leave.requests;
  IF n <> 0 THEN RAISE EXCEPTION 'RLS : demandes lisibles sans contexte tenant (%)', n; END IF;
  SELECT count(*) INTO n FROM leave.absences;
  IF n <> 0 THEN RAISE EXCEPTION 'RLS : absences lisibles sans contexte tenant (%)', n; END IF;
  SELECT count(*) INTO n FROM leave.request_attachments;
  IF n <> 0 THEN RAISE EXCEPTION 'RLS : justificatifs lisibles sans contexte tenant (%)', n; END IF;
END $$;

DO $$
BEGIN
  BEGIN
    DELETE FROM leave.requests WHERE true;
    RAISE EXCEPTION 'DELETE demandes autorisé au rôle applicatif';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE leave.request_versions SET quantity = 0 WHERE true;
    RAISE EXCEPTION 'UPDATE versions de demande autorisé au rôle applicatif';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM leave.request_events WHERE true;
    RAISE EXCEPTION 'DELETE événements autorisé au rôle applicatif';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM leave.absences WHERE true;
    RAISE EXCEPTION 'DELETE absences autorisé au rôle applicatif';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE leave.attachment_access_log SET viewed_by = viewed_by WHERE true;
    RAISE EXCEPTION 'UPDATE journal de consultation autorisé au rôle applicatif';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

SELECT 'OK 99 — E11.2 : demandes figées, absences sans chevauchement, application idempotente, journaux append-only' AS resultat;
