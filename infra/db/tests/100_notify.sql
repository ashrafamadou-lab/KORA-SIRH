-- TEST 100 — Notification Engine : modèles versionnés, idempotence, machine à états,
-- journal de tentatives append-only sans contenu, préférences bornées, isolation tenant.
\set QUIET on
\set appurl `echo "$DATABASE_URL_APP"`

-- ---------- Assertions catalogue (migrator) ----------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin.permissions WHERE key = 'notify.manage') THEN
    RAISE EXCEPTION 'permission notify.manage absente du catalogue';
  END IF;
END $$;

-- ---------- Fixtures (migrator) ----------
SELECT substr(md5(random()::text), 1, 8) AS rid \gset
INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('test-ntf-a-' || :'rid', 'NTF A', true) RETURNING id AS tenant_a \gset
INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('test-ntf-b-' || :'rid', 'NTF B', true) RETURNING id AS tenant_b \gset
INSERT INTO admin.users (tenant_id, email) VALUES (:'tenant_a', 'ntf-u1-' || :'rid' || '@test.bj') RETURNING id AS user_a \gset

-- users.locale : contrainte fr/en.
SET test.user_a = :'user_a';
DO $$
BEGIN
  BEGIN
    UPDATE admin.users SET locale = 'xx' WHERE id = current_setting('test.user_a')::uuid;
    RAISE EXCEPTION 'locale : « xx » aurait dû être refusée';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE admin.users SET locale = 'en' WHERE id = current_setting('test.user_a')::uuid;
  UPDATE admin.users SET locale = 'fr' WHERE id = current_setting('test.user_a')::uuid;
END $$;

\connect :"appurl"
\set QUIET on
SET app.tenant_id = :'tenant_a';
SET test.tenant_a = :'tenant_a';
SET test.tenant_b = :'tenant_b';
SET test.user_a = :'user_a';

-- ---------- Modèles : cycle de vie et immuabilité ----------
INSERT INTO notify.templates (tenant_id, key, version, name, subject_fr, subject_en, body_fr, body_en, variables, channels)
VALUES (:'tenant_a', 'test.bienvenue', 1, 'Bienvenue', 'Bienvenue {{prenom}}', 'Welcome {{prenom}}',
        'Bonjour {{prenom}}.', 'Hello {{prenom}}.', '["prenom"]', '["in_app","email"]')
RETURNING id AS tpl1 \gset
SET test.tpl1 = :'tpl1';

-- Un modèle sans in_app est refusé (le feed est le socle).
DO $$
BEGIN
  BEGIN
    INSERT INTO notify.templates (tenant_id, key, version, name, subject_fr, subject_en, body_fr, body_en, channels)
    VALUES (current_setting('test.tenant_a')::uuid, 'test.sans_socle', 1, 'X', 's', 's', 'b', 'b', '["email"]');
    RAISE EXCEPTION 'canaux : un modèle sans in_app aurait dû être refusé';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

UPDATE notify.templates SET status = 'active', activated_at = now() WHERE id = :'tpl1';

-- Contenu figé hors draft.
DO $$
BEGIN
  BEGIN
    UPDATE notify.templates SET body_fr = 'Altéré' WHERE id = current_setting('test.tpl1')::uuid;
    RAISE EXCEPTION 'immuabilité : la modification d''un modèle actif aurait dû être refusée';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  BEGIN
    UPDATE notify.templates SET status = 'draft' WHERE id = current_setting('test.tpl1')::uuid;
    RAISE EXCEPTION 'régression de statut active->draft aurait dû être refusée';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
END $$;

-- Une seule version active par (tenant, clé).
INSERT INTO notify.templates (tenant_id, key, version, name, subject_fr, subject_en, body_fr, body_en, variables, channels)
VALUES (:'tenant_a', 'test.bienvenue', 2, 'Bienvenue v2', 'Bienvenue {{prenom}}', 'Welcome {{prenom}}',
        'Bonjour {{prenom}} !', 'Hello {{prenom}}!', '["prenom"]', '["in_app","email"]')
RETURNING id AS tpl2 \gset
SET test.tpl2 = :'tpl2';
DO $$
BEGIN
  BEGIN
    UPDATE notify.templates SET status = 'active', activated_at = now() WHERE id = current_setting('test.tpl2')::uuid;
    RAISE EXCEPTION 'deux versions actives simultanées auraient dû être refusées';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;
