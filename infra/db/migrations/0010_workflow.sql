-- 0010 — Workflow Engine v1 (E3) : moteur d'approbation générique
-- Réf : Blueprint §14, PRD FR-WFE. Générique : aucun module métier ici, seulement un
-- objet de démonstration minimal (workflow.demo_requests) pour prouver le rattachement
-- instance ↔ demande et l'effet à l'approbation finale.

CREATE SCHEMA workflow;

-- ---------- Définitions versionnées ----------
-- Le contenu (steps) est figé dès que la définition quitte 'draft'. Une instance, en
-- plus, embarque un snapshot de ses étapes (voir instances.steps_snapshot) : double
-- garantie que « l'instance continue d'utiliser la version avec laquelle elle a démarré ».
CREATE TABLE workflow.definitions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES admin.tenants(id),
  key          text NOT NULL CHECK (key ~ '^[a-z0-9_]+$'),
  version      int  NOT NULL CHECK (version >= 1),
  status       text NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft', 'active', 'superseded', 'retired')),
  name         text NOT NULL,
  steps        jsonb NOT NULL,   -- [{index,name,approverType,approverRef,selfApprovalAllowed,slaHours,reminderHours,escalation,condition}]
  self_approval_default boolean NOT NULL DEFAULT false,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  CHECK (jsonb_typeof(steps) = 'array' AND jsonb_array_length(steps) >= 1),
  UNIQUE (tenant_id, key, version),
  UNIQUE (tenant_id, id)
);
-- Une seule version active par (tenant, key).
CREATE UNIQUE INDEX definitions_one_active
  ON workflow.definitions (tenant_id, key) WHERE status = 'active';
CREATE TRIGGER trg_definitions_touch BEFORE UPDATE ON workflow.definitions
  FOR EACH ROW EXECUTE FUNCTION admin.touch_updated_at();

-- Immuabilité rétroactive : hors 'draft', le contenu ne change plus ; seules des
-- transitions de statut contrôlées sont permises (draft→active, active→superseded,
-- active→retired, draft→retired). Aucune régression de statut.
CREATE FUNCTION workflow.guard_definition_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' THEN
    IF NEW.steps IS DISTINCT FROM OLD.steps
       OR NEW.key <> OLD.key
       OR NEW.version <> OLD.version
       OR NEW.name IS DISTINCT FROM OLD.name THEN
      RAISE EXCEPTION 'définition % v% (%): contenu figé hors draft', OLD.key, OLD.version, OLD.status
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;
  IF NEW.status <> OLD.status THEN
    IF NOT (
      (OLD.status = 'draft'  AND NEW.status IN ('active', 'retired')) OR
      (OLD.status = 'active' AND NEW.status IN ('superseded', 'retired')) OR
      (OLD.status = 'superseded' AND NEW.status = 'retired')
    ) THEN
      RAISE EXCEPTION 'transition de statut interdite : % -> %', OLD.status, NEW.status
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_definitions_guard BEFORE UPDATE ON workflow.definitions
  FOR EACH ROW EXECUTE FUNCTION workflow.guard_definition_update();

-- ---------- Instances ----------
CREATE TABLE workflow.instances (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES admin.tenants(id),
  definition_id      uuid NOT NULL,
  definition_key     text NOT NULL,
  definition_version int  NOT NULL,
  steps_snapshot     jsonb NOT NULL,          -- copie figée des étapes au démarrage
  subject_type       text NOT NULL,
  subject_id         uuid NOT NULL,
  status             text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'approved', 'rejected', 'returned', 'cancelled', 'expired')),
  current_step_index int NOT NULL DEFAULT 0,
  context            jsonb NOT NULL DEFAULT '{}',
  revision           int NOT NULL DEFAULT 0,  -- garde optimiste anti-double-transition
  delegated_to_user_id uuid,                  -- réassignation de l'étape courante (action delegate)
  step_entered_at    timestamptz NOT NULL DEFAULT now(),
  step_deadline      timestamptz,
  reminder_sent_at   timestamptz,
  escalated_at       timestamptz,
  created_by         uuid NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  decided_at         timestamptz,
  FOREIGN KEY (tenant_id, definition_id) REFERENCES workflow.definitions (tenant_id, id),
  UNIQUE (tenant_id, id)
);
CREATE INDEX instances_status_idx ON workflow.instances (tenant_id, status, step_deadline);
CREATE INDEX instances_subject_idx ON workflow.instances (tenant_id, subject_type, subject_id);
CREATE TRIGGER trg_instances_touch BEFORE UPDATE ON workflow.instances
  FOR EACH ROW EXECUTE FUNCTION admin.touch_updated_at();

