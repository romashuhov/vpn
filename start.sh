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
    # Без этой строки выбор тома для миграции терялся бы при перезапуске через
    # sudo, и скрипт снова упирался бы в «несколько старых томов, выберите сами».
    [ -n "${WIREDECK_MIGRATE_FROM+x}" ] && envargs+=("WIREDECK_MIGRATE_FROM=$WIREDECK_MIGRATE_FROM")
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

# --- единственный экземпляр --------------------------------------------------
# Вся логика переноса данных построена на допущении «контейнер остановлен, в
# базу никто не пишет». Против ВТОРОГО экземпляра скрипта это допущение ничем не
# обеспечено: два параллельных запуска (второй ssh-сеанс, cron с ./update.sh
# плюс ручной ./start.sh, нетерпеливый повтор после «зависшей» сборки) оба
# увидят пустой целевой том — первый скопирует базу и поднимет панель, а второй
# начнёт копировать ПОВЕРХ файла, уже открытого живым SQLite. Это гарантированная
# порча базы, причём уже после сообщения «Готово». Заодно снимается гонка двух
# `docker compose up -d` за имя контейнера.
lock_ok=0
if command -v flock >/dev/null 2>&1 && : >>"$DEPLOY/.lock" 2>/dev/null; then
  exec 9>>"$DEPLOY/.lock"
  if flock -n 9; then
    lock_ok=1
  else
    die "Другой ./start.sh или ./update.sh уже работает — дождитесь его завершения (иначе оба будут писать в один том с базой)."
  fi
fi
[ "$lock_ok" -eq 1 ] \
  || warn "Блокировка недоступна (нет flock или нет прав на deploy/.lock) — не запускайте ./start.sh и ./update.sh одновременно."

# === Том с данными и миграция со старого имени ===============================
# ВНИМАНИЕ: блок ниже продублирован в update.sh (различается только обёртка
# dkr) — правки вносить в оба файла. Дублирование намеренное: каждый скрипт
# должен работать сам по себе, без общих подключаемых файлов.
#
# До появления `name: wiredeck` в docker-compose.yml compose брал имя проекта из
# каталога («deploy») и создавал том deploy_wiredeck_data. После фиксации имён
# том называется wiredeck_data — и установка, развёрнутая ДО этого изменения,
# при обычном обновлении подключила бы ДРУГОЙ, пустой том: пропали бы
# пользователи, ключи сервера, статистика и пароль администратора. Панель
# встретила бы экраном первичной настройки, а клиенты перестали бы подключаться,
# потому что у сервера новые ключи. Поэтому перед первым запуском данные
# переносятся автоматически, а старый том НИКОГДА не удаляется — он остаётся
# единственной страховкой пользователя.

DATA_VOLUME=wiredeck_data
MIGRATION_MARK=.migrated-from # метка внутри нового тома: перенос уже выполнен
MIGRATING_MARK=.migrating     # метка «перенос идёт прямо сейчас» (см. do_data_migration)
MIGRATE_TMP=.migrate-tmp      # временный каталог внутри целевого тома

# План переноса: заполняет plan_data_migration, выполняет do_data_migration.
MIGRATE_SRC=""
MIGRATE_PLANNED=0

# В start.sh docker заведомо доступен текущему пользователю (выше скрипт либо
# перезапустился через sudo, либо проверил `docker info`). Обёртка существует
# только ради дословного совпадения блока с update.sh, где нужен sudo-фоллбек.
dkr() { docker "$@"; }

vol_exists() { dkr volume inspect "$1" >/dev/null 2>&1; }

# Образ для операций с томами. Сначала берём то, что уже есть локально: перенос
# данных обязан работать и на сервере без интернета (типовой сценарий — VPS,
# где docker hub уже недоступен, а обновиться надо).
helper_image() {
  local img
  for img in alpine:latest busybox:latest wiredeck-wiredeck:latest deploy-wiredeck:latest; do
    if [ -n "$(dkr images -q "$img" 2>/dev/null || true)" ]; then
      printf '%s' "$img"
      return 0
    fi
  done
  dkr pull -q alpine >/dev/null 2>&1 || return 1
  printf '%s' alpine
  return 0
}

