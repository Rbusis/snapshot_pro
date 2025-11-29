// swing.js — SWING v1.5 (Clean Output + Debug Control + API v2 FIX)

import fetch from "node-fetch";
import { DEBUG } from "./debug.js";

// ========= TELEGRAM =========
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

async function sendTelegram(msg){
  if(!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try{
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode:"Markdown" })
    });
  }catch{}
}

// ========= DEBUG =========
function logDebug(...args){
  if(DEBUG.global || DEBUG.swing){
    console.log("[SWING DEBUG]", ...args);
  }
}

// ========= CONFIG =========
const SCAN_INTERVAL_MS = 30 * 60_000;

const JDS_READY = 75;
const JDS_PRIME = 85;

const MAX_ATR_1H   = 1.8;
const MAX_VOLA_24  = 25;
const MAX_VWAP_4H  = 4;

// ========= SYMBOLS =========
const SYMBOLS = [
  "BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT",
  "AVAXUSDT","LINKUSDT","DOTUSDT","TRXUSDT","ADAUSDT",
  "NEARUSDT","ATOMUSDT","OPUSDT","INJUSDT","UNIUSDT",
  "LTCUSDT","TIAUSDT","SEIUSDT"
];

// ========= STATE =========
const prevOI = new Map();
const lastAlerts = new Map();
const sleep = ms => new Promise(r => setTimeout(r, ms));

const num = (v,d=4)=>v==null?null:+(+v).toFixed(d);
const clamp = (x,min,max)=>Math.max(min,Math.min(max,x));

// ========= SAFE FETCH =========
async function safeGetJson(url){
  try{
    const r = await fetch(url,{headers:{Accept:"application/json"}});
    return r.ok ? await r.json() : null;
  }catch(e){
    logDebug("safeGetJson ERROR",url,e);
    return null;
  }
}

// ========= API v2 =========
async function getCandles(symbol,seconds,limit=400){
  logDebug("getCandles",symbol,seconds);
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}&granularity=${seconds}&limit=${limit}&productType=usdt-futures`
  );
  if(!j?.data?.length) return [];
  return j.data.map(c=>({
    t:+c[0],o:+c[1],h:+c[2],l:+c[3],c:+c[4],v:+c[5]
  })).sort((a,b)=>a.t-b.t);
}

async function getTicker(symbol){
  logDebug("getTicker",symbol);
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/ticker?symbol=${symbol}&productType=usdt-futures`
  );
  return j?.data ? (Array.isArray(j.data)?j.data[0]:j.data) : null;
}

async function getDepth(symbol){
  logDebug("getDepth",symbol);
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/merge-depth?symbol=${symbol}&productType=usdt-futures&limit=20`
  );
  if(!j?.data) return { bids:[], asks:[] };
  const d = Array.isArray(j.data)?j.data[0]:j.data;
  return {
    bids: d.bids?.map(x=>[+x[0],+x[1]]) || [],
    asks: d.asks?.map(x=>[+x[0],+x[1]]) || []
  };
}

async function getOI(symbol){
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/open-interest?symbol=${symbol}&productType=usdt-futures`
  );
  const d = j?.data;
  return Array.isArray(d)?d[0]:d;
}

// ========= INDICATORS =========
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

function rsi(cl,p=14){
  if(cl.length<p+1) return null;
  let g=0,l=0;
  for(let i=1;i<=p;i++){
    const d=cl[i]-cl[i-1];
    d>=0?g+=d:l-=d;
  }
  g/=p; l=(l/p)||1e-9;
  let v=100-100/(1+(g/l));

  for(let i=p+1;i<cl.length;i++){
    const d=cl[i]-cl[i-1];
    g=(g*(p-1)+Math.max(d,0))/p;
    l=((l*(p-1)+Math.max(-d,0))/p)||1e-9;
    v=100-100/(1+(g/l));
  }
  return v;
}

function vwap(c){
  let pv=0,v=0;
  for(const x of c){
    const p=(x.h+x.l+x.c)/3;
    pv+=p*x.v; v+=x.v;
  }
  return v?pv/v:null;
}

function positionInDay(last,low,high){
  if(high<=low) return null;
  return ((last-low)/(high-low))*100;
}

