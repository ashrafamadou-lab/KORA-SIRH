-- 0013 — Consultation de l'audit trail (E6) : colonnes de recherche, index, vérification
-- d'intégrité bornée, permissions de vue différenciées.
-- Réf : Blueprint §15.2/§27, PRD US-E6. Le journal reste STRICTEMENT append-only : cette
-- migration n'expose AUCUNE capacité de correction, suppression ou recalcul de chaîne.
--
-- Décision d'intégrité (documentée, assumée) : `result` et `correlation_id` rejoignent
-- le même étage que `ip` et `device` — des MÉTADONNÉES DE TRANSPORT hors du payload de
-- hachage (audit.row_payload est une liste EXPLICITE de colonnes, inchangée ici). Toutes
-- les chaînes existantes restent donc valides à l'octet près, et verify_chain reste
-- l'autorité. Contrepartie honnête : ces deux colonnes ne sont pas couvertes par la
-- preuve d'intégrité — comme ip/device depuis l'origine. Les colonnes PROBANTES
-- (acteur, action, valeurs, horodatage…) restent toutes chaînées.

-- ---------- Colonnes de recherche ----------
ALTER TABLE audit.audit_log
  ADD COLUMN result text CHECK (result IS NULL OR result IN ('success', 'denied', 'failure')),
  ADD COLUMN correlation_id uuid;

-- ---------- Index de consultation (volumes réels, filtres du sponsor) ----------
-- Curseur stable par id décroissant, borné tenant (RLS) :
CREATE INDEX audit_log_tenant_id_idx      ON audit.audit_log (tenant_id, id DESC);
CREATE INDEX audit_log_tenant_module_idx  ON audit.audit_log (tenant_id, module, id DESC);
CREATE INDEX audit_log_tenant_actor_idx   ON audit.audit_log (tenant_id, actor_user_id, id DESC);
CREATE INDEX audit_log_tenant_record_idx  ON audit.audit_log (tenant_id, record_type, record_id);
CREATE INDEX audit_log_tenant_corr_idx    ON audit.audit_log (tenant_id, correlation_id)
  WHERE correlation_id IS NOT NULL;

-- ---------- Vérification d'intégrité BORNÉE et continuable ----------
-- verify_chain(uuid) (0005) reste l'autorité en vérification complète ; ici, la version
-- segmentée protège l'API des requêtes trop coûteuses : elle vérifie AU PLUS p_limit
-- lignes à partir de p_after_id, en repartant du hash p_seed fourni par l'appelant
-- (NULL = début de chaîne). La continuation est cryptographiquement sûre : le hash de
-- reprise vient du SEGMENT PRÉCÉDEMMENT VÉRIFIÉ, pas de la table — une falsification
-- cohérente du stockage ne peut donc pas passer entre deux segments.
-- Sous kora_app, la RLS borne la lecture au tenant courant : passer le tenant d'un
-- autre ne révèle rien (0 ligne vérifiée).
CREATE FUNCTION audit.verify_chain_segment(
  p_tenant   uuid,
  p_after_id bigint,
  p_seed     text,
  p_limit    int,
  OUT broken_id bigint,
  OUT checked   int,
  OUT last_id   bigint,
  OUT last_hash text
) RETURNS record
LANGUAGE plpgsql STABLE AS $$
DECLARE
  r      audit.audit_log%ROWTYPE;
  v_prev text := p_seed;   -- NULL = genèse
BEGIN
  broken_id := NULL;
  checked   := 0;
  last_id   := COALESCE(p_after_id, 0);
  last_hash := p_seed;
  FOR r IN
    SELECT * FROM audit.audit_log
     WHERE tenant_id = p_tenant AND id > COALESCE(p_after_id, 0)
     ORDER BY id
     LIMIT GREATEST(1, LEAST(p_limit, 20000))
  LOOP
    IF COALESCE(r.prev_hash, '∅') <> COALESCE(v_prev, '∅')
       OR r.row_hash <> encode(digest(COALESCE(v_prev, 'genesis') || audit.row_payload(r), 'sha256'), 'hex') THEN
      broken_id := r.id;
      RETURN;
    END IF;
    v_prev    := r.row_hash;
    checked   := checked + 1;
    last_id   := r.id;
    last_hash := v_prev;
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION audit.verify_chain_segment(uuid, bigint, text, int) TO kora_app;

-- ---------- Permissions de consultation différenciées ----------
-- Trois niveaux (conditions sponsor E6) : audit global du tenant, audit d'un module,
-- audit limité à l'utilisateur. Les clés par module suivent les modules RÉELLEMENT
-- écrits par l'application ('auth' par défaut de audit.util, puis les modules nommés).
INSERT INTO admin.permissions (key, description) VALUES
  ('audit.view',             'Consulter l''audit trail de tout le tenant (lecture seule)'),
  ('audit.export',           'Exporter le journal d''audit filtré (CSV/JSON) — export lui-même audité'),
  ('audit.view_own',         'Consulter uniquement ses propres événements d''audit'),
  ('audit.view_auth',        'Consulter l''audit du module auth'),
  ('audit.view_admin_users', 'Consulter l''audit du module admin_users'),
  ('audit.view_workflow',    'Consulter l''audit du module workflow'),
  ('audit.view_config',      'Consulter l''audit du module config'),
  ('audit.view_notify',      'Consulter l''audit du module notify'),
  ('audit.view_audit',       'Consulter l''audit du module audit (traces de consultation/export)')
ON CONFLICT (key) DO NOTHING;
