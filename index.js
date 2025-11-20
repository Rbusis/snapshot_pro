// index.js — JTF v0.8.1.3 AUTOSELECT (Railway / Telegram)
// TOP30 Bitget USDT Perp, MMS -> JDS fusionné, Setup State, Confiance, R:R, Reco
// Sortie : blocs Telegram avec emojis, max 3 trades, aucun fichier écrit.

import fetch from "node-fetch";

// ========= CONFIG =========

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

// Snapshot toutes les 5 minutes
const SCAN_INTERVAL_MS   = 5 * 60_000;
// Anti-spam : délai min entre 2 envois pour même paire/direction
const MIN_ALERT_DELAY_MS = 15 * 60_000;

// Délai de re-validation des trades TAKE (en ms)
const VALIDATION_DELAY_MS = 30_000; // 30 secondes

// TOP30 Bitget USDT perp
const SYMBOLS = [
  "BTCUSDT_UMCBL","ETHUSDT_UMCBL","BNBUSDT_UMCBL","SOLUSDT_UMCBL","XRPUSDT_UMCBL",
  "ADAUSDT_UMCBL","DOGEUSDT_UMCBL","AVAXUSDT_UMCBL","DOTUSDT_UMCBL","TRXUSDT_UMCBL",
  "LINKUSDT_UMCBL","TONUSDT_UMCBL","SUIUSDT_UMCBL","APTUSDT_UMCBL","NEARUSDT_UMCBL",
  "ARBUSDT_UMCBL","OPUSDT_UMCBL","INJUSDT_UMCBL","ATOMUSDT_UMCBL","AAVEUSDT_UMCBL",
  "LTCUSDT_UMCBL","UNIUSDT_UMCBL","FILUSDT_UMCBL","XLMUSDT_UMCBL","RUNEUSDT_UMCBL",
  "ALGOUSDT_UMCBL","PEPEUSDT_UMCBL","WIFUSDT_UMCBL","TIAUSDT_UMCBL","SEIUSDT_UMCBL"
];

// ========= MÉMOIRE =========

// ΔOI persisté uniquement en RAM (reset à chaque redéploiement)
const prevOI     = new Map();   // symbol -> OI précédent
// Anti-spam par paire/direction (stocke aussi la dernière reco)
const lastAlerts = new Map();   // "symbol-direction" -> { ts, reco }

// ========= UTILS =========

const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const num   = (v,d=4)=>v==null?null:+(+v).toFixed(d);
const clamp = (x,min,max)=>Math.max(min,Math.min(max,x));
const baseSymbol = s => s.replace("_UMCBL","");

async function safeGetJson(url){
  try{
    const r = await fetch(url,{ headers:{ Accept:"application/json" } });
    if(!r.ok) return null;
    return await r.json();
  }catch{
    return null;
  }
}

// ========= API BITGET =========

async function getCandles(symbol, seconds, limit=400){
  const base = baseSymbol(symbol);
  // v2
  let j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/candles?symbol=${base}&granularity=${seconds}&productType=usdt-futures&limit=${limit}`
  );
  if(j?.data?.length){
    return j.data
      .map(c=>({ t:+c[0],o:+c[1],h:+c[2],l:+c[3],c:+c[4],v:+c[5] }))
      .sort((a,b)=>a.t-b.t);
  }
  // v1 fallback
  j = await safeGetJson(
    `https://api.bitget.com/api/mix/v1/market/candles?symbol=${symbol}&granularity=${seconds}&limit=${limit}`
  );
  if(j?.data?.length){
    return j.data
      .map(c=>({ t:+c[0],o:+c[1],h:+c[2],l:+c[3],c:+c[4],v:+c[5] }))
      .sort((a,b)=>a.t-b.t);
  }
  return [];
}

async function getTicker(symbol){
  const j = await safeGetJson(
    `https://api.bitget.com/api/mix/v1/market/ticker?symbol=${symbol}`
  );
  return j?.data ?? null;
}

async function getMarkPrice(symbol){
  const j = await safeGetJson(
    `https://api.bitget.com/api/mix/v1/market/mark-price?symbol=${symbol}`
  );
  if(j?.data?.markPrice!=null) return +j.data.markPrice;
  const tk = await getTicker(symbol);
  return tk?.markPrice ? +tk.markPrice : null;
}

