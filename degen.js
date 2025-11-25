// degen.js — JTF DEGEN v1.1 Ultra-Sniper
// Lowcaps Momentum Sniper — très peu de signaux, mais "balles en or".

import fetch from "node-fetch";
import fs from "fs";

// ========= LOAD JSON (Top30 + Discovery) =========

function loadJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

const top30 = loadJson("./config/top30.json");

function getDiscoveryList() {
  try {
    return loadJson("./config/discovery_list.json");
  } catch (e) {
    console.log("⚠️ discovery_list.json introuvable — fallback []");
    return [];
  }
}

// ========= CONFIG =========

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

const SCAN_INTERVAL_MS      = 5 * 60_000;   // Scan toutes les 5 min
const MIN_ALERT_DELAY_MS    = 15 * 60_000;  // Anti-spam par paire
const GLOBAL_COOLDOWN_MS    = 30 * 60_000;  // Cooldown global entre 2 tirs
const SYMBOL_UPDATE_INTERVAL = 60 * 60_000; // Refresh liste lowcaps : 1h

// Contexte BTC
const BTC_TREND_ABS_MIN   = 0.2;  // en dessous : marché trop mort
const BTC_TREND_ABS_MAX   = 2.5;  // au dessus : trop violent

const BTC_LONG_MIN  = 0.2;
const BTC_LONG_MAX  = 2.0;
const BTC_SHORT_MIN = -2.0;
const BTC_SHORT_MAX = -0.2;

// ========= ÉTAT =========

let DEGEN_SYMBOLS = [];
let lastSymbolUpdate   = 0;
let lastGlobalTradeTime = 0;
const lastAlerts = new Map();

// Fallback si API tickers KO
const FALLBACK_LOWCAPS = [
  "MAGICUSDT_UMCBL","GALAUSDT_UMCBL","ONEUSDT_UMCBL",
  "CELOUSDT_UMCBL","KAVAUSDT_UMCBL"
];

// À exclure (Top majors + déjà couverts ailleurs)
const IGNORE_LIST = [
  "BTCUSDT_UMCBL","ETHUSDT_UMCBL","BNBUSDT_UMCBL","SOLUSDT_UMCBL","XRPUSDT_UMCBL",
  "ADAUSDT_UMCBL","DOGEUSDT_UMCBL","AVAXUSDT_UMCBL","DOTUSDT_UMCBL","TRXUSDT_UMCBL",
  "LINKUSDT_UMCBL","TONUSDT_UMCBL","SUIUSDT_UMCBL","APTUSDT_UMCBL","NEARUSDT_UMCBL",
  "ARBUSDT_UMCBL","OPUSDT_UMCBL","INJUSDT_UMCBL","ATOMUSDT_UMCBL","AAVEUSDT_UMCBL",
  "LTCUSDT_UMCBL","UNIUSDT_UMCBL","FILUSDT_UMCBL","XLMUSDT_UMCBL","RUNEUSDT_UMCBL",
  "ALGOUSDT_UMCBL","PEPEUSDT_UMCBL","WIFUSDT_UMCBL","TIAUSDT_UMCBL","SEIUSDT_UMCBL"
];

// ========= UTILS =========

const sleep  = (ms) => new Promise(res => setTimeout(res, ms));
const num    = (v,d=4)=>v==null?null:+(+v).toFixed(d);
const clamp  = (x,min,max)=>Math.max(min,Math.min(max,x));
const baseSymbol = s => s.replace("_UMCBL","");

