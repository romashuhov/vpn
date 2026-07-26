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
import { getAwgParams } from './awg.js';
import { maybeSeedDemo } from './seed.js';
import { genKeypair } from './wg/keys.js';
import { buildServerState } from './wg/confgen.js';
import { createRunner } from './wg/index.js';
import { startPoller } from './stats/poller.js';
import { usersOutsideSubnet } from './stats/queries.js';
import { registerRoutes } from './api/routes.js';

function isApiUrl(url: string): boolean {
  const p = url.split('?')[0];
  return p === '/api' || p.startsWith('/api/');
}

/**
 * Диагностика смены WG_SUBNET на живой установке.
 *
 * Отказ, который она закрывает: подсеть поменяли, когда пользователи уже
 * созданы. Их адреса остаются от старой подсети, интерфейс поднимается с
 * адресом новой, MASQUERADE тоже пишется для новой — у старых клиентов туннель
 * устанавливается (хендшейк проходит, панель показывает «онлайн»), но интернета
 * нет. Перевыдача конфига не помогает: в него подставляется старый адрес с новым
 * префиксом. Раньше всё это происходило совершенно молча, поэтому здесь —
 * громкий лог; перенумерацию адресов сознательно НЕ делаем (это отдельная фича,
 * а самовольная смена адресов сломала бы уже выданные конфиги).
 */
function checkUsersSubnet(): void {
  const strays = usersOutsideSubnet(config.wg.subnet);
  if (strays.length === 0) return;
  const sample = strays
    .slice(0, 10)
    .map((u) => `#${u.id} ${u.name} (${u.address})`)
    .join(', ');
  console.error('[wg] ==========================================================================');
  console.error(
    `[wg] ВНИМАНИЕ: ${strays.length} пользоват. имеют адрес ВНЕ текущей подсети ` +
      `WG_SUBNET=${config.wg.subnet}: ${sample}${strays.length > 10 ? ', …' : ''}`,
  );
  console.error(
    '[wg] Похоже, WG_SUBNET сменили на уже работающей установке. У этих клиентов ' +
      'туннель поднимется и хендшейк пройдёт, но трафик наружу не пойдёт: адрес из ' +
      'старой подсети, а адрес интерфейса и правило MASQUERADE — из новой. ' +
      'Перевыдача конфига не лечит (в конфиг попадёт тот же старый адрес).',
  );
  console.error('[wg] Что делать (одно из двух):');
  console.error(
    `[wg]   1) вернуть прежнее значение WG_SUBNET в deploy/.env (подсеть, которой ` +
      'принадлежат адреса выше) и перезапустить панель — все конфиги снова заработают;',
  );
  console.error(
    '[wg]   2) либо оставить новую подсеть и пересоздать этих пользователей в панели ' +
      '(им понадобятся новые конфиги — адреса выдаются при создании).',
  );
  console.error('[wg] ==========================================================================');
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

  // 2a. Параметры обфускации AmneziaWG — инициализируем ДО первого
  // buildServerState, чтобы серверный и клиентские конфиги видели одни и те же
  // значения (генерация происходит один раз и сохраняется в settings).
  if (config.engine === 'awg') {
    const p = getAwgParams(config);
    console.log(
      `[awg] Параметры обфускации: Jc=${p.jc} Jmin=${p.jmin} Jmax=${p.jmax} ` +
        `S1=${p.s1} S2=${p.s2} H1..H4 заданы`,
    );
  }

  if (config.wg.mock) {
    console.log('[wg] Мок-режим WireGuard: реальный интерфейс не поднимается');
  } else {
    console.log(
      config.engine === 'awg'
        ? '[wg] Движок туннеля: AmneziaWG (WG_ENGINE=awg). Клиентские конфиги открываются ' +
            'приложением AmneziaWG (не AmneziaVPN — оно ждёт свой формат vpn://), ' +
            'официальный клиент WireGuard их не примет.'
        : '[wg] Движок туннеля: WireGuard (WG_ENGINE=wg)',
    );
    if (config.wg.host === '') {
      console.warn(
        '[wg] ВНИМАНИЕ: WG_HOST не задан — клиентские конфиги будут без корректного Endpoint. ' +
          'Задайте WG_HOST=<публичный IP или домен сервера>.',
      );
    }
  }

  // 3. Демо-данные (только мок-режим и пустая БД)
  maybeSeedDemo(config);

  // 3a. Проверка адресов пользователей против WG_SUBNET — до поднятия
  // интерфейса, чтобы диагностика была видна раньше сообщений wg-quick.
  checkUsersSubnet();

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

  if (config.cookieSecure) {
    console.warn(
      '[http] COOKIE_SECURE=1: cookie сессии ставится только по HTTPS. ' +
        'Вход по http://<IP>:' + config.port + ' работать НЕ будет (браузер отбросит cookie) — ' +
        'заходите через reverse proxy с TLS либо уберите COOKIE_SECURE из deploy/.env.',
    );
  }

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
