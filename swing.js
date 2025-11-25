// swing.js — JTF SWING BOT v1.1
// Swing Trading basé sur cycles 1h–4h (qualité uniquement)
// - Scan toutes les 30 min
// - Très peu de signaux (READY / PRIME uniquement)
// - Entrées LIMIT dynamiques selon JDS-SWING
// - SL/TP via ATR 1h/4h (adapté à la volatilité)
// - Direction via VWAP, RSI, OB, OI
// - R:R et durée estimée dans le message Telegram

import fetch from "node-fetch";

// ========= CONFIG =========

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

// Scan toutes les 30 minutes EXACT
const SCAN_INTERVAL_MS   = 30 * 60_000;

// Délai anti-spam entre 2 signaux identiques (par symbole/direction/state)
const MIN_ALERT_DELAY_MS = 30 * 60_000;

// TOP SWING — Liste qualité + liquidité (tu pourras ajuster si besoin)
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
const MAX_ATR_1H_PCT         = 1.8;
const MAX_VOLA_24            = 25;
const MAX_VWAP_4H_DEVIATION  = 4;

// ========= MÉMOIRE =========
const prevOI    = new Map();
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

// ========= API BITGET =========

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

async function getTicker(symbol) {
  const j = await safeGetJson(`https://api.bitget.com/api/mix/v1/market/ticker?symbol=${symbol}`);
  return j?.data ?? null;
}

async function getDepth(symbol) {
  // OB plus profond pour un signal swing (moins de bruit MM)
  const j = await safeGetJson(`https://api.bitget.com/api/mix/v1/market/depth?symbol=${symbol}&limit=20`);
  if (j?.data?.bids && j.data.asks) {
    return {
      bids: j.data.bids.map(x => [+x[0], +x[1]]),
      asks: j.data.asks.map(x => [+x[0], +x[1]])
    };
  }
  return { bids: [], asks: [] };
}

async function getOI(symbol) {
  const j = await safeGetJson(`https://api.bitget.com/api/mix/v1/market/open-interest?symbol=${symbol}`);
  return j?.data ?? null;
}

// ========= INDICATEURS =========

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
  let e = closes[closes.length - period]; // seed
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

// ========= ORDERBOOK ANALYSIS =========

function analyzeOrderbook(depth) {
  if (!depth.bids.length || !depth.asks.length) {
    return { imbalance: 0, pressure: "neutral" };
  }

  const bidVolume = depth.bids.reduce((sum, [, vol]) => sum + vol, 0);
  const askVolume = depth.asks.reduce((sum, [, vol]) => sum + vol, 0);
  const total     = bidVolume + askVolume;

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

  const last   = +tk.last;
  const high24 = +tk.high24h;
  const low24  = +tk.low24h;
  const vol24  = +tk.baseVolume;

  const openInterest = oi ? +oi.amount : null;
  const prev         = prevOI.get(symbol) ?? null;
  const deltaOI      = (prev != null && openInterest != null && prev !== 0)
    ? ((openInterest - prev) / prev) * 100
    : null;
  prevOI.set(symbol, openInterest ?? prev);

  const [c15m, c1h, c4h] = await Promise.all([
    getCandles(symbol,  900, 400),
    getCandles(symbol, 3600, 400),
    getCandles(symbol,14400, 400)
  ]);

  if (!c1h.length || !c4h.length || !c15m.length) return null;

  const depth      = await getDepth(symbol);
  const obAnalysis = analyzeOrderbook(depth);

  const volaPct = (last && high24 && low24) ? ((high24 - low24) / last) * 100 : null;
  const tend24  = (high24 > low24 && last) ? (((last - low24) / (high24 - low24)) * 200 - 100) : null;
  const posDay  = positionInDay(last, low24, high24);

  const vwap1h = vwap(c1h.slice(-48));
  const vwap4h = vwap(c4h.slice(-48));
  const deltaVWAP1h = (vwap1h && last) ? percent(last, vwap1h) : null;
  const deltaVWAP4h = (vwap4h && last) ? percent(last, vwap4h) : null;

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
    rsi: { "15m": num(rsi15, 2), "1h": num(rsi1h, 2), "4h": num(rsi4h, 2) },
    c15m, c1h, c4h
  };
}

