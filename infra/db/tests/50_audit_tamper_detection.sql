-- TEST 50 — Détection de falsification de l'audit trail (nécessite le superutilisateur).
-- Simule un attaquant disposant de droits élevés : désactivation du trigger, altération
-- d'une ligne — verify_chain doit détecter la corruption. Tout est exécuté dans une
-- transaction ANNULÉE : la base reste intacte.
\set QUIET on
\set superurl `echo "$DATABASE_URL_SUPER"`
\connect :"superurl"
\set QUIET on

SELECT substr(md5(random()::text), 1, 8) AS rid \gset
BEGIN;
INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('test-tam-' || :'rid', 'Test Tamper', true) RETURNING id AS tenant_t \gset
SET LOCAL test.tenant_t = :'tenant_t';
INSERT INTO audit.audit_log (tenant_id, action, module, record_type, reason)
VALUES (:'tenant_t', 'create', 'core_hr', 'employee', 'ligne 1'),
       (:'tenant_t', 'update', 'core_hr', 'employee', 'ligne 2');

ALTER TABLE audit.audit_log DISABLE TRIGGER trg_audit_immutable;
UPDATE audit.audit_log SET reason = 'FALSIFIÉ'
 WHERE tenant_id = :'tenant_t'
   AND id = (SELECT min(id) FROM audit.audit_log WHERE tenant_id = :'tenant_t');
ALTER TABLE audit.audit_log ENABLE TRIGGER trg_audit_immutable;

DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad FROM audit.verify_chain(current_setting('test.tenant_t')::uuid);
  IF bad < 1 THEN
    RAISE EXCEPTION 'verify_chain : la falsification aurait dû être détectée (0 ligne signalée)';
  END IF;
END $$;
ROLLBACK;
