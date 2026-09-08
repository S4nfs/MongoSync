#!/bin/bash
# Rolling mongodump backups. Runs as its own container; never exits.
set -uo pipefail

BACKUP_DIR="/backups"
RETENTION="${BACKUP_RETENTION:-7}"
INTERVAL="${BACKUP_INTERVAL_SECONDS:-86400}"

if [ -z "${LOCAL_URI:-}" ]; then
  echo "FATAL: LOCAL_URI is not set. Cannot run backups."
  exit 1
fi

mkdir -p "$BACKUP_DIR"

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }

log "Backup service started. interval=${INTERVAL}s retention=${RETENTION}"

while true; do
  STAMP="$(date -u '+%Y-%m-%d_%H-%M-%S')"
  ARCHIVE="$BACKUP_DIR/mongo-backup-$STAMP.archive.gz"

  log "Starting dump -> $(basename "$ARCHIVE")"

  # --oplog captures concurrent writes so the archive is a consistent point in time.
  if mongodump --uri="$LOCAL_URI" --oplog --gzip --archive="$ARCHIVE.tmp" --quiet; then
    mv "$ARCHIVE.tmp" "$ARCHIVE"
    log "OK  $(du -h "$ARCHIVE" | cut -f1)  $(basename "$ARCHIVE")"
  else
    rm -f "$ARCHIVE.tmp"
    log "FAILED - dump did not complete. Keeping previous backups untouched."
  fi

  # Prune only on success paths above; oldest-first removal beyond retention count.
  CURRENT=$(ls -1 "$BACKUP_DIR"/mongo-backup-*.archive.gz 2>/dev/null | wc -l)
  if [ "$CURRENT" -gt "$RETENTION" ]; then
    ls -1 "$BACKUP_DIR"/mongo-backup-*.archive.gz | sort | head -n "$((CURRENT - RETENTION))" | while read -r old; do
      log "Pruning $(basename "$old")"
      rm -f "$old"
    done
  fi

  log "Sleeping ${INTERVAL}s until next backup."
  sleep "$INTERVAL"
done
