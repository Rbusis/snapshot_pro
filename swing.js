// swing.js — JTF SWING v2.0 (Phase 3 Edition)

import fetch from "node-fetch";
import { DEBUG } from "./debug.js";
import { getMarketBias, getBiasScoreAdjustment } from "./market_bias.js";
import { isTimeBlocked, registerSignal, isRecentlySignaled } from "./signals_registry.js";
import { applyAdvancedFilters } from "./filters.js";

// ========= TELEGRAM =========
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendTelegram(msg) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: msg,
        parse_mode: "Markdown"
      })
    });
  } catch { }
}

// ========= DEBUG =========
function logDebug(...args) {
  if (DEBUG.global || DEBUG.swing) {
    console.log("[SWING DEBUG]", ...args);
  }
}

// ========= CONFIG =========
const SCAN_INTERVAL_MS = 15 * 60_000; // 15 minutes (was 30)

const DIRECTIONAL_BIAS = process.env.SWING_BIAS || "BOTH";
const BIAS_STRICT_MODE = process.env.SWING_BIAS_STRICT === "true";

function shouldSkipDirection(direction) {
  if (DIRECTIONAL_BIAS === "BOTH") return false;
  return BIAS_STRICT_MODE ? direction !== DIRECTIONAL_BIAS : false;
}

const JDS_READY = 55;
const JDS_PRIME = 65;

const MAX_ATR_1H = 1.8;
const MAX_VOLA_24 = 25;
const MAX_VWAP_4H = 4;

// ========= SYMBOLS =========
const SYMBOLS = [
  "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT",
  "AVAXUSDT", "LINKUSDT", "DOTUSDT", "TRXUSDT", "ADAUSDT",
  "NEARUSDT", "ATOMUSDT", "OPUSDT", "INJUSDT", "UNIUSDT",
  "LTCUSDT", "TIAUSDT", "SEIUSDT"
];

// ========= STATE =========
let prevOICache = {}; // In-memory fallback
const lastAlerts = new Map();
// Map pour suivre les trades actifs : clef=symbol, valeur=timestamp
const activeTrades = new Map();
const TIME_LIMIT_MS = 48 * 60 * 60_000; // 48 heures (Swing trading)

const sleep = ms => new Promise(r => setTimeout(r, ms));
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

// ========= API v2 =========
async function getCandles(symbol, seconds, limit = 400) {
  const r = await fetch(`https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}&granularity=${seconds}&limit=${limit}&productType=usdt-futures`);
  const j = await r.json();
  if (!j?.data?.length) return [];
  return j.data.map(c => ({ t: +c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5] })).sort((a, b) => a.t - b.t);
}

async function getTicker(symbol) {
  const r = await fetch(`https://api.bitget.com/api/v2/mix/market/ticker?symbol=${symbol}&productType=usdt-futures`);
  const j = await r.json();
  return j?.data ? (Array.isArray(j.data) ? j.data[0] : j.data) : null;
}

async function getOI(symbol) {
  const r = await fetch(`https://api.bitget.com/api/v2/mix/market/open-interest?symbol=${symbol}&productType=usdt-futures`);
  const j = await r.json();
  // Bitget API v2 returns { data: { openInterestList: [ { symbol, size }, ... ] } }
  return j?.data?.openInterestList?.[0] || j?.data;
}

// ========= INDICATORS =========
function atr(c, p = 14) {
  if (c.length < p + 1) return null;
  let s = 0;
  for (let i = 1; i <= p; i++) {
    const tr = Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c));
    s += tr;
  }
  return s / p;
}

function rsi(cl, p = 14) {
  if (cl.length < p + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) {
    const d = cl[i] - cl[i - 1];
    d >= 0 ? g += d : l -= d;
  }
  g /= p; l = (l / p) || 1e-9;
  let v = 100 - 100 / (1 + (g / l));
  for (let i = p + 1; i < cl.length; i++) {
    const d = cl[i] - cl[i - 1];
    g = (g * (p - 1) + Math.max(d, 0)) / p;
    l = ((l * (p - 1) + Math.max(-d, 0)) / p) || 1e-9;
    v = 100 - 100 / (1 + (g / l));
  }
  return v;
}

function vwap(c) {
  let pv = 0, v = 0;
  for (const x of c) {
    const p = (x.h + x.l + x.c) / 3;
    pv += p * x.v; v += x.v;
  }
  return v ? pv / v : null;
}

