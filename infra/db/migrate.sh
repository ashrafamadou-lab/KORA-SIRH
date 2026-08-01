#!/usr/bin/env bash
# Runner de migrations SQL-first (ADR-003) — zéro dépendance : bash + psql.
# - Migrations ordonnées NNNN_description.sql, appliquées une seule fois, en transaction.
# - Checksum SHA-256 : une migration déjà appliquée ne peut plus être modifiée
#   (on corrige EN AVANT avec une nouvelle migration, jamais en réécrivant).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
URL="${DATABASE_URL_MIGRATOR:-postgres://kora_migrator:kora_migrator_dev@127.0.0.1:5432/kora}"

psql "$URL" -qX -v ON_ERROR_STOP=1 -c "
  CREATE SCHEMA IF NOT EXISTS meta;
  CREATE TABLE IF NOT EXISTS meta.schema_migrations (
    filename   text PRIMARY KEY,
    checksum   text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  );"

ran=0
for f in "$DIR"/migrations/*.sql; do
  base="$(basename "$f")"
  sum="$(sha256sum "$f" | cut -d' ' -f1)"
  existing="$(psql "$URL" -qXtA -v ON_ERROR_STOP=1 \
    -c "SELECT checksum FROM meta.schema_migrations WHERE filename = '$base'")"
  if [[ -n "$existing" ]]; then
    if [[ "$existing" != "$sum" ]]; then
      echo "ERREUR : $base a été modifiée après application (checksum différent)." >&2
      exit 1
    fi
    continue
  fi
  echo "→ $base"
  psql "$URL" -qX -v ON_ERROR_STOP=1 --single-transaction \
    -f "$f" \
    -c "INSERT INTO meta.schema_migrations (filename, checksum) VALUES ('$base', '$sum')"
  ran=$((ran + 1))
done

if [[ $ran -eq 0 ]]; then echo "Aucune migration en attente."; else echo "$ran migration(s) appliquée(s)."; fi
