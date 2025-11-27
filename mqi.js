// mqi.js — MQI v1.1 (Stable-State Engine, Noise-Resistant)
// Mode OBSERVER ONLY — ZERO interaction avec Autoselect / Degen / Swing / Discovery
// Améliorations v1.1 :
// - Dead Zones (zones mortes autour des seuils)
// - Double-Confirmation pour changer d'état
// - BTC & Breadth smoothing
// - Score smoothing (moyenne glissante 2 scans)
// - Anti-spam + état plus stable
// - Messages rares mais utiles

import fetch from "node-fetch";
import { loadJson } from "./config/loadJson.js";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

const SCAN_INTERVAL_MS          = 5 * 60_000;    // Scan toutes les 5 min
const MIN_SCORE_DELTA_FOR_ALERT = 7;             // Score doit changer d'au moins 7 pts
const MIN_SEND_INTERVAL_MS      = 12 * 60_000;   // Cooldown global 12 min

// Dead Zones (stabilise les états)
const DEADZONE_NEUTRAL_LOW  = 45;
const DEADZONE_NEUTRAL_HIGH = 55;
const DEADZONE_STRONG_LOW   = 58;
const DEADZONE_STRONG_HIGH  = 72;

// Double confirmation (transition confirmée sur 2 scans consécutifs)
const REQUIRED_CONFIRMATIONS = 2;

// Mémoire MQI
let lastMQIState   = null;
let lastMQIScore   = null;
let lastMQISentAt  = 0;

let scoreHistory = [];
let stateCandidate = null;
let stateConfirmations = 0;

// Top30 pour breadth si dispo
const top30 = loadJson("./config/top30.json") || [];

// ==========================================================
// UTILS
// ==========================================================

const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const num   = (v, d = 2) => v == null ? null : +(+v).toFixed(d);

