#!/bin/zsh

PLIST_DEST="$HOME/Library/LaunchAgents/com.companion.ingest-watch.plist"

launchctl unload "$PLIST_DEST" 2>/dev/null
rm -f "$PLIST_DEST"

echo "Companion ingest-watch removed."
