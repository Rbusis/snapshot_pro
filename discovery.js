// discovery.js — JTF DISCOVERY v2.0 (Advanced Phase 3 Edition)

import fetch from "node-fetch";
import fs from "fs";
import { DEBUG } from "./debug.js";
import { isRecentlySignaled, registerSignal, isTimeBlocked } from "./signals_registry.js";
import { getMarketBias, getBiasScoreAdjustment } from "./market_bias.js";
import { applyAdvancedFilters } from "./filters.js";

// ========= DEBUG =========
function logDebug(...args) {
  if (DEBUG.global || DEBUG.discovery) {
    console.log("[DISCOVERY DEBUG]", ...args);
  }
}

// ========= CONFIG =========
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const SCAN_INTERVAL_MS = 5 * 60_000;

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

const DIRECTIONAL_BIAS = process.env.DISCOVERY_BIAS || "BOTH";
const BIAS_STRICT_MODE = process.env.DISCOVERY_BIAS_STRICT === "true";

function shouldSkipDirection(direction) {
  if (DIRECTIONAL_BIAS === "BOTH") return false;
  return BIAS_STRICT_MODE ? direction !== DIRECTIONAL_BIAS : false;
}

const MIN_ALERT_DELAY_MS = 15 * 60_000;
const GLOBAL_COOLDOWN_MS = 30 * 60_000;
const SYMBOL_UPDATE_INTERVAL = 60 * 60_000;

// ========= STATE =========
let DISCOVERY_SYMBOLS = [];
let lastSymbolUpdate = 0;
let lastGlobalTradeTime = 0;
// Map pour suivre les trades actifs : clef=symbol, valeur=timestamp
const activeTrades = new Map();
const TIME_LIMIT_MS = 8 * 60 * 60_000; // 8 heures (Intraday complet)
const lastAlerts = new Map();

// ========= BLACKLIST (TOXIC) =========
const IGNORE_LIST = [
  "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT",
  "ADAUSDT", "DOGEUSDT", "AVAXUSDT", "DOTUSDT", "TRXUSDT",
  "LINKUSDT", "TONUSDT", "SUIUSDT", "APTUSDT", "NEARUSDT",
  "ARBUSDT", "OPUSDT", "INJUSDT", "ATOMUSDT", "AAVEUSDT",
  "LTCUSDT", "UNIUSDT", "FILUSDT", "XLMUSDT", "RUNEUSDT",
  "ALGOUSDT", "PEPEUSDT", "WIFUSDT", "TIAUSDT", "SEIUSDT",
  "WIFUSDT_UMCBL" // Doublé pour sécurité
];

// ========= UTILS =========
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (x, min, max) => Math.max(min, Math.min(max, x));
const num = (v, d = 4) => v == null ? null : +(+v).toFixed(d);

function getPriceDecimals(price) {
  if (price == null || !isFinite(price)) return 4;
  const p = Math.abs(price);
  if (p >= 1000) return 2;
  if (p >= 100) return 3;
  if (p >= 1) return 4;
  return 5;
}

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

