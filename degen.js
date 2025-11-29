// degen.js — JTF DEGEN v1.2 Ultra-Sniper (API v2 FIXED & CLEAN)

import fetch from "node-fetch";
import fs from "fs";

// ========= LOAD JSON =========

function loadJson(path) {
  try {
    if (fs.existsSync(path)) {
      return JSON.parse(fs.readFileSync(path, "utf8"));
    }
  } catch (e) {
    console.error(`⚠️ Erreur lecture ${path}:`, e.message);
  }
  return [];
}

const top30 = loadJson("./config/top30.json").map(s => s.replace("_UMCBL",""));
function getDiscoveryList() {
  return loadJson("./config/discovery_list.json").map(s => s.replace("_UMCBL",""));
}

// ========= CONFIG =========

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

// ========= STATE =========

let DEGEN_SYMBOLS = [];
let lastSymbolUpdate = 0;
let lastGlobalTradeTime = 0;
const lastAlerts = new Map();

// Fallback lowcaps
const FALLBACK_LOWCAPS = [
  "MAGICUSDT","GALAUSDT","ONEUSDT","CELOUSDT","KAVAUSDT"
];

// Exclusions (normalisées)
const IGNORE_LIST = [
  "BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT",
  "ADAUSDT","DOGEUSDT","AVAXUSDT","DOTUSDT","TRXUSDT",
  "LINKUSDT","TONUSDT","SUIUSDT","APTUSDT","NEARUSDT",
  "ARBUSDT","OPUSDT","INJUSDT","ATOMUSDT","AAVEUSDT",
  "LTCUSDT","UNIUSDT","FILUSDT","XLMUSDT","RUNEUSDT",
  "ALGOUSDT","PEPEUSDT","WIFUSDT","TIAUSDT","SEIUSDT"
];

// ========= UTILS =========

const sleep = ms => new Promise(r => setTimeout(r, ms));
const num   = (v,d=4)=>v==null?null:+(+v).toFixed(d);
const clamp = (x,min,max)=>Math.max(min,Math.min(max,x));

async function safeGetJson(url){
  try {
    const r = await fetch(url, { headers:{Accept:"application/json"} });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// ========= API v2 ONLY =========

async function getCandles(symbol, granularity="5m", limit=100){
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}&granularity=${granularity}&productType=usdt-futures&limit=${limit}`
  );
  if (!j?.data) return [];
  return j.data.map(c=>({
    t:+c[0], o:+c[1], h:+c[2], l:+c[3], c:+c[4], v:+c[5]
  })).sort((a,b)=>a.t-b.t);
}

async function getTicker(symbol){
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/ticker?symbol=${symbol}&productType=usdt-futures`
  );
  if (Array.isArray(j?.data)) return j.data[0] ?? null;
  return j?.data ?? null;
}

async function getFunding(symbol){
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/current-fund-rate?symbol=${symbol}&productType=usdt-futures`
  );
  const d = Array.isArray(j?.data) ? j.data[0] : j?.data;
  return d ?? null;
}

async function getDepth(symbol){
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/merge-depth?symbol=${symbol}&limit=20&productType=usdt-futures`
  );
  return (j?.data?.bids && j.data.asks) ? j.data : null;
}

async function fetchAllTickers(){
  const j = await safeGetJson(
    "https://api.bitget.com/api/v2/mix/market/tickers?productType=usdt-futures"
  );
  return j?.data ?? [];
}

// ========= BTC TREND =========

async function getBTCTrend(){
  const c = await getCandles("BTCUSDT","1H",5);
  if (!c.length) return null;
  const last = c[c.length-1];
  return ((last.c - last.o)/last.o)*100;
}

// ========= LISTE DEGEN =========

async function updateDegenList(){
  try {
    const all = await fetchAllTickers();
    if (!all.length) return FALLBACK_LOWCAPS;

    const discovery = getDiscoveryList();

    let valid = all.filter(t =>
      t.symbol.includes("USDT") &&
      +t.usdtVolume > 3_000_000 &&
      !IGNORE_LIST.includes(t.symbol)
    );

    valid.sort((a,b)=>(+b.usdtVolume) - (+a.usdtVolume));

    let lowcaps = valid.map(t=>t.symbol);

    lowcaps = lowcaps.filter(sym =>
      !top30.includes(sym) &&
      !discovery.includes(sym)
    );

    lowcaps = lowcaps.slice(0,30);

    console.log(`🔄 DEGEN list updated: ${lowcaps.length} paires.`);
    return lowcaps.length >= 5 ? lowcaps : FALLBACK_LOWCAPS;

  } catch {
    return FALLBACK_LOWCAPS;
  }
}

// ========= INDICATEURS =========

