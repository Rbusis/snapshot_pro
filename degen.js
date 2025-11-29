// degen.js — JTF DEGEN v1.3 (CLEAN — API v2 FIXED)
// Ultra-Sniper Lowcaps — zéro debug, stable et silencieux

import fetch from "node-fetch";
import fs from "fs";

// ========= LOAD JSON =========

function loadJson(path){
  try{
    if(fs.existsSync(path)){
      return JSON.parse(fs.readFileSync(path,"utf8"));
    }
  }catch{}
  return [];
}

const top30     = loadJson("./config/top30.json");
const discovery = loadJson("./config/discovery_list.json");

// ========= CONFIG =========

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

const SCAN_INTERVAL_MS       = 5 * 60_000;
const MIN_ALERT_DELAY_MS     = 15 * 60_000;
const GLOBAL_COOLDOWN_MS     = 30 * 60_000;
const SYMBOL_UPDATE_INTERVAL = 60 * 60_000;

// ========= STATE =========

let DEGEN_SYMBOLS      = [];
let lastSymbolUpdate   = 0;
let lastGlobalTradeTime = 0;
const lastAlerts       = new Map();

// ========= UTILS =========

const sleep = ms => new Promise(r=>setTimeout(r,ms));
const num   = (v,d=4)=>v==null?null:+(+v).toFixed(d);
const clamp = (x,min,max)=>Math.max(min,Math.min(max,x));

async function safeGetJson(url){
  try{
    const r = await fetch(url,{headers:{Accept:"application/json"}});
    if(!r.ok) return null;
    return await r.json();
  }catch{
    return null;
  }
}

// ========= API v2 (identique à Discovery) =========