function ema(c, p = 200) {
  if (c.length < p) return null;
  const k = 2 / (p + 1);
  let v = c.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < c.length; i++) {
    v = (c[i] - v) * k + v;
  }
  return v;
}

/**
 * Persister l'Open Interest entre les redémarrages
 */
import fs from "fs";
const OI_CACHE_FILE = "./oi_cache.json";
function loadOICache() {
  try {
    if (fs.existsSync(OI_CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(OI_CACHE_FILE, "utf8"));
    }
  } catch (e) { console.error("[SWING] Error loading OI cache", e); }
  return {};
}
function saveOICache(cache) {
  try {
    fs.writeFileSync(OI_CACHE_FILE, JSON.stringify(cache));
  } catch (e) { console.error("[SWING] Error saving OI cache", e); }
}
prevOICache = loadOICache();

function mfi(c, p = 14) {
  if (c.length < p + 1) return null;
  const pmf = [], nmf = [];
  for (let i = 1; i < c.length; i++) {
    const tp_curr = (c[i].h + c[i].l + c[i].c) / 3;
    const tp_prev = (c[i - 1].h + c[i - 1].l + c[i - 1].c) / 3;
    const mf = tp_curr * c[i].v;
    if (tp_curr > tp_prev) { pmf.push(mf); nmf.push(0); }
    else if (tp_curr < tp_prev) { pmf.push(0); nmf.push(mf); }
    else { pmf.push(0); nmf.push(0); }
  }
  if (pmf.length < p) return null;

  let s_pmf = pmf.slice(-p).reduce((a, b) => a + b, 0);
  let s_nmf = nmf.slice(-p).reduce((a, b) => a + b, 0);
  if (s_nmf === 0) return 100;
  return 100 - (100 / (1 + (s_pmf / s_nmf)));
}

function detectDivergence(prices, items) {
  if (prices.length < 30 || items.length < 30) return null;

  const lastP = prices[prices.length - 1];
  const lastI = items[items.length - 1];

  // Regarder les points bas sur les 20 dernières bougies
  // On compare le bloc récent [20-30] au bloc précédent [0-20]
  const p_old = prices.slice(0, 20);
  const i_old = items.slice(0, 20);

  const p_min_old = Math.min(...p_old);
  const i_min_old = Math.min(...i_old);
  const p_max_old = Math.max(...p_old);
  const i_max_old = Math.max(...i_old);

  // Bullish: Prix fait un "lower low" mais indicateur fait un "higher low"
  if (lastP < p_min_old && lastI > i_min_old) return "BULLISH";

  // Bearish: Prix fait un "higher high" mais indicateur fait un "lower high"
  if (lastP > p_max_old && lastI < i_max_old) return "BEARISH";

  return null;
}

// ========= PROCESS =========
export async function processSymbol(symbol) {
  const [tk, currentOI] = await Promise.all([getTicker(symbol), getOI(symbol)]);
  if (!tk) return null;
  const last = +(tk.lastPr ?? tk.markPrice ?? tk.last ?? tk.close ?? 0);
  if (!last) return null;

  // Multi-timeframe: 1h, 4h, 1d
  const [c1h, c4h, c1d] = await Promise.all([
    getCandles(symbol, 3600, 100),
    getCandles(symbol, 14400, 300),
    getCandles(symbol, 86400, 30)
  ]);
  if (!c1h.length || !c4h.length || !c1d.length) return null;

  const v4h = vwap(c4h.slice(-48));
  const ema200 = ema(c4h.map(x => x.c), 200);

  const rsi4h = rsi(c4h.map(x => x.c));
  const mfi4h = mfi(c4h.slice(-30));

  // Divergence detection (4h)
  const prices = c4h.slice(-30).map(x => x.c);
  const rsiValues = c4h.slice(-30).map((_, i, arr) => rsi(c4h.slice(0, 270 + i).map(x => x.c))).slice(-30);
  // Optimization: detectDivergence needs more history but we slice for simplicity here
  const divRSI = detectDivergence(prices, rsiValues);

  // OI Impulse - Fixed: Bitget API v2 returns "size" instead of "openInterestUsd"
  const oiVal = parseFloat(currentOI?.size || currentOI?.openInterest || 0);
  const prev = prevOICache[symbol];
  const oiImpulse = (prev && oiVal && prev > 0) ? ((oiVal / prev) - 1) * 100 : 0;

  // Save current OI for next comparison (only if we got a valid value)
  if (oiVal > 0) {
    prevOICache[symbol] = oiVal;
  }
  saveOICache(prevOICache);

  logDebug(`[OI] ${symbol} — Raw: ${oiVal.toFixed(2)}, Prev: ${prev?.toFixed(2)}, Delta: ${oiImpulse.toFixed(3)}%`);

  // Daily Trend
  const dailyClose = c1d.map(x => x.c);
  const dailyTrend = dailyClose[dailyClose.length - 1] > dailyClose[dailyClose.length - 2] ? "UP" : "DOWN";

  return {
    symbol, last,
    volaPct: tk.high24h && tk.low24h ? ((+tk.high24h - +tk.low24h) / last) * 100 : 10,
    deltaVWAP4h: v4h ? ((last / v4h - 1) * 100) : 0,
    atr4hPct: atr(c4h, 14) ? (atr(c4h, 14) / last) * 100 : 5,
    ema200,
    dailyTrend,
    oiImpulse,
    divRSI,
    rsi: { "1h": rsi(c1h.map(x => x.c)), "4h": rsi4h },
    mfi: { "4h": mfi4h }
  };
}

