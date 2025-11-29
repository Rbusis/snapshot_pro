// degen.js — JTF DEGEN v1.2 (API v2 FIXED + LIGHT DEBUG MODE)

import fetch from "node-fetch";
import fs from "fs";
import process from "node:process";

// ========= DEBUG MODE =========
const DEBUG = true; // set to false in production.

// ========= LOAD JSON =========

function loadJson(path) {
  try {
    if (fs.existsSync(path)) {
      return JSON.parse(fs.readFileSync(path, "utf8"));
    }
  } catch (e) {
    console.error(`⚠️ Erreur lecture ${path}:`, e.message);
  }
  return [];
}

const top30 = loadJson("./config/top30.json");
const getDiscoveryList = () => loadJson("./config/discovery_list.json");

// ========= CONFIG =========

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

const SCAN_INTERVAL_MS      = 5 * 60_000;
const MIN_ALERT_DELAY_MS    = 15 * 60_000;
const GLOBAL_COOLDOWN_MS    = 30 * 60_000;
const SYMBOL_UPDATE_INTERVAL = 60 * 60_000;

// BTC limits
const BTC_TREND_ABS_MIN   = 0.2;
const BTC_TREND_ABS_MAX   = 2.5;

const BTC_LONG_MIN  = 0.2;
const BTC_LONG_MAX  = 2.0;
const BTC_SHORT_MIN = -2.0;
const BTC_SHORT_MAX = -0.2;

// ========= STATE =========

let DEGEN_SYMBOLS       = [];
let lastSymbolUpdate    = 0;
let lastGlobalTradeTime = 0;
const lastAlerts        = new Map();

const FALLBACK_LOWCAPS = [
  "MAGICUSDT","GALAUSDT","ONEUSDT","CELOUSDT","KAVAUSDT"
];

const IGNORE_LIST = [
  "BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT",
  "ADAUSDT","DOGEUSDT","AVAXUSDT","DOTUSDT","TRXUSDT",
  "LINKUSDT","TONUSDT","SUIUSDT","APTUSDT","NEARUSDT",
  "ARBUSDT","OPUSDT","INJUSDT","ATOMUSDT","AAVEUSDT",
  "LTCUSDT","UNIUSDT","FILUSDT","XLMUSDT","RUNEUSDT",
  "ALGOUSDT","PEPEUSDT","WIFUSDT","TIAUSDT","SEIUSDT"
];

// ========= UTILS =========

const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const num   = (v,d=4)=>v==null?null:+(+v).toFixed(d);
const clamp = (x,min,max)=>Math.max(min,Math.min(max,x));

