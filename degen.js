// degen.js — JTF DEGEN v1.3 (API v2 TRUE FUTURES FIX + Light Debug)
// Ultra-Sniper Lowcaps — Now fully compatible with Bitget API v2

import fetch from "node-fetch";
import fs from "fs";

// ================== LOAD JSON ==================

function loadJson(path) {
  try {
    if (fs.existsSync(path)) {
      return JSON.parse(fs.readFileSync(path, "utf8"));
    }
  } catch (e) {
    console.error(`⚠️ Error loading ${path}:`, e.message);
  }
  return [];
}

const top30     = loadJson("./config/top30.json");           // must contain BTCUSDT, ETHUSDT, etc.
const discovery = loadJson("./config/discovery_list.json"); // must contain futures-only

// ================== CONFIG ==================

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

const SCAN_INTERVAL_MS      = 5 * 60_000;
const MIN_ALERT_DELAY_MS    = 15 * 60_000;
const GLOBAL_COOLDOWN_MS    = 30 * 60_000;
const SYMBOL_UPDATE_INTERVAL = 60 * 60_000;

// BTC context limits
const BTC_TREND_ABS_MIN   = 0.2;
const BTC_TREND_ABS_MAX   = 2.5;

const BTC_LONG_MIN  = 0.2;
const BTC_LONG_MAX  = 2.0;
const BTC_SHORT_MIN = -2.0;
const BTC_SHORT_MAX = -0.2;

let DEGEN_SYMBOLS = [];
let lastSymbolUpdate   = 0;
let lastGlobalTradeTime = 0;

const lastAlerts = new Map();

// ================== UTILS ==================

const sleep = ms => new Promise(res=>setTimeout(res,ms));
const num   = (v,d=4)=>v==null?null:+(+v).toFixed(d);
const clamp = (x,min,max)=>Math.max(min,Math.min(max,x));

/* DEBUG flag */
const DEBUG = true;  // set false to turn off

async function safeGetJson(url){
  try {
    const r = await fetch(url, { headers:{Accept:"application/json"} });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// ================== API v2 ==================

async function fetchFuturesTickers(){
  const j = await safeGetJson(
    "https://api.bitget.com/api/v2/mix/market/tickers?productType=usdt-futures"
  );
  return j?.data ?? [];
}

async function getCandles(symbol, seconds, limit=120){
  const gran = seconds; // v2 accepts raw numeric granularity
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}&granularity=${gran}&productType=usdt-futures&limit=${limit}`
  );
  if (!j?.data?.length) return [];
  return j.data.map(c=>({
    t:+c[0], o:+c[1], h:+c[2], l:+c[3], c:+c[4], v:+c[5]
  })).sort((a,b)=>a.t-b.t);
}

async function getTicker(symbol){
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/ticker?symbol=${symbol}&productType=usdt-futures`
  );
  if (!j) return null;

  if (Array.isArray(j.data)) return j.data[0];
  return j.data ?? null;
}

