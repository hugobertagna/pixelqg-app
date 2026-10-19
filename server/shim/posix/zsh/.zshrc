# PixelQG terminal (zsh): loads your usual .zshrc, then makes `claude` go through the PixelQG relay
# even if your .zshrc put another folder in front of server/shim in PATH.
ZDOTDIR="$PIXELQG_USER_ZDOTDIR"
# /etc/zshrc ran while ZDOTDIR pointed here: keep the history in your own folder.
if [[ "$HISTFILE" == "$PIXELQG_ZDOTDIR"/* ]]; then
  HISTFILE="$ZDOTDIR/.zsh_history"
fi
unset PIXELQG_ZDOTDIR
if [[ -f "$ZDOTDIR/.zshrc" ]]; then
  source "$ZDOTDIR/.zshrc"
fi
unalias claude 2>/dev/null
function claude {
  if [[ -n "$PIXELQG_NODE" && -n "$PIXELQG_SHIM" ]]; then
    "$PIXELQG_NODE" "$PIXELQG_SHIM" "$@"
  else
    command claude "$@"
  fi
}
