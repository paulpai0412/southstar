#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="/home/timmypai/.local/bin:${PATH}"
export TORK_DATASTORE_TYPE="${TORK_DATASTORE_TYPE:-postgres}"
export TORK_CONFIG="${TORK_CONFIG:-${repo_root}/.tools/tork/southstar.config.toml}"

exec tork run standalone
