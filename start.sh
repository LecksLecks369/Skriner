#!/usr/bin/env bash
# MetaScalp Screener — быстрый старт (macOS / Linux)
set -e
cd "$(dirname "$0")"

if ! command -v bun >/dev/null 2>&1; then
  echo "[!] Bun не установлен."
  echo "    Установите: curl -fsSL https://bun.sh/install | bash"
  echo "    Затем откройте новый терминал и запустите ./start.sh снова."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "[*] Установка зависимостей (bun install)..."
  bun install
fi

if [ ! -f .next/standalone/server.js ] || [ "$1" = "--rebuild" ]; then
  echo "[*] Сборка проекта (bun run build)..."
  bun run build
fi

echo "[*] Запуск: http://localhost:3000  (Ctrl+C — остановить)"
exec bun start
