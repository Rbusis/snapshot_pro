// discovery.js — JTF DISCOVERY v1.2 (Midcaps Momentum Scanner — API v2 ONLY)

import fetch from "node-fetch";
import fs from "fs";

// ========= CONFIG =========
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

const SCAN_INTERVAL_MS      = 5 * 60_000;
const MIN_ALERT_DELAY_MS    = 15 * 60_000;
const GLOBAL_COOLDOWN_MS    = 30 * 60_000;
const SYMBOL_UPDATE_INTERVAL = 60 * 60_000;

// Sécurité BTC
const BTC_LONG_MIN  = -0.2;
const BTC_SHORT_MAX = +0.5;

// État interne
let DISCOVERY_SYMBOLS = [];
let lastSymbolUpdate   = 0;
let lastGlobalTradeTime = 0;
const lastAlerts = new Map();

// Fallback midcaps
const FALLBACK_MIDCAPS = [
  "INJUSDT_UMCBL", "FETUSDT_UMCBL", "RNDRUSDT_UMCBL", 
  "ARBUSDT_UMCBL", "AGIXUSDT_UMCBL"
];

// Éviter les double couvertures
const IGNORE_LIST = [
  // Top majors + déjà couverts ailleurs
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

// ========= API v2 ONLY =========

// CANDLES
async function getCandles(symbol, seconds, limit=100){
  const base = baseSymbol(symbol);
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/candles?symbol=${base}&granularity=${seconds}&productType=usdt-futures&limit=${limit}`
  );
  if (!j?.data?.length) return [];
  return j.data.map(c=>({
    t:+c[0], o:+c[1], h:+c[2], l:+c[3], c:+c[4], v:+c[5]
  })).sort((a,b)=>a.t-b.t);
}

// TICKER
async function getTicker(symbol){
  const base = baseSymbol(symbol);
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/ticker?symbol=${base}&productType=usdt-futures`
  );
  return j?.data ?? null;
}

// FUNDING
async function getFunding(symbol){
  const base = baseSymbol(symbol);
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/current-fund-rate?symbol=${base}&productType=usdt-futures`
  );
  return j?.data ?? null;
}

// DEPTH
async function getDepth(symbol){
  const base = baseSymbol(symbol);
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/depth?symbol=${base}&limit=20&productType=usdt-futures`
  );
  return (j?.data?.bids && j?.data?.asks) ? j.data : null;
}

// FULL MARKET
async function getAllTickers(){
  const j = await safeGetJson(
    "https://api.bitget.com/api/v2/mix/market/tickers?productType=usdt-futures"
  );
  return j?.data ?? [];
}

// ========= BTC TREND (RETRY PATTERN) =========
async function getBTCTrend(){
  let attempts = 0;
  while(attempts < 3){
    const c = await getCandles("BTCUSDT_UMCBL", 3600, 5);
    if (c && c.length > 0) {
      const last = c[c.length-1];
      return ((last.c - last.o)/last.o)*100;
    }
    attempts++;
    if(attempts < 3) await sleep(1000);
  }
  return null;
}

// ========= LISTE MIDCAPS =========
async function updateDiscoveryList(){
  try {
    const all = await getAllTickers();
    if (!all.length) return FALLBACK_MIDCAPS;

    let list = all.filter(t =>
      t.symbol.endsWith("_UMCBL") &&
      !IGNORE_LIST.includes(t.symbol) &&
      (+t.usdtVolume > 5_000_000)
    );

    list.sort((a,b)=>(+b.usdtVolume)-(+a.usdtVolume));
    const midcaps = list.slice(0,50).map(t=>t.symbol);

    // Sauvegarde locale (Optionnel, ignore erreur si FS en lecture seule)
    try {
      fs.writeFileSync("./config/discovery_list.json", JSON.stringify(midcaps,null,2));
    } catch(e){}

    return midcaps.length ? midcaps : FALLBACK_MIDCAPS;
  }
  catch {
    return FALLBACK_MIDCAPS;
  }
}

// ========= INDICATEURS =========

