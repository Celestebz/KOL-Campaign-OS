#!/bin/zsh
# KOL Campaign OS background service launcher (production mode, macOS).
# Started by the "com.kol-campaign-os" LaunchAgent at user login.
# All output goes to logs/service-<date>.log. No interactive prompts here.

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

# launchd provides a minimal PATH; add common locations for node / docker.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

mkdir -p logs
LOG="logs/service-$(date +%F).log"

echo "[$(date '+%F %T')] === KOL Campaign OS service starting ===" >> "$LOG"

# NOTE: do NOT set NODE_ENV=production here. server/database.js refuses to
# auto-run pending migrations when NODE_ENV=production.

# 0. Docker CLI present?
if ! command -v docker >/dev/null 2>&1; then
  echo "[ERROR] docker not found in PATH. Install Docker Desktop." >> "$LOG"
  exit 1
fi

# 1. Wait for the Docker engine (Docker Desktop may still be booting after login).
DTRIES=0
until docker info >/dev/null 2>&1; do
  DTRIES=$((DTRIES + 1))
  if [ "$DTRIES" -ge 36 ]; then
    echo "[ERROR] Docker engine not ready after 3 minutes." >> "$LOG"
    exit 1
  fi
  sleep 5
done
echo "[INFO] Docker engine is ready." >> "$LOG"

# 2. Start the MySQL container.
if ! docker compose up -d mysql >> "$LOG" 2>&1; then
  echo "[ERROR] docker compose up -d mysql failed." >> "$LOG"
  exit 1
fi

# 3. Wait until MySQL reports healthy (max ~2 minutes).
TRIES=0
until [ "$(docker inspect --format '{{.State.Health.Status}}' kol-campaign-os-mysql 2>/dev/null)" = "healthy" ]; do
  TRIES=$((TRIES + 1))
  if [ "$TRIES" -ge 24 ]; then
    echo "[ERROR] MySQL container not healthy after 2 minutes." >> "$LOG"
    exit 1
  fi
  sleep 5
done
echo "[INFO] MySQL container is healthy." >> "$LOG"

# 4. Frontend build must exist (production mode serves client/build).
if [ ! -f "client/build/index.html" ]; then
  echo "[ERROR] client/build/index.html missing. Run 'npm run build' once, then restart." >> "$LOG"
  exit 1
fi

# 5. Avoid a duplicate instance.
if lsof -nP -iTCP:5001 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "[INFO] Port 5001 is already listening; service already running. Exiting." >> "$LOG"
  exit 0
fi

# 6. Start the server (blocks here; the LaunchAgent keeps it alive in background).
echo "[INFO] Launching node server/index.js ..." >> "$LOG"
exec node server/index.js >> "$LOG" 2>&1
