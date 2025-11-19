// index.js — JTF v0.8.1.2 AUTOSELECT
// MMS Score + JDS Fusion + ΔOI mémoire + Telegram Alerts
// Compatible Railway — ESM — Aucun fichier écrit

import fetch from "node-fetch";

// ========== CONFIG ==========

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

const SCAN_INTERVAL_MS   = 5 * 60_000;   // 5 minutes
const ALERT_THRESHOLD    = 80;           // jds final >= 80
const MIN_ALERT_DELAY_MS = 15 * 60_000;  // anti-spam 15 minutes

// mémoire runtime (pas de fichiers sur Railway)
const prevOI     = new Map();   // symbol -> OI précédent
const lastAlerts = new Map();   // "BTC-LONG" -> timestamp

// TOP30 Bitget USDT Perp
const SYMBOLS = [
  "BTCUSDT_UMCBL","ETHUSDT_UMCBL","BNBUSDT_UMCBL","SOLUSDT_UMCBL","XRPUSDT_UMCBL",
  "ADAUSDT_UMCBL","DOGEUSDT_UMCBL","AVAXUSDT_UMCBL","DOTUSDT_UMCBL","TRXUSDT_UMCBL",
  "LINKUSDT_UMCBL","TONUSDT_UMCBL","SUIUSDT_UMCBL","APTUSDT_UMCBL","NEARUSDT_UMCBL",
  "ARBUSDT_UMCBL","OPUSDT_UMCBL","INJUSDT_UMCBL","ATOMUSDT_UMCBL","AAVEUSDT_UMCBL",
  "LTCUSDT_UMCBL","UNIUSDT_UMCBL","FILUSDT_UMCBL","XLMUSDT_UMCBL","RUNEUSDT_UMCBL",
  "ALGOUSDT_UMCBL","PEPEUSDT_UMCBL","WIFUSDT_UMCBL","TIAUSDT_UMCBL","SEIUSDT_UMCBL"
];

// ========== UTILS ==========

const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const num = (v,d=6)=>v==null?null:+(+v).toFixed(d);
const clamp = (x,min,max)=>Math.max(min,Math.min(max,x));

function base(sym){ return sym.replace("_UMCBL",""); }

async function safeGetJson(url){
  try{
    const r = await fetch(url,{headers:{Accept:"application/json"}});
    if(!r.ok) return null;
    return await r.json();
  }catch{return null;}
}

// ========== API HELPERS ==========

async function getCandles(symbol, seconds, limit=400){
  const b = base(symbol);
  let j = await safeGetJson(`https://api.bitget.com/api/v2/mix/market/candles?symbol=${b}&granularity=${seconds}&productType=usdt-futures&limit=${limit}`);
  if(j?.data?.length){
    return j.data.map(c=>({t:+c[0],o:+c[1],h:+c[2],l:+c[3],c:+c[4],v:+c[5]})).sort((a,b)=>a.t-b.t);
  }
  j = await safeGetJson(`https://api.bitget.com/api/mix/v1/market/candles?symbol=${symbol}&granularity=${seconds}&limit=${limit}`);
  if(j?.data?.length){
    return j.data.map(c=>({t:+c[0],o:+c[1],h:+c[2],l:+c[3],c:+c[4],v:+c[5]})).sort((a,b)=>a.t-b.t);
  }
  return [];
}

async function getTicker(sym){
  const j = await safeGetJson(`https://api.bitget.com/api/mix/v1/market/ticker?symbol=${sym}`);
  return j?.data ?? null;
}

async function getMarkPrice(sym){
  const j = await safeGetJson(`https://api.bitget.com/api/mix/v1/market/mark-price?symbol=${sym}`);
  if(j?.data?.markPrice!=null) return +j.data.markPrice;
  const tk = await getTicker(sym);
  return tk?.markPrice?+tk.markPrice:null;
}

async function getDepth(sym){
  const j = await safeGetJson(`https://api.bitget.com/api/mix/v1/market/depth?symbol=${sym}&limit=5`);
  if(j?.data?.bids && j.data.asks){
    return {
      bids: j.data.bids.map(x=>[+x[0],+x[1]]),
      asks: j.data.asks.map(x=>[+x[0],+x[1]])
    };
  }
  return {bids:[],asks:[]};
}

