// discovery.js — JTF DISCOVERY v1.6 (FULL API v2 FIX)
// Stable — Debug complet — Compatible Railway

import fetch from "node-fetch";
import fs from "fs";

// ========= CONFIG =========
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

const SCAN_INTERVAL_MS      = 5 * 60_000;
const MIN_ALERT_DELAY_MS    = 15 * 60_000;
const GLOBAL_COOLDOWN_MS    = 30 * 60_000;
const SYMBOL_UPDATE_INTERVAL = 60 * 60_000;

// BTC sécurité
const BTC_LONG_MIN  = -0.2;
const BTC_SHORT_MAX = +0.5;

// État interne
let DISCOVERY_SYMBOLS = [];
let lastSymbolUpdate   = 0;
let lastGlobalTradeTime = 0;
const lastAlerts = new Map();

// Fallback midcaps
const FALLBACK_MIDCAPS = [
  "INJUSDT_UMCBL", "FETUSDT_UMCBL", "RNDRUSDT_UMCBL",
  "ARBUSDT_UMCBL", "AGIXUSDT_UMCBL"
];

// Ignorés (majeurs + déjà scannés ailleurs)
const IGNORE_LIST = [
  "BTCUSDT_UMCBL","ETHUSDT_UMCBL","BNBUSDT_UMCBL","SOLUSDT_UMCBL","XRPUSDT_UMCBL",
  "ADAUSDT_UMCBL","DOGEUSDT_UMCBL","AVAXUSDT_UMCBL","DOTUSDT_UMCBL","TRXUSDT_UMCBL",
  "LINKUSDT_UMCBL","TONUSDT_UMCBL","SUIUSDT_UMCBL","APTUSDT_UMCBL","NEARUSDT_UMCBL",
  "ARBUSDT_UMCBL","OPUSDT_UMCBL","INJUSDT_UMCBL","ATOMUSDT_UMCBL","AAVEUSDT_UMCBL",
  "LTCUSDT_UMCBL","UNIUSDT_UMCBL","FILUSDT_UMCBL","XLMUSDT_UMCBL","RUNEUSDT_UMCBL",
  "ALGOUSDT_UMCBL","PEPEUSDT_UMCBL","WIFUSDT_UMCBL","TIAUSDT_UMCBL","SEIUSDT_UMCBL"
];

// ========= UTILS =========
const sleep = (ms) => new Promise(r => setTimeout(r,ms));
const clamp = (x,min,max)=>Math.max(min,Math.min(max,x));
const num = (v,d=4)=>v==null?null:+(+v).toFixed(d);

async function safeGetJson(url){
  try{
    const r = await fetch(url,{ headers:{Accept:"application/json"} });
    if(!r.ok) return null;
    return await r.json();
  }catch{
    return null;
  }
}

// ========= API v2 (symbol EXACT : XXXUSDT_UMCBL) =========

// Candles
async function getCandles(symbol, seconds, limit=200){
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}&granularity=${seconds}&limit=${limit}&productType=usdt-futures`
  );
  if(!j?.data?.length) return [];
  return j.data.map(c => ({
    t:+c[0], o:+c[1], h:+c[2], l:+c[3], c:+c[4], v:+c[5]
  })).sort((a,b)=>a.t-b.t);
}

// 🔥 FIX COMPLET : getTicker valide
async function getTicker(symbol){
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/ticker?symbol=${symbol}&productType=usdt-futures`
  );
  return j?.data ?? null;
}

// Funding
async function getFunding(symbol){
  return (
    await safeGetJson(
      `https://api.bitget.com/api/v2/mix/market/current-fund-rate?symbol=${symbol}&productType=usdt-futures`
    )
  )?.data ?? null;
}

