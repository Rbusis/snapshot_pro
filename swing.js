// swing.js — JTF SWING BOT v1.0
// Swing Trading basé sur cycles 1h-4h
// Très peu de signaux. Très forte robustesse.

import fetch from "node-fetch";

// ========= CONFIG =========

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Scan toutes les 30 minutes EXACT
const SCAN_INTERVAL_MS = 30 * 60_000;

// Délai anti-spam entre 2 signaux identiques
const MIN_ALERT_DELAY_MS = 30 * 60_000;

// TOP SWING — Liste qualité + liquidité
const SYMBOLS = [
  "BTCUSDT_UMCBL", "ETHUSDT_UMCBL", "BNBUSDT_UMCBL", "SOLUSDT_UMCBL", "XRPUSDT_UMCBL",
  "AVAXUSDT_UMCBL", "LINKUSDT_UMCBL", "DOTUSDT_UMCBL", "TRXUSDT_UMCBL", "ADAUSDT_UMCBL",
  "NEARUSDT_UMCBL", "ATOMUSDT_UMCBL", "OPUSDT_UMCBL", "INJUSDT_UMCBL", "UNIUSDT_UMCBL",
  "LTCUSDT_UMCBL", "TIAUSDT_UMCBL", "SEIUSDT_UMCBL"
];

// Seuils JDS-SWING
const JDS_THRESHOLD_READY = 75;
const JDS_THRESHOLD_PRIME = 85;

// Conditions de marché à éviter
const MAX_ATR_1H_PCT = 1.8;
const MAX_VOLA_24 = 25;
const MAX_VWAP_4H_DEVIATION = 4;

// ========= MÉMOIRE =========
const prevOI = new Map();
const lastAlerts = new Map();

// ========= UTILS =========
const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const num = (v, d = 4) => v == null ? null : +(+v).toFixed(d);
const clamp = (x, min, max) => Math.max(min, Math.min(max, x));
const baseSymbol = s => s.replace("_UMCBL", "");

async function safeGetJson(url) {
  try {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// ========= API BITGET =========

async function getCandles(symbol, seconds, limit = 400) {
  const base = baseSymbol(symbol);
  let j = await safeGetJson(`https://api.bitget.com/api/v2/mix/market/candles?symbol=${base}&granularity=${seconds}&productType=usdt-futures&limit=${limit}`);
  if (j?.data?.length) {
    return j.data.map(c => ({ t: +c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5] })).sort((a, b) => a.t - b.t);
  }
  return [];
}

async function getTicker(symbol) {
  const j = await safeGetJson(`https://api.bitget.com/api/mix/v1/market/ticker?symbol=${symbol}`);
  return j?.data ?? null;
}

async function getDepth(symbol) {
  const j = await safeGetJson(`https://api.bitget.com/api/mix/v1/market/depth?symbol=${symbol}&limit=5`);
  if (j?.data?.bids && j.data.asks) {
    return { bids: j.data.bids.map(x => [+x[0], +x[1]]), asks: j.data.asks.map(x => [+x[0], +x[1]]) };
  }
  return { bids: [], asks: [] };
}

async function getOI(symbol) {
  const j = await safeGetJson(`https://api.bitget.com/api/mix/v1/market/open-interest?symbol=${symbol}`);
  return j?.data ?? null;
}

// ========= INDICATEURS =========

function percent(a, b) { return b ? (a / b - 1) * 100 : null; }

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
  for (let i = 1; i <= p; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) g += d; else l -= d; }
  g /= p; l = (l / p) || 1e-9;
  let rs = g / l; let val = 100 - 100 / (1 + rs);
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]; const G = Math.max(d, 0), L = Math.max(-d, 0);
    g = (g * (p - 1) + G) / p; l = ((l * (p - 1) + L) / p) || 1e-9; rs = g / l; val = 100 - 100 / (1 + rs);
  }
  return val;
}

function vwap(c) {
  let pv = 0, v = 0; for (const x of c) { const p = (x.h + x.l + x.c) / 3; pv += p * x.v; v += x.v; }
  return v ? pv / v : null;
}

