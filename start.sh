#!/usr/bin/env bash
#
# WireDeck — запуск после клона одной командой: ./start.sh
#
# Полностью без вопросов: сам поставит Docker с compose-плагином (если нет),
# определит публичный IP, запишет deploy/.env и поднимет контейнер.
# Пароль администратора задаётся в веб-панели при первом входе.
#
# Публичный адрес можно задать заранее:  WG_HOST=vpn.example.com ./start.sh

set -euo pipefail

c_green=$'\033[1;32m'; c_yellow=$'\033[1;33m'; c_red=$'\033[1;31m'; c_reset=$'\033[0m'
info() { echo "${c_green}[wiredeck]${c_reset} $*"; }
warn() { echo "${c_yellow}[wiredeck]${c_reset} $*"; }
die()  { echo "${c_red}[wiredeck]${c_reset} $*" >&2; exit 1; }

# Через пайп (curl | bash) запускать нельзя: скрипт должен лежать рядом с репо.
# Для установки с нуля есть deploy/install.sh — он клонирует и вызывает start.sh.
if [ ! -f "${BASH_SOURCE[0]:-}" ]; then
  die "start.sh нельзя запускать через пайп. Используйте: curl -fsSL https://raw.githubusercontent.com/romashuhov/vpn/main/deploy/install.sh | sudo bash"
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF="$ROOT/$(basename "${BASH_SOURCE[0]}")"
DEPLOY="$ROOT/deploy"
ENV_FILE="$DEPLOY/.env"

# --- права -------------------------------------------------------------------
# root нужен, если docker отсутствует, недоступен текущему юзеру или демон лежит.

docker_ok()  { command -v docker >/dev/null 2>&1; }
compose_ok() { docker compose version >/dev/null 2>&1; }

if [ "$(id -u)" -ne 0 ]; then
  if ! docker_ok || ! compose_ok || ! docker info >/dev/null 2>&1; then
    command -v sudo >/dev/null 2>&1 \
      || die "Нужны права root (установка/запуск Docker), а sudo нет. Запустите от root: bash $SELF"
    info "Нужны права root — перезапускаюсь через sudo."
    # sudo с env_reset вычищает окружение — протаскиваем наши переменные через `env`.
    envargs=()
    [ -n "${WG_HOST+x}" ] && envargs+=("WG_HOST=$WG_HOST")
    [ -n "${WG_ENGINE+x}" ] && envargs+=("WG_ENGINE=$WG_ENGINE")
    exec sudo env "${envargs[@]}" bash "$SELF" "$@"
  fi
fi

# --- apt: дождаться освобождения dpkg-lock -----------------------------------
# Свежие VPS первые минуты держат lock фоновым unattended-upgrades — из-за него
# падал бы и наш apt-get, и установщик get.docker.com.

apt_busy() {
  if command -v fuser >/dev/null 2>&1; then
    fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock >/dev/null 2>&1
  else
    pgrep -f 'unattended-upgr|apt-get|aptd|dpkg' >/dev/null 2>&1
  fi
}

wait_for_apt() {
  local waited=0
  while apt_busy; do
    [ "$waited" -eq 0 ] && info "Жду, пока фоновое обновление системы отпустит dpkg (свежий сервер, обычно 1–5 минут)…"
    sleep 5
    waited=$((waited + 5))
    [ "$waited" -ge 900 ] && die "dpkg занят дольше 15 минут. Посмотрите, что происходит: ps aux | grep -E 'apt|dpkg'"
  done
  [ "$waited" -gt 0 ] && info "dpkg освободился (ждали ${waited} с)."
  return 0
}

# --- Docker + compose plugin -------------------------------------------------

