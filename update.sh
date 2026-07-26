#!/usr/bin/env bash
# WireDeck — обновление: git pull + пересборка, если задеплоен не текущий коммит.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

c_green=$'\033[1;32m'; c_yellow=$'\033[1;33m'; c_red=$'\033[1;31m'; c_reset=$'\033[0m'
info() { echo "${c_green}[wiredeck]${c_reset} $*"; }
warn() { echo "${c_yellow}[wiredeck]${c_reset} $*"; }
die()  { echo "${c_red}[wiredeck]${c_reset} $*" >&2; exit 1; }

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

# --- единственный экземпляр --------------------------------------------------
# Вся логика переноса данных построена на допущении «контейнер остановлен, в
# базу никто не пишет». Против ВТОРОГО экземпляра скрипта это допущение ничем не
# обеспечено: два параллельных запуска (cron с ./update.sh плюс ручной
# ./start.sh, второй ssh-сеанс, нетерпеливый повтор после «зависшей» сборки)
# оба увидят пустой целевой том — первый скопирует базу и поднимет панель, а
# второй начнёт копировать ПОВЕРХ файла, уже открытого живым SQLite. Заодно
# снимается гонка двух `docker compose up -d` за имя контейнера.
lock_ok=0
if command -v flock >/dev/null 2>&1 && : >>"$ROOT/deploy/.lock" 2>/dev/null; then
  exec 9>>"$ROOT/deploy/.lock"
  if flock -n 9; then
    lock_ok=1
  else
    die "Другой ./start.sh или ./update.sh уже работает — дождитесь его завершения (иначе оба будут писать в один том с базой)."
  fi
fi
[ "$lock_ok" -eq 1 ] \
  || warn "Блокировка недоступна (нет flock или нет прав на deploy/.lock) — не запускайте ./start.sh и ./update.sh одновременно."

# === Том с данными и миграция со старого имени ===============================
# ВНИМАНИЕ: блок ниже продублирован в start.sh (различается только обёртка
# dkr) — правки вносить в оба файла. Дублирование намеренное: каждый скрипт
# должен работать сам по себе, без общих подключаемых файлов.
#
# До появления `name: wiredeck` в docker-compose.yml compose брал имя проекта из
# каталога («deploy») и создавал том deploy_wiredeck_data. После фиксации имён
# том называется wiredeck_data — и установка, развёрнутая ДО этого изменения,
# при обычном ./update.sh подключила бы ДРУГОЙ, пустой том: пропали бы
# пользователи, ключи сервера, статистика и пароль администратора. Панель
# встретила бы экраном первичной настройки, а клиенты перестали бы подключаться,
# потому что у сервера новые ключи. Поэтому перед подъёмом контейнера данные
# переносятся автоматически, а старый том НИКОГДА не удаляется — он остаётся
# единственной страховкой пользователя.

DATA_VOLUME=wiredeck_data
MIGRATION_MARK=.migrated-from # метка внутри нового тома: перенос уже выполнен
MIGRATING_MARK=.migrating     # метка «перенос идёт прямо сейчас» (см. do_data_migration)
MIGRATE_TMP=.migrate-tmp      # временный каталог внутри целевого тома

# План переноса: заполняет plan_data_migration, выполняет do_data_migration.
MIGRATE_SRC=""
MIGRATE_PLANNED=0

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
    [ "$rc" -eq 0 ] && die "Предыдущий перенос данных оборвался: в томе $DATA_VOLUME осталась метка $MIGRATING_MARK, значит его содержимое НЕПОЛНОЕ (частично скопированная база). Запускать панель на нём нельзя. Ваши данные целы в старом томе — посмотрите: docker volume ls | grep _wiredeck_data. Очистите новый том и повторите: docker run --rm -v $DATA_VOLUME:/v alpine sh -c 'rm -rf /v/..?* /v/.[!.]* /v/*' && ./update.sh"
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

  [ -n "$src" ] || die "Нашёл несколько старых томов с базой: ${sources[*]}. Угадывать, где данные ваших пользователей, не буду. Укажите явно: WIREDECK_MIGRATE_FROM=<том> ./update.sh (или WIREDECK_MIGRATE_FROM=none, чтобы начать с чистой базы)."

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
# === конец блока, продублированного в start.sh ===============================

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

# Сначала СБОРКА — и только потом остановка/подъём. Раньше контейнер убивался до
# сборки: любая её неудача (нет сети, ошибка компиляции, кончилось место)
# оставляла VPN лежать без автоматического отката. Теперь при провале сборки
# работающая версия просто продолжает работать.
info "Собираю новый образ (${head:0:7})…"
dc build \
  || die "Сборка не удалась — обновление отменено. ${c_green}Текущая версия продолжает работать${c_reset}: контейнер не тронут, клиенты подключены. Частые причины: нет сети или кончилось место (df -h). Разберитесь по выводу выше и повторите ./update.sh"

# Все проверки переноса данных — ДО остановки контейнера. Они ничего не меняют в
# системе, но могут потребовать решения владельца (несколько старых томов,
# недоступный том, нет образа); случись это после `dkr rm -f`, VPN и панель уже
# лежали бы, а выигрыш от сборки до остановки был бы съеден целиком.
plan_data_migration

# Контейнер от версий до фиксации имени compose-проекта (проект «deploy») —
# без этого up упёрся бы в занятое имя контейнера. Трогаем только если в НАШЕМ
# проекте контейнеров нет, а имя занято (иначе зря рвали бы соединения:
# `dc up -d` и так пересоздаст контейнер под новый образ).
if [ -z "$(dc ps -q 2>/dev/null || true)" ] \
  && [ -n "$(dkr ps -aq -f 'name=^wiredeck$' 2>/dev/null || true)" ]; then
  info "Убираю контейнер от старой версии (миграция имени compose-проекта)…"
  dkr rm -f wiredeck >/dev/null 2>&1 || true
fi

# Строго здесь: образ уже собран, старый контейнер остановлен (никто не пишет в
# базу), а новый ещё не поднят (иначе он создал бы пустую базу в новом томе).
do_data_migration

dc up -d
prune_dangling_images
# Метку пишем только после успешного up: если сборка упала, следующий запуск повторит её.
git -C "$ROOT" rev-parse HEAD > "$ROOT/deploy/.deployed"
echo "[wiredeck] Обновлено: задеплоен ${head:0:7}."
