# KORA — SIRH d'entreprise pour le Bénin

Monolithe modulaire multi-tenant (React/NestJS/PostgreSQL cible), conçu Blueprint-first.
Références produit : Blueprint v1.0 (validé D8), PRD MVP v1.1, Backlog v1.1, Registre
juridique v2. Règle non négociable : **aucune règle légale codée en dur** — tout
paramètre est daté, sourcé, versionné, et inactif tant qu'un juriste identifié ne l'a
pas contresigné.

## État du repo — honnêteté d'abord

**Incréments 1 à 3 validés (socle de données, auth E1/E2 + clôture, E3 Workflow Engine, E4 Config Center) — CI verte, artefacts publiés.**
**E5 (SHA 13ae258c, run 30701148520) et E6 (SHA 12c0dc37, run 30702827791) validés. Tranche courante : E8 Organisation — livré, à prouver par la CI au prochain push. Séquence restante : E9 Core HR puis E7 PWA/i18n.**

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
| **MFA TOTP de bout en bout** (tranche 2) : enrôlement → activation avec preuve de possession → exigé au login (TOTP ou code de récupération à usage unique, consommation atomique) → rotation → désactivation ; secret scellé AES-256-GCM (`KORA_MFA_KEY`), 8 codes hachés. Limite v1 assumée : pas d'anti-rejeu TOTP dans la fenêtre de 90 s | ⚠ Écrit + e2e — **preuve = job CI `api`** |
| **RBAC branché sur la base** (tranche 2) : `PermissionsGuard` charge `user_roles → role_permissions` + `user_scopes` et évalue avec `@kora/core` (`can`, anti-élévation) ; premier endpoint protégé `GET /employees` (session + permission + RLS = trois barrières). Portée fine par cible : module Organisation | ⚠ Écrit + e2e — **preuve = job CI `api`** |
| **OpenAPI** : spécification 3.0.3 servie sur `/api/v1/openapi.json` — maintenue à la main (zéro dépendance ajoutée, lockfile intact) ; génération `@nestjs/swagger` planifiée avec la prochaine vague de dépendances | ⚠ Servie + e2e |
| **Rate limiting du login** : fenêtre glissante par identité (10/min) et par IP (100/min), 429 + Retry-After AVANT toute transaction ; état mémoire v1 (Redis au passage multi-instances) | ⚠ Écrit + e2e |
| **Clôture E1/E2** (tranche courte) : sessions actives (métadonnées, **jamais de jeton**), révocation d'une session / des autres / administrative ; changement de mot de passe (ancien vérifié, politique `@kora/core`, compromission `off`/`local`/`hibp` avec fail-open/closed **documenté et testé**, **révoque les autres sessions**) ; **API admin** `/admin/users` (créer, activer, désactiver ⇒ révocation totale, affecter des rôles **bornés aux permissions de l'acteur** — anti-élévation, révoquer sessions) — RBAC réel + audit obligatoire | ⚠ Écrit + e2e (négatifs : inter-tenant, escalade, session révoquée réutilisée, mdp non autorisé) |
| **Workflow Engine v1** (E3) : définitions versionnées immuables, instances à snapshot (version figée), branches conditionnelles, submit/approve/reject/return/cancel/delegate, approbateurs role/user/manager/scope, anti-auto-approbation, échéances+escalades (tick), transitions append-only, idempotence + verrou anti-double-transition | ✅ core+SQL+e2e, CI verte |
| **Config Center API** (E4) : cycle de vie draft→submitted→approved→(active\|scheduled)→superseded / rejected / retired ; contreseing **via le Workflow Engine** (décision liée à la version exacte) ; séparation création/vérification/activation (créateur ≠ activateur pour juridique) ; résolution temporelle passé/présent/futur ; supersession sans réécriture d'historique ; anti-chevauchement ; surcharges tenant (RLS : global lisible/surchargeacble, jamais réécrit) ; preview d'impact ; permissions ordinaires vs juridiques sensibles | ✅ core+SQL+e2e, CI verte |
| **Notification Engine** (E5) : in-app + architecture multi-canal extensible (email/sms/push en file, **transport SIMULÉ — aucun fournisseur payant branché**) ; modèles bilingues FR/EN versionnés (contenu figé hors draft, une seule version active) ; variables contrôlées (inconnues/manquantes rejetées AVANT envoi) ; **filtre anti-secrets** (noms interdits : mot de passe/jeton/MFA/médical ; valeurs à forme de secret refusées ; journaux assainis SANS contenu) ; idempotence par clé d'événement (2 livraisons = 1 notification logique) ; file `pending/processing/sent/failed/cancelled/dead_letter` + retries à backoff + requeue/cancel admin ; destinataires user/rôle/portée/approbateur ; préférences par canal sortant (in_app = socle), **notifications obligatoires non désactivables** ; pont Workflow Engine (approbateur, demandeur, escalade, délégataire) ; audit admin ; OpenAPI | ✅ migration 0012 + test SQL 100, core notify (61 tests), 17 e2e — **preuve = CI** |
| **Consultation d'audit** (E6) : API 100 % LECTURE (aucune route d'écriture ; la base refuse UPDATE/DELETE par trigger + absence de grant) ; recherche période/acteur/action/module/type/id/résultat/corrélation/salarié ; **pagination par curseur stable** (id) insensible aux insertions ; vues différenciées par permission (`audit.view` global, `audit.view_<module>`, `audit.view_own`) — les filtres INTERSECTENT le périmètre, jamais ne l'élargissent ; **masquage systématique** (clés secrètes ⇒ ‹masqué›, feuilles texte scrubées — API, exports ET traces) ; **intégrité de chaîne** `valid/broken/unverified` bornée et reprenable cryptographiquement (seed du segment précédent), **aucune réparation possible** ; export CSV (RFC 4180 + anti-injection tableur + BOM) / JSON plafonné, borné à la visibilité, permission `audit.export` ; consultations sensibles, vérifications et exports **eux-mêmes audités** ; `result`/`correlation_id` ajoutés HORS payload de hachage (statut métadonnées comme ip/device — chaînes existantes intactes, décision documentée) | ✅ migration 0013 + test SQL 110, core audit-view (71 tests au total), 14 e2e (falsification détectée, volume 3000+) — **preuve = CI** |
| **Organisation** (E8) : référentiel complet DANS le tenant (sociétés/entités juridiques ≠ tenant, sites, centres de coûts, emplois, unités direction→équipe, postes) — codes uniques immuables par tenant, libellés FR/EN obligatoires, statuts `draft→active⇄inactive→archived` gardés (archived terminal) ; **hiérarchies DATÉES** (unités, rattachements de poste, ligne managériale — UN seul parent applicable à une date par EXCLUDE gist) avec règle **close-only** : une réorganisation clôt la période et ouvre une ligne, l'histoire ne se réécrit JAMAIS ; **FK composites (tenant_id, id) partout : l'inter-tenant est rejeté PAR POSTGRESQL** ; anti-cycles (unités + postes) par trigger à la date ; organigramme à une date ; **portées RBAC réelles** (scope_ref validé contre l'organisation, première évaluation `can()` PAR CIBLE sur le déplacement d'unité) ; changements sensibles **via workflow E3** (pending_changes, appliqué à l'approbation, `conflict` géré) + **notifications E5** par portée ; désactivation sans orphelins (409 children_active), **aucune suppression physique** ; **import CSV atomique** (preview/apply, rapport d'erreurs par ligne, zéro insertion partielle, références par code = zéro croisement inter-tenant) ; audit old/new (chaîné, masqué par E6) ; OpenAPI | ✅ migration 0014 + test SQL 120, core org (81 tests au total), 16 e2e — **preuve = CI** |
| Frontend PWA | ⛔ NOT IMPLEMENTED — Phase 2-3 |
| CI GitHub Actions | ✅ `db-socle` validé sur GitHub ; jobs `core` et `api` (actions v6/v7, **Node ≥ 22.18 épinglé**) |
| Lockfile npm (`package-lock.json`) | ⚠ **Requis committé à la racine avant la CI** (le job `api` refuse de tourner sans, puis `npm ci` exclusivement — aucune écriture de la CI sur `main`). Génération : `npm install --package-lock-only` à la racine sur un poste avec accès registre, ou workflow manuel « Générer le lockfile » (artefact à committer soi-même) |

## Structure

```text
apps/api/    API NestJS : Prisma (rôle kora_app, withTenant/set_config), auth, workflow, config, notify, e2e node:test
packages/core/  domaine pur zéro dépendance (TOTP, mdp, lockout, jetons, RBAC, workflow, notify) + tests
infra/
  docker-compose.yml       Postgres 16 + Redis + MinIO + Mailpit (dev)
  db/
    migrations/            0001→0014 : schémas, RBAC, core, paramètres, audit, RLS, auth, workflow, config, notify, consultation d'audit, organisation
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