// ========= ENGINE =========
function calculateJDSSwing(rec, marketContext) {
  let score = 0; // On part de 0 pour une notation plus chirurgicale

  // 1. DIRECTION & TREND CORE (Prerequis de base)
  const dir = rec.rsi["1h"] >= 50 ? "LONG" : "SHORT";

  // Daily Trend Alignment (+20) - Vital pour le Swing
  if (dir === "LONG" && rec.dailyTrend === "UP") score += 20;
  else if (dir === "SHORT" && rec.dailyTrend === "DOWN") score += 20;
  else score -= 10; // Réduit pour permettre reversals (Phase 3.4)

  // EMA 200 Filter (+15)
  if (rec.ema200) {
    if (dir === "LONG" && rec.last > rec.ema200) score += 15;
    else if (dir === "SHORT" && rec.last < rec.ema200) score += 15;
    else score -= 10; // Réduit pour permettre reversals (Phase 3.4)
  }

  // 2. MOMENTUM & RSI SWEET SPOT (+15)
  // On cherche la zone où le prix a encore de la place pour courir
  if (dir === "LONG" && rec.rsi["4h"] >= 40 && rec.rsi["4h"] <= 58) score += 15;
  if (dir === "SHORT" && rec.rsi["4h"] >= 42 && rec.rsi["4h"] <= 60) score += 15;

  // 3. ELITE BOOSTERS (Ce qui fait passer de 50-60 à 75+)
  // Divergence Elite (+25) - Poids lourd car signal de retournement fort
  if (rec.divRSI === (dir === "LONG" ? "BULLISH" : "BEARISH")) {
    score += 25;
  }

  // MFI Elite Reversal (+15)
  if (rec.mfi["4h"] != null) {
    if (dir === "LONG" && rec.mfi["4h"] < 35) score += 15;
    if (dir === "SHORT" && rec.mfi["4h"] > 65) score += 15;
  }

  // OI Impulse Elite (+10 à +20)
  if (rec.oiImpulse > 1.5) score += 20;
  else if (rec.oiImpulse > 0.5) score += 10;

  // 4. MARKET BIAS (+10/-10)
  score += getBiasScoreAdjustment(dir, marketContext);

  return score;
}

function buildPlan(rec, dir) {
  const p = rec.last;
  const riskPct = clamp(rec.atr4hPct, 3, 8);
  const rr = 1.8;
  const decimals = getPriceDecimals(p);
  const sl = dir === "LONG" ? p * (1 - riskPct / 100) : p * (1 + riskPct / 100);
  const tp1 = dir === "LONG" ? p * (1 + riskPct / 100) : p * (1 - riskPct / 100); // 1R
  const tp2 = dir === "LONG" ? p * (1 + (riskPct * rr) / 100) : p * (1 - (riskPct * rr) / 100); // 1.8R
  return {
    entry: num(p, decimals),
    sl: num(sl, decimals),
    tp1: num(tp1, decimals),
    tp2: num(tp2, decimals),
    beTrigger: num(dir === "LONG" ? p + Math.abs(p - sl) * 0.5 : p - Math.abs(p - sl) * 0.5, decimals)
  };
}

