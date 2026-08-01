-- TEST 130 — Core HR : cycle de vie gardé (réintégration incluse), affectation
-- PRINCIPALE unique par période, FK inter-tenant rejetées par PostgreSQL, carrière
-- append-only, zones privées isolées par RLS, aucun DELETE, catalogue des permissions.
\set QUIET on
\set appurl `echo "$DATABASE_URL_APP"`

-- ---------- Catalogue (migrator) ----------
DO $$
BEGIN
  IF (SELECT count(*) FROM admin.permissions WHERE key IN
      ('employees.view','employees.view_private','employees.view_identifiers','employees.view_documents',
       'employees.manage','employees.assign','employees.view_history','employees.import')) <> 8 THEN
    RAISE EXCEPTION 'permissions employees.* incomplètes au catalogue';
  END IF;
END $$;

-- ---------- Fixtures (migrator) ----------
SELECT substr(md5(random()::text), 1, 8) AS rid \gset
INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('test-hr-a-' || :'rid', 'HR A', true) RETURNING id AS tenant_a \gset
INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('test-hr-b-' || :'rid', 'HR B', true) RETURNING id AS tenant_b \gset
-- Organisation minimale de B (cibles inter-tenant).
INSERT INTO org.companies (tenant_id, code, label_fr, label_en, status) VALUES (:'tenant_b', 'HRB-CO', 'B', 'B', 'active') RETURNING id AS co_b \gset
INSERT INTO org.units (tenant_id, unit_type, code, label_fr, label_en, status) VALUES (:'tenant_b', 'direction', 'HRB-DIR', 'B', 'B', 'active') RETURNING id AS unit_b \gset

\connect :"appurl"
\set QUIET on
SET app.tenant_id = :'tenant_a';
SET test.tenant_a = :'tenant_a';
SET test.tenant_b = :'tenant_b';
SET test.co_b = :'co_b';
SET test.unit_b = :'unit_b';

-- Organisation minimale de A.
INSERT INTO org.companies (tenant_id, code, label_fr, label_en, status) VALUES (:'tenant_a', 'HRA-CO', 'A', 'A', 'active') RETURNING id AS co_a \gset
INSERT INTO org.units (tenant_id, unit_type, code, label_fr, label_en, status) VALUES (:'tenant_a', 'direction', 'HRA-DIR', 'A', 'A', 'active') RETURNING id AS unit_a \gset
SET test.co_a = :'co_a';
SET test.unit_a = :'unit_a';

INSERT INTO core.employees (tenant_id, matricule, first_name, last_name, status, hire_date)
VALUES (:'tenant_a', 'HR-0001', 'Awa', 'Sossou', 'draft', '2026-01-01') RETURNING id AS emp \gset
SET test.emp = :'emp';

-- ---------- Cycle de vie gardé ----------
DO $$
DECLARE e uuid := current_setting('test.emp')::uuid;
BEGIN
  -- draft -> terminated : interdit (pas de raccourci).
  BEGIN
    UPDATE core.employees SET status = 'terminated' WHERE id = e;
    RAISE EXCEPTION 'cycle de vie : draft->terminated aurait dû être refusé';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  UPDATE core.employees SET status = 'pre_hire' WHERE id = e;
  UPDATE core.employees SET status = 'active' WHERE id = e;
  UPDATE core.employees SET status = 'on_leave' WHERE id = e;
  UPDATE core.employees SET status = 'active' WHERE id = e;
  UPDATE core.employees SET status = 'terminated' WHERE id = e;
  -- RÉINTÉGRATION : terminated -> active, permise (et auditée côté service).
  UPDATE core.employees SET status = 'active' WHERE id = e;
  -- Le matricule est immuable.
  BEGIN
    UPDATE core.employees SET matricule = 'HR-9999' WHERE id = e;
    RAISE EXCEPTION 'matricule : la modification aurait dû être refusée';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
END $$;

-- ---------- Affectations : principale unique, FK inter-tenant, close-only ----------
INSERT INTO core.employee_assignments (tenant_id, employee_id, company_id, unit_id, is_primary, effective_from)
VALUES (:'tenant_a', :'emp', :'co_a', :'unit_a', true, '2026-01-01') RETURNING id AS asg1 \gset
SET test.asg1 = :'asg1';

DO $$
DECLARE t uuid := current_setting('test.tenant_a')::uuid;
        e uuid := current_setting('test.emp')::uuid;
BEGIN
  -- DEUX affectations PRINCIPALES chevauchantes : refusées (EXCLUDE partiel).
  BEGIN
    INSERT INTO core.employee_assignments (tenant_id, employee_id, company_id, unit_id, is_primary, effective_from)
    VALUES (t, e, current_setting('test.co_a')::uuid, current_setting('test.unit_a')::uuid, true, '2026-03-01');
    RAISE EXCEPTION 'principale unique : le chevauchement aurait dû être refusé';
  EXCEPTION WHEN exclusion_violation THEN NULL;
  END;
  -- Une SECONDAIRE chevauchante est permise (pourcentage).
  INSERT INTO core.employee_assignments (tenant_id, employee_id, company_id, unit_id, is_primary, allocation_pct, effective_from)
  VALUES (t, e, current_setting('test.co_a')::uuid, current_setting('test.unit_a')::uuid, false, 20, '2026-03-01');
  -- FK inter-tenant : unité du tenant B refusée PAR LA BASE.
  BEGIN
    INSERT INTO core.employee_assignments (tenant_id, employee_id, company_id, unit_id, is_primary, effective_from)
    VALUES (t, e, current_setting('test.co_a')::uuid, current_setting('test.unit_b')::uuid, false, '2026-01-01');
    RAISE EXCEPTION 'FK inter-tenant : l''unité de B aurait dû être rejetée';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  -- Société du tenant B : refusée aussi.
  BEGIN
    INSERT INTO core.employee_assignments (tenant_id, employee_id, company_id, unit_id, is_primary, effective_from)
    VALUES (t, e, current_setting('test.co_b')::uuid, current_setting('test.unit_a')::uuid, false, '2026-01-01');
    RAISE EXCEPTION 'FK inter-tenant : la société de B aurait dû être rejetée';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;

