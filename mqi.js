// mqi.js — MQI v1.1.1 (Stable-State Engine, Zero-Crash)
// Mode OBSERVER ONLY — ZERO interaction avec Autoselect / Degen / Swing / Discovery
// Points clés v1.1.1 :
// - Protection totale API (Bitget errors, nulls, missing data)
// - Breadth sécurisée (plus jamais de crash allTickers.find)
// - Score smoothing (moyenne glissante 2 scans)
// - Dead zones pour éviter le bruit
// - Double confirmation pour changer d’état
// - Anti-spam + messages rares et utiles

import fetch from "node-fetch";
import { loadJson } from "./config/loadJson.js";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

// ====== CONFIG ======
const SCAN_INTERVAL_MS          = 5 * 60_000;    // Scan toutes les 5 min
const MIN_SCORE_DELTA_FOR_ALERT = 7;             // Score doit changer d'au moins 7 pts
const MIN_SEND_INTERVAL_MS      = 12 * 60_000;   // Cooldown global

// Dead Zones = stabilisation
const DEADZONE_NEUTRAL_LOW  = 45;
const DEADZONE_NEUTRAL_HIGH = 55;
const DEADZONE_STRONG_LOW   = 58;
const DEADZONE_STRONG_HIGH  = 72;

// Double confirmation
const REQUIRED_CONFIRMATIONS = 2;

// Mémoire
let lastMQIState   = null;
let lastMQIScore   = null;
let lastMQISentAt  = 0;

let scoreHistory = [];
let stateCandidate = null;
let stateConfirmations = 0;

// Top30 (pour breadth)
const top30 = loadJson("./config/top30.json") || [];

// ==========================================================
// UTILS
// ==========================================================

const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const num   = (v,d=2)=>v==null?null:+(+v).toFixed(d);

