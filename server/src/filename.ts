// Имя файла конфигурации из имени пользователя.
//
// Точная копия web/src/lib/filename.ts — правки вносить в оба файла. Логика
// продублирована намеренно: общего пакета между server и web в проекте нет,
// а расходиться эти две реализации не должны (иначе скачанный из панели файл
// и файл, отданный напрямую через API, назывались бы по-разному).
//
// Почему нельзя просто подставить имя как есть: приложения WireGuard и
// AmneziaWG берут НАЗВАНИЕ ТУННЕЛЯ из имени файла и принимают только
// [a-zA-Z0-9_=+.-] длиной до 15 символов. Кириллица либо отбрасывается, либо
// ломает импорт, поэтому имена транслитерируются.

const RU_MAP: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

const MAX_LENGTH = 15; // предел названия туннеля в клиентах WireGuard/AmneziaWG

/** Транслитерация кириллицы; латиница, цифры и разрешённые знаки — как есть. */
function translit(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const lower = ch.toLowerCase();
    const mapped = RU_MAP[lower];
    if (mapped !== undefined) {
      // Сохраняем регистр: «Алиса» → «Alisa», а не «alisa».
      out += ch === lower ? mapped : mapped.charAt(0).toUpperCase() + mapped.slice(1);
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Базовое имя файла (без расширения) для пользователя.
 * Пустой результат после очистки — запасное `wg-client-<id>`.
 */
export function confBaseName(userName: string, userId: number): string {
  const base = translit(userName)
    .replace(/[^a-zA-Z0-9_=+.-]+/g, '-') // пробелы и прочее — в дефис
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '') // не начинаем и не заканчиваем на - или .
    .slice(0, MAX_LENGTH)
    .replace(/[-.]+$/g, ''); // обрезка могла оставить хвостовой разделитель
  return base.length > 0 ? base : `wg-client-${userId}`;
}

/** Имя файла конфигурации: `<имя>.conf`. */
export function confFileName(userName: string, userId: number): string {
  return `${confBaseName(userName, userId)}.conf`;
}
