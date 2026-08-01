#!/usr/bin/env bash
# Applique le seed de développement (kora_migrator). Idempotent.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
URL="${DATABASE_URL_MIGRATOR:-postgres://kora_migrator:kora_migrator_dev@127.0.0.1:5432/kora}"
psql "$URL" -qX -v ON_ERROR_STOP=1 -f "$DIR/seed/seed_dev.sql"
psql "$URL" -qXtA -c "SELECT 'Seed appliqué. Paramètres en draft (inactifs, contreseing requis) : ' || count(*) FROM compliance.legal_parameters WHERE status = 'draft'"