if ! docker_ok || ! compose_ok; then
  [ "$(id -u)" -eq 0 ] || die "Внутренняя ошибка: установка Docker требует root."
  if ! docker_ok; then
    warn "Docker не найден."
  else
    warn "Docker есть, но нет плагина «docker compose»."
  fi
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
  fi
  case "${ID:-}:${ID_LIKE:-}" in
    *debian*|*ubuntu*) ;;
    *) warn "Автоустановка рассчитана на Ubuntu/Debian, обнаружено: ${PRETTY_NAME:-неизвестная ОС}." ;;
  esac
  wait_for_apt
  command -v curl >/dev/null 2>&1 || {
    info "Ставлю curl…"
    apt-get -o DPkg::Lock::Timeout=300 update -qq
    DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y -qq curl
  }
  info "Устанавливаю Docker (официальный скрипт get.docker.com)…"
  curl -fsSL https://get.docker.com | sh
  docker_ok  || die "Docker так и не появился в PATH — установка не удалась."
  compose_ok || die "Плагин «docker compose» недоступен — установите docker-compose-plugin и повторите."
fi

# Демон может быть установлен, но не запущен (например, после reboot).
if ! docker info >/dev/null 2>&1; then
  info "Docker-демон не отвечает — пробую запустить…"
  systemctl start docker 2>/dev/null || service docker start 2>/dev/null || true
  docker info >/dev/null 2>&1 || die "Docker установлен, но демон не отвечает. Запустите его: systemctl start docker"
fi

# --- deploy/.env: единственная обязательная переменная — WG_HOST -------------

if [ -e "$ENV_FILE" ] && [ ! -r "$ENV_FILE" ]; then
  die "deploy/.env существует, но не читается (чужой владелец/права). Запустите через sudo либо почините права: chown $(id -un) '$ENV_FILE'"
fi

current_host=""
if [ -r "$ENV_FILE" ]; then
  # Терпим CRLF после правок на Windows и кавычки вокруг значения.
  current_host="$(grep -E '^WG_HOST=' "$ENV_FILE" | tail -1 | cut -d= -f2- \
    | tr -d '\r' | sed -e "s/^[\"']//" -e "s/[\"']\$//")"
fi

if [ -n "$current_host" ]; then
  info "deploy/.env уже настроен (WG_HOST=$current_host)."
else
  wg_host="${WG_HOST:-}"
  if [ -z "$wg_host" ]; then
    wg_host="$(curl -4fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)"
    [ -n "$wg_host" ] && info "Определён публичный IP: $wg_host"
  fi
  [ -n "$wg_host" ] || die "Не удалось определить публичный IP автоматически. Задайте адрес явно: WG_HOST=<IP или домен> ./start.sh"
  [ -w "$DEPLOY" ] || die "Нет прав на запись в $DEPLOY — запустите через sudo."
  tmp_env="$(mktemp)"
  if [ -r "$ENV_FILE" ]; then
    grep -v '^WG_HOST=' "$ENV_FILE" > "$tmp_env" || true # пустой остаток — не ошибка
  fi
  printf 'WG_HOST=%s\n' "$wg_host" >> "$tmp_env"
  install -m 600 "$tmp_env" "$ENV_FILE" || { rm -f "$tmp_env"; die "Не удалось записать $ENV_FILE"; }
  rm -f "$tmp_env"
  current_host="$wg_host"
  info "Записал deploy/.env (WG_HOST=$wg_host)"
fi

# --- Порты: при первом запуске подобрать свободные ---------------------------
# Если дефолтный порт занят (например, на хосте уже живёт свой WireGuard или
# что-то на 8080) — берём следующий свободный (+1). Выбор фиксируется в
# deploy/.env и больше никогда не меняется: порт WG зашит в клиентские конфиги.
# Если контейнер wiredeck уже существует, дефолтные порты заняты им самим —
# подбор пропускается, работаем как есть.

port_busy() { # $1 = tcp|udp, $2 = порт
  command -v ss >/dev/null 2>&1 || return 1 # нет ss — считаем порт свободным
  local flag="-tlnH"
  [ "$1" = "udp" ] && flag="-ulnH"
  [ -n "$(ss "$flag" "sport = :$2" 2>/dev/null)" ]
}