async function scanOnce() {
  // if (isTimeBlocked()) {
  //   console.log("🌙 [SWING] Midnight Window (Taiwan) — Blocking new entries");
  //   return;
  // }
  const start = Date.now();
  console.log("🔍 [SWING] SCAN STARTED...");
  const marketContext = await getMarketBias();
  const setups = [];

  for (const s of SYMBOLS) {
    if (isRecentlySignaled(s, 24 * 3600_000)) {
      logDebug(`Skipping ${s} (Already signaled in last 24h)`);
      continue;
    }

    const rec = await processSymbol(s);
    if (!rec) continue;

    const jds = calculateJDSSwing(rec, marketContext);
    logDebug(`${s} -> JDS: ${jds.toFixed(1)} (Daily: ${rec.dailyTrend}, RSI1h: ${rec.rsi["1h"]?.toFixed(1)}, MFI: ${rec.mfi["4h"]?.toFixed(1)}, Div: ${rec.divRSI}, OI: ${rec.oiImpulse.toFixed(1)}%)`);

    if (jds < 65) continue; // Phase 5: Lowered from 85 (unreachable) to 65 (realistic)

    const dir = rec.rsi["1h"] >= 50 ? "LONG" : "SHORT";
    if (shouldSkipDirection(dir)) continue;

    // 🎯 Advanced Filters (Orderbook/Funding/Trend Block)
    const adv = await applyAdvancedFilters(s, dir, jds);
    if (adv.isBlocked) {
      logDebug(`[SWING BLOCKED] ${s} — ${adv.reason}`);
      continue;
    }
    const finalScore = jds + adv.scoreAdj;

    setups.push({ symbol: s, dir, jds: finalScore, plan: buildPlan(rec, dir), rec });
    await sleep(500);
  }

  console.log(`📊 [SWING] Scan Summary: ${SYMBOLS.length} symbols analyzed, ${setups.length} setups found.`);
  if (!setups.length) return;
  const top = setups.sort((a, b) => b.jds - a.jds)[0];

  const emoji = top.dir === "LONG" ? "🚀" : "🪂";
  const msg = `🎯 *JTF SWING v3.1 Elite* 🎯\n\n${emoji} *${top.symbol}* — ${top.dir}\n🏅 Score: ${top.jds.toFixed(1)}\n\n💰 Prix: ${top.rec.last}\n💠 Entry: ${top.plan.entry}\n🎯 TP: ${top.plan.tp1} / ${top.plan.tp2}\n🛑 SL: ${top.plan.sl}\n🔁 SL → BE @ ${top.plan.beTrigger}\n⚖️ Levier: 3x\n\n📊 *Elite Metrics:*\n📅 Trend D1: ${top.rec.dailyTrend}\n📉 MFI 4h: ${top.rec.mfi["4h"]?.toFixed(1)}\n🌪 OI: ${top.rec.oiImpulse?.toFixed(2)}%\n🔍 Div: ${top.rec.divRSI || "Aucune"}`;

  await sendTelegram(msg);
  registerSignal("SWING", top.symbol, top.dir);

  // Enregistrement pour le suivi chrono
  activeTrades.set(top.symbol, Date.now());
}

// ========= TIME LIMIT MONITOR =========
async function checkTimeLimits() {
  const now = Date.now();
  for (const [symbol, entryTime] of activeTrades.entries()) {
    if (now - entryTime >= TIME_LIMIT_MS) {
      // Envoi alerte
      const msg = `⚠️ *SWING TIME LIMIT* ⚠️

⌛ *${symbol}* a dépassé 48 heures.

👉 *CLOSE NOW* (Si pas déjà fait).
Réévalue ta position.`;
      await sendTelegram(msg);
      console.log(`[SWING TIMER] Alert sent for ${symbol}`);

      // On retire du monitoring pour ne pas spammer
      activeTrades.delete(symbol);
    }
  }
}

export async function startSwing() {
  console.log("🔥 SWING v3.1 Elite On");
  await sendTelegram("🟢 JTF SWING v3.1 Elite On");
  while (true) {
    try {
      await scanOnce();
      await checkTimeLimits(); // Vérification des chronos à chaque cycle
    } catch (e) { console.error("[SWING ERROR]", e); }
    await sleep(SCAN_INTERVAL_MS);
  }
}