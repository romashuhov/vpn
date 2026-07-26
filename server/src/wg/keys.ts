// Генерация ключей WireGuard (Curve25519) через node:crypto — без бинарника wg.
// Сырые 32 байта ключа — последние 32 байта DER-представления (pkcs8/spki).

import { generateKeyPairSync, randomBytes } from 'node:crypto';

/** Пара ключей X25519 в base64 — формат, который ожидает WireGuard. */
export function genKeypair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  const priv = privateKey
    .export({ type: 'pkcs8', format: 'der' })
    .subarray(-32)
    .toString('base64');
  const pub = publicKey
    .export({ type: 'spki', format: 'der' })
    .subarray(-32)
    .toString('base64');
  return { privateKey: priv, publicKey: pub };
}

/** Preshared-ключ: 32 случайных байта в base64. */
export function genPresharedKey(): string {
  return randomBytes(32).toString('base64');
}
