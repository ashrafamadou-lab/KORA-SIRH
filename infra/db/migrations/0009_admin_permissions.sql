-- 0009 — Catalogue de permissions : administration des utilisateurs et des sessions
-- (clôture E1/E2). Le catalogue est global (référentiel) ; les rôles restent par tenant.

INSERT INTO admin.permissions (key, description) VALUES
  ('users.view',         'Consulter les comptes utilisateurs de sa portée'),
  ('users.create',       'Créer un compte utilisateur'),
  ('users.edit',         'Activer / désactiver un compte utilisateur'),
  ('users.manage_roles', 'Affecter ou retirer des rôles — borné aux permissions que l''acteur possède lui-même'),
  ('sessions.revoke',    'Révoquer administrativement les sessions d''un utilisateur')
ON CONFLICT (key) DO NOTHING;
