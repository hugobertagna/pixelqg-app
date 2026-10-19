#!/usr/bin/env sh
# PixelQG launcher for macOS / Linux.
# First time: chmod +x start.sh   then: ./start.sh   (extra options are passed through, e.g. ./start.sh --demo)

cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  Node.js est introuvable."
  echo "  Installe Node.js 20 ou plus récent depuis https://nodejs.org puis relance ce script."
  echo ""
  exit 1
fi

exec node server/server.js --open "$@"
