// index.js — JTF v0.8.1.2 AUTOSELECT
// Full Snapshot TOP30 + MMS + Fusion JDS + Telegram Alerts
// Version Railway — AUCUN fichier écrit, tout en mémoire

import fetch from "node-fetch";

// ====== Config Telegram ======
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

// ====== Config Scanner ======
const SCAN_INTERVAL_MS   = 5 * 60_000;  // 5 minutes
const ALERT_THRESHOLD    = 80;          // JDS min pour envoyer alerte
const MIN_ALERT_DELAY_MS = 15 * 60_000; // anti-spam 15 min

// ====== Mémoire (pas de fichiers) ======
const lastAlerts = new Map();        // "BTC-LONG" -> timestamp
const prevOI     = new Map();        // symbol -> previous OI

// ====== TOP30 ======
const SYMBOLS = [
  "BTCUSDT_UMCBL","ETHUSDT_UMCBL","BNBUSDT_UMCBL","SOLUSDT_UMCBL","XRPUSDT_UMCBL",
  "ADAUSDT_UMCBL","DOGEUSDT_UMCBL","AVAXUSDT_UMCBL","DOTUSDT_UMCBL","TRXUSDT_UMCBL",
  "LINKUSDT_UMCBL","TONUSDT_UMCBL","SUIUSDT_UMCBL","APTUSDT_UMCBL","NEARUSDT_UMCBL",
  "ARBUSDT_UMCBL","OPUSDT_UMCBL","INJUSDT_UMCBL","ATOMUSDT_UMCBL","AAVEUSDT_UMCBL",
  "LTCUSDT_UMCBL","UNIUSDT_UMCBL","FILUSDT_UMCBL","XLMUSDT_UMCBL","RUNEUSDT_UMCBL",
  "ALGOUSDT_UMCBL","PEPEUSDT_UMCBL","WIFUSDT_UMCBL","TIAUSDT_UMCBL","SEIUSDT_UMCBL"
];

// ====== Utils ======
const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const num = (v,d=6)=>v==null?null:+(+v).toFixed(d);
const clamp = (x,min,max)=>Math.max(min,Math.min(max,x));

function baseSymbol(sym){ return sym.replace("_UMCBL",""); }

// safe GET JSON
async function safeGetJson(url){
  try{
    const r = await fetch(url,{headers:{Accept:"application/json"}});
    if(!r.ok) return null;
    return await r.json();
  }catch{return null;}
}

// ====== API Bitget ======
async function getCandles(symbol, seconds, limit=400){
  const base = baseSymbol(symbol);
  const v2 = `https://api.bitget.com/api/v2/mix/market/candles?symbol=${base}&granularity=${seconds}&productType=usdt-futures&limit=${limit}`;
  let j = await safeGetJson(v2);
  if(j?.data?.length){
    return j.data.map(c=>({t:+c[0],o:+c[1],h:+c[2],l:+c[3],c:+c[4],v:+c[5]}))
                 .sort((a,b)=>a.t-b.t);
  }
  const v1 = `https://api.bitget.com/api/mix/v1/market/candles?symbol=${symbol}&granularity=${seconds}&limit=${limit}`;
  j = await safeGetJson(v1);
  if(j?.data?.length){
    return j.data.map(c=>({t:+c[0],o:+c[1],h:+c[2],l:+c[3],c:+c[4],v:+c[5]}))
                 .sort((a,b)=>a.t-b.t);
  }
  return [];
}

async function getTicker(symbol){
  const url = `https://api.bitget.com/api/mix/v1/market/ticker?symbol=${symbol}`;
  const j = await safeGetJson(url);
  return j?.data ?? null;
}
async function getMarkPrice(symbol){
  const url = `https://api.bitget.com/api/mix/v1/market/mark-price?symbol=${symbol}`;
  const j = await safeGetJson(url);
  if(j?.data?.markPrice!=null) return +j.data.markPrice;
  const tk = await getTicker(symbol);
  return tk?.markPrice ? +tk.markPrice : null;
}
async function getDepth(symbol){
  const url = `https://api.bitget.com/api/mix/v1/market/depth?symbol=${symbol}&limit=5`;
  const j = await safeGetJson(url);
  if(j?.data?.bids&&j.data.asks){
    return {
      bids: j.data.bids.map(x=>[+x[0],+x[1]]),
      asks: j.data.asks.map(x=>[+x[0],+x[1]])
    };
  }
  return {bids:[],asks:[]};
}
async function getFunding(symbol){
  const url = `https://api.bitget.com/api/mix/v1/market/currentFundRate?symbol=${symbol}`;
  const j = await safeGetJson(url);
  return j?.data ?? null;
}
async function getOI(symbol){
  const url = `https://api.bitget.com/api/mix/v1/market/open-interest?symbol=${symbol}`;
  const j = await safeGetJson(url);
  return j?.data ?? null;
}