// ========= JDS-SWING (VERSION OPTIMISÉE) =========
// Intègre : ΔP multi-TF, EMA20/50, VWAP directionnel, RSI structure, ATR/Vola, Tend24/PosDay, OB/OI

function calculateJDSSwing(rec) {
  const { c15m, c1h, c4h } = rec;
  const closes15m = c15m.map(x => x.c);
  const closes1h  = c1h.map(x => x.c);
  const closes4h  = c4h.map(x => x.c);
  const last      = rec.last;

  let score = 0;

  // -------- MODULE 1 : Trend / Structure (0-25) --------
  let m1 = 0;

  // ΔP 1h et 4h (lookback 6 bougies -> ~6h et ~24h)
  let dP1h = null, dP4h = null;
  if (closes1h.length > 6) {
    dP1h = percent(closes1h[closes1h.length - 1], closes1h[closes1h.length - 7]);
  }
  if (closes4h.length > 6) {
    dP4h = percent(closes4h[closes4h.length - 1], closes4h[closes4h.length - 7]);
  }

  if (dP1h != null && dP4h != null) {
    const sameSign = (dP1h > 0 && dP4h > 0) || (dP1h < 0 && dP4h < 0);
    if (sameSign) m1 += 12;
    else if (Math.sign(dP1h) === Math.sign(dP4h)) m1 += 6;
  }

  // EMA20 / EMA50 1h
  const ema20_1h = ema(closes1h, 20);
  const ema50_1h = ema(closes1h, 50);
  let ema20_prev = null;
  if (closes1h.length > 21) {
    const prevCloses = closes1h.slice(0, -1);
    ema20_prev = ema(prevCloses, 20);
  }

  if (ema20_1h && ema50_1h) {
    const emaSlope = ema20_prev != null ? ema20_1h - ema20_prev : 0;
    const above = last > ema20_1h && ema20_1h > ema50_1h;
    if (above && emaSlope > 0) m1 += 8;
    else if (above) m1 += 5;
    else if (last > ema20_1h || ema20_1h > ema50_1h) m1 += 3;
  }

  // Alignement VWAP directionnel (signes 1h/4h)
  const v1 = rec.deltaVWAP1h;
  const v4 = rec.deltaVWAP4h;
  if (v1 != null && v4 != null) {
    if ((v1 > 0 && v4 > 0) || (v1 < 0 && v4 < 0)) m1 += 5;
  }

  m1 = clamp(m1, 0, 25);
  score += m1;

  // -------- MODULE 2 : VWAP Distance / Mean Reversion (0-20) --------
  let m2 = 0;
  const d1 = v1 != null ? Math.abs(v1) : null;
  const d4 = v4 != null ? Math.abs(v4) : null;

  if (d1 != null && d4 != null) {
    if (d1 >= 0.3 && d1 <= 2.0 && d4 >= 0.5 && d4 <= 3.0) m2 = 20;
    else if (d1 <= 4.0 && d4 <= 5.0) m2 = 12;
    else m2 = 5;
  }
  score += m2;

  // -------- MODULE 3 : RSI Structure (0-20) --------
  let m3 = 0;
  const r15 = rec.rsi["15m"];
  const r1  = rec.rsi["1h"];
  const r4  = rec.rsi["4h"];

  if (r15 != null && r1 != null && r4 != null) {
    const rsiAvg  = (r15 + r1 + r4) / 3;
    const rsiMin  = Math.min(r15, r1, r4);
    const rsiMax  = Math.max(r15, r1, r4);
    const spread  = rsiMax - rsiMin;

    if (rsiAvg > 35 && rsiAvg < 65 && spread <= 15) m3 = 20;
    else if (rsiAvg > 30 && rsiAvg < 70) m3 = 12;
    else m3 = 5;
  }
  score += m3;

  // -------- MODULE 4 : Volatilité (ATR + 24h) (0-15) --------
  let m4 = 0;
  const atr1hPct = rec.atr1hPct;
  const vola24   = rec.volaPct;

  if (atr1hPct != null && vola24 != null) {
    if (atr1hPct < MAX_ATR_1H_PCT && vola24 > 2 && vola24 < MAX_VOLA_24) m4 = 15;
    else if (atr1hPct < 2.5 && vola24 < 30) m4 = 8;
    else m4 = 3;
  }
  score += m4;

  // -------- MODULE 5 : Structure journalière (PosDay + Tend24) (0-10) --------
  let m5 = 0;
  const posDay = rec.posDay;
  const tend24 = rec.tend24;
  if (posDay != null && tend24 != null) {
    if ((posDay > 30 && posDay < 70) || Math.abs(tend24) > 25) m5 = 10;
    else if (Math.abs(tend24) > 10) m5 = 6;
    else m5 = 3;
  }
  score += m5;

  // -------- MODULE 6 : Flux (OI + OB) (0-10) --------
  let m6 = 0;
  const dOI        = rec.deltaOIpct;
  const obImb      = rec.obImbalance;
  const absOb      = obImb != null ? Math.abs(obImb) : null;
  const absDeltaOI = dOI != null ? Math.abs(dOI) : null;

  if (absDeltaOI != null) {
    if (absDeltaOI > 0.5 && absDeltaOI < 5) m6 += 6;
    else if (absDeltaOI < 10) m6 += 3;
  }
  if (absOb != null) {
    if (absOb > 10 && absOb < 35) m6 += 4;
    else if (absOb < 50) m6 += 2;
  }

  m6 = clamp(m6, 0, 10);
  score += m6;

  const total = clamp(score, 0, 100);

  // Debug interne (console seulement)
  console.log(
    `📊 JDS-SWING ${rec.symbol} = ${total.toFixed(1)} | ` +
    `M1=${m1.toFixed(1)} M2=${m2.toFixed(1)} M3=${m3.toFixed(1)} ` +
    `M4=${m4.toFixed(1)} M5=${m5.toFixed(1)} M6=${m6.toFixed(1)}`
  );

  return total;
}