async function safeGetJson(url) {
  try {
    const r = await fetch(url, { headers:{Accept:"application/json"} });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

function percentChange(a,b){
  if(!b) return 0;
  return (a/b - 1) * 100;
}

function baseSymbol(s){ return s.replace("_UMCBL",""); }

// ==========================================================
// API BITGET (sécurisé)
// ==========================================================

async function getCandles(symbol, seconds, limit = 10) {
  const base = baseSymbol(symbol);
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/candles?symbol=${base}&granularity=${seconds}&productType=usdt-futures&limit=${limit}`
  );

  if (j?.data?.length) {
    return j.data.map(c => ({
      t:+c[0], o:+c[1], h:+c[2], l:+c[3], c:+c[4], v:+c[5]
    })).sort((a,b)=>a.t-b.t);
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

  // 🚨 Protection totale : pas de data -> tableau vide -> ZERO crash
  if (!j || !Array.isArray(j.data)) {
    console.log("⚠️ MQI WARNING: getAllTickers() returned invalid data");
    return [];
  }
  return j.data;
}

// ==========================================================
// VWAP
// ==========================================================

function vwap(c) {
  let pv=0, v=0;
  for(const x of c){
    const p=(x.h+x.l+x.c)/3;
    pv+=p*x.v;
    v+=x.v;
  }
  return v?pv/v:null;
}

// ==========================================================
// MQI CALCULATION
// ==========================================================

async function computeMQI() {
  const [btc1h, eth1h] = await Promise.all([
    getCandles("BTCUSDT_UMCBL", 3600, 5),
    getCandles("ETHUSDT_UMCBL", 3600, 5)
  ]);

  if (btc1h.length < 2 || eth1h.length < 2) return null;

  // Trend 1h
  let btcTrend1h = percentChange(btc1h.at(-1).c, btc1h.at(-1).o);
  let ethTrend1h = percentChange(eth1h.at(-1).c, eth1h.at(-1).o);

  // Smoothing
  btcTrend1h *= 0.7;
  ethTrend1h *= 0.7;

  const btcTk = await getTicker("BTCUSDT_UMCBL");
  if (!btcTk) return null;

  const lastPrice = +btcTk.last;
  const high24    = +btcTk.high24h;
  const low24     = +btcTk.low24h;

  const volaPct   = lastPrice ? ((high24 - low24)/lastPrice)*100 : 0;

  const btcVWAP1h = vwap(btc1h.slice(-24));
  const distVWAP  = btcVWAP1h ? ((lastPrice - btcVWAP1h)/btcVWAP1h)*100 : 0;

  const allTickers = await getAllTickers();
  const btc24 = +btcTk.priceChangePercent || 0;

  // Breadth sécurisé
  let aligned = 0;
  let total   = 0;

  if (Array.isArray(allTickers) && allTickers.length > 0) {
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

  // Trend label
  let trendLabel = "CHOP";
  const absBTC  = Math.abs(btcTrend1h);
  const absETH  = Math.abs(ethTrend1h);

  if (absBTC < 0.12 && absETH < 0.12 && volaPct < 0.5) {
    trendLabel = "RANGE";
  } else if (absBTC > 0.45 && absETH > 0.45 && breadth > 65) {
    trendLabel = "MOMENTUM";
  }

  // MQI score
  let score = 0;

  const avgTrend = (absBTC + absETH)/2;
  score += avgTrend >= 0.8 ? 30 : avgTrend >= 0.4 ? 22 : avgTrend >= 0.2 ? 15 : 10;

  score += breadth >= 85 ? 25 : breadth >= 70 ? 18 : breadth >= 55 ? 12 : 6;

  score += (volaPct>=0.35 && volaPct<=1.6) ? 20 :
           (volaPct>=0.2 && volaPct<=2.5) ? 14 :
           volaPct<=4 ? 8 : 4;

  const absVWAP = Math.abs(distVWAP);
  score += absVWAP<=0.7 ? 15 : absVWAP<=1.4 ? 10 : absVWAP<=3 ? 6 : 3;

  const sameSign = Math.sign(btcTrend1h) === Math.sign(ethTrend1h);
  score += sameSign && breadth>=60 ? 10 :
           sameSign && breadth>=50 ? 6 : 3;

  score = Math.round(Math.max(0, Math.min(100, score)));

  // Smoothing score
  scoreHistory.push(score);
  if (scoreHistory.length > 2) scoreHistory.shift();

  const smoothedScore = Math.round(
    scoreHistory.reduce((a,b)=>a+b,0) / scoreHistory.length
  );

  return {
    score: smoothedScore,
    btcTrend1h: num(btcTrend1h,3),
    ethTrend1h: num(ethTrend1h,3),
    breadth: num(breadth,2),
    vola: num(volaPct,2),
    distVWAP: num(distVWAP,2),
    trendLabel
  };
}

// ==========================================================
// CLASSIFICATION (avec Dead Zones)
// ==========================================================

function classifyMQI(score) {
  if (score >= DEADZONE_NEUTRAL_LOW && score <= DEADZONE_NEUTRAL_HIGH)
    return "MARKET NEUTRAL";

  if (score >= DEADZONE_STRONG_LOW && score <= DEADZONE_STRONG_HIGH)
    return "MARKET OK";

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

  // Premier message
  if (lastMQIState === null) {
    lastMQIState  = state;
    lastMQIScore  = score;
    lastMQISentAt = now;
    return true;
  }

  // Score change min
  if (Math.abs(score - lastMQIScore) < MIN_SCORE_DELTA_FOR_ALERT
      && state === lastMQIState) {
    return false;
  }

  // Double confirmation
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

  // Mise à jour
  lastMQIState  = state;
  lastMQIScore  = score;
  lastMQISentAt = now;
  stateConfirmations = 0;

  return true;
}

// ==========================================================
// TELEGRAM
// ==========================================================

async function sendTelegram(text){
  if(!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try{
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,{
      method:"POST",
      headers:{ "Content-Type":"application/json" },
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

  const { score, btcTrend1h, ethTrend1h, breadth, vola, distVWAP, trendLabel } = metrics;

  const state = classifyMQI(score);

  console.log(
    `📡 MQI v1.1.1 — Score=${score} | State=${state} | BTC=${btcTrend1h}% ETH=${ethTrend1h}% Breadth=${breadth}%`
  );

  if (!shouldSendMQI(score, state)) return;

  const msg =
`📡 *MQI v1.1.1 — Market Quality Index*

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
  console.log("🛰️ MQI v1.1.1 démarré. Mode stable & silencieux.");
  await sendTelegram("🛰️ *MQI v1.1.1* démarré. Messages rares, zéro bruit.");

  while (true) {
    try {
      await scanMQIOnce();
    } catch (e) {
      console.error("❌ MQI Error:", e.message);
    }
    await sleep(SCAN_INTERVAL_MS);
  }
}