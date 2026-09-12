/*
 * Замер базовой частоты для «ерша».
 *
 * Зачем отдельный скрипт, а не константа в коде: база сравнения — это ИЗМЕРЕНИЕ
 * с сроком годности, а не свойство формулы. Популяция скана меняется, и константа,
 * снятая однажды, молча начинает описывать другой рынок. Поэтому число задаётся
 * прогоном этого скрипта, а в setups.ts рядом с константой пишется популяция,
 * дата и n.
 *
 * Что именно меряется. Ёрш утверждает УСЛОВНОЕ: «пила есть сейчас → она сохранится
 * ближайшие 30 минут». Значит контроль — не доля произвольных окон с пилой
 * (prevalence), а доля окон с пилой ПОСЛЕ окна с пилой (persistence). Скрипт печатает
 * оба числа именно поэтому: какое из них больше — вопрос замера, а не рассуждения.
 * На выборке 2026-09-11 (OKX, 13243 окна) persistence 8.38% против prevalence 6.71%,
 * то есть пила слегка залипает; предварительный прогон на n=241 дал 4.1% и «возврат
 * к среднему» — это был шум малой выборки. Отсюда и Wilson-интервал в выдаче: без
 * него ровно эта ошибка и делается.
 *
 * Детектор и оценка исхода импортируются из рабочих модулей — второй копии формулы
 * здесь нет намеренно: описание фильтра, живущее отдельно от фильтра, становится
 * вторым определением, которое ничто не синхронизирует.
 *
 * Запуск (из каталога Skriner):
 *   node --experimental-strip-types --import ./scripts/register-ts.mjs \
 *        scripts/measure-chop-baseline.mjs [--bars 900] [--venue okx]
 */
import { detectChop, CHOP_ER_MAX } from '../src/lib/screener/setups.ts';
import { evalChopPersist } from '../src/lib/screener/patterns.ts';

const BARS = 30; // окно детектора = CHOP_BARS
const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const WANT_BARS = Math.max(120, Number(argOf('bars', 900)));
const VENUE = argOf('venue', 'okx');
const CONC = 6;
/* Порог скора в условии срабатывания не участвует (см. setups.ts). Оставлен
   параметром скрипта: именно им и меряется, добавляет ли скор что-нибудь к одному ER.
   0 = выключен. */
const SCORE_GATE = Number(argOf('score-gate', 0));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function jf(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

/* ---------- источники свечей ---------- */

const VENUES = {
  okx: {
    async symbols() {
      const j = await jf('https://www.okx.com/api/v5/market/tickers?instType=SWAP');
      return (j.data || [])
        .filter((d) => d.instId.endsWith('-USDT-SWAP'))
        .sort((a, b) => parseFloat(b.volCcy24h) - parseFloat(a.volCcy24h))
        .map((d) => d.instId);
    },
    /* OKX: /candles отдаёт последние 300, глубже — /history-candles по 100 с курсором
       `after` (строго старше указанного ts). Свечи приходят новыми вперёд. */
    async candles(sym, want) {
      const out = [];
      const first = await jf(`https://www.okx.com/api/v5/market/candles?instId=${sym}&bar=1m&limit=300`);
      out.push(...(first.data || []));
      while (out.length < want) {
        const oldest = out[out.length - 1]?.[0];
        if (!oldest) break;
        const page = await jf(
          `https://www.okx.com/api/v5/market/history-candles?instId=${sym}&bar=1m&limit=100&after=${oldest}`
        );
        const rows = page.data || [];
        if (!rows.length) break;
        out.push(...rows);
      }
      return out
        .map((r) => ({ ts: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], qv: +r[7] }))
        .filter((c) => c.c > 0)
        .sort((a, b) => a.ts - b.ts);
    },
  },
  bybit: {
    async symbols() {
      const j = await jf('https://api.bybit.com/v5/market/tickers?category=linear', 25000);
      return (j.result?.list || [])
        .filter((t) => t.symbol.endsWith('USDT'))
        .sort((a, b) => parseFloat(b.turnover24h) - parseFloat(a.turnover24h))
        .map((t) => t.symbol);
    },
    async candles(sym, want) {
      const j = await jf(
        `https://api.bybit.com/v5/market/kline?category=linear&symbol=${sym}&interval=1&limit=${Math.min(1000, want)}`
      );
      return (j.result?.list || [])
        .map((r) => ({ ts: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], qv: +r[6] }))
        .filter((c) => c.c > 0)
        .sort((a, b) => a.ts - b.ts);
    },
  },
};

/* ---------- статистика ---------- */

/** Интервал Уилсона: на долях порядка процентов нормальное приближение врёт. */
function wilson(k, n, z = 1.96) {
  if (!n) return null;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - s) / d), Math.min(1, (c + s) / d)];
}

const q = (a, p) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const pct = (x) => (x == null ? '—' : (100 * x).toFixed(2) + '%');

