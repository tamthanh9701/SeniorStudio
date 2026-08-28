#!/bin/sh
set -eu
architecture="$(uname -m)"
case "$architecture" in
  x86_64|amd64)
    export BRIDGE_DOCKERFILE=bridge/Dockerfile
    ;;
  aarch64|arm64)
    export BRIDGE_DOCKERFILE=bridge/Dockerfile.arm64
    ;;
  *)
    echo "Unsupported ZimaOS architecture: $architecture" >&2
    exit 1
    ;;
esac
exec docker compose -f docker-compose.zimaos.yml up --build "$@"
