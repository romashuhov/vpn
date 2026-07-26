// Точка входа WireDeck: bootstrap всего процесса.
// Порядок строго по контракту (ARCHITECTURE.md): openDb → серверные ключи →
// maybeSeedDemo → createRunner → runner.up → startPoller → Fastify → listen.

import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { getSetting, listUsers, openDb, setSetting } from './db.js';
import { maybeSeedDemo } from './seed.js';
import { genKeypair } from './wg/keys.js';
import { buildServerState } from './wg/confgen.js';
import { createRunner } from './wg/index.js';
import { startPoller } from './stats/poller.js';
import { registerRoutes } from './api/routes.js';

function isApiUrl(url: string): boolean {
  const p = url.split('?')[0];
  return p === '/api' || p.startsWith('/api/');
}

async function main(): Promise<void> {
  // 1. База данных (+ миграции)
  openDb(config.dbPath);

  // 2. Серверные ключи WireGuard — создать при отсутствии
  if (!getSetting('server_private_key') || !getSetting('server_public_key')) {
    const { privateKey, publicKey } = genKeypair();
    setSetting('server_private_key', privateKey);
    setSetting('server_public_key', publicKey);
    console.log('[wg] Сгенерированы серверные ключи WireGuard');
  }
  const serverPrivateKey = getSetting('server_private_key');
  if (!serverPrivateKey) {
    throw new Error('Не удалось прочитать server_private_key из настроек');
  }

  if (config.wg.mock) {
    console.log('[wg] Мок-режим WireGuard: реальный интерфейс не поднимается');
  } else if (config.wg.host === '') {
    console.warn(
      '[wg] ВНИМАНИЕ: WG_HOST не задан — клиентские конфиги будут без корректного Endpoint. ' +
        'Задайте WG_HOST=<публичный IP или домен сервера>.',
    );
  }

  // 3. Демо-данные (только мок-режим и пустая БД)
  maybeSeedDemo(config);

  // 4. WireGuard-интерфейс. Ошибка up не должна валить панель:
  // в linux логируем и продолжаем, чтобы веб-морда открывалась в любом случае.
  const runner = createRunner(config);
  try {
    await runner.up(buildServerState(config, serverPrivateKey, listUsers()));
    console.log(`[wg] Интерфейс ${config.wg.iface} поднят`);
  } catch (err) {
    console.error(
      `[wg] Не удалось поднять интерфейс ${config.wg.iface} — панель продолжит работу:`,
      err,
    );
  }

  // 5. Опрос статистики
  startPoller(runner, config.pollIntervalMs);

  // 6. HTTP-сервер
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  registerRoutes(app, { cfg: config, runner });

  const hasWebDist = fs.existsSync(config.webDist);
  const hasIndexHtml = hasWebDist && fs.existsSync(path.join(config.webDist, 'index.html'));
  if (hasWebDist) {
    await app.register(fastifyStatic, { root: config.webDist });
  } else {
    console.warn(`[http] Папка веб-сборки не найдена (${config.webDist}) — отдаётся только API`);
  }

  // SPA-fallback: любой не найденный не-/api путь → index.html; /api → 404 JSON.
  app.setNotFoundHandler((req, reply) => {
    if (isApiUrl(req.url)) {
      reply.code(404).send({ error: 'Не найдено' });
      return;
    }
    if (hasIndexHtml) {
      reply.sendFile('index.html');
      return;
    }
    reply.code(404).type('text/plain; charset=utf-8').send('WireDeck: веб-интерфейс не собран');
  });

  const address = await app.listen({ port: config.port, host: config.host });
  console.log(`[http] WireDeck запущен: ${address}`);
  if (config.host === '0.0.0.0' || config.host === '::') {
    console.log(`[http] Панель: http://localhost:${config.port}`);
  }

  // Грациозное завершение: закрываем HTTP-сервер, runner.down() НЕ вызываем —
  // WireGuard-интерфейс должен пережить рестарт панели.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[http] Получен ${signal}: останавливаем сервер (WireGuard остаётся поднятым)`);
    try {
      await app.close();
    } catch (err) {
      console.error('[http] Ошибка при остановке сервера:', err);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[http] Фатальная ошибка запуска WireDeck:', err);
  process.exit(1);
});