function rsi(values,p=14){
  if (!values || values.length < p+1) return null;
  let g=0,l=0;

  for(let i=1;i<=p;i++){
    const d=values[i]-values[i-1];
    if(d>=0) g+=d; else l-=d;
  }

  g/=p; l=(l/p)||1e-9;
  let rs=g/l;
  let v=100-100/(1+rs);

  for(let i=p+1;i<values.length;i++){
    const d=values[i]-values[i-1];
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
  return v?pv/v:null;
}

function calcWicks(c){
  if (!c) return {upper:0,lower:0};
  const top = Math.max(c.o,c.c);
  const bot = Math.min(c.o,c.c);
  return {
    upper: ((c.h-top)/c.c)*100,
    lower: ((bot-c.l)/c.c)*100
  };
}

// ========= PROCESS PAIRE =========

async function processDiscovery(symbol){
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

  const [c5m, c15m] = await Promise.all([
    getCandles(symbol,300,100),
    getCandles(symbol,900,100)
  ]);
  if (!c5m.length) return null;

  const closes5  = c5m.map(x=>x.c);
  const rsi5     = rsi(closes5);
  const rsi15    = rsi(c15m.map(x=>x.c));

  const vwap5 = vwap(c5m.slice(-24));
  const priceVsVwap = vwap5 ? ((last-vwap5)/vwap5)*100 : 0;

  const wicks = calcWicks(c5m[c5m.length-1]);

  const lastVol = c5m[c5m.length-1].v;
  const avgVol  = c5m.slice(-11,-1).reduce((a,b)=>a+b.v,0)/10;
  const volRatio = avgVol>0 ? lastVol/avgVol : 1;

  const change24 = tk.priceChangePercent ? (+tk.priceChangePercent)*100 : 0;

  let obScore = 0;
  let bidsVol=0, asksVol=0;

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
    symbol,last,volaPct,rsi5,rsi15,
    priceVsVwap,volRatio,change24,obScore,bidsVol,asksVol,wicks
  };
}

// ========= ANALYSE LOGIQUE MIDCAP =========

function analyzeCandidate(rec, btc){
  if (!rec || btc==null) return null;

  // HARD FILTERS
  if (rec.volRatio < 2) return null;
  if (rec.volaPct < 3 || rec.volaPct > 22) return null;

  const gapAbs = Math.abs(rec.priceVsVwap);
  if (gapAbs < 0.6 || gapAbs > 3.2) return null;

  if (!rec.rsi5) return null;

  let direction = null;

  if (rec.priceVsVwap > 0){
    if (btc < BTC_LONG_MIN) return null;
    if (rec.wicks.upper > 1.2) return null;
    if (rec.obScore < 0) return null;
    direction = "LONG";
  } else {
    if (btc > BTC_SHORT_MAX) return null;
    if (rec.wicks.lower > 1.2) return null;
    if (rec.obScore > 0) return null;
    direction = "SHORT";
  }

  // SCORING
  let score = 0;

  // Volume
  score += rec.volRatio >= 3 ? 30 : 15;

  // VWAP Gap
  if (gapAbs >= 1 && gapAbs <= 2.2) score += 20; else score += 10;

  // RSI
  if (direction==="LONG"){
    if (rec.rsi5>=55 && rec.rsi5<=75) score += 15;
    else score += 5;
  } else {
    if (rec.rsi5>=25 && rec.rsi5<=45) score += 15;
    else score += 5;
  }

  // OB
  if ((direction==="LONG" && rec.obScore===1) ||
      (direction==="SHORT" && rec.obScore===-1))
    score += 15;

  // Trend 24h
  if ((direction==="LONG" && rec.change24>3) ||
      (direction==="SHORT" && rec.change24<-3))
    score += 10;

  // BTC Context
  if ((direction==="LONG" && btc>=0) ||
      (direction==="SHORT" && btc<=0))
    score += 10;

  if (score < 78) return null;

  // PLAN DE TRADE
  const decimals = rec.last < 1 ? 5 : 3;
  const pullback = clamp(gapAbs/4,0.4,1.0);

  const limitEntry = direction==="LONG"
    ? rec.last*(1-pullback/100)
    : rec.last*(1+pullback/100);

  const riskPct = clamp((rec.volaPct/5)*2,2,5);
  const sl = direction==="LONG"
    ? rec.last*(1-riskPct/100)
    : rec.last*(1+riskPct/100);

  const tp = direction==="LONG"
    ? rec.last*(1+(riskPct*2)/100)
    : rec.last*(1-(riskPct*2)/100);

  const levier = riskPct>4 ? "2x" : "3x";
  const obRatio = rec.asksVol>0 ? (rec.bidsVol/rec.asksVol).toFixed(2) : "N/A";

  const reason =
    rec.volRatio>=3 ? "Volume Spike" :
    rec.obScore!==0 ? "Orderbook Pressure" :
    "Momentum Propre";

  return {
    symbol:rec.symbol,
    direction,
    score,
    reason,
    price:rec.last,
    limitEntry:num(limitEntry,decimals),
    sl:num(sl,decimals),
    tp:num(tp,decimals),
    riskPct:num(riskPct,2),
    volRatio:num(rec.volRatio,1),
    vola:num(rec.volaPct,1),
    obRatio,
    levier
  };
}

