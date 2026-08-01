-- 0005 — Audit trail immuable à chaînage d'intégrité
-- Réf : Blueprint §15.2/§27, PRD US-E6-01. Append-only : ni UPDATE ni DELETE, pour
-- personne via l'application ; chaque ligne embarque le hash de la précédente (par
-- tenant), ce qui rend toute altération détectable.

CREATE TABLE audit.audit_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  occurred_at  timestamptz NOT NULL DEFAULT now(),      -- horodatage serveur, jamais client
  actor_user_id uuid,
  on_behalf_of uuid,                                    -- mode délégué (D5) : « par X pour le compte de Y »
  action       text NOT NULL,                           -- create / update / status_change / read_sensitive / export / login…
  module       text NOT NULL,
  record_type  text NOT NULL,
  record_id    text,
  employee_id  uuid,
  old_value    jsonb,
  new_value    jsonb,
  reason       text,
  workflow_ref uuid,
  ip           inet,
  device       text,
  prev_hash    text,
  row_hash     text NOT NULL
);
CREATE INDEX audit_log_tenant_time_idx ON audit.audit_log (tenant_id, occurred_at DESC);
CREATE INDEX audit_log_employee_idx    ON audit.audit_log (tenant_id, employee_id) WHERE employee_id IS NOT NULL;

-- Charge utile canonique d'une ligne (utilisée au calcul ET à la vérification).
CREATE FUNCTION audit.row_payload(r audit.audit_log) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT concat_ws('|',
    r.id::text, r.tenant_id::text,
    to_char(r.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    COALESCE(r.actor_user_id::text, ''), COALESCE(r.on_behalf_of::text, ''),
    r.action, r.module, r.record_type, COALESCE(r.record_id, ''),
    COALESCE(r.employee_id::text, ''),
    COALESCE(r.old_value::text, ''), COALESCE(r.new_value::text, ''),
    COALESCE(r.reason, ''), COALESCE(r.workflow_ref::text, ''))
$$;

-- Chaînage : hash(ligne N) = sha256(hash(ligne N-1) || payload(N)), chaîne par tenant.
-- Verrou consultatif transactionnel par tenant : sérialise les insertions concurrentes
-- d'un même tenant sans bloquer les autres.
CREATE FUNCTION audit.chain_hash() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_prev text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('audit:' || NEW.tenant_id::text));
  SELECT row_hash INTO v_prev
    FROM audit.audit_log
   WHERE tenant_id = NEW.tenant_id
   ORDER BY id DESC
   LIMIT 1;
  NEW.prev_hash := v_prev;                              -- NULL pour la première ligne du tenant
  NEW.row_hash  := encode(digest(COALESCE(v_prev, 'genesis') || audit.row_payload(NEW), 'sha256'), 'hex');
  RETURN NEW;
END $$;

CREATE TRIGGER trg_audit_chain BEFORE INSERT ON audit.audit_log
  FOR EACH ROW EXECUTE FUNCTION audit.chain_hash();

-- Immuabilité : refus structurel, quel que soit le rôle applicatif.
CREATE FUNCTION audit.forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit.audit_log est en append-only : % interdit', TG_OP
    USING ERRCODE = 'raise_exception';
END $$;

CREATE TRIGGER trg_audit_immutable BEFORE UPDATE OR DELETE ON audit.audit_log
  FOR EACH ROW EXECUTE FUNCTION audit.forbid_mutation();

-- Vérification d'intégrité de la chaîne d'un tenant : retourne les lignes corrompues
-- (0 ligne = chaîne intacte). Utilisée par les tests et, plus tard, par un job planifié.
CREATE FUNCTION audit.verify_chain(p_tenant uuid)
RETURNS TABLE (id bigint, expected_hash text, stored_hash text)
LANGUAGE sql STABLE AS $$
  WITH ordered AS (
    SELECT a.id,
           a.prev_hash,
           a.row_hash,
           a AS rec,
           LAG(a.row_hash) OVER (ORDER BY a.id) AS computed_prev
      FROM audit.audit_log a
     WHERE a.tenant_id = p_tenant
  )
  SELECT id,
         encode(digest(COALESCE(computed_prev, 'genesis') || audit.row_payload(rec), 'sha256'), 'hex'),
         row_hash
    FROM ordered
   WHERE row_hash <> encode(digest(COALESCE(computed_prev, 'genesis') || audit.row_payload(rec), 'sha256'), 'hex')
      OR COALESCE(prev_hash, '∅') <> COALESCE(computed_prev, '∅')
$$;