function rsi(values, p=14){
  if (!values || values.length < p+1) return null;

  let g=0,l=0;
  for (let i=1;i<=p;i++){
    const d = values[i]-values[i-1];
    if (d>=0) g+=d; else l-=d;
  }
  g/=p; l=(l/p)||1e-9;

  let rs = g/l;
  let rsiVal = 100-100/(1+rs);

  for (let i=p+1;i<values.length;i++){
    const d = values[i]-values[i-1];
    g = (g*(p-1)+Math.max(d,0))/p;
    l = ((l*(p-1)+Math.max(-d,0))/p)||1e-9;
    rs = g/l;
    rsiVal = 100-100/(1+rs);
  }

  return rsiVal;
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
  if (!c) return {upper:0,lower:0};
  const top = Math.max(c.o,c.c);
  const bot = Math.min(c.o,c.c);
  return {
    upper: ((c.h-top)/c.c)*100,
    lower: ((bot-c.l)/c.c)*100
  };
}

// ========= PROCESS PAIRE =========

async function processDegen(symbol){
  const [tk, , depth] = await Promise.all([
    getTicker(symbol),
    getFunding(symbol),
    getDepth(symbol)
  ]);

  if (!tk) return null;

  const last = +tk.last;
  const high24 = +tk.high24h;
  const low24  = +tk.low24h;
  const volaPct = ((high24-low24)/last)*100;

  const [c5m,c15m] = await Promise.all([
    getCandles(symbol,"5m",100),
    getCandles(symbol,"15m",100)
  ]);

  if (!c5m?.length || !c15m?.length) return null;

  const closes5  = c5m.map(x=>x.c);
  const closes15 = c15m.map(x=>x.c);

  const rsi5  = rsi(closes5);
  const rsi15 = rsi(closes15);

  const vwap5 = vwap(c5m.slice(-24));
  const priceVsVwap = vwap5 ? ((last-vwap5)/vwap5)*100 : 0;

  const ck = c5m[c5m.length-1];
  const wicks = calcWicks(ck);

  const lastVol = ck.v;
  const avgVol = c5m.slice(-11,-1).reduce((a,b)=>a+b.v,0)/10;
  const volRatio = lastVol/avgVol;

  let obScore=0,bv=0,av=0;
  if (depth){
    bv = depth.bids.slice(0,10).reduce((a,x)=>a+(+x[1]),0);
    av = depth.asks.slice(0,10).reduce((a,x)=>a+(+x[1]),0);
    if (av>0){
      const r = bv/av;
      if (r>1.25) obScore=1;
      else if (r<0.75) obScore=-1;
    }
  }

  return {
    symbol,last,volaPct,rsi5,rsi15,
    priceVsVwap,volRatio,
    obScore,bidsVol:bv,asksVol:av,wicks,
    change24: tk.priceChangePercent? (+tk.priceChangePercent)*100 : 0
  };
}

// ========= ANALYZE CANDIDATE =========

function analyzeCandidate(rec, btc){
  if (!rec || btc==null) return null;

  const gapAbs = Math.abs(rec.priceVsVwap);

  if (rec.volRatio < 3.5) return null;
  if (rec.volaPct < 4 || rec.volaPct > 25) return null;
  if (gapAbs < 1.0 || gapAbs > 3.5) return null;

  if (Math.abs(btc) < BTC_TREND_ABS_MIN || Math.abs(btc) > BTC_TREND_ABS_MAX) return null;

  let direction = rec.priceVsVwap > 0 ? "LONG" : "SHORT";

  const r5 = rec.rsi5;
  const r15 = rec.rsi15;

  const wU = rec.wicks.upper;
  const wL = rec.wicks.lower;

  const ob = rec.obScore;

  if (direction==="LONG"){
    if (btc < BTC_LONG_MIN || btc > BTC_LONG_MAX) return null;
    if (r5 < 50 || r5 > 75) return null;
    if (r15 < 45 || r15 > 70) return null;
    if (wU > 1.2) return null;
    if (ob < 0) return null;
  } else {
    if (btc > BTC_SHORT_MAX || btc < BTC_SHORT_MIN) return null;
    if (r5 < 25 || r5 > 50) return null;
    if (r15 < 30 || r15 > 55) return null;
    if (wL > 1.2) return null;
    if (ob > 0) return null;
  }

  let score = 0;

  score += clamp(10 + (rec.volRatio - 3.5) * 8,0,30);

  let scoreGap = 5;
  if (gapAbs>=1.2 && gapAbs<=2.4) scoreGap = 20;
  else if (gapAbs>2.4 && gapAbs<=3.5) scoreGap = 12;
  score += scoreGap;

  let scoreRsi = 0;
  if (direction==="LONG"){
    if (r5>=55 && r5<=70 && r15>=50 && r15<=65) scoreRsi=15;
    else if (r5>50 && r15>45) scoreRsi=7;
  } else {
    if (r5>=30 && r5<=45 && r15>=35 && r15<=50) scoreRsi=15;
    else if (r5<50 && r15<55) scoreRsi=7;
  }
  score += scoreRsi;

  const obRatio = rec.asksVol>0 ? rec.bidsVol/rec.asksVol : 1;
  if (direction==="LONG"){
    if (ob===1 && obRatio>=1.3) score+=15;
    else if (ob===1) score+=8;
  } else {
    if (ob===-1 && obRatio<=0.77) score+=15;
    else if (ob===-1) score+=8;
  }

  const ch24 = rec.change24;
  if (direction==="LONG"){
    if (ch24>8) score+=10;
    else if (ch24>4) score+=6;
  } else {
    if (ch24<-8) score+=10;
    else if (ch24<-4) score+=6;
  }

  if (direction==="LONG"){
    if (btc>=0.5 && btc<=1.8) score+=10;
    else if (btc>=0.2 && btc<=2.0) score+=6;
  } else {
    if (btc<=-0.5 && btc>=-1.8) score+=10;
    else if (btc<=-0.2 && btc>=-2.0) score+=6;
  }

  if (direction==="LONG"){
    if (wU<0.6) score+=5;
    else if (wU>1.0) score-=5;
  } else {
    if (wL<0.6) score+=5;
    else if (wL>1.0) score-=5;
  }

  score = clamp(Math.round(score),0,100);
  if (score<88) return null;

  return {
    symbol:rec.symbol,
    direction,
    score,
    volRatio:rec.volRatio,
    vola:rec.volaPct,
    priceVsVwap:rec.priceVsVwap,
    last:rec.last
  };
}