// ========= TELEGRAM =========

async function sendTelegram(text){
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,{
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode:"Markdown"
      })
    });
  } catch(e){
    console.error("Discovery Telegram Error:", e.message);
  }
}

function checkAntiSpam(symbol,dir){
  const k=`${symbol}-${dir}`;
  const now=Date.now();
  const last=lastAlerts.get(k);
  if(last && now-last<MIN_ALERT_DELAY_MS) return false;
  lastAlerts.set(k,now);
  return true;
}

// ========= MAIN LOOP =========

async function scanDiscovery(){
  const now = Date.now();

  const btc = await getBTCTrend();
  if (btc==null) {
    console.log("⚠️ BTC DATA ERROR (Discovery paused).");
    return;
  }

  if (now-lastSymbolUpdate > SYMBOL_UPDATE_INTERVAL || !DISCOVERY_SYMBOLS.length){
    DISCOVERY_SYMBOLS = await updateDiscoveryList();
    lastSymbolUpdate = now;
    console.log(`🔄 Discovery list : ${DISCOVERY_SYMBOLS.length} paires.`);
  }

  console.log(`🚀 DISCOVERY v1.2 | BTC: ${btc.toFixed(2)}% | Pairs: ${DISCOVERY_SYMBOLS.length}`);

  const BATCH = 5;
  const candidates = [];

  for(let i=0;i<DISCOVERY_SYMBOLS.length;i+=BATCH){
    const batch = DISCOVERY_SYMBOLS.slice(i,i+BATCH);
    const results = await Promise.all(batch.map(s=>processDiscovery(s)));
    for(const r of results){
      const s = analyzeCandidate(r, btc);
      if(s) candidates.push(s);
    }
    await sleep(300);
  }

  if (!candidates.length){
    console.log("ℹ Aucun signal Discovery.");
    return;
  }

  const best = candidates.sort((a,b)=>b.score-a.score)[0];

  if (now-lastGlobalTradeTime < GLOBAL_COOLDOWN_MS){
    console.log(`⏳ Cooldown : ${best.symbol} ignoré.`);
    return;
  }

  if (!checkAntiSpam(best.symbol,best.direction)){
    console.log(`⏳ Anti-spam : ${best.symbol} ignoré.`);
    return;
  }

  // Envoi
  const emoji = best.direction==="LONG" ? "🚀" : "🪂";

  const msg = 
`⚡ *JTF DISCOVERY v1.2* ⚡

${emoji} *${best.symbol}* — ${best.direction}
🏅 *Score:* ${best.score}/100
🔎 *Setup:* ${best.reason}

📉 *Limit Entry:* ${best.limitEntry}
🔹 Market: ${best.price}

🎯 TP: ${best.tp}
🛑 SL: ${best.sl} (-${best.riskPct}%)

⚖️ *Levier:* ${best.levier}
📊 *Vol:* x${best.volRatio} | *Vola:* ${best.vola}% | *OB:* ${best.obRatio}

_Midcap Momentum Logic_`;

  await sendTelegram(msg);
  lastGlobalTradeTime = now;

  console.log(`✅ Signal Discovery envoyé: ${best.symbol}`);
}

// ========= START =========

async function main(){
  console.log("🔥 Discovery v1.2 (API v2 only) démarré.");
  await sendTelegram("🔥 *DISCOVERY v1.2* lancé (API v2 only).");
  while(true){
    try { await scanDiscovery(); }
    catch(e){ console.error("DISCOVERY Crash:",e); }
    await sleep(SCAN_INTERVAL_MS);
  }
}

export const startDiscovery = main;
