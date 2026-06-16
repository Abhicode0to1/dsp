#!/usr/bin/env bash
# DSP — update/deploy script for the GCP VM.
# Pulls latest code, installs deps, rebuilds the frontend, and gracefully
# reloads under PM2 with near-zero downtime. DB migrations run automatically on
# boot (runMigrations). Run from the repo root on the server:  ./deploy.sh
#
# .env and backend/uploads are gitignored, so `git pull` never touches your
# production secrets or uploaded files.
set -euo pipefail

APP_DIR="/opt/dsp"
DB_NAME="dsp"
BACKUP_DIR="/opt/dsp-backups"

cd "$APP_DIR"

echo "==> [1/5] Backing up the database (rollback safety)"
mkdir -p "$BACKUP_DIR"
ts="$(date +%Y%m%d-%H%M%S)"
# Dump as root via MySQL socket auth (no password needed); run deploy.sh as root.
sudo mysqldump "$DB_NAME" | gzip > "$BACKUP_DIR/dsp-$ts.sql.gz"
echo "    saved $BACKUP_DIR/dsp-$ts.sql.gz"

echo "==> [2/5] Pulling latest code"
git fetch --all --tags
git pull --ff-only

echo "==> [3/5] Backend dependencies"
( cd backend && npm ci --omit=dev )

echo "==> [4/5] Frontend build"
( cd frontend && npm ci && npm run build )

echo "==> [5/5] Graceful zero-downtime reload (PM2)"
pm2 reload dsp --update-env
pm2 save

echo "==> Done. Health check:"
sleep 2
curl -fsS http://127.0.0.1:5000/api/health && echo
echo "If anything looks wrong, roll back with:  git checkout <previous-tag> && ./deploy.sh"
