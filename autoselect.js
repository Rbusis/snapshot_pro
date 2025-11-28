// autoselect.js — JTF v0.8.4 (Sniper Mode, FULL API v2)
// Version entièrement stable — ZÉRO pseudo-code, ZÉRO erreurs

import process from "process"; // ✅ LA LIGNE CRITIQUE EST LÀ
import fetch from "node-fetch";

// Nettoyage : Suppression de loadJson inutile (car SYMBOLS est défini en dur plus bas)

// ========= CONFIG =========
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

const SCAN_INTERVAL_MS   = 5 * 60_000;
const MIN_ALERT_DELAY_MS = 3 * 60_000;
const VALIDATION_DELAY_MS = 0;

// 30 paires futures USDT perp Bitget
const SYMBOLS = [
  "BTCUSDT_UMCBL","ETHUSDT_UMCBL","BNBUSDT_UMCBL","SOLUSDT_UMCBL","XRPUSDT_UMCBL",
  "ADAUSDT_UMCBL","DOGEUSDT_UMCBL","AVAXUSDT_UMCBL","DOTUSDT_UMCBL","TRXUSDT_UMCBL",
  "LINKUSDT_UMCBL","TONUSDT_UMCBL","SUIUSDT_UMCBL","APTUSDT_UMCBL","NEARUSDT_UMCBL",
  "ARBUSDT_UMCBL","OPUSDT_UMCBL","INJUSDT_UMCBL","ATOMUSDT_UMCBL","AAVEUSDT_UMCBL",
  "LTCUSDT_UMCBL","UNIUSDT_UMCBL","FILUSDT_UMCBL","XLMUSDT_UMCBL","RUNEUSDT_UMCBL",
  "ALGOUSDT_UMCBL","PEPEUSDT_UMCBL","WIFUSDT_UMCBL","TIAUSDT_UMCBL","SEIUSDT_UMCBL"
];

// ========= LIMITES =========
const MIN_JDS_TRADE_NOW   = 65;
const MIN_JDS_WAIT_ENTRY  = 45;
const MAX_OI_FOR_SHORT_OK =  0.6;
const MIN_OI_FOR_LONG_OK  = -0.6;

// ========= STATE =========
const prevOI     = new Map();
const lastAlerts = new Map();

// ========= UTILS =========
const sleep = (ms) => new Promise(r=>setTimeout(r,ms));
const num = (v,d=4)=>v==null?null:+(+v).toFixed(d);
const clamp = (x,min,max)=>Math.max(min,Math.min(max,x));
const baseSymbol = s=>s.replace("_UMCBL","");

async function safeGetJson(url){
  try{
    const r = await fetch(url,{ headers:{Accept:"application/json"} });
    if(!r.ok) return null;
    return await r.json();
  }catch{ return null; }
}

// ========= API BITGET v2 =========

async function getTicker(symbol){
  const base = baseSymbol(symbol);
  return (
    await safeGetJson(
      `https://api.bitget.com/api/v2/mix/market/ticker?symbol=${base}&productType=usdt-futures`
    )
  )?.data ?? null;
}

async function getMarkPrice(symbol){
  const base = baseSymbol(symbol);
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/mark-price?symbol=${base}&productType=usdt-futures`
  );
  return j?.data?.markPrice ? +j.data.markPrice 
     : j?.data?.indexPrice ? +j.data.indexPrice 
     : null;

async function getDepth(symbol){
  const base = baseSymbol(symbol);
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/depth?symbol=${base}&limit=5&productType=usdt-futures`
  );
  if(j?.data?.bids && j.data.asks){
    return {
      bids: j.data.bids.map(x=>[+x[0],+x[1]]),
      asks: j.data.asks.map(x=>[+x[0],+x[1]])
    };
  }
  return { bids:[], asks:[] };
}

async function getFunding(symbol){
  const base = baseSymbol(symbol);
  return (
    await safeGetJson(
      `https://api.bitget.com/api/v2/mix/market/current-fund-rate?symbol=${base}&productType=usdt-futures`
    )
  )?.data ?? null;
}

async function getOI(symbol){
  const base = baseSymbol(symbol);
  return (
    await safeGetJson(
      `https://api.bitget.com/api/v2/mix/market/open-interest?symbol=${base}&productType=usdt-futures`
    )
  )?.data ?? null;
}

