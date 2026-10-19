#!/usr/bin/env bash
# PixelQG launcher for macOS / Linux (experimental: never tested on a real Mac).
# First time: chmod +x start.sh   then: ./start.sh   (extra options go to the server, e.g. ./start.sh --no-observe)
# macOS: double-click launcher/PixelQG.command instead, it runs this script.
#
# Starts the server, opens PixelQG in an app window (Chrome, Edge or Chromium with a dedicated
# profile, else the default browser) and stops the server when this script ends: app window
# closed, Ctrl+C, or terminal window closed.

cd "$(dirname "$0")" || exit 1
APP_DIR="$(pwd)"

pause_if_asked() {
  # Double-clicked PixelQG.command: leave the message readable before the window is closed.
  if [ -n "$PIXELQG_PAUSE" ] && [ -t 0 ]; then
    printf '\n  Appuie sur Entrée pour fermer cette fenêtre.'
    read -r _
  fi
}

# ---------------------------------------------------------------- Node.js
# The runtime shipped with PixelQG (runtime/node) first, then the one installed on this computer.
NODE=""
if [ -x "$APP_DIR/runtime/node" ]; then
  NODE="$APP_DIR/runtime/node"
elif command -v node >/dev/null 2>&1; then
  NODE="$(command -v node)"
else
  for c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [ -x "$c" ]; then NODE="$c"; break; fi
  done
fi
if [ -z "$NODE" ]; then
  echo ""
  echo "  Node.js est introuvable sur cet ordinateur."
  echo "  Installe Node.js 20 ou plus récent depuis https://nodejs.org (version « LTS »),"
  echo "  puis relance PixelQG."
  echo ""
  pause_if_asked
  exit 1
fi

if [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
  exec "$NODE" server/server.js --help
fi

# ---------------------------------------------------------------- stop everything on exit
LOG="$(mktemp "${TMPDIR:-/tmp}/pixelqg.XXXXXX")" || exit 1
SERVER_PID=""
TAIL_PID=""
SIGNALED=""

alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }

cleanup() {
  trap - EXIT INT TERM HUP
  if alive "$SERVER_PID"; then
    # Ctrl+C and a closed terminal reach the server too: give it time to stop its agents itself.
    if [ -z "$SIGNALED" ]; then kill -TERM "$SERVER_PID" 2>/dev/null; fi
    i=0
    while alive "$SERVER_PID" && [ $i -lt 40 ]; do sleep 0.25; i=$((i + 1)); done
    if alive "$SERVER_PID"; then kill -TERM "$SERVER_PID" 2>/dev/null; sleep 2; fi
    if alive "$SERVER_PID"; then kill -KILL "$SERVER_PID" 2>/dev/null; fi
  fi
  if alive "$TAIL_PID"; then kill "$TAIL_PID" 2>/dev/null; fi
  rm -f "$LOG"
}
trap cleanup EXIT
trap 'SIGNALED=1; exit 130' INT
trap 'SIGNALED=1; exit 129' HUP
trap 'exit 143' TERM

# ---------------------------------------------------------------- server
"$NODE" server/server.js "$@" >"$LOG" 2>&1 &
SERVER_PID=$!
tail -n +1 -f "$LOG" &
TAIL_PID=$!

URL=""
i=0
while [ $i -lt 120 ]; do
  URL="$(grep -o 'http://127\.0\.0\.1:[0-9]*/' "$LOG" 2>/dev/null | head -n 1)"
  if [ -n "$URL" ] || ! alive "$SERVER_PID"; then break; fi
  sleep 0.25
  i=$((i + 1))
done
if [ -z "$URL" ]; then
  sleep 0.5
  echo ""
  echo "  Le serveur de PixelQG n'a pas pu démarrer : regarde les messages ci-dessus."
  echo ""
  pause_if_asked
  exit 1
fi

# ---------------------------------------------------------------- window
find_browser() {
  if [ "$(uname -s)" = "Darwin" ]; then
    for app in "Google Chrome" "Microsoft Edge" "Chromium"; do
      for base in /Applications "$HOME/Applications"; do
        if [ -x "$base/$app.app/Contents/MacOS/$app" ]; then
          echo "$base/$app.app/Contents/MacOS/$app"
          return 0
        fi
      done
    done
  else
    for c in google-chrome google-chrome-stable microsoft-edge microsoft-edge-stable chromium chromium-browser; do
      if command -v "$c" >/dev/null 2>&1; then
        command -v "$c"
        return 0
      fi
    done
  fi
  return 1
}

wait_for_server() {
  echo ""
  echo "  PixelQG est ouvert dans ton navigateur : $URL"
  echo "  Pour l'arrêter, appuie sur Ctrl+C ici (ou ferme cette fenêtre)."
  echo ""
  wait "$SERVER_PID"
}

BROWSER="$(find_browser)"
if [ -n "$BROWSER" ]; then
  if [ "$(uname -s)" = "Darwin" ]; then
    PROFILE="$HOME/Library/Application Support/PixelQG/fenetre"
  elif [ -d "$HOME/snap/chromium" ] && [ "${BROWSER#*chromium}" != "$BROWSER" ]; then
    PROFILE="$HOME/snap/chromium/common/pixelqg-fenetre" # the Chromium snap cannot write hidden folders of $HOME
  else
    PROFILE="${XDG_DATA_HOME:-$HOME/.local/share}/pixelqg/fenetre"
  fi
  mkdir -p "$PROFILE" 2>/dev/null
  echo ""
  echo "  Ferme la fenêtre PixelQG (sur Mac : Cmd+Q) pour tout arrêter."
  STARTED=$SECONDS
  "$BROWSER" --app="$URL" --user-data-dir="$PROFILE" --window-size=1440,900 \
    --no-first-run --no-default-browser-check --disable-sync >/dev/null 2>&1
  # Back at once: the window went to a browser already running with this profile.
  if [ $((SECONDS - STARTED)) -lt 5 ] && alive "$SERVER_PID"; then wait_for_server; fi
else
  if [ "$(uname -s)" = "Darwin" ]; then
    open "$URL"
  else
    xdg-open "$URL" >/dev/null 2>&1 || echo "  Ouvre cette adresse dans ton navigateur : $URL"
  fi
  wait_for_server
fi
