#!/usr/bin/env bash
#
# WireDeck — установка одной командой на Ubuntu/Debian VPS (запуск от root):
#
#   curl -fsSL https://raw.githubusercontent.com/romashuhov/vpn/main/deploy/install.sh | sudo bash
#
# Тонкий бутстрап: ставит git/curl при необходимости, клонирует репозиторий
# в /opt/wiredeck и передаёт управление start.sh — тот проверит Docker,
# настроит .env и запустит контейнер. Пароль администратора задаётся
# в веб-панели при первом входе.

set -euo pipefail

REPO_URL="https://github.com/romashuhov/vpn"
INSTALL_DIR="/opt/wiredeck"

c_green=$'\033[1;32m'; c_yellow=$'\033[1;33m'; c_red=$'\033[1;31m'; c_reset=$'\033[0m'
info() { echo "${c_green}[wiredeck]${c_reset} $*"; }
warn() { echo "${c_yellow}[wiredeck]${c_reset} $*"; }
die()  { echo "${c_red}[wiredeck]${c_reset} $*" >&2; exit 1; }

# Всё тело — в main(): при обрыве curl посреди передачи bash не исполнит
# усечённый скрипт (класс уязвимостей pipe-to-shell).
main() {

[ "$(id -u)" -eq 0 ] || die "Нужны права root. Запустите: curl -fsSL .../install.sh | sudo bash"

if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
fi
case "${ID:-}:${ID_LIKE:-}" in
  *debian*|*ubuntu*) ;;
  *) warn "Скрипт рассчитан на Ubuntu/Debian, обнаружено: ${PRETTY_NAME:-неизвестная ОС}. Продолжаю…" ;;
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

if [ -d "$INSTALL_DIR/.git" ]; then
  info "Каталог $INSTALL_DIR уже существует — обновляю."
  git -C "$INSTALL_DIR" pull --ff-only || warn "Не удалось обновить (локальные изменения?). Продолжаю с текущей версией."
else
  info "Клонирую $REPO_URL в $INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

exec bash "$INSTALL_DIR/start.sh"

}

main "$@"