function positionInDay(last, low, high) {
  const r = high - low; if (r <= 0 || last == null) return null; return ((last - low) / r) * 100;
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

// ========= JDS-SWING CALCULATION =========

function calculateJDSSwing(rec, c15m, c1h, c4h) {
  let score = 0;

  // MODULE 1: Macro-Trend 1h/4h (0-20)
  const trend1h = trendStrength(c1h, 48);
  const trend4h = trendStrength(c4h, 24);
  const trendScore = clamp((Math.abs(trend1h) + Math.abs(trend4h)) / 10, 0, 20);
  score += trendScore;

  // MODULE 2: VWAP-Bias 1h/4h (0-20)
  const vwap1h = vwap(c1h.slice(-48));
  const vwap4h = vwap(c4h.slice(-48));
  const last = rec.last;
  let vwapScore = 0;
  if (vwap1h && vwap4h && last) {
    const deltaVWAP1h = Math.abs(percent(last, vwap1h));
    const deltaVWAP4h = Math.abs(percent(last, vwap4h));
    if (deltaVWAP1h < 2 && deltaVWAP4h < 2) vwapScore = 20;
    else if (deltaVWAP1h < 4 && deltaVWAP4h < 4) vwapScore = 12;
    else vwapScore = 5;
  }
  score += vwapScore;

  // MODULE 3: Momentum 15m/1h/4h (0-20)
  const closes15m = c15m.map(x => x.c);
  const closes1h = c1h.map(x => x.c);
  const closes4h = c4h.map(x => x.c);
  const rsi15 = rsi(closes15m, 14);
  const rsi1h = rsi(closes1h, 14);
  const rsi4h = rsi(closes4h, 14);

  let momentumScore = 0;
  if (rsi15 && rsi1h && rsi4h) {
    const rsiAvg = (rsi15 + rsi1h + rsi4h) / 3;
    if (rsiAvg > 40 && rsiAvg < 60) momentumScore = 20;
    else if (rsiAvg > 35 && rsiAvg < 65) momentumScore = 12;
    else momentumScore = 5;
  }
  score += momentumScore;

  // MODULE 4: Volatilité saine (ATR + vola24) (0-15)
  const atr1h = atr(c1h, 14);
  const atr1hPct = atr1h && last ? (atr1h / last) * 100 : null;
  const vola24 = rec.volaPct;

  let volaScore = 0;
  if (atr1hPct && vola24) {
    if (atr1hPct < MAX_ATR_1H_PCT && vola24 < MAX_VOLA_24 && vola24 > 2) volaScore = 15;
    else if (atr1hPct < 2.5 && vola24 < 30) volaScore = 8;
    else volaScore = 2;
  }
  score += volaScore;

  // MODULE 5: Structure journalière (PosDay + Tend24) (0-15)
  const posDay = rec.posDay;
  const tend24 = rec.tend24;

  let structureScore = 0;
  if (posDay != null && tend24 != null) {
    if ((posDay > 30 && posDay < 70) || Math.abs(tend24) > 20) structureScore = 15;
    else if (Math.abs(tend24) > 10) structureScore = 8;
    else structureScore = 3;
  }
  score += structureScore;

  // MODULE 6: Orderbook + Construction OI (0-10)
  const deltaOI = rec.deltaOIpct;
  const obImbalance = rec.obImbalance;

  let oiScore = 0;
  if (deltaOI != null) {
    if (Math.abs(deltaOI) > 0.5 && Math.abs(deltaOI) < 5) oiScore = 10;
    else if (Math.abs(deltaOI) < 8) oiScore = 5;
    else oiScore = 2;
  }
  score += oiScore;

  return clamp(score, 0, 100);
}

// ========= ORDERBOOK ANALYSIS =========

function analyzeOrderbook(depth) {
  if (!depth.bids.length || !depth.asks.length) return { imbalance: 0, pressure: "neutral" };

  const bidVolume = depth.bids.reduce((sum, [, vol]) => sum + vol, 0);
  const askVolume = depth.asks.reduce((sum, [, vol]) => sum + vol, 0);
  const total = bidVolume + askVolume;

  if (total === 0) return { imbalance: 0, pressure: "neutral" };

  const imbalance = ((bidVolume - askVolume) / total) * 100;
  let pressure = "neutral";
  if (imbalance > 15) pressure = "bullish";
  else if (imbalance < -15) pressure = "bearish";

  return { imbalance: num(imbalance, 2), pressure };
}

// ========= SNAPSHOT PAR PAIRE =========

async function processSymbol(symbol) {
  const [tk, oi] = await Promise.all([getTicker(symbol), getOI(symbol)]);
  if (!tk) return null;

  const last = +tk.last;
  const high24 = +tk.high24h;
  const low24 = +tk.low24h;
  const vol24 = +tk.baseVolume;

  const openInterest = oi ? +oi.amount : null;
  const prev = prevOI.get(symbol) ?? null;
  const deltaOI = (prev != null && openInterest != null && prev !== 0) ? ((openInterest - prev) / prev) * 100 : null;
  prevOI.set(symbol, openInterest ?? prev);

  const [c15m, c1h, c4h] = await Promise.all([
    getCandles(symbol, 900, 400),
    getCandles(symbol, 3600, 400),
    getCandles(symbol, 14400, 400)
  ]);

  const depth = await getDepth(symbol);
  const obAnalysis = analyzeOrderbook(depth);

  const volaPct = (last && high24 && low24) ? ((high24 - low24) / last) * 100 : null;
  const tend24 = (high24 > low24 && last) ? (((last - low24) / (high24 - low24)) * 200 - 100) : null;
  const posDay = positionInDay(last, low24, high24);

  const vwap1h = vwap(c1h.slice(-48));
  const vwap4h = vwap(c4h.slice(-48));
  const deltaVWAP1h = (vwap1h && last) ? percent(last, vwap1h) : null;
  const deltaVWAP4h = (vwap4h && last) ? percent(last, vwap4h) : null;

  const atr1h = atr(c1h, 14);
  const atr4h = atr(c4h, 14);
  const atr1hPct = atr1h && last ? (atr1h / last) * 100 : null;
  const atr4hPct = atr4h && last ? (atr4h / last) * 100 : null;

  const closes15m = c15m.map(x => x.c);
  const closes1h = c1h.map(x => x.c);
  const closes4h = c4h.map(x => x.c);

  const rsi15 = rsi(closes15m, 14);
  const rsi1h = rsi(closes1h, 14);
  const rsi4h = rsi(closes4h, 14);

  return {
    symbol, last, high24, low24, vol24, volaPct, tend24, posDay,
    deltaVWAP1h: deltaVWAP1h != null ? num(deltaVWAP1h, 4) : null,
    deltaVWAP4h: deltaVWAP4h != null ? num(deltaVWAP4h, 4) : null,
    deltaOIpct: deltaOI != null ? num(deltaOI, 3) : null,
    atr1hPct: atr1hPct != null ? num(atr1hPct, 4) : null,
    atr4hPct: atr4hPct != null ? num(atr4hPct, 4) : null,
    obImbalance: obAnalysis.imbalance,
    obPressure: obAnalysis.pressure,
    rsi: { "15m": num(rsi15, 2), "1h": num(rsi1h, 2), "4h": num(rsi4h, 2) },
    c15m, c1h, c4h
  };
}

// ========= DÉTECTION DIRECTION =========

function detectDirection(rec, jdsSwing) {
  const vwap1h = rec.deltaVWAP1h;
  const vwap4h = rec.deltaVWAP4h;
  const rsi1h = rec.rsi["1h"];
  const rsi4h = rec.rsi["4h"];
  const obPressure = rec.obPressure;
  const deltaOI = rec.deltaOIpct;

  let longScore = 0;
  let shortScore = 0;

  // VWAP bias
  if (vwap1h != null && vwap1h < 0) longScore += 2;
  if (vwap1h != null && vwap1h > 0) shortScore += 2;
  if (vwap4h != null && vwap4h < 0) longScore += 2;
  if (vwap4h != null && vwap4h > 0) shortScore += 2;

  // RSI bias
  if (rsi1h != null && rsi1h < 50) longScore += 1;
  if (rsi1h != null && rsi1h > 50) shortScore += 1;
  if (rsi4h != null && rsi4h < 50) longScore += 1;
  if (rsi4h != null && rsi4h > 50) shortScore += 1;

  // OB pressure
  if (obPressure === "bullish") longScore += 2;
  if (obPressure === "bearish") shortScore += 2;

  // OI construction
  if (deltaOI != null && deltaOI > 0.5) longScore += 1;
  if (deltaOI != null && deltaOI < -0.5) shortScore += 1;

  const direction = longScore > shortScore ? "LONG" : "SHORT";
  return direction;
}

// ========= CONDITIONS MARCHÉ =========

function shouldAvoidMarket(rec) {
  const atr1h = rec.atr1hPct;
  const vola24 = rec.volaPct;
  const vwap4h = rec.deltaVWAP4h;
  const deltaOI = rec.deltaOIpct;

  // ATR 1h trop violent
  if (atr1h != null && atr1h > MAX_ATR_1H_PCT) return "ATR 1h trop élevé";

  // Vola24 excessive
  if (vola24 != null && vola24 > MAX_VOLA_24) return "Volatilité 24h excessive";

  // Écart VWAP 4h trop large
  if (vwap4h != null && Math.abs(vwap4h) > MAX_VWAP_4H_DEVIATION) return "Écart VWAP 4h trop large";

  // OB contradictoire (fort déséquilibre inverse)
  if (rec.obPressure === "bullish" && deltaOI != null && deltaOI < -3) return "OB contradictoire";
  if (rec.obPressure === "bearish" && deltaOI != null && deltaOI > 3) return "OB contradictoire";

  return null;
}

// ========= CALCUL ENTRÉE/SL/TP =========

function calculateTradePlan(rec, direction, jdsSwing) {
  const last = rec.last;
  const atr1h = rec.atr1hPct ? (rec.atr1hPct / 100) * last : last * 0.01;
  const atr4h = rec.atr4hPct ? (rec.atr4hPct / 100) * last : last * 0.015;

  let entry, sl, tp1, tp2;

  if (direction === "LONG") {
    entry = last - (0.7 * atr1h);
    sl = entry - (1.2 * atr4h);
    const slDist = entry - sl;
    tp1 = entry + (1.0 * slDist);
    tp2 = entry + (2.0 * slDist);
  } else {
    entry = last + (0.7 * atr1h);
    sl = entry + (1.2 * atr4h);
    const slDist = sl - entry;
    tp1 = entry - (1.0 * slDist);
    tp2 = entry - (2.0 * slDist);
  }

  const decimals = last < 0.0001 ? 7 : last < 0.01 ? 6 : last < 0.1 ? 5 : 4;

  return {
    entry: num(entry, decimals),
    sl: num(sl, decimals),
    tp1: num(tp1, decimals),
    tp2: num(tp2, decimals)
  };
}

// ========= LEVIER CONSEILLÉ =========

function getRecommendedLeverage(vola24) {
  if (vola24 == null) return "2x";
  if (vola24 < 5) return "3x";
  if (vola24 <= 10) return "2x";
  return "1x";
}

// ========= DURÉE ESTIMÉE =========

function estimateDuration(jdsSwing, rec) {
  const trend1h = trendStrength(rec.c1h, 48);
  const trend4h = trendStrength(rec.c4h, 24);
  const avgTrend = (Math.abs(trend1h) + Math.abs(trend4h)) / 2;

  if (jdsSwing >= 90 && avgTrend > 40) return "3h-12h";
  if (jdsSwing >= 85) return "6h-24h";
  if (jdsSwing >= 75) return "12h-36h";
  return "24h-48h";
}

// ========= MOVE TO BE =========

function getMoveToBeCondition(direction) {
  return `TP1 atteint OU +1×ATR(1h) OU divergence RSI(15m) contre position`;
}

// ========= ANTI-SPAM =========

function shouldSendAlert(symbol, direction, state) {
  const key = `${symbol}-${direction}-${state}`;
  const now = Date.now();
  const last = lastAlerts.get(key);

  if (!last) {
    lastAlerts.set(key, now);
    return true;
  }

  if (now - last < MIN_ALERT_DELAY_MS) return false;

  lastAlerts.set(key, now);
  return true;
}

// ========= TELEGRAM =========

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" })
    });
  } catch (e) { }
}

