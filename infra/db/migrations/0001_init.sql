-- 0001 — Extensions, schémas, helpers transverses
-- Réf : Blueprint §11-12 ; décisions D1/D2 (multi-tenant, base partagée + RLS).

CREATE EXTENSION IF NOT EXISTS pgcrypto;    -- gen_random_uuid(), digest()
CREATE EXTENSION IF NOT EXISTS btree_gist;  -- contraintes d'exclusion (anti-chevauchement)
CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- recherche fuzzy (E16, plus tard)
CREATE EXTENSION IF NOT EXISTS citext;      -- emails insensibles à la casse

CREATE SCHEMA admin;       -- tenants, utilisateurs, RBAC
CREATE SCHEMA core;        -- dossier salarié, organisation
CREATE SCHEMA compliance;  -- paramètres légaux versionnés (Parameter Engine)
CREATE SCHEMA audit;       -- journal immuable

-- Tenant courant : posé par la couche applicative via SET LOCAL app.tenant_id = '<uuid>'
-- dans chaque transaction (spike ADR-002). NULL si absent → RLS ne rend aucune ligne.
CREATE FUNCTION admin.current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

-- Trigger générique de mise à jour du champ updated_at.
CREATE FUNCTION admin.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS
$$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