async function getFunding(sym){
  const j = await safeGetJson(`https://api.bitget.com/api/mix/v1/market/currentFundRate?symbol=${sym}`);
  return j?.data ?? null;
}

async function getOI(sym){
  const j = await safeGetJson(`https://api.bitget.com/api/mix/v1/market/open-interest?symbol=${sym}`);
  return j?.data ?? null;
}

// ========== INDICATORS ==========

function percent(a,b){ return b ? (a/b - 1)*100 : null; }

function ema(arr,period,acc=x=>x){
  if(!arr.length) return null;
  const k = 2/(period+1);
  let e = acc(arr[0]);
  for(let i=1;i<arr.length;i++){
    const v = acc(arr[i]);
    e = v*k + e*(1-k);
  }
  return e;
}

function rsi(closes,p=14){
  if(closes.length<p+1) return null;
  let g=0,l=0;
  for(let i=1;i<=p;i++){
    const d=closes[i]-closes[i-1];
    if(d>=0) g+=d; else l-=d;
  }
  g/=p; l=(l/p)||1e-9;
  let rs=g/l; let val=100-100/(1+rs);
  for(let i=p+1;i<closes.length;i++){
    const d=closes[i]-closes[i-1];
    const G=Math.max(d,0), L=Math.max(-d,0);
    g=(g*(p-1)+G)/p;
    l=((l*(p-1)+L)/p)||1e-9;
    rs=g/l; val=100-100/(1+rs);
  }
  return val;
}

function closeChange(c,bars=1){
  if(c.length<bars+1) return null;
  return percent(c[c.length-1].c, c[c.length-1-bars].c);
}

function vwap(c){
  let pv=0,v=0;
  for(const x of c){
    const p=(x.h+x.l+x.c)/3;
    pv+=p*x.v; v+=x.v;
  }
  return v?pv/v:null;
}

// ========== MMS SCORE ==========

function toScore100(x){
  if(x==null||isNaN(x)) return null;
  return clamp((x+1)/2 *100,0,100);
}

// ========== PROCESS SYMBOL ==========

async function processSymbol(symbol){
  const [tk, fr, oi] = await Promise.all([
    getTicker(symbol),
    getFunding(symbol),
    getOI(symbol)
  ]);
  if(!tk) return null;

  const last  = +tk.last;
  const high24= +tk.high24h;
  const low24 = +tk.low24h;

  const openInterest = oi ? +oi.amount : null;
  const prev = prevOI.get(symbol) ?? null;
  const deltaOI = (prev!=null && openInterest!=null && prev!==0)
    ? ((openInterest - prev)/prev)*100
    : null;
  prevOI.set(symbol, openInterest ?? prev);

  const [c1m,c5m,c15m,c1h] = await Promise.all([
    getCandles(symbol,60,120),
    getCandles(symbol,300,120),
    getCandles(symbol,900,400),
    getCandles(symbol,3600,400)
  ]);

  const [depth,markPrice] = await Promise.all([
    getDepth(symbol),
    getMarkPrice(symbol)
  ]);

  // ΔP
  const dP_5m  = closeChange(c5m,1);
  const dP_15m = closeChange(c15m,1);

  // ΔVWAP
  const vwap1h    = vwap(c1h.slice(-48));
  const deltaVWAP = (vwap1h && last)? percent(last,vwap1h):null;

  // RSI
  const rsi15 = rsi(c15m.map(x=>x.c),14);

  // MMS Long/Short
  const longNorm = {
    m15: dP_15m!=null?clamp(-dP_15m/2,-1,1):0,
    m5:  dP_5m !=null?clamp(-dP_5m /2,-1,1):0,
    vwap:deltaVWAP!=null?clamp(-deltaVWAP/2,-1,1):0,
    rsi: rsi15!=null?clamp((50-rsi15)/20,-1,1):0
  };

  const shortNorm = {
    m15: dP_15m!=null?clamp(dP_15m/2,-1,1):0,
    m5:  dP_5m !=null?clamp(dP_5m /2,-1,1):0,
    vwap:deltaVWAP!=null?clamp(deltaVWAP/2,-1,1):0,
    rsi: rsi15!=null?clamp((rsi15-50)/20,-1,1):0
  };

  const MMS_long_raw  = longNorm.m15*0.4 + longNorm.m5*0.2 + longNorm.vwap*0.2 + longNorm.rsi*0.2;
  const MMS_short_raw = shortNorm.m15*0.4 + shortNorm.m5*0.2 + shortNorm.vwap*0.2 + shortNorm.rsi*0.2;

  const MMS_long  = toScore100(MMS_long_raw);
  const MMS_short = toScore100(MMS_short_raw);

  return {
    symbol,
    last,
    markPrice,
    deltaVWAPpct: num(deltaVWAP,4),
    deltaOIpct:   num(deltaOI,3),
    rsi15:        num(rsi15,2),
    dP_15m:       num(dP_15m,2),
    MMS_long,
    MMS_short
  };
}

