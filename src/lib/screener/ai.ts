/* Провайдер для ИИ-разбора сигнала.

   Зачем отдельный модуль. Раньше роут /api/ai-comment импортировал
   z-ai-web-dev-sdk напрямую и больше ничего не умел. SDK берёт ключ РОВНО из
   файла `.z-ai-config` (cwd → ~ → /etc), требует в нём одновременно baseUrl и
   apiKey, переменных окружения не читает и запасного пути не имеет. Файла на
   машине нет — он в .gitignore, то есть всегда был локальным и не переносится
   вместе с репозиторием, — поэтому разбор падал на ZAI.create() за 0.4 секунды,
   ещё до любого обращения к модели. Одна недостающая строчка конфигурации
   выключала функцию целиком.

   Теперь источников три, в порядке убывания явности:

     1. AI_BASE_URL (+ AI_API_KEY, AI_MODEL) — любой OpenAI-совместимый эндпоинт:
        Z.AI, OpenRouter, DeepSeek, локальный сервер. Явная настройка бьёт всё.
     2. .z-ai-config — прежний путь через SDK, без изменений. Тот, у кого файл
        есть, ничего не заметит.
     3. Локальный Ollama на 127.0.0.1:11434 — ключ не нужен вовсе. Обнаруживается
        сам, и это делает функцию работающей из коробки там, где Ollama уже стоит.

   Ни один секрет в коде не живёт: путь 1 читает переменные окружения, путь 2 —
   файл, который и раньше читал SDK, путь 3 не требует ключа. */

import fs from 'fs';
import os from 'os';
import path from 'path';

/** Куда SDK смотрит за конфигом — тот же список, что в z-ai-web-dev-sdk */
const ZAI_CONFIG_PATHS = [
  path.join(process.cwd(), '.z-ai-config'),
  path.join(os.homedir(), '.z-ai-config'),
  '/etc/.z-ai-config',
];

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/v1';

/* Кандидаты для Ollama, по убыванию предпочтения. Список, а не константа,
   потому что облачные модели Ollama СНИМАЮТ с обслуживания: на этой машине
   единственная установленная модель отвечала HTTP 410 «retired at 2026-07-15»,
   и захардкоженное имя означало бы, что функция снова умрёт молча в тот день,
   когда снимут следующую. Рабочая модель определяется опытом и запоминается;
   при отказе поиск повторяется. AI_MODEL перебивает список целиком. */
const OLLAMA_CANDIDATES = ['gpt-oss:120b-cloud', 'gpt-oss:20b-cloud', 'llama3.1:8b', 'qwen2.5:7b'];

const REQUEST_TIMEOUT_MS = 45_000; // роут объявляет maxDuration 60
const MAX_TOKENS = 320;

interface ProviderGlobal {
  __screenerAiModel: { model: string; ts: number } | null;
}
const g = globalThis as unknown as ProviderGlobal;
if (g.__screenerAiModel === undefined) g.__screenerAiModel = null;

export type AiProvider =
  | { kind: 'openai'; baseUrl: string; apiKey: string | null; model: string | null; label: string }
  | { kind: 'zai'; label: string }
  | { kind: 'ollama'; baseUrl: string; label: string };

/** Что нашлось и где — уезжает в ответ роута, чтобы источник разбора был виден */
export interface AiResolution {
  provider: AiProvider | null;
  /** Куда смотрели и что там было — для сообщения об ошибке, без значений ключей */
  checked: string[];
}

function readZaiConfig(): { baseUrl: string; apiKey: string } | null {
  for (const p of ZAI_CONFIG_PATHS) {
    try {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8')) as { baseUrl?: string; apiKey?: string };
      // оба поля обязательны — ровно как в SDK, иначе файл считается отсутствующим
      if (cfg.baseUrl && cfg.apiKey) return { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey };
    } catch {
      /* нет файла или он не парсится — пробуем следующий */
    }
  }
  return null;
}

