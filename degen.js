// degen.js — JTF DEGEN v4.0 (Advanced Phase 3 Edition)

import fetch from "node-fetch";
import { DEBUG } from "./debug.js";
import { isRecentlySignaled, registerSignal, isTimeBlocked } from "./signals_registry.js";
import { getMarketBias, getBiasScoreAdjustment } from "./market_bias.js";
import { applyAdvancedFilters } from "./filters.js";

// ========= DEBUG =========
function logDebug(...args) {
  if (DEBUG.global || DEBUG.degen) {
    console.log("[DEGEN DEBUG]", ...args);
  }
}

// ========= CONFIG =========
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const SCAN_INTERVAL_MS = 2 * 60_000;
const MIN_ALERT_DELAY_MS = 10 * 60_000;

async function sendTelegram(msg) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: "Markdown" })
    });
  } catch (e) {
    console.error("[TELEGRAM ERROR]", e);
  }
}

const DIRECTIONAL_BIAS = process.env.DEGEN_BIAS || "BOTH";
const BIAS_STRICT_MODE = process.env.DEGEN_BIAS_STRICT === "true";

function shouldSkipDirection(direction, marketContext = null) {
  // Phase 5: Removed Auto Bias hard block (v3.3). The ±5 score adjustment
  // from getBiasScoreAdjustment() is sufficient to penalize counter-trend trades
  // without blocking high-quality setups.
  if (DIRECTIONAL_BIAS !== "BOTH") {
    return BIAS_STRICT_MODE ? direction !== DIRECTIONAL_BIAS : false;
  }
  return false;
}
const GLOBAL_COOLDOWN_MS = 30 * 60_000;
const SYMBOL_UPDATE_INTERVAL = 60 * 60_000;

// ========= STATE =========
let DEGEN_SYMBOLS = [];
let lastSymbolUpdate = 0;
let lastGlobalTradeTime = 0;
// Map pour suivre les trades actifs : clef=symbol, valeur=timestamp
const activeTrades = new Map();
const TIME_LIMIT_MS = 120 * 60_000; // 120 minutes (Scalping extended)

// ========= BLACKLIST (TOXIC) =========
const IGNORE_LIST = [
  "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT",
  "ADAUSDT", "DOGEUSDT", "AVAXUSDT", "DOTUSDT", "TRXUSDT",
  "LINKUSDT", "TONUSDT", "SUIUSDT", "APTUSDT", "NEARUSDT",
  "ARBUSDT", "OPUSDT", "INJUSDT", "ATOMUSDT", "AAVEUSDT",
  "LTCUSDT", "UNIUSDT", "FILUSDT", "XLMUSDT", "RUNEUSDT",
  "ALGOUSDT", "PEPEUSDT", "WIFUSDT", "TIAUSDT", "SEIUSDT",
  "WIFUSDT_UMCBL"
];

// ========= UTILS =========
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const num = (v, d = 4) => v == null ? null : +(+v).toFixed(d);

function getPriceDecimals(price) {
  if (price == null || !isFinite(price)) return 4;
  const p = Math.abs(price);
  if (p >= 1000) return 2;
  if (p >= 100) return 3;
  if (p >= 1) return 4;
  return 5;
}

const clamp = (x, min, max) => Math.max(min, Math.min(max, x));

async function safeGetJson(url) {
  try {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    return r.ok ? await r.json() : null;
  } catch (e) {
    return null;
  }
}

// ========= API v2 =========
async function getTicker(symbol) {
  const j = await safeGetJson(`https://api.bitget.com/api/v2/mix/market/ticker?symbol=${symbol}&productType=usdt-futures`);
  return j?.data ? (Array.isArray(j.data) ? j.data[0] : j.data) : null;
}

async function getCandles(symbol, seconds, limit = 120) {
  const j = await safeGetJson(`https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}&granularity=${seconds}&limit=${limit}&productType=usdt-futures`);
  if (!j?.data?.length) return [];
  return j.data.map(c => ({ t: +c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5] })).sort((a, b) => a.t - b.t);
}

async function getAllTickers() {
  const j = await safeGetJson("https://api.bitget.com/api/v2/mix/market/tickers?productType=usdt-futures");
  return j?.data ?? [];
}

// ========= INDICATORS =========
function rsi(values, p = 14) {
  if (!values || values.length < p + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) {
    const d = values[i] - values[i - 1];
    d >= 0 ? g += d : l -= d;
  }
  g /= p; l = (l / p) || 1e-9;
  let val = 100 - 100 / (1 + (g / l));
  for (let i = p + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    g = (g * (p - 1) + Math.max(d, 0)) / p;
    l = ((l * (p - 1) + Math.max(-d, 0)) / p) || 1e-9;
    val = 100 - 100 / (1 + (g / l));
  }
  return val;
}

