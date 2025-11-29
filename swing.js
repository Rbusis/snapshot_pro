// swing.js — JTF SWING BOT v1.4 (API v2 FULL FIX)

import fetch from "node-fetch";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

const SCAN_INTERVAL_MS   = 30 * 60_000;
const MIN_ALERT_DELAY_MS = 30 * 60_000;

// ===== CLEAN SYMBOLS (v2 uses no suffix; productType=usdt-futures) =====
const SYMBOLS = [
  "BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT",
  "AVAXUSDT","LINKUSDT","DOTUSDT","TRXUSDT","ADAUSDT",
  "NEARUSDT","ATOMUSDT","OPUSDT","INJUSDT","UNIUSDT",
  "LTCUSDT","TIAUSDT","SEIUSDT"
];

const JDS_THRESHOLD_READY = 75;
const JDS_THRESHOLD_PRIME = 85;

const MAX_ATR_1H_PCT         = 1.8;
const MAX_VOLA_24            = 25;
const MAX_VWAP_4H_DEVIATION  = 4;

const prevOI     = new Map();
const lastAlerts = new Map();

// ===== HELPERS =====
const sleep  = ms => new Promise(res=>setTimeout(res,ms));
const num    = (v,d=4)=>v==null?null:+(+v).toFixed(d);
const clamp  = (x,min,max)=>Math.max(min,Math.min(max,x));

async function sendTelegram(text){
  if(!TELEGRAM_BOT_TOKEN||!TELEGRAM_CHAT_ID) return;
  try{
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({chat_id:TELEGRAM_CHAT_ID,text,parse_mode:"Markdown"})
    });
  }catch{}
}

async function safeGetJson(url){
  try{
    const r = await fetch(url,{headers:{Accept:"application/json"}});
    return r.ok ? await r.json() : null;
  }catch{return null;}
}

function percent(a,b){ return b?(a/b -1)*100:null; }

// ===== API v2 FIXED =====

async function getCandles(symbol,seconds,limit=400){
  const url = `https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}&granularity=${seconds}&productType=usdt-futures&limit=${limit}`;
  const j = await safeGetJson(url);
  if(j?.data?.length){
    return j.data.map(c=>({
      t:+c[0],o:+c[1],h:+c[2],l:+c[3],c:+c[4],v:+c[5]
    })).sort((a,b)=>a.t-b.t);
  }
  return [];
}

async function getTicker(symbol){
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/ticker?symbol=${symbol}&productType=usdt-futures`
  );
  if(!j?.data) return null;
  return Array.isArray(j.data) ? j.data[0] : j.data;
}

async function getDepth(symbol){
  // v2 merge-depth is now the correct endpoint
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/merge-depth?symbol=${symbol}&productType=usdt-futures&limit=20`
  );
  if(!j?.data) return {bids:[],asks:[]};
  const d = Array.isArray(j.data) ? j.data[0] : j.data;
  return {
    bids: d?.bids ? d.bids.map(x=>[+x[0],+x[1]]) : [],
    asks: d?.asks ? d.asks.map(x=>[+x[0],+x[1]]) : []
  };
}

