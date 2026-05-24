#!/bin/bash
# Install (symlink) the extension into the user's GNOME Shell extensions dir.
# Re-run this when files in this repo change; reload the shell to pick up updates:
#   - X11:     Alt+F2, then type 'r' and Enter
#   - Wayland: log out and back in (or restart gnome-shell another way)

set -euo pipefail

UUID="claude-meter@jairhdez"
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

if [ -e "$DEST" ] && [ ! -L "$DEST" ]; then
    echo "Refusing to overwrite $DEST (it's a real directory, not a symlink)." >&2
    echo "Move or remove it manually first, then re-run." >&2
    exit 1
fi

mkdir -p "$(dirname "$DEST")"
rm -f "$DEST"
ln -s "$SRC" "$DEST"

echo "Linked $DEST -> $SRC"
echo
echo "Now reload GNOME Shell (Wayland: log out / log in) and enable with:"
echo "  gnome-extensions enable $UUID"
