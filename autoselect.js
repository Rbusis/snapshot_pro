// top30.js — v0.8.9 (JTF TOP 30, Clean Output + Debug Control + Data Logs)

import process from "process";
import fetch from "node-fetch";
import { DEBUG } from "./debug.js";

// ========= CONFIG =========
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

const SCAN_INTERVAL_MS    = 5 * 60_000;
const MIN_ALERT_DELAY_MS  = 3 * 60_000;

// ========= DEBUG =========
function logDebug(...args){
  if (DEBUG.global || DEBUG.autoselect){
    console.log("[TOP30 DEBUG]", ...args);
  }
}

// ========= SYMBOLS =========
const SYMBOLS = [
  "BTCUSDT_UMCBL","ETHUSDT_UMCBL","BNBUSDT_UMCBL","SOLUSDT_UMCBL","XRPUSDT_UMCBL",
  "ADAUSDT_UMCBL","DOGEUSDT_UMCBL","AVAXUSDT_UMCBL","DOTUSDT_UMCBL","TRXUSDT_UMCBL",
  "LINKUSDT_UMCBL","TONUSDT_UMCBL","SUIUSDT_UMCBL","APTUSDT_UMCBL","NEARUSDT_UMCBL",
  "ARBUSDT_UMCBL","OPUSDT_UMCBL","INJUSDT_UMCBL","ATOMUSDT_UMCBL","AAVEUSDT_UMCBL",
  "LTCUSDT_UMCBL","UNIUSDT_UMCBL","FILUSDT_UMCBL","XLMUSDT_UMCBL","RUNEUSDT_UMCBL",
  "ALGOUSDT_UMCBL","PEPEUSDT_UMCBL","WIFUSDT_UMCBL","TIAUSDT_UMCBL","SEIUSDT_UMCBL"
];

// ========= LIMITES (réservé, pas encore utilisé) =========
const MAX_OI_FOR_SHORT_OK =  0.6;
const MIN_OI_FOR_LONG_OK  = -0.6;

// ========= STATE =========
const prevOI     = new Map();
const lastAlerts = new Map();

// ========= UTIL =========
const sleep  = ms => new Promise(r => setTimeout(r, ms));
const num    = (v,d=4)=>v==null?null:+(+v).toFixed(d);
const clamp  = (x,min,max)=>Math.max(min,Math.min(max,x));
const baseSymbol = s => s.replace("_UMCBL","");

function normalizeData(data){
  return Array.isArray(data) ? (data[0] ?? null) : data;
}

async function safeGetJson(url){
  try{
    logDebug("safeGetJson", url);
    const r = await fetch(url,{headers:{Accept:"application/json"}});
    if (!r.ok){
      logDebug("HTTP ERROR", r.status, url);
      return null;
    }
    return await r.json();
  }catch(e){
    logDebug("safeGetJson FAIL", url, e);
    return null;
  }
}

// ========= API v2 =========
async function getTicker(symbol){
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/ticker?symbol=${baseSymbol(symbol)}&productType=usdt-futures`
  );
  return normalizeData(j?.data);
}

async function getOI(symbol){
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/open-interest?symbol=${baseSymbol(symbol)}&productType=usdt-futures`
  );
  return normalizeData(j?.data);
}

async function getFunding(symbol){
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/current-fund-rate?symbol=${baseSymbol(symbol)}&productType=usdt-futures`
  );
  return normalizeData(j?.data);
}

async function getDepth(symbol){
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/depth?symbol=${baseSymbol(symbol)}&productType=usdt-futures&limit=5`
  );
  return j?.data ? {
    bids: j.data.bids.map(x=>[+x[0],+x[1]]),
    asks: j.data.asks.map(x=>[+x[0],+x[1]])
  } : { bids:[], asks:[] };
}