function vwap(c) {
  let pv = 0, v = 0;
  for (const k of c) {
    const p = (k.h + k.l + k.c) / 3;
    pv += p * k.v; v += k.v;
  }
  return v ? pv / v : null;
}

function wicks(c) {
  if (!c) return { upper: 0, lower: 0 };
  const top = Math.max(c.o, c.c);
  const bot = Math.min(c.o, c.c);
  return { upper: ((c.h - top) / c.c) * 100, lower: ((bot - c.l) / c.c) * 100 };
}

// ========= DYNAMIC LIST =========
async function updateDegenList() {
  const all = await getAllTickers();
  const list = all.filter(t => t.symbol?.endsWith("USDT") && !IGNORE_LIST.includes(t.symbol) && (+t.usdtVolume > 3_000_000))
    .sort((a, b) => (+b.usdtVolume) - (+a.usdtVolume)).slice(0, 40).map(t => t.symbol);
  return list;
}

// ========= PROCESS ONE SYMBOL =========
async function processDegen(symbol) {
  const tk = await getTicker(symbol);
  if (!tk) return null;
  const last = +(tk.lastPr ?? tk.markPrice ?? tk.last ?? 0);
  if (!last || last <= 0) return null;

  const [c5m, c15m] = await Promise.all([getCandles(symbol, 300, 120), getCandles(symbol, 900, 120)]);
  if (!c5m?.length || c5m.length < 20) return null;

  const rsi5 = rsi(c5m.map(x => x.c));
  const vwp = vwap(c5m.slice(-24));
  const priceVsVwap = vwp ? ((last - vwp) / vwp) * 100 : 0;
  const lastC = c5m[c5m.length - 1];
  const wick = wicks(lastC);
  const avgVol = c5m.slice(-11, -1).reduce((a, b) => a + b.v, 0) / 10;
  const volRatio = avgVol > 0 ? lastC.v / avgVol : 1;

  return { symbol, last, volaPct: tk.high24h && tk.low24h ? ((+tk.high24h - +tk.low24h) / last) * 100 : 5, rsi5, priceVsVwap, volRatio, wicks: wick };
}

// ========= ANALYZE =========
async function analyzeCandidate(rec, marketContext) {
  if (!rec) return null;
  let dir = rec.priceVsVwap > 0 ? "LONG" : "SHORT";
  if (rec.volRatio < (dir === "LONG" ? 3.0 : 2.5)) return null;
  if (rec.volaPct == null || rec.volaPct < 5 || rec.volaPct > 40) return null;

  const gap = Math.abs(rec.priceVsVwap);
  const [gapMin, gapMax] = dir === "LONG" ? [0.6, 2.2] : [0.8, 2.8];
  if (gap < gapMin || gap > gapMax) return null;

  if (dir === "LONG") {
    if (rec.wicks.upper > 1.3) return null;
  } else {
    if (rec.wicks.lower > 1.3) return null;
  }
  if (shouldSkipDirection(dir, marketContext)) return null;

  let score = 0;
  score += rec.volRatio >= 3.5 ? 35 : rec.volRatio >= 3 ? 28 : 20;
  score += (gap >= 1 && gap <= 2.2 ? 25 : gap >= 0.7 && gap <= 2.5 ? 15 : 5);
  score += (dir === "LONG" ? (rec.rsi5 >= 50 && rec.rsi5 <= 70 ? 20 : 10) : (rec.rsi5 >= 30 && rec.rsi5 <= 50 ? 20 : 10));
  score += getBiasScoreAdjustment(dir, marketContext);

  // 🎯 Score filters phase 3 (DEGEN Trap protection)
  if (score > 96) {
    console.log(`[DEGEN TRAP] ${rec.symbol} — Score ${score.toFixed(1)} > 96 is too dangerous`);
    return null;
  }
  if (score < 80) return null; // Phase 5: Raised from 75 to 80

  // 🎯 Advanced Filters (Orderbook/Funding)
  const adv = await applyAdvancedFilters(rec.symbol, dir, score);
  if (adv.isBlocked) {
    console.log(`[DEGEN BLOCKED] ${rec.symbol} — ${adv.reason}`);
    return null;
  }
  score += adv.scoreAdj;

  const decimals = getPriceDecimals(rec.last);
  const gapPc = gap / 100;
  const retraceFactor = gap <= 1.2 ? 0.20 : 0.30;
  const entry = dir === "LONG" ? rec.last * (1 - gapPc * retraceFactor) : rec.last * (1 + gapPc * retraceFactor);
  const riskPct = clamp(rec.volaPct / 7, 2.0, 5.0); // Élargi (v3.3)
  const rr = gap <= 1.2 ? 1.5 : 1.7;

  let sl = dir === "LONG" ? entry * (1 - riskPct / 100) : entry * (1 + riskPct / 100);
  let tp1 = dir === "LONG" ? entry * (1 + riskPct / 100) : entry * (1 - riskPct / 100); // 1R partial
  let tp2 = dir === "LONG" ? entry * (1 + (riskPct * rr) / 100) : entry * (1 - (riskPct * rr) / 100);

  // Correction BE (Anti-Negative BE)
  const bePrice = dir === "LONG" ? entry * 1.002 : entry * 0.998;

  return {
    symbol: rec.symbol,
    direction: dir,
    score,
    entry: num(entry, decimals),
    sl: num(sl, decimals),
    tp1: num(tp1, decimals),
    tp2: num(tp2, decimals),
    beTrigger: num(dir === "LONG" ? entry + Math.abs(entry - sl) * 0.5 : entry - Math.abs(entry - sl) * 0.5, decimals), // 0.5R BE (v3.3)
    bePrice: num(bePrice, decimals),
    price: num(rec.last, decimals),
    levier: riskPct > 2.8 ? "2x" : "3x",
    rr
  };
}