pick_free_port() { # $1 = tcp|udp, $2 = стартовый порт
  local p="$2" tries=0
  while port_busy "$1" "$p"; do
    p=$((p + 1))
    tries=$((tries + 1))
    [ "$tries" -ge 100 ] && die "Не нашёл свободный $1-порт в диапазоне $2–$p."
  done
  printf '%s' "$p"
}

env_has() { [ -r "$ENV_FILE" ] && grep -qE "^$1=" "$ENV_FILE"; }

ensure_port() { # $1 = имя переменной, $2 = tcp|udp, $3 = дефолт
  env_has "$1" && return 0 # порт уже зафиксирован — не трогаем
  if [ -n "$(docker ps -aq -f 'name=^wiredeck$' 2>/dev/null || true)" ]; then
    return 0 # контейнер существует: занятость дефолтов — это мы сами
  fi
  local want got
  want="${!1:-$3}"
  got="$(pick_free_port "$2" "$want")"
  [ "$got" != "$want" ] && warn "Порт $want/$2 занят — использую $got."
  if printf '%s=%s\n' "$1" "$got" >> "$ENV_FILE" 2>/dev/null; then
    info "Зафиксировал $1=$got в deploy/.env"
  else
    warn "Не удалось дописать $1=$got в deploy/.env (права?) — применяю только на этот запуск."
    export "$1=$got"
  fi
  return 0
}

ensure_port WG_PORT udp 51820
ensure_port PANEL_PORT tcp 8080

# --- Движок туннеля: новые установки идут на AmneziaWG -----------------------
# Ванильный WireGuard узнаётся по сигнатуре (в России этим занимаются ТСПУ),
# AmneziaWG маскирует рукопожатие. Новые установки поднимаем сразу на нём.
# Существующие НЕ трогаем: смена движка требует перевыдачи всех клиентских
# конфигов — молча ломать работающую установку нельзя (см. README).

ensure_engine() {
  env_has WG_ENGINE && return 0 # выбор уже зафиксирован — не трогаем
  if [ -n "$(docker ps -aq -f 'name=^wiredeck$' 2>/dev/null || true)" ]; then
    return 0 # контейнер уже есть: это обновление, движок оставляем прежним
  fi
  local want="${WG_ENGINE:-awg}"
  case "$want" in
    wg | awg) ;;
    *)
      warn "Неизвестное значение WG_ENGINE=$want — использую awg."
      want=awg
      ;;
  esac
  if printf 'WG_ENGINE=%s\n' "$want" >> "$ENV_FILE" 2>/dev/null; then
    if [ "$want" = awg ]; then
      info "Движок туннеля: AmneziaWG (маскировка от DPI) — зафиксировал WG_ENGINE=awg в deploy/.env."
      info "Клиентам понадобится приложение AmneziaWG (именно оно, не AmneziaVPN) — официальный клиент WireGuard такие конфиги не открывает."
    else
      info "Зафиксировал WG_ENGINE=wg в deploy/.env (обычный WireGuard)."
    fi
  else
    warn "Не удалось дописать WG_ENGINE в deploy/.env (права?) — движок не зафиксирован."
  fi
  return 0
}

ensure_engine

# Порты для проверок и итогового вывода: из окружения либо deploy/.env
# (compose читает те же значения — источники должны совпадать).
env_val() {
  # Объявление и присваивание раздельно: в bash 5.2 `${!name}` в той же строке
  # local раскрывается раньше, чем присвоен сам name («invalid indirect expansion»).
  local name="$1" def="$2" v
  v="${!name:-}"
  if [ -z "$v" ] && [ -r "$ENV_FILE" ]; then
    v="$(grep -E "^${name}=" "$ENV_FILE" | tail -1 | cut -d= -f2- \
      | tr -d '\r' | sed -e "s/^[\"']//" -e "s/[\"']\$//")"
  fi
  printf '%s' "${v:-$def}"
}
PANEL_PORT="$(env_val PANEL_PORT 8080)"
WG_UDP_PORT="$(env_val WG_PORT 51820)"
WG_ENGINE_ACTIVE="$(env_val WG_ENGINE wg)"