// ========= SCAN COMPLET =========

async function scanOnce() {
  console.log("🔍 JTF SWING BOT v1.0 — Scan en cours…");

  const snapshots = [];
  const BATCH_SIZE = 5;

  for (let i = 0; i < SYMBOLS.length; i += BATCH_SIZE) {
    const batch = SYMBOLS.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(symbol => processSymbol(symbol).catch(e => null)));
    for (const res of results) if (res) snapshots.push(res);
    if (i + BATCH_SIZE < SYMBOLS.length) await sleep(1000);
  }

  const readySetups = [];
  const primeSetups = [];

  for (const rec of snapshots) {
    const jdsSwing = calculateJDSSwing(rec, rec.c15m, rec.c1h, rec.c4h);

    // Ignorer CHOP/WATCH
    if (jdsSwing < 60) continue;

    const avoidReason = shouldAvoidMarket(rec);
    if (avoidReason) continue;

    const direction = detectDirection(rec, jdsSwing);

    // Filtre OI purge/construction contradictoire
    if (direction === "LONG" && rec.deltaOIpct != null && rec.deltaOIpct < -2) continue;
    if (direction === "SHORT" && rec.deltaOIpct != null && rec.deltaOIpct > 2) continue;

    const plan = calculateTradePlan(rec, direction, jdsSwing);
    const leverage = getRecommendedLeverage(rec.volaPct);
    const duration = estimateDuration(jdsSwing, rec);
    const moveToBe = getMoveToBeCondition(direction);

    const setup = {
      symbol: rec.symbol,
      direction,
      jdsSwing: num(jdsSwing, 1),
      entry: plan.entry,
      sl: plan.sl,
      tp1: plan.tp1,
      tp2: plan.tp2,
      leverage,
      duration,
      moveToBe,
      momentum: `RSI 15m:${rec.rsi["15m"]} | 1h:${rec.rsi["1h"]} | 4h:${rec.rsi["4h"]}`,
      vwapContext: `VWAP 1h:${rec.deltaVWAP1h}% | 4h:${rec.deltaVWAP4h}%`,
      rec
    };

    if (jdsSwing >= JDS_THRESHOLD_PRIME) {
      primeSetups.push(setup);
    } else if (jdsSwing >= JDS_THRESHOLD_READY) {
      readySetups.push(setup);
    }
  }

  // Construction du message
  let message = "";

  if (primeSetups.length === 0 && readySetups.length === 0) {
    message = "📊 *JTF SWING — RAS*";
    // await sendTelegram(message); // Optionnel si tu veux éviter le spam "RAS"
    console.log("✅ Aucun setup détecté.");
    return;
  }

  // Priorité aux PRIME
  const setupsToSend = primeSetups.length > 0 ? primeSetups : readySetups.slice(0, 3);
  const state = primeSetups.length > 0 ? "PRIME" : "READY";

  message = `🎯 *JTF SWING — ${state} DÉTECTÉ*\n\n`;

  for (let i = 0; i < setupsToSend.length; i++) {
    const s = setupsToSend[i];

    if (!shouldSendAlert(s.symbol, s.direction, state)) continue;

    const dirEmoji = s.direction === "LONG" ? "📈" : "📉";

    message += `*${i + 1}) ${baseSymbol(s.symbol)}*\n`;
    message += `${dirEmoji} *${s.direction}*\n`;
    message += `💠 *Entry (LIMIT):* ${s.entry}\n`;
    message += `🛡️ *SL:* ${s.sl}\n`;
    message += `🎯 *TP1:* ${s.tp1} | *TP2:* ${s.tp2}\n`;
    message += `📏 *Levier:* ${s.leverage}\n`;
    message += `⏱️ *Durée estimée:* ${s.duration}\n`;
    message += `🔄 *Move to BE:* ${s.moveToBe}\n`;
    message += `🔥 *JDS-SWING:* ${s.jdsSwing}\n`;
    message += `📊 *Momentum:* ${s.momentum}\n`;
    message += `📍 *VWAP:* ${s.vwapContext}\n\n`;
  }

  if (message.includes("Entry")) {
    await sendTelegram(message);
  }
  console.log(`✅ ${state} envoyé (${setupsToSend.length} setup(s)).`);
}

async function main() {
  console.log("🚀 JTF SWING BOT v1.0 — Démarré.");
  await sendTelegram("🟢 *JTF SWING BOT v1.0* démarré.\nScan toutes les 30min. Très peu de signaux. Très forte robustesse.");

  while (true) {
    try {
      await scanOnce();
    } catch (e) {
      console.error("❌ Erreur scan:", e.message);
    }
    await sleep(SCAN_INTERVAL_MS);
  }
}

export const startSwing = main;
