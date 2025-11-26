// mqi.js — MQI v1.0 (Observer Intelligent, Only-on-change)
// Market Quality Index pour BTC/ETH + Top30
// - Scan toutes les 5 minutes
// - N'INTERAGIT AVEC AUCUN AUTRE BOT
// - Envoie sur Telegram UNIQUEMENT si l'état change
//   ou si le score bouge de ≥ 5 points (avec cooldown)

import fetch from "node-fetch";
import { loadJson } from "./config/loadJson.js";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

const SCAN_INTERVAL_MS          = 5 * 60_000;   // Scan toutes les 5 min
const MIN_SCORE_DELTA_FOR_ALERT = 5;            // Variation minimale du score pour renvoyer
const MIN_SEND_INTERVAL_MS      = 10 * 60_000;  // Cooldown min entre 2 messages MQI

// Top30 pour la breadth (si dispo)
const top30 = loadJson("./config/top30.json") || [];

// Mémoire MQI (pour éviter le spam)
let lastMQIState   = null;   // ex: "MARKET PRIME"
let lastMQIScore   = null;   // ex: 80
let lastMQISentAt  = 0;

// ========= UTILS =========

const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const num   = (v, d = 2) => v == null ? null : +(+v).toFixed(d);

async function safeGetJson(url) {
  try {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    if (!r.ok) return null;
    return await r.json();
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

// ========= API BITGET =========

async function getCandles(symbol, seconds, limit = 10) {
  const base = baseSymbol(symbol);
  // v2
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
  // fallback v1
  j = await safeGetJson(
    `https://api.bitget.com/api/mix/v1/market/candles?symbol=${symbol}&granularity=${seconds}&limit=${limit}`
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

// ========= VWAP =========

function vwap(candles) {
  let pv = 0, v = 0;
  for (const x of candles) {
    const p = (x.h + x.l + x.c) / 3;
    pv += p * x.v;
    v  += x.v;
  }
  return v ? pv / v : null;
}

// ========= CALCUL MQI =========

async function computeMQI() {
  // 1) BTC / ETH trend 1h
  const [btc1h, eth1h] = await Promise.all([
    getCandles("BTCUSDT_UMCBL", 3600, 5),
    getCandles("ETHUSDT_UMCBL", 3600, 5)
  ]);

  if (btc1h.length < 2 || eth1h.length < 2) {
    console.log("⚠️ MQI: pas assez de données 1h BTC/ETH");
    return null;
  }

  const btcLast = btc1h[btc1h.length - 1];
  const ethLast = eth1h[eth1h.length - 1];

  const btcTrend1h = percentChange(btcLast.c, btcLast.o);
  const ethTrend1h = percentChange(ethLast.c, ethLast.o);

  // 2) BTC ticker pour vola 24h + VWAP distance
  const btcTk = await getTicker("BTCUSDT_UMCBL");
  if (!btcTk) {
    console.log("⚠️ MQI: ticker BTC indisponible");
    return null;
  }

  const lastPrice = +btcTk.last;
  const high24    = +btcTk.high24h;
  const low24     = +btcTk.low24h;

  const volaPct   = lastPrice ? ((high24 - low24) / lastPrice) * 100 : 0;

  const btcVWAP1h = vwap(btc1h.slice(-24));
  const distVWAP  = btcVWAP1h
    ? ((lastPrice - btcVWAP1h) / btcVWAP1h) * 100
    : 0;

  // 3) Breadth Top30 (alignement avec BTC sur 1h via 24h-change approximation)
  const allTickers = await getAllTickers();
  const btc24 = +btcTk.priceChangePercent || 0;

  let aligned = 0;
  let total   = 0;

  if (top30 && Array.isArray(top30) && top30.length > 0) {
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

  const breadth = total > 0 ? (aligned / total) * 100 : 50;

  // 4) Détection type de trend global (MOMENTUM / RANGE / CHOP)
  let trendLabel = "CHOP";
  const absBTC   = Math.abs(btcTrend1h);
  const absETH   = Math.abs(ethTrend1h);

  if (absBTC < 0.15 && absETH < 0.15 && volaPct < 0.6) {
    trendLabel = "RANGE";
  } else if (absBTC > 0.35 && absETH > 0.35 && breadth > 60) {
    trendLabel = "MOMENTUM";
  }

  // 5) SCORE MQI (0–100)
  let score = 0;

  // Module 1: BTC/ETH Trend (max 30)
  const avgTrend = (Math.abs(btcTrend1h) + Math.abs(ethTrend1h)) / 2;
  if (avgTrend >= 0.8) score += 30;
  else if (avgTrend >= 0.4) score += 22;
  else if (avgTrend >= 0.2) score += 16;
  else score += 10;

  // Module 2: Breadth (max 25)
  if (breadth >= 85) score += 25;
  else if (breadth >= 70) score += 18;
  else if (breadth >= 55) score += 12;
  else score += 6;

  // Module 3: Volatilité 24h (max 20) — préférence pour 0.4–1.5%
  if (volaPct >= 0.4 && volaPct <= 1.5) score += 20;
  else if (volaPct >= 0.2 && volaPct <= 2.5) score += 14;
  else if (volaPct <= 4) score += 8;
  else score += 4;

  // Module 4: Distance VWAP (max 15) — idéal < 1%
  const absVWAP = Math.abs(distVWAP);
  if (absVWAP <= 0.6) score += 15;
  else if (absVWAP <= 1.2) score += 10;
  else if (absVWAP <= 2.5) score += 6;
  else score += 3;

  // Module 5: Cohérence Trend vs Breadth (max 10)
  const sameSign = Math.sign(btcTrend1h) === Math.sign(ethTrend1h);
  if (sameSign && breadth >= 70) score += 10;
  else if (sameSign && breadth >= 55) score += 6;
  else score += 3;

  score = Math.max(0, Math.min(100, score));
  const scoreRounded = Math.round(score);

  return {
    score: scoreRounded,
    btcTrend1h: num(btcTrend1h, 2),
    ethTrend1h: num(ethTrend1h, 2),
    breadth:    num(breadth, 2),
    vola:       num(volaPct, 2),
    distVWAP:   num(distVWAP, 2),
    trendLabel
  };
}

// ========= CLASSIFICATION MQI =========

function classifyMQI(score) {
  if (score >= 80) {
    return { state: "MARKET PRIME", emoji: "🟢", desc: "tendance nette, conditions optimales" };
  }
  if (score >= 70) {
    return { state: "MARKET STRONG", emoji: "🟢", desc: "tendance claire, contexte favorable" };
  }
  if (score >= 60) {
    return { state: "MARKET OK", emoji: "🟡", desc: "conditions correctes, rien d'exceptionnel" };
  }
  if (score >= 50) {
    return { state: "MARKET NEUTRAL", emoji: "🟦", desc: "normal, rien à signaler" };
  }
  if (score >= 40) {
    return { state: "MARKET WEAK", emoji: "🟠", desc: "tendance fragile, prudence" };
  }
  return { state: "MARKET DANGER", emoji: "🔴", desc: "marché hostile, risque élevé" };
}

// ========= ANTI-SPAM: ONLY-ON-CHANGE =========

function shouldSendMQI(score, state) {
  const now = Date.now();

  // Premier message : on envoie
  if (lastMQIState === null && lastMQIScore === null) {
    lastMQIState  = state;
    lastMQIScore  = score;
    lastMQISentAt = now;
    return true;
  }

  const scoreDiff = Math.abs(score - lastMQIScore);

  // Si état identique ET variation de score < seuil -> ne rien envoyer
  if (state === lastMQIState && scoreDiff < MIN_SCORE_DELTA_FOR_ALERT) {
    return false;
  }

  // On protège quand même avec un petit cooldown
  if (now - lastMQISentAt < MIN_SEND_INTERVAL_MS) {
    return false;
  }

  // OK, on envoie et on met à jour la mémoire
  lastMQIState  = state;
  lastMQIScore  = score;
  lastMQISentAt = now;
  return true;
}

// ========= TELEGRAM =========

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
  } catch (e) {
    console.error("❌ MQI Telegram error:", e.message);
  }
}

// ========= BOUCLE PRINCIPALE =========

async function scanMQIOnce() {
  const metrics = await computeMQI();
  if (!metrics) return;

  const { score, btcTrend1h, ethTrend1h, breadth, vola, distVWAP, trendLabel } = metrics;
  const { state, emoji, desc } = classifyMQI(score);

  console.log(
    `📡 MQI v1.0 — Score=${score} | ${state} | BTC=${btcTrend1h}% ETH=${ethTrend1h}% Breadth=${breadth}% Vola=${vola}% VWAP=${distVWAP}% Trend=${trendLabel}`
  );

  if (!shouldSendMQI(score, state)) {
    return; // pas de changement significatif -> silence
  }

  const msg =
`📡 *MQI v1.0 — Market Quality Index*

*Score:* ${score}/100
${emoji} *${state}* — ${desc}

📊 *Données :*
• BTC Trend 1h: ${btcTrend1h}%
• ETH Trend 1h: ${ethTrend1h}%
• Breadth: ${breadth}% (Top30 alignés)
• Vola: ${vola}%
• Trend: ${trendLabel}
• Dist VWAP: ${distVWAP}%`;

  await sendTelegram(msg);
}

async function main() {
  console.log("🛰️ MQI v1.0 (Observer intelligent) démarré. Scan toutes les 5 min, only-on-change.");
  // Message de démarrage (une seule fois)
  await sendTelegram("🛰️ *MQI v1.0* démarré.\nMode OBSERVER ONLY — aucun impact sur les autres bots.\nScan toutes les 5 minutes, message uniquement si l'état du marché change.");

  while (true) {
    try {
      await scanMQIOnce();
    } catch (e) {
      console.error("❌ MQI scan error:", e.message);
    }
    await sleep(SCAN_INTERVAL_MS);
  }
}

export const startMQI = main;