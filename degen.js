// degen.js — JTF DEGEN v1.3 (API v2 FUTURES + Discovery-style Endpoints)
// Lowcaps Momentum Sniper — mêmes filtres DEGEN, mais API 100% fiable

import fetch from "node-fetch";
import fs from "fs";

// ========= CONFIG =========

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

const SCAN_INTERVAL_MS       = 5 * 60_000;
const MIN_ALERT_DELAY_MS     = 15 * 60_000;
const GLOBAL_COOLDOWN_MS     = 30 * 60_000;
const SYMBOL_UPDATE_INTERVAL = 60 * 60_000;

// BTC context limits
const BTC_TREND_ABS_MIN = 0.2;
const BTC_TREND_ABS_MAX = 2.5;

const BTC_LONG_MIN  = 0.2;
const BTC_LONG_MAX  = 2.0;
const BTC_SHORT_MIN = -2.0;
const BTC_SHORT_MAX = -0.2;

// Debug (pour vérifier les valeurs)
const DEBUG = true;

// ========= STATE =========

let DEGEN_SYMBOLS        = [];
let lastSymbolUpdate     = 0;
let lastGlobalTradeTime  = 0;
const lastAlerts         = new Map();

// Fallback lowcaps (futures USDT)
const FALLBACK_LOWCAPS = [
  "MAGICUSDT","GALAUSDT","ONEUSDT",
  "CELOUSDT","KAVAUSDT"
];

// Exclusions grosses caps (mêmes que Discovery / TOP30)
const IGNORE_LIST = [
  "BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT",
  "ADAUSDT","DOGEUSDT","AVAXUSDT","DOTUSDT","TRXUSDT",
  "LINKUSDT","TONUSDT","SUIUSDT","APTUSDT","NEARUSDT",
  "ARBUSDT","OPUSDT","INJUSDT","ATOMUSDT","AAVEUSDT",
  "LTCUSDT","UNIUSDT","FILUSDT","XLMUSDT","RUNEUSDT",
  "ALGOUSDT","PEPEUSDT","WIFUSDT","TIAUSDT","SEIUSDT"
];

// ========= LOAD JSON (top30 + discovery_list) =========

function loadJson(path){
  try{
    if (fs.existsSync(path)){
      return JSON.parse(fs.readFileSync(path,"utf8"));
    }
  }catch(e){
    console.error(`⚠️ Erreur lecture ${path}:`, e.message);
  }
  return [];
}

const TOP30 = loadJson("./config/top30.json");                // ["BTCUSDT", ...]
function getDiscoveryList(){
  return loadJson("./config/discovery_list.json");            // ["INJUSDT", ...] ou []
}

// ========= UTILS =========

const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const num   = (v,d=4) => (v==null ? null : +(+v).toFixed(d));
const clamp = (x,min,max) => Math.max(min, Math.min(max,x));

async function safeGetJson(url){
  try{
    const r = await fetch(url, { headers:{Accept:"application/json"} });
    if (!r.ok) return null;
    return await r.json();
  }catch{
    return null;
  }
}

// ========= API v2 (copié du style Discovery) =========

async function getCandles(symbol, seconds, limit=100){
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}&granularity=${seconds}&limit=${limit}&productType=usdt-futures`
  );
  if (!j?.data?.length) return [];
  return j.data.map(c => ({
    t:+c[0], o:+c[1], h:+c[2], l:+c[3], c:+c[4], v:+c[5]
  })).sort((a,b)=>a.t-b.t);
}

async function getTicker(symbol){
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/ticker?symbol=${symbol}&productType=usdt-futures`
  );
  if (!j?.data) return null;
  return Array.isArray(j.data) ? j.data[0] : j.data;
}