// ==== Indicators =====
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
  let rs=g/l; let r=100-100/(1+rs);
  for(let i=p+1;i<closes.length;i++){
    const d=closes[i]-closes[i-1];
    const G=Math.max(d,0), L=Math.max(-d,0);
    g=(g*(p-1)+G)/p;
    l=((l*(p-1)+L)/p)||1e-9;
    rs=g/l; r=100-100/(1+rs);
  }
  return r;
}
function percent(a,b){ return b?(a/b-1)*100:null; }
function vwap(c){
  let pv=0,v=0;
  for(const x of c){
    const p=(x.h+x.l+x.c)/3; pv+=p*x.v; v+=x.v;
  }
  return v?pv/v:null;
}
function closeChangePct(c,bars=1){
  if(c.length<bars+1) return null;
  const a=c[c.length-1].c;
  const b=c[c.length-1-bars].c;
  return percent(a,b);
}
function positionInDay(last,low,high){
  const r=high-low; if(r<=0) return null;
  return ((last-low)/r)*100;
}

// ========= MMS score (ex-JDS snapshot) =========
function toScore100(x){
  if(x==null||isNaN(x)) return null;
  return clamp((x+1)/2 *100,0,100);
}

// ========= ProcessSymbol (snapshot complet) =========
async function processSymbol(symbol){
  const [tk, fr, oi] = await Promise.all([
    getTicker(symbol),
    getFunding(symbol),
    getOI(symbol)
  ]);
  if(!tk) return null;

  const last = +tk.last;
  const high24 = +tk.high24h;
  const low24  = +tk.low24h;

  const prevOI_val = prevOI.get(symbol) ?? null;
  const openInterest = oi ? +oi.amount : null;
  const deltaOI = (prevOI_val!=null && openInterest!=null && prevOI_val!==0)
                  ? ((openInterest - prevOI_val)/prevOI_val)*100
                  : null;
  // MAJ mémoire
  prevOI.set(symbol, openInterest ?? prevOI_val);

  const [c1m,c5m,c15m,c1h,c4h] = await Promise.all([
    getCandles(symbol,60,120),
    getCandles(symbol,300,120),
    getCandles(symbol,900,400),
    getCandles(symbol,3600,400),
    getCandles(symbol,14400,400)
  ]);

  const [depth, markPrice] = await Promise.all([
    getDepth(symbol),
    getMarkPrice(symbol)
  ]);

  // spread
  let spreadPct = null;
  if(depth.bids.length && depth.asks.length){
    const b=depth.bids[0][0], a=depth.asks[0][0];
    spreadPct=((a-b)/((a+b)/2))*100;
    if(spreadPct<0) spreadPct=-spreadPct;
  }

  const closes1m  = c1m.map(x=>x.c);
  const closes5m  = c5m.map(x=>x.c);
  const closes15m = c15m.map(x=>x.c);
  const closes1h  = c1h.map(x=>x.c);
  const closes4h  = c4h.map(x=>x.c);

  const ema20_1m = ema(c1m,20,x=>x.c);
  const ema20_5m = ema(c5m,20,x=>x.c);

  const rsi15    = rsi(closes15m,14);

  // ΔP
  const dP_1m  = closeChangePct(c1m,1);
  const dP_5m  = closeChangePct(c5m,1);
  const dP_15m = closeChangePct(c15m,1);

  const vwap1h    = vwap(c1h.slice(-48));
  const deltaVWAP = (vwap1h && last)? percent(last,vwap1h) : null;

  // ===== MMS calc =====
  const longNorm = {
    m5:  dP_5m  !=null? clamp(-dP_5m/2,-1,1):0,
    m15: dP_15m !=null? clamp(-dP_15m/2,-1,1):0,
    vwap:deltaVWAP!=null?clamp(-deltaVWAP/2,-1,1):0,
    rsi: rsi15 !=null? clamp((50-rsi15)/20,-1,1):0
  };
  const shortNorm = {
    m5:  dP_5m  !=null? clamp(dP_5m/2,-1,1):0,
    m15: dP_15m !=null? clamp(dP_15m/2,-1,1):0,
    vwap:deltaVWAP!=null?clamp(deltaVWAP/2,-1,1):0,
    rsi: rsi15 !=null? clamp((rsi15-50)/20,-1,1):0
  };

  const MMS_long_raw =
    longNorm.m15*0.4 + longNorm.m5*0.2 + longNorm.vwap*0.2 + longNorm.rsi*0.2;
  const MMS_short_raw =
    shortNorm.m15*0.4 + shortNorm.m5*0.2 + shortNorm.vwap*0.2 + shortNorm.rsi*0.2;

  const MMS_long  = toScore100(MMS_long_raw);
  const MMS_short = toScore100(MMS_short_raw);

  return {
    symbol,
    last,
    markPrice,
    deltaVWAPpct: num(deltaVWAP,4),
    deltaOIpct: num(deltaOI,3),
    openInterest,
    rsi15: num(rsi15,2),
    dP_15m: num(dP_15m,2),
    MMS_long,
    MMS_short
  };
}

