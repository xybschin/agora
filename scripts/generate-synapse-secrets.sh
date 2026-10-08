#!/usr/bin/env sh
# Generates the dev Synapse's secrets as files under docker/matrix/synapse/,
# which homeserver.yaml reads through its *_path options. That directory is
# gitignored apart from the two config files, so the values never reach the
# repository (agora-eni.11).
#
# The files are written from inside the Synapse image: Synapse takes ownership
# of its data directory (uid 991) on first boot, so the host user can neither
# write nor delete there. They are left mode 0644 because Synapse reads them as
# uid 991 and bootstrap reads registration_shared_secret as you; keep the
# checkout on a machine only you use.
#
# Idempotent: an existing file is kept, because rotating a secret by accident
# changes what the running homeserver accepts. To rotate one on purpose, name
# it -- `--rotate registration_shared_secret` -- and restart Synapse after.
#
# Usage: scripts/generate-synapse-secrets.sh [--rotate <name>...]
set -eu
cd "$(dirname "$0")/.."

ROTATE=""
if [ "${1:-}" = "--rotate" ]; then
  shift
  [ "$#" -gt 0 ] || { echo "--rotate needs at least one secret name" >&2; exit 1; }
  for name in "$@"; do
    case "$name" in
      registration_shared_secret|macaroon_secret_key|form_secret) ROTATE="$ROTATE $name" ;;
      *) echo "unknown secret: $name" >&2; exit 1 ;;
    esac
  done
elif [ "$#" -gt 0 ]; then
  echo "usage: $0 [--rotate <name>...]" >&2
  exit 1
fi

docker compose -f docker-compose.infra.yml run --rm --no-deps -e ROTATE="$ROTATE" --entrypoint sh synapse -c '
  for name in $ROTATE; do
    rm -f "/data/$name"
    echo "removed $name for rotation"
  done
  for name in registration_shared_secret macaroon_secret_key form_secret; do
    file="/data/$name"
    if [ -s "$file" ]; then
      echo "keeping existing $name"
    else
      python -c "import secrets; print(secrets.token_hex(32), end=\"\")" > "$file"
      chmod 0644 "$file"
      echo "generated $name"
    fi
  done
'
