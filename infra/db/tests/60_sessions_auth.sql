-- TEST 60 — Auth : sessions bornées au tenant, resolve_tenant, unicité des empreintes
\set QUIET on
\set appurl `echo "$DATABASE_URL_APP"`

-- ---------- Fixtures (migrator) ----------
SELECT substr(md5(random()::text), 1, 8) AS rid \gset
INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('test-ses-a-' || :'rid', 'Test SES A', true) RETURNING id AS tenant_a \gset
INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('test-ses-b-' || :'rid', 'Test SES B', true) RETURNING id AS tenant_b \gset
INSERT INTO admin.users (tenant_id, email, password_hash) VALUES (:'tenant_a', 'a@test.local', 'x') RETURNING id AS user_a \gset
INSERT INTO admin.users (tenant_id, email, password_hash) VALUES (:'tenant_b', 'b@test.local', 'x') RETURNING id AS user_b \gset

-- ---------- Assertions (kora_app) ----------
\connect :"appurl"
\set QUIET on

-- resolve_tenant fonctionne SANS contexte tenant (c'est son rôle au login)…
SELECT admin.resolve_tenant('test-ses-a-' || :'rid') AS resolved_a \gset
DO $$ BEGIN
  IF current_setting('app.tenant_id', true) IS NOT NULL AND current_setting('app.tenant_id', true) <> '' THEN
    RAISE EXCEPTION 'précondition : aucun contexte tenant attendu';
  END IF;
END $$;
SET test.tenant_a = :'tenant_a';
SET test.resolved_a = :'resolved_a';
DO $$ BEGIN
  IF current_setting('test.resolved_a')::uuid <> current_setting('test.tenant_a')::uuid THEN
    RAISE EXCEPTION 'resolve_tenant : id résolu incorrect';
  END IF;
END $$;
-- … mais un slug inconnu ne révèle rien.
DO $$ BEGIN
  IF admin.resolve_tenant('slug-inexistant-xyz') IS NOT NULL THEN
    RAISE EXCEPTION 'resolve_tenant : un slug inconnu doit rendre NULL';
  END IF;
END $$;

-- Sessions : création dans son tenant, invisibilité inter-tenant, WITH CHECK.
SET app.tenant_id = :'tenant_a';
SET test.user_a = :'user_a';
SET test.tenant_b = :'tenant_b';
SET test.user_b = :'user_b';
INSERT INTO admin.sessions (tenant_id, user_id, token_hash, expires_at)
VALUES (:'tenant_a', :'user_a', 'hash-a-' || :'rid', now() + interval '12 hours');

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM admin.sessions;
  IF n <> 1 THEN RAISE EXCEPTION 'sessions : attendu 1 visible pour A, obtenu %', n; END IF;
  BEGIN
    INSERT INTO admin.sessions (tenant_id, user_id, token_hash, expires_at)
    VALUES (current_setting('test.tenant_b')::uuid, current_setting('test.user_b')::uuid,
            'hash-intrus', now() + interval '1 hour');
    RAISE EXCEPTION 'sessions : insertion inter-tenant aurait dû être refusée';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

-- Unicité de l'empreinte de jeton.
SET test.rid = :'rid';
DO $$
BEGIN
  BEGIN
    INSERT INTO admin.sessions (tenant_id, user_id, token_hash, expires_at)
    VALUES (admin.current_tenant_id(), current_setting('test.user_a')::uuid,
            'hash-a-' || current_setting('test.rid'), now() + interval '1 hour');
    RAISE EXCEPTION 'sessions : token_hash dupliqué aurait dû être refusé';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;

-- Champs de verrouillage modifiables par l'application (flux login).
DO $$
DECLARE n int;
BEGIN
  UPDATE admin.users
     SET failed_login_count = failed_login_count + 1,
         locked_until = now() + interval '30 seconds'
   WHERE id = current_setting('test.user_a')::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'users : mise à jour lockout attendue sur 1 ligne, obtenu %', n; END IF;
  -- et invisibles/inatteignables hors tenant :
  UPDATE admin.users SET failed_login_count = 99
   WHERE id = current_setting('test.user_b')::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'users : le compte du tenant B a été modifié depuis A'; END IF;
END $$;