// ===== Fusion MMS → JDS final =====
function fuseMMS(record){
  const L = record.MMS_long;
  const S = record.MMS_short;

  if(L==null && S==null) return null;

  if((S ?? -999) > (L ?? -999)){
    return {direction:"SHORT", jds:S};
  }else{
    return {direction:"LONG", jds:L};
  }
}

// ===== Anti-spam =====
function shouldSendAlert(symbol,direction,jds){
  if(jds < ALERT_THRESHOLD) return false;
  const key = `${symbol}-${direction}`;
  const now = Date.now();
  const last = lastAlerts.get(key)||0;
  if(now-last < MIN_ALERT_DELAY_MS) return false;
  lastAlerts.set(key,now);
  return true;
}

// ==== Scan global =====
async function scanOnce(){
  console.log("🔍 Scan complet JTF…");

  const results = [];
  for(const s of SYMBOLS){
    try{
      const r = await processSymbol(s);
      if(r) results.push(r);
    }catch(e){
      console.error("Erreur:",s,e.message);
    }
    await sleep(150);
  }

  // Best LONG / SHORT
  let bestL=null, bestS=null;

  for(const r of results){
    const fused = fuseMMS(r);
    if(!fused) continue;

    if(fused.direction==="LONG"){
      if(!bestL || fused.jds > bestL.jds) bestL = {r, ...fused};
    }else{
      if(!bestS || fused.jds > bestS.jds) bestS = {r, ...fused};
    }
  }

  // Alerte LONG
  if(bestL && shouldSendAlert(bestL.r.symbol,"LONG",bestL.jds)){
    const e = bestL.r;
    await sendTelegramMessage(
`*JTF ALERT — LONG*
Pair: \`${e.symbol}\`
JDS/100: *${bestL.jds.toFixed(1)}*
MMS(L,S): ${e.MMS_long}/${e.MMS_short}
Prix: ${e.last}
ΔVWAP: ${e.deltaVWAPpct}%
ΔOI: ${e.deltaOIpct}%
RSI15m: ${e.rsi15}
Idée: MMS élevé côté LONG → rebond / mean reversion.`
    );
  }

  // Alerte SHORT
  if(bestS && shouldSendAlert(bestS.r.symbol,"SHORT",bestS.jds)){
    const e = bestS.r;
    await sendTelegramMessage(
`*JTF ALERT — SHORT*
Pair: \`${e.symbol}\`
JDS/100: *${bestS.jds.toFixed(1)}*
MMS(L,S): ${e.MMS_long}/${e.MMS_short}
Prix: ${e.last}
ΔVWAP: ${e.deltaVWAPpct}%
ΔOI: ${e.deltaOIpct}%
RSI15m: ${e.rsi15}
Idée: MMS élevé côté SHORT → essoufflement / excès haussier.`
    );
  }

  console.log("✅ Scan terminé.");
}

// ====== Telegram ======
async function sendTelegramMessage(text){
  if(!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID){
    console.error("❌ Telegram config manquante");
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try{
    await fetch(url,{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({chat_id:TELEGRAM_CHAT_ID, text, parse_mode:"Markdown"})
    });
  }catch(e){
    console.error("❌ Telegram:",e.message);
  }
}

// ====== MAIN LOOP ======
async function main(){
  console.log("🚀 JTF v0.8.1.2 — Railway MMS Scanner démarré.");
  await sendTelegramMessage("🟢 JTF Scanner démarré (snapshot complet toutes les 5min).");

  while(true){
    try{
      await scanOnce();
    }catch(e){
      console.error("❌ Erreur scan:",e.message);
    }
    await sleep(SCAN_INTERVAL_MS);
  }
}

main();