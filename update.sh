#!/usr/bin/env bash
# WireDeck — обновление: git pull + пересборка, если задеплоен не текущий коммит.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

c_red=$'\033[1;31m'; c_reset=$'\033[0m'
die() { echo "${c_red}[wiredeck]${c_reset} $*" >&2; exit 1; }

dc() {
  command -v docker >/dev/null 2>&1 || die "Docker не установлен — сначала запустите ./start.sh"
  if docker info >/dev/null 2>&1; then docker compose "$@"; return; fi
  if [ "$(id -u)" -eq 0 ]; then die "Docker-демон не отвечает. Запустите его: systemctl start docker"; fi
  command -v sudo >/dev/null 2>&1 || die "Нет доступа к Docker (нужна группа docker) и нет sudo — запустите от root."
  # sudo с env_reset вычищает окружение; `env VAR=…` протаскивает переменные при необходимости.
  local envargs=()
  [ -n "${WG_HOST+x}" ] && envargs+=("WG_HOST=$WG_HOST")
  sudo env "${envargs[@]}" docker compose "$@"
}

dkr() { # raw docker с тем же sudo-фоллбеком
  if docker info >/dev/null 2>&1; then docker "$@"; else sudo docker "$@"; fi
}

[ -r "$ROOT/deploy/.env" ] || die "Нет читаемого deploy/.env — сначала запустите ./start.sh"

# git отказывает работать в чужом репозитории (dubious ownership) — проверяем заранее.
repo_uid="$(stat -c %u "$ROOT/.git")"
if [ "$repo_uid" != "$(id -u)" ]; then
  repo_user="$(stat -c %U "$ROOT/.git")"
  die "Репозиторий принадлежит пользователю «$repo_user» — запустите обновление от него: sudo -u $repo_user ./update.sh (или sudo ./update.sh, если клонировали под root)."
fi

git pull --ff-only
head="$(git rev-parse HEAD)"
deployed="$(cat "$ROOT/deploy/.deployed" 2>/dev/null || true)"
if [ "$head" = "$deployed" ]; then
  echo "[wiredeck] Задеплоен актуальный коммит (${head:0:7}) — пересборка не нужна."
  exit 0
fi

cd "$ROOT/deploy"
# Контейнер от версий до фиксации имени compose-проекта (проект «deploy») —
# без этого up упёрся бы в занятое имя контейнера.
dkr rm -f wiredeck >/dev/null 2>&1 || true
dc up -d --build
# Метку пишем только после успешного up: если сборка упала, следующий запуск повторит её.
git -C "$ROOT" rev-parse HEAD > "$ROOT/deploy/.deployed"
echo "[wiredeck] Обновлено: задеплоен ${head:0:7}."
