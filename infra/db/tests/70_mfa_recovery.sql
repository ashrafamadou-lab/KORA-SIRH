-- TEST 70 — Codes de récupération MFA : isolation, unicité, usage unique, rotation
\set QUIET on
\set appurl `echo "$DATABASE_URL_APP"`

-- ---------- Fixtures (migrator) ----------
SELECT substr(md5(random()::text), 1, 8) AS rid \gset
INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('test-mfa-a-' || :'rid', 'Test MFA A', true) RETURNING id AS tenant_a \gset
INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('test-mfa-b-' || :'rid', 'Test MFA B', true) RETURNING id AS tenant_b \gset
INSERT INTO admin.users (tenant_id, email, password_hash) VALUES (:'tenant_a', 'mfa-a@test.local', 'x') RETURNING id AS user_a \gset
INSERT INTO admin.users (tenant_id, email, password_hash) VALUES (:'tenant_b', 'mfa-b@test.local', 'x') RETURNING id AS user_b \gset

-- ---------- Assertions (kora_app, tenant A) ----------
\connect :"appurl"
\set QUIET on
SET app.tenant_id = :'tenant_a';
SET test.user_a = :'user_a';
SET test.tenant_b = :'tenant_b';
SET test.user_b = :'user_b';

INSERT INTO admin.mfa_recovery_codes (tenant_id, user_id, code_hash) VALUES
  (:'tenant_a', :'user_a', 'hash-1-' || :'rid'),
  (:'tenant_a', :'user_a', 'hash-2-' || :'rid');

-- Unicité (user_id, code_hash).
SET test.rid = :'rid';
DO $$
BEGIN
  BEGIN
    INSERT INTO admin.mfa_recovery_codes (tenant_id, user_id, code_hash)
    VALUES (admin.current_tenant_id(), current_setting('test.user_a')::uuid,
            'hash-1-' || current_setting('test.rid'));
    RAISE EXCEPTION 'unicité code_hash : doublon aurait dû être rejeté';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;

-- Écriture inter-tenant refusée.
DO $$
BEGIN
  BEGIN
    INSERT INTO admin.mfa_recovery_codes (tenant_id, user_id, code_hash)
    VALUES (current_setting('test.tenant_b')::uuid, current_setting('test.user_b')::uuid, 'intrus');
    RAISE EXCEPTION 'RLS : insertion inter-tenant aurait dû être refusée';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

-- Consommation à usage unique : UPDATE atomique conditionné à used_at IS NULL.
DO $$
DECLARE n int;
BEGIN
  UPDATE admin.mfa_recovery_codes SET used_at = now()
   WHERE user_id = current_setting('test.user_a')::uuid
     AND code_hash = 'hash-1-' || current_setting('test.rid')
     AND used_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'consommation : attendu 1 ligne, obtenu %', n; END IF;
  -- Rejouer le même code ne consomme rien.
  UPDATE admin.mfa_recovery_codes SET used_at = now()
   WHERE user_id = current_setting('test.user_a')::uuid
     AND code_hash = 'hash-1-' || current_setting('test.rid')
     AND used_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'usage unique : le code a été consommé deux fois'; END IF;
END $$;

-- Rotation : suppression physique autorisée (matériel d'authentification), bornée au tenant.
DO $$
DECLARE n int;
BEGIN
  DELETE FROM admin.mfa_recovery_codes WHERE user_id = current_setting('test.user_a')::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 2 THEN RAISE EXCEPTION 'rotation : attendu 2 suppressions, obtenu %', n; END IF;
END $$;

-- Le tenant B ne voit rien de tout cela.
\connect :"appurl"
\set QUIET on
SET app.tenant_id = :'tenant_b';
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM admin.mfa_recovery_codes;
  IF n <> 0 THEN RAISE EXCEPTION 'RLS : % code(s) visibles depuis le tenant B', n; END IF;
END $$;