# --- сборка и запуск ---------------------------------------------------------

info "Собираю и запускаю контейнер (первая сборка может занять несколько минут)…"
cd "$DEPLOY"
# Миграция со старого имени compose-проекта («deploy»): контейнер «wiredeck»
# от старого проекта занял бы имя и не дал подняться новому. Трогаем его только
# если в НАШЕМ проекте контейнеров нет, а имя занято.
if [ -z "$(docker compose ps -q 2>/dev/null || true)" ] \
  && [ -n "$(docker ps -aq -f 'name=^wiredeck$' 2>/dev/null || true)" ]; then
  info "Убираю контейнер от старой версии (миграция имени compose-проекта)…"
  docker rm -f wiredeck >/dev/null 2>&1 || true
fi
docker compose up -d --build

# Метка успешно задеплоенного коммита — по ней ./update.sh решает, нужна ли пересборка.
git -C "$ROOT" rev-parse HEAD > "$DEPLOY/.deployed" 2>/dev/null || true

# --- ждём панель и смотрим, задан ли пароль ----------------------------------

info "Жду ответа панели…"
auth_status=""
for _ in $(seq 1 30); do
  auth_status="$(curl -fsS --max-time 2 "http://127.0.0.1:${PANEL_PORT}/api/auth/status" 2>/dev/null || true)"
  [ -n "$auth_status" ] && break
  sleep 2
done

echo
if [ -z "$auth_status" ]; then
  warn "Панель не ответила за 60 секунд. Проверьте логи: ./logs.sh"
else
  info "Готово! WireDeck запущен."
fi
echo
echo "  Панель управления:  ${c_green}http://${current_host}:${PANEL_PORT}${c_reset}"
echo
if [ -z "$auth_status" ] || printf '%s' "$auth_status" | grep -q '"needsSetup":true'; then
  echo "  ${c_yellow}ВАЖНО: откройте панель ПРЯМО СЕЙЧАС и задайте пароль администратора.${c_reset}"
  echo "  ${c_yellow}Пока пароль не задан, это может сделать любой, кто дотянется до порта ${PANEL_PORT}.${c_reset}"
else
  echo "  Пароль администратора уже задан — просто войдите."
fi
echo
if [ "$WG_ENGINE_ACTIVE" = "awg" ]; then
  echo "  Движок туннеля: ${c_green}AmneziaWG${c_reset} — трафик маскируется от DPI."
  echo "  ${c_yellow}Клиентам нужно приложение AmneziaWG (не AmneziaVPN):${c_reset}"
  echo "    Android: Google Play «AmneziaWG» либо APK — github.com/amnezia-vpn/amneziawg-android/releases"
  echo "    iOS: App Store «AmneziaWG» · Windows: github.com/amnezia-vpn/amneziawg-windows-client/releases"
  echo "  ${c_yellow}Официальное приложение WireGuard эти конфиги не откроет.${c_reset}"
else
  echo "  Движок туннеля: обычный WireGuard (клиентам подойдёт официальное приложение)."
  echo "  Если провайдер режет WireGuard — см. README, раздел «Обход блокировок»."
fi
echo
echo "  Не забудьте открыть порты в firewall:"
echo "    ${WG_UDP_PORT}/udp — трафик WireGuard"
echo "    ${PANEL_PORT}/tcp  — веб-панель (лучше спрятать за reverse proxy с TLS, см. README)"
echo
echo "  Управление: ./logs.sh  ./restart.sh  ./update.sh  ./stop.sh"
