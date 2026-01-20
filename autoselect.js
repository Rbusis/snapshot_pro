// autoselect.js — JTF MAJORS v2.0 (BTC/ETH/SOL optimized)

import process from "process";
import fetch from "node-fetch";
import { DEBUG } from "./debug.js";
import { getMarketBias, getBiasScoreAdjustment } from "./market_bias.js";
import { isRecentlySignaled, registerSignal, isTimeBlocked } from "./signals_registry.js";
import { applyAdvancedFilters } from "./filters.js";

// ========= CONFIG =========
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

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

const SCAN_INTERVAL_MS = 5 * 60_000;
const MIN_ALERT_DELAY_MS = 15 * 60_000;
const FLIP_COOLDOWN_MS = 30 * 60_000;
const MAX_SIGNALS_PER_SCAN = 2;
const SUGGESTED_LEVERAGE = "10x";

const DIRECTIONAL_BIAS = process.env.TOP30_BIAS || "BOTH";
const BIAS_STRICT_MODE = process.env.TOP30_BIAS_STRICT === "true";

function shouldSkipDirection(direction) {
  if (DIRECTIONAL_BIAS === "BOTH") return false;
  return BIAS_STRICT_MODE ? direction !== DIRECTIONAL_BIAS : false;
}

// ========= DEBUG =========
function logDebug(...args) {
  if (DEBUG.global || DEBUG.autoselect) {
    console.log("[MAJORS DEBUG]", ...args);
  }
}

// ========= SYMBOLS (MAJORS ONLY) =========
const SYMBOLS = [
  "BTCUSDT_UMCBL", "ETHUSDT_UMCBL", "SOLUSDT_UMCBL"
];

// ========= STATE =========
const prevOI = new Map();
const lastAlerts = new Map();
const lastSentDirection = new Map();
// Map pour suivre les trades actifs : clef=symbol, valeur=timestamp
const activeTrades = new Map();
const TIME_LIMIT_MS = 72 * 60 * 60_000; // 72 heures (Majors swing trading)

// ========= UTIL =========
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
const baseSymbol = s => s.replace("_UMCBL", "");

async function safeGetJson(url) {
  try {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  }
}

// ========= API v2 =========
async function getTicker(symbol) {
  const j = await safeGetJson(`https://api.bitget.com/api/v2/mix/market/ticker?symbol=${baseSymbol(symbol)}&productType=usdt-futures`);
  return j?.data?.[0] || j?.data;
}

async function getOI(symbol) {
  const j = await safeGetJson(`https://api.bitget.com/api/v2/mix/market/open-interest?symbol=${baseSymbol(symbol)}&productType=usdt-futures`);
  // Bitget API v2 returns { data: { openInterestList: [ { symbol, size }, ... ] } }
  return j?.data?.openInterestList?.[0] || j?.data;
}

async function getCandles(symbol, sec, limit = 200) {
  const j = await safeGetJson(`https://api.bitget.com/api/v2/mix/market/candles?symbol=${baseSymbol(symbol)}&granularity=${sec}&limit=${limit}&productType=usdt-futures`);
  return j?.data ? j.data.map(c => ({ t: +c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5] })).sort((a, b) => a.t - b.t) : [];
}

// ========= INDICATORS =========
function percent(a, b) { return b ? (a / b - 1) * 100 : null; }

function closeChange(c, b = 1) {
  if (c.length < b + 1) return null;
  return percent(c[c.length - 1].c, c[c.length - 1 - b].c);
}

function toScore100(x) { return clamp((x + 1) / 2 * 100, 0, 100); }

// ========= SNAPSHOT =========
async function processSymbol(symbol) {
  const [tk, oi] = await Promise.all([getTicker(symbol), getOI(symbol)]);
  if (!tk) return null;

  const last = +(tk.lastPr ?? tk.markPrice ?? tk.last ?? 0);
  if (!last || last <= 0) return null;

  const openInterest = oi?.size != null ? +oi.size : (oi?.amount != null ? +oi.amount : null);
  const prev = prevOI.get(symbol) ?? null;
  const deltaOI = prev != null && openInterest != null && prev !== 0 ? ((openInterest - prev) / prev) * 100 : null;
  prevOI.set(symbol, openInterest ?? prev);

  const [c15m] = await Promise.all([getCandles(symbol, 900, 50)]);
  if (!c15m.length) return null;

  const dP15 = closeChange(c15m);

  // 🎯 Sensibilité augmentée (Suppression du / 3)
  const MMS_long = toScore100(-(dP15) || 0);
  const MMS_short = toScore100(+(dP15) || 0);

  return {
    symbol, last,
    volaPct: tk.high24h && tk.low24h ? ((+tk.high24h - +tk.low24h) / last) * 100 : 5,
    deltaOIpct: deltaOI != null ? +num(deltaOI, 3) : null,
    MMS_long, MMS_short
  };
}

// ====== JDS Engine ======
function fuseJDS(rec, marketContext) {
  const short_adj = getBiasScoreAdjustment("SHORT", marketContext);
  const long_adj = getBiasScoreAdjustment("LONG", marketContext);

  const mms_short_adjusted = rec.MMS_short + short_adj;
  const mms_long_adjusted = rec.MMS_long + long_adj;

  if (mms_short_adjusted > mms_long_adjusted) {
    return { direction: "SHORT", jds: rec.MMS_short + (short_adj / 2) };
  }
  return { direction: "LONG", jds: rec.MMS_long + (long_adj / 2) };
}