// Depth
async function getDepth(symbol){
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/depth?symbol=${symbol}&limit=20&productType=usdt-futures`
  );
  return (j?.data?.bids && j?.data?.asks) ? j.data : null;
}

// Full tickers
async function getAllTickers(){
  const j = await safeGetJson(
    "https://api.bitget.com/api/v2/mix/market/tickers?productType=usdt-futures"
  );
  return j?.data ?? [];
}

// ========= BTC Trend =========
async function getBTCTrend(){
  const c = await getCandles("BTCUSDT_UMCBL", 3600, 5);
  if(!c?.length) return null;
  const last = c[c.length-1];
  return ((last.c - last.o)/last.o)*100;
}

// ========= Update Discovery List =========
async function updateDiscoveryList(){
  const all = await getAllTickers();
  if(!all.length){
    console.log("⚠ DiscoveryList : fallback (no market data)");
    return FALLBACK_MIDCAPS;
  }

  let list = all.filter(t =>
    t.symbol.endsWith("_UMCBL") &&
    !IGNORE_LIST.includes(t.symbol) &&
    (+t.usdtVolume > 5_000_000)
  );

  list.sort((a,b)=>(+b.usdtVolume) - (+a.usdtVolume));
  const midcaps = list.slice(0,50).map(t=>t.symbol);

  try{
    fs.writeFileSync("./config/discovery_list.json", JSON.stringify(midcaps,null,2));
  }catch{}

  return midcaps.length ? midcaps : FALLBACK_MIDCAPS;
}

// ========= INDICS =========
function rsi(values,p=14){
  if(!values || values.length < p+1) return null;
  let g=0,l=0;
  for(let i=1;i<=p;i++){
    const d=values[i]-values[i-1];
    if(d>=0) g+=d; else l-=d;
  }
  g/=p; l=(l/p)||1e-9;
  let val = 100-100/(1+(g/l));

  for(let i=p+1;i<values.length;i++){
    const d=values[i]-values[i-1];
    g=(g*(p-1)+Math.max(d,0))/p;
    l=((l*(p-1)+Math.max(-d,0))/p)||1e-9;
    val = 100-100/(1+(g/l));
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
    upper: ((c.h-top)/c.c)*100,
    lower: ((bot-c.l)/c.c)*100
  };
}

// ========= PROCESS SYMBOL =========
async function processDiscovery(symbol){
  const tk = await getTicker(symbol);

  if(!tk){
    console.log(`[DISCOVERY DEBUG] ${symbol}: ❌ Ticker NULL`);
    return null;
  }

  const last = +tk.lastPr || +tk.markPrice || +tk.last || null;
  if(!last){
    console.log(`[DISCOVERY DEBUG] ${symbol}: ❌ last=NULL (ticker incomplete)`);
    return null;
  }

  // 24h vola
  const high24 = +tk.high24h;
  const low24  = +tk.low24h;
  const volaPct = last ? ((high24-low24)/last)*100 : null;

  // candles 5m / 15m
  const [c5m,c15m] = await Promise.all([
    getCandles(symbol,300,100),
    getCandles(symbol,900,100)
  ]);
  if(!c5m?.length){
    console.log(`[DISCOVERY DEBUG] ${symbol}: ❌ Candles MISSING`);
    return null;
  }

  const rsi5  = rsi(c5m.map(x=>x.c));
  const rsi15 = rsi(c15m.map(x=>x.c));

  const vwap5 = vwap(c5m.slice(-24));
  const priceVsVwap = vwap5 ? ((last-vwap5)/vwap5)*100 : 0;

  const wick = wicks(c5m[c5m.length-1]);

  const lastVol = c5m[c5m.length-1].v;
  const avgVol  = c5m.slice(-11,-1).reduce((a,b)=>a+b.v,0)/10;
  const volRatio = avgVol>0 ? lastVol/avgVol : 1;

  const change24 = tk.priceChangePercent ? (+tk.priceChangePercent)*100 : 0;

  // depth
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

  console.log(
    `[DISCOVERY DEBUG] ${symbol}: last=${last} | vola=${num(volaPct)} | rsi5=${num(rsi5)} | VWAPgap=${num(priceVsVwap)} | volRatio=${num(volRatio)}`
  );

  return {
    symbol,last,volaPct,rsi5,rsi15,
    priceVsVwap,volRatio,change24,obScore,
    bidsVol:bids,asksVol:asks,wicks:wick
  };
}

// ========= LOGIC =========
function analyze(rec, btc){
  if(!rec||btc==null) return null;

  if(rec.volRatio < 2) return null;
  if(rec.volaPct < 3 || rec.volaPct > 22) return null;

  const gap=Math.abs(rec.priceVsVwap);
  if(gap < 0.6 || gap > 3.2) return null;

  let dir=null;

  if(rec.priceVsVwap>0){
    if(btc < BTC_LONG_MIN) return null;
    if(rec.wicks.upper>1.2) return null;
    if(rec.obScore<0) return null;
    dir="LONG";
  } else {
    if(btc > BTC_SHORT_MAX) return null;
    if(rec.wicks.lower>1.2) return null;
    if(rec.obScore>0) return null;
    dir="SHORT";
  }

  let score=0;
  score += rec.volRatio>=3 ? 30 : 15;
  score += (gap>=1 && gap<=2.2) ? 20 : 10;
  score += (dir==="LONG"
      ? (rec.rsi5>=55&&rec.rsi5<=75?15:5)
      : (rec.rsi5>=25&&rec.rsi5<=45?15:5)
  );
  if((dir==="LONG"&&rec.obScore===1)||(dir==="SHORT"&&rec.obScore===-1)) score+=15;
  if((dir==="LONG"&&rec.change24>3)||(dir==="SHORT"&&rec.change24<-3)) score+=10;
  if((dir==="LONG"&&btc>=0)||(dir==="SHORT"&&btc<=0)) score+=10;

  if(score<78) return null;

  const decimals = rec.last < 1 ? 5 : 3;

  const pullback = clamp(gap/4,0.4,1.0);
  const entry = dir==="LONG"
    ? rec.last*(1-pullback/100)
    : rec.last*(1+pullback/100);

  const riskPct = clamp((rec.volaPct/5)*2,2,5);
  const sl = dir==="LONG"
    ? rec.last*(1-riskPct/100)
    : rec.last*(1+riskPct/100);

  const tp = dir==="LONG"
    ? rec.last*(1+(riskPct*2)/100)
    : rec.last*(1-(riskPct*2)/100);

  const lev = riskPct>4?"2x":"3x";

  return {
    symbol:rec.symbol,
    direction:dir,
    score,
    price:rec.last,
    limitEntry:num(entry,decimals),
    sl:num(sl,decimals),
    tp:num(tp,decimals),
    riskPct:num(riskPct,2),
    obRatio: rec.asksVol>0 ? (rec.bidsVol/rec.asksVol).toFixed(2) : "N/A",
    volRatio:num(rec.volRatio,1),
    vola:num(rec.volaPct,1),
    levier:lev,
    reason:
      rec.volRatio>=3?"Volume Spike":
      rec.obScore!==0?"Orderbook Pressure":
      "Momentum Propre"
  };
}

// ========= TELEGRAM =========
async function sendTelegram(msg){
  if(!TELEGRAM_BOT_TOKEN||!TELEGRAM_CHAT_ID) return;
  try{
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,{
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ chat_id:TELEGRAM_CHAT_ID, text:msg, parse_mode:"Markdown" })
    });
  }catch(e){
    console.error("Telegram error:",e);
  }
}

function antiSpam(symbol,dir){
  const key=`${symbol}-${dir}`;
  const now=Date.now();
  const last=lastAlerts.get(key);
  if(last&&now-last<MIN_ALERT_DELAY_MS) return false;
  lastAlerts.set(key,now);
  return true;
}

// ========= MAIN LOOP =========
async function scanDiscovery(){
  const now=Date.now();

  const btc = await getBTCTrend();
  if(btc==null){
    console.log("⚠ BTC Trend missing — skip");
    return;
  }

  console.log(`🔥 Discovery v1.6 — BTC Trend=${btc.toFixed(2)}%`);

  if(now-lastSymbolUpdate > SYMBOL_UPDATE_INTERVAL || !DISCOVERY_SYMBOLS.length){
    DISCOVERY_SYMBOLS = await updateDiscoveryList();
    lastSymbolUpdate = now;
    console.log(`🔄 Liste mise à jour (${DISCOVERY_SYMBOLS.length} paires).`);
  }

  const BATCH=5;
  const signals=[];

  for(let i=0;i<DISCOVERY_SYMBOLS.length;i+=BATCH){
    const batch=DISCOVERY_SYMBOLS.slice(i,i+BATCH);
    const res = await Promise.all(batch.map(s=>processDiscovery(s)));
    for(const r of res){
      const s=analyze(r,btc);
      if(s) signals.push(s);
    }
    await sleep(250);
  }

  if(!signals.length){
    console.log("ℹ Aucun signal Discovery.");
    return;
  }

  const best = signals.sort((a,b)=>b.score-a.score)[0];

  if(now-lastGlobalTradeTime < GLOBAL_COOLDOWN_MS){
    console.log(`⏳ Cooldown — ${best.symbol} ignoré`);
    return;
  }

  if(!antiSpam(best.symbol,best.direction)){
    console.log(`⏳ Anti-spam — ${best.symbol} ignoré`);
    return;
  }

  const emoji=best.direction==="LONG"?"🚀":"🪂";

  const msg=
`⚡ *JTF DISCOVERY v1.6* ⚡

${emoji} *${best.symbol}* — ${best.direction}
🏅 Score: ${best.score}

💠 Entry: ${best.limitEntry}
🎯 TP: ${best.tp}
🛑 SL: ${best.sl}

📊 Vol: x${best.volRatio}
🌡️ Vola: ${best.vola}%
📘 OB: ${best.obRatio}
⚖️ Levier: ${best.levier}

_Momentum Midcaps — API v2 FIXED_`;

  await sendTelegram(msg);
  lastGlobalTradeTime = now;

  console.log(`✅ Signal envoyé : ${best.symbol}`);
}

// ========= START =========
async function main(){
  console.log("🔥 Discovery v1.6 — démarré.");
  await sendTelegram("🟢 Discovery v1.6 lancé (API v2 FIX).");
  while(true){
    try{ await scanDiscovery(); }
    catch(e){ console.error("DISCOVERY CRASH:",e); }
    await sleep(SCAN_INTERVAL_MS);
  }
}

export const startDiscovery = main;