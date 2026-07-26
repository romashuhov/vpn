#!/usr/bin/env bash
#
# WireDeck — установка одной командой на Ubuntu/Debian VPS (запуск от root):
#
#   curl -fsSL https://raw.githubusercontent.com/romashuhov/vpn/main/deploy/install.sh | sudo bash
#
# Что делает: проверяет/ставит Docker, клонирует репозиторий в /opt/wiredeck,
# спрашивает публичный IP, пишет deploy/.env и запускает docker compose.

set -euo pipefail

REPO_URL="https://github.com/romashuhov/vpn"
INSTALL_DIR="/opt/wiredeck"
ENV_FILE="$INSTALL_DIR/deploy/.env"
PANEL_PORT=8080
WG_UDP_PORT=51820

c_green=$'\033[1;32m'; c_yellow=$'\033[1;33m'; c_red=$'\033[1;31m'; c_reset=$'\033[0m'
info() { echo "${c_green}[wiredeck]${c_reset} $*"; }
warn() { echo "${c_yellow}[wiredeck]${c_reset} $*"; }
die()  { echo "${c_red}[wiredeck]${c_reset} $*" >&2; exit 1; }

# --- ввод с терминала (работает и при `curl | bash`, когда stdin — пайп) -----

have_tty() { { : </dev/tty; } 2>/dev/null; }

# ask "вопрос" имя_переменной "дефолт"
ask() {
  local prompt="$1" __var="$2" def="${3-}" answer=""
  if have_tty; then
    read -r -p "$prompt" answer </dev/tty || true
  fi
  printf -v "$__var" '%s' "${answer:-$def}"
}

# confirm "вопрос" — явный y/n, по умолчанию «нет»
confirm() {
  local answer
  ask "$1 [y/N]: " answer "n"
  [[ "$answer" =~ ^[YyДд] ]]
}

# --- проверки окружения ------------------------------------------------------

[ "$(id -u)" -eq 0 ] || die "Нужны права root. Запустите: curl -fsSL .../install.sh | sudo bash"

if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
fi
case "${ID:-}:${ID_LIKE:-}" in
  *debian*|*ubuntu*) ;;
  *)
    warn "Скрипт рассчитан на Ubuntu/Debian, обнаружено: ${PRETTY_NAME:-неизвестная ОС}."
    confirm "Продолжить на свой страх и риск?" || die "Установка прервана."
    ;;
esac

# git и curl нужны самому скрипту
missing_pkgs=()
command -v git  >/dev/null 2>&1 || missing_pkgs+=(git)
command -v curl >/dev/null 2>&1 || missing_pkgs+=(curl)
if [ "${#missing_pkgs[@]}" -gt 0 ]; then
  info "Устанавливаю недостающие пакеты: ${missing_pkgs[*]}"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing_pkgs[@]}"
fi

# --- Docker + compose plugin -------------------------------------------------

docker_ok()  { command -v docker >/dev/null 2>&1; }
compose_ok() { docker compose version >/dev/null 2>&1; }

if ! docker_ok || ! compose_ok; then
  if ! docker_ok; then
    warn "Docker не найден."
  else
    warn "Docker есть, но нет плагина «docker compose»."
  fi
  if confirm "Установить Docker (вместе с compose) официальным скриптом get.docker.com?"; then
    info "Устанавливаю Docker…"
    curl -fsSL https://get.docker.com | sh
  else
    die "Без Docker продолжить нельзя. Установите его вручную (https://docs.docker.com/engine/install/) и запустите скрипт снова."
  fi
  docker_ok  || die "Docker так и не появился в PATH — установка не удалась."
  compose_ok || die "Плагин «docker compose» недоступен — установите docker-compose-plugin и запустите скрипт снова."
fi

# --- код панели --------------------------------------------------------------

if [ -d "$INSTALL_DIR/.git" ]; then
  info "Каталог $INSTALL_DIR уже существует — обновляю."
  git -C "$INSTALL_DIR" pull --ff-only || warn "Не удалось обновить (локальные изменения?). Продолжаю с текущей версией."
