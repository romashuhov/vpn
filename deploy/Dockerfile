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
# Stage 2: runtime — только прод-зависимости server + собранные dist-ы + wireguard
# ---------------------------------------------------------------------------
FROM node:24-alpine AS runtime

RUN apk add --no-cache wireguard-tools iptables ip6tables bash iproute2

WORKDIR /app

ENV NODE_ENV=production \
    DATA_DIR=/data

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
