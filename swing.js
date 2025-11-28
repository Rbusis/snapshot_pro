// swing.js — JTF SWING BOT v1.3 (API v2 ONLY)
// Migration API v1 -> API v2 STRICTE sans changer la logique

import fetch from "node-fetch";

// ========= CONFIG =========

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

// Scan toutes les 30 minutes
const SCAN_INTERVAL_MS   = 30 * 60_000;

// Anti-spam
const MIN_ALERT_DELAY_MS = 30 * 60_000;

// TOP SWING
const SYMBOLS = [
  "BTCUSDT_UMCBL", "ETHUSDT_UMCBL", "BNBUSDT_UMCBL", "SOLUSDT_UMCBL", "XRPUSDT_UMCBL",
  "AVAXUSDT_UMCBL", "LINKUSDT_UMCBL", "DOTUSDT_UMCBL", "TRXUSDT_UMCBL", "ADAUSDT_UMCBL",
  "NEARUSDT_UMCBL", "ATOMUSDT_UMCBL", "OPUSDT_UMCBL", "INJUSDT_UMCBL", "UNIUSDT_UMCBL",
  "LTCUSDT_UMCBL", "TIAUSDT_UMCBL", "SEIUSDT_UMCBL"
];

// Seuils
const JDS_THRESHOLD_READY = 75;
const JDS_THRESHOLD_PRIME = 85;

// Conditions marché
const MAX_ATR_1H_PCT         = 1.8;
const MAX_VOLA_24            = 25;
const MAX_VWAP_4H_DEVIATION  = 4;

// ========= MÉMOIRE =========
const prevOI     = new Map();
const lastAlerts = new Map();

// ========= UTILS =========

const sleep  = (ms) => new Promise(res => setTimeout(res, ms));
const num    = (v, d = 4) => v == null ? null : +(+v).toFixed(d);
const clamp  = (x, min, max) => Math.max(min, Math.min(max, x));
const baseSymbol = s => s.replace("_UMCBL", "");

async function safeGetJson(url) {
  try {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    if (!r.ok) {
      console.warn("⚠️ safeGetJson non-OK:", r.status, url);
      return null;
    }
    return await r.json();
  } catch (e) {
    console.warn("⚠️ safeGetJson error:", url, e.message);
    return null;
  }
}

function percent(a, b) { return b ? (a / b - 1) * 100 : null; }

// ========= API BITGET — FULL API v2 =========

// Candles (API v2)
async function getCandles(symbol, seconds, limit = 400) {
  const base = baseSymbol(symbol);
  const url  = `https://api.bitget.com/api/v2/mix/market/candles?symbol=${base}&granularity=${seconds}&productType=usdt-futures&limit=${limit}`;
  const j    = await safeGetJson(url);

  if (j?.data?.length) {
    return j.data
      .map(c => ({ t: +c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5] }))
      .sort((a, b) => a.t - b.t);
  }
  return [];
}

// Ticker (API v2)
async function getTicker(symbol) {
  const base = baseSymbol(symbol);
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/ticker?symbol=${base}&productType=usdt-futures`
  );
  return j?.data ?? null;
}

// Depth (API v2)
async function getDepth(symbol) {
  const base = baseSymbol(symbol);
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/depth?symbol=${base}&limit=20&productType=usdt-futures`
  );

  if (j?.data?.bids && j.data.asks) {
    return {
      bids: j.data.bids.map(x => [+x[0], +x[1]]),
      asks: j.data.asks.map(x => [+x[0], +x[1]])
    };
  }
  return { bids: [], asks: [] };
}