// ========= PROCESS =========
async function processSymbol(symbol){
  logDebug("processSymbol",symbol);

  const [tk,oi] = await Promise.all([
    getTicker(symbol),
    getOI(symbol)
  ]);

  if(!tk){
    logDebug("NO TICKER",symbol);
    return null;
  }

  const last = +(
    tk.lastPr ?? tk.markPrice ?? tk.last ?? tk.close ?? null
  );
  if(!last) return null;

  const high24 = tk.high24h?+tk.high24h:null;
  const low24  = tk.low24h?+tk.low24h:null;

  const openI = oi?.amount!=null?+oi.amount:null;
  const prev  = prevOI.get(symbol) ?? null;
  const deltaOI = (prev!=null && openI!=null && prev!==0)
    ? ((openI-prev)/prev)*100
    : null;
  prevOI.set(symbol,openI ?? prev);

  const [c15,c1h,c4h] = await Promise.all([
    getCandles(symbol,900,400),
    getCandles(symbol,3600,400),
    getCandles(symbol,14400,400)
  ]);

  if(!c15.length || !c1h.length || !c4h.length){
    logDebug("missing candles",symbol);
    return null;
  }

  const depth = await getDepth(symbol);
  const volaPct = (high24!=null && low24!=null)
    ? ((high24-low24)/last)*100
    : null;

  const tend24 = (high24>low24 && last)
    ? (((last-low24)/(high24-low24))*200 - 100)
    : null;

  const posDay = positionInDay(last,low24,high24);
  const v1h = vwap(c1h.slice(-48));
  const v4h = vwap(c4h.slice(-48));
  const dVWAP1h = v1h?((last/v1h -1)*100):null;
  const dVWAP4h = v4h?((last/v4h -1)*100):null;

  const atr1 = atr(c1h,14);
  const atr4 = atr(c4h,14);

  const rsi15 = rsi(c15.map(x=>x.c));
  const rsi1h = rsi(c1h.map(x=>x.c));
  const rsi4h = rsi(c4h.map(x=>x.c));

  return {
    symbol,last,high24,low24,volaPct,tend24,posDay,
    dVWAP1h:num(dVWAP1h,4),
    dVWAP4h:num(dVWAP4h,4),
    deltaOIpct:num(deltaOI,3),
    atr1hPct: atr1?num((atr1/last)*100,4):null,
    atr4hPct: atr4?num((atr4/last)*100,4):null,
    rsi:{ "15m":num(rsi15,2),"1h":num(rsi1h,2),"4h":num(rsi4h,2) },
    c15,c1h,c4h
  };
}

// ========= SWING ENGINE =========
// (JDS, detectDirection, timing, filters, etc. inchangés)

function calculateJDSSwing(rec){
  let score=0;

  if(rec.rsi["15m"] > 60) score+=12;
  if(rec.rsi["15m"] < 40) score+=12;

  if(Math.abs(rec.dVWAP1h) < 1.2) score+=10;

  if(rec.deltaOIpct>1) score+=8;
  if(rec.deltaOIpct<-1) score+=8;

  if(rec.atr1hPct<MAX_ATR_1H) score+=12;
  if(rec.volaPct<MAX_VOLA_24) score+=12;

  if(Math.abs(rec.dVWAP4h) < MAX_VWAP_4H) score+=10;

  return score;
}

function detectDirection(rec,jds){
  if(rec.rsi["15m"]>55 && rec.dVWAP1h>0) return "LONG";
  if(rec.rsi["15m"]<45 && rec.dVWAP1h<0) return "SHORT";
  return "NEUTRAL";
}

function isTimingGood(rec,dir){
  if(dir==="LONG")  return rec.rsi["15m"]>55;
  if(dir==="SHORT") return rec.rsi["15m"]<45;
  return false;
}

function shouldAvoid(rec){
  if(rec.atr1hPct>MAX_ATR_1H) return true;
  if(rec.volaPct>MAX_VOLA_24) return true;
  return false;
}

function buildPlan(rec,dir){
  const entry = rec.last;
  const atr = rec.atr1hPct?rec.atr1hPct/100*rec.last:rec.last*0.004;
  const sl = dir==="LONG" ? entry - atr : entry + atr;
  const tp = dir==="LONG" ? entry + atr*2 : entry - atr*2;
  return {
    entry:num(entry,4),
    sl:num(sl,4),
    tp:num(tp,4),
    rr: (2).toFixed(1)
  };
}

// ========= ANTI-SPAM =========
function shouldSend(symbol,dir){
  const key = `${symbol}-${dir}`;
  const now = Date.now();
  const last = lastAlerts.get(key);
  if(last && now-last < 30*60_000) return false;
  lastAlerts.set(key,now);
  return true;
}

// ===== SCAN =====
async function scanOnce(){
  const start = Date.now();
  console.log("🔍 [SWING] SCAN STARTED...");

  const snaps=[];
  for(let i=0;i<SYMBOLS.length;i+=5){
    const batch=SYMBOLS.slice(i,i+5);
    const res=await Promise.all(batch.map(s=>processSymbol(s).catch(()=>null)));
    for(const r of res) if(r)snaps.push(r);
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

  const totalSetup = prime.length + ready.length;
  const duration   = Date.now() - start;
  console.log(`[SWING] SCAN — ${SYMBOLS.length} PAIRS | ${duration} MS | ${totalSetup} SETUP`);

  if(!prime.length && !ready.length){
    // aucun envoi Telegram (on garde le log uniquement)
    return;
  }

  const sends = prime.length?prime:ready.slice(0,3);
  const state = prime.length?"PRIME":"READY";

  let msg=`🎯 *JTF SWING — ${state}*\n\n`;
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

// ========= MAIN LOOP =========
export async function startSwing(){
  console.log("🔥 SWING On");
  await sendTelegram("🟢 SWING On");
  while(true){
    try{ await scanOnce(); }
    catch(e){ console.error("[SWING ERROR]",e); }
    await sleep(SCAN_INTERVAL_MS);
  }
}