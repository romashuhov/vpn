#!/usr/bin/env bash
# WireDeck — перезапуск контейнера (применяет изменения deploy/.env).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

c_red=$'\033[1;31m'; c_reset=$'\033[0m'
die() { echo "${c_red}[wiredeck]${c_reset} $*" >&2; exit 1; }

dc() {
  command -v docker >/dev/null 2>&1 || die "Docker не установлен — сначала запустите ./start.sh"
  if docker info >/dev/null 2>&1; then docker compose "$@"; return; fi
  if [ "$(id -u)" -eq 0 ]; then die "Docker-демон не отвечает. Запустите его: systemctl start docker"; fi
  command -v sudo >/dev/null 2>&1 || die "Нет доступа к Docker (нужна группа docker) и нет sudo — запустите от root."
  sudo docker compose "$@"
}

[ -r "$ROOT/deploy/.env" ] || die "Нет читаемого deploy/.env — сначала запустите ./start.sh"

cd "$ROOT/deploy"
# down + up (а не restart): пересоздание подхватывает новые переменные из .env.
# Для down WG_HOST не нужен — подставляем заглушку в subshell, чтобы не влиять на up.
( export WG_HOST="${WG_HOST:-unset}"; dc down --remove-orphans )
dc up -d
echo "[wiredeck] Перезапущено."