# Есть ли файл в томе. Коды: 0 — есть, 1 — нет, 2 — проверить не удалось.
# Третье состояние принципиально: «не знаю» нельзя считать «пусто» — именно так
# и затирают чужую базу. Сначала пробуем каталог тома на хосте (быстро и не
# требует образа), потом — контейнером.
vol_has_file() { # $1 = существующий том, $2 = имя файла внутри
  local mp img rc=0
  mp="$(dkr volume inspect -f '{{ .Mountpoint }}' "$1" 2>/dev/null || true)"
  # Быстрой ветке доверяем ТОЛЬКО если каталог тома реально читаем и проходим.
  # `test -e` даёт «нет» и когда файла нет, и когда нет прав (EACCES), а
  # различить их нельзя — то есть третье состояние «не знаю» она не выдаёт
  # никогда. Каталог тома принадлежит root и закрыт (сервер сам дожимает 0700),
  # а docker-команды уходят под sudo, тогда как сам `test` выполняется от
  # исходного пользователя: на хосте, где каталог томов проходим не-root'ом,
  # живая боевая база опозналась бы как «файла нет» — и её затёрли бы старой
  # копией или молча сменили движок туннеля. Не уверены — идём в контейнер.
  if [ -n "$mp" ] && [ -d "$mp" ] && [ -r "$mp" ] && [ -x "$mp" ]; then
    [ -e "$mp/$2" ] && return 0
    return 1
  fi
  img="$(helper_image)" || return 2
  dkr run --rm -v "$1:/vol:ro" "$img" sh -c "[ -e '/vol/$2' ]" >/dev/null 2>&1 || rc=$?
  case "$rc" in
    0) return 0 ;;
    1) return 1 ;;
    *) return 2 ;; # docker не смог запуститься — это «неизвестно», а не «пусто»
  esac
}

# Тома вида <проект>_wiredeck_data. Имя старого тома зависит от каталога
# установки (для /opt/wiredeck/deploy это ровно deploy_wiredeck_data, но каталог
# мог называться иначе), поэтому ищем по суффиксу, а не по одному имени.
legacy_volumes() {
  dkr volume ls -q 2>/dev/null | tr -d '\r' \
    | grep -E '^[A-Za-z0-9][A-Za-z0-9_.-]*_wiredeck_data$' || true
}

# Похоже ли, что установка уже работала (в каком-то из томов лежит боевая база).
# «Проверить не удалось» трактуем как «данные есть»: осторожная ошибка не ломает
# ничего, обратная — молча меняет движок туннеля у живой установки.
installation_has_data() {
  local v rc
  for v in "$DATA_VOLUME" $(legacy_volumes); do
    vol_exists "$v" || continue
    rc=0
    vol_has_file "$v" wiredeck.db || rc=$?
    [ "$rc" -ne 1 ] && return 0
  done
  return 1
}

