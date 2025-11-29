// discovery.js — JTF DISCOVERY v1.6.4 (FULL API v2 FIX)
// Stable — Debug complet — Compatible Railway — BTC Trend désactivé

import fetch from "node-fetch";
import fs from "fs";

// ========= CONFIG =========
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

const SCAN_INTERVAL_MS       = 5 * 60_000;
const MIN_ALERT_DELAY_MS     = 15 * 60_000;
const GLOBAL_COOLDOWN_MS     = 30 * 60_000;
const SYMBOL_UPDATE_INTERVAL = 60 * 60_000;

// BTC "sécurité" (toujours là, mais BTC Trend = 0 pour l'instant)
const BTC_LONG_MIN  = -0.2;
const BTC_SHORT_MAX = +0.5;

// État interne
let DISCOVERY_SYMBOLS   = [];
let lastSymbolUpdate    = 0;
let lastGlobalTradeTime = 0;
const lastAlerts        = new Map();

// Fallback midcaps (format v2: symbole sans suffixe, futures via productType)
const FALLBACK_MIDCAPS = [
  "INJUSDT", "FETUSDT", "RNDRUSDT",
  "ARBUSDT", "AGIXUSDT"
];

// Ignorés (grands caps) — format v2
const IGNORE_LIST = [
  "BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT",
  "ADAUSDT","DOGEUSDT","AVAXUSDT","DOTUSDT","TRXUSDT",
  "LINKUSDT","TONUSDT","SUIUSDT","APTUSDT","NEARUSDT",
  "ARBUSDT","OPUSDT","INJUSDT","ATOMUSDT","AAVEUSDT",
  "LTCUSDT","UNIUSDT","FILUSDT","XLMUSDT","RUNEUSDT",
  "ALGOUSDT","PEPEUSDT","WIFUSDT","TIAUSDT","SEIUSDT"
];

// ========= UTILS =========
const sleep  = (ms) => new Promise(r => setTimeout(r, ms));
const clamp  = (x, min, max) => Math.max(min, Math.min(max, x));
const num    = (v, d = 4) => (v == null ? null : +(+v).toFixed(d));

async function safeGetJson(url) {
  try {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// ========= API v2 HELPERS =========

// Candles (v2) — symbol = "BTCUSDT", granularity en secondes (déjà validé sur Autoselect)
async function getCandles(symbol, seconds, limit = 200) {
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}&granularity=${seconds}&limit=${limit}&productType=usdt-futures`
  );
  if (!j?.data?.length) return [];
  return j.data
    .map(c => ({
      t: +c[0],
      o: +c[1],
      h: +c[2],
      l: +c[3],
      c: +c[4],
      v: +c[5]
    }))
    .sort((a, b) => a.t - b.t);
}

// ----------- Ticker v2 (corrigé: data[0]) -----------
async function getTicker(symbol) {
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/ticker?symbol=${symbol}&productType=usdt-futures`
  );
  if (!j?.data) return null;
  const d = Array.isArray(j.data) ? j.data[0] : j.data;
  return d || null;
}

async function getFunding(symbol) {
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/current-fund-rate?symbol=${symbol}&productType=usdt-futures`
  );
  if (!j?.data) return null;
  const d = Array.isArray(j.data) ? j.data[0] : j.data;
  return d || null;
}

async function getDepth(symbol) {
  // V2: merge-depth avec productType
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/merge-depth?symbol=${symbol}&productType=usdt-futures&limit=20`
  );
  if (!j?.data) return null;
  const d = Array.isArray(j.data) ? j.data[0] : j.data;
  return (d?.bids && d?.asks) ? d : null;
}

// All futures list (v2)
async function getAllTickers() {
  const j = await safeGetJson(
    "https://api.bitget.com/api/v2/mix/market/tickers?productType=usdt-futures"
  );
  if (!j?.data) return [];
  // j.data est déjà un array de tickers
  return j.data;
}

// ========= BTC TREND =========
// NOTE: désactivé pour l’instant (on passe btcTrend=0 dans scanDiscovery)
// On garde la fonction au cas où on veuille le réactiver plus tard.
async function getBTCTrend() {
  const c = await getCandles("BTCUSDT", 3600, 5);
  if (!c?.length) return null;
  const last = c[c.length - 1];
  return ((last.c - last.o) / last.o) * 100;
}