async function safeGetJson(url) {
  try {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

function percentChange(a, b) {
  if (!b) return 0;
  return (a / b - 1) * 100;
}

function baseSymbol(s) {
  return s.replace("_UMCBL", "");
}

// ==========================================================
// API
// ==========================================================

async function getCandles(symbol, seconds, limit = 10) {
  const base = baseSymbol(symbol);
  let j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/candles?symbol=${base}&granularity=${seconds}&productType=usdt-futures&limit=${limit}`
  );
  if (j?.data?.length) {
    return j.data
      .map(c => ({
        t: +c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5]
      }))
      .sort((a, b) => a.t - b.t);
  }

  return [];
}

async function getTicker(symbol) {
  const j = await safeGetJson(
    `https://api.bitget.com/api/mix/v1/market/ticker?symbol=${symbol}`
  );
  return j?.data ?? null;
}

async function getAllTickers() {
  const j = await safeGetJson(
    "https://api.bitget.com/api/mix/v1/market/tickers?productType=umcbl"
  );
  return j?.data ?? [];
}

// ==========================================================
// VWAP
// ==========================================================

function vwap(candles) {
  let pv = 0, v = 0;
  for (const x of candles) {
    const p = (x.h + x.l + x.c) / 3;
    pv += p * x.v;
    v  += x.v;
  }
  return v ? pv / v : null;
}

// ==========================================================
// MQI CALCULATION (with smoothing)
// ==========================================================

async function computeMQI() {
  const [btc1h, eth1h] = await Promise.all([
    getCandles("BTCUSDT_UMCBL", 3600, 5),
    getCandles("ETHUSDT_UMCBL", 3600, 5)
  ]);

  if (btc1h.length < 2 || eth1h.length < 2) return null;

  const btcLast = btc1h[btc1h.length - 1];
  const ethLast = eth1h[eth1h.length - 1];

  let btcTrend1h = percentChange(btcLast.c, btcLast.o);
  let ethTrend1h = percentChange(ethLast.c, ethLast.o);

  // Smoothing BTC/ETH (réduit 40% de bruit)
  btcTrend1h = num(btcTrend1h * 0.7, 3);
  ethTrend1h = num(ethTrend1h * 0.7, 3);

  const btcTk = await getTicker("BTCUSDT_UMCBL");
  if (!btcTk) return null;

  const lastPrice = +btcTk.last;
  const high24    = +btcTk.high24h;
  const low24     = +btcTk.low24h;

  const volaPct   = lastPrice ? ((high24 - low24) / lastPrice) * 100 : 0;

  const btcVWAP1h = vwap(btc1h.slice(-24));
  const distVWAP  = btcVWAP1h ? ((lastPrice - btcVWAP1h) / btcVWAP1h) * 100 : 0;

  const allTickers = await getAllTickers();
  const btc24 = +btcTk.priceChangePercent || 0;

  let aligned = 0;
  let total   = 0;

  if (top30.length > 0) {
    for (const sym of top30) {
      const t = allTickers.find(x => x.symbol === sym);
      if (!t) continue;
      const ch = +(t.priceChangePercent || 0);
      if (!isNaN(ch)) {
        total++;
        if (Math.sign(ch) === Math.sign(btc24)) aligned++;
      }
    }
  }

  let breadth = total > 0 ? (aligned / total) * 100 : 50;

  // Breadth smoothing
  breadth = breadth * 0.7 + 50 * 0.3;

  // Trend label (stable)
  let trendLabel = "CHOP";
  const absBTC   = Math.abs(btcTrend1h);
  const absETH   = Math.abs(ethTrend1h);

  if (absBTC < 0.12 && absETH < 0.12 && volaPct < 0.5) {
    trendLabel = "RANGE";
  } else if (absBTC > 0.45 && absETH > 0.45 && breadth > 65) {
    trendLabel = "MOMENTUM";
  }

  // MQI score
  let score = 0;

  const avgTrend = (Math.abs(btcTrend1h) + Math.abs(ethTrend1h)) / 2;
  if (avgTrend >= 0.8) score += 30;
  else if (avgTrend >= 0.4) score += 22;
  else if (avgTrend >= 0.2) score += 15;
  else score += 10;

  if (breadth >= 85) score += 25;
  else if (breadth >= 70) score += 18;
  else if (breadth >= 55) score += 12;
  else score += 6;

  if (volaPct >= 0.35 && volaPct <= 1.6) score += 20;
  else if (volaPct >= 0.2 && volaPct <= 2.5) score += 14;
  else if (volaPct <= 4) score += 8;
  else score += 4;

  const absVWAP = Math.abs(distVWAP);
  if (absVWAP <= 0.7) score += 15;
  else if (absVWAP <= 1.4) score += 10;
  else if (absVWAP <= 3) score += 6;
  else score += 3;

  const sameSign = Math.sign(btcTrend1h) === Math.sign(ethTrend1h);
  if (sameSign && breadth >= 60) score += 10;
  else if (sameSign && breadth >= 50) score += 6;
  else score += 3;

  score = Math.round(Math.max(0, Math.min(100, score)));

  // Score smoothing (moyenne glissante)
  scoreHistory.push(score);
  if (scoreHistory.length > 2) scoreHistory.shift();

  const smoothedScore = Math.round(
    scoreHistory.reduce((a, b) => a + b, 0) / scoreHistory.length
  );

  return {
    score: smoothedScore,
    rawScore: score,
    btcTrend1h,
    ethTrend1h,
    breadth: num(breadth, 2),
    vola: num(volaPct, 2),
    distVWAP: num(distVWAP, 2),
    trendLabel
  };
}

// ==========================================================
// CLASSIFICATION (stable-state logic)
// ==========================================================

function classifyMQI(score) {
  // Dead zones = pas de changement
  if (score >= DEADZONE_NEUTRAL_LOW && score <= DEADZONE_NEUTRAL_HIGH) {
    return "MARKET NEUTRAL";
  }

  if (score >= DEADZONE_STRONG_LOW && score <= DEADZONE_STRONG_HIGH) {
    return "MARKET OK";
  }

  if (score >= 80) return "MARKET PRIME";
  if (score >= 70) return "MARKET STRONG";
  if (score >= 60) return "MARKET OK";
  if (score >= 50) return "MARKET NEUTRAL";
  if (score >= 40) return "MARKET WEAK";
  return "MARKET DANGER";
}

// ==========================================================
// ANTI-SPAM + DOUBLE CONFIRMATION
// ==========================================================

function shouldSendMQI(score, state) {
  const now = Date.now();

  // INIT
  if (lastMQIState === null) {
    lastMQIState = state;
    lastMQIScore = score;
    lastMQISentAt = now;
    return true;
  }

  // Score change < threshold
  if (Math.abs(score - lastMQIScore) < MIN_SCORE_DELTA_FOR_ALERT
      && state === lastMQIState) {
    return false;
  }

  // Candidate state (double confirmation)
  if (stateCandidate !== state) {
    stateCandidate = state;
    stateConfirmations = 1;
    return false;
  }

  stateConfirmations++;

  if (stateConfirmations < REQUIRED_CONFIRMATIONS) {
    return false;
  }

  // Cooldown
  if (now - lastMQISentAt < MIN_SEND_INTERVAL_MS) return false;

  // Update memory
  lastMQIState = state;
  lastMQIScore = score;
  lastMQISentAt = now;
  stateConfirmations = 0;

  return true;
}

// ==========================================================
// TELEGRAM
// ==========================================================

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
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
  } catch {}
}

// ==========================================================
// MAIN LOOP
// ==========================================================

async function scanMQIOnce() {
  const metrics = await computeMQI();
  if (!metrics) return;

  const { score, btcTrend1h, ethTrend1h, breadth, vola, distVWAP, trendLabel } =
    metrics;

  const state = classifyMQI(score);

  console.log(
    `📡 MQI v1.1 — Score=${score} | State=${state} | BTC=${btcTrend1h}% ETH=${ethTrend1h}% Breadth=${breadth}%`
  );

  if (!shouldSendMQI(score, state)) return;

  const msg =
`📡 *MQI v1.1 — Market Quality Index*

*Score:* ${score}/100
*État:* ${state}

📊 *Données :*
• BTC Trend 1h: ${btcTrend1h}%
• ETH Trend 1h: ${ethTrend1h}%
• Breadth: ${breadth}% (Top30)
• Vola: ${vola}%
• Trend: ${trendLabel}
• Dist VWAP: ${distVWAP}%`;

  await sendTelegram(msg);
}

export async function startMQI() {
  console.log("🛰️ MQI v1.1 démarré. Mode stable et silencieux.");
  await sendTelegram(
    "🛰️ *MQI v1.1 (Stable-State Engine)* démarré.\nMessages RARES et PERTINENTS uniquement."
  );

  while (true) {
    try {
      await scanMQIOnce();
    } catch (e) {
      console.error("❌ MQI Error:", e.message);
    }
    await sleep(SCAN_INTERVAL_MS);
  }
}