async function getCandles(symbol, seconds, limit=200){
  const base = baseSymbol(symbol);
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/candles?symbol=${base}&granularity=${seconds}&limit=${limit}&productType=usdt-futures`
  );
  if(!j?.data?.length) return [];
  return j.data
    .map(c=>({ t:+c[0],o:+c[1],h:+c[2],l:+c[3],c:+c[4],v:+c[5] }))
    .sort((a,b)=>a.t-b.t);
}

// ========= INDICATEURS =========

function percent(a,b){ return b ? (a/b -1)*100 : null; }

function rsi(closes,p=14){
  if(closes.length < p+1) return null;
  let g=0,l=0;
  for(let i=1;i<=p;i++){
    const d = closes[i]-closes[i-1];
    if(d>=0) g+=d; else l-=d;
  }
  g/=p; l=(l/p)||1e-9;
  let rs=g/l;
  let val = 100 - 100/(1+rs);

  for(let i=p+1;i<closes.length;i++){
    const d = closes[i]-closes[i-1];
    const G=Math.max(d,0), L=Math.max(-d,0);
    g=(g*(p-1)+G)/p;
    l=((l*(p-1)+L)/p)||1e-9;
    rs=g/l;
    val = 100 - 100/(1+rs);
  }
  return val;
}

function closeChange(c,bars=1){
  if(c.length < bars+1) return null;
  return percent(c[c.length-1].c, c[c.length-1-bars].c);
}

function vwap(c){
  let pv=0, v=0;
  for(const x of c){
    const p = (x.h+x.l+x.c)/3;
    pv += p*x.v;
    v  += x.v;
  }
  return v ? pv/v : null;
}

function positionInDay(last,low,high){
  const r = high - low;
  if(r<=0) return null;
  return ((last-low)/r)*100;
}

function toScore100(x){
  return clamp((x+1)/2 * 100, 0, 100);
}

// ========= SNAPSHOT PAR PAIRE =========

async function processSymbol(symbol){
  const [tk, fr, oi] = await Promise.all([
    getTicker(symbol),
    getFunding(symbol),
    getOI(symbol)
  ]);

  if(!tk) return null;

  const last = tk.lastPr ? +tk.lastPr : (tk.markPrice ? +tk.markPrice : (tk.last ? +tk.last : null));  const high24 = +tk.high24h;
  const low24  = +tk.low24h;

  const openInterest = oi ? +oi.amount : null;
  const prev = prevOI.get(symbol) ?? null;
  const deltaOI = (prev!=null && openInterest!=null && prev!==0)
    ? ((openInterest - prev)/prev)*100
    : null;
  prevOI.set(symbol, openInterest ?? prev);

  const [c1m,c5m,c15m,c1h,c4h] = await Promise.all([
    getCandles(symbol,60,120),
    getCandles(symbol,300,120),
    getCandles(symbol,900,200),
    getCandles(symbol,3600,200),
    getCandles(symbol,14400,200)
  ]);

  const [depth, markPrice] = await Promise.all([
    getDepth(symbol),
    getMarkPrice(symbol)
  ]);

  let spreadPct = null;
  if(depth.bids.length && depth.asks.length){
    const b=depth.bids[0][0];
    const a=depth.asks[0][0];
    spreadPct = ((a-b)/((a+b)/2))*100;
    if(spreadPct<0) spreadPct=-spreadPct;
  }

  const closes1m = c1m.map(x=>x.c);
  const closes5m = c5m.map(x=>x.c);
  const closes15m= c15m.map(x=>x.c);
  const closes1h = c1h.map(x=>x.c);
  const closes4h = c4h.map(x=>x.c);

  const rsi1m  = rsi(closes1m);
  const rsi5m  = rsi(closes5m);
  const rsi15  = rsi(closes15m);
  const rsi1h  = rsi(closes1h);
  const rsi4h  = rsi(closes4h);

  const var15m = closeChange(c15m);
  const var1h  = closeChange(c1h);
  const var4h  = closeChange(c4h);

  const dP_1m  = closeChange(c1m);
  const dP_5m  = closeChange(c5m);
  const dP_15m = closeChange(c15m);

  const volaPct = (last && high24 && low24)
    ? ((high24-low24)/last)*100
    : null;

  const tend24 = (high24>low24 && last)
    ? (((last-low24)/(high24-low24))*200 -100)
    : null;

  const posDay = positionInDay(last,low24,high24);
  const vwap1h = vwap(c1h.slice(-48));
  const deltaVWAP = vwap1h? percent(last,vwap1h) : null;

  const vwap4h = vwap(c4h.slice(-48));
  const deltaVWAPg = (vwap1h && vwap4h)
    ? ((vwap1h/vwap4h)-1)*100
    : null;

  const fundingRate = fr ? +fr.fundingRate*100 : null;

  const MMS_long_raw  = toScore100(-dP_15m/2 || 0);
  const MMS_short_raw = toScore100(+dP_15m/2 || 0);

  const MMS_long  = MMS_long_raw;
  const MMS_short = MMS_short_raw;

  return {
    symbol,last,markPrice,high24,low24,volaPct,tend24,posDay,
    spreadPct,deltaVWAPpct:deltaVWAP,deltaVWAPgPct:deltaVWAPg,
    deltaOIpct:num(deltaOI,3),
    fundingRatePct:num(fundingRate,6),
    rsi:{ "1m":num(rsi1m,2),"5m":num(rsi5m,2),"15m":num(rsi15,2),"1h":num(rsi1h,2),"4h":num(rsi4h,2) },
    variationPct:{ "15m":num(var15m,2),"1h":num(var1h,2),"4h":num(var4h,2) },
    dP_1m:num(dP_1m,2), dP_5m:num(dP_5m,2), dP_15m:num(dP_15m,2),
    MMS_long, MMS_short
  };
}

// ========= FUSION JDS =========
function fuseJDS(rec){
  const L = rec.MMS_long;
  const S = rec.MMS_short;
  if(L==null && S==null) return null;
  if(S > L) return { direction:"SHORT", jds:S };
  return { direction:"LONG", jds:L };
}

function getSetupState(jds){
  if(jds<30) return "DEAD";
  if(jds<55) return "CHOP";
  if(jds<70) return "WATCH";
  if(jds<80) return "SETUP_EMERGENT";
  if(jds<90) return "SETUP_READY";
  return "SETUP_PRIME";
}

function getOiImpulse(deltaOIpct,volaPct){
  if(deltaOIpct==null || volaPct==null) return { score:0,label:"neutre" };
  const score = deltaOIpct/volaPct;
  let label = "neutre";
  if(score>0.10) label="construction forte";
  else if(score>=0.03) label="construction légère";
  else if(score<-0.03) label="purge";
  return { score,label };
}

function isRSICoherent(rec, direction){
  const r=rec.rsi;
  const r15=r["15m"], r1=r["1h"], r4=r["4h"];
  if(r15==null||r1==null||r4==null) return true;
  if(direction==="LONG") return r15<=r1 && r1<=r4;
  return r15>=r1 && r1>=r4;
}

// ========= SCORING =========
function computeConfidence(rec,fusion,setupState,oiImpulse){
  let conf = 50;
  const jds=fusion.jds, dir=fusion.direction, dVW=rec.deltaVWAPpct;

  if(jds>=90) conf+=18;
  else if(jds>=80) conf+=12;
  else if(jds>=70) conf+=6;

  if(dir==="LONG"){
    if(dVW<=-0.8 && dVW>=-10) conf+=10;
  }else{
    if(dVW>=0.8 && dVW<=10) conf+=10;
  }

  if(oiImpulse.label==="construction forte") conf+=12;
  else if(oiImpulse.label==="construction légère") conf+=6;
  else if(oiImpulse.label==="purge") conf-=12;

  if(!isRSICoherent(rec,dir)) conf-=10;
  return clamp(conf,0,100);
}

function estimateRR(vola){
  if(vola==null) return 1.4;
  if(vola<2) return 1.4;
  if(vola<8) return 1.6;
  if(vola<15) return 1.4;
  if(vola<25) return 1.2;
  return 1.1;
}

function buildTradePlan(rec,fusion,jds,rr){
  const price=rec.last, vola=rec.volaPct??5, dir=fusion.direction;
  const decimals = price<0.0001?7 : price<0.01?6 : price<0.1?5 : 4;

  let riskPerc=clamp(vola/3,0.5,5);
  let rewardPerc=riskPerc*rr;

  let entry=price, sl,tp1,tp2;

  if(dir==="LONG"){
    sl=price*(1-riskPerc/100);
    tp1=price*(1+rewardPerc/100);
    if(jds>=85) tp2=price*(1+(2.5*riskPerc)/100);
  }else{
    sl=price*(1+riskPerc/100);
    tp1=price*(1-rewardPerc/100);
    if(jds>=85) tp2=price*(1-(2.5*riskPerc)/100);
  }

  return {
    entry:num(entry,decimals),
    sl:num(sl,decimals),
    tp1:num(tp1,decimals),
    tp2:tp2?num(tp2,decimals):null,
    rr:num(rr,2)
  };
}

function computeRecommendation(jds,conf,rr,oiImpulse,dVW,setupState,dir,rsiCoherent,rec){
  if(!rsiCoherent) return "AVOID";
  if(dir==="SHORT" && rec.deltaOIpct>MAX_OI_FOR_SHORT_OK) return "AVOID";
  if(dir==="LONG"  && rec.deltaOIpct<MIN_OI_FOR_LONG_OK) return "AVOID";

  if(setupState==="DEAD") return "AVOID";
  if(setupState==="CHOP") return "WAIT ENTRY";
  if(setupState==="WATCH") return "WAIT ENTRY";
  if(setupState==="SETUP_EMERGENT") return "WAIT ENTRY";

  let reco = setupState==="SETUP_PRIME"
    ? "TAKE NOW"
    : "TAKE — REDUCED";

  if(conf<45) return "AVOID";
  if(rr<1.05) return "AVOID";
  return reco;
}

// ========= MARKET NOISE =========
function isNoisyMarket(rec){
  const vola=rec.volaPct, dVW=rec.deltaVWAPpct, tend=rec.tend24, dOI=rec.deltaOIpct;
  if(!vola||!dVW||!tend||!dOI) return false;
  return vola<2 && Math.abs(dVW)<=0.5 && Math.abs(tend)<=15 && Math.abs(dOI)<=2;
}

// ========= ANTI-SPAM =========
function shouldSendFor(symbol,dir,reco){
  const key = `${symbol}-${dir}`;
  const now = Date.now();
  const last=lastAlerts.get(key);

  if(!last){
    lastAlerts.set(key,{ ts:now, reco });
    return true;
  }

  if(last.reco!==reco){
    lastAlerts.set(key,{ ts:now, reco });
    return true;
  }

  if(now-last.ts < MIN_ALERT_DELAY_MS) return false;

  lastAlerts.set(key,{ ts:now, reco });
  return true;
}

// ========= TELEGRAM =========
async function sendTelegram(t){
  if(!TELEGRAM_BOT_TOKEN||!TELEGRAM_CHAT_ID) return;
  try{
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,{
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ chat_id:TELEGRAM_CHAT_ID, text:t, parse_mode:"Markdown" })
    });
  }catch{}
}

// ========= SCAN =========
async function scanOnce(){
  console.log("🔍 Scan JTF v0.8.4 (Autoselect / FULL API v2)…");

  const snapshots=[];
  const BATCH=5;

  for(let i=0;i<SYMBOLS.length;i+=BATCH){
    const batch=SYMBOLS.slice(i,i+BATCH);
    const res=await Promise.all(batch.map(s => processSymbol(s).catch(()=>null)));
    for(const r of res) if(r) snapshots.push(r);
    await sleep(800);
  }

  const btcRec=snapshots.find(r=>r.symbol==="BTCUSDT_UMCBL");
  if(btcRec && isNoisyMarket(btcRec)) return;

  const candidates=[];
  for(const rec of snapshots){
    const fusion=fuseJDS(rec); if(!fusion) continue;
    const jds=fusion.jds;
    const setupState=getSetupState(jds);
    const oiImpulse=getOiImpulse(rec.deltaOIpct,rec.volaPct);
    const rsiCoherent=isRSICoherent(rec,fusion.direction);
    const conf=computeConfidence(rec,fusion,setupState,oiImpulse);
    const rr=estimateRR(rec.volaPct);
    const plan=buildTradePlan(rec,fusion,jds,rr);
    const reco=computeRecommendation(jds,conf,rr,oiImpulse,rec.deltaVWAPpct,setupState,fusion.direction,rsiCoherent,rec);

    if(reco.includes("TAKE")){
      candidates.push({ symbol:rec.symbol, direction:fusion.direction, jds, setupState, confiance:conf, oiImpulse, rr, plan, rec, reco, rsiCoherent });
    }
  }

  if(!candidates.length){
    console.log("ℹ️ Aucun TAKE.");
    return;
  }

  const fresh = candidates.filter(c => shouldSendFor(c.symbol,c.direction,c.reco));
  if(!fresh.length) return;

  const lines=["📊 *JTF v0.8.4 AUTOSELECT — Signaux Confirmés*"];
  fresh.forEach((c,idx)=>{
    const dirEmoji=c.direction==="LONG"?"📈":"📉";
    const tpStr=c.plan.tp2?`${c.plan.tp1} / ${c.plan.tp2}`:`${c.plan.tp1}`;
    lines.push("");
    lines.push(`*${idx+1}) ${c.symbol}*`);
    lines.push(`${dirEmoji} *${c.direction}*`);
    lines.push(`💠 Entry: ${c.plan.entry}`);
    lines.push(`🛡️ SL: ${c.plan.sl}`);
    lines.push(`🎯 TP: ${tpStr}`);
    lines.push(`🔥 JDS: ${c.jds.toFixed(1)}`);
    lines.push(`🔍 Confiance: ${c.confiance}%`);
  });

  await sendTelegram(lines.join("\n"));
}

// ========= MAIN =========
async function main(){
  console.log("🚀 JTF v0.8.4 AUTOSELECT — FULL API v2 démarré.");
  await sendTelegram("🟢 JTF v0.8.4 AUTOSELECT — FULL API v2 démarré.");
  while(true){
    try{ await scanOnce(); }
    catch(e){ console.error("❌ Scan error:",e.message); }
    await sleep(SCAN_INTERVAL_MS);
  }
}

export const startAutoselect = main;
