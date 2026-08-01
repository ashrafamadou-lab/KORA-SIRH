# ADR-004 — Audit trail append-only à chaînage d'intégrité

**Statut** : accepté et prouvé par tests (01/08/2026) — Blueprint §15.2/§27

## Contexte

L'audit trail est une exigence contractuelle du produit (qui/quoi/quand/sur qui/
ancienne/nouvelle valeur/pourquoi/approuvé par qui), opposable en audit social. Il doit
résister y compris à un acteur disposant de droits élevés.

## Décision

- Table `audit.audit_log` en **append-only structurel** : trigger `forbid_mutation`
  (UPDATE/DELETE → exception, y compris pour le propriétaire du schéma) + absence de
  grant UPDATE/DELETE pour `kora_app`.
- **Chaînage par tenant** : `row_hash = sha256(prev_hash || payload_canonique)` calculé
  par trigger BEFORE INSERT, sérialisé par verrou consultatif transactionnel par tenant
  (pas de course, pas de blocage inter-tenant).
- `audit.verify_chain(tenant)` retourne les lignes dont le hash ne se recalcule pas ou
  dont le lien est rompu — 0 ligne = chaîne intacte. À brancher en job planifié
  (Compliance Center) dans les incréments suivants.
- Champ `on_behalf_of` : traçabilité native du mode délégué (décision D5).

## Preuves (exécutées)

- `30_audit_chain.sql` : chaîne liée et recalculable ; UPDATE/DELETE refusés pour
  l'application **et** pour le propriétaire.
- `50_audit_tamper_detection.sql` : falsification simulée en superutilisateur (trigger
  désactivé, ligne altérée) → détectée par `verify_chain` ; transaction annulée.

## Limites assumées

Un superutilisateur peut réécrire une ligne **et** son hash ; la parade est
opérationnelle (accès superutilisateur restreint et journalisé côté infra) plus, en
production, l'export scellé périodique du dernier hash de chaîne vers un stockage
externe (WORM) — inscrit au backlog de la Phase 5 (Compliance Center).
