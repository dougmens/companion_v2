#!/bin/zsh

PLIST_SRC="$(cd "$(dirname "$0")" && pwd)/com.companion.ingest-watch.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/com.companion.ingest-watch.plist"

cp "$PLIST_SRC" "$PLIST_DEST"

launchctl unload "$PLIST_DEST" 2>/dev/null
launchctl load "$PLIST_DEST"

echo "Companion ingest-watch installed and started."
