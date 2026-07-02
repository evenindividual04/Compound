#!/usr/bin/env bash
# Compound SMS bridge installer. Piped from the Setup page in-app, or run
# manually: curl -fsSL <origin>/bridge/install.sh | INGEST_URL=... INGEST_SECRET=... bash
set -euo pipefail

BASE_URL="${INGEST_URL:?Set INGEST_URL to your Compound instance's URL}"
SECRET="${INGEST_SECRET:?Set INGEST_SECRET to your instance's ingest secret (see the Setup page)}"
BRIDGE_DIR="$HOME/.compound-sms-bridge"
LOG_PATH="$BRIDGE_DIR/bridge.log"
PLIST_PATH="$HOME/Library/LaunchAgents/com.compound.sms-bridge.plist"

mkdir -p "$BRIDGE_DIR"

echo "Downloading bridge.py..."
curl -fsSL "$BASE_URL/bridge/bridge.py" -o "$BRIDGE_DIR/bridge.py"

echo "Writing config..."
cat > "$BRIDGE_DIR/config.json" <<EOF
{"ingest_url": "$BASE_URL", "ingest_secret": "$SECRET"}
EOF

echo "Installing the launchd agent..."
mkdir -p "$HOME/Library/LaunchAgents"
curl -fsSL "$BASE_URL/bridge/com.compound.sms-bridge.plist.template" \
  | sed "s|__BRIDGE_PATH__|$BRIDGE_DIR/bridge.py|g; s|__LOG_PATH__|$LOG_PATH|g" \
  > "$PLIST_PATH"

launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load "$PLIST_PATH"

echo ""
echo "Installed. Two manual steps remain (Apple requires a human click for both):"
echo "1. iPhone: Settings -> Messages -> Text Message Forwarding -> enable this Mac"
echo "2. Mac: System Settings -> Privacy & Security -> Full Disk Access -> add /usr/bin/python3"
echo ""
echo "Check status any time: tail -f $LOG_PATH"
