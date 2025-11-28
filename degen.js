// degen.js — JTF DEGEN v1.1 Ultra-Sniper (API v2 ONLY)
// Lowcaps Momentum Sniper — très peu de signaux, mais "balles en or".

import fetch from "node-fetch";
import fs from "fs";

// ========= LOAD JSON =========

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

// ========= API BITGET (v2 ONLY) =========

// CANDLES v2
async function getCandles(symbol, seconds, limit=100){
  const base = baseSymbol(symbol);
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/candles?symbol=${base}&granularity=${seconds}&productType=usdt-futures&limit=${limit}`
  );
  if (!j?.data?.length) return [];
  return j.data
    .map(c=>({ t:+c[0],o:+c[1],h:+c[2],l:+c[3],c:+c[4],v:+c[5] }))
    .sort((a,b)=>a.t-b.t);
}

// TICKER v2
async function getTicker(symbol){
  const base = baseSymbol(symbol);
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/ticker?symbol=${base}&productType=usdt-futures`
  );
  return j?.data ?? null;
}

// FUNDING v2
async function getFunding(symbol){
  const base = baseSymbol(symbol);
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/current-fund-rate?symbol=${base}&productType=usdt-futures`
  );
  return j?.data ?? null;
}

// DEPTH v2
async function getDepth(symbol){
  const base = baseSymbol(symbol);
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/depth?symbol=${base}&limit=20&productType=usdt-futures`
  );
  return (j?.data?.bids && j?.data?.asks) ? j.data : null;
}

// FULL MARKET TICKERS v2
async function fetchAllTickers(){
  const j = await safeGetJson(
    "https://api.bitget.com/api/v2/mix/market/tickers?productType=usdt-futures"
  );
  return j?.data ?? [];
}

// ========= BTC TREND =========

async function getBTCTrend() {
  const candles = await getCandles("BTCUSDT_UMCBL",3600,5);
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

    // Filtrage strict
    let valid = all.filter(t =>
      t.symbol.endsWith("_UMCBL") &&
      (+t.usdtVolume > 3_000_000) &&
      !IGNORE_LIST.includes(t.symbol)
    );

    // Tri par volume
    valid.sort((a,b)=>(+b.usdtVolume) - (+a.usdtVolume));

    let lowCaps = valid.map(t=>t.symbol);

    // Exclure Top30 + Discovery
    lowCaps = lowCaps.filter(sym =>
      !top30.includes(sym) &&
      !discovery.includes(sym)
    );

    lowCaps = lowCaps.slice(0,30);

    console.log(`🔄 DEGEN v1.1 (v2 API) lowcaps: ${lowCaps.length} paires.`);
    return lowCaps.length >= 5 ? lowCaps : FALLBACK_LOWCAPS;

  } catch (e){
    console.log("⚠️ updateDegenList ERROR:", e?.message);
    return FALLBACK_LOWCAPS;
  }
}

// ========= INDICATEURS =========

function rsi(c,p=14){ ... }   // UNCHANGED
function vwap(c){ ... }       // UNCHANGED
function calcWicks(c){ ... }  // UNCHANGED

// ========= PROCESS PAIRE =========

async function processDegen(symbol){
  const [tk,,depth] = await Promise.all([
    getTicker(symbol),
    getFunding(symbol),
    getDepth(symbol)
  ]);
  if (!tk) return null;

  const last = +tk.last;
  const high24 = +tk.high24h;
  const low24  = +tk.low24h;

  const volaPct = last ? ((high24-low24)/last)*100 : null;
  const change24 = tk.priceChangePercent != null ? (+tk.priceChangePercent)*100 : null;

  const [c5m, c15m] = await Promise.all([
    getCandles(symbol,300,100),
    getCandles(symbol,900,100)
  ]);
  if (!c5m.length || !c15m.length) return null;

  const closes5  = c5m.map(x=>x.c);
  const closes15 = c15m.map(x=>x.c);

  const rsi5  = rsi(closes5);
  const rsi15 = rsi(closes15);

  const vwap5 = vwap(c5m.slice(-24));
  const priceVsVwap = vwap5 ? ((last-vwap5)/vwap5)*100 : 0;

  const currentCandle = c5m[c5m.length-1];
  const wicks = calcWicks(currentCandle);

  const lastVol = currentCandle.v;
  const avgVol = c5m.slice(-11,-1).reduce((a,b)=>a+b.v,0)/10;
  const volRatio = avgVol>0 ? lastVol/avgVol : 1;

  let obScore=0, bidsVol=0, asksVol=0;
  if (depth){
    bidsVol = depth.bids.slice(0,10).reduce((a,x)=>a+(+x[1]),0);
    asksVol = depth.asks.slice(0,10).reduce((a,x)=>a+(+x[1]),0);
    if (asksVol>0){
      const r = bidsVol/asksVol;
      if (r>1.25) obScore=1;
      else if (r<0.75) obScore=-1;
    }
  }

  return {
    symbol, last, volaPct, rsi5, rsi15, priceVsVwap,
    volRatio, change24, obScore, bidsVol, asksVol, wicks
  };
}

// ========= ANALYSE SNIPER v1.1 =========

function analyzeCandidate(rec, btc){ ... }  // UNCHANGED

// ========= TELEGRAM & SPAM =========

async function sendTelegram(text){ ... }  // unchanged

function checkAntiSpam(symbol,dir){ ... } // unchanged

// ========= MAIN LOOP =========

async function scanDegen(){
  const now = Date.now();
  const btcChange = await getBTCTrend();
  if (btcChange==null || isNaN(btcChange)){
    console.log("⚠️ BTC DATA ERROR.");
    return;
  }

  if (now-lastSymbolUpdate > SYMBOL_UPDATE_INTERVAL || !DEGEN_SYMBOLS.length){
    DEGEN_SYMBOLS = await updateDegenList();
    lastSymbolUpdate = now;
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
    await sleep(300);
  }

  if (!candidates.length){
    console.log("ℹ️ Aucun signal DEGEN.");
    return;
  }

  // best shot
  const best = candidates.sort((a,b)=>{
    if (b.score!==a.score) return b.score-a.score;
    return (+b.volRatio)-(+a.volRatio);
  })[0];

  if ((now-lastGlobalTradeTime) < GLOBAL_COOLDOWN_MS){
    console.log(`⏳ Cooldown : signal ${best.symbol} ignoré.`);
    return;
  }

  if (!checkAntiSpam(best.symbol, best.direction)){
    console.log(`⏳ Anti-spam : ${best.symbol} ignoré.`);
    return;
  }

  // SEND SIGNAL
  const emoji = best.direction==="LONG" ? "🔫🟢" : "🔫🔴";
  const msg = `🎯 *DEGEN v1.1 (API v2)*\n\n${emoji} *${best.symbol}* — ${best.direction}\n...`;

  await sendTelegram(msg);
  console.log(`✅ SHOT : ${best.symbol}`);
  lastGlobalTradeTime = now;
}

async function main(){
  console.log("🔫 DEGEN v1.1 (API v2) démarré.");
  await sendTelegram("🔫 *DEGEN v1.1 (API v2)* activé.");
  while(true){
    try { await scanDegen(); }
    catch(e){ console.error("DEGEN crash:", e); }
    await sleep(SCAN_INTERVAL_MS);
  }
}

export const startDegen = main;