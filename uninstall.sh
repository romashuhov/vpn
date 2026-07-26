#!/usr/bin/env bash
# WireDeck — удаление: останавливает и удаляет контейнер и собранный образ.
#
#   ./uninstall.sh          — контейнер и образ; ДАННЫЕ сохраняются (спросит, если есть tty)
#   ./uninstall.sh --purge  — то же + БЕЗВОЗВРАТНО удалить данные (volume wiredeck_data)
#
# Docker и каталог репозитория скрипт не трогает.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

c_green=$'\033[1;32m'; c_yellow=$'\033[1;33m'; c_red=$'\033[1;31m'; c_reset=$'\033[0m'
info() { echo "${c_green}[wiredeck]${c_reset} $*"; }
warn() { echo "${c_yellow}[wiredeck]${c_reset} $*"; }
die()  { echo "${c_red}[wiredeck]${c_reset} $*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "Docker не установлен — удалять нечего."

have_tty() { { : </dev/tty; } 2>/dev/null; }

# Подтверждение необратимого действия: без терминала ответ всегда «нет» —
# данные по умолчанию переживают uninstall (явное согласие только через --purge).
confirm_destructive() {
  have_tty || return 1
  local answer=""
  read -r -p "$1 [y/N]: " answer </dev/tty || true
  [[ "$answer" =~ ^[YyДд] ]]
}

dc() {
  if docker info >/dev/null 2>&1; then docker compose "$@"; return; fi
  if [ "$(id -u)" -eq 0 ]; then die "Docker-демон не отвечает. Запустите его: systemctl start docker"; fi
  command -v sudo >/dev/null 2>&1 || die "Нет доступа к Docker (нужна группа docker) и нет sudo — запустите от root."
  # sudo с env_reset вычищает окружение; `env VAR=…` протаскивает заглушку WG_HOST.
  local envargs=()
  [ -n "${WG_HOST+x}" ] && envargs+=("WG_HOST=$WG_HOST")
  sudo env "${envargs[@]}" docker compose "$@"
}

dkr() { # raw docker с тем же sudo-фоллбеком
  if docker info >/dev/null 2>&1; then docker "$@"; else sudo docker "$@"; fi
}

purge=0
for arg in "$@"; do
  case "$arg" in
    --purge) purge=1 ;;
    *) die "Неизвестный аргумент: $arg (поддерживается только --purge)" ;;
  esac
done

delete_data=0
if [ "$purge" -eq 1 ]; then
  delete_data=1
elif confirm_destructive "Удалить и ДАННЫЕ (volume wiredeck_data: пользователи, ключи, статистика)? Это необратимо"; then
  delete_data=1
fi

cd "$ROOT/deploy"
# Для down значение WG_HOST не важно — заглушка, чтобы работало и без .env.
export WG_HOST="${WG_HOST:-unset}"

down_args=(down --remove-orphans --rmi local)
[ "$delete_data" -eq 1 ] && down_args+=(--volumes)

info "Останавливаю и удаляю контейнер и образ WireDeck…"
dc "${down_args[@]}"
# Хвосты от версий до фиксации имени compose-проекта (проект «deploy»).
dkr rm -f wiredeck >/dev/null 2>&1 || true
dkr rmi deploy-wiredeck >/dev/null 2>&1 || true
rm -f "$ROOT/deploy/.deployed"

echo
if [ "$delete_data" -eq 1 ]; then
  warn "Данные удалены безвозвратно (volume wiredeck_data)."
else
  info "Данные сохранены в volume wiredeck_data — вернуть панель: ./start.sh"
fi
info "Docker и каталог репозитория не тронуты. Убрать каталог полностью: rm -rf $(printf '%q' "$ROOT")"
