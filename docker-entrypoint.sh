#!/bin/sh
# Applies pending migrations, then hands off to the container's command. `set -e` aborts before the
# exec if migrations fail, so a bad schema change stops the container instead of starting an app
# that does not match the database. `exec "$@"` runs CMD in this process, keeping it PID 1 so
# signals from `docker stop` reach node, and leaving CMD overridable at `docker run`.
set -e

node src/migrations/run.js

exec "$@"
