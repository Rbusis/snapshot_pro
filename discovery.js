// discovery.js — JTF DISCOVERY v0.5 (Elite Mode)
// Cible : Mid-Caps (Top 50 hors autoselect).
// Stratégie : Momentum 5m + Order Book.
// FILTRES STRICTS : Score >= 80 | Volume >= x1.5

import fetch from "node-fetch";

// ========= CONFIG =========

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

const SCAN_INTERVAL_MS   = 5 * 60_000;   // Scan toutes les 5 min
const MIN_ALERT_DELAY_MS = 15 * 60_000;  // Anti-spam 15 min

let DISCOVERY_SYMBOLS = [];
let lastSymbolUpdate = 0;
const SYMBOL_UPDATE_INTERVAL = 60 * 60_000;

const FALLBACK_MIDCAPS = [
  "INJUSDT_UMCBL","RNDRUSDT_UMCBL","FETUSDT_UMCBL","AGIXUSDT_UMCBL",
  "ARBUSDT_UMCBL","OPUSDT_UMCBL","LDOUSDT_UMCBL","FILUSDT_UMCBL",
  "STXUSDT_UMCBL","IMXUSDT_UMCBL","SNXUSDT_UMCBL","FXSUSDT_UMCBL"
];

// Liste des cryptos gérées par le Bot 1 (Autoselect) pour éviter les doublons
const IGNORE_LIST = [
  "BTCUSDT_UMCBL","ETHUSDT_UMCBL","BNBUSDT_UMCBL","SOLUSDT_UMCBL","XRPUSDT_UMCBL",
  "ADAUSDT_UMCBL","DOGEUSDT_UMCBL","AVAXUSDT_UMCBL","DOTUSDT_UMCBL","TRXUSDT_UMCBL",
  "LINKUSDT_UMCBL","TONUSDT_UMCBL","SUIUSDT_UMCBL","APTUSDT_UMCBL","NEARUSDT_UMCBL",
  "ARBUSDT_UMCBL","OPUSDT_UMCBL","INJUSDT_UMCBL","ATOMUSDT_UMCBL","AAVEUSDT_UMCBL",
  "LTCUSDT_UMCBL","UNIUSDT_UMCBL","FILUSDT_UMCBL","XLMUSDT_UMCBL","RUNEUSDT_UMCBL",
  "ALGOUSDT_UMCBL","PEPEUSDT_UMCBL","WIFUSDT_UMCBL","TIAUSDT_UMCBL","SEIUSDT_UMCBL"
];

const lastAlerts = new Map();

// Utils
const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const num   = (v,d=4)=>v==null?null:+(+v).toFixed(d);
const clamp = (x,min,max)=>Math.max(min,Math.min(max,x));
const baseSymbol = s => s.replace("_UMCBL","");

async function safeGetJson(url){
  try{
    const r = await fetch(url,{ headers:{ Accept:"application/json" } });
    if(!r.ok) return null;
    return await r.json();
  }catch{ return null; }
}

// ========= LISTE DYNAMIQUE =========

async function updateDiscoveryList() {
  try {
    const url = "https://api.bitget.com/api/mix/v1/market/tickers?productType=umcbl";
    const j = await safeGetJson(url);
    if (!j || !j.data) return FALLBACK_MIDCAPS;

    const valid = j.data.filter(t => 
      t.symbol.endsWith("_UMCBL") && 
      !t.symbol.startsWith("USDC") &&
      (+t.usdtVolume > 5000000) &&
      !IGNORE_LIST.includes(t.symbol)
    );

    valid.sort((a,b) => (+b.usdtVolume) - (+a.usdtVolume));
    const midCaps = valid.slice(0, 50).map(t => t.symbol);

    console.log(`🔄 Discovery List (Elite): ${midCaps.length} paires.`);
    return midCaps.length > 5 ? midCaps : FALLBACK_MIDCAPS;

  } catch (e) {
    console.error("❌ Erreur Update List:", e.message);
    return FALLBACK_MIDCAPS;
  }
}

// ========= API DATA =========

async function getTicker(symbol){
  const j = await safeGetJson(`https://api.bitget.com/api/mix/v1/market/ticker?symbol=${symbol}`);
  return j?.data ?? null;
}
async function getCandles(symbol, seconds, limit=100){
  const base = baseSymbol(symbol);
  const j = await safeGetJson(`https://api.bitget.com/api/v2/mix/market/candles?symbol=${base}&granularity=${seconds}&productType=usdt-futures&limit=${limit}`);
  if(j?.data?.length){
    return j.data.map(c=>({ t:+c[0],o:+c[1],h:+c[2],l:+c[3],c:+c[4],v:+c[5] })).sort((a,b)=>a.t-b.t);
  }
  return [];
}
async function getFunding(symbol){
  const j = await safeGetJson(`https://api.bitget.com/api/mix/v1/market/currentFundRate?symbol=${symbol}`);
  return j?.data ?? null;
}
async function getDepth(symbol){
  const j = await safeGetJson(`https://api.bitget.com/api/mix/v1/market/depth?symbol=${symbol}&limit=20`);
  if(j?.data?.bids && j?.data?.asks) return j.data;
  return null;
}

