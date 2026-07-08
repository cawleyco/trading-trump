#!/bin/bash
# Install the trading bot as a launchd agent: starts at login, restarts on
# crash, logs to ~/Library/Logs/trading-bot.log.
# Usage: ./scripts/install-launchd.sh          (install/replace)
#        ./scripts/install-launchd.sh remove   (uninstall)
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_DEST="$HOME/Library/LaunchAgents/com.trading-bot.plist"
NODE_PATH="$(which node)"

if [[ "${1:-}" == "remove" ]]; then
  launchctl unload "$PLIST_DEST" 2>/dev/null || true
  rm -f "$PLIST_DEST"
  echo "Removed launchd agent. The bot will no longer auto-start."
  exit 0
fi

if [[ ! -f "$PROJECT_ROOT/.env" ]]; then
  echo "ERROR: $PROJECT_ROOT/.env not found — set up the bot before installing the agent." >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

sed -e "s|__NODE_PATH__|$NODE_PATH|g" \
    -e "s|__PROJECT_ROOT__|$PROJECT_ROOT|g" \
    -e "s|__HOME__|$HOME|g" \
    "$PROJECT_ROOT/scripts/com.trading-bot.plist.template" > "$PLIST_DEST"

launchctl unload "$PLIST_DEST" 2>/dev/null || true
launchctl load "$PLIST_DEST"

echo "Installed. The bot now starts at login and restarts if it crashes."
echo "  Logs:      tail -f ~/Library/Logs/trading-bot.log"
echo "  Stop once: launchctl stop com.trading-bot   (it will restart — use the kill switch to stop trading)"
echo "  Uninstall: ./scripts/install-launchd.sh remove"
echo
echo "NOTE: launchd keeps the PROCESS alive, not the Mac awake. To prevent"
echo "sleep during market hours, run: caffeinate -s   (or adjust Energy settings)."