async function getDepth(symbol){
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/merge-depth?symbol=${symbol}&productType=usdt-futures&limit=20`
  );
  if (!j?.data) return null;
  const d = Array.isArray(j.data) ? j.data[0] : j.data;
  return (d?.bids && d?.asks) ? d : null;
}

async function getAllTickers(){
  const j = await safeGetJson(
    "https://api.bitget.com/api/v2/mix/market/tickers?productType=usdt-futures"
  );
  return j?.data ?? [];
}

async function getBTCTrend(){
  const c = await getCandles("BTCUSDT", 3600, 5);
  if (!c?.length) return null;
  const last = c[c.length-1];
  return ((last.c - last.o)/last.o)*100;
}

// ========= LISTE DEGEN (futures only) =========

async function updateDegenList(){
  try{
    const all = await getAllTickers();
    if (!all.length) return FALLBACK_LOWCAPS;

    const discovery = getDiscoveryList();

    let list = all.filter(t =>
      t.symbol?.endsWith("USDT") &&
      !IGNORE_LIST.includes(t.symbol) &&
      (+t.usdtVolume > 3_000_000)
    );

    list.sort((a,b)=>(+b.usdtVolume) - (+a.usdtVolume));

    let lowcaps = list.map(t=>t.symbol);

    lowcaps = lowcaps.filter(sym =>
      !TOP30.includes(sym) &&
      !discovery.includes(sym)
    );

    lowcaps = lowcaps.slice(0,30);

    if (!lowcaps.length) return FALLBACK_LOWCAPS;

    console.log(`🔄 DEGEN list updated (${lowcaps.length} paires).`);
    return lowcaps;
  }catch(e){
    console.log("⚠️ updateDegenList ERROR:", e?.message);
    return FALLBACK_LOWCAPS;
  }
}

// ========= INDICATEURS =========

function rsi(values, period=14){
  if (!values || values.length < period+1) return null;
  let gains=0, losses=0;

  for(let i=1;i<=period;i++){
    const diff = values[i]-values[i-1];
    if(diff>=0) gains += diff;
    else losses -= diff;
  }

  gains /= period;
  losses = (losses/period) || 1e-9;

  let rs = gains / losses;
  let rsiVal = 100 - 100/(1+rs);

  for(let i=period+1;i<values.length;i++){
    const diff = values[i]-values[i-1];
    gains = (gains*(period-1)+Math.max(diff,0))/period;
    losses = ((losses*(period-1)+Math.max(-diff,0))/period) || 1e-9;
    rs = gains / losses;
    rsiVal = 100 - 100/(1+rs);
  }

  return rsiVal;
}

function vwap(candles){
  let pv=0, vol=0;
  for(const c of candles){
    const price=(c.h+c.l+c.c)/3;
    pv += price*c.v;
    vol += c.v;
  }
  return vol ? pv/vol : null;
}

function calcWicks(candle){
  if (!candle) return {upper:0,lower:0};
  const top = Math.max(candle.o,candle.c);
  const bottom = Math.min(candle.o,candle.c);
  return {
    upper: ((candle.h-top)/candle.c)*100,
    lower: ((bottom-candle.l)/candle.c)*100
  };
}

// ========= PROCESS PAIR =========

async function processDegen(symbol){
  const [tk, depth] = await Promise.all([
    getTicker(symbol),
    getDepth(symbol)
  ]);

  if (!tk) return null;

  // Même logique que Discovery : on prend le premier champ disponible
  const last =
    (tk.lastPr    != null ? +tk.lastPr    : NaN) ||
    (tk.markPrice != null ? +tk.markPrice : NaN) ||
    (tk.close     != null ? +tk.close     : NaN) ||
    (tk.last      != null ? +tk.last      : NaN);

  if(!last || Number.isNaN(last)) return null;

  const high24 = tk.high24h != null ? +tk.high24h : null;
  const low24  = tk.low24h  != null ? +tk.low24h  : null;
  const volaPct = (high24 != null && low24 != null)
    ? ((high24-low24)/last)*100
    : null;

  const change24 = tk.change24h != null ? +tk.change24h : 0;

  // 5m et 15m
  const [c5m, c15m] = await Promise.all([
    getCandles(symbol,300,100),
    getCandles(symbol,900,100)
  ]);

  if (!c5m?.length || !c15m?.length) return null;

  const closes5  = c5m.map(x=>x.c);
  const closes15 = c15m.map(x=>x.c);

  const rsi5  = rsi(closes5);
  const rsi15 = rsi(closes15);

  const vwap5 = vwap(c5m.slice(-24));
  const priceVsVwap = vwap5 ? ((last-vwap5)/vwap5)*100 : 0;

  const currentCandle = c5m[c5m.length-1];
  const wicks = calcWicks(currentCandle);

  const lastVol = currentCandle.v;
  const avgVol  = c5m.slice(-11,-1).reduce((a,b)=>a+b.v,0)/10;
  const volRatio = avgVol>0 ? lastVol/avgVol : 1;

  let obScore=0, bidsVol=0, asksVol=0;
  if (depth){
    const bidsArr = depth.bids || [];
    const asksArr = depth.asks || [];
    bidsVol = bidsArr.slice(0,10).reduce((a,x)=>a+(+x[1]),0);
    asksVol = asksArr.slice(0,10).reduce((a,x)=>a+(+x[1]),0);

    if (asksVol > 0){
      const r = bidsVol/asksVol;
      if (r>1.25) obScore = 1;
      else if (r<0.75) obScore = -1;
    }
  }

  // DEBUG léger pour vérifier que tout est OK
  if (DEBUG){
    console.log(
      `[DEGEN DEBUG] ${symbol} | last=${num(last,6)} | vola=${num(volaPct,2)} | volRatio=${num(volRatio,2)} | ΔVWAP=${num(priceVsVwap,2)} | rsi5=${num(rsi5,1)} | rsi15=${num(rsi15,1)}`
    );
  }

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
    bidsVol,
    asksVol,
    wicks
  };
}

// ========= ANALYZE CANDIDATE (tes filtres, inchangés) =========

function analyzeCandidate(rec, btcChange) {
  if (!rec || btcChange == null || isNaN(btcChange)) return null;
  if (rec.volaPct == null) return null;

  const vola     = rec.volaPct;
  const volRatio = rec.volRatio;
  const gapAbs   = Math.abs(rec.priceVsVwap);

  // HARD FILTERS
  if (volRatio < 3.5) return null;
  if (vola < 4 || vola > 25) return null;
  if (gapAbs < 1.0 || gapAbs > 3.5) return null;

  const absBTC = Math.abs(btcChange);
  if (absBTC < BTC_TREND_ABS_MIN || absBTC > BTC_TREND_ABS_MAX) return null;

  let direction = null;
  if (rec.priceVsVwap > 0) direction = "LONG";
  else if (rec.priceVsVwap < 0) direction = "SHORT";
  else return null;

  if (rec.rsi5 == null || rec.rsi15 == null) return null;

  const r5  = rec.rsi5;
  const r15 = rec.rsi15;

  const wU = rec.wicks.upper;
  const wL = rec.wicks.lower;

  const obScore = rec.obScore;

  // Direction filters
  if (direction === "LONG") {
    if (btcChange < BTC_LONG_MIN || btcChange > BTC_LONG_MAX) return null;
    if (r5 < 50 || r5 > 75) return null;
    if (r15 < 45 || r15 > 70) return null;
    if (wU > 1.2) return null;
    if (obScore < 0) return null;
  } else {
    if (btcChange > BTC_SHORT_MAX || btcChange < BTC_SHORT_MIN) return null;
    if (r5 < 25 || r5 > 50) return null;
    if (r15 < 30 || r15 > 55) return null;
    if (wL > 1.2) return null;
    if (obScore > 0) return null;
  }

  // SCORE 0–100
  let score = 0;

  // Volume Spike
  score += clamp(10 + (volRatio - 3.5) * 8, 0, 30);

  // VWAP Gap
  let scoreGap = 5;
  if (gapAbs >= 1.2 && gapAbs <= 2.4) scoreGap = 20;
  else if (gapAbs > 2.4 && gapAbs <= 3.5) scoreGap = 12;
  score += scoreGap;

  // RSI
  let scoreRsi = 0;
  if (direction === "LONG") {
    if (r5 >= 55 && r5 <= 70 && r15 >= 50 && r15 <= 65) scoreRsi = 15;
    else if (r5 > 50 && r15 > 45) scoreRsi = 7;
  } else {
    if (r5 >= 30 && r5 <= 45 && r15 >= 35 && r15 <= 50) scoreRsi = 15;
    else if (r5 < 50 && r15 < 55) scoreRsi = 7;
  }
  score += scoreRsi;

  // Orderbook
  let scoreOB = 0;
  const obRatio = rec.asksVol > 0 ? rec.bidsVol / rec.asksVol : 1;

  if (direction === "LONG") {
    if (obScore === 1 && obRatio >= 1.3) scoreOB = 15;
    else if (obScore === 1) scoreOB = 8;
  } else {
    if (obScore === -1 && obRatio <= 0.77) scoreOB = 15;
    else if (obScore === -1) scoreOB = 8;
  }
  score += scoreOB;

  // Trend 24h
  let scoreTrend = 0;
  const ch24 = rec.change24;

  if (direction === "LONG") {
    if (ch24 > 8) scoreTrend = 10;
    else if (ch24 > 4) scoreTrend = 6;
  } else {
    if (ch24 < -8) scoreTrend = 10;
    else if (ch24 < -4) scoreTrend = 6;
  }
  score += scoreTrend;

  // BTC Context
  let scoreBTC = 0;
  if (direction === "LONG") {
    if (btcChange >= 0.5 && btcChange <= 1.8) scoreBTC = 10;
    else if (btcChange >= 0.2 && btcChange <= 2.0) scoreBTC = 6;
  } else {
    if (btcChange <= -0.5 && btcChange >= -1.8) scoreBTC = 10;
    else if (btcChange <= -0.2 && btcChange >= -2.0) scoreBTC = 6;
  }
  score += scoreBTC;

  // Wicks bonus/malus
  if (direction === "LONG") {
    if (wU < 0.6) score += 5;
    else if (wU > 1.0) score -= 5;
  } else {
    if (wL < 0.6) score += 5;
    else if (wL > 1.0) score -= 5;
  }

  const DEGEN_SCORE = clamp(Math.round(score), 0, 100);
  if (DEGEN_SCORE < 88) return null;

  return {
    symbol: rec.symbol,
    direction,
    score: DEGEN_SCORE,
    volRatio: rec.volRatio,
    vola: rec.volaPct,
    priceVsVwap: rec.priceVsVwap,
    last: rec.last
  };
}

// ========= TELEGRAM =========

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
  }catch(e){
    console.error("Telegram error:", e?.message || e);
  }
}

function checkAntiSpam(symbol, direction){
  const key = `${symbol}-${direction}`;
  const now = Date.now();
  const last = lastAlerts.get(key);
  if (last && now-last < MIN_ALERT_DELAY_MS) return false;
  lastAlerts.set(key, now);
  return true;
}

// ========= MAIN LOOP =========

async function scanDegen(){
  const now = Date.now();

  if (now - lastSymbolUpdate > SYMBOL_UPDATE_INTERVAL || !DEGEN_SYMBOLS.length){
    DEGEN_SYMBOLS = await updateDegenList();
    lastSymbolUpdate = now;
  }

  const btcChange = await getBTCTrend();
  if (btcChange == null || isNaN(btcChange)){
    console.log("⚠️ BTC DATA ERROR (API Issue).");
    return;
  }

  console.log(`🎯 DEGEN v1.3 (API v2 Futures) | BTC: ${btcChange.toFixed(2)}% | Symbols: ${DEGEN_SYMBOLS.length}`);

  const candidates = [];
  const BATCH = 5;

  for (let i=0; i<DEGEN_SYMBOLS.length; i+=BATCH){
    const batch = DEGEN_SYMBOLS.slice(i,i+BATCH);
    const results = await Promise.all(batch.map(s=>processDegen(s)));
    for (const r of results){
      const s = analyzeCandidate(r, btcChange);
      if (s) candidates.push(s);
    }
    await sleep(300);
  }

  if (!candidates.length){
    console.log("ℹ️ Aucun signal DEGEN.");
    return;
  }

  const best = candidates.sort((a,b)=>{
    if (b.score !== a.score) return b.score - a.score;
    return (+b.volRatio) - (+a.volRatio);
  })[0];

  if ((now - lastGlobalTradeTime) < GLOBAL_COOLDOWN_MS){
    console.log(`⏳ Cooldown : signal ${best.symbol} ignoré (Score: ${best.score}).`);
    return;
  }

  if (!checkAntiSpam(best.symbol, best.direction)){
    console.log(`⏳ Anti-spam : ${best.symbol} ignoré.`);
    return;
  }

  const emoji = best.direction === "LONG" ? "🔫🟢" : "🔫🔴";

  const msg =
`🎯 *DEGEN v1.3 (API v2 Futures)*

${emoji} *${best.symbol}* — ${best.direction}
🏅 *Score:* ${best.score}/100

📊 *Vol Spike:* x${num(best.volRatio, 2)}
🌡️ *Vola24:* ${num(best.vola, 2)}%
📉 *ΔVWAP:* ${num(best.priceVsVwap,2)}%

💰 *Prix:* ${best.last}

_Wait for limit. No FOMO._`;

  await sendTelegram(msg);
  console.log(`✅ SHOT : ${best.symbol} [${best.direction}] Score:${best.score}`);
  lastGlobalTradeTime = now;
}

async function main(){
  console.log("🔫 DEGEN v1.3 (API v2 Futures + Discovery-style) démarré.");
  await sendTelegram("🔫 *DEGEN v1.3 (API v2 Futures)* activé.");
  while(true){
    try { await scanDegen(); }
    catch(e){ console.error("DEGEN crash:", e); }
    await sleep(SCAN_INTERVAL_MS);
  }
}

export const startDegen = main;