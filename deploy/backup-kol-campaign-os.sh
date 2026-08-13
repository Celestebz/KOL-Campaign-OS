#!/usr/bin/env bash
set -Eeuo pipefail

ENV_FILE=/etc/kol-campaign-os/kol-campaign-os.env
BACKUP_ROOT=/var/backups/kol-campaign-os
DATA_DIR=/var/lib/kol-campaign-os/data
KEEP_DAYS=14

if [[ "$BACKUP_ROOT" != "/var/backups/kol-campaign-os" ]]; then
  echo "Refusing to prune unexpected backup root: $BACKUP_ROOT" >&2
  exit 1
fi

if [[ ! -r "$ENV_FILE" ]]; then
  echo "Cannot read $ENV_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

STAMP=$(date +%Y%m%d-%H%M%S)
DEST="$BACKUP_ROOT/$STAMP"
install -d -m 0750 "$DEST"

MYSQL_PWD="$DB_PASSWORD" mysqldump \
  --host="$DB_HOST" \
  --port="$DB_PORT" \
  --user="$DB_USER" \
  --single-transaction \
  --quick \
  --routines \
  --triggers \
  --default-character-set=utf8mb4 \
  "$DB_NAME" | gzip -9 > "$DEST/database.sql.gz"

if [[ -d "$DATA_DIR/uploads" ]]; then
  tar -C "$DATA_DIR" -czf "$DEST/uploads.tar.gz" uploads
fi

find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime "+$KEEP_DAYS" -exec rm -rf -- {} +
echo "Backup completed: $DEST"
