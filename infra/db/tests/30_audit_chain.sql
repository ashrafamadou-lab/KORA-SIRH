-- TEST 30 — Audit trail : append-only et chaînage d'intégrité (PRD US-E6-01)
\set QUIET on
\set appurl `echo "$DATABASE_URL_APP"`
\set migurl `echo "$DATABASE_URL_MIGRATOR"`

-- ---------- Fixture (migrator) ----------
SELECT substr(md5(random()::text), 1, 8) AS rid \gset
INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('test-aud-' || :'rid', 'Test Audit', true) RETURNING id AS tenant_t \gset

-- ---------- Écritures et assertions (kora_app) ----------
\connect :"appurl"
\set QUIET on
SET app.tenant_id = :'tenant_t';
SET test.tenant_t = :'tenant_t';

INSERT INTO audit.audit_log (tenant_id, action, module, record_type, record_id, new_value, reason)
VALUES (:'tenant_t', 'create', 'core_hr', 'employee', 'E-1', '{"matricule": "E-1"}', 'test');
INSERT INTO audit.audit_log (tenant_id, action, module, record_type, record_id, old_value, new_value, reason)
VALUES (:'tenant_t', 'update', 'core_hr', 'employee', 'E-1', '{"poste": "A"}', '{"poste": "B"}', 'test');
INSERT INTO audit.audit_log (tenant_id, action, module, record_type, record_id, reason)
VALUES (:'tenant_t', 'read_sensitive', 'core_hr', 'salary', 'E-1', 'consultation salaire — journalisée en lecture');

-- La chaîne est liée : prev_hash(N) = row_hash(N-1), et le hash stocké se recalcule.
DO $$
DECLARE r audit.audit_log%ROWTYPE; prev text := NULL; n int := 0; bad int;
BEGIN
  FOR r IN SELECT * FROM audit.audit_log
            WHERE tenant_id = current_setting('test.tenant_t')::uuid ORDER BY id LOOP
    n := n + 1;
    IF COALESCE(r.prev_hash, '∅') <> COALESCE(prev, '∅') THEN
      RAISE EXCEPTION 'chaînage : prev_hash de la ligne % ne référence pas la ligne précédente', r.id;
    END IF;
    IF r.row_hash <> encode(digest(COALESCE(prev, 'genesis') || audit.row_payload(r), 'sha256'), 'hex') THEN
      RAISE EXCEPTION 'chaînage : row_hash de la ligne % ne se recalcule pas', r.id;
    END IF;
    prev := r.row_hash;
  END LOOP;
  IF n <> 3 THEN RAISE EXCEPTION 'audit : attendu 3 lignes, obtenu %', n; END IF;
  SELECT count(*) INTO bad FROM audit.verify_chain(current_setting('test.tenant_t')::uuid);
  IF bad <> 0 THEN RAISE EXCEPTION 'verify_chain : % ligne(s) signalée(s) corrompue(s) sur une chaîne saine', bad; END IF;
END $$;

-- Append-only côté application : UPDATE et DELETE refusés (privilège et/ou trigger).
DO $$
BEGIN
  BEGIN
    UPDATE audit.audit_log SET reason = 'falsifié'
     WHERE tenant_id = current_setting('test.tenant_t')::uuid;
    RAISE EXCEPTION 'audit : UPDATE aurait dû être refusé';
  EXCEPTION WHEN insufficient_privilege OR raise_exception THEN NULL;
  END;
  BEGIN
    DELETE FROM audit.audit_log
     WHERE tenant_id = current_setting('test.tenant_t')::uuid;
    RAISE EXCEPTION 'audit : DELETE aurait dû être refusé';
  EXCEPTION WHEN insufficient_privilege OR raise_exception THEN NULL;
  END;
END $$;

-- Append-only même pour le propriétaire du schéma : le trigger bloque aussi kora_migrator.
\connect :"migurl"
\set QUIET on
SET test.tenant_t = :'tenant_t';
DO $$
BEGIN
  BEGIN
    UPDATE audit.audit_log SET reason = 'falsifié par le propriétaire'
     WHERE tenant_id = current_setting('test.tenant_t')::uuid;
    RAISE EXCEPTION 'audit : UPDATE par le propriétaire aurait dû être bloqué par le trigger';
  EXCEPTION WHEN raise_exception THEN NULL; -- P0001 « append-only » : attendu
  END;
  BEGIN
    DELETE FROM audit.audit_log
     WHERE tenant_id = current_setting('test.tenant_t')::uuid;
    RAISE EXCEPTION 'audit : DELETE par le propriétaire aurait dû être bloqué par le trigger';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
END $$;