async function getCandles(symbol,sec,limit=200){
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/candles?symbol=${baseSymbol(symbol)}&granularity=${sec}&limit=${limit}&productType=usdt-futures`
  );
  return j?.data ? j.data.map(c=>({
    t:+c[0],o:+c[1],h:+c[2],l:+c[3],c:+c[4],v:+c[5]
  })).sort((a,b)=>a.t-b.t) : [];
}

// ========= INDICATORS =========
function percent(a,b){ return b?(a/b -1)*100:null; }

function rsi(cl,p=14){
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
    const G=Math.max(d,0), L=Math.max(-d,0);
    g=(g*(p-1)+G)/p;
    l=((l*(p-1)+L)/p)||1e-9;
    rs=g/l;
    v=100-100/(1+rs);
  }
  return v;
}

function closeChange(c,b=1){
  if(c.length<b+1) return null;
  return percent(c[c.length-1].c,c[c.length-1-b].c);
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
  const r=high-low;
  return r<=0?null:((last-low)/r)*100;
}

function toScore100(x){ return clamp((x+1)/2*100,0,100); }

// ========= SNAPSHOT =========
async function processSymbol(symbol){
  logDebug("processSymbol START", symbol);

  const [tk,fr,oi] = await Promise.all([
    getTicker(symbol),
    getFunding(symbol),
    getOI(symbol)
  ]);

  if(!tk){
    console.log(`[TOP30 DROP] ${symbol} — no ticker data`);
    return null;
  }

  const lastRaw = tk.lastPr ?? tk.markPrice ?? tk.last ?? null;
  const last    = lastRaw != null ? +lastRaw : null;
  const high24  = tk.high24h != null ? +tk.high24h : null;
  const low24   = tk.low24h  != null ? +tk.low24h  : null;

  if(!last || last <= 0){
    console.log(`[TOP30 DROP] ${symbol} — invalid price: ${lastRaw}`);
    return null;
  }

  const openInterest = oi?.amount != null ? +oi.amount : null;
  const prev = prevOI.get(symbol) ?? null;
  const deltaOI = prev!=null && openInterest!=null && prev!==0
    ? ((openInterest-prev)/prev)*100
    : null;
  prevOI.set(symbol, openInterest ?? prev);

  const [c1m,c5m,c15m,c1h,c4h] = await Promise.all([
    getCandles(symbol,60,120),
    getCandles(symbol,300,120),
    getCandles(symbol,900,200),
    getCandles(symbol,3600,200),
    getCandles(symbol,14400,200)
  ]);

  if(!c1m.length||!c5m.length||!c15m.length||!c1h.length||!c4h.length){
    console.log(
      `[TOP30 DROP] ${symbol} — missing candles ` +
      `(1m=${c1m.length},5m=${c5m.length},15m=${c15m.length},1h=${c1h.length},4h=${c4h.length})`
    );
    return null;
  }

  const dP15 = closeChange(c15m);

  const volaPct = last!=null && high24!=null && low24!=null
    ? ((high24-low24)/last)*100 : null;

  const vwap1h = vwap(c1h.slice(-48));
  const deltaVWAP = vwap1h ? percent(last,vwap1h) : null;

  const MMS_long  = toScore100(-(dP15/2)||0);
  const MMS_short = toScore100( +(dP15/2)||0);

  const deltaVWAPpct = deltaVWAP != null ? +num(deltaVWAP,4) : null;
  const deltaOIpct   = deltaOI   != null ? +num(deltaOI,3)   : null;

  // Log pour vérifier les data reçues
  console.log(
    `[TOP30 DATA] ${symbol} | P=${last} | Vola=${volaPct!=null?volaPct.toFixed(2):"n/a"}% | ` +
    `ΔVWAP=${deltaVWAPpct!=null?deltaVWAPpct.toFixed(4):"n/a"} | ΔOI=${deltaOIpct!=null?deltaOIpct.toFixed(3):"n/a"} | ` +
    `MMS_L=${MMS_long.toFixed(1)} | MMS_S=${MMS_short.toFixed(1)}`
  );

  return {
    symbol,
    last,
    volaPct,
    deltaVWAPpct,
    deltaOIpct,
    MMS_long,
    MMS_short
  };
}

// ====== JDS Engine (raccourci) ======
function fuseJDS(rec){
  if(rec.MMS_short > rec.MMS_long) return {direction:"SHORT",jds:rec.MMS_short};
  return {direction:"LONG",jds:rec.MMS_long};
}

function getSetupState(jds){
  if(jds<30) return "DEAD";
  if(jds<55) return "CHOP";
  if(jds<70) return "WATCH";
  if(jds<80) return "SETUP_EMERGENT";
  if(jds<90) return "SETUP_READY";
  return "SETUP_PRIME";
}

function isRSICoherent(){ return true; }

function getOiImpulse(oi,vola){
  if(oi==null||vola==null) return {score:0,label:"neutre"};
  const score = oi/vola;
  let label="neutre";
  if(score>0.10) label="construction forte";
  else if(score>=0.03) label="construction légère";
  else if(score<-0.03) label="purge";
  return {score,label};
}

function computeConfidence(rec,fusion,setupState,oiImpulse){
  let conf=50;
  const jds=fusion.jds;

  if(jds>=90) conf+=18;
  else if(jds>=80) conf+=12;
  else if(jds>=70) conf+=6;

  if(oiImpulse.label==="construction forte") conf+=12;
  else if(oiImpulse.label==="construction légère") conf+=6;
  else if(oiImpulse.label==="purge") conf-=12;

  return clamp(conf,0,100);
}

function estimateRR(vola){
  if(vola<2)  return 1.4;
  if(vola<8)  return 1.6;
  if(vola<15) return 1.4;
  return 1.2;
}

function buildTradePlan(rec,fusion,jds,rr){
  const p=rec.last;
  const dir=fusion.direction;
  const decimals=p<0.01?6:p<0.1?5:4;

  const risk=clamp((rec.volaPct??5)/3,0.5,5);
  const reward=risk*rr;

  let sl,tp1,tp2;
  if(dir==="LONG"){
    sl  = p*(1-risk/100);
    tp1 = p*(1+reward/100);
    if(jds>=85) tp2=p*(1+(2.5*risk)/100);
  } else {
    sl  = p*(1+risk/100);
    tp1 = p*(1-reward/100);
    if(jds>=85) tp2=p*(1-(2.5*risk)/100);
  }

  return {
    entry:num(p,decimals),
    sl:num(sl,decimals),
    tp1:num(tp1,decimals),
    tp2:tp2?num(tp2,decimals):null,
    rr
  };
}

// ========= RECO (TAKE / WAIT / AVOID) =========
// TAKE seulement pour JDS >= 80 (SETUP_READY / SETUP_PRIME)
function computeRecommendation(jds, conf, rr, oiImpulse, dVW, setupState, dir, rsiCoh, rec){
  // États faibles → on oublie
  if (setupState === "DEAD")  return "AVOID";
  if (setupState === "CHOP")  return "AVOID";
  if (setupState === "WATCH") return "WAIT";

  // 70–80 : EMERGENT → on observe mais on ne trade pas
  if (setupState === "SETUP_EMERGENT") return "WAIT";

  // À partir d'ici : SETUP_READY (80–90) ou SETUP_PRIME (90+)
  if (conf < 45) return "AVOID";
  if (rr   < 1.05) return "AVOID";

  return "TAKE";
}

// ========= ANTI-SPAM =========
function shouldSendFor(symbol,dir,reco){
  const key=`${symbol}-${dir}`;
  const now=Date.now();
  const last=lastAlerts.get(key);

  if(!last){
    lastAlerts.set(key,{ts:now,reco});
    return true;
  }
  if(last.reco!==reco){
    lastAlerts.set(key,{ts:now,reco});
    return true;
  }
  if(now-last.ts<MIN_ALERT_DELAY_MS) return false;

  lastAlerts.set(key,{ts:now,reco});
  return true;
}

// ========= TELEGRAM =========
async function sendTelegram(text){
  if(!TELEGRAM_BOT_TOKEN||!TELEGRAM_CHAT_ID) return;
  try{
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,{
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body:JSON.stringify({chat_id:TELEGRAM_CHAT_ID,text,parse_mode:"Markdown"})
    });
  }catch{}
}

// ========= MARKET NOISE =========
function isNoisyMarket(rec){
  const vola = rec.volaPct;
  const dVW  = rec.deltaVWAPpct;
  const dOI  = rec.deltaOIpct;

  if (vola == null || dVW == null || dOI == null) return false;

  return (
    vola < 2 &&
    Math.abs(dVW)  <= 0.5 &&
    Math.abs(dOI)  <= 2
  );
}

// ========= SCAN =========
async function scanOnce(){
  const t0 = Date.now();
  console.log("🔍 [TOP30] SCAN STARTED...");

  const snapshots = [];
  const BATCH     = 5;

  for (let i = 0; i < SYMBOLS.length; i += BATCH){
    const batch = SYMBOLS.slice(i, i + BATCH);
    const res   = await Promise.all(
      batch.map(s => processSymbol(s).catch(() => null))
    );
    for (const r of res) if (r) snapshots.push(r);
    await sleep(800);
  }

  // Market noise check (BTC)
  const btcRec = snapshots.find(r => r.symbol === "BTCUSDT_UMCBL");
  if (btcRec && isNoisyMarket(btcRec)){
    const ms = Date.now() - t0;
    console.log(`[TOP30] SCAN — ${SYMBOLS.length} PAIRS | ${ms} MS | MARKET NOISE`);
    return;
  }

  const candidates = [];
  for (const rec of snapshots){
    const fusion = fuseJDS(rec);
    if (!fusion) continue;

    const jds         = fusion.jds;
    const setupState  = getSetupState(jds);
    const oiImpulse   = getOiImpulse(rec.deltaOIpct, rec.volaPct);
    const rsiCoherent = isRSICoherent(rec, fusion.direction);
    const conf        = computeConfidence(rec, fusion, setupState, oiImpulse);
    const rr          = estimateRR(rec.volaPct);
    const plan        = buildTradePlan(rec, fusion, jds, rr);
    const reco        = computeRecommendation(
      jds, conf, rr, oiImpulse, rec.deltaVWAPpct,
      setupState, fusion.direction, rsiCoherent, rec
    );

    // On ne garde que les vrais trades "TAKE"
    if (reco === "TAKE"){
      candidates.push({
        symbol:     rec.symbol,
        direction:  fusion.direction,
        jds,
        setupState,
        confiance:  conf,
        oiImpulse,
        rr,
        plan,
        rec,
        reco,
        rsiCoherent
      });
    }
  }

  const ms = Date.now() - t0;
  console.log(`[TOP30] SCAN — ${SYMBOLS.length} PAIRS | ${ms} MS | ${candidates.length} SETUP`);

  if (!candidates.length){
    return;
  }

  const validCandidates = candidates.filter(c =>
    c.plan.entry !== null &&
    c.plan.sl    !== null &&
    c.plan.tp1   !== null
  );

  if (!validCandidates.length){
    return;
  }

  const fresh = validCandidates.filter(c =>
    shouldSendFor(c.symbol, c.direction, c.reco)
  );
  if (!fresh.length) return;

  const lines = ["📊 *JTF TOP 30 — Signaux Confirmés*"];
  fresh.forEach((c, idx) => {
    const dirEmoji = c.direction === "LONG" ? "📈" : "📉";
    const tpStr    = c.plan.tp2 ? `${c.plan.tp1} / ${c.plan.tp2}` : `${c.plan.tp1}`;
    lines.push("");
    lines.push(`*${idx + 1}) ${c.symbol}*`);
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
export async function startAutoselect(){
  console.log("🔥 TOP 30 On (v0.8.9)");
  await sendTelegram("🟢 JTF TOP 30 v0.8.9 On");
  while(true){
    try{ await scanOnce(); }
    catch(e){ console.log("[TOP30 ERROR]",e); }
    await sleep(SCAN_INTERVAL_MS);
  }
}