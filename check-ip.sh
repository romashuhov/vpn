#!/usr/bin/env bash
# WireDeck — проверка, доступен ли адрес сервера из России.
#
#   ./check-ip.sh 1.2.3.4          — проверить порт панели (8080)
#   ./check-ip.sh 1.2.3.4 51820    — проверить другой TCP-порт
#
# Через публичный сервис check-host.net подключается к вашему адресу с узлов
# в разных странах, отдельно показывая российские. Адрес должен быть уже
# назначен серверу, а панель — запущена (она слушает на всех адресах, поэтому
# достаточно добавить IP на интерфейс: ip addr add <IP>/32 dev eth0).
#
# КАК ЧИТАТЬ РЕЗУЛЬТАТ:
#  - мир подключается, Россия — нет  → адрес заблокирован для РФ, нужен другой;
#  - подключаются все                → адрес живой; но узлы сервиса стоят в
#    дата-центрах, а у домашних и особенно мобильных операторов фильтрация
#    строже — финальная проверка всё равно за реальным клиентом;
#  - не подключается никто           → проблема не в блокировке: панель не
#    запущена, порт закрыт файрволом или адрес не назначен серверу.
#
# UDP (сам WireGuard) сервис проверить не может — это тест доступности АДРЕСА.
# Работу туннеля смотрите в панели: появился ли хендшейк и растёт ли трафик.

set -euo pipefail

IP="${1:-}"
PORT="${2:-8080}"
[ -n "$IP" ] || { echo "Использование: ./check-ip.sh <IP> [TCP-порт, по умолчанию 8080]" >&2; exit 1; }

# Ищем работающий Python (на Windows python3 бывает нерабочей заглушкой).
PY=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import json,urllib.request' >/dev/null 2>&1; then PY="$c"; break; fi
done
[ -n "$PY" ] || { echo "Нужен python3: apt-get install -y python3" >&2; exit 1; }

exec "$PY" - "$IP" "$PORT" <<'PYEOF'
import json, sys, time, urllib.request

# Консоль может быть не в UTF-8 (Windows) — не падаем на кириллице и символах.
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

ip, port = sys.argv[1], sys.argv[2]
G, Y, R, D, N = '\033[1;32m', '\033[1;33m', '\033[1;31m', '\033[2m', '\033[0m'

def api(url):
    req = urllib.request.Request(url, headers={'Accept': 'application/json', 'User-Agent': 'wiredeck-check'})
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.load(r)

try:
    who = api(f"https://ipinfo.io/{ip}")
    print(f"\nАдрес {ip}: {who.get('country', '?')} · {who.get('org', '?')}")
except Exception:
    print(f"\nАдрес {ip}")

try:
    start = api(f"https://check-host.net/check-tcp?host={ip}:{port}&max_nodes=40")
except Exception as e:
    print(f"{R}Сервис проверки недоступен: {e}{N}"); sys.exit(1)

nodes, rid = start.get('nodes', {}), start.get('request_id')
if not rid:
    print(f"{R}Сервис не принял запрос (лимит? попробуйте через минуту).{N}"); sys.exit(1)

print(f"Проверяю TCP-порт {port} с {len(nodes)} узлов по миру…")
time.sleep(20)
res = api(f"https://check-host.net/check-result/{rid}")

ru, ru_ok, world, world_ok = [], 0, 0, 0
for node, meta in nodes.items():
    cc, city = (meta[0] or '?').upper(), (meta[2] or '')
    r = res.get(node)
    e = r[0] if isinstance(r, list) and r else r
    ok = isinstance(e, dict) and 'time' in e
    verdict = f"{round(e['time'] * 1000)} мс" if ok else (e.get('error', 'нет ответа') if isinstance(e, dict) else 'нет данных')
    if cc == 'RU':
        ru.append((city, verdict, ok)); ru_ok += 1 if ok else 0
    else:
        world += 1; world_ok += 1 if ok else 0

print()
for city, verdict, ok in sorted(ru):
    print(f"  {G if ok else R}[{'+' if ok else '-'}]{N} Россия, {city:<18} {verdict}")
if not ru:
    print(f"  {Y}Российских узлов в выдаче не оказалось — повторите запуск.{N}")
print(f"  {D}остальной мир: {world_ok} из {world} узлов подключились{N}\n")

if not ru:
    sys.exit(0)
if ru_ok == 0 and world_ok > world / 2:
    print(f"{R}ВЕРДИКТ: адрес заблокирован для России.{N}")
    print("Сервер жив и доступен из других стран, но из РФ до него не доходят.")
    print("Нужен другой IP — желательно из другой подсети и другого хостера.")
elif ru_ok == 0:
    print(f"{Y}ВЕРДИКТ: адрес недоступен ниоткуда.{N}")
    print("Похоже, дело не в блокировке: проверьте, запущена ли панель (./logs.sh),")
    print("назначен ли адрес серверу и открыт ли порт в файрволе.")
elif ru_ok < len(ru):
    print(f"{Y}ВЕРДИКТ: доступен частично ({ru_ok} из {len(ru)} российских узлов).{N}")
    print("Возможна фильтрация у части операторов — проверьте на реальном клиенте.")
else:
    print(f"{G}ВЕРДИКТ: адрес доступен из России.{N}")
    print("Жёсткой блокировки нет. Но узлы сервиса — дата-центры; у домашних и")
    print("мобильных операторов фильтрация строже, поэтому финальная проверка —")
    print("подключить клиента и посмотреть в панели хендшейк и рост трафика.")
PYEOF
