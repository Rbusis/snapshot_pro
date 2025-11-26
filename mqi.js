// mqi.js — Market Quality Index v0.9 (Observer-Only)
// Analyse globale marché — aucune influence sur les autres bots
// Scan toutes les 10 minutes — envoie un message Telegram indépendant

import fetch from "node-fetch";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

const SCAN_INTERVAL_MS = 10 * 60_000;

// TOP30 pour la breadth
const TOP30 = [
  "BTCUSDT_UMCBL","ETHUSDT_UMCBL","BNBUSDT_UMCBL","SOLUSDT_UMCBL","XRPUSDT_UMCBL",
  "AVAXUSDT_UMCBL","LINKUSDT_UMCBL","DOTUSDT_UMCBL","TRXUSDT_UMCBL","ADAUSDT_UMCBL",
  "NEARUSDT_UMCBL","ATOMUSDT_UMCBL","OPUSDT_UMCBL","INJUSDT_UMCBL","UNIUSDT_UMCBL",
  "LTCUSDT_UMCBL","TIAUSDT_UMCBL","SEIUSDT_UMCBL","DOGEUSDT_UMCBL","FILUSDT_UMCBL",
  "ARBUSDT_UMCBL","APTUSDT_UMCBL","XLMUSDT_UMCBL","SUIUSDT_UMCBL","AAVEUSDT_UMCBL",
  "RUNEUSDT_UMCBL","PEPEUSDT_UMCBL","WIFUSDT_UMCBL","ALGOUSDT_UMCBL","FTMUSDT_UMCBL"
];

const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const num = (v, d=2) => v == null ? null : +(+v).toFixed(d);

async function safeJson(url){
  try {
    const r = await fetch(url);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function getCandles(symbol, seconds, limit=50){
  const base = symbol.replace("_UMCBL","");
  const url = `https://api.bitget.com/api/v2/mix/market/candles?symbol=${base}&granularity=${seconds}&productType=usdt-futures&limit=${limit}`;
  const j = await safeJson(url);
  if (j?.data?.length) {
    return j.data.map(c => ({ t:+c[0], o:+c[1], h:+c[2], l:+c[3], c:+c[4] }))
                 .sort((a,b)=>a.t-b.t);
  }
  return [];
}

function percent(a,b){ return b ? ((a/b)-1)*100 : null; }

function computeDelta(candles, lookback=4){
  if (candles.length < lookback+1) return 0;
  const now = candles[candles.length-1].c;
  const past = candles[candles.length-1-lookback].c;
  return percent(now, past);
}

function computeVWAP(c){
  let pv=0, v=0;
  for(const x of c){
    const p = (x.h+x.l+x.c)/3;
    pv += p;
    v  += 1;
  }
  return v ? pv/v : null;
}

// MQI scoring = Observer only
function scoreMQI({btc, eth, breadth, vola, trend}){
  let score = 0;

  // Trend BTC/ETH
  if (btc > 0 && eth > 0) score += 25;
  else if (btc > 0) score += 15;
  else if (eth > 0) score += 10;

  // Breadth : % du marché aligné
  if (breadth > 65) score += 30;
  else if (breadth > 55) score += 20;
  else if (breadth > 45) score += 10;

  // Vola (sweet zone : 1.5 → 5%)
  if (vola >= 1.5 && vola <= 5) score += 25;
  else if (vola <= 8) score += 15;

  // Trend classification
  if (trend === "TREND") score += 20;
  else if (trend === "MOMENTUM") score += 10;
  else if (trend === "CHOP") score += 0;

  return Math.max(0, Math.min(100, score));
}

function stateText(score){
  if (score >= 80) return "🟢 *MARKET PRIME* — tendance nette, conditions optimales";
  if (score >= 65) return "🟩 *MARKET GOOD* — marché propre, setups fiables";
  if (score >= 40) return "🟦 *MARKET NEUTRAL* — normal, rien à signaler";
  return "🔴 *MARKET BAD* — range / bruit / incertitude";
}

async function analyzeMQI(){
  const btc = await getCandles("BTCUSDT_UMCBL", 900, 40);
  const eth = await getCandles("ETHUSDT_UMCBL", 900, 40);

  if (!btc.length || !eth.length) return null;

  const btcTrend = computeDelta(btc, 4);  // delta 1h
  const ethTrend = computeDelta(eth, 4);

  // Breadth = % Top30 alignés
  let aligned = 0;
  for(const sym of TOP30){
    const c = await getCandles(sym, 900, 30);
    if (!c.length) continue;
    const d = computeDelta(c, 4);
    if (d > 0) aligned++;
  }
  const breadth = (aligned / TOP30.length) * 100;

  const high24 = btc[btc.length-1].h;
  const low24  = btc[btc.length-1].l;
  const last   = btc[btc.length-1].c;
  const vola   = ((high24 - low24) / last) * 100;

  const vwap = computeVWAP(btc.slice(-12));
  const dist = percent(last, vwap);

  let trend;
  if (Math.abs(dist) < 0.3) trend = "CHOP";
  else if (Math.abs(dist) < 1.2) trend = "MOMENTUM";
  else trend = "TREND";

  const mqiValue = scoreMQI({btc:btcTrend, eth:ethTrend, breadth, vola, trend});

  return {
    score: mqiValue,
    btcTrend: num(btcTrend),
    ethTrend: num(ethTrend),
    breadth: num(breadth),
    vola: num(vola),
    trend,
    distVWAP: num(dist)
  };
}

async function sendTelegram(text){
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,{
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode:"Markdown"
    })
  });
}

async function scanMQI(){
  const r = await analyzeMQI();
  if (!r) return;

  const msg =
`📡 *MQI v0.9 — Market Quality Index*\n
Score: *${r.score}/100*\n${stateText(r.score)}

📊 *Données :*
• BTC Trend 1h: ${r.btcTrend}%
• ETH Trend 1h: ${r.ethTrend}%
• Breadth: ${r.breadth}% (Top30 alignés)
• Vola: ${r.vola}% 
• Trend: ${r.trend}
• Dist VWAP: ${r.distVWAP}%`;

  await sendTelegram(msg);
  console.log(msg);
}

async function main(){
  console.log("🟢 MQI v0.9 — Observer Mode lancé.");
  await sendTelegram("🟢 *MQI v0.9 lancé — Mode OBSERVER ONLY*");

  while(true){
    try { await scanMQI(); }
    catch(e){ console.error("MQI error:", e.message); }
    await sleep(SCAN_INTERVAL_MS);
  }
}

export const startMQI = main;