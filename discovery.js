// discovery.js — JTF DISCOVERY v0.1 (Mid-Caps)
// Cible : Rank 31-80 | Stratégie : Momentum & Breakout

import fetch from "node-fetch";

// ========= CONFIG =========

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

// Scan toutes les 5 minutes
const SCAN_INTERVAL_MS   = 5 * 60_000;

// Anti-spam plus long (10 min)
const MIN_ALERT_DELAY_MS = 10 * 60_000;

// Liste dynamique
let DISCOVERY_SYMBOLS = [];
let lastSymbolUpdate = 0;
const SYMBOL_UPDATE_INTERVAL = 60 * 60_000;

// Fallback MidCaps
const FALLBACK_MIDCAPS = [
  "INJUSDT_UMCBL","RNDRUSDT_UMCBL","FETUSDT_UMCBL","AGIXUSDT_UMCBL",
  "ARBUSDT_UMCBL","OPUSDT_UMCBL","LDOUSDT_UMCBL","FILUSDT_UMCBL",
  "STXUSDT_UMCBL","IMXUSDT_UMCBL","SNXUSDT_UMCBL","FXSUSDT_UMCBL"
];

// Mémoire
const prevVolume = new Map();
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
      (+t.usdtVolume > 5000000) 
    );

    valid.sort((a,b) => (+b.usdtVolume) - (+a.usdtVolume));
    // On prend du rang 31 au rang 80
    const midCaps = valid.slice(30, 80).map(t => t.symbol);

    console.log(`🔄 Discovery List mise à jour : ${midCaps.length} paires.`);
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

// ========= ANALYSE =========

async function processDiscovery(symbol) {
  const [tk, fr] = await Promise.all([getTicker(symbol), getFunding(symbol)]);
  if(!tk) return null;

  const last = +tk.last;
  const [c15m, c1h] = await Promise.all([getCandles(symbol, 900, 100), getCandles(symbol, 3600, 100)]);
  if(c15m.length < 50 || c1h.length < 50) return null;

  const closes15 = c15m.map(x=>x.c); const closes1h = c1h.map(x=>x.c);
  const rsi15 = rsi(closes15, 14); const rsi1h = rsi(closes1h, 14);
  const vwap15 = vwap(c15m.slice(-24));
  const priceVsVwap = vwap15 ? ((last - vwap15)/vwap15)*100 : 0;

  const lastVol = c15m[c15m.length-1].v;
  const avgVol  = c15m.slice(-11, -1).reduce((a,b)=>a+b.v, 0) / 10;
  const volRatio = avgVol > 0 ? lastVol / avgVol : 1;

  const high24 = +tk.high24h; const low24 = +tk.low24h;
  const volaPct = (high24 - low24) / last * 100;
  const change24 = (+tk.priceChangePercent) * 100;

  return { symbol, last, volaPct, rsi15, rsi1h, priceVsVwap, volRatio, change24, funding: fr ? +fr.fundingRate * 100 : 0 };
}

function analyzeCandidate(rec) {
  if(!rec || !rec.rsi15 || !rec.rsi1h || rec.volaPct < 3) return null;
  let direction = null, score = 0, reason = "";

  // LONG
  if (rec.priceVsVwap > 0.5 && rec.rsi1h > 55 && rec.rsi15 > 50) {
    let s = 50;
    if (rec.volRatio > 2.0) s += 20; else if (rec.volRatio > 1.5) s += 10;
    // On ajoute "rec.volRatio < 1.0" pour filtrer tout ce qui n'a pas de volume
if(!rec || !rec.rsi15 || !rec.rsi1h || rec.volaPct < 3 || rec.volRatio < 1.0) return null;
if (rec.change24 > 5) s += 10;
    if (s >= 70) { direction = "LONG"; score = s; reason = `Vol x${rec.volRatio.toFixed(1)} | RSI Bull`; }
  }
  // SHORT
  else if (rec.priceVsVwap < -0.5 && rec.rsi1h < 45 && rec.rsi15 < 50) {
    let s = 50;
    if (rec.volRatio > 2.0) s += 15; else if (rec.volRatio > 1.5) s += 10;
    if (rec.rsi15 < 40 && rec.rsi15 > 20) s += 10;
    if (rec.change24 < -5) s += 10;
    if (s >= 70) { direction = "SHORT"; score = s; reason = `Vol x${rec.volRatio.toFixed(1)} | RSI Bear`; }
  }

  if (!direction) return null;

  const riskMult = 2.0;
  const slDist = (rec.volaPct / 5) * riskMult;
  const riskPct = clamp(slDist, 1.5, 8.0);
  const sl = direction === "LONG" ? rec.last * (1 - riskPct/100) : rec.last * (1 + riskPct/100);
  const tp = direction === "LONG" ? rec.last * (1 + (riskPct * 2.5)/100) : rec.last * (1 - (riskPct * 2.5)/100);

  return { symbol: rec.symbol, direction, score, reason, price: rec.last, sl: num(sl, rec.last<1?5:3), tp: num(tp, rec.last<1?5:3), riskPct: num(riskPct, 2), volRatio: num(rec.volRatio, 1), vola: num(rec.volaPct, 1) };
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

// ========= SCAN ENGINE =========

async function scanDiscovery(){
  const now = Date.now();
  if(now - lastSymbolUpdate > SYMBOL_UPDATE_INTERVAL || DISCOVERY_SYMBOLS.length === 0){
    DISCOVERY_SYMBOLS = await updateDiscoveryList(); lastSymbolUpdate = now;
  }
  console.log(`🚀 Discovery Scan sur ${DISCOVERY_SYMBOLS.length} Mid-Caps...`);
  const BATCH_SIZE = 5; const candidates = [];
  for(let i=0; i<DISCOVERY_SYMBOLS.length; i+=BATCH_SIZE){
    const batch = DISCOVERY_SYMBOLS.slice(i, i+BATCH_SIZE);
    const results = await Promise.all(batch.map(s => processDiscovery(s).catch(e=>null)));
    for(const r of results){ const signal = analyzeCandidate(r); if(signal) candidates.push(signal); }
    await sleep(500);
  }
  const best = candidates.sort((a,b) => b.score - a.score).slice(0, 2);
  for(const c of best){
    if(!checkAntiSpam(c.symbol, c.direction)) continue;
    const emoji = c.direction === "LONG" ? "🚀" : "🪂";
    const msg = `⚡ *JTF DISCOVERY (Mid-Caps)* ⚡\n\n${emoji} *${c.symbol}* — ${c.direction}\n📊 Score: ${c.score}/100\n💡 Raison: _${c.reason}_\n\n🔹 Entry: ${c.price}\n🛑 SL: ${c.sl} (-${c.riskPct}%)\n🎯 TP: ${c.tp}\n\n🌪️ Vola: ${c.vola}%\n📢 Volume: x${c.volRatio}\n\n_Levier faible (2x max)_`;
    await sendTelegram(msg); console.log(`✅ Signal envoyé: ${c.symbol}`);
  }
}

async function main(){
  console.log("🔥 JTF DISCOVERY v0.1 démarré.");
  await sendTelegram("🔥 *JTF DISCOVERY (Mid-Caps) connecté.*");
  while(true){ try { await scanDiscovery(); } catch(e) { console.error("Loop Error:", e.message); } await sleep(SCAN_INTERVAL_MS); }
}

// EXPORT pour le Chef d'Orchestre
export const startDiscovery = main;