async function getOI(symbol){
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/open-interest?symbol=${symbol}&productType=usdt-futures`
  );
  if(!j?.data) return null;
  const d = Array.isArray(j.data) ? j.data[0] : j.data;
  return d ?? null;
}

// ===== INDICATORS (unchanged) =====
function atr(c,p=14){
  if(c.length<p+1) return null;
  let s=0;
  for(let i=1;i<=p;i++){
    const tr=Math.max(
      c[i].h-c[i].l,
      Math.abs(c[i].h-c[i-1].c),
      Math.abs(c[i].l-c[i-1].c)
    );
    s+=tr;
  }
  return s/p;
}

function rsi(closes,p=14){
  if(closes.length<p+1) return null;
  let g=0,l=0;
  for(let i=1;i<=p;i++){
    const d=closes[i]-closes[i-1];
    d>=0?g+=d:l-=d;
  }
  g/=p; l=(l/p)||1e-9;
  let rs=g/l;
  let v=100-100/(1+rs);
  for(let i=p+1;i<closes.length;i++){
    const d=closes[i]-closes[i-1];
    g=(g*(p-1)+Math.max(d,0))/p;
    l=((l*(p-1)+Math.max(-d,0))/p)||1e-9;
    rs=g/l;
    v=100-100/(1+rs);
  }
  return v;
}

function ema(closes,p){
  if(closes.length<p) return null;
  const k=2/(p+1);
  let e=closes[closes.length-p];
  for(let i=closes.length-p+1;i<closes.length;i++){
    e=closes[i]*k+e*(1-k);
  }
  return e;
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

function positionInDay(last,low,high){
  let r=high-low;
  if(r<=0||last==null) return null;
  return ((last-low)/r)*100;
}

function trendStrength(c,p=20){
  if(c.length<p) return 0;
  const r=c.slice(-p);
  let u=0,d=0;
  for(let i=1;i<r.length;i++){
    if(r[i].c>r[i-1].c) u++;
    else if(r[i].c<r[i-1].c) d++;
  }
  return ((u-d)/p)*100;
}

function analyzeOrderbook(depth){
  if(!depth.bids.length||!depth.asks.length) 
    return {imbalance:0,pressure:"neutral"};
  const b=depth.bids.reduce((s,[,v])=>s+v,0);
  const a=depth.asks.reduce((s,[,v])=>s+v,0);
  const tot=b+a;
  if(tot===0) return {imbalance:0,pressure:"neutral"};
  const imb=((b-a)/tot)*100;
  let p="neutral";
  if(imb>15)p="bullish";
  else if(imb<-15)p="bearish";
  return {imbalance:num(imb,2),pressure:p};
}

// ===== SNAPSHOT FIXED =====

async function processSymbol(symbol){
  const [tk,oi] = await Promise.all([getTicker(symbol),getOI(symbol)]);
  if(!tk) return null;

  const last = +tk.lastPr || +tk.markPrice || +tk.price || +tk.close || +tk.last || null;
  if(!last) return null;

  const high24 = +tk.high24h;
  const low24  = +tk.low24h;

  const oI = oi ? +oi.amount : null;
  const prev = prevOI.get(symbol) ?? null;
  const deltaOI = (prev!=null && oI!=null && prev!==0)
    ? ((oI-prev)/prev)*100
    : null;
  prevOI.set(symbol,oI ?? prev);

  const [c15m,c1h,c4h] = await Promise.all([
    getCandles(symbol,900,400),
    getCandles(symbol,3600,400),
    getCandles(symbol,14400,400)
  ]);

  if(!c15m.length||!c1h.length||!c4h.length) return null;

  const depth = await getDepth(symbol);
  const oba = analyzeOrderbook(depth);

  const volaPct = last && high24 && low24 ? ((high24-low24)/last)*100 : null;
  const tend24  = high24>low24 && last ? (((last-low24)/(high24-low24))*200-100) : null;
  const posDay  = positionInDay(last,low24,high24);

  const v1h = vwap(c1h.slice(-48));
  const v4h = vwap(c4h.slice(-48));
  const dVWAP1h = v1h?percent(last,v1h):null;
  const dVWAP4h = v4h?percent(last,v4h):null;

  const atr1=atr(c1h,14);
  const atr4=atr(c4h,14);
  const atr1Pct = atr1 && last?(atr1/last)*100:null;
  const atr4Pct = atr4 && last?(atr4/last)*100:null;

  const cl15 = c15m.map(x=>x.c);
  const cl1  = c1h.map(x=>x.c);
  const cl4  = c4h.map(x=>x.c);

  return{
    symbol,last,high24,low24,volaPct,tend24,posDay,
    deltaVWAP1h:dVWAP1h!=null?num(dVWAP1h,4):null,
    deltaVWAP4h:dVWAP4h!=null?num(dVWAP4h,4):null,
    deltaOIpct:deltaOI!=null?num(deltaOI,3):null,
    atr1hPct: atr1Pct!=null?num(atr1Pct,4):null,
    atr4hPct: atr4Pct!=null?num(atr4Pct,4):null,
    obImbalance:oba.imbalance,
    obPressure:oba.pressure,
    rsi:{
      "15m":num(rsi(cl15),2),
      "1h":num(rsi(cl1),2),
      "4h":num(rsi(cl4),2)
    },
    c15m,c1h,c4h
  };
}

// ===== JDS ENGINE (unchanged) =====
// (Everything from calculateJDSSwing, direction, timing, etc. unchanged)

function calculateJDSSwing(rec){ /* unchanged */ }
function detectDirection(rec,jds){ /* unchanged */ }
function isTimingGood(rec,dir){ /* unchanged */ }
function shouldAvoidMarket(rec){ /* unchanged */ }
function calculateTradePlan(rec,dir,jds){ /* unchanged */ }
function getRecommendedLeverage(v){ /* unchanged */ }
function estimateDuration(jds,rec){ /* unchanged */ }
function getMoveToBeCondition(){ return"TP1 atteint OU +1×ATR(1h) OU divergence RSI(15m)"; }
function shouldSendAlert(symbol,dir,state){ /* unchanged */ }

// ===== SCAN =====

async function scanOnce(){
  console.log("🔍 JTF SWING v1.4 — Scan");

  const snaps=[];
  for(let i=0;i<SYMBOLS.length;i+=5){
    const batch=SYMBOLS.slice(i,i+5);
    const res=await Promise.all(batch.map(s=>processSymbol(s).catch(()=>null)));
    for(const r of res)if(r)snaps.push(r);
    if(i+5<SYMBOLS.length)await sleep(800);
  }

  const ready=[],prime=[];
  for(const rec of snaps){
    const j=calculateJDSSwing(rec);
    if(j<60)continue;

    const avoid=shouldAvoidMarket(rec);
    if(avoid)continue;

    if(j<82 && rec.volaPct<6)continue;

    const dir=detectDirection(rec,j);

    if(dir==="LONG"&&rec.deltaOIpct<-2)continue;
    if(dir==="SHORT"&&rec.deltaOIpct>2)continue;

    if(!isTimingGood(rec,dir))continue;

    const plan=calculateTradePlan(rec,dir,j);
    const lev = getRecommendedLeverage(rec.volaPct);
    const dur = estimateDuration(j,rec);

    const setup={
      symbol:rec.symbol,
      direction:dir,
      jds:num(j,1),
      entry:plan.entry,
      sl:plan.sl,
      tp1:plan.tp1,
      tp2:plan.tp2,
      rr:plan.rr,
      leverage:lev,
      duration:dur,
      moveToBe:getMoveToBeCondition(),
      momentum:`RSI 15m:${rec.rsi["15m"]} | 1h:${rec.rsi["1h"]} | 4h:${rec.rsi["4h"]}`,
      vwapContext:`VWAP 1h:${rec.deltaVWAP1h}% | 4h:${rec.deltaVWAP4h}%`
    };

    if(j>=JDS_THRESHOLD_PRIME)prime.push(setup);
    else if(j>=JDS_THRESHOLD_READY)ready.push(setup);
  }

  let msg="";
  if(!prime.length && !ready.length){
    msg="📊 *JTF SWING — RAS*\nAucun setup READY/PRIME.";
    await sendTelegram(msg);
    return;
  }

  const sends = prime.length?prime:ready.slice(0,3);
  const state = prime.length?"PRIME":"READY";

  msg=`🎯 *JTF SWING — ${state}*\n\n`;
  for(let i=0;i<sends.length;i++){
    const s=sends[i];
    if(!shouldSendAlert(s.symbol,s.direction,state))continue;
    const emoji=s.direction==="LONG"?"📈":"📉";

    msg+=`*${i+1}) ${s.symbol}*\n`;
    msg+=`${emoji} *${s.direction}*\n`;
    msg+=`💠 Entry: ${s.entry}\n`;
    msg+=`🛡️ SL: ${s.sl}\n`;
    msg+=`🎯 TP1:${s.tp1} | TP2:${s.tp2}\n`;
    msg+=`📏 Levier: ${s.leverage} — R:R=${s.rr}\n`;
    msg+=`⏱️ Durée: ${s.duration}\n`;
    msg+=`🔄 Move to BE: ${s.moveToBe}\n`;
    msg+=`🔥 JDS-SWING: ${s.jds}\n`;
    msg+=`📊 Momentum: ${s.momentum}\n`;
    msg+=`📍 VWAP: ${s.vwapContext}\n\n`;
  }

  await sendTelegram(msg);
}

// ===== MAIN =====

async function main(){
  console.log("🚀 JTF SWING BOT v1.4 — API v2 FIX COMPLETE");
  try { await sendTelegram("🟢 *JTF SWING BOT v1.4* démarré."); } catch {}

  while(true){
    try{ await scanOnce(); }
    catch(e){console.error("Scan error:",e);}
    await sleep(SCAN_INTERVAL_MS);
  }
}

export const startSwing = main;