-- Mutation PROPRE : clôture de la principale puis nouvelle ligne — l'histoire tient.
UPDATE core.employee_assignments SET effective_to = '2026-07-01' WHERE id = :'asg1';
INSERT INTO core.employee_assignments (tenant_id, employee_id, company_id, unit_id, is_primary, effective_from)
VALUES (:'tenant_a', :'emp', :'co_a', :'unit_a', true, '2026-07-01');
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM core.employee_assignments
   WHERE employee_id = current_setting('test.emp')::uuid AND is_primary
     AND daterange(effective_from, effective_to, '[)') @> DATE '2026-03-15';
  IF n <> 1 THEN RAISE EXCEPTION 'historique : la principale de mars doit rester consultable (%)', n; END IF;
  -- Ligne close figée (close-only) ; jamais de DELETE.
  BEGIN
    UPDATE core.employee_assignments SET unit_id = current_setting('test.unit_a')::uuid,
           effective_from = '2026-02-01' WHERE id = current_setting('test.asg1')::uuid;
    RAISE EXCEPTION 'close-only : la réécriture aurait dû être refusée';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  BEGIN
    DELETE FROM core.employee_assignments WHERE id = current_setting('test.asg1')::uuid;
    RAISE EXCEPTION 'suppression d''affectation : aurait dû être refusée';
  EXCEPTION WHEN insufficient_privilege OR raise_exception THEN NULL;
  END;
END $$;

-- ---------- Carrière : append-only ----------
INSERT INTO core.career_events (tenant_id, employee_id, event_type, effective_date, details)
VALUES (:'tenant_a', :'emp', 'hire', '2026-01-01', '{"status":"active"}');
DO $$
BEGIN
  BEGIN
    UPDATE core.career_events SET details = '{"falsifie":true}'
     WHERE employee_id = current_setting('test.emp')::uuid;
    RAISE EXCEPTION 'carrière : UPDATE aurait dû être refusé';
  EXCEPTION WHEN insufficient_privilege OR raise_exception THEN NULL;
  END;
  BEGIN
    DELETE FROM core.career_events WHERE employee_id = current_setting('test.emp')::uuid;
    RAISE EXCEPTION 'carrière : DELETE aurait dû être refusé';
  EXCEPTION WHEN insufficient_privilege OR raise_exception THEN NULL;
  END;
END $$;

-- ---------- Zones privées : présentes, contraintes, 1-1 ----------
INSERT INTO core.employee_private (tenant_id, employee_id, birth_date, nationality, personal_phone)
VALUES (:'tenant_a', :'emp', '1990-05-12', 'BJ', '+2290196000001');
INSERT INTO core.employee_identifiers (tenant_id, employee_id, cnss_number, id_document_type, id_document_number)
VALUES (:'tenant_a', :'emp', 'CNSS-HR-' || :'rid', 'cni', 'CNI-123456789');
DO $$
BEGIN
  BEGIN
    INSERT INTO core.employee_private (tenant_id, employee_id) VALUES
      (current_setting('test.tenant_a')::uuid, current_setting('test.emp')::uuid);
    RAISE EXCEPTION 'zone privée : le doublon 1-1 aurait dû être refusé';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;

-- ---------- Isolation : B ne voit RIEN (dossier, zones, affectations, carrière) ----------
SET app.tenant_id = :'tenant_b';
DO $$
DECLARE ne int; np int; ni int; na int; nc int;
BEGIN
  SELECT count(*) INTO ne FROM core.employees WHERE matricule = 'HR-0001';
  SELECT count(*) INTO np FROM core.employee_private;
  SELECT count(*) INTO ni FROM core.employee_identifiers;
  SELECT count(*) INTO na FROM core.employee_assignments;
  SELECT count(*) INTO nc FROM core.career_events;
  IF ne + np + ni + na + nc <> 0 THEN
    RAISE EXCEPTION 'isolation : B voit % dossier(s), % privé(s), % identifiant(s), % affectation(s), % événement(s)',
      ne, np, ni, na, nc;
  END IF;
  -- B ne peut pas écrire une zone privée rattachée au salarié de A (RLS WITH CHECK).
  BEGIN
    INSERT INTO core.employee_private (tenant_id, employee_id)
    VALUES (current_setting('test.tenant_a')::uuid, current_setting('test.emp')::uuid);
    RAISE EXCEPTION 'isolation écriture : B a pu créer une zone privée chez A';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
