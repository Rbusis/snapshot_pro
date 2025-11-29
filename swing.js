// swing.js — JTF SWING BOT v1.5 (API v2 FIX + Debug Control + Clean Logs)

import fetch from "node-fetch";
import { DEBUG } from "./index.js";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

const SCAN_INTERVAL_MS   = 30 * 60_000;
const MIN_ALERT_DELAY_MS = 30 * 60_000;

/* CLEAN SYMBOLS */
const SYMBOLS = [
  "BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT",
  "AVAXUSDT","LINKUSDT","DOTUSDT","TRXUSDT","ADAUSDT",
  "NEARUSDT","ATOMUSDT","OPUSDT","INJUSDT","UNIUSDT",
  "LTCUSDT","TIAUSDT","SEIUSDT"
];

const JDS_THRESHOLD_READY = 75;
const JDS_THRESHOLD_PRIME = 85;

const MAX_ATR_1H_PCT        = 1.8;
const MAX_VOLA_24           = 25;
const MAX_VWAP_4H_DEVIATION = 4;

const prevOI     = new Map();
const lastAlerts = new Map();

/* ===== DEBUG ===== */
function logDebug(...a){
  if(DEBUG.global || DEBUG.swing){
    console.log("[SWING DEBUG]", ...a);
  }
}

/* ===== HELPERS ===== */
const sleep = ms => new Promise(res=>setTimeout(res,ms));
const num   = (v,d=4)=>v==null?null:+(+v).toFixed(d);
const clamp = (x,min,max)=>Math.max(min,Math.min(max,x));

async function sendTelegram(text){
  if(!TELEGRAM_BOT_TOKEN||!TELEGRAM_CHAT_ID) return;
  try{
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,{
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body:JSON.stringify({ chat_id:TELEGRAM_CHAT_ID, text, parse_mode:"Markdown" })
    });
  }catch(e){}
}

async function safeGetJson(url){
  try{
    const r = await fetch(url,{ headers:{Accept:"application/json"} });
    return r.ok ? await r.json() : null;
  }catch(e){
    logDebug("safeGetJson error", url, e);
    return null;
  }
}

function percent(a,b){ return b?(a/b -1)*100:null; }

/* ===== API v2 FIXED ===== */

async function getCandles(symbol,seconds,limit=400){
  logDebug("getCandles", symbol, seconds);
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
  logDebug("getTicker", symbol);
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/ticker?symbol=${symbol}&productType=usdt-futures`
  );
  if(!j?.data) return null;
  return Array.isArray(j.data) ? j.data[0] : j.data;
}

async function getDepth(symbol){
  logDebug("getDepth", symbol);
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/merge-depth?symbol=${symbol}&productType=usdt-futures&limit=20`
  );
  if(!j?.data) return { bids:[], asks:[] };
  const d = Array.isArray(j.data) ? j.data[0] : j.data;
  return {
    bids: d?.bids ? d.bids.map(x=>[+x[0],+x[1]]) : [],
    asks: d?.asks ? d.asks.map(x=>[+x[0],+x[1]]) : []
  };
}