// ========= INDICATEURS =========

function rsi(closes,p=14){
  if(closes.length<p+1) return null;
  let g=0,l=0;
  for(let i=1;i<=p;i++){ const d=closes[i]-closes[i-1]; if(d>=0) g+=d; else l-=d; }
  g/=p; l=(l/p)||1e-9;
  let rs=g/l; let val=100-100/(1+rs);
  for(let i=p+1;i<closes.length;i++){
    const d=closes[i]-closes[i-1]; const G=Math.max(d,0), L=Math.max(-d,0);
    g=(g*(p-1)+G)/p; l=((l*(p-1)+L)/p)||1e-9; rs=g/l; val=100-100/(1+rs);
  }
  return val;
}
function vwap(c){
  let pv=0,v=0; for(const x of c){ const p=(x.h+x.l+x.c)/3; pv+=p*x.v; v+=x.v; }
  return v?pv/v:null;
}

// ========= ANALYSE TECHNIQUE =========

async function processDiscovery(symbol) {
  const [tk, fr, depth] = await Promise.all([
    getTicker(symbol), 
    getFunding(symbol),
    getDepth(symbol)
  ]);
  if(!tk) return null;

  const last = +tk.last;
  const [c5m, c15m] = await Promise.all([getCandles(symbol, 300, 100), getCandles(symbol, 900, 100)]);
  if(c5m.length < 50 || c15m.length < 50) return null;

  const closes5  = c5m.map(x=>x.c); 
  const closes15 = c15m.map(x=>x.c);
  
  const rsi5  = rsi(closes5, 14); 
  const rsi15 = rsi(closes15, 14);
  const vwap5 = vwap(c5m.slice(-24));
  const priceVsVwap = vwap5 ? ((last - vwap5)/vwap5)*100 : 0;

  const lastVol = c5m[c5m.length-1].v;
  const avgVol  = c5m.slice(-11, -1).reduce((a,b)=>a+b.v, 0) / 10;
  const volRatio = avgVol > 0 ? lastVol / avgVol : 1;

  const high24 = +tk.high24h; const low24 = +tk.low24h;
  const volaPct = (high24 - low24) / last * 100;
  const change24 = (+tk.priceChangePercent) * 100;

  let obScore = 0; let bidsVol = 0; let asksVol = 0;

  if (depth && depth.bids && depth.asks) {
    bidsVol = depth.bids.slice(0, 10).reduce((acc, x) => acc + (+x[1]), 0);
    asksVol = depth.asks.slice(0, 10).reduce((acc, x) => acc + (+x[1]), 0);
    if (asksVol > 0) {
      const ratio = bidsVol / asksVol;
      if (ratio > 1.2) obScore = 1; else if (ratio < 0.8) obScore = -1;
    }
  }

  return { symbol, last, volaPct, rsi5, rsi15, priceVsVwap, volRatio, change24, funding: fr ? +fr.fundingRate * 100 : 0, obScore, bidsVol, asksVol };
}

// ========= LOGIQUE SIGNAL (ELITE) =========

