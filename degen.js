// degen.js — JTF DEGEN v3.4
// API v2, 5m candles, filtres scalping, anti-top/bottom, registry anti-doublons

import fetch from "node-fetch";
import { DEBUG } from "./debug.js";
import { isRecentlySignaled, registerSignal } from "./signals_registry.js";

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

// 🎯 Directional bias (SHORT performs +1.18 USDT better)
const DIRECTIONAL_BIAS = process.env.DEGEN_BIAS || "SHORT";
const BIAS_STRICT_MODE = process.env.DEGEN_BIAS_STRICT === "true"; // Default: soft mode

function shouldSkipDirection(direction) {
  if (DIRECTIONAL_BIAS === "BOTH") return false;
  if (BIAS_STRICT_MODE) {
    return direction !== DIRECTIONAL_BIAS;
  }
  return false; // Soft mode: allow both directions
}
const GLOBAL_COOLDOWN_MS = 30 * 60_000;
const SYMBOL_UPDATE_INTERVAL = 60 * 60_000;

// ========= STATE =========
let DEGEN_SYMBOLS = [];
let lastSymbolUpdate = 0;
let lastGlobalTradeTime = 0;
const lastAlerts = new Map();

// ========= UTILS =========
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const num = (v, d = 4) => v == null ? null : +(+v).toFixed(d);
const clamp = (x, min, max) => Math.max(min, Math.min(max, x));

async function safeGetJson(url) {
  try {
    logDebug("safeGetJson", url);
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    if (!r.ok) {
      logDebug("HTTP ERROR", r.status, url);
      return null;
    }
    return await r.json();
  } catch (e) {
    logDebug("safeGetJson ERROR", url, e);
    return null;
  }
}

// ========= API v2 =========
async function getTicker(symbol) {
  logDebug("getTicker", symbol);
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/ticker?symbol=${symbol}&productType=usdt-futures`
  );
  return j?.data ? (Array.isArray(j.data) ? j.data[0] : j.data) : null;
}

async function getCandles(symbol, seconds, limit = 120) {
  logDebug("getCandles", symbol, seconds);
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}&granularity=${seconds}&limit=${limit}&productType=usdt-futures`
  );
  if (!j?.data?.length) return [];
  return j.data.map(c => ({
    t: +c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5]
  })).sort((a, b) => a.t - b.t);
}