// ========= TELEGRAM =========

async function sendTelegram(text){
  if(!TELEGRAM_BOT_TOKEN||!TELEGRAM_CHAT_ID) return;
  try{
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,{
      method:"POST",
      headers: {"Content-Type":"application/json"},
      body:JSON.stringify({ chat_id:TELEGRAM_CHAT_ID, text, parse_mode:"Markdown" })
    });
  } catch(e){
    console.error("Telegram error:",e.message);
  }
}

function antiSpam(symbol,dir){
  const key = `${symbol}-${dir}`;
  const now = Date.now();
  const last = lastAlerts.get(key);
  if (last && now-last < MIN_ALERT_DELAY_MS) return false;
  lastAlerts.set(key,now);
  return true;
}

// ========= MAIN SCAN =========

async function scanDegen(){
  const now = Date.now();

  if (now-lastSymbolUpdate > SYMBOL_UPDATE_INTERVAL || !DEGEN_SYMBOLS.length){
    DEGEN_SYMBOLS = await updateDegenList();
    lastSymbolUpdate = now;
  }

  const btc = await getBTCTrend();
  if (btc==null){
    console.log("⚠ BTC Trend unavailable");
    return;
  }

  console.log(`🔫 DEGEN v1.2 | BTC: ${btc.toFixed(2)}% | ${DEGEN_SYMBOLS.length} pairs`);

  const candidates = [];
  const BATCH = 5;

  for (let i=0;i<DEGEN_SYMBOLS.length;i+=BATCH){
    const batch = DEGEN_SYMBOLS.slice(i,i+BATCH);
    const results = await Promise.all(batch.map(s=>processDegen(s)));
    for (const r of results){
      const sig = analyzeCandidate(r,btc);
      if (sig) candidates.push(sig);
    }
    await sleep(300);
  }

  if (!candidates.length){
    console.log("ℹ Aucun signal DEGEN.");
    return;
  }

  const best = candidates.sort((a,b) =>
    b.score !== a.score ? b.score-a.score :
    (+b.volRatio) - (+a.volRatio)
  )[0];

  if (now-lastGlobalTradeTime < GLOBAL_COOLDOWN_MS){
    console.log(`⏳ Cooldown — ignored ${best.symbol}`);
    return;
  }

  if (!antiSpam(best.symbol,best.direction)){
    console.log(`⏳ AntiSpam — ignored ${best.symbol}`);
    return;
  }

  const emoji = best.direction==="LONG" ? "🟢🔫" : "🔴🔫";

  const msg =
`🎯 *DEGEN v1.2 (API v2 FIXED)*

${emoji} *${best.symbol}* — ${best.direction}
🏅 Score: ${best.score}/100

📊 Vol Spike: x${num(best.volRatio,2)}
🌡️ Vola24: ${num(best.vola,2)}%
📉 ΔVWAP: ${num(best.priceVsVwap,2)}%

💰 Prix: ${best.last}

_Wait for limit. No FOMO._`;

  await sendTelegram(msg);

  lastGlobalTradeTime = now;
  console.log(`✅ SHOT SENT: ${best.symbol} (${best.score})`);
}

// ========= MAIN LOOP =========

async function main(){
  console.log("🔫 JTF DEGEN v1.2 — démarré.");
  await sendTelegram("🔫 *JTF DEGEN v1.2 (API v2)* activé.");
  while(true){
    try{ await scanDegen(); }
    catch(e){ console.error("DEGEN crash:",e); }
    await sleep(SCAN_INTERVAL_MS);
  }
}

export const startDegen = main;