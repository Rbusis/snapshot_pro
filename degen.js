// degen.js — JTF DEGEN v1.1 Ultra-Sniper (API v2 FIXED)
// Lowcaps Momentum Sniper — très peu de signaux, mais "balles en or".

import fetch from "node-fetch";
import fs from "fs";

// ========= LOAD JSON =========

function loadJson(path) {
  try {
    if (fs.existsSync(path)) {
      return JSON.parse(fs.readFileSync(path, "utf8"));
    }
  } catch (e) {
    console.error(`⚠️ Erreur lecture ${path}:`, e.message);
  }
  return []; // Retourne un tableau vide par défaut si erreur ou pas de fichier
}

// Assure-toi que ces fichiers existent ou que la fonction gère le vide
const top30 = loadJson("./config/top30.json");

function getDiscoveryList() {
  return loadJson("./config/discovery_list.json");
}

// ========= CONFIG =========

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

const SCAN_INTERVAL_MS      = 5 * 60_000;
const MIN_ALERT_DELAY_MS    = 15 * 60_000;
const GLOBAL_COOLDOWN_MS    = 30 * 60_000;
const SYMBOL_UPDATE_INTERVAL = 60 * 60_000;

// BTC context limits
const BTC_TREND_ABS_MIN   = 0.2;
const BTC_TREND_ABS_MAX   = 2.5;

const BTC_LONG_MIN  = 0.2;
const BTC_LONG_MAX  = 2.0;
const BTC_SHORT_MIN = -2.0;
const BTC_SHORT_MAX = -0.2;

// Mapping Granularity pour Bitget API v2
const TIME_MAP = {
  60: "1m",
  300: "5m",
  900: "15m",
  3600: "1H",
  14400: "4H",
  86400: "1D"
};

// ========= STATE =========

let DEGEN_SYMBOLS = [];
let lastSymbolUpdate   = 0;
let lastGlobalTradeTime = 0;
const lastAlerts = new Map();

// Fallback lowcaps
const FALLBACK_LOWCAPS = [
  "MAGICUSDT_UMCBL","GALAUSDT_UMCBL","ONEUSDT_UMCBL",
  "CELOUSDT_UMCBL","KAVAUSDT_UMCBL"
];

// Exclusions
const IGNORE_LIST = [
  "BTCUSDT_UMCBL","ETHUSDT_UMCBL","BNBUSDT_UMCBL","SOLUSDT_UMCBL","XRPUSDT_UMCBL",
  "ADAUSDT_UMCBL","DOGEUSDT_UMCBL","AVAXUSDT_UMCBL","DOTUSDT_UMCBL","TRXUSDT_UMCBL",
  "LINKUSDT_UMCBL","TONUSDT_UMCBL","SUIUSDT_UMCBL","APTUSDT_UMCBL","NEARUSDT_UMCBL",
  "ARBUSDT_UMCBL","OPUSDT_UMCBL","INJUSDT_UMCBL","ATOMUSDT_UMCBL","AAVEUSDT_UMCBL",
  "LTCUSDT_UMCBL","UNIUSDT_UMCBL","FILUSDT_UMCBL","XLMUSDT_UMCBL","RUNEUSDT_UMCBL",
  "ALGOUSDT_UMCBL","PEPEUSDT_UMCBL","WIFUSDT_UMCBL","TIAUSDT_UMCBL","SEIUSDT_UMCBL"
];

// ========= UTILS =========

const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const num   = (v,d=4)=>v==null?null:+(+v).toFixed(d);
const clamp = (x,min,max)=>Math.max(min,Math.min(max,x));

// Nettoie le symbole pour les appels API qui demandent la base (ex: BTCUSDT)
const baseSymbol = s => s.replace("_UMCBL","");
// Assure le format interne (ex: BTCUSDT_UMCBL)
const formatSymbol = s => s.endsWith("_UMCBL") ? s : `${s}_UMCBL`;

async function safeGetJson(url){
  try {
    const r = await fetch(url, { headers:{ Accept:"application/json" }, timeout: 5000 });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// ========= API BITGET (v2 ONLY) =========

async function getCandles(symbol, seconds, limit=100){
  const base = baseSymbol(symbol);
  // Conversion explicite secondes -> string pour API v2
  const granularity = TIME_MAP[seconds] || "5m"; 

  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/candles?symbol=${base}&granularity=${granularity}&productType=usdt-futures&limit=${limit}`
  );
  if (!j?.data?.length) return [];
  
  // Format v2 : [ts, o, h, l, c, vol(base), vol(quote)...]
  return j.data.map(c => ({
    t:+c[0], o:+c[1], h:+c[2], l:+c[3], c:+c[4], v:+c[5]
  })).sort((a,b)=>a.t-b.t);
}

async function getTicker(symbol){
  const base = baseSymbol(symbol);
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/ticker?symbol=${base}&productType=usdt-futures`
  );
  // Endpoint ticker renvoie un objet ou un tableau selon le endpoint exact, ici on attend data[0] ou data
  if (Array.isArray(j?.data)) return j.data[0];
  return j?.data ?? null;
}

async function getFunding(symbol){
  const base = baseSymbol(symbol);
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/current-fund-rate?symbol=${base}&productType=usdt-futures`
  );
  // Parfois data est un tableau, parfois un objet
  if (Array.isArray(j?.data)) return j.data[0];
  return j?.data ?? null;
}

async function getDepth(symbol){
  const base = baseSymbol(symbol);
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/depth?symbol=${base}&limit=20&productType=usdt-futures`
  );
  return (j?.data?.bids && j?.data?.asks) ? j.data : null;
}

