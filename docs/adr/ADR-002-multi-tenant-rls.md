# ADR-002 — Multi-tenant : base partagée + Row-Level Security PostgreSQL

**Statut** : accepté et **prouvé par spike** (01/08/2026) — décisions D1/D2

## Contexte

D1 impose le multi-tenant dès le premier jour (déployé d'abord pour un client) ; D2
retient la base partagée avec `tenant_id` + RLS plutôt qu'une base par client. Le risque
n° 1 d'un SIRH mutualisé est la fuite inter-tenant sur des données RH sensibles.

## Décision

- `tenant_id uuid NOT NULL` sur toute table métier ; FK **composites**
  `(tenant_id, id)` entre tables métier pour rendre les références inter-tenant
  impossibles au niveau relationnel.
- RLS activée sur toutes les tables métier ; politiques `TO kora_app` bornées à
  `admin.current_tenant_id()`, lu depuis le GUC `app.tenant_id`.
- Deux rôles PostgreSQL : `kora_migrator` (propriétaire, migrations/seeds uniquement)
  et `kora_app` (**NOBYPASSRLS**, non propriétaire, moindre privilège, pas de DELETE) —
  seul rôle utilisé par l'application.
- La couche applicative pose le tenant par `SET LOCAL app.tenant_id = '<uuid>'` au début
  de chaque transaction (middleware — incrément 2). Sans contexte : zéro ligne visible.
- Cas particulier : `compliance.legal_parameters` accepte `tenant_id NULL` (profil pays,
  lisible par tous les tenants, modifiable uniquement par le processus privilégié).

## Résultat du spike (exécuté, reproductible : `npm run db:test`)

`infra/db/tests/10_rls_isolation.sql` — vert : lecture bornée au tenant, table
`tenants` réduite à sa propre ligne, INSERT inter-tenant rejeté (42501), UPDATE
inter-tenant sans effet (0 ligne), aucun contexte → aucune ligne, bascule de tenant
correcte. Défense en profondeur vérifiée dans `40_parameters.sql` : demander une
résolution « pour » un autre tenant ne révèle jamais ses surcharges.

## Conséquences

- L'isolation ne dépend pas de la discipline du code applicatif : une requête oubliant
  le `WHERE tenant_id` reste bornée par la base.
- L'option « schéma dédié par grand compte » (D2) reste ouverte : rien ici ne l'empêche.
- Le pool de connexions devra poser/nettoyer le GUC par transaction (SET LOCAL), jamais
  par session partagée.