// ========= UPDATE DISCOVERY LIST =========
async function updateDiscoveryList() {
  const all = await getAllTickers();
  if (!all.length) {
    console.log("⚠ DiscoveryList fallback (no market data)");
    return FALLBACK_MIDCAPS;
  }

  // On garde seulement les USDT perp, suffisamment liquides, en excluant les big caps
  let list = all.filter(t =>
    t.symbol?.endsWith("USDT") &&
    !IGNORE_LIST.includes(t.symbol) &&
    (+t.usdtVolume > 5_000_000)
  );

  list.sort((a, b) => (+b.usdtVolume) - (+a.usdtVolume));

  const finalList = list.slice(0, 50).map(t => t.symbol);

  try {
    fs.writeFileSync("./config/discovery_list.json", JSON.stringify(finalList, null, 2));
  } catch {
    // non bloquant
  }

  return finalList.length ? finalList : FALLBACK_MIDCAPS;
}

// ========= INDICATORS =========
function rsi(values, p = 14) {
  if (!values || values.length < p + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) g += d; else l -= d;
  }
  g /= p;
  l = (l / p) || 1e-9;
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

// ========= PROCESS SYMBOL =========
async function processDiscovery(symbol) {
  const tk = await getTicker(symbol);

  if (!tk) {
    console.log(`[DISCOVERY DEBUG] ${symbol}: ❌ Ticker NULL`);
    return null;
  }

  // Bitget v2: lastPr, high24h, low24h, usdtVolume, change24h, etc.
  const last =
    (tk.lastPr      != null ? +tk.lastPr      : NaN) ||
    (tk.markPrice   != null ? +tk.markPrice   : NaN) ||
    (tk.close       != null ? +tk.close       : NaN) ||
    (tk.last        != null ? +tk.last        : NaN);

  if (!last || Number.isNaN(last)) {
    console.log(`[DISCOVERY DEBUG] ${symbol}: ❌ last=NULL`);
    return null;
  }

  const high24  = tk.high24h != null ? +tk.high24h : null;
  const low24   = tk.low24h  != null ? +tk.low24h  : null;
  const volaPct = (high24 != null && low24 != null)
    ? ((high24 - low24) / last) * 100
    : null;

  const [c5m, c15m] = await Promise.all([
    getCandles(symbol, 300, 100),
    getCandles(symbol, 900, 100)
  ]);

  if (!c5m?.length) {
    console.log(`[DISCOVERY DEBUG] ${symbol}: ❌ Missing candles`);
    return null;
  }

  const rsi5  = rsi(c5m.map(x => x.c));
  const rsi15 = rsi(c15m.map(x => x.c));
  const vwap5 = vwap(c5m.slice(-24));
  const priceVsVwap = vwap5 ? ((last - vwap5) / vwap5) * 100 : 0;

  const lastCandle = c5m[c5m.length - 1];
  const wick       = wicks(lastCandle);
  const lastVol    = lastCandle.v;
  const avgVol     = c5m.slice(-11, -1).reduce((a, b) => a + b.v, 0) / 10;
  const volRatio   = avgVol > 0 ? lastVol / avgVol : 1;

  // v2: "change24h" est la variation de prix sur 24h (pas forcément en %)
  // On continue à l’utiliser comme un indicateur de momentum (approx).
  const change24 = tk.change24h != null ? +tk.change24h : 0;

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

  console.log(
    `[DISCOVERY DEBUG] ${symbol}: last=${last} | vola=${num(volaPct)} | rsi5=${num(rsi5)} | vwapGap=${num(priceVsVwap)} | volRatio=${num(volRatio)}`
  );

  return {
    symbol,
    last,
    volaPct,
    rsi5,
    rsi15,
    priceVsVwap,
    volRatio,
    change24,
    obScore,
    bidsVol: bids,
    asksVol: asks,
    wicks: wick
  };
}