// ========= DÉTECTION DIRECTION =========

function detectDirection(rec, jdsSwing) {
  const vwap1h    = rec.deltaVWAP1h;
  const vwap4h    = rec.deltaVWAP4h;
  const rsi1h     = rec.rsi["1h"];
  const rsi4h     = rec.rsi["4h"];
  const obPressure= rec.obPressure;
  const deltaOI   = rec.deltaOIpct;

  let longScore  = 0;
  let shortScore = 0;

  // VWAP bias
  if (vwap1h != null && vwap1h < 0) longScore += 2;
  if (vwap1h != null && vwap1h > 0) shortScore += 2;
  if (vwap4h != null && vwap4h < 0) longScore += 2;
  if (vwap4h != null && vwap4h > 0) shortScore += 2;

  // RSI bias (structure de tendance)
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

  // Mode continuation : si JDS très haut et RSI déjà étendu, on ne pénalise pas
  if (jdsSwing >= 90 && rsi4h != null && rsi1h != null) {
    if (rsi4h > 65 && rsi1h > 55) longScore += 2;   // continuation haussière
    if (rsi4h < 35 && rsi1h < 45) shortScore += 2;  // continuation baissière
  }

  return longScore >= shortScore ? "LONG" : "SHORT";
}

// ========= CONDITIONS MARCHÉ =========

function shouldAvoidMarket(rec) {
  const atr1h  = rec.atr1hPct;
  const vola24 = rec.volaPct;
  const vwap4h = rec.deltaVWAP4h;
  const deltaOI= rec.deltaOIpct;

  if (atr1h != null && atr1h > MAX_ATR_1H_PCT) return "ATR 1h trop élevé";
  if (vola24 != null && vola24 > MAX_VOLA_24)   return "Volatilité 24h excessive";
  if (vwap4h != null && Math.abs(vwap4h) > MAX_VWAP_4H_DEVIATION) return "Écart VWAP 4h trop large";

  if (rec.obPressure === "bullish" && deltaOI != null && deltaOI < -3) return "OB contradictoire";
  if (rec.obPressure === "bearish" && deltaOI != null && deltaOI >  3) return "OB contradictoire";

  return null;
}

