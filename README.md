# KORA — SIRH d'entreprise pour le Bénin

Monolithe modulaire multi-tenant (React/NestJS/PostgreSQL cible), conçu Blueprint-first.
Références produit : Blueprint v1.0 (validé D8), PRD MVP v1.1, Backlog v1.1, Registre
juridique v2. Règle non négociable : **aucune règle légale codée en dur** — tout
paramètre est daté, sourcé, versionné, et inactif tant qu'un juriste identifié ne l'a
pas contresigné.

## État du repo — honnêteté d'abord

**Incrément 1 (Phase 1) : socle de données — LIVRÉ ET TESTÉ.**

| Composant | État |
|---|---|
| Migrations SQL-first + runner à ledger (checksums) | ✅ Testé (rejeu idempotent) |
| Multi-tenant RLS (D1/D2) : isolation lecture/écriture, rôle app NOBYPASSRLS | ✅ Testé (`10_…`) |
| Historisation salariale anti-chevauchement, unicités par tenant, FK composites | ✅ Testé (`20_…`) |
| Audit trail append-only à hash chaîné + détection de falsification | ✅ Testé (`30_…`, `50_…`) |
| Parameter Engine : versions datées, statuts, résolution à la date de l'événement | ✅ Testé (`40_…`) |
| Seed : 16 rôles, 2 tenants DEMO, 18 paramètres Bénin **en draft** (contreseing requis) | ✅ Appliqué |
| Application NestJS (auth, RBAC service, workflow, notifications, API/OpenAPI) | ⛔ NOT IMPLEMENTED — incréments 2+ |
| Frontend PWA | ⛔ NOT IMPLEMENTED — Phase 2/3 |
| CI GitHub Actions | ⚠ Rédigée, à valider au premier push |

## Structure

```text
apps/        (vide) applications — api NestJS et web PWA aux incréments suivants
packages/    (vide) types et validations partagés
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
