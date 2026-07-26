# syntax=docker/dockerfile:1
#
# WireDeck — multi-stage сборка.
# Контекст сборки — КОРЕНЬ репозитория (см. deploy/docker-compose.yml: context: ..).
#
#   docker build -f deploy/Dockerfile -t wiredeck .

# ---------------------------------------------------------------------------
# Stage 1: build — устанавливаем все зависимости, собираем web (Vite) и server (tsc)
# ---------------------------------------------------------------------------
FROM node:24-alpine AS build

# Тулчейн для сборки нативных модулей (better-sqlite3)
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Сначала только манифесты — чтобы npm install кэшировался между сборками.
# package-lock.json* — glob: не падаем, если lock-файла (пока) нет.
COPY package.json package-lock.json* ./
COPY server/package.json server/
COPY web/package.json web/

RUN npm install

# Исходники — копируем адресно, чтобы не затащить хостовые node_modules/dist
COPY server/tsconfig.json server/
COPY server/src server/src
COPY web/tsconfig.json web/vite.config.ts web/index.html web/
COPY web/src web/src

# Корневой скрипт: build web (tsc --noEmit + vite build) → build server (tsc)
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2a: amneziawg-go — userspace-демон AmneziaWG (движок WG_ENGINE=awg).
#
# В контейнере модуля ядра amneziawg нет, поэтому awg-quick откатывается на
# userspace-реализацию (см. add_if() в src/wg-quick/linux.bash upstream).
# Версия зафиксирована тегом: v0.2.19 — последний релиз ветки 0.2.x, выпущен
# в один день с закреплённым ниже тегом amneziawg-tools (2026-06-18), поэтому
# UAPI-протокол между awg и демоном гарантированно совместим. Ветка v3.x
# (v3.0.0/v3.0.1) — свежий мажорный бамп, намеренно не берём.
# ---------------------------------------------------------------------------
FROM golang:1.24-alpine AS awg-go-build

ARG AMNEZIAWG_GO_REF=v0.2.19

RUN apk add --no-cache git make

WORKDIR /src
# make сам генерирует version.go из `git describe`, поэтому нужен .git (clone, не tarball).
# CGO_ENABLED=0 — полностью статический бинарник, переносим в любой рантайм.
RUN git clone --depth 1 --branch "$AMNEZIAWG_GO_REF" \
        https://github.com/amnezia-vpn/amneziawg-go.git . \
    && CGO_ENABLED=0 make \
    && ./amneziawg-go --version

# ---------------------------------------------------------------------------
# Stage 2b: amneziawg-tools — awg и awg-quick (форки wg/wg-quick с тем же CLI).
#
# База — тот же node:24-alpine, что и runtime: musl из одного и того же
# релиза Alpine, никакого риска рассинхрона динамической линковки для awg (C).
# ---------------------------------------------------------------------------
FROM node:24-alpine AS awg-tools-build

ARG AMNEZIAWG_TOOLS_REF=v1.0.20260618-2

RUN apk add --no-cache git build-base linux-headers bash

WORKDIR /src
# WITH_WGQUICK=yes — иначе Makefile включает awg-quick только по факту
# автодетекта /usr/bin/bash, а с DESTDIR это срабатывает ненадёжно.
# Bash-completion и systemd-юниты в контейнере не нужны.
RUN git clone --depth 1 --branch "$AMNEZIAWG_TOOLS_REF" \
        https://github.com/amnezia-vpn/amneziawg-tools.git . \
    && make -C src -j"$(nproc)" \
    && make -C src DESTDIR=/out \
        WITH_WGQUICK=yes WITH_BASHCOMPLETION=no WITH_SYSTEMDUNITS=no install

# ---------------------------------------------------------------------------
# Stage 3: runtime — только прод-зависимости server + собранные dist-ы + wireguard
# ---------------------------------------------------------------------------
FROM node:24-alpine AS runtime

# Метка нужна скриптам: после каждой пересборки предыдущий образ остаётся
# висеть как <none> и не удаляется никогда — на типовом VPS это упирается в
# «нет места». start.sh/update.sh чистят такие слои через
# `docker image prune --filter label=org.wiredeck.image=1`, и фильтр обязателен:
# без него prune снёс бы висячие образы чужих проектов на том же хосте.
LABEL org.wiredeck.image=1

RUN apk add --no-cache wireguard-tools iptables ip6tables bash iproute2

# Движок AmneziaWG. wireguard-tools (wg/wg-quick) выше остаётся нетронутым —
# при WG_ENGINE=wg (дефолт) поведение образа ровно прежнее.
COPY --from=awg-go-build   /src/amneziawg-go /usr/bin/amneziawg-go
COPY --from=awg-tools-build /out/usr/bin/awg       /usr/bin/awg
COPY --from=awg-tools-build /out/usr/bin/awg-quick /usr/bin/awg-quick

# /etc/amnezia/amneziawg — каталог конфигов по умолчанию для awg-quick, когда
# ему передают голое имя интерфейса. Мы передаём полный путь из DATA_DIR, но
# каталог создаём: upstream-Makefile делает то же самое, а awg-quick при
# отсутствии каталога ведёт себя менее предсказуемо в диагностике.
# /var/run/amneziawg — сюда amneziawg-go кладёт UAPI-сокет <iface>.sock,
# оттуда же его читает awg (SOCK_PATH = RUNSTATEDIR "/amneziawg/").
RUN mkdir -p /etc/amnezia/amneziawg /var/run/amneziawg \
    && chmod 700 /etc/amnezia/amneziawg

WORKDIR /app

ENV NODE_ENV=production \
    DATA_DIR=/data

# ВНИМАНИЕ: переменную WG_QUICK_USERSPACE_IMPLEMENTATION здесь НЕ выставляем,
# хотя именно ей awg-quick выбирает userspace-реализацию. Причина: wg-quick и
# awg-quick читают ОДНО И ТО ЖЕ имя переменной, но с разными дефолтами
# (wireguard-go и amneziawg-go соответственно). Глобальный ENV сломал бы
# режим WG_ENGINE=wg на хостах без модуля ядра wireguard: вместо честного
# падения «Unknown device type» ванильный wg-quick запустил бы amneziawg-go,
# получил бы UAPI-сокет в /var/run/amneziawg вместо /var/run/wireguard, упал
# бы на `wg setconf` и оставил висящий tun-интерфейс и процесс-сироту.
#
# awg-quick и без ENV подставляет amneziawg-go — это его собственный дефолт
# (`${WG_QUICK_USERSPACE_IMPLEMENTATION:-amneziawg-go}` в add_if), проверено
# сборкой. Если серверу нужна явная фиксация, её надо задавать в env
# КОНКРЕТНОГО дочернего процесса awg-quick, а не на весь контейнер.

# Прод-зависимости только для workspace server.
# web/package.json нужен npm лишь для резолва workspaces из корневого package.json.
# Тулчейн ставим временно (better-sqlite3 без musl-prebuild собирается из исходников)
# и сносим в том же слое, чтобы не раздувать образ.
COPY package.json package-lock.json* ./
COPY server/package.json server/
COPY web/package.json web/
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && npm install --omit=dev -w server \
    && npm cache clean --force \
    && apk del .build-deps

# dist-ы с сохранением взаимной раскладки: server/dist считает WEB_DIST
# по умолчанию как ../../web/dist от собственного каталога.
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist

EXPOSE 8080
EXPOSE 51820/udp

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "const p=process.env.PORT||8080;fetch('http://127.0.0.1:'+p+'/api/auth/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "/app/server/dist/index.js"]