async function getDepth(symbol){
  const j = await safeGetJson(
    `https://api.bitget.com/api/mix/v1/market/depth?symbol=${symbol}&limit=5`
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
  const j = await safeGetJson(
    `https://api.bitget.com/api/mix/v1/market/currentFundRate?symbol=${symbol}`
  );
  return j?.data ?? null;
}

async function getOI(symbol){
  const j = await safeGetJson(
    `https://api.bitget.com/api/mix/v1/market/open-interest?symbol=${symbol}`
  );
  return j?.data ?? null;
}

// ========= INDICATEURS =========

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

function positionInDay(last,low,high){
  const r = high - low;
  if(r<=0 || last==null) return null;
  return ((last-low)/r)*100;
}

function toScore100(x){
  if(x==null || isNaN(x)) return null;
  return clamp((x+1)/2 * 100, 0, 100);
}

// ========= SNAPSHOT PAR PAIRE (MMS) =========

async function processSymbol(symbol){
  const [tk, fr, oi] = await Promise.all([
    getTicker(symbol),
    getFunding(symbol),
    getOI(symbol)
  ]);
  if(!tk) return null;

  const last   = +tk.last;
  const high24 = +tk.high24h;
  const low24  = +tk.low24h;
  const vol24  = +tk.baseVolume;

  const openInterest = oi ? +oi.amount : null;
  const prev = prevOI.get(symbol) ?? null;
  const deltaOI = (prev!=null && openInterest!=null && prev!==0)
    ? ((openInterest - prev)/prev)*100
    : null;
  prevOI.set(symbol, openInterest ?? prev);

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

  let spreadPct = null;
  if(depth.bids.length && depth.asks.length){
    const b=depth.bids[0][0];
    const a=depth.asks[0][0];
    spreadPct=((a-b)/((a+b)/2))*100;
    if(spreadPct<0) spreadPct=-spreadPct;
  }

  const closes1m  = c1m.map(x=>x.c);
  const closes5m  = c5m.map(x=>x.c);
  const closes15m = c15m.map(x=>x.c);
  const closes1h  = c1h.map(x=>x.c);
  const closes4h  = c4h.map(x=>x.c);

  const rsi1m  = rsi(closes1m,14);
  const rsi5m  = rsi(closes5m,14);
  const rsi15  = rsi(closes15m,14);
  const rsi1h  = rsi(closes1h,14);
  const rsi4h  = rsi(closes4h,14);

  const var15m = closeChange(c15m,1);
  const var1h  = closeChange(c1h,1);
  const var4h  = closeChange(c4h,1);

  const dP_1m  = closeChange(c1m,1);
  const dP_5m  = closeChange(c5m,1);
  const dP_15m = closeChange(c15m,1);

  const volaPct = (last && high24 && low24)
    ? ((high24 - low24)/last)*100
    : null;

  const tend24  = (high24 > low24 && last)
    ? (((last-low24)/(high24-low24))*200 - 100)
    : null;

  const posDay  = positionInDay(last,low24,high24);

  // VWAP 1h local
const vwap1h    = vwap(c1h.slice(-48));
const deltaVWAP = (vwap1h && last) ? percent(last, vwap1h) : null;

// ===== VWAP GLOBAL 4h vs 1h =====
const vwap4h = vwap(c4h.slice(-48));     // VWAP 4h

let deltaVWAPg = null;
if (vwap1h && vwap4h) {
  deltaVWAPg = ((vwap1h / vwap4h) - 1) * 100;
}
  const fundingRate = fr ? +fr.fundingRate * 100 : null;

  // ===== MMS (ex-JDS du snapshot, long/short séparés) =====
  const normLongFromDelta  = dp => dp==null ? 0 : clamp(-dp/2,-1,1);
  const normShortFromDelta = dp => dp==null ? 0 : clamp(dp/2,-1,1);

  const m5L   = normLongFromDelta(dP_5m);
  const m15L  = normLongFromDelta(dP_15m);
  const m5S   = normShortFromDelta(dP_5m);
  const m15S  = normShortFromDelta(dP_15m);

  const dvwapL = deltaVWAP!=null ? clamp(-deltaVWAP/2,-1,1) : 0;
  const dvwapS = deltaVWAP!=null ? clamp( deltaVWAP/2,-1,1) : 0;

  const rsiL   = rsi15!=null ? clamp((50-rsi15)/20,-1,1) : 0;
  const rsiS   = rsi15!=null ? clamp((rsi15-50)/20,-1,1) : 0;

  const MMS_long_raw  = m15L*0.4 + m5L*0.2 + dvwapL*0.2 + rsiL*0.2;
  const MMS_short_raw = m15S*0.4 + m5S*0.2 + dvwapS*0.2 + rsiS*0.2;

  const MMS_long  = toScore100(MMS_long_raw);
  const MMS_short = toScore100(MMS_short_raw);

  return {
    symbol,
    last,
    markPrice,
    high24, low24, vol24,
    volaPct,
    tend24,
    posDay,
    spreadPct: spreadPct!=null ? num(spreadPct,4) : null,
    deltaVWAPpct: deltaVWAP!=null ? num(deltaVWAP,4) : null,
    deltaVWAPgPct: deltaVWAPg != null ? num(deltaVWAPg,4) : null,
    deltaOIpct:   deltaOI!=null   ? num(deltaOI,3)   : null,
    fundingRatePct: fundingRate!=null ? num(fundingRate,6) : null,
    rsi: {
      "1m":  num(rsi1m,2),
      "5m":  num(rsi5m,2),
      "15m": num(rsi15,2),
      "1h":  num(rsi1h,2),
      "4h":  num(rsi4h,2)
    },
    variationPct: {
      "15m": num(var15m,2),
      "1h" : num(var1h,2),
      "4h" : num(var4h,2)
    },
    dP_1m:  num(dP_1m,2),
    dP_5m:  num(dP_5m,2),
    dP_15m: num(dP_15m,2),
    MMS_long,
    MMS_short
  };
}

// ========= FUSION MMS → JDS =========

function fuseJDS(rec){
  const L = rec.MMS_long;
  const S = rec.MMS_short;
  if(L==null && S==null) return null;
  if((S ?? -999) > (L ?? -999)){
    return { direction:"SHORT", jds:S };
  }
  return { direction:"LONG", jds:L };
}

// ========= SETUP STATE =========

function getSetupState(jds){
  if(jds < 40) return "DEAD";
  if(jds < 70) return "CHOP";
  if(jds < 80) return "WATCH";
  if(jds < 90) return "SETUP_EMERGENT";
  if(jds < 95) return "SETUP_READY";
  return "SETUP_PRIME";
}

// ========= OI IMPULSE SCORE =========

function getOiImpulse(deltaOIpct, volaPct){
  if(deltaOIpct==null || volaPct==null || Math.abs(volaPct)<0.1){
    return { score:0, label:"neutre" };
  }
  const score = deltaOIpct / volaPct; // ΔOI / Vola
  let label;
  if(score > 0.10)       label = "construction forte";
  else if(score >= 0.03) label = "construction légère";
  else if(score > -0.02) label = "neutre";
  else if(score < -0.03) label = "purge";
  else                   label = "neutre";
  return { score, label };
}

// ========= OI IMPULSE WEIGHTED =========
// Pondère OI Impulse par la tendance structurelle (RSI multi-TF)
function getWeightedOiImpulse(rec, oiImpulse) {
  const r = rec.rsi;
  const r15 = r["15m"], r1h = r["1h"], r4h = r["4h"];
  if (r15 == null || r1h == null || r4h == null) {
    return { weighted: oiImpulse.score, mult: 1 };
  }

  // Calcul d’un TrendScore simple 0 → 1.6
  let trend = 1;
  const upBias = (r15 + r1h + r4h) / 3;
  const downBias = 100 - upBias;

  // Tendance haussière
  if (upBias > 55) trend += 0.3;
  if (upBias > 60) trend += 0.3;

  // Tendance baissière
  if (downBias > 55) trend += 0.25;
  if (downBias > 60) trend += 0.25;

  const weighted = oiImpulse.score * trend;
  return { weighted, mult: trend };
}

// ========= RSI COHERENCE =========

function isRSICoherent(rec, direction){
  const r = rec.rsi;
  const r15 = r["15m"];
  const r1h = r["1h"];
  const r4h = r["4h"];
  if(r15==null || r1h==null || r4h==null) return true; // on ne pénalise pas si manque de data

  if(direction === "LONG"){
    // structure ascendante
    return r15 <= r1h && r1h <= r4h;
  }else{
    // SHORT : structure descendante
    return r15 >= r1h && r1h >= r4h;
  }
}

// ========= CONFIANCE % =========

function computeConfidence(rec, fusion, setupState, oiImpulse){
  let conf = 50;
  const jds = fusion.jds;
  const dir = fusion.direction;
  const dVW = rec.deltaVWAPpct;
  const vola= rec.volaPct;
  const r   = rec.rsi;

  // JDS contribution
  if(jds >= 95) conf += 18;
  else if(jds >= 90) conf += 12;
  else if(jds >= 80) conf += 6;
  else if(jds < 70)  conf -= 10;

  // ΔVWAP alignement
  if(dVW!=null){
    if(dir==="LONG"){
      if(dVW <= -0.8 && dVW >= -8) conf += 12;
      else if(dVW < -12 || dVW > 6) conf -= 10;
    }else{
      if(dVW >= 0.8 && dVW <= 8) conf += 12;
      else if(dVW > 12 || dVW < -6) conf -= 10;
    }
  }

  // RSI multi-TF gradient
  if(r["15m"]!=null && r["1h"]!=null && r["4h"]!=null){
    let scoreRSI = 0;
    const frames = [r["15m"],r["1h"],r["4h"]];
    if(dir==="LONG"){
      for(const v of frames){
        if(v < 45) scoreRSI += 1;
        else if(v > 60) scoreRSI -= 1;
      }
    }else{
      for(const v of frames){
        if(v > 55) scoreRSI += 1;
        else if(v < 40) scoreRSI -= 1;
      }
    }
    conf += scoreRSI * 4; // -12..+12
  }

  // RSI cohérence structurelle
  if(!isRSICoherent(rec, dir)){
    conf -= 15; // grosse pénalité
  }

  // OI Impulse
  if(oiImpulse.label === "construction forte") conf += 15;
  else if(oiImpulse.label === "construction légère") conf += 8;
  else if(oiImpulse.label === "purge") conf -= 15;

    // ===== MUST-HAVE : ΔVWAP Global (structure profonde du flux) =====
  const dVG = rec.deltaVWAPgPct;
  if (dVG != null) {

    // Structure alignée → boost
    if (fusion.direction === "LONG" && dVG < -0.3) {
      conf += 8;
    }
    if (fusion.direction === "SHORT" && dVG > 0.3) {
      conf += 8;
    }

    // Structure opposée → légère pénalité
    if (fusion.direction === "LONG" && dVG > 1.0) {
      conf -= 5;
    }
    if (fusion.direction === "SHORT" && dVG < -1.0) {
      conf -= 5;
    }
  }
  
  // Volatilité cohérente
  if(vola!=null){
    if(vola >= 2 && vola <= 20) conf += 5;
    else if(vola > 35 || vola < 1) conf -= 10;
  }

  // Setup DEAD/CHOP
  if(setupState==="DEAD" || setupState==="CHOP"){
    conf = Math.min(conf, 55);
  }

  return clamp(Math.round(conf),0,100);
}

// ========= R:R et PLAN (entrée / SL / TP) =========

function estimateRR(vola){
  if(vola==null) return 1.3;
  if(vola < 2)   return 1.3;
  if(vola < 8)   return 1.6;
  if(vola < 15)  return 1.4;
  if(vola < 25)  return 1.2;
  return 1.1; // trop violent → souvent AVOID
}

function buildTradePlan(rec, fusion, jds, rr){
  const price = rec.last;
  const vola  = rec.volaPct ?? 5;
  const dir   = fusion.direction;

  let riskPerc = clamp(vola / 3, 0.5, 5); // % distance SL
  const rewardPerc = riskPerc * rr;

  let entry = price;
  let sl, tp1, tp2;

  if(dir==="LONG"){
    sl  = price * (1 - riskPerc/100);
    if(jds >= 90){
      tp1 = price * (1 + (0.9*riskPerc)/100);           // ≈ 0.9R
      tp2 = price * (1 + (2.7*riskPerc)/100);           // ≈ 2.7R
    }else{
      tp1 = price * (1 + (rewardPerc)/100);             // R:R simple
      tp2 = null;
    }
  }else{
    sl  = price * (1 + riskPerc/100);
    if(jds >= 90){
      tp1 = price * (1 - (0.9*riskPerc)/100);
      tp2 = price * (1 - (2.7*riskPerc)/100);
    }else{
      tp1 = price * (1 - (rewardPerc)/100);
      tp2 = null;
    }
  }

  return {
    entry: num(entry,4),
    sl:    num(sl,4),
    tp1:   num(tp1,4),
    tp2:   tp2!=null ? num(tp2,4) : null,
    riskPerc: num(riskPerc,2),
    rr: num(rr,2)
  };
}

// ========= RECOMMANDATION =========

function computeRecommendation(jds, conf, rr, oiImpulse, dVW, setupState, direction, rsiCoherent){
  // Verrou RSI incohérent : on ne prend pas le trade
  if(!rsiCoherent){
    return "AVOID";
  }

  let reco;

  // Règles d'état
  if(setupState==="DEAD" || setupState==="CHOP") {
    reco = "AVOID";
  } else if(setupState==="WATCH" || setupState==="SETUP_EMERGENT"){
    reco = "WAIT ENTRY";
  } else if(setupState==="SETUP_READY"){
    reco = "TAKE — REDUCED";
  } else { // PRIME
    reco = "TAKE NOW";
  }

  // R:R minimal
  if(rr < 1.2) reco = "AVOID";

  // Confiance globale
  if(conf < 70) {
    reco = "AVOID";
  } else if(conf >= 70 && conf <= 79 && reco!=="AVOID"){
    reco = "WAIT ENTRY";
  }

  // Verrou TAKE NOW (v1.2)
  if(reco==="TAKE NOW"){
    const ok =
      jds >= 95 &&
      conf >= 90 &&
      rr >= 1.5 &&
      dVW!=null && Math.abs(dVW) <= 10 &&
      oiImpulse.label !== "purge";
    if(!ok){
      if(jds >= 90 && conf >= 80) reco = "TAKE — REDUCED";
      else reco = "WAIT ENTRY";
    }
  }

  // Verrou TAKE — REDUCED (un peu plus souple)
  if(reco==="TAKE — REDUCED"){
    const ok =
      jds >= 90 && jds <= 94 &&
      conf >= 80 &&
      oiImpulse.label !== "purge";
    if(!ok) reco = "WAIT ENTRY";
  }

  // Si JDS < 90 → jamais TAKE NOW
  if(jds < 90 && (reco==="TAKE NOW" || reco==="TAKE — REDUCED")){
    reco = "WAIT ENTRY";
  }

  // HARD LOCK : purge forte contre la direction
  if(direction==="LONG" && oiImpulse.label==="purge") {
    reco = "AVOID";
  }
  if(direction==="SHORT" && oiImpulse.label==="construction forte") {
    reco = "AVOID";
  }
  
    // ===== MUST-HAVE : ΔVWAP Global (structure profonde HTF) =====
  const dVG = rec.deltaVWAPgPct;
  if (dVG != null) {

    // 1) CONTRETENDANCE FORTE → on évite
    if (direction === "LONG"  && dVG > 1.5) {
      reco = "WAIT ENTRY";    // jamais TAKE NOW
      conf -= 10;             // pénalité structurelle
    }
    if (direction === "SHORT" && dVG < -1.5) {
      reco = "WAIT ENTRY";
      conf -= 10;
    }

    // 2) ALIGNÉ AVEC LA STRUCTURE → renforcement des signaux
    if (direction === "LONG" && dVG < -0.3) {
      conf += 8;  // structure baissière favorable au short
    }
    if (direction === "SHORT" && dVG > 0.3) {
      conf += 8;  // structure haussière favorable au long
    }

    // 3) Setup PREMIUM : autoriser TAKE NOW seulement si structure OK
    if (reco === "TAKE NOW") {
      if (direction === "LONG" && dVG > 0.5) {
        reco = "TAKE — REDUCED";   // structure moins propre
      }
      if (direction === "SHORT" && dVG < -0.5) {
        reco = "TAKE — REDUCED";
      }
    }
  }

  return reco;
}

// ========= NOISY MARKET BLOCKER =========

function isNoisyMarket(rec){
  const vola = rec.volaPct;
  const dVW  = rec.deltaVWAPpct;
  const tend = rec.tend24;
  const dOI  = rec.deltaOIpct;
  if(vola==null || dVW==null || tend==null || dOI==null) return false;

  const condVola = vola < 2;
  const condVW   = dVW >= -0.5 && dVW <= 0.5;
  const condTend = tend >= -15 && tend <= 15;
  const condOI   = dOI >= -2 && dOI <= 2;

  return condVola && condVW && condTend && condOI;
}

// ========= ANTI-SPAM =========

function shouldSendFor(symbol, direction, reco){
  const key = `${symbol}-${direction}`;
  const now = Date.now();
  const last = lastAlerts.get(key);

  // jamais envoyé : on envoie
  if(!last){
    lastAlerts.set(key, { ts: now, reco });
    return true;
  }

  // si reco a changé (ex: WAIT -> TAKE REDUCED), on envoie même si délai non écoulé
  if(last.reco !== reco){
    lastAlerts.set(key, { ts: now, reco });
    return true;
  }

  // même reco, on applique le délai anti-spam
  if(now - last.ts < MIN_ALERT_DELAY_MS){
    return false;
  }

  lastAlerts.set(key, { ts: now, reco });
  return true;
}

// ========= TRADE VALIDATOR (TAKE — REDUCED / TAKE NOW) =========

// Recalcule un "candidate" complet pour une paire unique
async function buildCandidateForSymbol(symbol, initialDirection) {
  const rec = await processSymbol(symbol);
  if (!rec) return null;

  const fusion = fuseJDS(rec);
  if (!fusion) return null;

  // si la direction change complètement, c'est déjà un gros warning
  const direction = fusion.direction;
  const jds        = fusion.jds;
  const setupState = getSetupState(jds);
  const oiImpulse  = getOiImpulse(rec.deltaOIpct, rec.volaPct);
  const rsiCoherent = isRSICoherent(rec, direction);
  const confiance  = computeConfidence(rec, fusion, setupState, oiImpulse);
  const rr         = estimateRR(rec.volaPct);
  const plan       = buildTradePlan(rec, fusion, jds, rr);
  const reco       = computeRecommendation(
    jds, confiance, rr, oiImpulse, rec.deltaVWAPpct, setupState, direction, rsiCoherent
  );

  return {
    symbol,
    direction,
    jds,
    setupState,
    confiance,
    oiImpulse,
    rr: +plan.rr,
    plan,
    rec,
    reco,
    rsiCoherent
  };
}

// Vérifie si le trade initial est invalidé par la nouvelle structure
function isTradeInvalidated(initial, latest) {
  if (!latest) return true; // pas de data = on préfère annuler

  // 1) Si la reco n'est plus TAKE — REDUCED / TAKE NOW → on annule
  if (latest.reco === "AVOID" || latest.reco === "WAIT ENTRY") {
    return true;
  }

  // 2) Changement de direction = invalidation
  if (latest.direction !== initial.direction) {
    return true;
  }

  const oldRec = initial.rec;
  const newRec = latest.rec;

  // 3) Changement de signe sur ΔVWAP ou amplitude trop extrême
  const oldDVW = oldRec.deltaVWAPpct;
  const newDVW = newRec.deltaVWAPpct;
  if (oldDVW != null && newDVW != null) {
    if (oldDVW * newDVW < 0) {
      // signe opposé → retournement brutal
      return true;
    }
    if (Math.abs(newDVW) > 10) {
      // trop extrême par rapport à ton style
      return true;
    }
  }

  // 4) OI Impulse : purge forte vs direction
  const oiLabel = latest.oiImpulse.label;
  if (latest.direction === "LONG" && oiLabel === "purge") return true;
  if (latest.direction === "SHORT" && oiLabel === "construction forte") return true;

  // 5) RSI incohérent maintenant
  if (!latest.rsiCoherent) return true;

  // 6) Prix déjà trop loin : SL touché ou TP1 déjà fait avant entrée
  const priceNow = newRec.last;
  const entry    = initial.plan.entry;
  const sl       = initial.plan.sl;
  const tp1      = initial.plan.tp1;

  if (latest.direction === "LONG") {
    if (priceNow <= sl) return true;    // déjà invalidé
    if (tp1 != null && priceNow >= tp1) return true; // mouvement déjà réalisé
  } else {
    if (priceNow >= sl) return true;
    if (tp1 != null && priceNow <= tp1) return true;
  }

  return false;
}

// Programme une validation rapide du trade après VALIDATION_DELAY_MS
function scheduleTradeValidation(initialTrade) {
  // On ne valide que TAKE — REDUCED et TAKE NOW
  if (initialTrade.reco !== "TAKE — REDUCED" && initialTrade.reco !== "TAKE NOW") {
    return;
  }

  setTimeout(async () => {
    try {
      const latest = await buildCandidateForSymbol(
        initialTrade.symbol,
        initialTrade.direction
      );
      const invalid = isTradeInvalidated(initialTrade, latest);

      if (invalid) {
        // Message simple : le plan n'est plus valide
        const lines = [];
        lines.push("⚠️ *JTF Trade invalidé — Validation rapide*");
        lines.push(`Pair: \`${initialTrade.symbol}\``);
        lines.push(`Direction: *${initialTrade.direction}*`);
        lines.push(`Reco initiale: ${initialTrade.reco}`);
        lines.push("");
        lines.push("Structure cassée après validation (prix / ΔVWAP / ΔOI / RSI).");
        lines.push("➡️ *Ne pas entrer sur ce setup.* Attends le prochain snapshot.");

        await sendTelegram(lines.join("\n"));
        console.log(`⚠️ Trade invalidé (validator) sur ${initialTrade.symbol} (${initialTrade.direction}).`);
      } else {
        console.log(`✅ Trade toujours valide après validation rapide: ${initialTrade.symbol} (${initialTrade.direction}).`);
      }
    } catch (e) {
      console.error("Erreur dans scheduleTradeValidation:", e.message);
    }
  }, VALIDATION_DELAY_MS);
}

// ========= TELEGRAM =========

async function sendTelegram(text){
  if(!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID){
    console.error("❌ TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID manquant.");
    return;
  }
  try{
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,{
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "Markdown"
      })
    });
  }catch(e){
    console.error("❌ Erreur Telegram:", e.message);
  }
}