# Планирование переноса — ТОЛЬКО чтение. Здесь живут все отказы (неоднозначный
# источник, недоступный том, нет образа), поэтому вызывать эту функцию нужно ДО
# остановки контейнера: иначе безопасная проверка сама роняет VPN и оставляет
# его лежать без автоматического отката, пока владелец не прочитает сообщение.
plan_data_migration() {
  local override="${WIREDECK_MIGRATE_FROM:-}"
  local candidates=() sources=() v rc src="" target_has=0

  # Оборванный предыдущий перенос — проверяем ПЕРВЫМ делом и не пропускаем даже
  # по WIREDECK_MIGRATE_FROM=none: в целевом томе лежит недокопированная база,
  # и поднимать на ней панель нельзя ни при каких условиях (см. do_data_migration).
  if vol_exists "$DATA_VOLUME"; then
    rc=0
    vol_has_file "$DATA_VOLUME" "$MIGRATING_MARK" || rc=$?
    [ "$rc" -eq 0 ] && die "Предыдущий перенос данных оборвался: в томе $DATA_VOLUME осталась метка $MIGRATING_MARK, значит его содержимое НЕПОЛНОЕ (частично скопированная база). Запускать панель на нём нельзя. Ваши данные целы в старом томе — посмотрите: docker volume ls | grep _wiredeck_data. Очистите новый том и повторите: docker run --rm -v $DATA_VOLUME:/v alpine sh -c 'rm -rf /v/..?* /v/.[!.]* /v/*' && ./start.sh"
  fi

  case "$override" in
    off | none | skip)
      warn "Миграция тома данных пропущена по требованию (WIREDECK_MIGRATE_FROM=$override)."
      return 0
      ;;
  esac

  while IFS= read -r v; do
    [ -n "$v" ] && candidates+=("$v")
  done < <(legacy_volumes)
  [ "${#candidates[@]}" -eq 0 ] && return 0 # старых томов нет — обычный случай

  if vol_exists "$DATA_VOLUME"; then
    rc=0
    vol_has_file "$DATA_VOLUME" wiredeck.db || rc=$?
    [ "$rc" -eq 2 ] && die "Не удалось заглянуть в том $DATA_VOLUME (нет доступа к каталогу тома и не нашлось образа для проверки). Останавливаюсь: вслепую запускать нельзя — можно потерять данные. Посмотрите сами: docker volume ls"
    target_has=$((rc == 0 ? 1 : 0))
  fi

  for v in "${candidates[@]}"; do
    rc=0
    vol_has_file "$v" wiredeck.db || rc=$?
    [ "$rc" -eq 2 ] && die "Не удалось заглянуть в старый том $v. Останавливаюсь, чтобы не запустить панель с пустой базой. Посмотрите сами: docker volume ls"
    [ "$rc" -eq 0 ] && sources+=("$v")
  done
  [ "${#sources[@]}" -eq 0 ] && return 0 # старые тома пустые — переносить нечего

  if [ -n "$override" ]; then
    for v in "${sources[@]}"; do
      [ "$v" = "$override" ] && src="$v"
    done
    [ -n "$src" ] || die "WIREDECK_MIGRATE_FROM=$override: тома с базой wiredeck.db с таким именем нет. Есть: ${sources[*]}"
  elif [ "${#sources[@]}" -eq 1 ]; then
    src="${sources[0]}"
  fi

  if [ "$target_has" -eq 1 ]; then
    # Метка означает, что перенос уже делали, и старый том — просто бэкап.
    # Без неё каждый последующий запуск пугал бы предупреждением на пустом месте.
    rc=0
    vol_has_file "$DATA_VOLUME" "$MIGRATION_MARK" || rc=$?
    [ "$rc" -eq 0 ] && return 0
    warn "ВНИМАНИЕ: база есть И в новом томе $DATA_VOLUME, И в старом (${sources[*]})."
    warn "Ничего не трогаю: какой из них актуален — решать вам. Панель поднимется на $DATA_VOLUME."
    warn "Заглянуть внутрь:   docker run --rm -v <том>:/v alpine ls -l /v"
    warn "Взять старый: ./stop.sh, потом очистить новый том"
    warn "  docker run --rm -v $DATA_VOLUME:/v alpine sh -c 'rm -rf /v/..?* /v/.[!.]* /v/*'"
    warn "  и запустить  WIREDECK_MIGRATE_FROM=${sources[0]} ./start.sh"
    return 0
  fi

  [ -n "$src" ] || die "Нашёл несколько старых томов с базой: ${sources[*]}. Угадывать, где данные ваших пользователей, не буду. Укажите явно: WIREDECK_MIGRATE_FROM=<том> ./start.sh (или WIREDECK_MIGRATE_FROM=none, чтобы начать с чистой базы)."

  # Образ для копирования ищем (и при необходимости тянем) уже здесь: этот отказ
  # тоже обязан случиться до остановки работающего контейнера.
  helper_image >/dev/null || die "Для переноса нужен образ alpine: локально его нет, скачать не вышло (нет сети?). Панель НЕ трогаю — иначе она поднялась бы с пустой базой и новыми ключами сервера. Данные целы в томе $src. Повторите позже или перенесите вручную: docker run --rm -v $src:/from -v $DATA_VOLUME:/to alpine sh -c 'cp -a /from/. /to/'"

  info "Обнаружены данные прошлой установки в томе $src (имя тома до фиксации имени compose-проекта)."
  MIGRATE_SRC="$src"
  MIGRATE_PLANNED=1
  return 0
}

