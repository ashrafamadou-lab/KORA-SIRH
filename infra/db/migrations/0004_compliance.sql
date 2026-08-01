-- 0004 — Parameter Engine : paramètres légaux datés, sourcés, versionnés
-- Réf : Blueprint §8.3, PRD US-E4-01/02/04, Registre juridique v2 (rien d'actif sans
-- contreseing). Schéma : Parameter | Value | Country | Effective | Source | Verified | Status.

CREATE TABLE compliance.legal_parameters (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL = paramètre de profil pays (global) ; sinon surcharge propre au tenant.
  tenant_id      uuid REFERENCES admin.tenants(id),
  country_code   char(2) NOT NULL DEFAULT 'BJ',
  key            text NOT NULL CHECK (key ~ '^[a-z0-9_]+(\.[a-z0-9_]+)+$'),
  value          jsonb NOT NULL,
  unit           text,
  effective_from date NOT NULL,
  effective_to   date CHECK (effective_to IS NULL OR effective_to > effective_from),
  -- Traçabilité de la source — obligatoire dès le statut « active » (règle D8).
  source_text    text,
  source_url     text,
  confidence     text NOT NULL DEFAULT 'unverified'
                 CHECK (confidence IN ('unverified', 'low', 'medium', 'high', 'verified')),
  verified_by    text,
  verified_at    date,
  status         text NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft', 'active', 'superseded')),
  legal_ref      text,                       -- réf du registre juridique (ex. TRV-06)
  notes          text,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  -- Un paramètre actif exige source + vérificateur : le contreseing est structurel.
  CONSTRAINT active_requires_source CHECK (
    status <> 'active'
    OR (source_text IS NOT NULL AND verified_by IS NOT NULL AND verified_at IS NOT NULL)
  ),
  -- Anti-chevauchement des versions actives d'un même paramètre sur une même portée.
  CONSTRAINT parameter_no_overlap EXCLUDE USING gist (
    key WITH =,
    country_code WITH =,
    COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
    daterange(effective_from, effective_to, '[)') WITH &&
  ) WHERE (status = 'active' AND deleted_at IS NULL)
);
CREATE INDEX legal_parameters_lookup_idx
  ON compliance.legal_parameters (key, country_code, status, effective_from DESC);
CREATE TRIGGER trg_legal_parameters_touch BEFORE UPDATE ON compliance.legal_parameters
  FOR EACH ROW EXECUTE FUNCTION admin.touch_updated_at();

-- LE contrat du moteur (US-E4-02) : « la valeur en vigueur à la date de l'événement »,
-- jamais la valeur courante. Priorité : surcharge tenant > profil pays. STABLE : le
-- recalcul d'une période passée redonne exactement le même résultat.
CREATE FUNCTION compliance.parameter_value_at(
  p_key     text,
  p_country char(2),
  p_tenant  uuid,
  p_date    date
) RETURNS TABLE (
  parameter_id   uuid,
  value          jsonb,
  unit           text,
  scope          text,
  effective_from date,
  effective_to   date,
  source_text    text,
  legal_ref      text,
  confidence     text
)
LANGUAGE sql STABLE AS $$
  SELECT id,
         value,
         unit,
         CASE WHEN tenant_id IS NULL THEN 'country' ELSE 'tenant' END,
         effective_from,
         effective_to,
         source_text,
         legal_ref,
         confidence
    FROM compliance.legal_parameters
   WHERE key = p_key
     AND country_code = p_country
     AND status = 'active'
     AND deleted_at IS NULL
     AND (tenant_id IS NULL OR tenant_id = p_tenant)
     AND daterange(effective_from, effective_to, '[)') @> p_date
   ORDER BY (tenant_id IS NOT NULL) DESC, effective_from DESC
   LIMIT 1
$$;

-- Rapport « paramètres non vérifiés / expirants » (US-E4-04) — alimente le Compliance
-- Center et le blocage en production.
CREATE VIEW compliance.parameters_requiring_attention AS
SELECT id, tenant_id, country_code, key, status, confidence,
       effective_from, effective_to, legal_ref,
       CASE
         WHEN status = 'draft' THEN 'draft_awaiting_countersign'
         WHEN status = 'active' AND confidence <> 'verified' THEN 'active_unverified'
         WHEN status = 'active' AND effective_to IS NOT NULL
              AND effective_to <= (now()::date + 90) THEN 'expiring_within_90d'
       END AS attention_reason
  FROM compliance.legal_parameters
 WHERE deleted_at IS NULL
   AND (
     status = 'draft'
     OR (status = 'active' AND confidence <> 'verified')
     OR (status = 'active' AND effective_to IS NOT NULL AND effective_to <= (now()::date + 90))
   );
