// swing.js — JTF SWING v2.0 (Phase 3 Edition)

import fetch from "node-fetch";
import { DEBUG } from "./debug.js";
import { getMarketBias, getBiasScoreAdjustment } from "./market_bias.js";
import { isTimeBlocked } from "./signals_registry.js";

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
const SCAN_INTERVAL_MS = 30 * 60_000; // 30 minutes

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
const prevOI = new Map();
const lastAlerts = new Map();

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
  return j?.data?.[0] || j?.data;
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

// ========= PROCESS =========
async function processSymbol(symbol) {
  const [tk, oi] = await Promise.all([getTicker(symbol), getOI(symbol)]);
  if (!tk) return null;
  const last = +(tk.lastPr ?? tk.markPrice ?? tk.last ?? tk.close ?? 0);
  if (!last) return null;

  const [c1h, c4h] = await Promise.all([getCandles(symbol, 3600, 100), getCandles(symbol, 14400, 100)]);
  if (!c1h.length || !c4h.length) return null;

  const v4h = vwap(c4h.slice(-48));
  const rsi15 = rsi(c1h.slice(-4).map(x => x.c)); // rough proxy
  const rsi4h = rsi(c4h.map(x => x.c));

  return {
    symbol, last,
    volaPct: tk.high24h && tk.low24h ? ((+tk.high24h - +tk.low24h) / last) * 100 : 10,
    deltaVWAP4h: v4h ? ((last / v4h - 1) * 100) : 0,
    atr4hPct: atr(c4h, 14) ? (atr(c4h, 14) / last) * 100 : 5,
    rsi: { "15m": rsi15, "4h": rsi4h }
  };
}

// ========= ENGINE =========
function calculateJDSSwing(rec, marketContext) {
  let score = 40;
  if (rec.rsi["4h"] > 50 && rec.rsi["4h"] < 70) score += 15;
  if (rec.rsi["4h"] < 50 && rec.rsi["4h"] > 30) score += 15;
  const dir = rec.rsi["15m"] > 55 ? "LONG" : "SHORT";
  score += getBiasScoreAdjustment(dir, marketContext);
  return score;
}

function buildPlan(rec, dir) {
  const p = rec.last;
  const riskPct = clamp(rec.atr4hPct, 3, 8);
  const rr = 1.8;
  const decimals = getPriceDecimals(p);
  const sl = dir === "LONG" ? p * (1 - riskPct / 100) : p * (1 + riskPct / 100);
  const tp = dir === "LONG" ? p * (1 + (riskPct * rr) / 100) : p * (1 - (riskPct * rr) / 100);
  return { entry: num(p, decimals), sl: num(sl, decimals), tp: num(tp, decimals), beTrigger: num(dir === "LONG" ? p + Math.abs(p - sl) * 1.5 : p - Math.abs(p - sl) * 1.5, decimals) };
}

async function scanOnce() {
  if (isTimeBlocked()) {
    console.log("🌙 [SWING] Midnight Window (Taiwan) — Blocking new entries");
    return;
  }
  const start = Date.now();
  console.log("🔍 [SWING] SCAN STARTED...");
  const marketContext = await getMarketBias();
  const setups = [];

  for (const s of SYMBOLS) {
    const rec = await processSymbol(s);
    if (!rec) continue;
    const jds = calculateJDSSwing(rec, marketContext);
    if (jds < 60) continue;
    const dir = rec.rsi["15m"] > 50 ? "LONG" : "SHORT";
    if (shouldSkipDirection(dir)) continue;
    setups.push({ symbol: s, dir, jds, plan: buildPlan(rec, dir), rec });
    await sleep(500);
  }

  if (!setups.length) return;
  const top = setups.sort((a, b) => b.jds - a.jds)[0];

  const msg = `🎯 *JTF SWING v2.0*\n\n*${top.symbol}* — ${top.dir === "LONG" ? "📈" : "📉"} *${top.dir}*\n\n💰 Prix: ${top.rec.last}\n💠 Entry: ${top.plan.entry}\n🎯 TP: ${top.plan.tp}\n🛑 SL: ${top.plan.sl}\n🔁 SL → BE @ ${top.plan.beTrigger}\n🔥 Score: ${top.jds.toFixed(1)}`;

  await sendTelegram(msg);
}

export async function startSwing() {
  console.log("🔥 SWING v2.0 On");
  while (true) {
    try { await scanOnce(); } catch (e) { console.error("[SWING ERROR]", e); }
    await sleep(SCAN_INTERVAL_MS);
  }
}