# Собственно перенос. Вызывать ПОСЛЕ остановки старого контейнера (иначе
# копировали бы базу из-под пишущего процесса) и ДО `docker compose up` (иначе
# панель успеет создать пустую базу в новом томе).
do_data_migration() {
  [ "$MIGRATE_PLANNED" -eq 1 ] || return 0
  local src="$MIGRATE_SRC" img
  img="$(helper_image)" || die "Образ для переноса внезапно недоступен. Панель НЕ запускаю: данные целы в томе $src."

  if ! vol_exists "$DATA_VOLUME"; then
    # Создаём том сами и сразу с метками compose. Том, впервые созданный через
    # `docker run -v`, остаётся без них, и после этого КАЖДЫЙ `docker compose up`
    # печатает «volume wiredeck_data already exists but was not created by Docker
    # Compose», советуя лезть в compose-файл за external: true — ровно на тех
    # установках, которые только что пережили миграцию.
    dkr volume create --label com.docker.compose.project=wiredeck \
      --label com.docker.compose.volume=wiredeck_data "$DATA_VOLUME" >/dev/null 2>&1 || true
  fi

  info "Переношу данные в $DATA_VOLUME: пользователи, ключи сервера, статистика, пароль администратора…"

  # Двухфазный перенос с меткой «в процессе». Раньше копирование шло прямо в
  # целевой том, а признак завершённости ставился только после успеха — любой
  # обрыв на полпути (Ctrl+C, reboot, OOM и в первую очередь «кончилось место»,
  # то есть самая ожидаемая ошибка) оставлял огрызок, который следующий запуск
  # опознавал как «база уже есть» и молча поднимал панель на нём. Самый
  # неприятный исход тихий: wiredeck.db скопирован, а wiredeck.db-wal нет —
  # SQLite откроется без ошибок и откатится к последней контрольной точке, а её
  # может не быть неделями (авточекпойнт better-sqlite3 — 1000 страниц), то есть
  # панель встретит экраном первичной настройки при формально «целой» базе.
  # Метку пишем БЕЗ `|| true`: не смогли поставить — перенос начинать нельзя.
  dkr run --rm -v "$DATA_VOLUME:/to" "$img" \
    sh -c "printf '%s\n' 'migrating from $src' > '/to/$MIGRATING_MARK'" >/dev/null \
    || die "Не удалось записать метку начала переноса в том $DATA_VOLUME. Перенос НЕ начат, данные целы в томе $src. Проверьте место на диске (df -h) и права."

  # Копируем во временный каталог ВНУТРИ целевого тома и только потом
  # подставляем: обрыв на любом шаге не оставляет полуфайлов на месте боевых.
  dkr run --rm -e "TMP_NAME=$MIGRATE_TMP" -v "$src:/from" -v "$DATA_VOLUME:/to" "$img" sh -c '
    set -e
    rm -rf "/to/$TMP_NAME"
    mkdir "/to/$TMP_NAME"
    cp -a /from/. "/to/$TMP_NAME/"
    cd "/to/$TMP_NAME"
    for f in * .[!.]* ..?*; do
      [ -e "$f" ] || continue
      mv -f "$f" /to/
    done
    cd /
    rmdir "/to/$TMP_NAME"
  ' >/dev/null \
    || die "Копирование $src → $DATA_VOLUME не удалось (место на диске? df -h). Панель НЕ запускаю. Старый том $src не тронут — данные целы там. В томе $DATA_VOLUME осталась метка $MIGRATING_MARK, поэтому следующий запуск тоже откажется поднимать панель на неполных данных: очистите том и повторите."

  dkr run --rm -v "$DATA_VOLUME:/to" "$img" \
    sh -c "printf '%s\n' '$src' > '/to/$MIGRATION_MARK' && rm -f '/to/$MIGRATING_MARK'" >/dev/null \
    || die "Данные скопированы полностью, но метки в томе $DATA_VOLUME обновить не удалось. Пока метка $MIGRATING_MARK на месте, следующий запуск будет считать перенос оборванным. Поправьте вручную: docker run --rm -v $DATA_VOLUME:/v alpine sh -c 'echo $src > /v/$MIGRATION_MARK; rm -f /v/$MIGRATING_MARK'"

  info "Данные перенесены. Старый том $src оставлен как резервная копия — мы его не удаляем."
  return 0
}

