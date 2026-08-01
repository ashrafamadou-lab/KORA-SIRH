-- 0002 — Tenants, utilisateurs, RBAC (E1/E2 : fondations de données)
-- Réf : Blueprint §6 (rôles), §7 (permissions), PRD US-E1-06, US-E2-01/02.

CREATE TABLE admin.tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name        text NOT NULL,
  country_code char(2) NOT NULL DEFAULT 'BJ',          -- Country Profile (Blueprint §25)
  is_demo     boolean NOT NULL DEFAULT false,           -- DEMO DATA purgeable, jamais mélangé
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE TRIGGER trg_tenants_touch BEFORE UPDATE ON admin.tenants
  FOR EACH ROW EXECUTE FUNCTION admin.touch_updated_at();

-- Employee ≠ User (Blueprint §13) : un utilisateur peut ne pas être salarié (auditeur
-- externe) ; un salarié peut ne pas avoir de compte (mode délégué, D5). Le lien optionnel
-- 1–1 vers core.employees est ajouté en 0003 (FK différée car la table n'existe pas encore).
CREATE TABLE admin.users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES admin.tenants(id),
  email         citext NOT NULL,
  password_hash text,                                   -- Argon2id, posé par le service auth (incrément 2)
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  UNIQUE (tenant_id, email),
  UNIQUE (tenant_id, id)                                -- cible des FK composites (intégrité inter-tenant)
);
CREATE TRIGGER trg_users_touch BEFORE UPDATE ON admin.users
  FOR EACH ROW EXECUTE FUNCTION admin.touch_updated_at();

-- Catalogue global de permissions (module.action) — pas de tenant_id : c'est un référentiel.
CREATE TABLE admin.permissions (
  key         text PRIMARY KEY CHECK (key ~ '^[a-z_]+\.[a-z_]+$'),
  description text NOT NULL
);

-- Rôles par tenant : ensembles de permissions modifiables, jamais des blocs figés (§6).
CREATE TABLE admin.roles (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES admin.tenants(id),
  key        text NOT NULL,
  name       text NOT NULL,
  is_system  boolean NOT NULL DEFAULT false,            -- rôle seed (protégé contre la suppression)
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key),
  UNIQUE (tenant_id, id)
);

CREATE TABLE admin.role_permissions (
  tenant_id      uuid NOT NULL,
  role_id        uuid NOT NULL,
  permission_key text NOT NULL REFERENCES admin.permissions(key),
  PRIMARY KEY (role_id, permission_key),
  FOREIGN KEY (tenant_id, role_id) REFERENCES admin.roles(tenant_id, id)
);

CREATE TABLE admin.user_roles (
  tenant_id uuid NOT NULL,
  user_id   uuid NOT NULL,
  role_id   uuid NOT NULL,
  PRIMARY KEY (user_id, role_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES admin.users(tenant_id, id),
  FOREIGN KEY (tenant_id, role_id) REFERENCES admin.roles(tenant_id, id)
);

-- Portées : toute permission est bornée (entité, site, département, équipe) — §6/§7.
-- scope_ref pointera vers les tables d'organisation (incrément 3) ; la FK sera ajoutée
-- avec le module Organisation. NULL = portée « tout le tenant ».
CREATE TABLE admin.user_scopes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL,
  user_id    uuid NOT NULL,
  scope_type text NOT NULL CHECK (scope_type IN ('tenant', 'legal_entity', 'site', 'department', 'team')),
  scope_ref  uuid,
  CONSTRAINT scope_ref_required CHECK (scope_type = 'tenant' OR scope_ref IS NOT NULL),
  FOREIGN KEY (tenant_id, user_id) REFERENCES admin.users(tenant_id, id)
);
