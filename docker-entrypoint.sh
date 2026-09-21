#!/bin/sh
# A mounted volume arrives owned by root and replaces whatever the image put at
# that path, so the chown in the Dockerfile does not survive the mount. Fix the
# ownership here, at boot, where the real filesystem exists — then drop the
# privileges we only took in order to do it.
#
# Without this the server dies on its first line: opening the SQLite file fails
# with "unable to open database file", nothing ever listens, and the platform
# reports a healthy deploy of a container that answers nothing.
set -e

DIR=$(dirname "${DB_PATH:-/data/table.db}")

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DIR"
  chown node:node "$DIR"
  exec su-exec node "$@"
fi

# Already unprivileged: a host that drops root itself, or a local docker run
# with --user. Nothing to fix and nothing to drop.
mkdir -p "$DIR" 2>/dev/null || true
exec "$@"
