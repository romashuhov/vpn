#!/usr/bin/env bash
# WireDeck — удаление: останавливает и удаляет контейнер и собранный образ.
#
#   ./uninstall.sh          — контейнер и образ; ДАННЫЕ сохраняются (спросит, если есть tty)
#   ./uninstall.sh --purge  — то же + БЕЗВОЗВРАТНО удалить данные: volume
#                             wiredeck_data и тома прошлых установок
#                             (*_wiredeck_data), где лежит копия всех ключей
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

# Тома от установок, развёрнутых до фиксации имени compose-проекта
# (deploy_wiredeck_data и подобные). Миграция их НИКОГДА не удаляет — как
# страховка это правильно, но для uninstall это означает, что после переноса
# «--purge» переставал быть purge: в старом томе оставалась ПОЛНАЯ копия всех
# секретов (приватный ключ сервера, приватные ключи и PSK всех клиентов,
# scrypt-хэш пароля администратора), а пользователю сообщали «удалено
# безвозвратно». Хуже того, следующая установка находила этот том и молча
# восстанавливала из него всё, что админ только что удалял.
legacy_volumes() {
  dkr volume ls -q 2>/dev/null | tr -d '\r' \
    | grep -E '^[A-Za-z0-9][A-Za-z0-9_.-]*_wiredeck_data$' || true
}

legacy=()
while IFS= read -r v; do
  if [ -n "$v" ]; then legacy+=("$v"); fi
done < <(legacy_volumes)

data_targets="volume wiredeck_data"
[ "${#legacy[@]}" -gt 0 ] && data_targets="$data_targets и старые тома: ${legacy[*]}"

delete_data=0
if [ "$purge" -eq 1 ]; then
  delete_data=1
elif confirm_destructive "Удалить и ДАННЫЕ ($data_targets — пользователи, ключи, статистика, пароль)? Это необратимо"; then
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

# Старые тома сносим только вместе с данными и только по явному решению выше.
removed_legacy=()
if [ "$delete_data" -eq 1 ] && [ "${#legacy[@]}" -gt 0 ]; then
  for v in "${legacy[@]}"; do
    if dkr volume rm "$v" >/dev/null 2>&1; then
      removed_legacy+=("$v")
    else
      warn "Не удалось удалить старый том $v (занят контейнером?). Снесите сами: docker volume rm $v"
    fi
  done
fi

echo
if [ "$delete_data" -eq 1 ]; then
  if [ "${#removed_legacy[@]}" -gt 0 ]; then
    warn "Данные удалены безвозвратно: volume wiredeck_data, а также ${removed_legacy[*]}."
  else
    warn "Данные удалены безвозвратно (volume wiredeck_data)."
  fi
else
  info "Данные сохранены в volume wiredeck_data — вернуть панель: ./start.sh"
  if [ "${#legacy[@]}" -gt 0 ]; then
    warn "Кроме него остались тома прошлых установок со ВСЕМИ ключами: ${legacy[*]}."
    warn "Снести их: docker volume rm ${legacy[*]}"
  fi
fi
info "Docker и каталог репозитория не тронуты. Убрать каталог полностью: rm -rf $(printf '%q' "$ROOT")"