async function getTicker(symbol){
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/ticker?symbol=${symbol}&productType=usdt-futures`
  );
  if(!j?.data) return null;
  return Array.isArray(j.data) ? j.data[0] : j.data;
}

async function getCandles(symbol, seconds, limit=200){
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
  const d = Array.isArray(j.data) ? j.data[0] : j.data;
  return (d?.bids && d?.asks) ? d : null;
}

async function getAllTickers(){
  const j = await safeGetJson(
    "https://api.bitget.com/api/v2/mix/market/tickers?productType=usdt-futures"
  );
  return j?.data ?? [];
}

// ========= INDICATORS =========

function rsi(values,p=14){
  if(!values || values.length<p+1) return null;
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

function calcWicks(c){
  if(!c) return {upper:0,lower:0};
  const top=Math.max(c.o,c.c);
  const bot=Math.min(c.o,c.c);
  return {
    upper:((c.h-top)/c.c)*100,
    lower:((bot-c.l)/c.c)*100
  };
}

// ========= UPDATE LIST =========

async function updateDegenList(){
  const all = await getAllTickers();
  if(!all?.length) return [];

  let lowcaps = all
    .filter(t =>
      t.symbol?.endsWith("USDT") &&
      !top30.includes(t.symbol) &&
      !discovery.includes(t.symbol) &&
      (+t.usdtVolume > 3_000_000)
    )
    .sort((a,b)=>(+b.usdtVolume)-(+a.usdtVolume))
    .slice(0,30)
    .map(t=>t.symbol);

  return lowcaps;
}

// ========= PROCESS PAIR =========

async function processDegen(symbol){
  const tk = await getTicker(symbol);
  if(!tk) return null;

  const last =
    (tk.lastPr    != null ? +tk.lastPr    : NaN) ||
    (tk.markPrice != null ? +tk.markPrice : NaN) ||
    (tk.close     != null ? +tk.close     : NaN) ||
    (tk.last      != null ? +tk.last      : NaN);

  if(!last || Number.isNaN(last)) return null;

  const high24 = tk.high24h!=null?+tk.high24h:null;
  const low24  = tk.low24h !=null?+tk.low24h :null;

  const volaPct = (high24!=null && low24!=null)
    ? ((high24-low24)/last)*100
    : null;

  const change24 = tk.change24h!=null ? +tk.change24h : 0;

  const [c5m,c15m] = await Promise.all([
    getCandles(symbol,300,100),
    getCandles(symbol,900,100)
  ]);

  if(!c5m?.length || !c15m?.length) return null;

  const rsi5  = rsi(c5m.map(x=>x.c));
  const rsi15 = rsi(c15m.map(x=>x.c));

  const vwap5 = vwap(c5m.slice(-24));
  const priceVsVwap = vwap5 ? ((last-vwap5)/vwap5)*100 : 0;

  const L = c5m[c5m.length-1];
  const w = calcWicks(L);
  const lastVol = L.v;
  const avgVol  = c5m.slice(-11,-1).reduce((a,b)=>a+b.v,0)/10;
  const volRatio = avgVol>0 ? lastVol/avgVol : 1;

  const depth = await getDepth(symbol);
  let obScore=0, bids=0, asks=0;

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
    symbol,last,volaPct,change24,
    rsi5,rsi15,priceVsVwap,volRatio,
    wicks:w,obScore,bidsVol:bids,asksVol:asks
  };
}

// ========= ANALYZE (même filtres) =========

function analyzeCandidate(rec){
  if(!rec) return null;

  if(rec.volRatio < 3.5) return null;
  if(rec.volaPct < 4 || rec.volaPct > 25) return null;

  const gap = Math.abs(rec.priceVsVwap);
  if(gap < 1.0 || gap > 3.5) return null;

  let direction = rec.priceVsVwap > 0 ? "LONG" : "SHORT";

  if(direction==="LONG"){
    if(rec.rsi5<50||rec.rsi5>75) return null;
    if(rec.rsi15<45||rec.rsi15>70) return null;
    if(rec.wicks.upper>1.2) return null;
    if(rec.obScore<0) return null;
  } else {
    if(rec.rsi5<25||rec.rsi5>50) return null;
    if(rec.rsi15<30||rec.rsi15>55) return null;
    if(rec.wicks.lower>1.2) return null;
    if(rec.obScore>0) return null;
  }

  let score=0;
  score += clamp(10+(rec.volRatio-3.5)*8,0,30);
  score += (gap>=1.2&&gap<=2.4)?20:12;

  score += direction==="LONG"
    ? (rec.rsi5>=55&&rec.rsi5<=70&&rec.rsi15>=50&&rec.rsi15<=65?15:7)
    : (rec.rsi5>=30&&rec.rsi5<=45&&rec.rsi15>=35&&rec.rsi15<=50?15:7);

  const obRatio = rec.asksVol>0 ? rec.bidsVol/rec.asksVol : 1;

  if(direction==="LONG"){
    if(rec.obScore===1 && obRatio>=1.3) score+=15;
    else if(rec.obScore===1) score+=8;
  } else {
    if(rec.obScore===-1 && obRatio<=0.77) score+=15;
    else if(rec.obScore===-1) score+=8;
  }

  if(direction==="LONG"){
    if(rec.change24>8) score+=10;
    else if(rec.change24>4) score+=6;
  } else {
    if(rec.change24<-8) score+=10;
    else if(rec.change24<-4) score+=6;
  }

  if(direction==="LONG"){
    if(rec.wicks.upper<0.6) score+=5;
    else if(rec.wicks.upper>1.0) score-=5;
  } else {
    if(rec.wicks.lower<0.6) score+=5;
    else if(rec.wicks.lower>1.0) score-=5;
  }

  score = clamp(Math.round(score),0,100);
  if(score<88) return null;

  return { ...rec, direction, score };
}

// ========= TELEGRAM =========

async function sendTelegram(text){
  if(!TELEGRAM_BOT_TOKEN||!TELEGRAM_CHAT_ID) return;
  try{
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,{
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({chat_id:TELEGRAM_CHAT_ID,text,parse_mode:"Markdown"})
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
  const now = Date.now();

  // Mise à jour liste
  if (now - lastSymbolUpdate > SYMBOL_UPDATE_INTERVAL || !DEGEN_SYMBOLS.length){
    DEGEN_SYMBOLS = await updateDegenList();
    lastSymbolUpdate = now;
  }

  const BATCH = 5;
  const candidates = [];

  for (let i = 0; i < DEGEN_SYMBOLS.length; i += BATCH){
    const batch = DEGEN_SYMBOLS.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(s => processDegen(s)));
    for (const r of results){
      const s = analyzeCandidate(r);
      if (s) candidates.push(s);
    }
    await sleep(200);
  }

  // 🎯 HEARTBEAT LOG — indique que DEGEN tourne bien
  if (!candidates.length){
    console.log(`[DEGEN] Scan OK — 0 signal`);
    return;
  }

  // Un signal a été trouvé
  const best = candidates.sort((a,b)=>b.score - a.score)[0];

  if (now - lastGlobalTradeTime < GLOBAL_COOLDOWN_MS){
    console.log(`[DEGEN] Cooldown — Signal ignoré (${best.symbol})`);
    return;
  }

  if (!antiSpam(best.symbol, best.direction)){
    console.log(`[DEGEN] Anti-spam — ignoré (${best.symbol})`);
    return;
  }

  console.log(`[DEGEN] SIGNAL — ${best.symbol} ${best.direction} (Score ${best.score})`);

  const emoji = best.direction==="LONG" ? "🔫🟢" : "🔫🔴";

  const msg =
`🎯 *DEGEN v1.3 (API v2)*

${emoji} *${best.symbol}* — ${best.direction}
🏅 Score: ${best.score}/100

📊 Vol Spike: x${num(best.volRatio,2)}
🌡️ Vola24: ${num(best.volaPct,2)}%
📉 ΔVWAP: ${num(best.priceVsVwap,2)}%

💰 Prix: ${best.last}

_Wait for limit — sniper mode._`;

  await sendTelegram(msg);
  lastGlobalTradeTime = now;
}

// ========= START =========

async function main(){
  await sendTelegram("🟢 DEGEN v1.3 démarré (clean).");
  while(true){
    try{ await scanDegen(); }
    catch(e){}
    await sleep(SCAN_INTERVAL_MS);
  }
}

export const startDegen = main;