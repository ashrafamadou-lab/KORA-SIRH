-- TEST 10 — Isolation multi-tenant par RLS (décisions D1/D2, PRD US-E2-02)
-- Démarre en kora_migrator (fixtures), assertions en kora_app.
\set QUIET on
\set appurl `echo "$DATABASE_URL_APP"`
\set migurl `echo "$DATABASE_URL_MIGRATOR"`

-- ---------- Fixtures (migrator, hors RLS) ----------
SELECT substr(md5(random()::text), 1, 8) AS rid \gset
INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('test-rls-a-' || :'rid', 'Test RLS A', true) RETURNING id AS tenant_a \gset
INSERT INTO admin.tenants (slug, name, is_demo) VALUES ('test-rls-b-' || :'rid', 'Test RLS B', true) RETURNING id AS tenant_b \gset
INSERT INTO core.employees (tenant_id, matricule, first_name, last_name) VALUES
  (:'tenant_a', 'A-0001', 'Awa',   'Sossou'),
  (:'tenant_a', 'A-0002', 'Kofi',  'Dossou'),
  (:'tenant_b', 'B-0001', 'Chidi', 'Okafor');

-- ---------- Assertions (kora_app) ----------
\connect :"appurl"
\set QUIET on
SET app.tenant_id = :'tenant_a';
SET test.tenant_a = :'tenant_a';
SET test.tenant_b = :'tenant_b';

-- Le tenant A voit exactement ses 2 salariés, et seulement les siens.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM core.employees WHERE matricule LIKE 'A-%' OR matricule LIKE 'B-%';
  IF n <> 2 THEN RAISE EXCEPTION 'RLS lecture : attendu 2 salariés visibles pour A, obtenu %', n; END IF;
  PERFORM 1 FROM core.employees WHERE tenant_id = current_setting('test.tenant_b')::uuid;
  IF FOUND THEN RAISE EXCEPTION 'RLS lecture : une ligne du tenant B est visible depuis A'; END IF;
END $$;

-- La table tenants ne montre que son propre tenant.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM admin.tenants;
  IF n <> 1 THEN RAISE EXCEPTION 'RLS tenants : attendu 1 ligne visible, obtenu %', n; END IF;
END $$;

-- Écriture inter-tenant refusée (WITH CHECK) : insérer chez B en étant A.
DO $$
BEGIN
  BEGIN
    INSERT INTO core.employees (tenant_id, matricule, first_name, last_name)
    VALUES (current_setting('test.tenant_b')::uuid, 'B-9999', 'Intrus', 'Intrus');
    RAISE EXCEPTION 'RLS écriture : l''insertion inter-tenant aurait dû être refusée';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL; -- 42501 « new row violates row-level security policy » : attendu
  END;
END $$;

-- UPDATE inter-tenant : les lignes de B sont invisibles → 0 ligne affectée.
DO $$
DECLARE n int;
BEGIN
  UPDATE core.employees SET first_name = 'Pirate'
   WHERE tenant_id = current_setting('test.tenant_b')::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'RLS update : % ligne(s) du tenant B modifiée(s) depuis A', n; END IF;
END $$;

-- Sans tenant posé : aucune ligne, nulle part.
RESET app.tenant_id;
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM core.employees;
  IF n <> 0 THEN RAISE EXCEPTION 'RLS sans contexte : % ligne(s) visibles sans app.tenant_id', n; END IF;
END $$;

-- Bascule vers B : B ne voit que sa ligne.
SET app.tenant_id = :'tenant_b';
DO $$
DECLARE n int; m text;
BEGIN
  SELECT count(*), min(matricule) INTO n, m FROM core.employees;
  IF n <> 1 OR m <> 'B-0001' THEN
    RAISE EXCEPTION 'RLS bascule : attendu 1 salarié B-0001, obtenu % (%)', n, m;
  END IF;
END $$;