async function getDepth(symbol) {
  logDebug("getDepth", symbol);
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/merge-depth?symbol=${symbol}&productType=usdt-futures&limit=20`
  );
  if (!j?.data) return null;
  const d = Array.isArray(j.data) ? j.data[0] : j.data;
  return d?.bids && d?.asks ? d : null;
}

async function getAllTickers() {
  logDebug("getAllTickers");
  const j = await safeGetJson(
    "https://api.bitget.com/api/v2/mix/market/tickers?productType=usdt-futures"
  );
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
    pv += p * k.v;
    v += k.v;
  }
  return v ? pv / v : null;
}

function wicks(c) {
  if (!c) return { upper: 0, lower: 0 };
  const top = Math.max(c.o, c.c);
  const bot = Math.min(c.o, c.c);
  return {
    upper: ((c.h - top) / c.c) * 100,
    lower: ((bot - c.l) / c.c) * 100
  };
}

// ========= DYNAMIC LIST =========
async function updateDegenList() {
  const all = await getAllTickers();
  if (!all?.length) return [];

  const list = all
    .filter(t =>
      t.symbol?.endsWith("USDT") &&
      (+t.usdtVolume > 3_000_000)
    )
    .sort((a, b) => (+b.usdtVolume) - (+a.usdtVolume))
    .slice(0, 40)
    .map(t => t.symbol);

  console.log(`🔄 [DEGEN] LIST UPDATE — ${list.length} PAIRS`);
  return list;
}

// ========= PROCESS ONE SYMBOL =========
async function processDegen(symbol) {
  logDebug("processDegen START", symbol);

  const tk = await getTicker(symbol);
  if (!tk) {
    console.log(`[DEGEN DROP] ${symbol} — no ticker data`);
    return null;
  }

  const last = tk.lastPr
    ? +tk.lastPr
    : tk.markPrice
      ? +tk.markPrice
      : tk.close
        ? +tk.close
        : tk.last
          ? +tk.last
          : null;

  if (!last || last <= 0) {
    console.log(`[DEGEN DROP] ${symbol} — invalid price: ${last}`);
    return null;
  }

  const high24 = tk.high24h != null ? +tk.high24h : null;
  const low24 = tk.low24h != null ? +tk.low24h : null;

  const volaPct = (high24 != null && low24 != null && last > 0)
    ? ((high24 - low24) / last) * 100
    : null;

  // 5m & 15m
  const [c5m, c15m] = await Promise.all([
    getCandles(symbol, 300, 120),
    getCandles(symbol, 900, 120)
  ]);

  if (!c5m?.length || c5m.length < 20) {
    console.log(`[DEGEN DROP] ${symbol} — insufficient 5m candles (${c5m?.length || 0})`);
    return null;
  }

  const rsi5 = rsi(c5m.map(x => x.c));
  const rsi15 = rsi(c15m.map(x => x.c));

  const vwp = vwap(c5m.slice(-24));
  const priceVsVwap = vwp ? ((last - vwp) / vwp) * 100 : 0;

  const lastC = c5m[c5m.length - 1];
  const wick = wicks(lastC);

  const lastVol = lastC.v;
  const avgVol = c5m.slice(-11, -1).reduce((a, b) => a + b.v, 0) / 10;
  const volRatio = avgVol > 0 ? lastVol / avgVol : 1;

  const depth = await getDepth(symbol);
  let obScore = 0, bids = 0, asks = 0;

  if (depth) {
    bids = depth.bids.slice(0, 10).reduce((a, x) => a + (+x[1]), 0);
    asks = depth.asks.slice(0, 10).reduce((a, x) => a + (+x[1]), 0);
    if (asks > 0) {
      const r = bids / asks;
      if (r > 1.25) obScore = 1;
      else if (r < 0.75) obScore = -1;
    }
  }

  // Ligne claire pour vérifier la data dans Railway
  console.log(
    `[DEGEN DATA] ${symbol} | P=${last} | Vola=${volaPct != null ? volaPct.toFixed(2) : "n/a"}% | ` +
    `volRatio=${volRatio.toFixed(2)} | ΔVWAP=${priceVsVwap.toFixed(2)} | ` +
    `RSI5=${rsi5 != null ? rsi5.toFixed(1) : "n/a"} | OB=${obScore}`
  );

  return {
    symbol,
    last,
    volaPct,
    rsi5,
    rsi15,
    priceVsVwap,
    volRatio,
    obScore,
    bidsVol: bids,
    asksVol: asks,
    wicks: wick
  };
}

// ========= ANALYZE =========
function analyzeCandidate(rec) {
  if (!rec) return null;

  // Vol spike un peu plus exigeant
  if (rec.volRatio < 2.5) return null;

  // Volatilité : éviter le mort et le full casino
  if (rec.volaPct == null || rec.volaPct < 5 || rec.volaPct > 40) return null;

  const gap = Math.abs(rec.priceVsVwap);
  // Gap vs VWAP : pas trop petit, pas trop extrême
  if (gap < 0.8 || gap > 2.8) return null;

  let dir = null;

  if (rec.priceVsVwap > 0) {
    if (rec.wicks.upper > 1.3) return null;
    if (rec.obScore < 0) return null;
    dir = "LONG";
  } else {
    if (rec.wicks.lower > 1.3) return null;
    if (rec.obScore > 0) return null;
    dir = "SHORT";
  }

  // 🎯 Apply directional bias filter (soft mode: just log, don't skip)
  if (shouldSkipDirection(dir)) {
    console.log(`[DEGEN SKIP] ${rec.symbol} — ${dir} filtered (bias: ${DIRECTIONAL_BIAS})`);
    return null;
  }

  // Anti-top / anti-bottom : éviter le sommet/bas du spike
  if (dir === "LONG" && rec.rsi5 != null && rec.rsi5 > 80 && gap > 2.3) {
    return null;
  }
  if (dir === "SHORT" && rec.rsi5 != null && rec.rsi5 < 20 && gap > 2.3) {
    return null;
  }

  // Score DEGEN (énergie du setup)
  let score = 0;

  // Vol spike
  score += rec.volRatio >= 3.5 ? 32 : rec.volRatio >= 3 ? 26 : 18;

  // Gap "sweet spot"
  if (gap >= 1 && gap <= 2.0) score += 22;
  else if (gap >= 0.8 && gap <= 2.4) score += 14;
  else score += 6;

  // RSI court terme cohérent
  if (dir === "LONG") {
    if (rec.rsi5 >= 52 && rec.rsi5 <= 72) score += 18;
    else if (rec.rsi5 >= 48 && rec.rsi5 <= 78) score += 8;
  } else {
    if (rec.rsi5 >= 28 && rec.rsi5 <= 48) score += 18;
    else if (rec.rsi5 >= 22 && rec.rsi5 <= 52) score += 8;
  }

  // Orderbook dans le bon sens
  if ((dir === "LONG" && rec.obScore === 1) || (dir === "SHORT" && rec.obScore === -1)) {
    score += 16;
  }

  // Petit malus si gap très proche de la limite haute (plus risqué)
  if (gap > 2.4) score -= 6;

  if (score < 80) return null;

  // ======================
  // Entry LIMIT, SL, TP, BE
  // ======================
  const decimals = rec.last < 1 ? 5 : 3;
  const gapPc = gap / 100;

  // Limit order : retracement moins profond que Discovery
  const retraceFactor = gap <= 1.2 ? 0.20 : 0.30;

  const entry = dir === "LONG"
    ? rec.last * (1 - gapPc * retraceFactor)
    : rec.last * (1 + gapPc * retraceFactor);

  // Risque scalping : 1.5–3.5 % max
  const riskPct = clamp(rec.volaPct / 8, 1.5, 3.5);

  let slRaw = dir === "LONG"
    ? entry * (1 - riskPct / 100)
    : entry * (1 + riskPct / 100);

  // TP plus proche : ~1.5–1.7 R
  const rr = gap <= 1.2 ? 1.5 : 1.7;

  let tpRaw = dir === "LONG"
    ? entry * (1 + (riskPct * rr) / 100)
    : entry * (1 - (riskPct * rr) / 100);

  // ✅ Sécuriser l'ordre Entry / SL / TP
  let sl = slRaw;
  let tp = tpRaw;

  if (dir === "LONG") {
    if (sl >= entry) sl = entry * (1 - Math.abs(riskPct) / 100);
    if (tp <= entry) tp = entry * (1 + Math.abs(riskPct * rr) / 100);
  } else {
    if (sl <= entry) sl = entry * (1 + Math.abs(riskPct) / 100);
    if (tp >= entry) tp = entry * (1 - Math.abs(riskPct * rr) / 100);
  }

  // 🔒 Prix où on passe le SL à BE (1R)
  const riskAbs = Math.abs(entry - sl);
  const bePrice = dir === "LONG"
    ? entry + riskAbs
    : entry - riskAbs;

  const lev = riskPct > 2.8 ? "2x" : "3x";

  return {
    symbol: rec.symbol,
    direction: dir,
    score,
    last: rec.last,
    volaPct: rec.volaPct,
    priceVsVwap: rec.priceVsVwap,
    volRatio: rec.volRatio,
    obRatio: rec.asksVol > 0 ? (rec.bidsVol / rec.asksVol).toFixed(2) : "N/A",
    levier: lev,
    entry: num(entry, decimals),
    sl: num(sl, decimals),
    tp: num(tp, decimals),
    bePrice: num(bePrice, decimals),
    rr
  };
}

// ========= TELEGRAM =========
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

function antiSpam(symbol, dir) {
  const key = `${symbol}-${dir}`;
  const now = Date.now();
  const last = lastAlerts.get(key);
  if (last && now - last < MIN_ALERT_DELAY_MS) return false;
  lastAlerts.set(key, now);
  return true;
}

// ========= MAIN LOOP =========
async function scanDegen() {
  const start = Date.now();
  console.log("🔍 [DEGEN] SCAN STARTED...");

  const now = start;

  // Mise à jour liste dynamique
  if (now - lastSymbolUpdate > SYMBOL_UPDATE_INTERVAL || !DEGEN_SYMBOLS.length) {
    DEGEN_SYMBOLS = await updateDegenList();
    lastSymbolUpdate = now;
  }

  const BATCH = 5;
  const candidates = [];

  for (let i = 0; i < DEGEN_SYMBOLS.length; i += BATCH) {
    const batch = DEGEN_SYMBOLS.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(s => processDegen(s)));

    for (const r of results) {
      const s = analyzeCandidate(r);
      if (s) candidates.push(s);
    }

    await sleep(200);
  }

  const duration = Date.now() - start;
  console.log(`[DEGEN] SCAN — ${DEGEN_SYMBOLS.length} PAIRS | ${duration} MS | ${candidates.length} SETUP`);

  if (!candidates.length) {
    return;
  }

  const best = candidates.sort((a, b) => b.score - a.score)[0];

  // 🔁 Éviter doublons avec les autres bots (Discovery, etc.)
  if (isRecentlySignaled(best.symbol)) {
    console.log(`[DEGEN SKIP] ${best.symbol} — déjà signalé récemment par un autre bot`);
    return;
  }

  if (now - lastGlobalTradeTime < GLOBAL_COOLDOWN_MS) {
    console.log(`[DEGEN] COOLDOWN — ${best.symbol}`);
    return;
  }

  if (!antiSpam(best.symbol, best.direction)) {
    console.log(`[DEGEN] ANTISPAM — ${best.symbol}`);
    return;
  }

  console.log(`[DEGEN] SIGNAL — ${best.symbol} ${best.direction} | SCORE ${best.score}`);

  const emoji = best.direction === "LONG" ? "🚀" : "🪂";

  const msg =
    `⚡ *JTF DEGEN v3.4* ⚡

${emoji} *${best.symbol}* — ${best.direction}
🏅 Score: ${best.score}/100

💰 Prix actuel: ${best.last}
💠 Entry (limit): ${best.entry}
🎯 TP: ${best.tp}
🛑 SL: ${best.sl}
🔒 SL → BE si prix atteint: ${best.bePrice}
📏 R:R ≈ ${best.rr.toFixed(2)}

📊 Vol Spike: x${num(best.volRatio, 2)}
🌡️ Vola24: ${num(best.volaPct, 2)}%
📉 ΔVWAP: ${num(best.priceVsVwap, 2)}%
⚖️ Levier suggéré: ${best.levier}

_Wait for limit — sniper mode._`;

  registerSignal("DEGEN", best.symbol, best.direction);
  await sendTelegram(msg);
  lastGlobalTradeTime = now;
}

// ========= START =========
export async function startDegen() {
  console.log("🔥 DEGEN v3.4 On (5m scalps)");
  await sendTelegram("🟢 DEGEN v3.4 On");
  while (true) {
    try { await scanDegen(); }
    catch (e) { console.log("[DEGEN ERROR]", e); }
    await sleep(SCAN_INTERVAL_MS);
  }
}
