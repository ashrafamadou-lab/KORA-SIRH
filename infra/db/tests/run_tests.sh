#!/usr/bin/env bash
# Harnais de tests du socle de données — psql pur.
# Chaque fichier NN_*.sql est un test autonome : il démarre connecté en kora_migrator
# (fixtures), bascule lui-même vers kora_app via \connect pour les assertions RLS, et
# échoue à la première exception (ON_ERROR_STOP). Les assertions sont des blocs DO qui
# RAISE EXCEPTION quand la réalité ne correspond pas à l'attendu.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export DATABASE_URL_MIGRATOR="${DATABASE_URL_MIGRATOR:-postgres://kora_migrator:kora_migrator_dev@127.0.0.1:5432/kora}"
export DATABASE_URL_APP="${DATABASE_URL_APP:-postgres://kora_app:kora_app_dev@127.0.0.1:5432/kora}"
# Optionnelle : requise seulement par le test de détection de falsification (50_*),
# qui doit désactiver temporairement un trigger (superutilisateur) puis ROLLBACK.
export DATABASE_URL_SUPER="${DATABASE_URL_SUPER:-}"

pass=0; fail=0; skip=0
for f in "$DIR"/[0-9][0-9]*_*.sql; do
  base="$(basename "$f")"
  if [[ "$base" == 50_* && -z "$DATABASE_URL_SUPER" ]]; then
    echo "SKIP  $base (DATABASE_URL_SUPER non défini)"
    skip=$((skip + 1))
    continue
  fi
  if out="$(psql "$DATABASE_URL_MIGRATOR" -qX -v ON_ERROR_STOP=1 -f "$f" 2>&1)"; then
    echo "PASS  $base"
    pass=$((pass + 1))
  else
    echo "FAIL  $base"
    echo "$out" | sed 's/^/      /'
    fail=$((fail + 1))
  fi
done

echo "----------------------------------------"
echo "Tests : $pass réussi(s), $fail échoué(s), $skip ignoré(s)"
[[ $fail -eq 0 ]] || exit 1
