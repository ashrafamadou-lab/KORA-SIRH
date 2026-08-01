# ADR-003 — Stratégie de données : migrations SQL-first, outillage sans dépendance

**Statut** : accepté pour le socle (01/08/2026) ; choix de l'ORM applicatif confirmé à
l'incrément 2

## Contexte

Le Blueprint (§11.3) laissait « Prisma ou TypeORM » à trancher après spike RLS. Le cœur
du sujet s'est déplacé : ce qui rend KORA sûr (RLS, contraintes d'exclusion, triggers de
chaînage, checks de contreseing, grants par colonne) **n'est exprimable proprement qu'en
SQL**. Par ailleurs, l'environnement de construction de cet incrément n'avait pas accès
aux registres de paquets — l'outillage du socle devait fonctionner sans dépendance.

## Décision

1. **La vérité du schéma est en SQL** : migrations versionnées immuables
   (`infra/db/migrations/NNNN_*.sql`), appliquées par un runner minimal (`migrate.sh`,
   bash + psql, ledger `meta.schema_migrations` avec checksum SHA-256 — toute
   modification d'une migration appliquée est refusée ; on corrige en avant).
2. **Les invariants vivent dans la base**, pas seulement dans l'application :
   anti-chevauchement (btree_gist), FK composites anti-inter-tenant, append-only audité,
   `active_requires_source` (un paramètre légal actif sans source/vérificateur est
   impossible — règle D8 rendue structurelle).
3. **Tests du socle en psql pur** (`infra/db/tests/`) : ce qui est livré est exactement
   ce qui a été exécuté ; aucun runtime requis au-delà du client PostgreSQL.
4. **ORM applicatif** : Prisma reste pressenti pour la couche NestJS (sûreté de types),
   utilisé en mode *introspection* du schéma SQL (`prisma db pull`) — jamais comme
   source des migrations. Confirmation par test d'intégration réel à l'incrément 2
   (critère : `SET LOCAL app.tenant_id` par transaction via l'API client, requêtes de
   paie complexes en SQL brut typé).

## Conséquences

- Un DBA peut auditer l'intégralité du modèle de sécurité en lisant six fichiers SQL.
- Le runner est trivial (≈ 60 lignes de bash) : rien à maintenir, portable CI/local.
- Si Prisma déçoit à l'incrément 2, le coût de bascule est faible : le schéma et les
  invariants n'appartiennent à aucun ORM.