// ========= CALCUL ENTRÉE/SL/TP (DYNAMIQUE) =========

function calculateTradePlan(rec, direction, jdsSwing) {
  const last = rec.last;
  const atr1h = rec.atr1hPct ? (rec.atr1hPct / 100) * last : last * 0.01;
  const atr4h = rec.atr4hPct ? (rec.atr4hPct / 100) * last : last * 0.015;

  // Pullback dynamique selon la qualité du setup
  let pullbackFactor;
  if (jdsSwing >= 90)       pullbackFactor = 0.3;
  else if (jdsSwing >= 85)  pullbackFactor = 0.5;
  else                      pullbackFactor = 0.7;

  let entry, sl, tp1, tp2;

  if (direction === "LONG") {
    entry = last - (pullbackFactor * atr1h);
    sl    = entry - (1.2 * atr4h);
    const slDist = entry - sl;
    tp1   = entry + (1.0 * slDist);
    tp2   = entry + (2.0 * slDist);
  } else {
    entry = last + (pullbackFactor * atr1h);
    sl    = entry + (1.2 * atr4h);
    const slDist = sl - entry;
    tp1   = entry - (1.0 * slDist);
    tp2   = entry - (2.0 * slDist);
  }

  const decimals = last < 0.0001 ? 7 : last < 0.01 ? 6 : last < 0.1 ? 5 : 4;

  const entryF = num(entry, decimals);
  const slF    = num(sl, decimals);
  const tp1F   = num(tp1, decimals);
  const tp2F   = num(tp2, decimals);

  // R:R sur TP1
  let rr = null;
  const e = +entryF, s = +slF, t1 = +tp1F;
  if (direction === "LONG" && e > s && t1 > e) {
    rr = (t1 - e) / (e - s);
  } else if (direction === "SHORT" && s > e && e > t1) {
    rr = (e - t1) / (s - e);
  }
  const rrStr = rr != null && isFinite(rr) ? num(rr, 2) : null;

  return {
    entry: entryF,
    sl:    slF,
    tp1:   tp1F,
    tp2:   tp2F,
    rr:    rrStr
  };
}

// ========= LEVIER CONSEILLÉ =========

function getRecommendedLeverage(vola24) {
  if (vola24 == null) return "2x";
  if (vola24 < 5)     return "3x";
  if (vola24 <= 10)   return "2x";
  return "1x";
}

// ========= DURÉE ESTIMÉE =========

function estimateDuration(jdsSwing, rec) {
  const trend1h  = trendStrength(rec.c1h, 48);
  const trend4h  = trendStrength(rec.c4h, 24);
  const avgTrend = (Math.abs(trend1h) + Math.abs(trend4h)) / 2;

  if (jdsSwing >= 90 && avgTrend > 40) return "3h–12h";
  if (jdsSwing >= 85)                  return "6h–24h";
  if (jdsSwing >= 75)                  return "12h–36h";
  return "24h–48h";
}

// ========= MOVE TO BE =========

function getMoveToBeCondition(direction) {
  // Direction gardée pour une éventuelle nuance plus tard (LONG/SHORT)
  return "TP1 atteint OU +1×ATR(1h) OU divergence RSI(15m) contre position";
}

// ========= ANTI-SPAM =========

function shouldSendAlert(symbol, direction, state) {
  const key  = `${symbol}-${direction}-${state}`;
  const now  = Date.now();
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
  if (!TELEGRAM_BOT_TOKEN || ! TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "Markdown"
      })
    });
  } catch (e) {
    console.error("❌ Telegram error:", e.message);
  }
}

// ========= SCAN COMPLET =========