// ========== FUSION MMS → JDS FINAL ==========

function fuse(record){
  const L = record.MMS_long;
  const S = record.MMS_short;

  if(L==null && S==null) return null;

  if((S ?? -999) > (L ?? -999)){
    return { direction:"SHORT", jds:S };
  }else{
    return { direction:"LONG", jds:L };
  }
}

// ========== ANTI-SPAM ==========

function shouldAlert(symbol,dir,jds){
  if(jds < ALERT_THRESHOLD) return false;
  const key = `${symbol}-${dir}`;
  const now = Date.now();
  const last = lastAlerts.get(key) ?? 0;
  if(now-last < MIN_ALERT_DELAY_MS) return false;
  lastAlerts.set(key,now);
  return true;
}

// ========== TELEGRAM ==========

async function sendTelegram(text){
  if(!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID){
    console.error("❌ Missing Telegram config");
    return;
  }
  try{
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,{
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode:"Markdown" })
    });
  }catch(e){
    console.error("❌ Telegram:",e.message);
  }
}

// ========== SCAN COMPLET ==========

async function scanOnce(){
  console.log("🔍 Scan complet…");

  const results = [];
  for(const s of SYMBOLS){
    try{
      const r = await processSymbol(s);
      if(r) results.push(r);
    }catch(e){
      console.error("Erreur:",s,e.message);
    }
    await sleep(120);
  }

  let bestL=null, bestS=null;

  for(const r of results){
    const f = fuse(r);
    if(!f) continue;

    if(f.direction==="LONG"){
      if(!bestL || f.jds > bestL.jds) bestL = {r,...f};
    } else {
      if(!bestS || f.jds > bestS.jds) bestS = {r,...f};
    }
  }

  // LONG ALERT
  if(bestL && shouldAlert(bestL.r.symbol,"LONG",bestL.jds)){
    const e=bestL.r;
    await sendTelegram(
`*JTF ALERT — LONG*
Pair: \`${e.symbol}\`
JDS/100: *${bestL.jds.toFixed(1)}*
MMS(L,S): ${e.MMS_long}/${e.MMS_short}
Prix: ${e.last}
ΔVWAP: ${e.deltaVWAPpct}%
ΔOI: ${e.deltaOIpct}%
RSI15m: ${e.rsi15}
Idée: momentum LONG cohérent.`
    );
  }

  // SHORT ALERT
  if(bestS && shouldAlert(bestS.r.symbol,"SHORT",bestS.jds)){
    const e=bestS.r;
    await sendTelegram(
`*JTF ALERT — SHORT*
Pair: \`${e.symbol}\`
JDS/100: *${bestS.jds.toFixed(1)}*
MMS(L,S): ${e.MMS_long}/${e.MMS_short}
Prix: ${e.last}
ΔVWAP: ${e.deltaVWAPpct}%
ΔOI: ${e.deltaOIpct}%
RSI15m: ${e.rsi15}
Idée: momentum SHORT cohérent.`
    );
  }

  console.log("✅ Scan terminé.");
}

// ========== MAIN LOOP ==========

async function main(){
  console.log("🚀 JTF Scanner démarré (ESM / Railway).");
  await sendTelegram("🟢 JTF Scanner Railway démarré (scan toutes les 5 minutes).");

  while(true){
    try{
      await scanOnce();
    }catch(e){
      console.error("❌ Scan error:",e.message);
    }
    await sleep(SCAN_INTERVAL_MS);
  }
}

main();