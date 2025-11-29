// discovery.js — JTF DISCOVERY v1.8 (Clean Output + API v2 + Debug Control)

import fetch from "node-fetch";
import fs from "fs";
import { DEBUG } from "./debug.js";

// ========= DEBUG =========
function logDebug(...args){
  if (DEBUG.global || DEBUG.discovery){
    console.log("[DISCOVERY DEBUG]", ...args);
  }
}

// ========= CONFIG =========
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

const SCAN_INTERVAL_MS       = 5 * 60_000;
const MIN_ALERT_DELAY_MS     = 15 * 60_000;
const GLOBAL_COOLDOWN_MS     = 30 * 60_000;
const SYMBOL_UPDATE_INTERVAL = 60 * 60_000;

// BTC Trend désactivé
const BTC_LONG_MIN  = -0.2;
const BTC_SHORT_MAX = +0.5;

// ========= STATE =========
let DISCOVERY_SYMBOLS   = [];
let lastSymbolUpdate    = 0;
let lastGlobalTradeTime = 0;
const lastAlerts        = new Map();

// ========= BLACKLIST TOP30 =========
const IGNORE_LIST = [
  "BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT",
  "ADAUSDT","DOGEUSDT","AVAXUSDT","DOTUSDT","TRXUSDT",
  "LINKUSDT","TONUSDT","SUIUSDT","APTUSDT","NEARUSDT",
  "ARBUSDT","OPUSDT","INJUSDT","ATOMUSDT","AAVEUSDT",
  "LTCUSDT","UNIUSDT","FILUSDT","XLMUSDT","RUNEUSDT",
  "ALGOUSDT","PEPEUSDT","WIFUSDT","TIAUSDT","SEIUSDT"
];

// ========= UTILS =========
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (x,min,max)=>Math.max(min,Math.min(max,x));
const num   = (v,d=4)=>v==null?null:+(+v).toFixed(d);

async function safeGetJson(url){
  try{
    const r = await fetch(url,{headers:{Accept:"application/json"}});
    if(!r.ok) return null;
    return await r.json();
  }catch(e){
    logDebug("safeGetJson ERROR", e);
    return null;
  }
}

// ========= API v2 =========
async function getTicker(symbol){
  logDebug("getTicker", symbol);
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/ticker?symbol=${symbol}&productType=usdt-futures`
  );
  return j?.data ? (Array.isArray(j.data) ? j.data[0] : j.data) : null;
}

async function getCandles(symbol, seconds, limit=200){
  logDebug("getCandles", symbol, seconds);
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}&granularity=${seconds}&limit=${limit}&productType=usdt-futures`
  );
  if(!j?.data?.length) return [];
  return j.data.map(c=>({
    t:+c[0], o:+c[1], h:+c[2], l:+c[3], c:+c[4], v:+c[5]
  })).sort((a,b)=>a.t-b.t);
}