// ========= ANALYZE =========
function analyze(rec, btcTrend) {
  if (!rec || btcTrend == null) return null;

  // Filtres de base
  if (rec.volRatio < 2) return null;
  if (rec.volaPct == null || rec.volaPct < 3 || rec.volaPct > 22) return null;

  const gap = Math.abs(rec.priceVsVwap);
  if (gap < 0.6 || gap > 3.2) return null;

  let dir = null;

  if (rec.priceVsVwap > 0) {
    // LONG
    if (btcTrend < BTC_LONG_MIN) return null;       // Avec btcTrend=0, ce filtre est neutre
    if (rec.wicks.upper > 1.2) return null;
    if (rec.obScore < 0) return null;
    dir = "LONG";
  } else {
    // SHORT
    if (btcTrend > BTC_SHORT_MAX) return null;      // Avec btcTrend=0, ce filtre est neutre
    if (rec.wicks.lower > 1.2) return null;
    if (rec.obScore > 0) return null;
    dir = "SHORT";
  }

  let score = 0;
  score += rec.volRatio >= 3 ? 30 : 15;
  score += (gap >= 1 && gap <= 2.2) ? 20 : 10;
  score += (dir === "LONG"
    ? (rec.rsi5 >= 55 && rec.rsi5 <= 75 ? 15 : 5)
    : (rec.rsi5 >= 25 && rec.rsi5 <= 45 ? 15 : 5)
  );
  if ((dir === "LONG" && rec.obScore === 1) || (dir === "SHORT" && rec.obScore === -1)) score += 15;
  if ((dir === "LONG" && rec.change24 > 0) || (dir === "SHORT" && rec.change24 < 0))   score += 10;
  if ((dir === "LONG" && btcTrend >= 0) || (dir === "SHORT" && btcTrend <= 0))          score += 10;

  if (score < 78) return null;

  const decimals = rec.last < 1 ? 5 : 3;

  const pullback = clamp(gap / 4, 0.4, 1.0);
  const entry = dir === "LONG"
    ? rec.last * (1 - pullback / 100)
    : rec.last * (1 + pullback / 100);

  const riskPct = clamp((rec.volaPct / 5) * 2, 2, 5);
  const sl = dir === "LONG"
    ? rec.last * (1 - riskPct / 100)
    : rec.last * (1 + riskPct / 100);

  const tp = dir === "LONG"
    ? rec.last * (1 + (riskPct * 2) / 100)
    : rec.last * (1 - (riskPct * 2) / 100);

  const lev = riskPct > 4 ? "2x" : "3x";

  return {
    symbol: rec.symbol,
    direction: dir,
    score,
    price: rec.last,
    limitEntry: num(entry, decimals),
    sl: num(sl, decimals),
    tp: num(tp, decimals),
    riskPct: num(riskPct, 2),
    obRatio: rec.asksVol > 0 ? (rec.bidsVol / rec.asksVol).toFixed(2) : "N/A",
    volRatio: num(rec.volRatio, 1),
    vola: num(rec.volaPct, 1),
    levier: lev,
    reason:
      rec.volRatio >= 3 ? "Volume Spike" :
      rec.obScore !== 0 ? "Orderbook Pressure" :
      "Momentum Propre"
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
  } catch (e) {
    console.error("Telegram error:", e);
  }
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
async function scanDiscovery() {
  const now = Date.now();

  // BTC Trend désactivé pour l’instant : on force à 0
  const btcTrend = 0;
  console.log(`🔥 Discovery v1.6.4 — BTC Trend DISABLED (${btcTrend.toFixed(2)}%)`);

  if (now - lastSymbolUpdate > SYMBOL_UPDATE_INTERVAL || !DISCOVERY_SYMBOLS.length) {
    DISCOVERY_SYMBOLS = await updateDiscoveryList();
    lastSymbolUpdate = now;
    console.log(`🔄 Liste mise à jour (${DISCOVERY_SYMBOLS.length} paires).`);
  }

  const BATCH   = 5;
  const signals = [];

  for (let i = 0; i < DISCOVERY_SYMBOLS.length; i += BATCH) {
    const batch = DISCOVERY_SYMBOLS.slice(i, i + BATCH);
    const res   = await Promise.all(batch.map(s => processDiscovery(s)));
    for (const r of res) {
      const s = analyze(r, btcTrend);
      if (s) signals.push(s);
    }
    await sleep(250);
  }

  if (!signals.length) {
    console.log("ℹ Aucun signal Discovery.");
    return;
  }

  const best = signals.sort((a, b) => b.score - a.score)[0];

  if (now - lastGlobalTradeTime < GLOBAL_COOLDOWN_MS) {
    console.log(`⏳ Cooldown — ${best.symbol} ignoré`);
    return;
  }

  if (!antiSpam(best.symbol, best.direction)) {
    console.log(`⏳ Anti-spam — ${best.symbol} ignoré`);
    return;
  }

  const emoji = best.direction === "LONG" ? "🚀" : "🪂";

  const msg =
`⚡ *JTF DISCOVERY v1.6.4* ⚡

${emoji} *${best.symbol}* — ${best.direction}
🏅 Score: ${best.score}

💠 Entry: ${best.limitEntry}
🎯 TP: ${best.tp}
🛑 SL: ${best.sl}

📊 Vol: x${best.volRatio}
🌡️ Vola: ${best.vola}%
📘 OB: ${best.obRatio}
⚖️ Levier: ${best.levier}

_Momentum Midcaps — API v2 FULL FIX_`;

  await sendTelegram(msg);
  lastGlobalTradeTime = now;

  console.log(`✅ Signal envoyé : ${best.symbol}`);
}

// ========= START =========
async function main() {
  console.log("🔥 Discovery v1.6.4 — démarré.");
  await sendTelegram("🟢 Discovery v1.6.4 lancé (API v2 FULL FIX, BTC Trend OFF).");
  while (true) {
    try {
      await scanDiscovery();
    } catch (e) {
      console.error("DISCOVERY CRASH:", e);
    }
    await sleep(SCAN_INTERVAL_MS);
  }
}

export const startDiscovery = main;