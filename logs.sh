#!/usr/bin/env bash
# WireDeck — логи контейнера (Ctrl+C — выйти). Аргументы пробрасываются compose.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

c_red=$'\033[1;31m'; c_reset=$'\033[0m'
die() { echo "${c_red}[wiredeck]${c_reset} $*" >&2; exit 1; }

dc() {
  command -v docker >/dev/null 2>&1 || die "Docker не установлен — сначала запустите ./start.sh"
  if docker info >/dev/null 2>&1; then docker compose "$@"; return; fi
  if [ "$(id -u)" -eq 0 ]; then die "Docker-демон не отвечает. Запустите его: systemctl start docker"; fi
  command -v sudo >/dev/null 2>&1 || die "Нет доступа к Docker (нужна группа docker) и нет sudo — запустите от root."
  # sudo с env_reset вычищает окружение; `env VAR=…` протаскивает заглушку WG_HOST.
  local envargs=()
  [ -n "${WG_HOST+x}" ] && envargs+=("WG_HOST=$WG_HOST")
  sudo env "${envargs[@]}" docker compose "$@"
}

cd "$ROOT/deploy"
# Для logs WG_HOST не нужен — заглушка позволяет смотреть логи даже без .env.
export WG_HOST="${WG_HOST:-unset}"
dc logs -f --tail=200 "$@"
