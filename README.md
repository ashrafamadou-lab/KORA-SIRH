# KORA — SIRH d'entreprise pour le Bénin

Monolithe modulaire multi-tenant (React/NestJS/PostgreSQL cible), conçu Blueprint-first.
Références produit : Blueprint v1.0 (validé D8), PRD MVP v1.1, Backlog v1.1, Registre
juridique v2. Règle non négociable : **aucune règle légale codée en dur** — tout
paramètre est daté, sourcé, versionné, et inactif tant qu'un juriste identifié ne l'a
pas contresigné.

## État du repo — honnêteté d'abord

**Incrément 1 : socle de données — livré, testé, CI GitHub validée (run vert du 01/08/2026, artefacts publiés).**
**Incrément 2 (en cours) : auth E1 — domaine pur testé localement ; tranche API à prouver par la CI au prochain push.**

| Composant | État |
|---|---|
| Migrations SQL-first + runner à ledger (checksums) | ✅ Testé (rejeu idempotent, ×2 env. vierge + CI GitHub) |
| Multi-tenant RLS (D1/D2) : isolation lecture/écriture, rôle app NOBYPASSRLS | ✅ Testé (`10_…`) |
| Historisation salariale anti-chevauchement, unicités par tenant, FK composites | ✅ Testé (`20_…`) |
| Audit trail append-only à hash chaîné + détection de falsification | ✅ Testé (`30_…`, `50_…`) |
| Parameter Engine : versions datées, statuts, résolution à la date de l'événement | ✅ Testé (`40_…`) |
| Seed : 16 rôles, 2 tenants DEMO, 18 paramètres Bénin **en draft** (contreseing requis) | ✅ Appliqué |
| Auth — schéma (sessions, verrouillage, resolve_tenant) — migration 0007 | ✅ Testé (`60_…`) |
| `@kora/core` — domaine pur : TOTP (vecteurs RFC 6238), politique mdp, verrouillage progressif, jetons de session, RBAC anti-élévation | ✅ 19 tests node:test verts (zéro dépendance) |
| `@kora/api` — NestJS + Prisma (RLS par set_config) : login/me/logout, verrouillage **atomique** (UPDATE relatif), sessions liées à `is_active` (désactivation ⇒ révocation immédiate), audit. **Règle transactionnelle** : les refus sont des résultats métier (`success` / `invalid_credentials` / `locked` / `denied`) — la transaction committe compteurs, verrous, audits et révocations AVANT que l'exception HTTP ne soit levée | ⚠ Écrit + e2e fournis — **preuve = job CI `api`** |
| **MFA TOTP — socle technique uniquement** : colonnes en base (0007) + primitives `@kora/core` validées contre la RFC 6238. AUCUN contrôle MFA au login tant que l'enrôlement, la vérification au login, la récupération et la désactivation ne sont pas livrés de bout en bout | ⛔ NOT IMPLEMENTED côté API |
| **RBAC — logique de domaine uniquement** : résolution testée dans `@kora/core` (anti-élévation). Aucun guard API ne charge encore rôles, permissions et portées depuis la base | ⛔ NOT IMPLEMENTED côté API |
| OpenAPI, Workflow/Notification engines (services), Frontend PWA | ⛔ NOT IMPLEMENTED — incréments suivants / Phase 2-3 |
| CI GitHub Actions | ✅ `db-socle` validé sur GitHub ; jobs `core` et `api` (actions v6/v7, **Node ≥ 22.18 épinglé**) |
| Lockfile npm (`package-lock.json`) | ⚠ **Requis committé à la racine avant la CI** (le job `api` refuse de tourner sans, puis `npm ci` exclusivement — aucune écriture de la CI sur `main`). Génération : `npm install --package-lock-only` à la racine sur un poste avec accès registre, ou workflow manuel « Générer le lockfile » (artefact à committer soi-même) |

## Structure

```text
apps/api/    API NestJS : Prisma (rôle kora_app, withTenant/set_config), auth E1, e2e node:test
packages/core/  domaine pur zéro dépendance (TOTP, mdp, lockout, jetons, RBAC) + tests
infra/
  docker-compose.yml       Postgres 16 + Redis + MinIO + Mailpit (dev)
  db/
    migrations/            0001→0006 : schémas, RBAC, core, paramètres, audit, RLS
    seed/seed_dev.sql      rôles seed, tenants DEMO, paramètres Bénin (draft)
    migrate.sh · seed.sh   runner SQL-first (ledger meta.schema_migrations)
    tests/                 suite psql pure — run_tests.sh
docs/adr/    ADR-001 → ADR-004 (architecture, multi-tenant, données, audit)
```

## Démarrage rapide

```bash
# 1. Base de données (Docker) — crée rôles + base via docker-init
docker compose -f infra/docker-compose.yml up -d postgres
# (sans Docker : créer les rôles/base comme dans infra/db/docker-init/01_roles_db.sql)

# 2. Migrations + seed + tests
npm run db:migrate
npm run db:seed
npm run db:test        # 5 fichiers, dont détection de falsification si DATABASE_URL_SUPER est défini
```

Variables : voir `.env.example`. Le rôle applicatif est `kora_app` (NOBYPASSRLS) ; toute
transaction applicative doit poser `SET LOCAL app.tenant_id = '<uuid>'` — sans contexte,
la base ne rend **aucune** ligne.

## Principes intangibles (Blueprint)

Correctness > Sécurité > Intégrité des données > Configurabilité légale > Usabilité >
Performance > Polish. Suppression logique partout (`deleted_at`) ; l'audit est
append-only ; les périodes clôturées sont immuables ; l'IA (Phase 7) propose, l'humain
décide.