/* ---------- прогон ---------- */

const venue = VENUES[VENUE];
if (!venue) {
  console.error(`неизвестная площадка "${VENUE}"; есть: ${Object.keys(VENUES).join(', ')}`);
  process.exit(1);
}

const LIMIT = Number(argOf('limit', 0)) || Infinity;
const syms = (await venue.symbols()).slice(0, LIMIT === Infinity ? undefined : LIMIT);
console.error(`площадка ${VENUE}: ${syms.length} символов, целевая глубина ${WANT_BARS} баров`);

const series = [];
let done = 0;
const lanes = Array.from({ length: CONC }, () => []);
syms.forEach((s, i) => lanes[i % CONC].push(s));
await Promise.all(
  lanes.map(async (lane) => {
    for (const s of lane) {
      try {
        const cs = await venue.candles(s, WANT_BARS);
        if (cs.length >= BARS * 4) series.push(cs);
      } catch {
        /* символ пропускаем: недоступность одного не должна валить замер */
      }
      if (++done % 50 === 0) console.error(`  загружено ${done}/${syms.length}`);
    }
  })
);

let winTot = 0;
let prev = 0; // окон с ER <= порога (prevalence)
let persistTot = 0;
let persist = 0; // из них: следующее окно тоже пила
let firedTot = 0;
let fired = 0; // полное условие детектора (ER + скор) -> исход
let gatePass = 0; // окон, проходящих ТОЛЬКО гейт скора
const scores = [];

for (const cs of series) {
  /* Непересекающиеся окна: соседняя пара «сигнал -> исход» повторяет то, что
     делает резолвер (следующие 30 минут), а перекрытие окон раздуло бы n
     автокоррелированными наблюдениями и сузило интервал на пустом месте. */
  const vals = [];
  for (let i = 0; i + BARS <= cs.length; i += BARS) {
    const ctx = cs.slice(0, i + BARS); // detectChop берёт последние CHOP_BARS и ATR по хвосту
    vals.push({ v: ctx.length >= BARS + 2 ? detectChop(ctx, null) : null, end: i + BARS });
  }
  for (const { v } of vals) {
    if (!v) continue;
    winTot++;
    scores.push(v.score);
    if (v.er <= CHOP_ER_MAX) prev++;
    if (SCORE_GATE > 0 && v.score >= SCORE_GATE) gatePass++;
  }
  for (let k = 0; k + 1 < vals.length; k++) {
    const a = vals[k].v;
    if (!a || a.er > CHOP_ER_MAX) continue;
    const last = cs[vals[k].end - 1];
    const next = cs.slice(vals[k].end, vals[k].end + BARS);
    if (next.length < BARS) continue;
    /* Исход считает рабочая функция резолвера, на тех же поминутных закрытиях. */
    const oc = evalChopPersist(
      next.map((c) => ({ ts: c.ts, h: c.h, l: c.l, c: c.c })),
      last.c,
      last.ts,
      CHOP_ER_MAX
    );
    if (!oc || oc.win == null) continue;
    persistTot++;
    if (oc.win) persist++;
    if (SCORE_GATE > 0 && a.score >= SCORE_GATE) {
      firedTot++;
      if (oc.win) fired++;
    }
  }
}

const ciP = wilson(persist, persistTot);
const ciF = wilson(fired, firedTot);

console.log('');
console.log(`площадка: ${VENUE} · символов: ${series.length} · окон по ${BARS} мин: ${winTot}`);
console.log(`порог ER: ${CHOP_ER_MAX} · гейт скора для проверки: ${SCORE_GATE || 'выключен'}`);
console.log('');
console.log('скор, квантили p50/p75/p90/p99/max:', [0.5, 0.75, 0.9, 0.99].map((p) => q(scores, p)).join(' / '), '/', scores.length ? Math.max(...scores) : '—');
console.log('');
console.log(`prevalence   P(ER<=порога)                      ${pct(prev / winTot)}  (${prev}/${winTot})`);
console.log(`гейт скора   P(скор>=${SCORE_GATE})                     ${pct(gatePass / winTot)}  (${gatePass}/${winTot})`);
console.log(`PERSISTENCE  P(след.<=порога | сейчас<=порога)   ${pct(persist / persistTot)}  (${persist}/${persistTot})  95% ДИ ${ciP ? pct(ciP[0]) + '..' + pct(ciP[1]) : '—'}`);
console.log(`+ гейт скора                                   ${pct(fired / firedTot)}  (${fired}/${firedTot})  95% ДИ ${ciF ? pct(ciF[0]) + '..' + pct(ciF[1]) : '—'}`);
console.log('');
console.log('--- строка для setups.ts ---');
console.log(`export const CHOP_PERSIST_BASE_RATE = ${(persist / persistTot).toFixed(3)}; // ${VENUE}, ${series.length} симв., n=${persistTot}, ${new Date().toISOString().slice(0, 10)}`);