function analyzeCandidate(rec) {
  // FILTRE 1 : Volume x1.5 MINIMUM
  if(!rec || !rec.rsi5 || !rec.rsi15 || rec.volaPct < 3 || rec.volRatio < 1.5) return null;
  
  // Anti-FOMO
  if (rec.rsi5 > 82) return null; 
  if (rec.rsi5 < 18) return null;
  if (Math.abs(rec.priceVsVwap) > 4.0) return null;

  let direction = null, score = 0, reason = "";

  // LONG
  if (rec.priceVsVwap > 0.3 && rec.rsi15 > 50 && rec.rsi5 > 55 && rec.rsi5 < 80) {
    if (rec.obScore >= 0) {
        let s = 50;
        if (rec.volRatio > 2.0) s += 20; else if (rec.volRatio > 1.5) s += 10;
        if (rec.rsi5 > 60) s += 10;
        if (rec.change24 > 3) s += 10; 
        if (rec.obScore === 1) s += 10;

        // FILTRE 2 : SCORE >= 80 (Exigeant)
        if (s >= 80) { 
            direction = "LONG"; 
            score = s; 
            reason = `Vol x${rec.volRatio.toFixed(1)} | OrderBook Bullish`; 
        }
    }
  }
  
  // SHORT
  else if (rec.priceVsVwap < -0.3 && rec.rsi15 < 50 && rec.rsi5 < 45 && rec.rsi5 > 20) {
    if (rec.obScore <= 0) {
        let s = 50;
        if (rec.volRatio > 2.0) s += 20; else if (rec.volRatio > 1.5) s += 10;
        if (rec.rsi5 < 40) s += 10;
        if (rec.change24 < -3) s += 10;
        if (rec.obScore === -1) s += 10;
        
        // FILTRE 2 : SCORE >= 80 (Exigeant)
        if (s >= 80) { 
            direction = "SHORT"; 
            score = s; 
            reason = `Vol x${rec.volRatio.toFixed(1)} | OrderBook Bearish`; 
        }
    }
  }

  if (!direction) return null;

  // Money Management
  const riskMult = 1.8; 
  const slDist = (rec.volaPct / 5) * riskMult;
  const riskPct = clamp(slDist, 1.2, 6.0);
  
  const sl = direction === "LONG" ? rec.last * (1 - riskPct/100) : rec.last * (1 + riskPct/100);
  const tp = direction === "LONG" ? rec.last * (1 + (riskPct * 2.5)/100) : rec.last * (1 - (riskPct * 2.5)/100);
  const obRatio = rec.asksVol > 0 ? (rec.bidsVol / rec.asksVol).toFixed(2) : "N/A";

  return { 
    symbol: rec.symbol, direction, score, reason, 
    price: rec.last, sl: num(sl, rec.last<1?5:3), tp: num(tp, rec.last<1?5:3), 
    riskPct: num(riskPct, 2), volRatio: num(rec.volRatio, 1), vola: num(rec.volaPct, 1),
    obRatio
  };
}

// ========= TELEGRAM =========

async function sendTelegram(text){
  if(!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try{ await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,{ method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" }) }); }catch(e){}
}
function checkAntiSpam(symbol, direction){
  const key = `${symbol}-${direction}`; const now = Date.now(); const last = lastAlerts.get(key);
  if(last && (now - last < MIN_ALERT_DELAY_MS)) return false;
  lastAlerts.set(key, now); return true;
}

// ========= MOTEUR PRINCIPAL =========

async function scanDiscovery(){
  const now = Date.now();
  if(now - lastSymbolUpdate > SYMBOL_UPDATE_INTERVAL || DISCOVERY_SYMBOLS.length === 0){
    DISCOVERY_SYMBOLS = await updateDiscoveryList(); lastSymbolUpdate = now;
  }
  
  console.log(`🚀 Discovery Elite Scan sur ${DISCOVERY_SYMBOLS.length} Mid-Caps...`);
  
  const BATCH_SIZE = 5; 
  const candidates = [];
  
  for(let i=0; i<DISCOVERY_SYMBOLS.length; i+=BATCH_SIZE){
    const batch = DISCOVERY_SYMBOLS.slice(i, i+BATCH_SIZE);
    const results = await Promise.all(batch.map(s => processDiscovery(s).catch(e=>null)));
    
    for(const r of results){ 
      const signal = analyzeCandidate(r); 
      if(signal) candidates.push(signal); 
    }
    await sleep(400); 
  }
  
  const best = candidates.sort((a,b) => b.score - a.score).slice(0, 2);
  
  for(const c of best){
    if(!checkAntiSpam(c.symbol, c.direction)) continue;
    
    const emoji = c.direction === "LONG" ? "🚀" : "🪂";
    
    let footer = "_Mode Elite (80+) : Forte Probabilité_";
    if (c.volRatio >= 2.5) footer = "🔥 VOLUME EXPLOSIF : Setup Majeur !";

    const msg = `⚡ *JTF DISCOVERY (Elite)* ⚡\n\n${emoji} *${c.symbol}* — ${c.direction}\n📊 Score: ${c.score}/100\n💡 Raison: _${c.reason}_\n\n🔹 Entry: ${c.price}\n🛑 SL: ${c.sl} (-${c.riskPct}%)\n🎯 TP: ${c.tp}\n\n⚖️ *OB Ratio:* ${c.obRatio}\n📢 Volume: x${c.volRatio}\n\n${footer}`;
    
    await sendTelegram(msg); 
    console.log(`✅ Signal Elite envoyé: ${c.symbol}`);
  }
}

async function main(){
  console.log("🔥 JTF DISCOVERY v0.5 (Elite) démarré.");
  await sendTelegram("🔥 *JTF DISCOVERY (Mode Élite 80+) activé.*");
  while(true){ 
    try { await scanDiscovery(); } 
    catch(e) { console.error("Discovery Loop Error:", e.message); } 
    await sleep(SCAN_INTERVAL_MS); 
  }
}

export const startDiscovery = main;
