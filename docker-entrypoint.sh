#!/bin/sh
set -e

# The data volume outlives the image: it may have been created by an older root-only version, or
# be a host bind mount owned by whoever runs Docker. Take ownership while we still can, then drop
# to an unprivileged user for the server itself.
if [ "$(id -u)" = '0' ]; then
    chown -R www-data:www-data /data 2>/dev/null || true

    exec su-exec www-data "$@"
fi

exec "$@"