-- ---------- Transitions (append-only) ----------
CREATE TABLE workflow.transitions (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  instance_id   uuid NOT NULL,
  seq           int  NOT NULL,               -- 1..N par instance
  action        text NOT NULL CHECK (action IN ('submit','approve','reject','return','cancel','delegate','remind','escalate')),
  from_status   text,
  to_status     text,
  step_index    int,
  actor_user_id uuid,
  on_behalf_of  uuid,                          -- « par X pour le compte de Y »
  comment       text,
  attachments   jsonb,                         -- [{name, documentId}]
  occurred_at   timestamptz NOT NULL DEFAULT now(),  -- horodatage serveur
  UNIQUE (tenant_id, instance_id, seq),
  FOREIGN KEY (tenant_id, instance_id) REFERENCES workflow.instances (tenant_id, id)
);
CREATE INDEX transitions_instance_idx ON workflow.transitions (tenant_id, instance_id, seq);

CREATE FUNCTION workflow.forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'workflow.transitions est append-only : % interdit', TG_OP
    USING ERRCODE = 'raise_exception';
END $$;
CREATE TRIGGER trg_transitions_immutable BEFORE UPDATE OR DELETE ON workflow.transitions
  FOR EACH ROW EXECUTE FUNCTION workflow.forbid_mutation();

-- ---------- Idempotence des actions ----------
CREATE TABLE workflow.action_idempotency (
  tenant_id       uuid NOT NULL,
  instance_id     uuid NOT NULL,
  idempotency_key text NOT NULL,
  transition_seq  int NOT NULL,
  result          jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instance_id, idempotency_key),
  FOREIGN KEY (tenant_id, instance_id) REFERENCES workflow.instances (tenant_id, id)
);

-- ---------- Délégations datées (Blueprint §14.3) ----------
CREATE TABLE workflow.delegations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES admin.tenants(id),
  from_user_id uuid NOT NULL,
  to_user_id   uuid NOT NULL,
  from_date    date NOT NULL,
  to_date      date NOT NULL CHECK (to_date >= from_date),
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, from_user_id) REFERENCES admin.users (tenant_id, id),
  FOREIGN KEY (tenant_id, to_user_id)   REFERENCES admin.users (tenant_id, id)
);
CREATE INDEX delegations_lookup_idx ON workflow.delegations (tenant_id, to_user_id, from_date, to_date);

-- ---------- Objet de démonstration minimal ----------
CREATE TABLE workflow.demo_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES admin.tenants(id),
  title       text NOT NULL,
  amount      numeric(14,2) NOT NULL DEFAULT 0,
  status      text NOT NULL DEFAULT 'draft'
              CHECK (status IN ('draft', 'pending', 'approved', 'rejected', 'cancelled')),
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

-- ---------- Permissions ----------
INSERT INTO admin.permissions (key, description) VALUES
  ('workflow.manage', 'Créer et gérer les définitions de workflow (versions, activation)'),
  ('workflow.submit', 'Soumettre une demande dans un workflow'),
  ('workflow.act',    'Agir sur une instance (approuver, rejeter, retourner, déléguer)'),
  ('workflow.view',   'Consulter les instances et leur historique')
ON CONFLICT (key) DO NOTHING;

-- ---------- RLS + privilèges (rôle applicatif borné au tenant) ----------
ALTER TABLE workflow.definitions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow.instances         ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow.transitions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow.action_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow.delegations       ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow.demo_requests     ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_rows ON workflow.definitions TO kora_app
  USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON workflow.instances TO kora_app
  USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON workflow.transitions TO kora_app
  USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON workflow.action_idempotency TO kora_app
  USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON workflow.delegations TO kora_app
  USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON workflow.demo_requests TO kora_app
  USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());

GRANT USAGE ON SCHEMA workflow TO kora_app;
-- definitions : pas de DELETE (retrait = statut 'retired').
GRANT SELECT, INSERT, UPDATE ON workflow.definitions TO kora_app;
GRANT SELECT, INSERT, UPDATE ON workflow.instances TO kora_app;
GRANT SELECT, INSERT ON workflow.transitions TO kora_app;         -- append-only
GRANT SELECT, INSERT ON workflow.action_idempotency TO kora_app;
GRANT SELECT, INSERT, DELETE ON workflow.delegations TO kora_app; -- révocable
GRANT SELECT, INSERT, UPDATE ON workflow.demo_requests TO kora_app;
