#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
canonical_root="$(git -C "${repo_root}" rev-parse --show-toplevel 2>/dev/null || echo "${repo_root}")"
export PATH="/home/timmypai/.local/bin:${PATH}"
export TORK_DATASTORE_TYPE="${TORK_DATASTORE_TYPE:-postgres}"

if [[ -z "${TORK_CONFIG:-}" ]]; then
  if [[ -f "${repo_root}/.tools/tork/southstar.config.toml" ]]; then
    export TORK_CONFIG="${repo_root}/.tools/tork/southstar.config.toml"
  elif [[ -f "${canonical_root}/.tools/tork/southstar.config.toml" ]]; then
    export TORK_CONFIG="${canonical_root}/.tools/tork/southstar.config.toml"
  else
    export TORK_CONFIG="${repo_root}/.tools/tork/southstar.config.toml"
  fi
fi

if [[ "${TORK_DATASTORE_TYPE}" == "postgres" && -z "${TORK_DATASTORE_POSTGRES_DSN:-}" ]]; then
  default_dsn="${SOUTHSTAR_TEST_ADMIN_DATABASE_URL:-postgres://postgres:postgres@127.0.0.1:55432/postgres}"
  if [[ "${default_dsn}" == *"sslmode="* ]]; then
    export TORK_DATASTORE_POSTGRES_DSN="${default_dsn}"
  elif [[ "${default_dsn}" == *"?"* ]]; then
    export TORK_DATASTORE_POSTGRES_DSN="${default_dsn}&sslmode=disable"
  else
    export TORK_DATASTORE_POSTGRES_DSN="${default_dsn}?sslmode=disable"
  fi
fi

exec tork run standalone