async function safeGetJson(url){
  try {
    const r = await fetch(url, { headers:{ Accept:"application/json" } });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// ========= API BITGET =========

async function getCandles(symbol, seconds, limit=100){
  const base = baseSymbol(symbol);
  // v2
  let j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/candles?symbol=${base}&granularity=${seconds}&productType=usdt-futures&limit=${limit}`
  );
  if (j?.data?.length) {
    return j.data
      .map(c=>({ t:+c[0],o:+c[1],h:+c[2],l:+c[3],c:+c[4],v:+c[5] }))
      .sort((a,b)=>a.t-b.t);
  }
  // fallback v1
  j = await safeGetJson(
    `https://api.bitget.com/api/mix/v1/market/candles?symbol=${symbol}&granularity=${seconds}&limit=${limit}`
  );
  if (j?.data?.length) {
    return j.data
      .map(c=>({ t:+c[0],o:+c[1],h:+c[2],l:+c[3],c:+c[4],v:+c[5] }))
      .sort((a,b)=>a.t-b.t);
  }
  return [];
}

async function getBTCTrend() {
  const MAX_RETRIES = 3;
  for (let i = 0; i < MAX_RETRIES; i++) {
    const candles = await getCandles("BTCUSDT_UMCBL", 3600, 5);
    if (candles && candles.length >= 2) {
      const current = candles[candles.length - 1];
      const open = current.o;
      const close = current.c;
      if (!open) return 0;
      return ((close - open) / open) * 100;
    }
    if (i < MAX_RETRIES - 1) await sleep(2000);
  }
  return null;
}

async function updateDegenList() {
  try {
    const j = await safeGetJson("https://api.bitget.com/api/mix/v1/market/tickers?productType=umcbl");
    if (!j?.data) return FALLBACK_LOWCAPS;

    const discoveryList = getDiscoveryList();

    const valid = j.data.filter(t =>
      t.symbol.endsWith("_UMCBL") &&
      !t.symbol.startsWith("USDC") &&
      (+t.usdtVolume > 3_000_000) &&            // plus strict
      !IGNORE_LIST.includes(t.symbol)
    );

    valid.sort((a,b) => (+b.usdtVolume) - (+a.usdtVolume));

    let lowCaps = valid.map(t => t.symbol);

    // Filtrage automatique : exclure Top30 + Discovery
    lowCaps = lowCaps.filter(sym =>
      !top30.includes(sym) &&
      !discoveryList.includes(sym)
    );

    // Limiter à ~30 paires max
    lowCaps = lowCaps.slice(0, 30);

    console.log(`🔄 DEGEN v1.1 List (filtrée): ${lowCaps.length} paires.`);
    return lowCaps.length >= 5 ? lowCaps : FALLBACK_LOWCAPS;

  } catch (e) {
    console.log("⚠️ updateDegenList ERROR, fallback:", e?.message || e);
    return FALLBACK_LOWCAPS;
  }
}

async function getTicker(symbol){
  const j = await safeGetJson(`https://api.bitget.com/api/mix/v1/market/ticker?symbol=${symbol}`);
  return j?.data ?? null;
}

async function getFunding(symbol){
  const j = await safeGetJson(`https://api.bitget.com/api/mix/v1/market/currentFundRate?symbol=${symbol}`);
  return j?.data ?? null;
}

async function getDepth(symbol){
  const j = await safeGetJson(`https://api.bitget.com/api/mix/v1/market/depth?symbol=${symbol}&limit=20`);
  return (j?.data?.bids && j?.data?.asks) ? j.data : null;
}

// ========= INDICATEURS =========

function rsi(c,p=14){
  if (c.length < p+1) return null;
  let g=0,l=0;
  for (let i=1;i<=p;i++){
    const d=c[i]-c[i-1];
    if (d>=0) g+=d; else l-=d;
  }
  g/=p; l=(l/p)||1e-9;
  let rs=g/l;
  let v=100-100/(1+rs);
  for(let i=p+1;i<c.length;i++){
    const d=c[i]-c[i-1];
    g=(g*(p-1)+Math.max(d,0))/p;
    l=((l*(p-1)+Math.max(-d,0))/p)||1e-9;
    rs=g/l;
    v=100-100/(1+rs);
  }
  return v;
}

function vwap(c){
  let pv=0,v=0;
  for(const x of c){
    const p=(x.h+x.l+x.c)/3;
    pv+=p*x.v;
    v+=x.v;
  }
  return v ? pv/v : null;
}

// Fonction pour calculer la taille des mèches (%)
function calcWicks(candle) {
  if (!candle) return { upper:0, lower:0 };
  const bodyTop = Math.max(candle.o, candle.c);
  const bodyBot = Math.min(candle.o, candle.c);
  const upper = ((candle.h - bodyTop) / candle.c) * 100;
  const lower = ((bodyBot - candle.l) / candle.c) * 100;
  return { upper, lower };
}

// ========= TRAITEMENT PAIRE =========

async function processDegen(symbol) {
  const [tk, , depth] = await Promise.all([
    getTicker(symbol),
    getFunding(symbol),  // réservé pour v1.2 si besoin
    getDepth(symbol)
  ]);
  if (!tk) return null;

  const last = +tk.last;
  const high24 = +tk.high24h;
  const low24  = +tk.low24h;
  const volaPct = last ? ((high24 - low24)/last)*100 : null;
  const change24 = tk.priceChangePercent != null ? (+tk.priceChangePercent)*100 : null;

  const [c5m, c15m] = await Promise.all([
    getCandles(symbol, 300, 100),
    getCandles(symbol, 900, 100)
  ]);
  if (c5m.length < 50 || c15m.length < 20) return null;

  const closes5  = c5m.map(x=>x.c);
  const closes15 = c15m.map(x=>x.c);
  const rsi5  = rsi(closes5,14);
  const rsi15 = rsi(closes15,14);

  const vwap5 = vwap(c5m.slice(-24));
  const priceVsVwap = vwap5 ? ((last - vwap5)/vwap5)*100 : 0;

  const currentCandle = c5m[c5m.length-1];
  const wicks = calcWicks(currentCandle);

  const lastVol = c5m[c5m.length-1].v;
  const avgVol  = c5m.slice(-11,-1).reduce((a,b)=>a+b.v,0)/10;
  const volRatio = avgVol>0 ? lastVol/avgVol : 1;

  let obScore=0, bidsVol=0, asksVol=0;
  if (depth) {
    bidsVol = depth.bids.slice(0,10).reduce((a,x)=>a+(+x[1]),0);
    asksVol = depth.asks.slice(0,10).reduce((a,x)=>a+(+x[1]),0);
    if (asksVol > 0) {
      const r = bidsVol/asksVol;
      if (r > 1.25) obScore = 1;
      else if (r < 0.75) obScore = -1;
    }
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

// ========= CERVEAU SNIPER v1.1 =========

function analyzeCandidate(rec, btcChange) {
  if (!rec || btcChange == null || isNaN(btcChange)) return null;
  if (rec.volaPct == null) return null;

  const vola = rec.volaPct;
  const volRatio = rec.volRatio;
  const gapAbs = Math.abs(rec.priceVsVwap);

  // --- HARD FILTERS GLOBAUX ---

  // Volume Spike très strict
  if (volRatio < 3.5) return null;

  // Volatilité 24h : 4–25%
  if (vola < 4 || vola > 25) return null;

  // Gap VWAP : 1.0–3.5%
  if (gapAbs < 1.0 || gapAbs > 3.5) return null;

  // BTC : pas trop mort ni trop violent
  const absBtc = Math.abs(btcChange);
  if (absBtc < BTC_TREND_ABS_MIN || absBtc > BTC_TREND_ABS_MAX) return null;

  // --- DÉTERMINATION DIRECTION ---
  let direction = null;
  if (rec.priceVsVwap > 0) direction = "LONG";
  else if (rec.priceVsVwap < 0) direction = "SHORT";
  else return null;

  // RSI requis
  if (rec.rsi5 == null || rec.rsi15 == null) return null;
  const r5  = rec.rsi5;
  const r15 = rec.rsi15;

  // Wicks
  const wU = rec.wicks.upper;
  const wL = rec.wicks.lower;

  // OB
  const obScore = rec.obScore;

  // --- HARD FILTERS DIRECTIONNELS ---

  if (direction === "LONG") {
    // BTC doit être gentil haussier
    if (btcChange < BTC_LONG_MIN || btcChange > BTC_LONG_MAX) return null;
    // RSI 5m/15m dans les plages
    if (r5 < 50 || r5 > 75) return null;
    if (r15 < 45 || r15 > 70) return null;
    // Mèches hautes pas trop violentes
    if (wU > 1.2) return null;
    // Orderbook pas bearish
    if (obScore < 0) return null;
  } else { // SHORT
    if (btcChange > BTC_SHORT_MAX || btcChange < BTC_SHORT_MIN) return null;
    if (r5 < 25 || r5 > 50) return null;
    if (r15 < 30 || r15 > 55) return null;
    if (wL > 1.2) return null;
    if (obScore > 0) return null;
  }

  // --- SCORING DEGEN_SCORE (0-100) ---

  let score = 0;

  // M1 — Volume Spike (0–30)
  const scoreVol = clamp(10 + (volRatio - 3.5)*8, 0, 30);
  score += scoreVol;

  // M2 — Gap VWAP (0–20)
  let scoreGap = 5;
  if (gapAbs >= 1.2 && gapAbs <= 2.4) scoreGap = 20;
  else if (gapAbs > 2.4 && gapAbs <= 3.5) scoreGap = 12;
  score += scoreGap;

  // M3 — RSI Alignment (0–15)
  let scoreRsi = 0;
  if (direction === "LONG") {
    if (r5 >= 55 && r5 <= 70 && r15 >= 50 && r15 <= 65) scoreRsi = 15;
    else if (r5 > 50 && r15 > 45) scoreRsi = 7;
  } else {
    if (r5 >= 30 && r5 <= 45 && r15 >= 35 && r15 <= 50) scoreRsi = 15;
    else if (r5 < 50 && r15 < 55) scoreRsi = 7;
  }
  score += scoreRsi;

  // M4 — Orderbook (0–15)
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

  // M5 — Trend 24h (0–10)
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

  // M6 — Contexte BTC (0–10)
  let scoreBTC = 0;
  if (direction === "LONG") {
    if (btcChange >= 0.5 && btcChange <= 1.8) scoreBTC = 10;
    else if (btcChange >= 0.2 && btcChange <= 2.0) scoreBTC = 6;
  } else {
    if (btcChange <= -0.5 && btcChange >= -1.8) scoreBTC = 10;
    else if (btcChange <= -0.2 && btcChange >= -2.0) scoreBTC = 6;
  }
  score += scoreBTC;

  // M7 — Wicks Bonus/Malus (±10)
  if (direction === "LONG") {
    if (wU < 0.6) score += 5;
    else if (wU > 1.0) score -= 5;
  } else {
    if (wL < 0.6) score += 5;
    else if (wL > 1.0) score -= 5;
  }

  const DEGEN_SCORE = clamp(Math.round(score), 0, 100);

  // Seuil ultra strict
  if (DEGEN_SCORE < 88) return null;

  // --- PLAN DE TRADE ---

  const gap = gapAbs;
  let pullbackFactor = clamp(gap / 3, 0.4, 1.2);

  if (DEGEN_SCORE >= 95 || volRatio >= 6.5) {
    pullbackFactor = Math.max(0.3, pullbackFactor - 0.2);
  }

  let limitEntry;
  if (direction === "LONG") {
    limitEntry = rec.last * (1 - pullbackFactor/100);
  } else {
    limitEntry = rec.last * (1 + pullbackFactor/100);
  }

  const slPct = clamp(vola / 3.5, 3.0, 7.0);
  const tpPct = slPct * 2.2; // R:R ≈ 1:2.2

  const sl = direction === "LONG"
    ? rec.last * (1 - slPct/100)
    : rec.last * (1 + slPct/100);

  const tp = direction === "LONG"
    ? rec.last * (1 + tpPct/100)
    : rec.last * (1 - tpPct/100);

  let levier;
  if (vola <= 8) levier = "3x";
  else if (vola <= 16) levier = "2x";
  else levier = "1-2x";

  const obRatioStr = rec.asksVol > 0 ? obRatio.toFixed(2) : "N/A";

  let mainReason = "Momentum";
  if (volRatio > 6) mainReason = "Volume Nuke";
  else if (gapAbs > 2.2) mainReason = "VWAP Breakout";
  else if (Math.abs(ch24 || 0) > 10) mainReason = "Trend Continuation";

  const decimals = rec.last < 1 ? 5 : 3;

  const rr = (tpPct / slPct);

  return {
    symbol: rec.symbol,
    direction,
    score: DEGEN_SCORE,
    reason: mainReason,
    price: num(rec.last, decimals),
    limitEntry: num(limitEntry, decimals),
    sl: num(sl, decimals),
    tp: num(tp, decimals),
    riskPct: num(slPct, 2),
    rr: num(rr, 2),
    volRatio: num(volRatio,1),
    vola: num(vola,1),
    obRatio: obRatioStr,
    btcChange: btcChange.toFixed(2),
    gapVWAP: num(rec.priceVsVwap,2),
    levier
  };
}

// ========= TELEGRAM & ANTI-SPAM =========

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
  if (last && (now - last < MIN_ALERT_DELAY_MS)) return false;
  lastAlerts.set(key, now);
  return true;
}

// ========= BOUCLE PRINCIPALE =========

async function scanDegen(){
  const now = Date.now();
  const btcChange = await getBTCTrend();

  if (btcChange == null || isNaN(btcChange)) {
    console.error("⚠️ BTC DATA ERROR : Scan Degen annulé.");
    return;
  }

  if (now - lastSymbolUpdate > SYMBOL_UPDATE_INTERVAL || DEGEN_SYMBOLS.length === 0) {
    DEGEN_SYMBOLS = await updateDegenList();
    lastSymbolUpdate = now;
  }

  const cooldownSec = Math.max(0, Math.floor((GLOBAL_COOLDOWN_MS - (now - lastGlobalTradeTime))/1000));
  console.log(
    `🎯 DEGEN v1.1 | BTC: ${btcChange.toFixed(2)}% | Symbols: ${DEGEN_SYMBOLS.length} | Global cooldown: ${cooldownSec}s`
  );

  const BATCH_SIZE = 5;
  const candidates = [];

  for (let i = 0; i < DEGEN_SYMBOLS.length; i += BATCH_SIZE) {
    const batch = DEGEN_SYMBOLS.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(s => processDegen(s).catch(() => null))
    );
    for (const r of results) {
      const s = analyzeCandidate(r, btcChange);
      if (s) candidates.push(s);
    }
    await sleep(400);
  }

  if (!candidates.length) {
    console.log("ℹ️ DEGEN v1.1 : aucun signal valide sur ce scan.");
    return;
  }

  // SINGLE SHOT : meilleur score, puis plus gros volRatio en cas d'égalité
  const best = candidates.sort((a,b)=>{
    if (b.score !== a.score) return b.score - a.score;
    return (+b.volRatio || 0) - (+a.volRatio || 0);
  })[0];

  const timeSinceLast = now - lastGlobalTradeTime;
  if (timeSinceLast < GLOBAL_COOLDOWN_MS) {
    console.log(`⏳ DEGEN v1.1: Signal ${best.symbol} (Score ${best.score}) ignoré (cooldown global).`);
    return;
  }

  if (!checkAntiSpam(best.symbol, best.direction)) {
    console.log(`⏳ DEGEN v1.1: Signal ${best.symbol} ignoré par anti-spam.`);
    return;
  }

  const emoji    = best.direction === "LONG" ? "🔫 🟢" : "🔫 🔴";
  const riskEmoji = (+best.volRatio || 0) > 6 ? "☢️" : "⚡";

  const msg =
`🎯 *JTF DEGEN v1.1 (Ultra-Sniper)* ${riskEmoji}

${emoji} *${best.symbol}* — ${best.direction}
🏅 *Score:* ${best.score}/100
🔎 *Setup:* ${best.reason}

📉 *Limit Entry:* ${best.limitEntry}
🔹 Market: ${best.price}

🎯 TP: ${best.tp}
🛑 SL: ${best.sl} (-${best.riskPct}%)
📏 *R:R:* ${best.rr}

⚖️ *Levier conseillé:* ${best.levier} (Isolated)
📊 *Vol Spike:* x${best.volRatio} | *Vola24:* ${best.vola}%
📚 *OB Ratio:* ${best.obRatio}
₿ *BTC 1h:* ${best.btcChange}% | *ΔVWAP5m:* ${best.gapVWAP}%

_Wait for limit. No FOMO._`;

  await sendTelegram(msg);
  console.log(`✅ DEGEN v1.1 SHOT: ${best.symbol} (Score ${best.score})`);
  lastGlobalTradeTime = now;
}

async function main(){
  console.log("🔫 JTF DEGEN v1.1 (Ultra-Sniper) démarré.");
  await sendTelegram("🔫 *JTF DEGEN v1.1 (Ultra-Sniper)* activé.\nTrès peu de signaux, mais " +
                     "forte sélectivité. Scan toutes les 5 minutes.");

  while(true){
    try {
      await scanDegen();
    } catch(e) {
      console.error("Degen Crash:", e);
    }
    await sleep(SCAN_INTERVAL_MS);
  }
}

export const startDegen = main;