-- TEST 120 — Organisation : FK inter-tenant rejetées PAR POSTGRESQL, anti-cycle,
-- anti-chevauchement, close-only (l'histoire ne se réécrit pas), statuts gardés,
-- portées RBAC réelles, RLS, aucun DELETE, catalogue.
\set QUIET on
\set appurl `echo "$DATABASE_URL_APP"`

-- ---------- Catalogue (migrator) ----------
DO $$
BEGIN
  IF (SELECT count(*) FROM admin.permissions WHERE key IN ('org.view','org.manage','org.import')) <> 3 THEN
    RAISE EXCEPTION 'permissions org.* absentes du catalogue';
  END IF;
END $$;

-- ---------- Fixtures (migrator) ----------
SELECT substr(md5(random()::text), 1, 8) AS rid \gset
INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('test-org-a-' || :'rid', 'ORG A', true) RETURNING id AS tenant_a \gset
INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('test-org-b-' || :'rid', 'ORG B', true) RETURNING id AS tenant_b \gset
INSERT INTO admin.users (tenant_id, email) VALUES (:'tenant_a', 'org-u1-' || :'rid' || '@test.bj') RETURNING id AS user_a \gset

-- Unité du tenant B (pour prouver le rejet inter-tenant PAR LA BASE).
INSERT INTO org.companies (tenant_id, code, label_fr, label_en, status)
VALUES (:'tenant_b', 'CO-B', 'Société B', 'Company B', 'active') RETURNING id AS co_b \gset
INSERT INTO org.units (tenant_id, unit_type, code, label_fr, label_en, status)
VALUES (:'tenant_b', 'direction', 'DIR-B', 'Direction B', 'Directorate B', 'active') RETURNING id AS unit_b \gset

\connect :"appurl"
\set QUIET on
SET app.tenant_id = :'tenant_a';
SET test.tenant_a = :'tenant_a';
SET test.tenant_b = :'tenant_b';
SET test.unit_b = :'unit_b';
SET test.co_b = :'co_b';
SET test.user_a = :'user_a';

-- ---------- Référentiel A ----------
INSERT INTO org.companies (tenant_id, code, label_fr, label_en, status)
VALUES (:'tenant_a', 'CO-A', 'Société A', 'Company A', 'active') RETURNING id AS co_a \gset
SET test.co_a = :'co_a';
INSERT INTO org.sites (tenant_id, company_id, code, label_fr, label_en, status)
VALUES (:'tenant_a', :'co_a', 'SITE-COT', 'Site Cotonou', 'Cotonou site', 'active') RETURNING id AS site_a \gset
SET test.site_a = :'site_a';
INSERT INTO org.jobs (tenant_id, code, label_fr, label_en, status)
VALUES (:'tenant_a', 'JOB-COMPTA', 'Comptable', 'Accountant', 'active') RETURNING id AS job_a \gset
INSERT INTO org.cost_centers (tenant_id, code, label_fr, label_en, status)
VALUES (:'tenant_a', 'CC-100', 'CC Finance', 'Finance CC', 'active') RETURNING id AS cc_a \gset

INSERT INTO org.units (tenant_id, unit_type, code, label_fr, label_en, status)
VALUES (:'tenant_a', 'direction', 'DIR-A', 'Direction Générale', 'General Directorate', 'active') RETURNING id AS u_dir \gset
INSERT INTO org.units (tenant_id, unit_type, code, label_fr, label_en, status)
VALUES (:'tenant_a', 'department', 'DEP-FIN', 'Département Finance', 'Finance Department', 'active') RETURNING id AS u_fin \gset
INSERT INTO org.units (tenant_id, unit_type, code, label_fr, label_en, status)
VALUES (:'tenant_a', 'service', 'SRV-CPT', 'Service Comptabilité', 'Accounting Service', 'active') RETURNING id AS u_cpt \gset
SET test.u_dir = :'u_dir';
SET test.u_fin = :'u_fin';
SET test.u_cpt = :'u_cpt';

-- Code dupliqué dans le tenant : refusé ; code immuable ensuite.
DO $$
BEGIN
  BEGIN
    INSERT INTO org.units (tenant_id, unit_type, code, label_fr, label_en)
    VALUES (current_setting('test.tenant_a')::uuid, 'team', 'DEP-FIN', 'Doublon', 'Dup');
    RAISE EXCEPTION 'code dupliqué : aurait dû être refusé';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    UPDATE org.units SET code = 'DEP-FIN2' WHERE id = current_setting('test.u_fin')::uuid;
    RAISE EXCEPTION 'code immuable : la modification aurait dû être refusée';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
END $$;

-- ---------- Hiérarchie datée : DIR ← FIN ← CPT ----------
INSERT INTO org.unit_parents (tenant_id, unit_id, parent_unit_id, effective_from)
VALUES (:'tenant_a', :'u_fin', :'u_dir', '2026-01-01');
INSERT INTO org.unit_parents (tenant_id, unit_id, parent_unit_id, effective_from)
VALUES (:'tenant_a', :'u_cpt', :'u_fin', '2026-01-01') RETURNING id AS link_cpt \gset
SET test.link_cpt = :'link_cpt';

DO $$
BEGIN
  -- FK INTER-TENANT rejetée PAR POSTGRESQL : parent du tenant B.
  BEGIN
    INSERT INTO org.unit_parents (tenant_id, unit_id, parent_unit_id, effective_from)
    VALUES (current_setting('test.tenant_a')::uuid, current_setting('test.u_dir')::uuid,
            current_setting('test.unit_b')::uuid, '2026-01-01');
    RAISE EXCEPTION 'FK inter-tenant : le parent du tenant B aurait dû être rejeté par la base';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  -- Auto-parent refusé : le trigger anti-cycle (BEFORE INSERT) se déclenche avant la
  -- contrainte CHECK — les deux défenses le refusent, on accepte l'une ou l'autre.
  BEGIN
    INSERT INTO org.unit_parents (tenant_id, unit_id, parent_unit_id, effective_from)
    VALUES (current_setting('test.tenant_a')::uuid, current_setting('test.u_dir')::uuid,
            current_setting('test.u_dir')::uuid, '2026-01-01');
    RAISE EXCEPTION 'auto-parent : aurait dû être refusé';
  EXCEPTION WHEN check_violation OR raise_exception THEN NULL;
  END;
  -- CYCLE refusé : DIR sous CPT alors que CPT descend de DIR.
  BEGIN
    INSERT INTO org.unit_parents (tenant_id, unit_id, parent_unit_id, effective_from)
    VALUES (current_setting('test.tenant_a')::uuid, current_setting('test.u_dir')::uuid,
            current_setting('test.u_cpt')::uuid, '2026-06-01');
    RAISE EXCEPTION 'cycle : DIR→CPT aurait dû être refusé';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  -- CHEVAUCHEMENT refusé : CPT a déjà un parent ouvert depuis 2026-01-01.
  BEGIN
    INSERT INTO org.unit_parents (tenant_id, unit_id, parent_unit_id, effective_from)
    VALUES (current_setting('test.tenant_a')::uuid, current_setting('test.u_cpt')::uuid,
            current_setting('test.u_dir')::uuid, '2026-03-01');
    RAISE EXCEPTION 'chevauchement : deux parents applicables auraient dû être refusés';
  EXCEPTION WHEN exclusion_violation THEN NULL;
  END;
END $$;

-- Réorganisation PROPRE : clôture puis nouvelle ligne datée — l'histoire est conservée.
UPDATE org.unit_parents SET effective_to = '2026-07-01' WHERE id = :'link_cpt';
INSERT INTO org.unit_parents (tenant_id, unit_id, parent_unit_id, effective_from)
VALUES (:'tenant_a', :'u_cpt', :'u_dir', '2026-07-01');

DO $$
DECLARE
  p_before uuid;
  p_after  uuid;
BEGIN
  -- L'organigramme au 1er mars reste l'ANCIEN ; au 1er août, le NOUVEAU.
  p_before := org.unit_parent_at(current_setting('test.u_cpt')::uuid, '2026-03-01');
  p_after  := org.unit_parent_at(current_setting('test.u_cpt')::uuid, '2026-08-01');
  IF p_before <> current_setting('test.u_fin')::uuid THEN
    RAISE EXCEPTION 'historique : le parent au 2026-03-01 aurait dû rester FIN';
  END IF;
  IF p_after <> current_setting('test.u_dir')::uuid THEN
    RAISE EXCEPTION 'réorganisation : le parent au 2026-08-01 aurait dû être DIR';
  END IF;
  -- La ligne close est FIGÉE : ni réouverture ni réécriture.
  BEGIN
    UPDATE org.unit_parents SET effective_to = NULL WHERE id = current_setting('test.link_cpt')::uuid;
    RAISE EXCEPTION 'close-only : la réouverture aurait dû être refusée';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  BEGIN
    UPDATE org.unit_parents SET parent_unit_id = current_setting('test.u_dir')::uuid
     WHERE id = current_setting('test.link_cpt')::uuid;
    RAISE EXCEPTION 'close-only : la réécriture du parent aurait dû être refusée';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  -- Aucune suppression physique (pas de grant + trigger).
  BEGIN
    DELETE FROM org.unit_parents WHERE id = current_setting('test.link_cpt')::uuid;
    RAISE EXCEPTION 'suppression : aurait dû être refusée';
  EXCEPTION WHEN insufficient_privilege OR raise_exception THEN NULL;
  END;
END $$;

-- ---------- Postes : rattachements + ligne managériale datés ----------
INSERT INTO org.positions (tenant_id, code, label_fr, label_en, status)
VALUES (:'tenant_a', 'POS-DAF', 'Directeur financier', 'CFO', 'active') RETURNING id AS pos_daf \gset
INSERT INTO org.positions (tenant_id, code, label_fr, label_en, status)
VALUES (:'tenant_a', 'POS-CPT1', 'Comptable senior', 'Senior accountant', 'active') RETURNING id AS pos_cpt \gset
SET test.pos_daf = :'pos_daf';
SET test.pos_cpt = :'pos_cpt';

INSERT INTO org.position_assignments (tenant_id, position_id, unit_id, company_id, job_id, site_id, cost_center_id, effective_from)
VALUES (:'tenant_a', :'pos_cpt', :'u_cpt', :'co_a', :'job_a', :'site_a', :'cc_a', '2026-01-01');

DO $$
BEGIN
  -- Rattachement vers la société du tenant B : rejeté PAR LA BASE.
  BEGIN
    INSERT INTO org.position_assignments (tenant_id, position_id, unit_id, company_id, job_id, effective_from)
    SELECT current_setting('test.tenant_a')::uuid, current_setting('test.pos_daf')::uuid,
           current_setting('test.u_fin')::uuid, current_setting('test.co_b')::uuid,
           j.id, '2026-01-01'
      FROM org.jobs j WHERE j.tenant_id = current_setting('test.tenant_a')::uuid LIMIT 1;
    RAISE EXCEPTION 'FK inter-tenant : la société de B aurait dû être rejetée par la base';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  -- Chevauchement de rattachement refusé.
  BEGIN
    INSERT INTO org.position_assignments (tenant_id, position_id, unit_id, company_id, job_id, effective_from)
    SELECT current_setting('test.tenant_a')::uuid, current_setting('test.pos_cpt')::uuid,
           current_setting('test.u_fin')::uuid, current_setting('test.co_a')::uuid, j.id, '2026-05-01'
      FROM org.jobs j WHERE j.tenant_id = current_setting('test.tenant_a')::uuid LIMIT 1;
    RAISE EXCEPTION 'chevauchement de rattachement : aurait dû être refusé';
  EXCEPTION WHEN exclusion_violation THEN NULL;
  END;
END $$;

INSERT INTO org.position_managers (tenant_id, position_id, manager_position_id, effective_from)
VALUES (:'tenant_a', :'pos_cpt', :'pos_daf', '2026-01-01');
DO $$
BEGIN
  -- UN SEUL parent hiérarchique applicable à une date : le second manager chevauchant est refusé.
  BEGIN
    INSERT INTO org.position_managers (tenant_id, position_id, manager_position_id, effective_from)
    VALUES (current_setting('test.tenant_a')::uuid, current_setting('test.pos_cpt')::uuid,
            current_setting('test.pos_daf')::uuid, '2026-04-01');
    RAISE EXCEPTION 'double manager applicable : aurait dû être refusé';
  EXCEPTION WHEN exclusion_violation THEN NULL;
  END;
  -- Cycle managérial refusé : DAF managé par CPT alors que CPT est managé par DAF.
  BEGIN
    INSERT INTO org.position_managers (tenant_id, position_id, manager_position_id, effective_from)
    VALUES (current_setting('test.tenant_a')::uuid, current_setting('test.pos_daf')::uuid,
            current_setting('test.pos_cpt')::uuid, '2026-02-01');
    RAISE EXCEPTION 'cycle managérial : aurait dû être refusé';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
END $$;

-- ---------- Portées RBAC réelles ----------
DO $$
BEGIN
  -- Portée department vers une unité INEXISTANTE : refusée.
  BEGIN
    INSERT INTO admin.user_scopes (tenant_id, user_id, scope_type, scope_ref)
    VALUES (current_setting('test.tenant_a')::uuid, current_setting('test.user_a')::uuid,
            'department', gen_random_uuid());
    RAISE EXCEPTION 'scope_ref inconnu : aurait dû être refusé';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  -- Portée department vers l'unité du tenant B : refusée (mauvais tenant).
  BEGIN
    INSERT INTO admin.user_scopes (tenant_id, user_id, scope_type, scope_ref)
    VALUES (current_setting('test.tenant_a')::uuid, current_setting('test.user_a')::uuid,
            'department', current_setting('test.unit_b')::uuid);
    RAISE EXCEPTION 'scope_ref inter-tenant : aurait dû être refusé';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  -- Portée valide vers une unité réelle du bon tenant : acceptée.
  INSERT INTO admin.user_scopes (tenant_id, user_id, scope_type, scope_ref)
  VALUES (current_setting('test.tenant_a')::uuid, current_setting('test.user_a')::uuid,
          'department', current_setting('test.u_fin')::uuid);
END $$;

-- ---------- Statuts gardés ----------
DO $$
BEGIN
  UPDATE org.units SET status = 'inactive' WHERE id = current_setting('test.u_cpt')::uuid;
  UPDATE org.units SET status = 'active'   WHERE id = current_setting('test.u_cpt')::uuid;
  UPDATE org.units SET status = 'archived' WHERE id = current_setting('test.u_cpt')::uuid;
  BEGIN
    UPDATE org.units SET status = 'active' WHERE id = current_setting('test.u_cpt')::uuid;
    RAISE EXCEPTION 'archived est terminal : la réactivation aurait dû être refusée';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  -- Pas de suppression physique d'une entité (utilisée ou non).
  BEGIN
    DELETE FROM org.units WHERE id = current_setting('test.u_cpt')::uuid;
    RAISE EXCEPTION 'suppression d''unité : aurait dû être refusée';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

-- ---------- Isolation : B ne voit RIEN de A ----------
SET app.tenant_id = :'tenant_b';
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM org.units WHERE code LIKE 'D%' AND label_fr LIKE '%Générale%';
  IF n <> 0 THEN RAISE EXCEPTION 'isolation : B voit des unités de A'; END IF;
  SELECT count(*) INTO n FROM org.unit_parents;
  IF n <> 0 THEN RAISE EXCEPTION 'isolation : B voit % lien(s) hiérarchique(s) de A', n; END IF;
  SELECT count(*) INTO n FROM org.position_assignments;
  IF n <> 0 THEN RAISE EXCEPTION 'isolation : B voit % rattachement(s) de A', n; END IF;
  -- B ne peut pas écrire une ligne rattachée au tenant A (RLS WITH CHECK).
  BEGIN
    INSERT INTO org.units (tenant_id, unit_type, code, label_fr, label_en)
    VALUES (current_setting('test.tenant_a')::uuid, 'team', 'INTRUS', 'Intrus', 'Intruder');
    RAISE EXCEPTION 'isolation écriture : B a pu créer une unité chez A';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