async function scanOnce() {
  console.log("🔍 JTF SWING BOT v1.1 — Scan en cours…");

  const snapshots = [];
  const BATCH_SIZE = 5;

  for (let i = 0; i < SYMBOLS.length; i += BATCH_SIZE) {
    const batch   = SYMBOLS.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(symbol => processSymbol(symbol).catch(() => null)));
    for (const res of results) if (res) snapshots.push(res);
    if (i + BATCH_SIZE < SYMBOLS.length) await sleep(1000);
  }

  const readySetups = [];
  const primeSetups = [];

  for (const rec of snapshots) {
    const jdsSwing = calculateJDSSwing(rec);

    // Ignorer les zones CHOP/WATCH
    if (jdsSwing < 60) continue;

    const avoidReason = shouldAvoidMarket(rec);
    if (avoidReason) {
      console.log(`⛔ ${rec.symbol} ignoré: ${avoidReason}`);
      continue;
    }

    const direction = detectDirection(rec, jdsSwing);

    // Filtre OI purge/construction contradictoire
    if (direction === "LONG"  && rec.deltaOIpct != null && rec.deltaOIpct < -2) continue;
    if (direction === "SHORT" && rec.deltaOIpct != null && rec.deltaOIpct >  2) continue;

    const plan     = calculateTradePlan(rec, direction, jdsSwing);
    const leverage = getRecommendedLeverage(rec.volaPct);
    const duration = estimateDuration(jdsSwing, rec);
    const moveToBe = getMoveToBeCondition(direction);

    const setup = {
      symbol:   rec.symbol,
      direction,
      jdsSwing: num(jdsSwing, 1),
      entry:    plan.entry,
      sl:       plan.sl,
      tp1:      plan.tp1,
      tp2:      plan.tp2,
      rr:       plan.rr,
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

  let message = "";

  if (primeSetups.length === 0 && readySetups.length === 0) {
    message = "📊 *JTF SWING — RAS*\nAucun setup READY/PRIME sur ce scan.";
    await sendTelegram(message);
    console.log("✅ Aucun setup détecté (RAS envoyé).");
    return;
  }

  const setupsToSend = primeSetups.length > 0 ? primeSetups : readySetups.slice(0, 3);
  const state        = primeSetups.length > 0 ? "PRIME" : "READY";

  message = `🎯 *JTF SWING — ${state} DÉTECTÉ*\n\n`;

  for (let i = 0; i < setupsToSend.length; i++) {
    const s = setupsToSend[i];

    if (!shouldSendAlert(s.symbol, s.direction, state)) continue;

    const dirEmoji = s.direction === "LONG" ? "📈" : "📉";
    const rrStr    = s.rr != null ? `${s.rr}R` : "n/a";

    message += `*${i + 1}) ${baseSymbol(s.symbol)}*\n`;
    message += `${dirEmoji} *${s.direction}*\n`;
    message += `💠 *Entry (LIMIT):* ${s.entry}\n`;
    message += `🛡️ *SL:* ${s.sl}\n`;
    message += `🎯 *TP1:* ${s.tp1} | *TP2:* ${s.tp2}\n`;
    message += `📏 *Levier:* ${s.leverage} — *R:R:* ${rrStr}\n`;
    message += `⏱️ *Durée estimée:* ${s.duration}\n`;
    message += `🔄 *Move to BE:* ${s.moveToBe}\n`;
    message += `🔥 *JDS-SWING:* ${s.jdsSwing}\n`;
    message += `📊 *Momentum:* ${s.momentum}\n`;
    message += `📍 *VWAP:* ${s.vwapContext}\n\n`;
  }

  if (message.includes("Entry")) {
    await sendTelegram(message);
    console.log(`✅ ${state} envoyé (${setupsToSend.length} setup(s)).`);
  } else {
    console.log("ℹ️ Rien à envoyer (anti-spam a filtré tous les setups).");
  }
}

// ========= MAIN =========

async function main() {
  console.log("🚀 JTF SWING BOT v1.1 — Démarré.");
  await sendTelegram("🟢 *JTF SWING BOT v1.1* démarré.\nScan toutes les 30min. Très peu de signaux. Filtres swing multi-TF (1h/4h) + ATR + VWAP + OB/OI.");

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