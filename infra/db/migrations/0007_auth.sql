-- 0007 — Authentification (E1) : sessions, verrouillage progressif, résolution de tenant
-- Réf : PRD US-E1-01/02/03/06, Blueprint §15.2. La logique (délais, politiques) vit dans
-- packages/core et la couche API ; la base porte l'état et les invariants.

-- État de connexion et MFA sur le compte utilisateur.
ALTER TABLE admin.users
  ADD COLUMN mfa_enabled         boolean NOT NULL DEFAULT false,
  ADD COLUMN mfa_secret_enc      text,             -- secret TOTP chiffré applicativement (AES-256-GCM)
  ADD COLUMN failed_login_count  int NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  ADD COLUMN locked_until        timestamptz,
  ADD COLUMN password_updated_at timestamptz;

-- Sessions opaques : on ne stocke JAMAIS le jeton, seulement son empreinte SHA-256.
-- Le jeton transporte l'id du tenant (k1.<tenant>.<aléa>) pour poser le contexte RLS
-- avant la recherche — voir packages/core/src/session-token.ts.
CREATE TABLE admin.sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES admin.tenants(id),
  user_id      uuid NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  ip           inet,
  user_agent   text,
  FOREIGN KEY (tenant_id, user_id) REFERENCES admin.users (tenant_id, id)
);
CREATE INDEX sessions_user_idx ON admin.sessions (tenant_id, user_id, created_at DESC);

-- Résolution du tenant au login — le seul lookup légitime AVANT tout contexte RLS.
-- Fonction étroite, SECURITY DEFINER (propriétaire = kora_migrator, non soumis à RLS),
-- qui n'expose que l'id d'un tenant actif à partir de son slug public. search_path épinglé.
CREATE FUNCTION admin.resolve_tenant(p_slug text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = admin AS
$$ SELECT id FROM admin.tenants WHERE slug = p_slug AND deleted_at IS NULL $$;
REVOKE ALL ON FUNCTION admin.resolve_tenant(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.resolve_tenant(text) TO kora_app;

-- RLS et privilèges (mêmes principes que 0006 : pas de DELETE, révocation = revoked_at).
ALTER TABLE admin.sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON admin.sessions TO kora_app
  USING (tenant_id = admin.current_tenant_id())
  WITH CHECK (tenant_id = admin.current_tenant_id());
GRANT SELECT, INSERT, UPDATE ON admin.sessions TO kora_app;