# Висячие образы от прошлых сборок. Каждая пересборка перевешивает тег на новый
# образ, а предыдущий остаётся как <none> и не удаляется никогда. На типовом VPS
# десяток обновлений упирается в «нет места» — то самое, которым скрипты
# объясняют собственные отказы (включая прерванный перенос базы). Фильтр по
# метке нашего образа обязателен: голый `image prune` снёс бы и чужие висячие
# слои на том же хосте.
prune_dangling_images() {
  dkr image prune -f --filter label=org.wiredeck.image=1 >/dev/null 2>&1 || true
  return 0
}
# === конец блока, продублированного в update.sh ==============================

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
    # Страховка на случай .env без перевода строки в конце (правили руками):
    # иначе WG_HOST= приклеился бы к последней строке и обе переменные пропали бы.
    [ -s "$tmp_env" ] && [ -n "$(tail -c 1 "$tmp_env")" ] && printf '\n' >> "$tmp_env"
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

# Дописать строку в deploy/.env. Отдельная функция, потому что голое `>>`
# склеивает новую переменную с предыдущей строкой, если пользователь правил
# .env руками и не оставил перевод строки в конце: получилось бы
# `WG_HOST=1.2.3.4WG_PORT=51820`, то есть молча испорченный конфиг — compose
# подставил бы битый WG_HOST в Endpoint клиентских конфигов.
env_append() { # $1 = строка вида KEY=value
  if [ -s "$ENV_FILE" ] && [ -n "$(tail -c 1 "$ENV_FILE" 2>/dev/null || true)" ]; then
    printf '\n' >> "$ENV_FILE" || return 1
  fi
  printf '%s\n' "$1" >> "$ENV_FILE"
}

