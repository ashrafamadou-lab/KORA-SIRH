-- 0003 — Dossier salarié (minimal) et historisation salariale
-- Réf : Blueprint §12.1 (historisation par conception), §12.3 (salary_history),
-- PRD US-E9-01/02/05. Le dossier complet arrive avec l'incrément « Core HR » ;
-- ces tables posent les patrons structurants (unicités par tenant, anti-chevauchement,
-- suppression logique, FK composites anti-fuite inter-tenant).

CREATE TABLE core.employees (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES admin.tenants(id),
  matricule    text NOT NULL,
  first_name   text NOT NULL,
  last_name    text NOT NULL,
  birth_date   date CHECK (birth_date IS NULL OR birth_date < now()::date),
  cnss_number  text,          -- format à valider (CNS-06) : contrôle applicatif paramétrable, pas de regex en dur
  status       text NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'probation', 'suspended', 'long_leave', 'exited')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  UNIQUE (tenant_id, matricule),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX employees_cnss_unique
  ON core.employees (tenant_id, cnss_number)
  WHERE cnss_number IS NOT NULL AND deleted_at IS NULL;   -- doublon CNSS (US-E9-02)
CREATE TRIGGER trg_employees_touch BEFORE UPDATE ON core.employees
  FOR EACH ROW EXECUTE FUNCTION admin.touch_updated_at();

-- Lien optionnel 1–1 User ↔ Employee (Employee ≠ User, Blueprint §13).
ALTER TABLE admin.users ADD COLUMN employee_id uuid;
ALTER TABLE admin.users ADD CONSTRAINT users_employee_fk
  FOREIGN KEY (tenant_id, employee_id) REFERENCES core.employees(tenant_id, id);
CREATE UNIQUE INDEX users_employee_unique
  ON admin.users (tenant_id, employee_id)
  WHERE employee_id IS NOT NULL AND deleted_at IS NULL;

-- Historisation salariale : « le contrat et l'affectation portent la vérité » (§12.1).
-- Jamais d'écrasement : une ligne par période de validité ; effective_to NULL = courant.
-- Le bulletin de janvier référencera la ligne valide en janvier — pour toujours.
CREATE TABLE core.salary_history (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES admin.tenants(id),
  employee_id    uuid NOT NULL,
  amount         numeric(14,2) NOT NULL CHECK (amount >= 0),
  currency       char(3) NOT NULL DEFAULT 'XOF',
  effective_from date NOT NULL,
  effective_to   date CHECK (effective_to IS NULL OR effective_to > effective_from),
  reason         text NOT NULL DEFAULT 'hire'
                 CHECK (reason IN ('hire', 'increment', 'promotion', 'adjustment', 'correction')),
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  FOREIGN KEY (tenant_id, employee_id) REFERENCES core.employees(tenant_id, id),
  -- Anti-chevauchement : deux salaires ne peuvent coexister sur la même période (§12.3).
  CONSTRAINT salary_no_overlap EXCLUDE USING gist (
    tenant_id   WITH =,
    employee_id WITH =,
    daterange(effective_from, effective_to, '[)') WITH &&
  ) WHERE (deleted_at IS NULL)
);
CREATE INDEX salary_history_employee_idx ON core.salary_history (tenant_id, employee_id, effective_from DESC);
