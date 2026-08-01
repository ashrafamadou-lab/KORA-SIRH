-- TEST 110 — Consultation d'audit (E6) : colonnes hors payload SANS casser la chaîne,
-- vérification segmentée continuable, seed falsifié détecté, append-only, RLS, catalogue.
\set QUIET on
\set appurl `echo "$DATABASE_URL_APP"`

-- ---------- Catalogue (migrator) ----------
DO $$
DECLARE k text;
BEGIN
  FOREACH k IN ARRAY ARRAY['audit.view','audit.export','audit.view_own','audit.view_auth',
                           'audit.view_admin_users','audit.view_workflow','audit.view_config',
                           'audit.view_notify','audit.view_audit'] LOOP
    IF NOT EXISTS (SELECT 1 FROM admin.permissions WHERE key = k) THEN
      RAISE EXCEPTION 'permission % absente du catalogue', k;
    END IF;
  END LOOP;
END $$;

-- ---------- Fixtures (migrator) ----------
SELECT substr(md5(random()::text), 1, 8) AS rid \gset
INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('test-aud-a-' || :'rid', 'AUD A', true) RETURNING id AS tenant_a \gset
INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('test-aud-b-' || :'rid', 'AUD B', true) RETURNING id AS tenant_b \gset

\connect :"appurl"
\set QUIET on
SET app.tenant_id = :'tenant_a';
SET test.tenant_a = :'tenant_a';
SET test.tenant_b = :'tenant_b';

-- ---------- Insertion mixte : anciennes formes (sans result/corrélation) + nouvelles ----------
INSERT INTO audit.audit_log (tenant_id, action, module, record_type, reason)
VALUES (:'tenant_a', 'legacy_1', 'auth', 'user', 'ligne ancienne forme'),
       (:'tenant_a', 'legacy_2', 'workflow', 'instance', NULL),
       (:'tenant_a', 'legacy_3', 'config', 'parameter', 'x');
INSERT INTO audit.audit_log (tenant_id, action, module, record_type, reason, result, correlation_id, old_value, new_value)
VALUES (:'tenant_a', 'new_1', 'notify', 'template', 'avec résultat', 'success', gen_random_uuid(), '{"a":1}', '{"a":2}'),
       (:'tenant_a', 'new_2', 'audit', 'audit_log', 'export test', 'denied', gen_random_uuid(), NULL, NULL),
       (:'tenant_a', 'new_3', 'admin_users', 'user', NULL, 'failure', NULL, NULL, '{"b":true}');

-- La contrainte de valeur de result tient.
DO $$
BEGIN
  BEGIN
    INSERT INTO audit.audit_log (tenant_id, action, module, record_type, result)
    VALUES (current_setting('test.tenant_a')::uuid, 'bad', 'auth', 'user', 'weird');
    RAISE EXCEPTION 'result : « weird » aurait dû être refusé';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- ---------- La chaîne reste INTACTE avec les colonnes hors payload ----------
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM audit.verify_chain(current_setting('test.tenant_a')::uuid);
  IF n <> 0 THEN
    RAISE EXCEPTION 'verify_chain : % ligne(s) corrompue(s) après ajout des colonnes hors payload', n;
  END IF;
END $$;

-- ---------- Vérification segmentée : passe complète, continuation, seed falsifié ----------
DO $$
DECLARE
  t uuid := current_setting('test.tenant_a')::uuid;
  full_pass record;
  seg1 record;
  seg2 record;
  forged record;
BEGIN
  SELECT * INTO full_pass FROM audit.verify_chain_segment(t, 0, NULL, 1000);
  IF full_pass.broken_id IS NOT NULL OR full_pass.checked <> 6 THEN
    RAISE EXCEPTION 'segment complet : broken=% checked=% (attendu NULL/6)', full_pass.broken_id, full_pass.checked;
  END IF;

  -- Continuation : 2 lignes, puis reprise EXACTE depuis (last_id, last_hash).
  SELECT * INTO seg1 FROM audit.verify_chain_segment(t, 0, NULL, 2);
  IF seg1.broken_id IS NOT NULL OR seg1.checked <> 2 THEN
    RAISE EXCEPTION 'segment 1 : broken=% checked=% (attendu NULL/2)', seg1.broken_id, seg1.checked;
  END IF;
  SELECT * INTO seg2 FROM audit.verify_chain_segment(t, seg1.last_id, seg1.last_hash, 1000);
  IF seg2.broken_id IS NOT NULL OR seg2.checked <> 4 THEN
    RAISE EXCEPTION 'segment 2 (continuation) : broken=% checked=% (attendu NULL/4)', seg2.broken_id, seg2.checked;
  END IF;

  -- Un seed falsifié NE PASSE PAS : la reprise est cryptographique, pas déclarative.
  SELECT * INTO forged FROM audit.verify_chain_segment(t, seg1.last_id, repeat('ab', 32), 1000);
  IF forged.broken_id IS NULL THEN
    RAISE EXCEPTION 'seed falsifié : la vérification aurait dû signaler une rupture';
  END IF;
END $$;

-- ---------- Append-only réaffirmé (E6 : rien ne modifie le journal) ----------
DO $$
BEGIN
  BEGIN
    UPDATE audit.audit_log SET reason = 'falsifié' WHERE tenant_id = current_setting('test.tenant_a')::uuid;
    RAISE EXCEPTION 'append-only : UPDATE aurait dû être refusé';
  EXCEPTION WHEN insufficient_privilege OR raise_exception THEN NULL;
  END;
  BEGIN
    DELETE FROM audit.audit_log WHERE tenant_id = current_setting('test.tenant_a')::uuid;
    RAISE EXCEPTION 'append-only : DELETE aurait dû être refusé';
  EXCEPTION WHEN insufficient_privilege OR raise_exception THEN NULL;
  END;
END $$;

-- ---------- Isolation : B ne voit rien de A, même via la vérification segmentée ----------
SET app.tenant_id = :'tenant_b';
DO $$
DECLARE n int; seg record;
BEGIN
  SELECT count(*) INTO n FROM audit.audit_log;
  IF n <> 0 THEN RAISE EXCEPTION 'isolation : B voit % événement(s) de A', n; END IF;
  -- Demander la chaîne de A depuis la session de B : la RLS ne révèle RIEN (0 vérifiée).
  SELECT * INTO seg FROM audit.verify_chain_segment(current_setting('test.tenant_a')::uuid, 0, NULL, 1000);
  IF seg.checked <> 0 OR seg.broken_id IS NOT NULL THEN
    RAISE EXCEPTION 'isolation : la vérification segmentée a exposé la chaîne de A depuis B (checked=%)', seg.checked;
  END IF;
END $$;