async function safeGetJson(url){
  try {
    const r = await fetch(url,{ headers:{Accept:"application/json"} });
    if(!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// ========= API v2 =========

async function getCandles(symbol, seconds, limit=100){
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}&granularity=${seconds}&productType=usdt-futures&limit=${limit}`
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
  if (Array.isArray(j?.data)) return j.data[0];
  return j?.data ?? null;
}

async function getFunding(symbol){
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/current-fund-rate?symbol=${symbol}&productType=usdt-futures`
  );
  if (Array.isArray(j?.data)) return j.data[0];
  return j?.data ?? null;
}

async function getDepth(symbol){
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/merge-depth?symbol=${symbol}&limit=20&productType=usdt-futures`
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
  const candles = await getCandles("BTCUSDT", 3600, 5);
  if (!candles?.length) return null;
  const last = candles[candles.length-1];
  return ((last.c - last.o)/last.o)*100;
}

// ========= UPDATE LIST =========

async function updateDegenList(){
  try {
    const all = await fetchAllTickers();
    if (!all.length) return FALLBACK_LOWCAPS;

    const discovery = getDiscoveryList();

    let valid = all.filter(t =>
      t.symbol.includes("USDT") &&
      (+t.usdtVolume > 3_000_000) &&
      !IGNORE_LIST.includes(t.symbol)
    );

    valid.sort((a,b)=>(+b.usdtVolume)-(+a.usdtVolume));

    let low = valid.map(t => t.symbol);

    low = low.filter(sym =>
      !top30.includes(sym) &&
      !discovery.includes(sym)
    );

    low = low.slice(0,30);
    return low.length >= 5 ? low : FALLBACK_LOWCAPS;

  } catch {
    return FALLBACK_LOWCAPS;
  }
}

// ========= INDICATORS =========

function rsi(values, p=14){
  if (!values || values.length < p+1) return null;
  let g=0,l=0;
  for (let i=1;i<=p;i++){
    const d=values[i]-values[i-1];
    d>=0?g+=d:l-=d;
  }
  g/=p; l=(l/p)||1e-9;
  let rs=g/l;
  let v=100-100/(1+rs);
  for (let i=p+1;i<values.length;i++){
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
  for(const k of c){
    const p=(k.h+k.l+k.c)/3;
    pv+=p*k.v;
    v+=k.v;
  }
  return v?pv/v:null;
}

function calcWicks(c){
  if (!c) return {upper:0,lower:0};
  const top=Math.max(c.o,c.c);
  const bot=Math.min(c.o,c.c);
  return {
    upper: ((c.h-top)/c.c)*100,
    lower: ((bot-c.l)/c.c)*100
  };
}

// ========= PROCESS SYMBOL =========

async function processDegen(symbol){
  const [tk,, depth] = await Promise.all([
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

  const [c5m,c15m] = await Promise.all([
    getCandles(symbol,300,80),
    getCandles(symbol,900,80)
  ]);

  if (!c5m?.length || !c15m?.length) return null;

  const closes5  = c5m.map(x=>x.c);
  const closes15 = c15m.map(x=>x.c);

  const rsi5  = rsi(closes5);
  const rsi15 = rsi(closes15);

  const vwap5 = vwap(c5m.slice(-24));
  const priceVsVwap = vwap5 ? ((last-vwap5)/vwap5)*100 : 0;

  const current = c5m[c5m.length-1];
  const wicks = calcWicks(current);

  const lastVol = current.v;
  const avgVol  = c5m.slice(-11,-1).reduce((a,b)=>a+b.v,0)/10;
  const volRatio = avgVol>0 ? lastVol/avgVol : 1;

  let obScore=0,bidsVol=0,asksVol=0;
  if (depth){
    bidsVol = depth.bids.slice(0,10).reduce((a,x)=>a+(+x[1]),0);
    asksVol = depth.asks.slice(0,10).reduce((a,x)=>a+(+x[1]),0);
    if(asksVol>0){
      const r=bidsVol/asksVol;
      if(r>1.25) obScore=1;
      else if(r<0.75) obScore=-1;
    }
  }

  // ========= LIGHT DEBUG =========
  if (DEBUG){
    console.log(
      `[DEGEN DEBUG] ${symbol} | last=${num(last,4)} | vola=${num(volaPct,2)}% | volRatio=${num(volRatio,2)} | ΔVWAP=${num(priceVsVwap,2)} | rsi5=${num(rsi5,1)} | rsi15=${num(rsi15,1)}`
    );
  }

  return {
    symbol,last,volaPct,rsi5,rsi15,priceVsVwap,
    volRatio,change24,obScore,bidsVol,asksVol,wicks
  };
}

// ========= ANALYZE CANDIDATE =========
// (UNCHANGED LOGIC)

function analyzeCandidate(rec, btc){
  if (!rec || btc==null) return null;
  if (rec.volaPct <4 || rec.volaPct>25) return null;
  if (rec.volRatio < 3.5) return null;

  const gap = Math.abs(rec.priceVsVwap);
  if (gap <1.0 || gap>3.5) return null;

  const absBTC = Math.abs(btc);
  if (absBTC <BTC_TREND_ABS_MIN || absBTC>BTC_TREND_ABS_MAX) return null;

  let dir = rec.priceVsVwap>0 ? "LONG":"SHORT";

  if(dir==="LONG"){
    if(btc<BTC_LONG_MIN||btc>BTC_LONG_MAX)return null;
    if(rec.rsi5<50||rec.rsi5>75)return null;
  } else {
    if(btc>BTC_SHORT_MAX||btc<BTC_SHORT_MIN)return null;
    if(rec.rsi5<25||rec.rsi5>50)return null;
  }

  let score=0;
  score += clamp(10+(rec.volRatio-3.5)*8,0,30);
  score += (gap>=1.2&&gap<=2.4)?20:12;

  if(dir==="LONG"){
    if(rec.rsi5>=55&&rec.rsi5<=70)score+=15;
  } else {
    if(rec.rsi5>=30&&rec.rsi5<=45)score+=15;
  }

  if(score<88)return null;

  return {
    symbol:rec.symbol,
    direction:dir,
    score,
    volRatio:rec.volRatio,
    vola:rec.volaPct,
    priceVsVwap:rec.priceVsVwap,
    last:rec.last
  };
}

// ========= TELEGRAM =========

async function sendTelegram(text){
  if(!TELEGRAM_BOT_TOKEN||!TELEGRAM_CHAT_ID)return;
  try{
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({ chat_id:TELEGRAM_CHAT_ID,text,parse_mode:"Markdown" })
    });
  }catch{}
}

function checkAntiSpam(symbol,dir){
  const k=`${symbol}-${dir}`;
  const n=Date.now();
  if(lastAlerts.get(k)&&n-lastAlerts.get(k)<MIN_ALERT_DELAY_MS)return false;
  lastAlerts.set(k,n);
  return true;
}

// ========= MAIN LOOP =========

async function scanDegen(){
  const now = Date.now();

  if(now-lastSymbolUpdate>SYMBOL_UPDATE_INTERVAL || !DEGEN_SYMBOLS.length){
    DEGEN_SYMBOLS = await updateDegenList();
    lastSymbolUpdate = now;
    console.log(`🔄 DEGEN list updated: ${DEGEN_SYMBOLS.length} symbols`);
  }

  const btc = await getBTCTrend();
  if(btc==null){
    console.log("⚠️ BTC Trend missing.");
    return;
  }

  console.log(`🎯 DEGEN v1.2 | BTC ${btc.toFixed(2)}%`);

  const candidates=[];
  const BATCH=5;

  for(let i=0;i<DEGEN_SYMBOLS.length;i+=BATCH){
    const batch = DEGEN_SYMBOLS.slice(i,i+BATCH);
    const res = await Promise.all(batch.map(s=>processDegen(s)));
    for(const r of res){
      const s=analyzeCandidate(r,btc);
      if(s) candidates.push(s);
    }
    await sleep(200);
  }

  if(!candidates.length){
    console.log("ℹ️ Aucun signal DEGEN.");
    return;
  }

  const best = candidates.sort((a,b)=>b.score-a.score)[0];

  if(now-lastGlobalTradeTime<GLOBAL_COOLDOWN_MS){
    console.log(`⏳ Cooldown ignore ${best.symbol}`);
    return;
  }

  if(!checkAntiSpam(best.symbol,best.direction)){
    console.log(`⏳ Anti-spam ignore ${best.symbol}`);
    return;
  }

  const emoji = best.direction==="LONG"?"🔫🟢":"🔫🔴";

  const msg =
`🎯 *DEGEN v1.2 (API v2)*

${emoji} *${best.symbol}* — ${best.direction}
🏅 Score: ${best.score}

📊 Vol Spike: x${num(best.volRatio,2)}
🌡️ Vola: ${num(best.vola,2)}%
📉 ΔVWAP: ${num(best.priceVsVwap,2)}%

💰 Price: ${best.last}

_No market orders. Patience._`;

  await sendTelegram(msg);
  lastGlobalTradeTime = now;
}

async function main(){
  console.log("🔫 DEGEN v1.2 démarré (API v2 FIX + DEBUG MODE).");
  await sendTelegram("🔫 *DEGEN v1.2 READY* (API v2 + Debug Mode ON)");
  while(true){
    try { await scanDegen(); }
    catch(e){ console.error("DEGEN crash:",e); }
    await sleep(SCAN_INTERVAL_MS);
  }
}

export const startDegen = main;