async function fetchAllTickers(){
  const j = await safeGetJson(
    "https://api.bitget.com/api/v2/mix/market/tickers?productType=usdt-futures"
  );
  return j?.data ?? [];
}

// ========= BTC TREND =========

async function getBTCTrend() {
  // Utilise 3600s -> '1H' via TIME_MAP
  const candles = await getCandles("BTCUSDT_UMCBL", 3600, 5);
  if (!candles || candles.length < 2) return null;
  const last = candles[candles.length-1];
  return ((last.c - last.o)/last.o)*100;
}

// ========= LISTE DEGEN =========

async function updateDegenList(){
  try {
    const all = await fetchAllTickers();
    if (!all.length) return FALLBACK_LOWCAPS;

    const discovery = getDiscoveryList();

    // Filtre et normalisation
    let valid = all.filter(t => {
      // Vérif si USDT
      const isUSDT = t.symbol.includes("USDT");
      // Volume > 3M
      const hasVol = (+t.usdtVolume > 3_000_000);
      
      // Reconstruction du nom complet pour check IGNORE_LIST
      const fullSym = formatSymbol(t.symbol);
      
      return isUSDT && hasVol && !IGNORE_LIST.includes(fullSym);
    });

    // Tri par volume
    valid.sort((a,b)=>(+b.usdtVolume) - (+a.usdtVolume));

    // Conversion en tableau de strings normalisées
    let lowCaps = valid.map(t => formatSymbol(t.symbol));

    // Exclusion Top30 et Discovery
    lowCaps = lowCaps.filter(sym =>
      !top30.includes(sym) &&
      !discovery.includes(sym)
    );

    // On garde le top 30 des "non-top30"
    lowCaps = lowCaps.slice(0,30);

    console.log(`🔄 DEGEN v1.1 (v2 API) lowcaps: ${lowCaps.length} paires.`);
    return lowCaps.length >= 5 ? lowCaps : FALLBACK_LOWCAPS;

  } catch (e){
    console.log("⚠️ updateDegenList ERROR:", e?.message);
    return FALLBACK_LOWCAPS;
  }
}

// ========= INDICATEURS =========

function rsi(values, period = 14) {
  if (!values || values.length < period + 1) return null;

  let gains = 0, losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  gains /= period;
  losses = (losses / period) || 1e-9;

  let rs = gains / losses;
  let rsiVal = 100 - 100 / (1 + rs);

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    gains = (gains * (period - 1) + Math.max(diff, 0)) / period;
    losses = ((losses * (period - 1) + Math.max(-diff, 0)) / period) || 1e-9;
    rs = gains / losses;
    rsiVal = 100 - 100 / (1 + rs);
  }

  return rsiVal;
}

function vwap(candles) {
  let pv = 0, vol = 0;
  for (const c of candles) {
    const price = (c.h + c.l + c.c) / 3;
    pv += price * c.v;
    vol += c.v;
  }
  return vol ? pv / vol : null;
}

function calcWicks(candle) {
  if (!candle) return { upper: 0, lower: 0 };

  const top = Math.max(candle.o, candle.c);
  const bottom = Math.min(candle.o, candle.c);

  return {
    upper: ((candle.h - top) / candle.c) * 100,
    lower: ((bottom - candle.l) / candle.c) * 100
  };
}

// ========= PROCESS PAIRE =========

