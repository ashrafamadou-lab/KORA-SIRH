-- 0012 — Notification Engine (E5) : schéma notify
-- Réf : Blueprint §15 (notifications), PRD FR-NTF. Multi-canal extensible (in_app, email,
-- sms, push) SANS fournisseur payant branché : les canaux sortants passent par un
-- transport simulé (DEMO/TEST ONLY) tant qu'un fournisseur réel n'est pas contractualisé.
--
-- Invariants portés par CE fichier :
--  - modèles bilingues FR/EN versionnés : contenu figé hors 'draft', une seule version
--    active par (tenant, clé) — même discipline que les définitions de workflow ;
--  - idempotence : un événement métier porte une clé unique par tenant → le même
--    événement livré deux fois ne produit qu'UNE notification logique par destinataire ;
--  - file de livraison à états contrôlés : pending / processing / sent / failed /
--    cancelled / dead_letter — machine à états vérifiée par trigger ;
--  - journal des tentatives APPEND-ONLY et SANS CONTENU : jamais le sujet, le corps, ni
--    les variables du message — uniquement des métadonnées (canal, transport, issue,
--    erreur courte assainie). Aucun secret, jamais.
--  - préférences par canal : in_app est le socle (toujours livré, table contrainte aux
--    canaux sortants) ; les notifications obligatoires ignorent les préférences.

-- ---------- Langue de l'utilisateur (rendu FR/EN) ----------
ALTER TABLE admin.users
  ADD COLUMN locale text NOT NULL DEFAULT 'fr' CHECK (locale IN ('fr', 'en'));

CREATE SCHEMA notify;

-- ---------- Modèles versionnés bilingues ----------
CREATE TABLE notify.templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES admin.tenants(id),
  key         text NOT NULL CHECK (key ~ '^[a-z0-9_.]+$' AND char_length(key) <= 100),
  version     int  NOT NULL CHECK (version >= 1),
  status      text NOT NULL DEFAULT 'draft'
              CHECK (status IN ('draft', 'active', 'superseded', 'retired')),
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  -- Bilingue FR/EN : les deux langues sont OBLIGATOIRES (pas de modèle unilingue).
  subject_fr  text NOT NULL CHECK (char_length(subject_fr) BETWEEN 1 AND 200),
  subject_en  text NOT NULL CHECK (char_length(subject_en) BETWEEN 1 AND 200),
  body_fr     text NOT NULL CHECK (char_length(body_fr) BETWEEN 1 AND 4000),
  body_en     text NOT NULL CHECK (char_length(body_en) BETWEEN 1 AND 4000),
  -- Variables CONTRÔLÉES : liste fermée des noms autorisés dans les textes. Tout
  -- placeholder hors liste et toute valeur hors liste sont rejetés par le service.
  variables   jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(variables) = 'array'),
  -- Canaux du modèle : in_app est le socle obligatoire (feed = système de référence).
  channels    jsonb NOT NULL DEFAULT '["in_app"]'
              CHECK (jsonb_typeof(channels) = 'array'
                     AND jsonb_array_length(channels) >= 1
                     AND channels <@ '["in_app","email","sms","push"]'::jsonb
                     AND channels @> '["in_app"]'::jsonb),
  -- Obligatoire = non désactivable par préférence utilisateur.
  mandatory   boolean NOT NULL DEFAULT false,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  UNIQUE (tenant_id, key, version),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES admin.users (tenant_id, id)
);
CREATE UNIQUE INDEX templates_one_active
  ON notify.templates (tenant_id, key) WHERE status = 'active';
CREATE TRIGGER trg_templates_touch BEFORE UPDATE ON notify.templates
  FOR EACH ROW EXECUTE FUNCTION admin.touch_updated_at();

-- Contenu figé hors draft ; transitions de statut contrôlées, aucune régression.
CREATE FUNCTION notify.guard_template_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' THEN
    IF NEW.key <> OLD.key OR NEW.version <> OLD.version
       OR NEW.name IS DISTINCT FROM OLD.name
       OR NEW.subject_fr IS DISTINCT FROM OLD.subject_fr
       OR NEW.subject_en IS DISTINCT FROM OLD.subject_en
       OR NEW.body_fr IS DISTINCT FROM OLD.body_fr
       OR NEW.body_en IS DISTINCT FROM OLD.body_en
       OR NEW.variables IS DISTINCT FROM OLD.variables
       OR NEW.channels IS DISTINCT FROM OLD.channels
       OR NEW.mandatory IS DISTINCT FROM OLD.mandatory THEN
      RAISE EXCEPTION 'modèle % v% (%) : contenu figé hors draft', OLD.key, OLD.version, OLD.status
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;
  IF NEW.status <> OLD.status THEN
    IF NOT (
      (OLD.status = 'draft'      AND NEW.status IN ('active', 'retired')) OR
      (OLD.status = 'active'     AND NEW.status IN ('superseded', 'retired')) OR
      (OLD.status = 'superseded' AND NEW.status = 'retired')
    ) THEN
      RAISE EXCEPTION 'transition de statut interdite : % -> %', OLD.status, NEW.status
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_templates_guard BEFORE UPDATE ON notify.templates
  FOR EACH ROW EXECUTE FUNCTION notify.guard_template_update();

