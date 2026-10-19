#!/bin/bash
# PixelQG for macOS (experimental: never tested on a real Mac). Double-click it in the Finder:
# Terminal opens, PixelQG starts in its own window, and quitting that window (Cmd+Q) or closing
# the Terminal window stops PixelQG and its agents.
# First time, macOS may refuse an unsigned script: right-click > Ouvrir. If it is not executable:
#   chmod +x launcher/PixelQG.command
# It runs start.sh (finds Node.js, ./runtime/node first, starts the server, opens the window,
# stops the server on exit). Works next to start.sh or one folder below it (launcher/).

HERE="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$HERE/start.sh" ]; then
  APP_DIR="$HERE"
else
  APP_DIR="$(dirname "$HERE")"
fi
if [ ! -f "$APP_DIR/start.sh" ] || [ ! -f "$APP_DIR/server/server.js" ]; then
  echo ""
  echo "  Je ne trouve pas le dossier de PixelQG (start.sh et server/)."
  echo "  Garde PixelQG.command dans le dossier de PixelQG, puis relance-le."
  echo ""
  printf '  Appuie sur Entrée pour fermer cette fenêtre.'
  read -r _
  exit 1
fi
export PIXELQG_PAUSE=1
exec /bin/bash "$APP_DIR/start.sh" "$@"