ensure_port() { # $1 = имя переменной, $2 = tcp|udp, $3 = дефолт
  env_has "$1" && return 0 # порт уже зафиксирован — не трогаем
  if [ -n "$(docker ps -aq -f 'name=^wiredeck$' 2>/dev/null || true)" ]; then
    return 0 # контейнер существует: занятость дефолтов — это мы сами
  fi
  local want got
  want="${!1:-$3}"
  got="$(pick_free_port "$2" "$want")"
  [ "$got" != "$want" ] && warn "Порт $want/$2 занят — использую $got."
  if env_append "$1=$got" 2>/dev/null; then
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
  # Новая установка — это отсутствие И контейнера, И данных. Проверять только
  # контейнер было нельзя: после ./stop.sh (или ./uninstall.sh без --purge)
  # контейнера нет, а том с базой есть — и следующий ./start.sh молча дописывал
  # бы WG_ENGINE=awg, после чего ВСЕ ранее выданные клиентские конфиги
  # перестали бы работать (движки несовместимы по рукопожатию).
  if [ -n "$(docker ps -aq -f 'name=^wiredeck$' 2>/dev/null || true)" ]; then
    return 0 # контейнер уже есть: это обновление, движок оставляем прежним
  fi
  if installation_has_data; then
    if [ -n "${WG_ENGINE:-}" ] && [ "$WG_ENGINE" != "wg" ]; then
      # compose подхватывает WG_ENGINE прямо из окружения, поэтому переменная
      # сработала бы на ЭТОТ запуск, но не пережила бы ./restart.sh: установка
      # «мигала» бы между движками и ломала все выданные конфиги ДВАЖДЫ —
      # сначала при запуске, потом при первом же перезапуске без переменной.
      # Warn в потоке из десятков строк вывода легко не заметить, а цена ошибки
      # — неработающий VPN у всех пользователей, поэтому останавливаемся.
      die "WG_ENGINE=$WG_ENGINE задан в окружении, но установка уже работает (найдены данные прошлой установки). Смена движка ломает ВСЕ выданные клиентские конфиги, а через окружение она к тому же не переживёт ./restart.sh — движок вернётся обратно, и клиенты сломаются второй раз.
  Запустить как есть (движок не меняется):  unset WG_ENGINE && ./start.sh
  Сменить движок осознанно:                 printf '\\nWG_ENGINE=$WG_ENGINE\\n' >> deploy/.env && ./restart.sh
  После смены придётся перевыдать конфиги всем клиентам — см. README, раздел «Обход блокировок»."
    fi
    info "Нашёл данные прошлой установки — движок туннеля не меняю (WG_ENGINE не задан = обычный WireGuard)."
    info "Переключиться на AmneziaWG осознанно: printf '\\nWG_ENGINE=awg\\n' >> deploy/.env && ./restart.sh"
    info "После переключения придётся перевыдать конфиги всем клиентам — см. README, раздел «Обход блокировок»."
    return 0
  fi
  local want="${WG_ENGINE:-awg}"
  case "$want" in
    wg | awg) ;;
    *)
      warn "Неизвестное значение WG_ENGINE=$want — использую awg."
      want=awg
      ;;
  esac
  if env_append "WG_ENGINE=$want" 2>/dev/null; then
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

info "Собираю образ (первая сборка может занять несколько минут)…"
cd "$DEPLOY"
# Сборка отдельным шагом и ДО подмены контейнера: если она упадёт (нет сети,
# кончилось место, ошибка компиляции), уже работающий VPN остаётся работать на
# старом образе, а не лежит без автоматического отката.
docker compose build \
  || die "Сборка образа не удалась. Уже запущенный контейнер (если он был) не тронут и продолжает работать — VPN у клиентов жив. Частые причины: нет сети или кончилось место (df -h). Разберитесь по выводу выше и повторите ./start.sh"

# Все проверки переноса данных — ДО остановки контейнера. Они ничего не меняют в
# системе, но могут потребовать решения владельца (несколько старых томов,
# недоступный том, нет образа); случись это после `docker rm -f`, VPN и панель
# уже лежали бы, а скрипт вышел бы с ошибкой без автоматического отката.
plan_data_migration

# Миграция со старого имени compose-проекта («deploy»): контейнер «wiredeck»
# от старого проекта занял бы имя и не дал подняться новому. Трогаем его только
# если в НАШЕМ проекте контейнеров нет, а имя занято.
if [ -z "$(docker compose ps -q 2>/dev/null || true)" ] \
  && [ -n "$(docker ps -aq -f 'name=^wiredeck$' 2>/dev/null || true)" ]; then
  info "Убираю контейнер от старой версии (миграция имени compose-проекта)…"
  docker rm -f wiredeck >/dev/null 2>&1 || true
fi

# Строго здесь: старый контейнер уже остановлен (никто не пишет в базу), а новый
# ещё не поднят (иначе он создал бы пустую базу в новом томе, и перенос стал бы
# конфликтом «данные в обоих томах»).
do_data_migration

info "Запускаю контейнер…"
docker compose up -d
prune_dangling_images

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
