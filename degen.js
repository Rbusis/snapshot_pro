// degen.js — JTF DEGEN v3.0 (Stable, API v2, Identique Discovery)

import fetch from "node-fetch";
import { DEBUG } from "./debug.js";

// ========= CONFIG =========
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

const SCAN_INTERVAL_MS       = 2 * 60_000;
const MIN_ALERT_DELAY_MS     = 10 * 60_000;
const GLOBAL_COOLDOWN_MS     = 30 * 60_000;
const SYMBOL_UPDATE_INTERVAL = 60 * 60_000;

// ========= STATE =========
let DEGEN_SYMBOLS      = [];
let lastSymbolUpdate   = 0;
let lastGlobalTradeTime = 0;
const lastAlerts       = new Map();

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
    console.log("[DEGEN safeGetJson ERROR]", e.message);
    return null;
  }
}

// ========= API v2 IDENTIQUE DISCOVERY =========
async function getTicker(symbol){
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/ticker?symbol=${symbol}&productType=usdt-futures`
  );
  return j?.data ? (Array.isArray(j.data) ? j.data[0] : j.data) : null;
}

async function getCandles(symbol, seconds, limit=120){
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}&granularity=${seconds}&limit=${limit}&productType=usdt-futures`
  );
  if(!j?.data?.length) return [];
  return j.data.map(c=>({
    t:+c[0], o:+c[1], h:+c[2], l:+c[3], c:+c[4], v:+c[5]
  })).sort((a,b)=>a.t-b.t);
}