-- ---------- Événements (idempotence) ----------
-- Un événement = un fait métier unique par tenant (event_key). Rejouer la même clé ne
-- crée RIEN de nouveau (ON CONFLICT DO NOTHING côté service + contrainte ici). Le
-- payload contient UNIQUEMENT les variables contrôlées, déjà passées au filtre
-- anti-secrets du service — jamais de mot de passe, jeton, secret MFA ou donnée médicale.
CREATE TABLE notify.events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES admin.tenants(id),
  event_key        text NOT NULL CHECK (char_length(event_key) BETWEEN 1 AND 200),
  template_key     text NOT NULL,
  template_version int  NOT NULL,
  payload          jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload) = 'object'),
  source           text NOT NULL DEFAULT 'business' CHECK (source IN ('business', 'workflow', 'system')),
  subject_type     text,
  subject_id       uuid,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, event_key),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES admin.users (tenant_id, id)
);

CREATE FUNCTION notify.forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% est append-only : % interdit', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'raise_exception';
END $$;
CREATE TRIGGER trg_events_immutable BEFORE UPDATE OR DELETE ON notify.events
  FOR EACH ROW EXECUTE FUNCTION notify.forbid_mutation();

-- ---------- Notifications logiques (une par événement × destinataire) ----------
-- C'est la ligne que l'utilisateur consulte (in-app). L'unicité (event, user) est la
-- garantie d'idempotence côté destinataire. Le contenu est RENDU au moment de la
-- publication (langue du destinataire, variables contrôlées) : il ne change plus.
CREATE TABLE notify.notifications (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES admin.tenants(id),
  event_id         uuid NOT NULL,
  user_id          uuid NOT NULL,
  template_key     text NOT NULL,
  template_version int  NOT NULL,
  locale           text NOT NULL CHECK (locale IN ('fr', 'en')),
  subject          text NOT NULL,
  body             text NOT NULL,
  mandatory        boolean NOT NULL DEFAULT false,
  read_at          timestamptz,
  archived_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, event_id, user_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, event_id) REFERENCES notify.events (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id)  REFERENCES admin.users (tenant_id, id)
);
CREATE INDEX notifications_user_idx
  ON notify.notifications (tenant_id, user_id, created_at DESC);
CREATE TRIGGER trg_notifications_touch BEFORE UPDATE ON notify.notifications
  FOR EACH ROW EXECUTE FUNCTION admin.touch_updated_at();

-- Seul l'état de lecture/archivage évolue ; le contenu rendu est immuable.
CREATE FUNCTION notify.guard_notification_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.event_id <> OLD.event_id
     OR NEW.user_id <> OLD.user_id
     OR NEW.template_key <> OLD.template_key
     OR NEW.template_version <> OLD.template_version
     OR NEW.locale <> OLD.locale
     OR NEW.subject IS DISTINCT FROM OLD.subject
     OR NEW.body IS DISTINCT FROM OLD.body
     OR NEW.mandatory <> OLD.mandatory
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'notification : seuls read_at et archived_at sont modifiables'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_notifications_guard BEFORE UPDATE ON notify.notifications
  FOR EACH ROW EXECUTE FUNCTION notify.guard_notification_update();

-- ---------- File de livraison par canal ----------
-- Une livraison par (notification, canal). in_app est posée 'sent' immédiatement (le
-- feed EST la livraison) ; les canaux sortants démarrent 'pending' et suivent la machine
-- à états sous retries à backoff exponentiel, jusqu'à dead_letter à épuisement.
CREATE TABLE notify.deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES admin.tenants(id),
  notification_id uuid NOT NULL,
  channel         text NOT NULL CHECK (channel IN ('in_app', 'email', 'sms', 'push')),
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'cancelled', 'dead_letter')),
  attempt_count   int NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts    int NOT NULL CHECK (max_attempts >= 1),
  next_attempt_at timestamptz,
  -- Dernière erreur COURTE et ASSAINIE (scrub anti-secrets côté service) — jamais le contenu.
  last_error      text CHECK (last_error IS NULL OR char_length(last_error) <= 500),
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, notification_id, channel),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, notification_id) REFERENCES notify.notifications (tenant_id, id)
);
CREATE INDEX deliveries_due_idx
  ON notify.deliveries (tenant_id, next_attempt_at)
  WHERE status IN ('pending', 'failed');
CREATE TRIGGER trg_deliveries_touch BEFORE UPDATE ON notify.deliveries
  FOR EACH ROW EXECUTE FUNCTION admin.touch_updated_at();

