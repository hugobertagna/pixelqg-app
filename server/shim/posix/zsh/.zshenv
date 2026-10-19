# PixelQG terminal (zsh, macOS / Linux): ZDOTDIR points to this folder. Your own .zshenv is loaded
# from your usual ZDOTDIR (or $HOME), then ZDOTDIR points back here so that zsh reads our .zshrc.
PIXELQG_ZDOTDIR="$ZDOTDIR"
ZDOTDIR="${PIXELQG_USER_ZDOTDIR:-$HOME}"
if [[ -f "$ZDOTDIR/.zshenv" ]]; then
  source "$ZDOTDIR/.zshenv"
fi
PIXELQG_USER_ZDOTDIR="$ZDOTDIR"
ZDOTDIR="$PIXELQG_ZDOTDIR"
