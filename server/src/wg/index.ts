// Фабрика WgRunner: mock для разработки, LinuxRunner для прода.

import type { Config } from '../config.js';
import type { WgRunner } from './runner.js';
import { LinuxRunner } from './linux.js';
import { MockRunner } from './mock.js';

export function createRunner(cfg: Config): WgRunner {
  if (cfg.wg.mock) {
    console.log('[wg] mock-режим: WireGuard не используется, трафик симулируется');
    return new MockRunner();
  }
  return new LinuxRunner(cfg);
}
