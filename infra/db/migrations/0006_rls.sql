-- 0006 — Row-Level Security et privilèges du rôle applicatif
-- Réf : décisions D1/D2, Blueprint §15.2. Le rôle kora_app (NOBYPASSRLS, non
-- propriétaire) est le SEUL utilisé par l'application : chaque requête est bornée au
-- tenant posé par SET LOCAL app.tenant_id. kora_migrator (propriétaire) reste réservé
-- aux migrations et seeds — jamais au trafic applicatif.

-- ---------- Activation RLS ----------
ALTER TABLE admin.tenants               ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin.users                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin.roles                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin.role_permissions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin.user_roles            ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin.user_scopes           ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.employees              ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.salary_history         ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance.legal_parameters ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.audit_log             ENABLE ROW LEVEL SECURITY;

-- ---------- Politiques (TO kora_app) ----------
CREATE POLICY tenant_self ON admin.tenants FOR SELECT TO kora_app
  USING (id = admin.current_tenant_id());

CREATE POLICY tenant_rows ON admin.users TO kora_app
  USING (tenant_id = admin.current_tenant_id())
  WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON admin.roles TO kora_app
  USING (tenant_id = admin.current_tenant_id())
  WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON admin.role_permissions TO kora_app
  USING (tenant_id = admin.current_tenant_id())
  WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON admin.user_roles TO kora_app
  USING (tenant_id = admin.current_tenant_id())
  WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON admin.user_scopes TO kora_app
  USING (tenant_id = admin.current_tenant_id())
  WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON core.employees TO kora_app
  USING (tenant_id = admin.current_tenant_id())
  WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON core.salary_history TO kora_app
  USING (tenant_id = admin.current_tenant_id())
  WITH CHECK (tenant_id = admin.current_tenant_id());

-- Paramètres légaux : l'application lit les paramètres pays (tenant_id NULL) + les
-- surcharges de SON tenant ; elle ne peut écrire QUE des surcharges de son tenant.
-- Les paramètres pays sont gérés par le processus de configuration privilégié
-- (kora_migrator aujourd'hui ; fonction dédiée du Config Center à l'incrément 2).
CREATE POLICY parameters_read ON compliance.legal_parameters FOR SELECT TO kora_app
  USING (tenant_id IS NULL OR tenant_id = admin.current_tenant_id());
CREATE POLICY parameters_write ON compliance.legal_parameters FOR INSERT TO kora_app
  WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY parameters_update ON compliance.legal_parameters FOR UPDATE TO kora_app
  USING (tenant_id = admin.current_tenant_id())
  WITH CHECK (tenant_id = admin.current_tenant_id());

CREATE POLICY tenant_rows ON audit.audit_log TO kora_app
  USING (tenant_id = admin.current_tenant_id())
  WITH CHECK (tenant_id = admin.current_tenant_id());

-- ---------- Privilèges kora_app (moindre privilège) ----------
GRANT USAGE ON SCHEMA admin, core, compliance, audit TO kora_app;

-- Pas de DELETE nulle part : la suppression est logique (deleted_at), la purge physique
-- est un processus de rétention privilégié et audité (Blueprint §12.1).
GRANT SELECT                 ON admin.tenants          TO kora_app;
GRANT SELECT, INSERT, UPDATE ON admin.users            TO kora_app;
GRANT SELECT, INSERT, UPDATE ON admin.roles            TO kora_app;
GRANT SELECT, INSERT, DELETE ON admin.role_permissions TO kora_app;  -- table de liaison pure
GRANT SELECT, INSERT, DELETE ON admin.user_roles       TO kora_app;  -- table de liaison pure
GRANT SELECT, INSERT, UPDATE, DELETE ON admin.user_scopes TO kora_app;
GRANT SELECT                 ON admin.permissions      TO kora_app;
GRANT SELECT, INSERT, UPDATE ON core.employees         TO kora_app;
GRANT SELECT, INSERT, UPDATE ON core.salary_history    TO kora_app;

-- Paramètres : INSERT de surcharges tenant ; UPDATE restreint aux colonnes de cycle de
-- vie — la valeur et les dates d'effet d'une version sont immuables (on crée une
-- nouvelle version, on n'écrase jamais — US-E4-01).
GRANT SELECT, INSERT ON compliance.legal_parameters TO kora_app;
GRANT UPDATE (status, confidence, verified_by, verified_at, source_text, source_url, notes, deleted_at)
  ON compliance.legal_parameters TO kora_app;
GRANT SELECT ON compliance.parameters_requiring_attention TO kora_app;

-- Audit : lecture (bornée RLS) + insertion. Jamais UPDATE/DELETE (trigger + absence de grant).
GRANT SELECT, INSERT ON audit.audit_log TO kora_app;

GRANT EXECUTE ON FUNCTION admin.current_tenant_id()                    TO kora_app;
GRANT EXECUTE ON FUNCTION compliance.parameter_value_at(text, char, uuid, date) TO kora_app;
GRANT EXECUTE ON FUNCTION audit.verify_chain(uuid)                     TO kora_app;