// ========= MAIN LOOP =========
async function scanDegen() {
  /* 
  if (isTimeBlocked()) {
    console.log("🌙 [DEGEN] Midnight Window (Taiwan) — Blocking new entries");
    return;
  }
  */
  const start = Date.now();
  if (start - lastSymbolUpdate > SYMBOL_UPDATE_INTERVAL || !DEGEN_SYMBOLS.length) {
    DEGEN_SYMBOLS = await updateDegenList();
    lastSymbolUpdate = start;
  }

  const marketContext = await getMarketBias();
  const candidates = [];
  for (let i = 0; i < DEGEN_SYMBOLS.length; i += 5) {
    const results = await Promise.all(DEGEN_SYMBOLS.slice(i, i + 5).map(s => processDegen(s)));
    for (const r of results) {
      if (!r) continue;
      logDebug(`Analyzing ${r.symbol}: VolRatio=${r.volRatio.toFixed(1)}, Gap=${Math.abs(r.priceVsVwap).toFixed(2)}%, Vola=${r.volaPct.toFixed(1)}%`);
      const s = await analyzeCandidate(r, marketContext);
      if (s) {
        logDebug(`[DEGEN CANDIDATE] ${s.symbol} - Score: ${s.score.toFixed(1)}`);
        candidates.push(s);
      }
    }
    await sleep(200);
  }

  console.log(`📊 [DEGEN] Scan Summary: ${candidates.length} potential setups found out of ${DEGEN_SYMBOLS.length} symbols.`);
  if (!candidates.length) return;
  const best = candidates.sort((a, b) => b.score - a.score)[0];
  if (isRecentlySignaled(best.symbol) || (Date.now() - lastGlobalTradeTime < GLOBAL_COOLDOWN_MS)) return;

  const emoji = best.direction === "LONG" ? "🚀" : "🪂";
  const msg = `⚡ *JTF DEGEN v4.1* ⚡\n\n${emoji} *${best.symbol}* — ${best.direction}\n🏅 Score: ${best.score.toFixed(1)}\n\n💰 Prix: ${best.price}\n💠 Entry: ${best.entry}\n🎯 TP: ${best.tp1} / ${best.tp2}\n🛑 SL: ${best.sl}\n🔁 SL → BE @ ${best.beTrigger}\n⚖️ Levier: ${best.levier}`;

  console.log(`🔥 [DEGEN SIGNAL] ${best.symbol} (${best.direction}) - Score: ${best.score.toFixed(1)}`);

  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: "Markdown" })
  }).catch(() => { });

  lastGlobalTradeTime = Date.now();
  registerSignal("DEGEN", best.symbol, best.direction);

  // Enregistrement pour le suivi chrono
  activeTrades.set(best.symbol, Date.now());
}

// ========= TIME LIMIT MONITOR =========
async function checkTimeLimits() {
  const now = Date.now();
  for (const [symbol, entryTime] of activeTrades.entries()) {
    if (now - entryTime >= TIME_LIMIT_MS) {
      // Envoi alerte
      const msg = `⚠️ *DEGEN TIME LIMIT* ⚠️\n\n⌛ *${symbol}* a dépassé 120 min.\n\n👉 *CLOSE NOW* (Si pas déjà fait).\nLa volatilité scalping est probablement finie.`;
      await sendTelegram(msg);
      console.log(`[DEGEN TIMER] Alert sent for ${symbol}`);

      // On retire du monitoring pour ne pas spammer
      activeTrades.delete(symbol);
    }
  }
}

export async function startDegen() {
  console.log("🔥 DEGEN v4.0 On");
  await sendTelegram("🟢 JTF DEGEN v4.0 On");
  while (true) {
    try {
      await scanDegen();
      await checkTimeLimits(); // Vérification des chronos à chaque cycle
    } catch (e) { console.log("[DEGEN ERROR]", e); }
    await sleep(SCAN_INTERVAL_MS);
  }
}