UPDATE notify.templates SET status = 'superseded' WHERE id = :'tpl1';
UPDATE notify.templates SET status = 'active', activated_at = now() WHERE id = :'tpl2';

-- ---------- Événements : idempotence + append-only ----------
INSERT INTO notify.events (tenant_id, event_key, template_key, template_version, payload)
VALUES (:'tenant_a', 'test.evt.' || :'rid', 'test.bienvenue', 2, '{"prenom":"Awa"}')
RETURNING id AS evt \gset
SET test.evt = :'evt';
SELECT set_config('test.evtkey', 'test.evt.' || :'rid', false) \gset _
DO $$
BEGIN
  BEGIN
    INSERT INTO notify.events (tenant_id, event_key, template_key, template_version)
    VALUES (current_setting('test.tenant_a')::uuid, current_setting('test.evtkey'), 'test.bienvenue', 2);
    RAISE EXCEPTION 'idempotence : le même event_key aurait dû être refusé';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;
DO $$
BEGIN
  BEGIN
    UPDATE notify.events SET payload = '{"prenom":"Falsifié"}' WHERE id = current_setting('test.evt')::uuid;
    RAISE EXCEPTION 'append-only : UPDATE d''un événement aurait dû être refusé';
  EXCEPTION WHEN insufficient_privilege OR raise_exception THEN NULL;
  END;
  BEGIN
    DELETE FROM notify.events WHERE id = current_setting('test.evt')::uuid;
    RAISE EXCEPTION 'append-only : DELETE d''un événement aurait dû être refusé';
  EXCEPTION WHEN insufficient_privilege OR raise_exception THEN NULL;
  END;
END $$;

-- ---------- Notifications : une par (événement, destinataire), contenu figé ----------
INSERT INTO notify.notifications (tenant_id, event_id, user_id, template_key, template_version, locale, subject, body)
VALUES (:'tenant_a', :'evt', :'user_a', 'test.bienvenue', 2, 'fr', 'Bienvenue Awa', 'Bonjour Awa !')
RETURNING id AS notif \gset
SET test.notif = :'notif';
DO $$
BEGIN
  BEGIN
    INSERT INTO notify.notifications (tenant_id, event_id, user_id, template_key, template_version, locale, subject, body)
    VALUES (current_setting('test.tenant_a')::uuid, current_setting('test.evt')::uuid,
            current_setting('test.user_a')::uuid, 'test.bienvenue', 2, 'fr', 'Doublon', 'Doublon');
    RAISE EXCEPTION 'idempotence : une 2e notification (événement, destinataire) aurait dû être refusée';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    UPDATE notify.notifications SET subject = 'Falsifié' WHERE id = current_setting('test.notif')::uuid;
    RAISE EXCEPTION 'contenu rendu : la modification du sujet aurait dû être refusée';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  -- Lu / archivé : les seules évolutions permises.
  UPDATE notify.notifications SET read_at = now() WHERE id = current_setting('test.notif')::uuid;
  UPDATE notify.notifications SET archived_at = now() WHERE id = current_setting('test.notif')::uuid;
END $$;

-- ---------- Livraisons : machine à états ----------
INSERT INTO notify.deliveries (tenant_id, notification_id, channel, status, max_attempts, next_attempt_at)
VALUES (:'tenant_a', :'notif', 'email', 'pending', 3, now())
RETURNING id AS dlv \gset
SET test.dlv = :'dlv';
DO $$
DECLARE d uuid := current_setting('test.dlv')::uuid;
BEGIN
  -- Saut d'état interdit : pending -> sent sans passer par processing.
  BEGIN
    UPDATE notify.deliveries SET status = 'sent', sent_at = now() WHERE id = d;
    RAISE EXCEPTION 'machine à états : pending->sent direct aurait dû être refusé';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  -- Parcours d'échec : pending -> processing -> failed -> processing -> dead_letter.
  UPDATE notify.deliveries SET status = 'processing' WHERE id = d;
  UPDATE notify.deliveries SET status = 'failed', attempt_count = 1, next_attempt_at = now() WHERE id = d;
  UPDATE notify.deliveries SET status = 'processing' WHERE id = d;
  UPDATE notify.deliveries SET status = 'dead_letter', attempt_count = 2, next_attempt_at = NULL WHERE id = d;
  -- Requeue admin : dead_letter -> pending, puis annulation : pending -> cancelled -> pending.
  UPDATE notify.deliveries SET status = 'pending', attempt_count = 0, next_attempt_at = now() WHERE id = d;
  UPDATE notify.deliveries SET status = 'cancelled' WHERE id = d;
  UPDATE notify.deliveries SET status = 'pending', next_attempt_at = now() WHERE id = d;
  -- Parcours nominal : processing -> sent, puis TERMINAL.
  UPDATE notify.deliveries SET status = 'processing' WHERE id = d;
  UPDATE notify.deliveries SET status = 'sent', sent_at = now() WHERE id = d;
  BEGIN
    UPDATE notify.deliveries SET status = 'pending' WHERE id = d;
    RAISE EXCEPTION 'machine à états : sent est terminal, sent->pending aurait dû être refusé';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  -- Identité immuable : changer le canal est interdit.
  BEGIN
    UPDATE notify.deliveries SET channel = 'sms' WHERE id = d;
    RAISE EXCEPTION 'identité : le canal d''une livraison aurait dû être immuable';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