-- Machine à états de livraison :
--   pending    → processing (prise en file) | cancelled (annulation admin)
--   processing → sent | failed (réessai planifié) | dead_letter (épuisement)
--   failed     → processing (réessai) | cancelled
--   dead_letter→ pending (requeue admin, compteur remis à zéro par le service)
--   cancelled  → pending (requeue admin)
--   sent       → TERMINAL (aucune sortie)
CREATE FUNCTION notify.guard_delivery_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id
     OR NEW.notification_id <> OLD.notification_id
     OR NEW.channel <> OLD.channel
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'livraison : identité immuable (notification, canal)'
      USING ERRCODE = 'raise_exception';
  END IF;
  IF NEW.status <> OLD.status THEN
    IF NOT (
      (OLD.status = 'pending'     AND NEW.status IN ('processing', 'cancelled')) OR
      (OLD.status = 'processing'  AND NEW.status IN ('sent', 'failed', 'dead_letter')) OR
      (OLD.status = 'failed'      AND NEW.status IN ('processing', 'cancelled')) OR
      (OLD.status = 'dead_letter' AND NEW.status = 'pending') OR
      (OLD.status = 'cancelled'   AND NEW.status = 'pending')
    ) THEN
      RAISE EXCEPTION 'transition de livraison interdite : % -> %', OLD.status, NEW.status
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_deliveries_guard BEFORE UPDATE ON notify.deliveries
  FOR EACH ROW EXECUTE FUNCTION notify.guard_delivery_update();

-- ---------- Journal des tentatives (append-only, SANS CONTENU) ----------
-- Volontairement AUCUNE colonne de contenu : ni sujet, ni corps, ni variables, ni
-- adresse complète. L'erreur est courte, tronquée et assainie par le service (scrub
-- anti-secrets). C'est la matérialisation de la contrainte de sécurité E5 : « aucun mot
-- de passe, jeton, secret MFA ou donnée médicale ne doit apparaître dans les logs ».
CREATE TABLE notify.delivery_attempts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  delivery_id   uuid NOT NULL,
  attempt_no    int  NOT NULL CHECK (attempt_no >= 1),
  channel       text NOT NULL CHECK (channel IN ('in_app', 'email', 'sms', 'push')),
  transport     text NOT NULL CHECK (transport ~ '^[a-z_]+$'),
  outcome       text NOT NULL CHECK (outcome IN ('sent', 'failed')),
  error_code    text CHECK (error_code IS NULL OR char_length(error_code) <= 100),
  error_message text CHECK (error_message IS NULL OR char_length(error_message) <= 300),
  attempted_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, delivery_id, attempt_no),
  FOREIGN KEY (tenant_id, delivery_id) REFERENCES notify.deliveries (tenant_id, id)
);
CREATE TRIGGER trg_attempts_immutable BEFORE UPDATE OR DELETE ON notify.delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION notify.forbid_mutation();

-- ---------- Préférences par canal ----------
-- Contrainte structurelle : SEULS les canaux sortants sont désactivables — in_app est le
-- socle (système de référence) et n'a pas de ligne possible ici. Les notifications
-- OBLIGATOIRES ignorent ces préférences (décision portée par le service, testée).
CREATE TABLE notify.preferences (
  tenant_id  uuid NOT NULL,
  user_id    uuid NOT NULL,
  channel    text NOT NULL CHECK (channel IN ('email', 'sms', 'push')),
  enabled    boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, channel),
  FOREIGN KEY (tenant_id, user_id) REFERENCES admin.users (tenant_id, id)
);
CREATE TRIGGER trg_preferences_touch BEFORE UPDATE ON notify.preferences
  FOR EACH ROW EXECUTE FUNCTION admin.touch_updated_at();

-- ---------- Permission ----------
INSERT INTO admin.permissions (key, description) VALUES
  ('notify.manage', 'Administrer les notifications : modèles, publication d''événements, file de livraison')
ON CONFLICT (key) DO NOTHING;

-- ---------- RLS + privilèges (rôle applicatif borné au tenant) ----------
ALTER TABLE notify.templates         ENABLE ROW LEVEL SECURITY;
ALTER TABLE notify.events            ENABLE ROW LEVEL SECURITY;
ALTER TABLE notify.notifications     ENABLE ROW LEVEL SECURITY;
ALTER TABLE notify.deliveries        ENABLE ROW LEVEL SECURITY;
ALTER TABLE notify.delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE notify.preferences       ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_rows ON notify.templates TO kora_app
  USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON notify.events TO kora_app
  USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON notify.notifications TO kora_app
  USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON notify.deliveries TO kora_app
  USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON notify.delivery_attempts TO kora_app
  USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());
CREATE POLICY tenant_rows ON notify.preferences TO kora_app
  USING (tenant_id = admin.current_tenant_id()) WITH CHECK (tenant_id = admin.current_tenant_id());

GRANT USAGE ON SCHEMA notify TO kora_app;
-- Pas de DELETE nulle part : retrait = statut ('retired', 'cancelled'), jamais l'effacement.
GRANT SELECT, INSERT, UPDATE ON notify.templates     TO kora_app;
GRANT SELECT, INSERT         ON notify.events        TO kora_app;  -- append-only
GRANT SELECT, INSERT, UPDATE ON notify.notifications TO kora_app;  -- update ⇒ lu/archivé seulement (trigger)
GRANT SELECT, INSERT, UPDATE ON notify.deliveries    TO kora_app;
GRANT SELECT, INSERT         ON notify.delivery_attempts TO kora_app;  -- append-only
GRANT SELECT, INSERT, UPDATE ON notify.preferences   TO kora_app;
