#!/usr/bin/env bash
# Throwaway MySQL / MariaDB for the tests on port 33306 (127.0.0.1 only). Its data lives in
# /tmp/dbotter-test-mysql-$USER (DBOTTER_TEST_MYSQL_DIR to change): Ubuntu's AppArmor profile
# for mysqld refuses data directories under /home.
#
#   scripts/test-mysql.sh start   # create (first time) and start
#   scripts/test-mysql.sh stop
#   scripts/test-mysql.sh reset   # delete and start fresh
#
# Users: root (no password) and otter / otter-pass. MySQL turns TLS on by itself with a
# self-signed certificate. The tests create their own databases.
set -euo pipefail

cd "$(dirname "$0")/.."
DIR=${DBOTTER_TEST_MYSQL_DIR:-${TMPDIR:-/tmp}/dbotter-test-mysql-$(whoami)}
PORT=${DBOTTER_TEST_MYSQL_PORT:-33306}
MYSQLD=$(command -v mysqld || command -v mariadbd || ls /usr/sbin/mysqld /usr/sbin/mariadbd 2>/dev/null | head -1 || true)
[ -n "$MYSQLD" ] || { echo "mysqld / mariadbd not found" >&2; exit 1; }

client() { mysql -h 127.0.0.1 -P "$PORT" -u root "$@"; }

start() {
  mkdir -p "$DIR"
  if [ ! -d "$DIR/data" ]; then
    if "$MYSQLD" --version | grep -qi mariadb; then
      mariadb-install-db --no-defaults --datadir="$DIR/data" --auth-root-authentication-method=normal >/dev/null
    else
      "$MYSQLD" --no-defaults --initialize-insecure --datadir="$DIR/data" --user="$(whoami)" 2>/dev/null
    fi
    fresh=1
  fi
  nohup "$MYSQLD" --no-defaults --datadir="$DIR/data" --port="$PORT" --bind-address=127.0.0.1 \
    --socket="$DIR/mysqld.sock" --pid-file="$DIR/mysqld.pid" --log-error="$DIR/error.log" \
    $("$MYSQLD" --version | grep -qi mariadb || echo --mysqlx=OFF) >/dev/null 2>&1 &
  for _ in $(seq 60); do client -e "select 1" >/dev/null 2>&1 && break; sleep 0.5; done
  client -e "select 1" >/dev/null || { echo "MySQL didn't start; see $DIR/error.log" >&2; exit 1; }
  if [ "${fresh:-}" ]; then
    client -e "CREATE USER 'otter'@'%' IDENTIFIED BY 'otter-pass'; GRANT ALL ON *.* TO 'otter'@'%';"
  fi
  echo "test MySQL on 127.0.0.1:$PORT  (export DBOTTER_TEST_MYSQL_PORT=$PORT)"
}

stop() {
  [ -f "$DIR/mysqld.pid" ] && kill "$(cat "$DIR/mysqld.pid")" 2>/dev/null || true
  for _ in $(seq 40); do [ -f "$DIR/mysqld.pid" ] || break; sleep 0.25; done
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  reset) stop; rm -rf "$DIR"; start ;;
  *) echo "usage: $0 start|stop|reset" >&2; exit 2 ;;
esac
