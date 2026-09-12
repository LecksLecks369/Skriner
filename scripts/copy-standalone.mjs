/* Досборка standalone: рядом с server.js нужны .next/static и public.

   Почему не `cp -r` в npm-скрипте: это юникс-команда, и на голой Windows без bash
   шаг сборки молча не отрабатывает — артефакт получается без статики и без public,
   а сама сборка завершается успешно.

   Почему не fs.cpSync: на путях с кириллицей он падает с EIO (проверено на этой
   машине, домашний каталог содержит кириллицу). Поэтому обход дерева вручную —
   readdir + copyFile, без единого рекурсивного API. */

import fs from 'fs';
import path from 'path';

function copyTree(from, to) {
  const st = fs.statSync(from);
  if (!st.isDirectory()) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    return 1;
  }
  fs.mkdirSync(to, { recursive: true });
  let n = 0;
  for (const e of fs.readdirSync(from)) n += copyTree(path.join(from, e), path.join(to, e));
  return n;
}

const jobs = [
  ['.next/static', '.next/standalone/.next/static'],
  ['public', '.next/standalone/public'],
];

let total = 0;
for (const [from, to] of jobs) {
  if (!fs.existsSync(from)) {
    console.error(`[standalone] НЕТ ИСХОДНИКА: ${from} — сборка неполна`);
    process.exit(1);
  }
  const n = copyTree(from, to);
  total += n;
  console.log(`[standalone] ${from} -> ${to}: ${n} файлов`);
}

/* Проверка по факту, а не по отсутствию исключения: копирование, которое ничего не
   скопировало, выглядит для читателя лога точно так же, как успешное. */
for (const [, to] of jobs) {
  if (!fs.existsSync(to) || fs.readdirSync(to).length === 0) {
    console.error(`[standalone] ПУСТО ПОСЛЕ КОПИРОВАНИЯ: ${to}`);
    process.exit(1);
  }
}
console.log(`[standalone] готово, файлов: ${total}`);
