#!/usr/bin/env bash
# Throwaway Postgres for the tests, in .test-db/ on port 55432 (TCP on 127.0.0.1 only).
#
#   scripts/test-db.sh start   # create (first time), seed, start
#   scripts/test-db.sh stop
#   scripts/test-db.sh reset   # delete and start fresh
#
# Roles: postgres (trust, no password) and otter / otter-pass (password required).
# With openssl available, TLS is on with a test CA (.test-db/ca.crt, export DBOTTER_TEST_CA).
set -euo pipefail

cd "$(dirname "$0")/.."
DIR=.test-db
PORT=${DBOTTER_TEST_PORT:-55432}

bindir() {
  if command -v pg_config >/dev/null && [ -x "$(pg_config --bindir)/initdb" ]; then
    pg_config --bindir
  else
    # Debian/Ubuntu keep server binaries out of PATH; pick the newest
    ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1
  fi
}
BIN=$(bindir)
[ -x "$BIN/initdb" ] || { echo "PostgreSQL server binaries (initdb, pg_ctl) not found" >&2; exit 1; }

start() {
  if [ ! -d "$DIR/data" ]; then
    "$BIN/initdb" -D "$DIR/data" -U postgres --auth=trust >/dev/null
    # otter must use a password, everyone else is trusted
    { echo "host all otter 127.0.0.1/32 scram-sha-256"; cat "$DIR/data/pg_hba.conf"; } > "$DIR/hba" && mv "$DIR/hba" "$DIR/data/pg_hba.conf"
    if command -v openssl >/dev/null; then certs; fi
    fresh=1
  fi
  "$BIN/pg_ctl" -D "$DIR/data" -l "$DIR/log" -w \
    -o "-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=''" start >/dev/null
  if [ "${fresh:-}" ]; then
    echo "seeding (1M rows, takes a few seconds)…"
    psql -q -h 127.0.0.1 -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -f scripts/seed-test-db.sql
  fi
  echo "test database on 127.0.0.1:$PORT  (export DBOTTER_TEST_PORT=$PORT)"
  [ -f "$DIR/ca.crt" ] && echo "TLS on                         (export DBOTTER_TEST_CA=$PWD/$DIR/ca.crt)"
  return 0
}

# a CA and a server certificate for 127.0.0.1 / localhost
certs() {
  local d="$DIR/data"
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=DbOtter test CA" \
    -keyout "$DIR/ca.key" -out "$DIR/ca.crt" 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" -keyout "$d/server.key" -out "$DIR/server.csr" 2>/dev/null
  printf "subjectAltName=DNS:localhost,IP:127.0.0.1\n" > "$DIR/san.ext"
  openssl x509 -req -in "$DIR/server.csr" -CA "$DIR/ca.crt" -CAkey "$DIR/ca.key" -CAcreateserial -days 3650 \
    -extfile "$DIR/san.ext" -out "$d/server.crt" 2>/dev/null
  chmod 600 "$d/server.key"
  printf "ssl = on\nssl_cert_file = 'server.crt'\nssl_key_file = 'server.key'\n" >> "$d/postgresql.conf"
}

stop() {
  [ -d "$DIR/data" ] && "$BIN/pg_ctl" -D "$DIR/data" -m fast stop >/dev/null 2>&1 || true
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  reset) stop; rm -rf "$DIR"; start ;;
  *) echo "usage: $0 start|stop|reset" >&2; exit 2 ;;
esac