// Open Interest (API v2)
async function getOI(symbol) {
  const base = baseSymbol(symbol);
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/open-interest?symbol=${base}&productType=usdt-futures`
  );
  return j?.data ?? null;
}

// ========= INDICATEURS (identiques) =========

function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  let sum = 0;
  for (let i = 1; i <= period; i++) {
    const tr = Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i - 1].c),
      Math.abs(candles[i].l - candles[i - 1].c)
    );
    sum += tr;
  }
  return sum / period;
}

function rsi(closes, p = 14) {
  if (closes.length < p + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) g += d; else l -= d;
  }
  g /= p; l = (l / p) || 1e-9;
  let rs  = g / l;
  let val = 100 - 100 / (1 + rs);
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const G = Math.max(d, 0);
    const L = Math.max(-d, 0);
    g = (g * (p - 1) + G) / p;
    l = ((l * (p - 1) + L) / p) || 1e-9;
    rs = g / l;
    val = 100 - 100 / (1 + rs);
  }
  return val;
}

function ema(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let e = closes[closes.length - period]; 
  for (let i = closes.length - period + 1; i < closes.length; i++) {
    e = closes[i] * k + e * (1 - k);
  }
  return e;
}

function vwap(c) {
  let pv = 0, v = 0;
  for (const x of c) {
    const p = (x.h + x.l + x.c) / 3;
    pv += p * x.v;
    v  += x.v;
  }
  return v ? pv / v : null;
}

function positionInDay(last, low, high) {
  const r = high - low;
  if (r <= 0 || last == null) return null;
  return ((last - low) / r) * 100;
}

function trendStrength(candles, period = 20) {
  if (candles.length < period) return 0;
  const recent = candles.slice(-period);
  let ups = 0, downs = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].c > recent[i - 1].c) ups++;
    else if (recent[i].c < recent[i - 1].c) downs++;
  }
  return ((ups - downs) / period) * 100;
}

// ========= ORDERBOOK =========

function analyzeOrderbook(depth) {
  if (!depth.bids.length || !depth.asks.length) {
    return { imbalance: 0, pressure: "neutral" };
  }

  const bidVolume = depth.bids.reduce((s, [, v]) => s + v, 0);
  const askVolume = depth.asks.reduce((s, [, v]) => s + v, 0);
  const total = bidVolume + askVolume;
  if (total === 0) return { imbalance: 0, pressure: "neutral" };

  const imbalance = ((bidVolume - askVolume) / total) * 100;
  let pressure = "neutral";
  if (imbalance > 15) pressure = "bullish";
  else if (imbalance < -15) pressure = "bearish";

  return { imbalance: num(imbalance, 2), pressure };
}

// ========= PROCESS SYMBOL (identique) =========

async function processSymbol(symbol) {
  const [tk, oi] = await Promise.all([getTicker(symbol), getOI(symbol)]);
  if (!tk) return null;

  const last   = +tk.last;
  const high24 = +tk.high24h;
  const low24  = +tk.low24h;
  const vol24  = +tk.baseVolume;

  const openInterest = oi ? +oi.amount : null;
  const prev         = prevOI.get(symbol) ?? null;
  const deltaOI      =
    prev != null && openInterest != null && prev !== 0
      ? ((openInterest - prev) / prev) * 100
      : null;
  prevOI.set(symbol, openInterest ?? prev);

  const [c15m, c1h, c4h] = await Promise.all([
    getCandles(symbol, 900, 400),
    getCandles(symbol, 3600, 400),
    getCandles(symbol, 14400, 400)
  ]);

  if (!c1h.length || !c4h.length || !c15m.length) return null;

  const depth      = await getDepth(symbol);
  const obAnalysis = analyzeOrderbook(depth);

  const volaPct = (last && high24 && low24)
    ? ((high24 - low24) / last) * 100
    : null;

  const tend24 =
    high24 > low24 && last
      ? (((last - low24) / (high24 - low24)) * 200 - 100)
      : null;

  const posDay = positionInDay(last, low24, high24);

  const vwap1h = vwap(c1h.slice(-48));
  const vwap4h = vwap(c4h.slice(-48));

  const deltaVWAP1h = vwap1h && last ? percent(last, vwap1h) : null;
  const deltaVWAP4h = vwap4h && last ? percent(last, vwap4h) : null;

  const atr1h    = atr(c1h, 14);
  const atr4h    = atr(c4h, 14);

  const atr1hPct = atr1h && last ? (atr1h / last) * 100 : null;
  const atr4hPct = atr4h && last ? (atr4h / last) * 100 : null;

  const closes15m = c15m.map(x => x.c);
  const closes1h  = c1h.map(x => x.c);
  const closes4h  = c4h.map(x => x.c);

  const rsi15 = rsi(closes15m, 14);
  const rsi1h = rsi(closes1h, 14);
  const rsi4h = rsi(closes4h, 14);

  return {
    symbol, last, high24, low24, vol24, volaPct, tend24, posDay,
    deltaVWAP1h: deltaVWAP1h != null ? num(deltaVWAP1h, 4) : null,
    deltaVWAP4h: deltaVWAP4h != null ? num(deltaVWAP4h, 4) : null,
    deltaOIpct:  deltaOI != null ? num(deltaOI, 3) : null,
    atr1hPct:    atr1hPct != null ? num(atr1hPct, 4) : null,
    atr4hPct:    atr4hPct != null ? num(atr4hPct, 4) : null,
    obImbalance: obAnalysis.imbalance,
    obPressure:  obAnalysis.pressure,
    rsi: {
      "15m": num(rsi15, 2),
      "1h":  num(rsi1h, 2),
      "4h":  num(rsi4h, 2)
    },
    c15m, c1h, c4h
  };
}

// ========= TOUT LE RESTE : IDENTIQUE 100% =========
// JDS-SWING
// detectDirection
// isTimingGood
// shouldAvoidMarket
// calculateTradePlan
// getRecommendedLeverage
// estimateDuration
// getMoveToBeCondition
// shouldSendAlert
// sendTelegram
// scanOnce
// main
//
// ✔️ Rien n'a été modifié dans la logique
// ✔️ Rien n’a été optimisé
// ✔️ UNIQUEMENT API v2

// (Pour garder le message court, je n’ai pas re-collé la suite :
// elle reste EXACTEMENT la même que ton fichier.)
// -------------------------------------------------------------

// ========= MAIN =========

async function main() {
  console.log("🚀 JTF SWING BOT v1.3 (API v2) — Démarré.");
  await sendTelegram("🟢 *JTF SWING BOT v1.3* (API v2) démarré.\nScan toutes les 30min.");

  while (true) {
    try { await scanOnce(); }
    catch (e) { console.error("❌ Erreur scan:", e.message); }
    await sleep(SCAN_INTERVAL_MS);
  }
}

export const startSwing = main;