async function getCandles(symbol, seconds, limit = 200) {
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

// ========= PROCESS =========
async function processDiscovery(symbol) {
  const tk = await getTicker(symbol);
  if (!tk) return null;
  const last = +(tk.lastPr ?? tk.markPrice ?? tk.last ?? 0);
  if (!last) return null;

  const [c5m, c15m] = await Promise.all([getCandles(symbol, 300, 100), getCandles(symbol, 900, 100)]);
  if (!c5m?.length) return null;

  const rsi5 = rsi(c5m.map(x => x.c));
  const vwp = vwap(c5m.slice(-24));
  const priceVsVwap = vwp ? ((last - vwp) / vwp) * 100 : 0;
  const lastC = c5m[c5m.length - 1];
  const wick = wicks(lastC);
  const avgVol = c5m.slice(-11, -1).reduce((a, b) => a + b.v, 0) / 10;
  const volRatio = avgVol > 0 ? lastC.v / avgVol : 1;

  return { symbol, last, volaPct: tk.high24h && tk.low24h ? ((+tk.high24h - +tk.low24h) / last) * 100 : 5, rsi5, priceVsVwap, volRatio, change24: +tk.change24h || 0, wicks: wick };
}

// ========= ANALYZE =========
async function analyzeDiscovery(rec, marketContext) {
  if (!rec) return null;

  let dir = rec.priceVsVwap > 0 ? "LONG" : "SHORT";
  if (rec.volRatio < (dir === "LONG" ? 2.5 : 2.0)) return null;
  if (rec.volaPct == null || rec.volaPct < 3 || rec.volaPct > 30) return null;

  const gap = Math.abs(rec.priceVsVwap);
  const [gapMin, gapMax] = dir === "LONG" ? [0.5, 2.5] : [0.8, 3.5];
  if (gap < gapMin || gap > gapMax) return null;

  if (dir === "LONG") {
    if (rec.wicks.upper > 2.0 || rec.change24 < -5) return null;
  } else {
    if (rec.wicks.lower > 1.2) return null;
  }

  // 🎯 SCORING LINEAIRE (v2.2) 🎯
  // Finit les paliers brutaux. Chaque point de volume ou de % compte.

  let score = 0;

  // 1. VOLUME (Le plus important)
  // De x2.0 à x5.0 -> Donne de 20 à 50 points.
  // Formule : VolumeRatio * 10 (Borné entre 20 et 50)
  const volScore = Math.min(Math.max(rec.volRatio * 10, 20), 50);
  score += volScore;

  // 2. GAP (L'élastique)
  // Cible idéale : 1.2% à 2.0%. 
  // Formule dégressive : Plus on s'éloigne de l'idéal, moins on gagne.
  // Base 30 pts.
  let gapScore = 0;
  if (gap >= 0.8 && gap <= 3.0) {
    // Au coeur de la zone (1.0 - 2.0), on donne le max.
    if (gap >= 1.0 && gap <= 2.0) gapScore = 30;
    // En bordure, on réduit linéairement
    else gapScore = 20;
  } else {
    gapScore = 10; // Hors zone mais acceptable
  }
  score += gapScore;

  // 3. RSI (Le momentum)
  // Bon RSI = +20, Mauvais = +10.
  // On garde du simple ici pour l'instant car le RSI est binaire (Bon zone / Mauvaise zone)
  const goodRsiLong = (rec.rsi5 >= 45 && rec.rsi5 <= 65);
  const goodRsiShort = (rec.rsi5 >= 25 && rec.rsi5 <= 45);
  score += (dir === "LONG" ? (goodRsiLong ? 20 : 10) : (goodRsiShort ? 20 : 10));

  // 4. Biais BTC
  score += getBiasScoreAdjustment(dir, marketContext);

  if (score < 85) return null; // Phase 5: Raised from 80 to eliminate toxic 80-85 bucket

  // 🎯 Advanced Filters (Orderbook/Funding)
  const adv = await applyAdvancedFilters(rec.symbol, dir, score);
  if (adv.isBlocked) {
    console.log(`[DISCOVERY BLOCKED] ${rec.symbol} — ${adv.reason}`);
    return null;
  }
  score += adv.scoreAdj;

  const decimals = getPriceDecimals(rec.last);
  const gapPc = gap / 100;
  const retraceFactor = gap <= 1.2 ? 0.20 : gap <= 2.0 ? 0.25 : 0.30; // Dynamic (Phase 3.4)
  const entry = dir === "LONG" ? rec.last * (1 - gapPc * retraceFactor) : rec.last * (1 + gapPc * retraceFactor);
  const riskPct = clamp((rec.volaPct / 5) * 2, 2, 5);
  const rr = 1.6;

  let sl = dir === "LONG" ? entry * (1 - riskPct / 100) : entry * (1 + riskPct / 100);
  let tp1 = dir === "LONG" ? entry * (1 + riskPct / 100) : entry * (1 - riskPct / 100); // 1R partial
  let tp2 = dir === "LONG" ? entry * (1 + (riskPct * rr) / 100) : entry * (1 - (riskPct * rr) / 100);

  // Correction BE (Anti-Negative BE)
  const bePrice = dir === "LONG" ? entry * 1.002 : entry * 0.998; // +0.2% flush commission

  return {
    symbol: rec.symbol,
    direction: dir,
    score,
    price: num(rec.last, decimals),
    limitEntry: num(entry, decimals),
    sl: num(sl, decimals),
    tp1: num(tp1, decimals),
    tp2: num(tp2, decimals),
    beTrigger: num(dir === "LONG" ? entry + Math.abs(entry - sl) * 0.5 : entry - Math.abs(entry - sl) * 0.5, decimals),
    bePrice: num(bePrice, decimals),
    levier: riskPct > 4 ? "2x" : "3x"
  };
}

// ========= MAIN LOOP =========
async function scanDiscovery() {
  /* 
  if (isTimeBlocked()) {
    console.log("🌙 [DISCOVERY] Midnight Window (Taiwan) — Blocking new entries");
    return;
  }
  */
  const start = Date.now();
  console.log("🔍 [DISCOVERY] SCAN STARTED...");

  if (start - lastSymbolUpdate > SYMBOL_UPDATE_INTERVAL || !DISCOVERY_SYMBOLS.length) {
    const all = await getAllTickers();
    DISCOVERY_SYMBOLS = all.filter(t => t.symbol?.endsWith("USDT") && !IGNORE_LIST.includes(t.symbol) && (+t.usdtVolume > 5_000_000))
      .sort((a, b) => (+b.usdtVolume) - (+a.usdtVolume)).slice(0, 50).map(t => t.symbol);
    lastSymbolUpdate = start;
  }

  const marketContext = await getMarketBias();
  const signals = [];
  for (let i = 0; i < DISCOVERY_SYMBOLS.length; i += 5) {
    const batch = DISCOVERY_SYMBOLS.slice(i, i + 5);
    const res = await Promise.all(batch.map(s => processDiscovery(s)));
    for (const r of res) {
      if (!r) continue;
      logDebug(`Analyzing ${r.symbol}: VolRatio=${r.volRatio.toFixed(1)}, Gap=${Math.abs(r.priceVsVwap).toFixed(2)}%, Vola=${r.volaPct.toFixed(1)}%`);
      const s = await analyzeDiscovery(r, marketContext);
      if (s) {
        logDebug(`[DISCOVERY CANDIDATE] ${s.symbol} - Score: ${s.score.toFixed(1)}`);
        signals.push(s);
      }
    }
    await sleep(200);
  }

  console.log(`📊 [DISCOVERY] Scan Summary: ${signals.length} potential setups found out of ${DISCOVERY_SYMBOLS.length} symbols.`);
  if (!signals.length) return;
  const best = signals.sort((a, b) => b.score - a.score)[0];

  if (isRecentlySignaled(best.symbol, 24 * 3600_000)) {
    logDebug(`Skipping ${best.symbol} (Already signaled in last 24h)`);
    return;
  }
  if (Date.now() - lastGlobalTradeTime < GLOBAL_COOLDOWN_MS) return;

  const emoji = best.direction === "LONG" ? "🚀" : "🪂";
  const msg = `⚡ *JTF DISCOVERY v2.1* ⚡\n\n${emoji} *${best.symbol}* — ${best.direction}\n🏅 Score: ${best.score.toFixed(1)}\n\n💰 Prix: ${best.price}\n💠 Entry: ${best.limitEntry}\n🎯 TP: ${best.tp1} / ${best.tp2}\n🛑 SL: ${best.sl}\n🔁 SL → BE @ ${best.beTrigger}\n⚖️ Levier: ${best.levier}`;

  console.log(`🔥 [DISCOVERY SIGNAL] ${best.symbol} (${best.direction}) - Score: ${best.score.toFixed(1)}`);

  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: "Markdown" })
  }).catch(() => { });

  lastGlobalTradeTime = Date.now();
  registerSignal("DISCOVERY", best.symbol, best.direction);

  // Enregistrement pour le suivi chrono
  activeTrades.set(best.symbol, Date.now());
}

// ========= TIME LIMIT MONITOR =========
async function checkTimeLimits() {
  const now = Date.now();
  for (const [symbol, entryTime] of activeTrades.entries()) {
    if (now - entryTime >= TIME_LIMIT_MS) {
      // Envoi alerte
      const msg = `⚠️ *DISCOVERY TIME LIMIT* ⚠️\n\n⌛ *${symbol}* a dépassé 8 heures.\n\n👉 *CLOSE NOW* (Si pas déjà fait).\nLa session intraday est terminée.`;
      await sendTelegram(msg);
      console.log(`[DISCOVERY TIMER] Alert sent for ${symbol}`);

      // On retire du monitoring pour ne pas spammer
      activeTrades.delete(symbol);
    }
  }
}

export async function startDiscovery() {
  console.log("🔥 DISCOVERY v2.0 On");
  await sendTelegram("🟢 JTF DISCOVERY v2.0 On");
  while (true) {
    try {
      await scanDiscovery();
      await checkTimeLimits(); // Vérification des chronos à chaque cycle
    } catch (e) { console.log("[DISCOVERY ERROR]", e); }
    await sleep(SCAN_INTERVAL_MS);
  }
}