async function getDepth(symbol){
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/merge-depth?symbol=${symbol}&productType=usdt-futures&limit=20`
  );
  if(!j?.data) return null;
  const d = Array.isArray(j.data)?j.data[0]:j.data;
  return d?.bids && d?.asks ? d : null;
}

async function getAllTickers(){
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

// ========= DEGEN LIST (ALIGNE DISCOVERY) =========
async function updateDegenList(){
  const all = await getAllTickers();
  if(!all?.length) return [];

  const list = all
    .filter(t => t.symbol?.endsWith("_UMCBL"))
    .filter(t => +t.usdtVolume > 3_000_000)
    .sort((a,b)=>(+b.usdtVolume)-(+a.usdtVolume))
    .slice(0,40)
    .map(t => t.symbol);

  console.log("[DEGEN] LIST UPDATE:", list.length, "pairs");
  return list;
}

// ========= PROCESS =========
async function processDegen(symbol){
  const tk = await getTicker(symbol);
  if(!tk) return null;

  const last = tk.lastPr ?? tk.markPrice ?? tk.close ?? tk.last ?? null;
  if(!last) return null;

  const high24 = tk.high24h != null ? +tk.high24h : null;
  const low24  = tk.low24h  != null ? +tk.low24h  : null;
  const volaPct = (high24!=null && low24!=null)
    ? ((high24-low24)/last)*100
    : null;

  const [c3m,c15m] = await Promise.all([
    getCandles(symbol,180,120),
    getCandles(symbol,900,120)
  ]);
  if(!c3m?.length) return null;

  const rsi3 = rsi(c3m.map(x=>x.c));
  const vwp  = vwap(c3m.slice(-24));
  const priceVsVwap = vwp ? ((last-vwp)/vwp)*100 : 0;

  const lastC = c3m[c3m.length-1];
  const wick  = wicks(lastC);

  const lastVol = lastC.v;
  const avgVol  = c3m.slice(-11,-1).reduce((a,b)=>a+b.v,0)/10;
  const volRatio = avgVol>0 ? lastVol/avgVol : 1;

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
    symbol,last,volaPct,rsi3,priceVsVwap,
    volRatio,obScore,bidsVol:bids,asksVol:asks,wicks:wick
  };
}

// ========= ANALYZE =========
function analyzeCandidate(rec){
  if(!rec) return null;

  if(rec.volRatio < 2) return null;
  if(rec.volaPct < 3 || rec.volaPct > 20) return null;

  const gap = Math.abs(rec.priceVsVwap);
  if(gap < 0.6 || gap > 3.0) return null;

  let dir=null;
  if(rec.priceVsVwap>0){
    if(rec.wicks.upper>1.3) return null;
    if(rec.obScore<0) return null;
    dir="LONG";
  } else {
    if(rec.wicks.lower>1.3) return null;
    if(rec.obScore>0) return null;
    dir="SHORT";
  }

  let score = 0;
  score += rec.volRatio>=3 ? 30 : 15;
  score += (gap>=1 && gap<=2.2) ? 20 : 10;
  score += (dir==="LONG"
    ? (rec.rsi3>=55&&rec.rsi3<=75?15:5)
    : (rec.rsi3>=25&&rec.rsi3<=45?15:5)
  );
  if((dir==="LONG"&&rec.obScore===1)||(dir==="SHORT"&&rec.obScore===-1))
    score+=15;

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
    last:rec.last,
    entry:num(entry,decimals),
    sl:num(sl,decimals),
    tp:num(tp,decimals),
    volRatio:num(rec.volRatio,2),
    volaPct:num(rec.volaPct,2),
    priceVsVwap:num(rec.priceVsVwap,2),
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
async function scanDegen(){
  console.log("🔍 [DEGEN] SCAN STARTED");

  const now = Date.now();

  if(now-lastSymbolUpdate > SYMBOL_UPDATE_INTERVAL || !DEGEN_SYMBOLS.length){
    DEGEN_SYMBOLS = await updateDegenList();
    lastSymbolUpdate = now;
  }

  const candidates = [];
  const BATCH = 5;

  for(let i=0;i<DEGEN_SYMBOLS.length;i+=BATCH){
    const batch = DEGEN_SYMBOLS.slice(i,i+BATCH);
    const res = await Promise.all(batch.map(s => processDegen(s)));

    for(const r of res){
      const s = analyzeCandidate(r);
      if(s) candidates.push(s);
    }

    await sleep(200);
  }

  console.log(`[DEGEN] SCAN — ${DEGEN_SYMBOLS.length} PAIRS | ${candidates.length} SETUP`);

  if(!candidates.length) return;

  const best = candidates.sort((a,b)=>b.score-a.score)[0];

  if(now-lastGlobalTradeTime < GLOBAL_COOLDOWN_MS){
    console.log(`[DEGEN] COOLDOWN — ${best.symbol}`);
    return;
  }

  if(!antiSpam(best.symbol,best.direction)){
    console.log(`[DEGEN] ANTISPAM — ${best.symbol}`);
    return;
  }

  console.log(`[DEGEN] SIGNAL — ${best.symbol} ${best.direction} | SCORE ${best.score}`);

  const emoji = best.direction==="LONG" ? "🟢🔫" : "🔴🔫";

  const msg =
`🎯 *JTF DEGEN v3.0 (Stable)*

${emoji} *${best.symbol}* — ${best.direction}
🏅 Score: ${best.score}/100

📊 Vol Spike: x${best.volRatio}
🌡️ Vola24: ${best.volaPct}%
📉 ΔVWAP: ${best.priceVsVwap}%

💰 Prix: ${best.last}
🏹 Entry: ${best.entry}
🛑 SL: ${best.sl}
🎯 TP: ${best.tp}

⚖️ Levier: ${best.levier}

_Wait for sniper limit._`;

  await sendTelegram(msg);
  lastGlobalTradeTime = now;
}

// ========= START =========
export async function startDegen(){
  console.log("🔥 DEGEN v3.0 On");
  await sendTelegram("🟢 DEGEN v3.0 On");
  while(true){
    try{ await scanDegen(); }
    catch(e){ console.log("[DEGEN ERROR]", e); }
    await sleep(SCAN_INTERVAL_MS);
  }
}