async function getDepth(symbol){
  logDebug("getDepth", symbol);
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/merge-depth?symbol=${symbol}&productType=usdt-futures&limit=20`
  );
  if(!j?.data) return null;
  const d = Array.isArray(j.data)?j.data[0]:j.data;
  return d?.bids && d?.asks ? d : null;
}

async function getAllTickers(){
  logDebug("getAllTickers()");
  const j = await safeGetJson(
    "https://api.bitget.com/api/v2/mix/market/tickers?productType=usdt-futures"
  );
  return j?.data ?? [];
}

// ========= INDICATORS =========
function rsi(values,p=14){
  if(!values || values.length < p+1) return null;
  let g=0,l=0;
  for(let i=1;i<=p;i++){
    const d=values[i]-values[i-1];
    d>=0?g+=d:l-=d;
  }
  g/=p; l=(l/p)||1e-9;
  let val=100-100/(1+(g/l));

  for(let i=p+1;i<values.length;i++){
    const d=values[i]-values[i-1];
    g=(g*(p-1)+Math.max(d,0))/p;
    l=((l*(p-1)+Math.max(-d,0))/p)||1e-9;
    val=100-100/(1+(g/l));
  }
  return val;
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

function wicks(c){
  if(!c) return {upper:0,lower:0};
  const top=Math.max(c.o,c.c);
  const bot=Math.min(c.o,c.c);
  return {
    upper:((c.h-top)/c.c)*100,
    lower:((bot-c.l)/c.c)*100
  };
}

// ========= PROCESS =========
async function processDiscovery(symbol){
  logDebug("processDiscovery", symbol);

  const tk = await getTicker(symbol);
  if(!tk) return null;

  const last =
    (tk.lastPr ?? tk.markPrice ?? tk.close ?? tk.last ?? NaN);

  if(!last || Number.isNaN(last)){
    logDebug("invalid last", symbol);
    return null;
  }

  const high24 = tk.high24h != null ? +tk.high24h : null;
  const low24  = tk.low24h  != null ? +tk.low24h  : null;

  const volaPct = (high24!=null && low24!=null)
    ? ((high24-low24)/last)*100
    : null;

  const [c5m,c15m] = await Promise.all([
    getCandles(symbol,300,100),
    getCandles(symbol,900,100)
  ]);

  if(!c5m?.length){
    logDebug("missing 5m", symbol);
    return null;
  }

  const rsi5  = rsi(c5m.map(x=>x.c));
  const rsi15 = rsi(c15m.map(x=>x.c));

  const vwp = vwap(c5m.slice(-24));
  const priceVsVwap = vwp ? ((last-vwp)/vwp)*100 : 0;

  const lastC = c5m[c5m.length-1];
  const wick = wicks(lastC);

  const lastVol = lastC.v;
  const avgVol  = c5m.slice(-11,-1).reduce((a,b)=>a+b.v,0)/10;
  const volRatio = avgVol>0 ? lastVol/avgVol : 1;

  const change24 = tk.change24h != null ? +tk.change24h : 0;

  const depth = await getDepth(symbol);
  let obScore=0,bids=0,asks=0;

  if(depth){
    bids = depth.bids.slice(0,10).reduce((a,x)=>a+(+x[1]),0);
    asks = depth.asks.slice(0,10).reduce((a,x)=>a+(+x[1]),0);
    if(asks>0){
      const r=bids/asks;
      if(r>1.25) obScore=1;
      else if(r<0.75) obScore=-1;
    }
  }

  return {
    symbol,last,volaPct,rsi5,rsi15,priceVsVwap,
    volRatio,change24,obScore,bidsVol:bids,asksVol:asks,wicks:wick
  };
}

// ========= ANALYZE =========
function analyze(rec){
  if(!rec) return null;

  if(rec.volRatio < 2) return null;
  if(rec.volaPct < 3 || rec.volaPct > 22) return null;

  const gap=Math.abs(rec.priceVsVwap);
  if(gap < 0.6 || gap > 3.2) return null;

  let dir=null;

  if(rec.priceVsVwap>0){
    if(rec.wicks.upper>1.2) return null;
    if(rec.obScore<0) return null;
    dir="LONG";
  } else {
    if(rec.wicks.lower>1.2) return null;
    if(rec.obScore>0) return null;
    dir="SHORT";
  }

  let score=0;
  score += rec.volRatio>=3 ? 30 : 15;
  score += (gap>=1 && gap<=2.2) ? 20 : 10;
  score += (dir==="LONG"
    ? (rec.rsi5>=55&&rec.rsi5<=75?15:5)
    : (rec.rsi5>=25&&rec.rsi5<=45?15:5)
  );
  if((dir==="LONG"&&rec.obScore===1)||(dir==="SHORT"&&rec.obScore===-1)) score+=15;
  if((dir==="LONG"&&rec.change24>0)||(dir==="SHORT"&&rec.change24<0)) score+=10;

  if(score<78) return null;

  const decimals = rec.last<1?5:3;
  const gapPc = gap/100;

  const entry = dir==="LONG"
    ? rec.last*(1-gapPc*0.25)
    : rec.last*(1+gapPc*0.25);

  const riskPct = clamp((rec.volaPct/5)*2,2,5);

  const sl = dir==="LONG"
    ? rec.last*(1-riskPct/100)
    : rec.last*(1+riskPct/100);

  const tp = dir==="LONG"
    ? rec.last*(1+(riskPct*2)/100)
    : rec.last*(1-(riskPct*2)/100);

  const lev = riskPct>4 ? "2x" : "3x";

  return {
    symbol:rec.symbol,
    direction:dir,
    score,
    price:rec.last,
    limitEntry:num(entry,decimals),
    sl:num(sl,decimals),
    tp:num(tp,decimals),
    volRatio:num(rec.volRatio,1),
    vola:num(rec.volaPct,1),
    obRatio: rec.asksVol>0 ? (rec.bidsVol/rec.asksVol).toFixed(2) : "N/A",
    levier:lev
  };
}

// ========= TELEGRAM =========
async function sendTelegram(msg){
  if(!TELEGRAM_BOT_TOKEN||!TELEGRAM_CHAT_ID) return;
  try{
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        chat_id:TELEGRAM_CHAT_ID,
        text:msg,
        parse_mode:"Markdown"
      })
    });
  }catch{}
}

function antiSpam(symbol,dir){
  const key=`${symbol}-${dir}`;
  const now=Date.now();
  const last=lastAlerts.get(key);
  if(last && now-last<MIN_ALERT_DELAY_MS) return false;
  lastAlerts.set(key,now);
  return true;
}

// ========= MAIN LOOP =========
async function scanDiscovery(){
  const start = Date.now();
  console.log("🔍 [DISCOVERY] SCAN STARTED...");

  const now = start;
  const btcTrend = 0;

  // Refresh liste
  if (now - lastSymbolUpdate > SYMBOL_UPDATE_INTERVAL || !DISCOVERY_SYMBOLS.length){
    const all = await getAllTickers();
    let list = all.filter(t =>
      t.symbol?.endsWith("USDT") &&
      !IGNORE_LIST.includes(t.symbol) &&
      (+t.usdtVolume > 5_000_000)
    );
    list.sort((a,b)=>(+b.usdtVolume)-(+a.usdtVolume));
    DISCOVERY_SYMBOLS = list.slice(0,50).map(t=>t.symbol);

    try {
      fs.writeFileSync("./config/discovery_list.json", JSON.stringify(DISCOVERY_SYMBOLS,null,2));
    } catch {}

    lastSymbolUpdate = now;
    console.log(`🔄 [DISCOVERY] LIST UPDATE — ${DISCOVERY_SYMBOLS.length} PAIRS`);
  }

  const BATCH = 5;
  const signals = [];

  for (let i = 0; i < DISCOVERY_SYMBOLS.length; i += BATCH){
    const batch = DISCOVERY_SYMBOLS.slice(i, i + BATCH);
    const res   = await Promise.all(batch.map(s => processDiscovery(s)));
    for (const r of res){
      const s = analyze(r, btcTrend);
      if (s) signals.push(s);
    }
    await sleep(200);
  }

  const duration = Date.now() - start;
  console.log(`[DISCOVERY] SCAN — ${DISCOVERY_SYMBOLS.length} PAIRS | ${duration} MS | ${signals.length} SETUP`);

  if (!signals.length){
    return;
  }

  const best = signals.sort((a,b)=>b.score-a.score)[0];

  if (now - lastGlobalTradeTime < GLOBAL_COOLDOWN_MS){
    console.log(`[DISCOVERY] COOLDOWN — ${best.symbol}`);
    return;
  }

  if (!antiSpam(best.symbol,best.direction)){
    console.log(`[DISCOVERY] ANTISPAM — ${best.symbol}`);
    return;
  }

  console.log(`[DISCOVERY] SIGNAL — ${best.symbol} ${best.direction} | SCORE ${best.score}`);

  const emoji = best.direction==="LONG" ? "🚀" : "🪂";

  const msg =
`⚡ *JTF DISCOVERY v1.7* ⚡

${emoji} *${best.symbol}* — ${best.direction}
🏅 Score: ${best.score}

💠 Entry: ${best.limitEntry}
🎯 TP: ${best.tp}
🛑 SL: ${best.sl}

📊 Vol: x${best.volRatio}
🌡️ Vola: ${best.vola}%
📘 OB: ${best.obRatio}
⚖️ Levier: ${best.levier}`;

  await sendTelegram(msg);
  lastGlobalTradeTime = now;
}

// ========= MAIN =========
export async function startDiscovery(){
  console.log("🔥 DISCOVERY On");
  await sendTelegram("🟢 DISCOVERY On");
  while(true){
    try{
      await scanDiscovery();
    }catch(e){
      console.log("[DISCOVERY ERROR]",e);
    }
    await sleep(SCAN_INTERVAL_MS);
  }
}