async function processDegen(symbol){
  const [tk, , depth] = await Promise.all([
    getTicker(symbol),
    getFunding(symbol), // Gardé si besoin futur, mais non utilisé dans le calcul actuel
    getDepth(symbol)
  ]);
  
  if (!tk) return null;

  const last = +tk.last;
  const high24 = +tk.high24h;
  const low24  = +tk.low24h;

  const volaPct = last ? ((high24-low24)/last)*100 : null;
  const change24 = tk.priceChangePercent != null ? (+tk.priceChangePercent)*100 : null;

  // Récupération candles 5m (300s) et 15m (900s)
  const [c5m, c15m] = await Promise.all([
    getCandles(symbol, 300, 100),
    getCandles(symbol, 900, 100)
  ]);
  
  if (!c5m || c5m.length < 50 || !c15m || c15m.length < 50) return null;

  const closes5  = c5m.map(x=>x.c);
  const closes15 = c15m.map(x=>x.c);

  const rsi5  = rsi(closes5);
  const rsi15 = rsi(closes15);

  const vwap5 = vwap(c5m.slice(-24));
  const priceVsVwap = vwap5 ? ((last-vwap5)/vwap5)*100 : 0;

  const currentCandle = c5m[c5m.length-1];
  const wicks = calcWicks(currentCandle);

  const lastVol = currentCandle.v;
  // Moyenne des 10 dernières bougies cloturées (exclure la courante pour la moyenne)
  const avgVol = c5m.slice(-11,-1).reduce((a,b)=>a+b.v,0)/10;
  const volRatio = avgVol > 0 ? lastVol / avgVol : 1;

  let obScore = 0, bidsVol=0, asksVol=0;
  if (depth && depth.bids && depth.asks) {
    bidsVol = depth.bids.slice(0,10).reduce((a,x)=>a+(+x[1]),0);
    asksVol = depth.asks.slice(0,10).reduce((a,x)=>a+(+x[1]),0);
    if (asksVol > 0) {
      const r = bidsVol / asksVol;
      if (r > 1.25) obScore = 1;
      else if (r < 0.75) obScore = -1;
    }
  }

  return {
    symbol, last, volaPct, rsi5, rsi15, priceVsVwap,
    volRatio, change24, obScore, bidsVol, asksVol, wicks
  };
}

// ========= ANALYZE CANDIDATE (FULL VERSION) =========

function analyzeCandidate(rec, btcChange) {
  if (!rec || btcChange == null || isNaN(btcChange)) return null;
  if (rec.volaPct == null) return null;

  const vola = rec.volaPct;
  const volRatio = rec.volRatio;
  const gapAbs = Math.abs(rec.priceVsVwap);

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

  const r5 = rec.rsi5;
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

  score += clamp(10 + (volRatio - 3.5) * 8, 0, 30);

  let scoreGap = 5;
  if (gapAbs >= 1.2 && gapAbs <= 2.4) scoreGap = 20;
  else if (gapAbs > 2.4 && gapAbs <= 3.5) scoreGap = 12;
  score += scoreGap;

  let scoreRsi = 0;
  if (direction === "LONG") {
    if (r5 >= 55 && r5 <= 70 && r15 >= 50 && r15 <= 65) scoreRsi = 15;
    else if (r5 > 50 && r15 > 45) scoreRsi = 7;
  } else {
    if (r5 >= 30 && r5 <= 45 && r15 >= 35 && r15 <= 50) scoreRsi = 15;
    else if (r5 < 50 && r15 < 55) scoreRsi = 7;
  }
  score += scoreRsi;

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

  let scoreBTC = 0;
  if (direction === "LONG") {
    if (btcChange >= 0.5 && btcChange <= 1.8) scoreBTC = 10;
    else if (btcChange >= 0.2 && btcChange <= 2.0) scoreBTC = 6;
  } else {
    if (btcChange <= -0.5 && btcChange >= -1.8) scoreBTC = 10;
    else if (btcChange <= -0.2 && btcChange >= -2.0) scoreBTC = 6;
  }
  score += scoreBTC;

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
  if (lastAlerts.get(key) && now - lastAlerts.get(key) < MIN_ALERT_DELAY_MS)
    return false;
  lastAlerts.set(key, now);
  return true;
}

// ========= MAIN LOOP =========

async function scanDegen(){
  const now = Date.now();
  
  // Update de la liste si nécessaire
  if (now - lastSymbolUpdate > SYMBOL_UPDATE_INTERVAL || !DEGEN_SYMBOLS.length){
    DEGEN_SYMBOLS = await updateDegenList();
    lastSymbolUpdate = now;
  }

  const btcChange = await getBTCTrend();
  if (btcChange == null || isNaN(btcChange)){
    console.log("⚠️ BTC DATA ERROR (API Issue).");
    return;
  }

  console.log(`🎯 DEGEN v1.1 (API v2) | BTC: ${btcChange.toFixed(2)}% | Symbols: ${DEGEN_SYMBOLS.length}`);

  const candidates = [];
  const BATCH = 5;

  for (let i=0; i<DEGEN_SYMBOLS.length; i+=BATCH){
    const batch = DEGEN_SYMBOLS.slice(i,i+BATCH);
    const results = await Promise.all(batch.map(s=>processDegen(s)));
    for (const r of results){
      const s = analyzeCandidate(r, btcChange);
      if (s) candidates.push(s);
    }
    // Petit delai pour eviter le Rate Limit
    await sleep(300);
  }

  if (!candidates.length){
    console.log("ℹ️ Aucun signal DEGEN.");
    return;
  }

  // Sélection du meilleur signal (Score puis Volume Ratio)
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
`🎯 *DEGEN v1.1 (API v2)*

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
  console.log("🔫 DEGEN v1.1 (API v2 FIXED) démarré.");
  await sendTelegram("🔫 *DEGEN v1.1 (API v2)* activé.");
  while(true){
    try { await scanDegen(); }
    catch(e){ console.error("DEGEN crash:", e); }
    await sleep(SCAN_INTERVAL_MS);
  }
}

export const startDegen = main;