// ========= PLAN DE TRADE =========
function buildTradePlan(rec, fusion, rr) {
  const p = rec.last;
  const dir = fusion.direction;
  const decimals = getPriceDecimals(p);
  const riskPct = clamp((rec.volaPct ?? 5) / 2.5, 0.4, 3); // Plus serré sur Majors
  const rewardPct = riskPct * rr;

  let sl, tp1, tp2;
  if (dir === "LONG") {
    sl = p * (1 - riskPct / 100);
    tp1 = p * (1 + rewardPct / 100);
    tp2 = p * (1 + (1.8 * rewardPct) / 100);
  } else {
    sl = p * (1 + riskPct / 100);
    tp1 = p * (1 - rewardPct / 100);
    tp2 = p * (1 - (1.8 * rewardPct) / 100);
  }

  return {
    entry: num(p, decimals), sl: num(sl, decimals),
    tp1: num(tp1, decimals), tp2: num(tp2, decimals),
    bePrice: num(dir === "LONG" ? p + Math.abs(p - sl) : p - Math.abs(p - sl), decimals)
  };
}

// ========= SCAN =========
async function scanOnce() {
  if (isTimeBlocked()) {
    console.log("🌙 [MAJORS] Midnight Window (Taiwan) — Blocking new entries");
    return;
  }
  const t0 = Date.now();
  console.log("🔍 [MAJORS] SCAN STARTED...");

  const marketContext = await getMarketBias();
  const snapshots = [];
  for (const s of SYMBOLS) {
    const res = await processSymbol(s);
    if (res) {
      logDebug(`Snapshot for ${s}: MMS_L=${res.MMS_long.toFixed(1)}, MMS_S=${res.MMS_short.toFixed(1)}`);
      snapshots.push(res);
    }
    await sleep(500);
  }

  const candidates = [];
  for (const rec of snapshots) {
    const fusion = fuseJDS(rec, marketContext);
    logDebug(`${rec.symbol} -> Fusion: ${fusion.direction}, Score: ${fusion.jds.toFixed(1)}`);

    // 🎯 Clipping @ 95 (Phase 3 optimization)
    let score = Math.min(fusion.jds, 95);
    if (score < 80) continue;

    if (shouldSkipDirection(fusion.direction)) {
      logDebug(`[MAJORS SKIP] ${rec.symbol} — Direction ${fusion.direction} skipped by bias config`);
      continue;
    }
    if (isRecentlySignaled(rec.symbol, 45 * 60_000)) continue;

    // 🎯 Advanced Filters (Orderbook/Funding)
    const adv = await applyAdvancedFilters(rec.symbol, fusion.direction, score);
    if (adv.isBlocked) {
      console.log(`[MAJORS BLOCKED] ${rec.symbol} — ${adv.reason}`);
      continue;
    }
    score += adv.scoreAdj;

    const plan = buildTradePlan(rec, fusion, 1.6);
    candidates.push({ symbol: rec.symbol, direction: fusion.direction, score, plan, rec });
  }

  console.log(`📊 [MAJORS] Scan Summary: ${snapshots.length} symbols analyzed, ${candidates.length} candidates found.`);

  const selected = candidates.sort((a, b) => b.score - a.score).slice(0, MAX_SIGNALS_PER_SCAN);
  if (!selected.length) return;

  const lines = ["⚡ *JTF MAJORS v2.0* ⚡"];
  for (const c of selected) {
    const dirEmoji = c.direction === "LONG" ? "🚀" : "🪂";
    lines.push(`\n${dirEmoji} *${c.symbol}* — ${c.direction}\n🏅 Score: ${c.score.toFixed(1)}`);
    lines.push(`💰 Prix: ${c.rec.last}\n💠 Entry: ${c.plan.entry}\n🎯 TP: ${c.plan.tp1} / ${c.plan.tp2}\n🛑 SL: ${c.plan.sl}`);
    lines.push(`🔒 SL → BE @ ${c.plan.bePrice}\n⚖️ Levier: ${SUGGESTED_LEVERAGE}`);
    registerSignal("MAJORS", c.symbol, c.direction);

    // Enregistrement pour le suivi chrono
    activeTrades.set(c.symbol, Date.now());
  }

  await sendTelegram(lines.join("\n"));
}

// ========= TIME LIMIT MONITOR =========
async function checkTimeLimits() {
  const now = Date.now();
  for (const [symbol, entryTime] of activeTrades.entries()) {
    if (now - entryTime >= TIME_LIMIT_MS) {
      // Envoi alerte
      const msg = `⚠️ *MAJORS TIME LIMIT* ⚠️

⌛ *${symbol}* a dépassé 72 heures.

👉 *CLOSE NOW* (Si pas déjà fait).
Réévalue ta position sur ce Major.`;
      await sendTelegram(msg);
      console.log(`[MAJORS TIMER] Alert sent for ${symbol}`);

      // On retire du monitoring pour ne pas spammer
      activeTrades.delete(symbol);
    }
  }
}

export async function startAutoselect() {
  console.log("🔥 JTF MAJORS v2.0 On");
  await sendTelegram("🟢 JTF MAJORS v2.0 On");
  while (true) {
    try {
      await scanOnce();
      await checkTimeLimits(); // Vérification des chronos à chaque cycle
    } catch (e) { console.log("[MAJORS ERROR]", e); }
    await sleep(SCAN_INTERVAL_MS);
  }
}
