#!/bin/sh
# Postgres-style entrypoint.
#
# Runs as root long enough to chown the (platform-owned) data volume to the
# bguser uid, then atomically drops privileges via gosu before exec'ing
# node. This lets Railway / Fly / Render mount /data with their own
# ownership (typically root or a platform-specific uid) without our writes
# blowing up with EACCES.
#
# If the container was started with --user 1001 (running as bguser already),
# we skip the chown and just exec node directly.
set -e

DATA_DIR="${BG_DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  # Make sure the volume mountpoint actually exists (Railway sometimes
  # creates it lazily) before chowning.
  mkdir -p "$DATA_DIR"
  chown -R bguser:bguser "$DATA_DIR" || true
  exec gosu bguser:bguser node /app/dist/server/index.js "$@"
fi

exec node /app/dist/server/index.js "$@"
