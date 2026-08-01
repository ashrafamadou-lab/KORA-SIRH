-- TEST 80 — Workflow Engine : immuabilité, une seule active, append-only, isolation
\set QUIET on
\set appurl `echo "$DATABASE_URL_APP"`

-- ---------- Fixtures (migrator) ----------
SELECT substr(md5(random()::text), 1, 8) AS rid \gset
INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('test-wf-a-' || :'rid', 'WF A', true) RETURNING id AS tenant_a \gset
INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('test-wf-b-' || :'rid', 'WF B', true) RETURNING id AS tenant_b \gset

\connect :"appurl"
\set QUIET on
SET app.tenant_id = :'tenant_a';
SET test.tenant_a = :'tenant_a';
SET test.tenant_b = :'tenant_b';

-- Créer une définition draft, l'activer.
INSERT INTO workflow.definitions (tenant_id, key, version, name, steps)
VALUES (:'tenant_a', 'demo', 1, 'Démo v1',
        '[{"index":0,"name":"Manager","approverType":"role","approverRef":"manager"}]'::jsonb)
RETURNING id AS def1 \gset

UPDATE workflow.definitions SET status = 'active', activated_at = now() WHERE id = :'def1';

-- Immuabilité : le contenu d'une définition active ne peut plus changer.
SET test.def1 = :'def1';
DO $$
BEGIN
  BEGIN
    UPDATE workflow.definitions
       SET steps = '[{"index":0,"name":"Altéré","approverType":"user","approverRef":"x"}]'::jsonb
     WHERE id = current_setting('test.def1')::uuid;
    RAISE EXCEPTION 'immuabilité : la modification d''une définition active aurait dû être refusée';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
END $$;

-- Transition de statut interdite (active -> draft).
DO $$
BEGIN
  BEGIN
    UPDATE workflow.definitions SET status = 'draft' WHERE id = current_setting('test.def1')::uuid;
    RAISE EXCEPTION 'régression de statut active->draft aurait dû être refusée';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
END $$;

-- Une seule version active par (tenant, key) : activer une v2 sans superséder la v1 échoue.
INSERT INTO workflow.definitions (tenant_id, key, version, name, steps)
VALUES (:'tenant_a', 'demo', 2, 'Démo v2',
        '[{"index":0,"name":"Manager","approverType":"role","approverRef":"manager"}]'::jsonb)
RETURNING id AS def2 \gset
SET test.def2 = :'def2';
DO $$
BEGIN
  BEGIN
    UPDATE workflow.definitions SET status = 'active', activated_at = now() WHERE id = current_setting('test.def2')::uuid;
    RAISE EXCEPTION 'deux versions actives simultanées auraient dû être refusées';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;
-- En supersédant d'abord la v1, l'activation de la v2 passe.
UPDATE workflow.definitions SET status = 'superseded' WHERE id = :'def1';
UPDATE workflow.definitions SET status = 'active', activated_at = now() WHERE id = :'def2';

-- Instance sur la v2 : elle embarque un SNAPSHOT des étapes (indépendance de version).
INSERT INTO workflow.demo_requests (tenant_id, title, amount) VALUES (:'tenant_a', 'Demande test', 5000) RETURNING id AS req \gset
INSERT INTO workflow.instances
  (tenant_id, definition_id, definition_key, definition_version, steps_snapshot, subject_type, subject_id, created_by)
  VALUES (:'tenant_a', :'def2', 'demo', 2,
          (SELECT steps FROM workflow.definitions WHERE id = :'def2'),
          'demo_request', :'req', gen_random_uuid())
RETURNING id AS inst \gset
SET test.inst = :'inst';

INSERT INTO workflow.transitions (tenant_id, instance_id, seq, action, from_status, to_status, step_index)
VALUES (:'tenant_a', :'inst', 1, 'submit', NULL, 'pending', 0);

-- Append-only : ni UPDATE ni DELETE sur les transitions.
-- Refus par privilège (pas de grant UPDATE/DELETE) ET par trigger (défense en profondeur).
DO $$
BEGIN
  BEGIN
    UPDATE workflow.transitions SET comment = 'falsifié' WHERE instance_id = current_setting('test.inst')::uuid;
    RAISE EXCEPTION 'append-only : UPDATE aurait dû être refusé';
  EXCEPTION WHEN insufficient_privilege OR raise_exception THEN NULL;
  END;
  BEGIN
    DELETE FROM workflow.transitions WHERE instance_id = current_setting('test.inst')::uuid;
    RAISE EXCEPTION 'append-only : DELETE aurait dû être refusé';
  EXCEPTION WHEN insufficient_privilege OR raise_exception THEN NULL;
  END;
END $$;

-- Le snapshot survit au retrait de la définition (retire la v2 → l'instance garde ses étapes).
UPDATE workflow.definitions SET status = 'retired' WHERE id = :'def2';
DO $$
DECLARE n int;
BEGIN
  SELECT jsonb_array_length(steps_snapshot) INTO n
    FROM workflow.instances WHERE id = current_setting('test.inst')::uuid;
  IF n <> 1 THEN RAISE EXCEPTION 'snapshot : étapes perdues après retrait (%)', n; END IF;
END $$;

-- Isolation : le tenant B ne voit ni la définition ni l'instance de A.
SET app.tenant_id = :'tenant_b';
DO $$
DECLARE nd int; ni int; nt int;
BEGIN
  SELECT count(*) INTO nd FROM workflow.definitions;
  SELECT count(*) INTO ni FROM workflow.instances;
  SELECT count(*) INTO nt FROM workflow.transitions;
  IF nd <> 0 OR ni <> 0 OR nt <> 0 THEN
    RAISE EXCEPTION 'isolation : B voit % def, % inst, % transitions de A', nd, ni, nt;
  END IF;
END $$;

-- B ne peut pas insérer une transition rattachée à l'instance de A (RLS + FK).
SET test.inst = :'inst';
SET test.tenant_a = :'tenant_a';
DO $$
BEGIN
  BEGIN
    INSERT INTO workflow.transitions (tenant_id, instance_id, seq, action, to_status)
    VALUES (current_setting('test.tenant_a')::uuid, current_setting('test.inst')::uuid, 2, 'approve', 'approved');
    RAISE EXCEPTION 'isolation écriture : B a pu écrire une transition sur A';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