async function getDepth(symbol){
  // Depth normal works fine on futures-only
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/depth?symbol=${symbol}&limit=20&productType=usdt-futures`
  );
  return (j?.data?.bids && j?.data?.asks) ? j.data : null;
}

// ================== BTC TREND ==================

async function getBTCTrend(){
  const c = await getCandles("BTCUSDT", 3600, 5);
  if (!c || c.length < 2) return null;
  const last = c[c.length-1];
  return ((last.c - last.o)/last.o)*100;
}

// ================== DEGEN SYMBOL LIST ==================

const IGNORE_LIST = [
  "BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT","ADAUSDT","DOGEUSDT",
  "AVAXUSDT","DOTUSDT","TRXUSDT","LINKUSDT","TONUSDT","SUIUSDT","APTUSDT",
  "NEARUSDT","ARBUSDT","OPUSDT","INJUSDT","ATOMUSDT","AAVEUSDT","LTCUSDT",
  "UNIUSDT","FILUSDT","XLMUSDT","RUNEUSDT","ALGOUSDT","PEPEUSDT","WIFUSDT",
  "TIAUSDT","SEIUSDT"
];

const FALLBACK_LOWCAPS = [
  "MAGICUSDT","GALAUSDT","ONEUSDT","KAVAUSDT","CELOUSDT"
];

async function updateDegenList(){
  try {
    const all = await fetchFuturesTickers();  // future-only list
    if (!all.length) return FALLBACK_LOWCAPS;

    let valid = all.filter(t=>{
      const sym = t.symbol;
      const vol = +t.usdtVolume;

      return (
        sym.endsWith("USDT") &&
        vol > 3_000_000 &&
        !IGNORE_LIST.includes(sym) &&
        !top30.includes(sym) &&
        !discovery.includes(sym)
      );
    });

    valid.sort((a,b)=>(+b.usdtVolume)-(+a.usdtVolume));

    const lowcaps = valid.map(t=>t.symbol).slice(0,30);

    console.log(`🔄 DEGEN v1.3 list updated: ${lowcaps.length} futures symbols`);
    return lowcaps.length ? lowcaps : FALLBACK_LOWCAPS;

  } catch(e){
    console.log("⚠ updateDegenList ERROR:", e?.message);
    return FALLBACK_LOWCAPS;
  }
}

// ================== INDICATORS ==================

function rsi(values,p=14){
  if (!values || values.length < p+1) return null;
  let g=0,l=0;
  for (let i=1;i<=p;i++){
    const d=values[i]-values[i-1];
    d>=0?g+=d:l-=d;
  }
  g/=p; l=(l/p)||1e-9;
  let rs=g/l;
  let v=100-100/(1+rs);
  for (let i=p+1;i<values.length;i++){
    const d=values[i]-values[i-1];
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

function wicks(c){
  if (!c) return { upper:0, lower:0 };
  const top=Math.max(c.o,c.c);
  const bot=Math.min(c.o,c.c);
  return {
    upper: ((c.h-top)/c.c)*100,
    lower: ((bot-c.l)/c.c)*100
  };
}

// ================== PROCESS ONE PAIR ==================

async function processDegen(symbol){
  const [tk, depth] = await Promise.all([
    getTicker(symbol),
    getDepth(symbol)
  ]);

  if (!tk) return null;

  const last  = +tk.last;
  const high24= +tk.high24h;
  const low24 = +tk.low24h;

  const volaPct = last ? ((high24-low24)/last)*100 : null;
  const change24 = tk.priceChangePercent ? (+tk.priceChangePercent)*100 : null;

  const [c5m, c15m] = await Promise.all([
    getCandles(symbol, 300, 80),
    getCandles(symbol, 900, 80)
  ]);

  if (!c5m || c5m.length<40 || !c15m || c15m.length<40)
    return null;

  const rsi5  = rsi(c5m.map(x=>x.c));
  const rsi15 = rsi(c15m.map(x=>x.c));

  const vwap5 = vwap(c5m.slice(-24));
  const priceVsVwap = vwap5 ? ((last-vwap5)/vwap5)*100 : 0;

  const cd = c5m[c5m.length-1];
  const wk = wicks(cd);

  const lastVol = cd.v;
  const avgVol  = c5m.slice(-11,-1).reduce((a,b)=>a+b.v,0)/10;
  const volRatio = avgVol>0 ? lastVol/avgVol : 1;

  let obScore=0, bidsVol=0, asksVol=0;

  if (depth){
    bidsVol = depth.bids.slice(0,10).reduce((a,x)=>a+(+x[1]),0);
    asksVol = depth.asks.slice(0,10).reduce((a,x)=>a+(+x[1]),0);

    if (asksVol > 0){
      const r=bidsVol/asksVol;
      if (r>1.25) obScore=1;
      else if (r<0.75) obScore=-1;
    }
  }

  if (DEBUG){
    console.log(`[DEGEN DEBUG] ${symbol} | last=${num(last)} | vola=${num(volaPct)} | volRatio=${num(volRatio)} | ΔVWAP=${num(priceVsVwap)}`);
  }

  return {
    symbol,last,volaPct,rsi5,rsi15,priceVsVwap,
    volRatio,change24,obScore,bidsVol,asksVol,wicks:wk
  };
}

// ================== LOGIC / SCORING ==================

function analyzeCandidate(rec, btc){
  if (!rec || btc==null) return null;

  const vola = rec.volaPct;
  const gap  = Math.abs(rec.priceVsVwap);

  if (rec.volRatio < 3.5) return null;
  if (vola < 4 || vola > 25) return null;
  if (gap < 1.0 || gap > 3.5) return null;

  const absBTC = Math.abs(btc);
  if (absBTC < BTC_TREND_ABS_MIN || absBTC > BTC_TREND_ABS_MAX) return null;

  let dir = rec.priceVsVwap > 0 ? "LONG" : "SHORT";

  if (dir==="LONG"){
    if (btc < BTC_LONG_MIN || btc > BTC_LONG_MAX) return null;
    if (rec.rsi5<50 || rec.rsi5>75) return null;
    if (rec.rsi15<45||rec.rsi15>70) return null;
    if (rec.wicks.upper > 1.2) return null;
    if (rec.obScore < 0) return null;
  } else {
    if (btc > BTC_SHORT_MAX || btc < BTC_SHORT_MIN) return null;
    if (rec.rsi5<25 || rec.rsi5>50) return null;
    if (rec.rsi15<30||rec.rsi15>55) return null;
    if (rec.wicks.lower > 1.2) return null;
    if (rec.obScore > 0) return null;
  }

  let score=0;

  score += clamp(10+(rec.volRatio-3.5)*8,0,30);

  if (gap>=1.2 && gap<=2.4) score += 20;
  else if (gap>2.4 && gap<=3.5) score += 12;
  else score += 5;

  let r5 = rec.rsi5, r15 = rec.rsi15;

  if (dir==="LONG"){
    if (r5>=55&&r5<=70&&r15>=50&&r15<=65) score+=15;
    else if (r5>50&&r15>45) score+=7;
  } else {
    if (r5>=30&&r5<=45&&r15>=35&&r15<=50) score+=15;
    else if (r5<50&&r15<55) score+=7;
  }

  const obRatio = rec.asksVol>0 ? rec.bidsVol/rec.asksVol : 1;

  if (dir==="LONG"){
    if (rec.obScore===1 && obRatio>=1.3) score+=15;
    else if (rec.obScore===1) score+=8;
  }else{
    if (rec.obScore===-1 && obRatio<=0.77) score+=15;
    else if (rec.obScore===-1) score+=8;
  }

  if (dir==="LONG"){
    if (rec.change24>8) score+=10;
    else if (rec.change24>4) score+=6;
  }else{
    if (rec.change24<-8) score+=10;
    else if (rec.change24<-4) score+=6;
  }

  if (dir==="LONG"){
    if (btc>=0.5&&btc<=1.8) score+=10;
    else if (btc>=0.2&&btc<=2.0) score+=6;
  } else {
    if (btc<=-0.5&&btc>=-1.8) score+=10;
    else if (btc<=-0.2&&btc>=-2.0) score+=6;
  }

  const finalScore = clamp(Math.round(score),0,100);
  if (finalScore < 88) return null;

  return {
    symbol:rec.symbol,
    direction:dir,
    score:finalScore,
    volRatio:rec.volRatio,
    vola:rec.volaPct,
    priceVsVwap:rec.priceVsVwap,
    last:rec.last
  };
}

// ================== TELEGRAM ==================

async function sendTelegram(text){
  if(!TELEGRAM_BOT_TOKEN||!TELEGRAM_CHAT_ID) return;
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
    console.error("Telegram error:", e?.message);
  }
}

function checkAntiSpam(symbol, direction){
  const key = `${symbol}-${direction}`;
  const now = Date.now();
  const last = lastAlerts.get(key);
  if (last && now-last < MIN_ALERT_DELAY_MS) return false;
  lastAlerts.set(key,now);
  return true;
}

// ================== MAIN LOOP ==================

async function scanDegen(){
  const now = Date.now();

  if (now-lastSymbolUpdate > SYMBOL_UPDATE_INTERVAL || !DEGEN_SYMBOLS.length){
    DEGEN_SYMBOLS = await updateDegenList();
    lastSymbolUpdate = now;
  }

  const btc = await getBTCTrend();
  if (btc==null || isNaN(btc)){
    console.log("⚠ BTC Trend error");
    return;
  }

  console.log(`🎯 DEGEN v1.3 | BTC: ${btc.toFixed(2)}% | ${DEGEN_SYMBOLS.length} symbols`);

  const candidates = [];
  const BATCH = 5;

  for (let i=0;i<DEGEN_SYMBOLS.length;i+=BATCH){
    const batch = DEGEN_SYMBOLS.slice(i,i+BATCH);
    const results = await Promise.all(batch.map(s=>processDegen(s)));
    for (const r of results){
      const s = analyzeCandidate(r, btc);
      if (s) candidates.push(s);
    }
    await sleep(250);
  }

  if (!candidates.length){
    console.log("ℹ No DEGEN signal");
    return;
  }

  const best = candidates.sort((a,b)=>{
    if (b.score!==a.score) return b.score - a.score;
    return b.volRatio - a.volRatio;
  })[0];

  if (now-lastGlobalTradeTime < GLOBAL_COOLDOWN_MS){
    console.log(`⏳ Cooldown — skip ${best.symbol}`);
    return;
  }

  if (!checkAntiSpam(best.symbol,best.direction)){
    console.log(`⏳ Anti-spam — skip ${best.symbol}`);
    return;
  }

  const emoji = best.direction==="LONG" ? "🟢💥" : "🔴💥";

  const msg =
`🎯 *DEGEN v1.3 (API v2 Futures)*

${emoji} *${best.symbol}* — ${best.direction}
🏅 Score: ${best.score}/100

📊 Vol Spike: x${num(best.volRatio,2)}
🌡 Vola24: ${num(best.vola,2)}%
📉 ΔVWAP: ${num(best.priceVsVwap,2)}%

💰 Price: ${best.last}

_Patient limit. No FOMO._`;

  await sendTelegram(msg);
  console.log(`✅ SHOT: ${best.symbol} [${best.direction}] Score=${best.score}`);

  lastGlobalTradeTime = now;
}

async function main(){
  console.log("🔫 DEGEN v1.3 started");
  await sendTelegram("🟢 *DEGEN v1.3 (API v2 Futures)* activated.");
  while(true){
    try { await scanDegen(); }
    catch(e){ console.error("DEGEN crash:", e); }
    await sleep(SCAN_INTERVAL_MS);
  }
}

export const startDegen = main;