END $$;

-- ---------- Tentatives : append-only, sans contenu ----------
INSERT INTO notify.delivery_attempts (tenant_id, delivery_id, attempt_no, channel, transport, outcome, error_code, error_message)
VALUES (:'tenant_a', :'dlv', 1, 'email', 'simulated', 'failed', 'SIM_FAIL', 'échec simulé (assaini)');
DO $$
BEGIN
  BEGIN
    UPDATE notify.delivery_attempts SET error_message = 'falsifié' WHERE delivery_id = current_setting('test.dlv')::uuid;
    RAISE EXCEPTION 'append-only : UPDATE d''une tentative aurait dû être refusé';
  EXCEPTION WHEN insufficient_privilege OR raise_exception THEN NULL;
  END;
  BEGIN
    DELETE FROM notify.delivery_attempts WHERE delivery_id = current_setting('test.dlv')::uuid;
    RAISE EXCEPTION 'append-only : DELETE d''une tentative aurait dû être refusé';
  EXCEPTION WHEN insufficient_privilege OR raise_exception THEN NULL;
  END;
END $$;

-- ---------- Préférences : seuls les canaux sortants sont désactivables ----------
INSERT INTO notify.preferences (tenant_id, user_id, channel, enabled)
VALUES (:'tenant_a', :'user_a', 'email', false);
DO $$
BEGIN
  BEGIN
    INSERT INTO notify.preferences (tenant_id, user_id, channel, enabled)
    VALUES (current_setting('test.tenant_a')::uuid, current_setting('test.user_a')::uuid, 'in_app', false);
    RAISE EXCEPTION 'préférences : désactiver in_app aurait dû être refusé (socle)';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- ---------- Isolation : le tenant B ne voit RIEN de A ----------
SET app.tenant_id = :'tenant_b';
DO $$
DECLARE nt int; ne int; nn int; nd int; na int; np int;
BEGIN
  SELECT count(*) INTO nt FROM notify.templates;
  SELECT count(*) INTO ne FROM notify.events;
  SELECT count(*) INTO nn FROM notify.notifications;
  SELECT count(*) INTO nd FROM notify.deliveries;
  SELECT count(*) INTO na FROM notify.delivery_attempts;
  SELECT count(*) INTO np FROM notify.preferences;
  IF nt + ne + nn + nd + na + np <> 0 THEN
    RAISE EXCEPTION 'isolation : B voit % modèles, % événements, % notifications, % livraisons, % tentatives, % préférences de A',
      nt, ne, nn, nd, na, np;
  END IF;
END $$;

-- B ne peut pas écrire une ligne rattachée au tenant A (RLS WITH CHECK).
DO $$
BEGIN
  BEGIN
    INSERT INTO notify.templates (tenant_id, key, version, name, subject_fr, subject_en, body_fr, body_en)
    VALUES (current_setting('test.tenant_a')::uuid, 'test.intrusion', 1, 'X', 's', 's', 'b', 'b');
    RAISE EXCEPTION 'isolation écriture : B a pu créer un modèle chez A';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO notify.delivery_attempts (tenant_id, delivery_id, attempt_no, channel, transport, outcome)
    VALUES (current_setting('test.tenant_a')::uuid, current_setting('test.dlv')::uuid, 2, 'email', 'simulated', 'failed');
    RAISE EXCEPTION 'isolation écriture : B a pu journaliser une tentative chez A';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
