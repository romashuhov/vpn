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
  # sudo с env_reset вычищает окружение; `env VAR=…` протаскивает заглушку WG_HOST.
  local envargs=()
  [ -n "${WG_HOST+x}" ] && envargs+=("WG_HOST=$WG_HOST")
  sudo env "${envargs[@]}" docker compose "$@"
}

dkr() { # raw docker с тем же sudo-фоллбеком
  if docker info >/dev/null 2>&1; then docker "$@"; else sudo docker "$@"; fi
}

[ -r "$ROOT/deploy/.env" ] || die "Нет читаемого deploy/.env — сначала запустите ./start.sh"

# --- предохранитель: неперенесённые данные прошлой установки ------------------
# Перенос данных из тома старого имени (deploy_wiredeck_data → wiredeck_data)
# умеют только start.sh и update.sh. Здесь его намеренно нет — зато есть
# проверка, потому что путь «./restart.sh на неперенесённой установке» не
# гипотетический, а прямо описанный в README и в подсказке самого start.sh
# («printf '\nWG_ENGINE=awg\n' >> deploy/.env && ./restart.sh»). Без проверки
# `dc up -d` молча подключил бы ПУСТОЙ том: панель поднялась бы с нуля,
# сгенерировала новые ключи сервера, и все клиентские конфиги умерли бы.
# Предупреждения в документации для этого недостаточно.
DATA_VOLUME=wiredeck_data

vol_exists() { dkr volume inspect "$1" >/dev/null 2>&1; }

helper_image() {
  local img
  for img in alpine:latest busybox:latest wiredeck-wiredeck:latest deploy-wiredeck:latest; do
    if [ -n "$(dkr images -q "$img" 2>/dev/null || true)" ]; then
      printf '%s' "$img"
      return 0
    fi
  done
  return 1 # тянуть образ из сети ради проверки при рестарте не станем
}

# Коды: 0 — есть, 1 — нет, 2 — проверить не удалось. Быстрой ветке доверяем
# только если каталог тома реально читаем: `test -e` не отличает «нет файла» от
# «нет прав», а ошибиться здесь — значит либо зря заблокировать рестарт, либо
# пропустить пустой том.
vol_has_file() { # $1 = существующий том, $2 = имя файла внутри
  local mp img rc=0
  mp="$(dkr volume inspect -f '{{ .Mountpoint }}' "$1" 2>/dev/null || true)"
  if [ -n "$mp" ] && [ -d "$mp" ] && [ -r "$mp" ] && [ -x "$mp" ]; then
    [ -e "$mp/$2" ] && return 0
    return 1
  fi
  img="$(helper_image)" || return 2
  dkr run --rm -v "$1:/vol:ro" "$img" sh -c "[ -e '/vol/$2' ]" >/dev/null 2>&1 || rc=$?
  case "$rc" in
    0) return 0 ;;
    1) return 1 ;;
    *) return 2 ;;
  esac
}

legacy_volumes() {
  dkr volume ls -q 2>/dev/null | tr -d '\r' \
    | grep -E '^[A-Za-z0-9][A-Za-z0-9_.-]*_wiredeck_data$' || true
}

guard_unmigrated_data() {
  local v rc old=()
  # Быстрый выход для подавляющего большинства установок: старых томов нет —
  # ни одного docker run на проверку не тратим.
  while IFS= read -r v; do
    if [ -n "$v" ]; then old+=("$v"); fi
  done < <(legacy_volumes)
  [ "${#old[@]}" -eq 0 ] && return 0

  # Ругаемся ТОЛЬКО на достоверном сочетании «в новом томе базы точно нет» +
  # «в старом она точно есть». Любое «не знаю» пропускаем: ложная блокировка
  # рестарта на каждом запуске была бы хуже самой проблемы.
  if vol_exists "$DATA_VOLUME"; then
    rc=0
    vol_has_file "$DATA_VOLUME" wiredeck.db || rc=$?
    [ "$rc" -ne 1 ] && return 0 # база есть или неизвестно — не мешаем
  fi
  for v in "${old[@]}"; do
    rc=0
    vol_has_file "$v" wiredeck.db || rc=$?
    if [ "$rc" -eq 0 ]; then
      die "Данные прошлой установки лежат в томе $v и ещё НЕ перенесены в $DATA_VOLUME. Если поднять панель сейчас, она стартует с пустой базой, сгенерирует новые ключи сервера — и все выданные клиентские конфиги перестанут работать. Запустите ./start.sh (или ./update.sh): они переносят данные автоматически. Подробности — README, раздел «Данные и миграция тома»."
    fi
  done
  return 0
}

guard_unmigrated_data

cd "$ROOT/deploy"
# down + up (а не restart): пересоздание подхватывает новые переменные из .env.
# Для down WG_HOST не нужен — заглушка в subshell, чтобы не влиять на up.
( export WG_HOST="${WG_HOST:-unset}"; dc down --remove-orphans )
# Контейнер от версий до фиксации имени compose-проекта (проект «deploy»).
dkr rm -f wiredeck >/dev/null 2>&1 || true
dc up -d
echo "[wiredeck] Перезапущено."