function formatRecoWithEmoji(reco){
  const map = {
    "AVOID": "🟥 AVOID",
    "WAIT ENTRY": "🟧 WAIT ENTRY",
    "TAKE — REDUCED": "🟨 TAKE — REDUCED",
    "TAKE NOW": "🟩 TAKE NOW"
  };
  return map[reco] || reco;
}

// ========= SCAN COMPLET =========

async function scanOnce(){
  console.log("🔍 Scan JTF v0.8.1.3…");

  const snapshots = [];
  for(const s of SYMBOLS){
    try{
      const r = await processSymbol(s);
      if(r) snapshots.push(r);
    }catch(e){
      console.error("Erreur snapshot", s, e.message);
    }
    await sleep(120); // léger spacing API
  }

  // Noisy Market Blocker : on utilise BTC comme proxy du marché global
  const btcRec = snapshots.find(r => r.symbol === "BTCUSDT_UMCBL");
  if(btcRec && isNoisyMarket(btcRec)){
    await sendTelegram(
`🔴 *JTF AUTOSELECT — Marché sans direction*

BTCUSDT est en zone plate :
• Vola ≈ ${btcRec.volaPct != null ? btcRec.volaPct.toFixed(2) : "n/a"}%
• ΔVWAP ≈ ${btcRec.deltaVWAPpct != null ? btcRec.deltaVWAPpct.toFixed(2) : "n/a"}%
• Tend ≈ ${btcRec.tend24 != null ? btcRec.tend24.toFixed(2) : "n/a"}%
• ΔOI ≈ ${btcRec.deltaOIpct != null ? btcRec.deltaOIpct.toFixed(2) : "n/a"}%

→ Aucun setup judicieux sur ce snapshot (marché bruyant / sans flux directionnel).`
    );
    console.log("ℹ️ Marché sans direction (noisy blocker).");
    return;
  }

  const candidates = [];
  for(const rec of snapshots){
    const fusion = fuseJDS(rec);
    if(!fusion) continue;

    const jds        = fusion.jds;
    const setupState = getSetupState(jds);
    const oiImpulse  = getOiImpulse(rec.deltaOIpct, rec.volaPct);
    const rsiCoherent = isRSICoherent(rec, fusion.direction);
    const confiance  = computeConfidence(rec, fusion, setupState, oiImpulse);
    const rr         = estimateRR(rec.volaPct);
    const plan       = buildTradePlan(rec, fusion, jds, rr);
    const reco       = computeRecommendation(
      jds, confiance, rr, oiImpulse, rec.deltaVWAPpct, setupState, fusion.direction, rsiCoherent
    );

    candidates.push({
      symbol: rec.symbol,
      direction: fusion.direction,
      jds,
      setupState,
      confiance,
      oiImpulse,
      rr: +plan.rr,
      plan,
      rec,
      reco,
      rsiCoherent
    });
  }

  // Filtre : on ne garde pas AVOID
  const tradables = candidates
    .filter(c => c.reco !== "AVOID")
    .sort((a,b)=>{
      const order = {
        "SETUP_PRIME":4,
        "SETUP_READY":3,
        "SETUP_EMERGENT":2,
        "WATCH":1,
        "CHOP":0,
        "DEAD":0
      };
      const oa = order[a.setupState] ?? 0;
      const ob = order[b.setupState] ?? 0;
      if(ob !== oa) return ob - oa;
      if(b.jds !== a.jds) return b.jds - a.jds;
      return b.confiance - a.confiance;
    })
    .slice(0,3); // max 3 trades

  if(!tradables.length){
    await sendTelegram(
`🔴 *JTF AUTOSELECT — Aucun trade judicieux*

Tous les setups du TOP30 sont soit en état DEAD/CHOP, soit avec une Confiance insuffisante, un R:R trop faible ou une structure incohérente (RSI / ΔVWAP / ΔOI).
→ Résultat : *aucun trade recommandé* sur ce snapshot.`
    );
    console.log("ℹ️ Aucun trade judicieux.");
    return;
  }

  // Vérif anti-spam : au moins un setup nouveau ou dont la reco change
  const fresh = tradables.filter(c => shouldSendFor(c.symbol, c.direction, c.reco));
  if(!fresh.length){
    console.log("⏱️ Pas de nouveaux setups (anti-spam / reco inchangée), on skip l'envoi.");
    return;
  }

  // Les trades à valider rapidement (TAKE — REDUCED / TAKE NOW) parmi les setups frais
  const toValidate = fresh.filter(c =>
    c.reco === "TAKE — REDUCED" || c.reco === "TAKE NOW"
  );

  // ===== Format Telegram PRO avec emojis =====
  const lines = [];
  lines.push("📊 *JTF v0.8.1.3 AUTOSELECT — Snapshot TOP30*");

  tradables.forEach((c, idx) => {
    const vola   = c.rec.volaPct ?? 5;
    const type   = vola > 12 ? "Scalp" : "Swing";
    const levier = vola <= 5 ? "4x" : (vola <= 15 ? "3x" : "2x");
    const tpStr  = (c.jds >= 90 && c.plan.tp2)
      ? `${c.plan.tp1} / ${c.plan.tp2}`
      : `${c.plan.tp1}`;
    const rrStr  = (+c.plan.rr).toFixed(1);
    const dirEmoji = c.direction === "LONG" ? "📈" : "📉";

    lines.push("");
    lines.push(`*${idx+1}) ${c.symbol}*`);
    lines.push(`${dirEmoji} *${c.direction} – ${type}*`);
    lines.push(`💠 *Entry:* ${c.plan.entry}`);
    lines.push(`🛡️ *SL:* ${c.plan.sl}`);
    lines.push(`🎯 *TP:* ${tpStr}`);
    lines.push(`📏 *R:R:* ${rrStr} — *Lev:* ${levier}`);
    lines.push(`🔥 *JDS:* ${c.jds.toFixed(1)}`);
    lines.push(`🔍 *Confiance:* ${c.confiance}%`);
    lines.push(formatRecoWithEmoji(c.reco));
  });

  const best = tradables[0];

  lines.push("");
  lines.push("*Résumé :*");
  lines.push(`• ${tradables.length} setup(s) ont passé tous les filtres (Setup State, Confiance, OI Impulse, RSI, R:R).`);
  lines.push(`• Meilleur score : *${best.symbol}* (${best.direction}) avec JDS = ${best.jds.toFixed(1)} et Confiance = ${best.confiance}%.`);
  lines.push("• Aucun trade en dehors de cette liste : pas de FOMO, pas plus de 3 positions issues de ce snapshot.");
  lines.push("• Si la structure change fortement avant l'entrée (ΔVWAP, RSI, ΔOI), considère le plan comme *invalidé* et attends le prochain snapshot.");

  const message = lines.join("\n");
  await sendTelegram(message);
  
  // 🔍 Validation rapide pour les trades TAKE — REDUCED / TAKE NOW
  for (const t of toValidate) {
    scheduleTradeValidation(t);
  }
  
  console.log("✅ Snapshot JTF envoyé.");
}
// ========= MAIN LOOP =========

async function main(){
  console.log("🚀 JTF v0.8.1.3 AUTOSELECT — Bot Railway démarré.");
  await sendTelegram("🟢 JTF v0.8.1.3 AUTOSELECT démarré sur Railway (snapshot TOP30 toutes les 5 minutes).");

  while(true){
    try{
      await scanOnce();
    }catch(e){
      console.error("❌ Erreur scan:", e.message);
    }
    await sleep(SCAN_INTERVAL_MS);
  }
}

main();