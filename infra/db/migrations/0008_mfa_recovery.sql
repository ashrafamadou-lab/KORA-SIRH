-- 0008 — MFA : codes de récupération à usage unique (E1 / US-E1-02, tranche 2)
-- Le secret TOTP vit chiffré (AES-256-GCM applicatif) dans admin.users.mfa_secret_enc
-- (0007). Les codes de récupération sont stockés en empreinte SHA-256 : codes aléatoires
-- à haute entropie (40 bits), l'empreinte rapide suffit — contrairement aux mots de
-- passe humains qui exigent Argon2.

CREATE TABLE admin.mfa_recovery_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES admin.tenants(id),
  user_id    uuid NOT NULL,
  code_hash  text NOT NULL,
  used_at    timestamptz,                   -- usage unique : consommé = horodaté
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES admin.users (tenant_id, id),
  UNIQUE (user_id, code_hash)
);
CREATE INDEX mfa_recovery_codes_user_idx ON admin.mfa_recovery_codes (tenant_id, user_id);

ALTER TABLE admin.mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON admin.mfa_recovery_codes TO kora_app
  USING (tenant_id = admin.current_tenant_id())
  WITH CHECK (tenant_id = admin.current_tenant_id());

-- Exception assumée au « pas de DELETE » : matériel d'authentification remplaçable,
-- pas une donnée métier — la rotation/désactivation supprime physiquement les codes
-- (l'événement, lui, est journalisé dans l'audit trail).
GRANT SELECT, INSERT, UPDATE (used_at), DELETE ON admin.mfa_recovery_codes TO kora_app;