async function ollamaAlive(baseUrl: string): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2500);
    const r = await fetch(`${baseUrl}/models`, { signal: ctl.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Кто будет отвечать. Порядок фиксирован: явная настройка → файл SDK → локальный
 * Ollama. Список checked возвращается всегда — при отказе он и есть диагноз,
 * иначе сообщение «не настроено» не отличить от «настроено, но не отвечает».
 */
export async function resolveProvider(): Promise<AiResolution> {
  const checked: string[] = [];

  const envBase = process.env.AI_BASE_URL;
  if (envBase) {
    checked.push('AI_BASE_URL: задан');
    return {
      provider: {
        kind: 'openai',
        baseUrl: envBase.replace(/\/+$/, ''),
        apiKey: process.env.AI_API_KEY || null,
        model: process.env.AI_MODEL || null,
        label: `AI_BASE_URL (${envBase})`,
      },
      checked,
    };
  }
  checked.push('AI_BASE_URL: не задан');

  if (readZaiConfig()) {
    checked.push('.z-ai-config: найден');
    return { provider: { kind: 'zai', label: '.z-ai-config (z-ai-web-dev-sdk)' }, checked };
  }
  checked.push(`.z-ai-config: нет ни в одном из путей (${ZAI_CONFIG_PATHS.join(', ')})`);

  if (await ollamaAlive(OLLAMA_BASE)) {
    checked.push(`Ollama на ${OLLAMA_BASE}: отвечает`);
    return { provider: { kind: 'ollama', baseUrl: OLLAMA_BASE, label: `Ollama (${OLLAMA_BASE})` }, checked };
  }
  checked.push(`Ollama на ${OLLAMA_BASE}: не отвечает`);

  return { provider: null, checked };
}

/** Один запрос к OpenAI-совместимому эндпоинту. Бросает с текстом тела при !ok. */
async function openaiChat(
  baseUrl: string,
  apiKey: string | null,
  model: string,
  system: string,
  user: string,
  extra: Record<string, unknown> = {}
): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        /* charset указан явно: тело содержит кириллицу и в запросе, и в ответе */
        'Content-Type': 'application/json; charset=utf-8',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        stream: false,
        max_tokens: MAX_TOKENS,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        ...extra,
      }),
    });
    const raw = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${raw.slice(0, 300)}`);
    const j = JSON.parse(raw) as { choices?: Array<{ message?: { content?: string } }> };
    /* Берём именно content. У рассуждающих моделей рядом приезжает поле reasoning —
       это черновик модели, а не ответ, и показывать его оператору нельзя. */
    return j.choices?.[0]?.message?.content?.trim() || '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Разбор через Ollama с подбором модели.
 *
 * Запомненная модель проверяется первой; если она отвалилась (сняли с
 * обслуживания, удалили локально) — перебор кандидатов заново. Ошибка последней
 * попытки поднимается наверх целиком: «ни одна модель не ответила» без тела
 * ответа не отличает снятую модель от выключенного аккаунта.
 */
async function ollamaChat(baseUrl: string, system: string, user: string): Promise<string> {
  const forced = process.env.AI_MODEL;
  const order = forced
    ? [forced]
    : [g.__screenerAiModel?.model, ...OLLAMA_CANDIDATES].filter((m): m is string => !!m);
  const tried = new Set<string>();
  let lastErr: unknown = null;
  for (const model of order) {
    if (tried.has(model)) continue;
    tried.add(model);
    try {
      /* reasoning_effort — параметр рассуждающих моделей Ollama: без него
         gpt-oss тратит ~900 токенов черновика на ответ в два предложения. */
      const text = await openaiChat(baseUrl, null, model, system, user, { reasoning_effort: 'low' });
      if (text) {
        g.__screenerAiModel = { model, ts: Date.now() };
        return text;
      }
      lastErr = new Error(`модель ${model} вернула пустой ответ`);
    } catch (e) {
      lastErr = e;
      if (g.__screenerAiModel?.model === model) g.__screenerAiModel = null; // запомненная отвалилась
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('ни одна модель Ollama не ответила');
}

/** Текст разбора от выбранного провайдера. Возвращает пустую строку, если модель промолчала. */
export async function aiComplete(provider: AiProvider, system: string, user: string): Promise<string> {
  if (provider.kind === 'ollama') return ollamaChat(provider.baseUrl, system, user);
  if (provider.kind === 'openai') {
    const model = provider.model || 'gpt-4o-mini';
    return openaiChat(provider.baseUrl, provider.apiKey, model, system, user);
  }
  // прежний путь: SDK сам читает .z-ai-config, наличие которого уже проверено
  const ZAI = (await import('z-ai-web-dev-sdk')).default;
  const zai = await ZAI.create();
  const completion = await zai.chat.completions.create({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    thinking: { type: 'disabled' },
  });
  return completion.choices[0]?.message?.content?.trim() || '';
}

/** Сообщение, когда не настроено ничего: три пути и что сделать по каждому */
export function notConfiguredMessage(checked: string[]): string {
  return (
    'ИИ-провайдер не настроен. Подойдёт любой из трёх путей: ' +
    '(1) переменные AI_BASE_URL и AI_MODEL (плюс AI_API_KEY, если эндпоинт его требует) — например в .env.local; ' +
    '(2) файл .z-ai-config в корне проекта с полями baseUrl и apiKey; ' +
    '(3) запущенный локально Ollama — ключ не нужен. ' +
    'Проверено: ' +
    checked.join(' · ')
  );
}
