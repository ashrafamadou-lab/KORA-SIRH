# ADR-001 — Monolithe modulaire API-first (pas de microservices)

**Statut** : accepté (Blueprint v1.0 §11, validé par D8 le 01/08/2026)

## Contexte

KORA couvre ~35 modules RH pour 50 → 50 000 salariés, avec une paie qui exige des
transactions ACID strictes, une équipe de taille réaliste et un déploiement en Afrique
de l'Ouest.

## Décision

Un monolithe modulaire conteneurisé, découpé en bounded contexts à frontières strictes
(core, time, payroll, compliance, audit…), communiquant par interfaces internes et
événements de domaine — jamais par appels directs pour les effets de bord. API REST
publique unique et versionnée (`/api/v1`), consommée à l'identique par le frontend et
les futurs intégrateurs.

## Conséquences

- Les transactions de paie restent ACID sans sagas distribuées.
- Un module (ex. moteur de paie) reste extractible plus tard : ses frontières sont des
  interfaces + événements, pas des imports croisés.
- La discipline de frontières est portée par la revue de code et la structure du repo
  (`apps/api/src/modules/<context>`) — à outiller en lint à l'incrément 2.
