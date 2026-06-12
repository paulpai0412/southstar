#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

docker build \
  -f docker/pi-agent/Dockerfile \
  -t southstar/pi-agent:local \
  .