else
  info "Клонирую $REPO_URL в $INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

# --- публичный адрес сервера -------------------------------------------------

detected_ip="$(curl -4fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)"
if [ -n "$detected_ip" ]; then
  info "Определён публичный IP: $detected_ip"
else
  warn "Не удалось определить публичный IP автоматически."
fi

ask "Публичный IP или домен сервера [${detected_ip:-введите вручную}]: " wg_host "$detected_ip"
[ -n "$wg_host" ] || die "WG_HOST обязателен: без него клиентские конфиги не будут указывать на ваш сервер."

# --- .env (сохраняем прочие переменные, если файл уже был) -------------------

tmp_env="$(mktemp)"
if [ -f "$ENV_FILE" ]; then
  grep -v '^WG_HOST=' "$ENV_FILE" > "$tmp_env" || true
fi
printf 'WG_HOST=%s\n' "$wg_host" >> "$tmp_env"
install -m 600 "$tmp_env" "$ENV_FILE"
rm -f "$tmp_env"
info "Записал $ENV_FILE (WG_HOST=$wg_host)"

# --- сборка и запуск ---------------------------------------------------------

info "Собираю и запускаю контейнер (первая сборка может занять несколько минут)…"
cd "$INSTALL_DIR/deploy"
docker compose up -d --build

# --- первичный пароль администратора -----------------------------------------
# Пока пароль не задан, /api/auth/setup открыт любому, кто первым откроет
# панель, а свежеоткрытый 8080/tcp сканеры находят за минуты. Закрываем окно
# сразу: генерируем случайный пароль и задаём его локально через API.

admin_password=""
panel_local="http://127.0.0.1:${PANEL_PORT}"
info "Жду запуска панели, чтобы задать первичный пароль администратора…"
auth_status=""
for _ in $(seq 1 30); do
  auth_status="$(curl -fsS --max-time 2 "$panel_local/api/auth/status" 2>/dev/null || true)"
  if [ -n "$auth_status" ]; then break; fi
  sleep 2
done

if [ -z "$auth_status" ]; then
  warn "Панель не ответила за 60 секунд — первичный пароль НЕ задан."
  warn "ВАЖНО: пока пароль не задан, панель может захватить первый, кто её откроет."
  warn "Проверьте логи (docker logs wiredeck), затем откройте панель и задайте пароль немедленно."
elif printf '%s' "$auth_status" | grep -q '"needsSetup":true'; then
  admin_password="$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  if curl -fsS -X POST -H 'Content-Type: application/json' \
      -d "{\"password\":\"${admin_password}\"}" \
      "$panel_local/api/auth/setup" >/dev/null 2>&1; then
    info "Задан случайный первичный пароль администратора."
  else
    admin_password=""
    warn "Не удалось задать первичный пароль через API."
    warn "ВАЖНО: откройте панель и задайте пароль немедленно — до этого её может захватить кто угодно."
  fi
else
  info "Пароль администратора уже настроен — пропускаю."
fi

# --- итог --------------------------------------------------------------------

echo
info "Готово! WireDeck запущен."
echo
echo "  Панель управления:  ${c_green}http://${wg_host}:${PANEL_PORT}${c_reset}"
if [ -n "$admin_password" ]; then
  echo
  echo "  Пароль администратора: ${c_yellow}${admin_password}${c_reset}"
  echo "  Сохраните его в надёжном месте — он больше нигде не выводится."
fi
echo
echo "  Не забудьте открыть порты в firewall:"
echo "    ${WG_UDP_PORT}/udp — трафик WireGuard"
echo "    ${PANEL_PORT}/tcp  — веб-панель (лучше спрятать за reverse proxy с TLS, см. README)"
echo "  Например, для ufw:"
echo "    ufw allow ${WG_UDP_PORT}/udp && ufw allow ${PANEL_PORT}/tcp"
echo
echo "  Логи:      docker logs -f wiredeck"
echo "  Обновление: повторный запуск этого скрипта."