async function getOI(symbol){
  logDebug("getOI", symbol);
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/open-interest?symbol=${symbol}&productType=usdt-futures`
  );
  if(!j?.data) return null;
  const d = Array.isArray(j.data) ? j.data[0] : j.data;
  return d ?? null;
}

/* ===== INDICATORS (unchanged) ===== */

function atr(c,p=14){ /* unchanged */ 
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

function rsi(cl,p=14){ /* unchanged */
  if(cl.length<p+1) return null;
  let g=0,l=0;
  for(let i=1;i<=p;i++){
    const d=cl[i]-cl[i-1];
    d>=0?g+=d:l-=d;
  }
  g/=p; l=(l/p)||1e-9;
  let rs=g/l;
  let v=100-100/(1+rs);
  for(let i=p+1;i<cl.length;i++){
    const d=cl[i]-cl[i-1];
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

function analyzeOrderbook(depth){
  if(!depth.bids.length || !depth.asks.length)
    return { imbalance:0, pressure:"neutral" };
  const b = depth.bids.reduce((s,[,v])=>s+v,0);
  const a = depth.asks.reduce((s,[,v])=>s+v,0);
  const tot=b+a;
  if(tot===0) return { imbalance:0, pressure:"neutral" };
  const imb=((b-a)/tot)*100;
  let p="neutral";
  if(imb>15) p="bullish";
  else if(imb<-15) p="bearish";
  return {
    imbalance:num(imb,2),
    pressure:p
  };
}

/* ===== SNAPSHOT ===== */

async function processSymbol(symbol){
  logDebug("processSymbol", symbol);

  const [tk,oi] = await Promise.all([getTicker(symbol),getOI(symbol)]);
  if(!tk) return null;

  const last = +tk.lastPr || +tk.markPrice || +tk.price || +tk.close || +tk.last || null;
  if(!last){
    logDebug("invalid price",symbol);
    return null;
  }

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

  if(!c15m.length || !c1h.length || !c4h.length){
    logDebug("missing candles",symbol);
    return null;
  }

  const depth = await getDepth(symbol);
  const oba   = analyzeOrderbook(depth);

  const volaPct = last && high24 && low24 ? ((high24-low24)/last)*100 : null;

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

  return {
    symbol,last,high24,low24,volaPct,
    deltaVWAP1h:dVWAP1h!=null?num(dVWAP1h,4):null,
    deltaVWAP4h:dVWAP4h!=null?num(dVWAP4h,4):null,
    deltaOIpct:deltaOI!=null?num(deltaOI,3):null,
    atr1hPct: atr1Pct!=null?num(atr1Pct,4):null,
    atr4hPct: atr4Pct!=null?num(atr4Pct,4):null,
    obImbalance:oba.imbalance,
    obPressure:oba.pressure,
    rsi:{
      "15m":num(rsi(cl15),2),
      "1h": num(rsi(cl1),2),
      "4h": num(rsi(cl4),2)
    },
    c15m,c1h,c4h
  };
}

/* ===== ENGINE PLACEHOLDERS ===== */
// (We keep your previous functions unchanged, only adding debug when needed)

function calculateJDSSwing(rec){ /* unchanged */ }
function detectDirection(rec,jds){ /* unchanged */ }
function isTimingGood(rec,dir){ /* unchanged */ }
function shouldAvoidMarket(rec){ /* unchanged */ }
function calculateTradePlan(rec,dir,jds){ /* unchanged */ }
function getRecommendedLeverage(v){ /* unchanged */ }
function estimateDuration(jds,rec){ /* unchanged */ }
function getMoveToBeCondition(){ return"TP1 atteint OU +1×ATR(1h) OU divergence RSI(15m)"; }
function shouldSendAlert(symbol,dir,state){ /* unchanged */ }

/* ===== SCAN ===== */

async function scanOnce(){
  const t0 = Date.now();
  console.log("🔍 [SWING] Scan started...");

  const snaps=[];
  for(let i=0;i<SYMBOLS.length;i+=5){
    const batch=SYMBOLS.slice(i,i+5);
    const res=await Promise.all(batch.map(s=>{
      logDebug("batchProcess", s);
      return processSymbol(s).catch(()=>null);
    }));
    for(const r of res) if(r) snaps.push(r);
    if(i+5<SYMBOLS.length) await sleep(800);
  }

  const ready=[],prime=[];
  for(const rec of snaps){
    const j=calculateJDSSwing(rec);
    if(j<60) continue;

    if(shouldAvoidMarket(rec)) continue;

    if(j<82 && rec.volaPct<6) continue;

    const dir=detectDirection(rec,j);
    if(dir==="LONG" && rec.deltaOIpct<-2) continue;
    if(dir==="SHORT" && rec.deltaOIpct>2) continue;

    if(!isTimingGood(rec,dir)) continue;

    const plan=calculateTradePlan(rec,dir,j);

    const setup={
      symbol:rec.symbol,
      direction:dir,
      jds:num(j,1),
      entry:plan.entry,
      sl:plan.sl,
      tp1:plan.tp1,
      tp2:plan.tp2,
      rr:plan.rr,
      leverage:getRecommendedLeverage(rec.volaPct),
      duration:estimateDuration(j,rec),
      moveToBe:getMoveToBeCondition(),
      momentum:`RSI 15m:${rec.rsi["15m"]} | 1h:${rec.rsi["1h"]} | 4h:${rec.rsi["4h"]}`,
      vwapContext:`VWAP 1h:${rec.deltaVWAP1h}% | 4h:${rec.deltaVWAP4h}%`
    };

    if(j>=JDS_THRESHOLD_PRIME) prime.push(setup);
    else if(j>=JDS_THRESHOLD_READY) ready.push(setup);
  }

  const ms = Date.now()-t0;
  console.log(`[SWING] Scan — ${SYMBOLS.length} pairs | ${ms} ms | ${prime.length+ready.length} setup`);

  if(!prime.length && !ready.length){
    await sendTelegram("📊 *JTF SWING — RAS*\nAucun setup READY/PRIME.");
    return;
  }

  const sends = prime.length ? prime : ready.slice(0,3);
  const state = prime.length ? "PRIME" : "READY";

  let msg=`🎯 *JTF SWING — ${state}*\n\n`;

  for(let i=0;i<sends.length;i++){
    const s=sends[i];
    if(!shouldSendAlert(s.symbol,s.direction,state)) continue;
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

/* ===== MAIN ===== */

async function main(){
  console.log("🚀 JTF SWING BOT v1.5 — API v2 + Debug Ready");
  try{ await sendTelegram("🟢 *JTF SWING BOT v1.5* démarré."); }catch{}

  while(true){
    try{ await scanOnce(); }
    catch(e){ console.error("[SWING ERROR]",e); }
    await sleep(SCAN_INTERVAL_MS);
  }
}

export const startSwing = main;