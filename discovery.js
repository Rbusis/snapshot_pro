// discovery.js — JTF DISCOVERY v0.9 (Fail-Safe Fix)
// CORRECTIF CRITIQUE : Si BTC est illisible, le scan s'arrête (Pas de trade à l'aveugle).

import fetch from "node-fetch";

// ========= CONFIG =========
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const SCAN_INTERVAL_MS   = 5 * 60_000;
const MIN_ALERT_DELAY_MS = 15 * 60_000;
const BTC_DUMP_THRESHOLD = -0.3; 
const SYMBOL_UPDATE_INTERVAL = 60 * 60_000;

let DISCOVERY_SYMBOLS = [];
let lastSymbolUpdate = 0;
const lastAlerts = new Map();

const FALLBACK_MIDCAPS = ["INJUSDT_UMCBL","RNDRUSDT_UMCBL","FETUSDT_UMCBL","AGIXUSDT_UMCBL","ARBUSDT_UMCBL"];
const IGNORE_LIST = ["BTCUSDT_UMCBL","ETHUSDT_UMCBL","BNBUSDT_UMCBL","SOLUSDT_UMCBL","XRPUSDT_UMCBL","ADAUSDT_UMCBL","DOGEUSDT_UMCBL","AVAXUSDT_UMCBL","DOTUSDT_UMCBL","TRXUSDT_UMCBL","LINKUSDT_UMCBL","TONUSDT_UMCBL","SUIUSDT_UMCBL","APTUSDT_UMCBL","NEARUSDT_UMCBL","ARBUSDT_UMCBL","OPUSDT_UMCBL","INJUSDT_UMCBL","ATOMUSDT_UMCBL","AAVEUSDT_UMCBL","LTCUSDT_UMCBL","UNIUSDT_UMCBL","FILUSDT_UMCBL","XLMUSDT_UMCBL","RUNEUSDT_UMCBL","ALGOUSDT_UMCBL","PEPEUSDT_UMCBL","WIFUSDT_UMCBL","TIAUSDT_UMCBL","SEIUSDT_UMCBL"];

const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const num   = (v,d=4)=>v==null?null:+(+v).toFixed(d);
const clamp = (x,min,max)=>Math.max(min,Math.min(max,x));
const baseSymbol = s => s.replace("_UMCBL","");

async function safeGetJson(url){
  try{ const r = await fetch(url,{ headers:{ Accept:"application/json" } }); return r.ok ? await r.json() : null; }catch{ return null; }
}

async function getBTCTrend() {
  try {
    // On utilise v2 pour plus de fiabilité si possible, sinon v1
    const j = await safeGetJson(`https://api.bitget.com/api/mix/v1/market/candles?symbol=BTCUSDT_UMCBL&granularity=3600&limit=5`);
    if(!j?.data || j.data.length < 2) return null;
    // data: [timestamp, open, high, low, close, vol]
    const current = j.data[j.data.length - 1]; 
    const open = +current[1];
    const close = +current[4];
    if(!open) return 0;
    return ((close - open) / open) * 100;
  } catch { return null; }
}

async function updateDiscoveryList() {
  try {
    const j = await safeGetJson("https://api.bitget.com/api/mix/v1/market/tickers?productType=umcbl");
    if (!j?.data) return FALLBACK_MIDCAPS;
    const valid = j.data.filter(t => t.symbol.endsWith("_UMCBL") && !t.symbol.startsWith("USDC") && (+t.usdtVolume > 5000000) && !IGNORE_LIST.includes(t.symbol));
    valid.sort((a,b) => (+b.usdtVolume) - (+a.usdtVolume));
    const midCaps = valid.slice(0, 50).map(t => t.symbol);
    console.log(`🔄 Discovery List: ${midCaps.length} paires.`);
    return midCaps.length > 5 ? midCaps : FALLBACK_MIDCAPS;
  } catch { return FALLBACK_MIDCAPS; }
}

async function getTicker(symbol){ const j = await safeGetJson(`https://api.bitget.com/api/mix/v1/market/ticker?symbol=${symbol}`); return j?.data ?? null; }
async function getCandles(symbol, s, l=100){ const b = baseSymbol(symbol); const j = await safeGetJson(`https://api.bitget.com/api/v2/mix/market/candles?symbol=${b}&granularity=${s}&productType=usdt-futures&limit=${l}`); return j?.data?.map(c=>({t:+c[0],o:+c[1],h:+c[2],l:+c[3],c:+c[4],v:+c[5]})).sort((a,b)=>a.t-b.t)??[]; }
async function getFunding(symbol){ const j = await safeGetJson(`https://api.bitget.com/api/mix/v1/market/currentFundRate?symbol=${symbol}`); return j?.data ?? null; }
async function getDepth(symbol){ const j = await safeGetJson(`https://api.bitget.com/api/mix/v1/market/depth?symbol=${symbol}&limit=20`); return (j?.data?.bids && j?.data?.asks) ? j.data : null; }

function rsi(c,p=14){ if(c.length<p+1) return null; let g=0,l=0; for(let i=1;i<=p;i++){ const d=c[i]-c[i-1]; d>=0?g+=d:l-=d; } g/=p; l=(l/p)||1e-9; let rs=g/l; let v=100-100/(1+rs); for(let i=p+1;i<c.length;i++){ const d=c[i]-c[i-1]; g=(g*(p-1)+Math.max(d,0))/p; l=((l*(p-1)+Math.max(-d,0))/p)||1e-9; rs=g/l; v=100-100/(1+rs); } return v; }
function vwap(c){ let pv=0,v=0; for(const x of c){ const p=(x.h+x.l+x.c)/3; pv+=p*x.v; v+=x.v; } return v?pv/v:null; }

async function processDiscovery(symbol) {
  const [tk, fr, depth] = await Promise.all([getTicker(symbol), getFunding(symbol), getDepth(symbol)]);
  if(!tk) return null;
  const last=+tk.last; 
  const [c5m, c15m] = await Promise.all([getCandles(symbol, 300), getCandles(symbol, 900)]);
  if(c5m.length < 50) return null;

  const closes5=c5m.map(x=>x.c); const closes15=c15m.map(x=>x.c);
  const rsi5=rsi(closes5,14); const rsi15=rsi(closes15,14);
  const vwap5=vwap(c5m.slice(-24));
  const priceVsVwap=vwap5?((last-vwap5)/vwap5)*100:0;
  
  const lastVol=c5m[c5m.length-1].v; const avgVol=c5m.slice(-11,-1).reduce((a,b)=>a+b.v,0)/10;
  const volRatio=avgVol>0?lastVol/avgVol:1;
  const volaPct=(+tk.high24h - +tk.low24h)/last*100;
  
  let obScore=0, bidsVol=0, asksVol=0;
  if (depth) {
    bidsVol=depth.bids.slice(0,10).reduce((a,x)=>a+(+x[1]),0);
    asksVol=depth.asks.slice(0,10).reduce((a,x)=>a+(+x[1]),0);
    if(asksVol>0){ const r=bidsVol/asksVol; if(r>1.2) obScore=1; else if(r<0.8) obScore=-1; }
  }

  return { symbol, last, volaPct, rsi5, rsi15, priceVsVwap, volRatio, change24:(+tk.priceChangePercent)*100, obScore, bidsVol, asksVol };
}

function analyzeCandidate(rec, btcChange) {
  if(!rec || !rec.rsi5 || !rec.rsi15 || rec.volaPct < 3 || rec.volRatio < 1.5) return null;
  if (rec.rsi5 > 82 || rec.rsi5 < 18 || Math.abs(rec.priceVsVwap) > 4.0) return null;

  let direction=null, score=0, reason="";

  if (rec.priceVsVwap > 0.3 && rec.rsi15 > 50 && rec.rsi5 > 55 && rec.rsi5 < 80) {
    // SÉCURITÉ RENFORCÉE : Si BTC inconnu ou baissier, ON BLOQUE
    if (btcChange == null || isNaN(btcChange)) return null; 
    if (btcChange < BTC_DUMP_THRESHOLD) return null; 

    if (rec.obScore >= 0) {
      let s=50;
      if(rec.volRatio>2.0) s+=20; else if(rec.volRatio>1.5) s+=10;
      if(rec.rsi5>60) s+=10; if(rec.change24>3) s+=10; if(rec.obScore===1) s+=10;
      if (s >= 80) { direction="LONG"; score=s; reason=`Vol x${rec.volRatio.toFixed(1)} | BTC OK`; }
    }
  } else if (rec.priceVsVwap < -0.3 && rec.rsi15 < 50 && rec.rsi5 < 45 && rec.rsi5 > 20) {
    if (rec.obScore <= 0) {
      let s=50;
      if(rec.volRatio>2.0) s+=20; else if(rec.volRatio>1.5) s+=10;
      if(rec.rsi5<40) s+=10; if(rec.change24<-3) s+=10; if(rec.obScore===-1) s+=10;
      if (s >= 80) { direction="SHORT"; score=s; reason=`Vol x${rec.volRatio.toFixed(1)}`; }
    }
  }

  if (!direction) return null;

  // Smart Entry
  const pullbackPct = clamp(rec.volaPct / 20, 0.3, 1.0); 
  let limitEntry = direction === "LONG" ? rec.last * (1 - pullbackPct/100) : rec.last * (1 + pullbackPct/100);

  const riskMult = 1.8; 
  const riskPct = clamp((rec.volaPct/5)*riskMult, 1.2, 6.0);
  const sl = direction==="LONG" ? rec.last*(1-riskPct/100) : rec.last*(1+riskPct/100);
  const tp = direction==="LONG" ? rec.last*(1+(riskPct*2.5)/100) : rec.last*(1-(riskPct*2.5)/100);
  const obRatio = rec.asksVol > 0 ? (rec.bidsVol / rec.asksVol).toFixed(2) : "N/A";

  return { 
    symbol:rec.symbol, direction, score, reason, 
    price:rec.last, 
    limitEntry: num(limitEntry, rec.last<1?5:3), 
    sl:num(sl, rec.last<1?5:3), 
    tp:num(tp, rec.last<1?5:3), 
    riskPct:num(riskPct,2), volRatio:num(rec.volRatio,1), vola:num(rec.volaPct,1), obRatio 
  };
}

async function sendTelegram(text){
  if(!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try{ await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,{ method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" }) }); }catch(e){}
}
function checkAntiSpam(symbol, direction){
  const key=`${symbol}-${direction}`; const now=Date.now(); const last=lastAlerts.get(key);
  if(last && (now-last<MIN_ALERT_DELAY_MS)) return false; lastAlerts.set(key,now); return true;
}

async function scanDiscovery(){
  const now = Date.now();
  const btcChange = await getBTCTrend();
  
  // BLOQUEUR GÉNÉRAL : Si pas de BTC, on arrête tout le scan
  if (btcChange == null || isNaN(btcChange)) {
    console.error("🚨 ERREUR CRITIQUE : Impossible de lire le BTC. Scan Discovery ANNULÉ par sécurité.");
    return; 
  }

  if(now - lastSymbolUpdate > SYMBOL_UPDATE_INTERVAL || DISCOVERY_SYMBOLS.length === 0){
    DISCOVERY_SYMBOLS = await updateDiscoveryList(); lastSymbolUpdate = now;
  }
  console.log(`🚀 Discovery Scan | BTC: ${btcChange.toFixed(2)}%`);
  
  const BATCH_SIZE = 5; const candidates = [];
  for(let i=0; i<DISCOVERY_SYMBOLS.length; i+=BATCH_SIZE){
    const batch = DISCOVERY_SYMBOLS.slice(i, i+BATCH_SIZE);
    const results = await Promise.all(batch.map(s => processDiscovery(s).catch(e=>null)));
    for(const r of results){ const s = analyzeCandidate(r, btcChange); if(s) candidates.push(s); }
    await sleep(400); 
  }
  
  const best = candidates.sort((a,b) => b.score - a.score).slice(0, 2);
  for(const c of best){
    if(!checkAntiSpam(c.symbol, c.direction)) continue;
    const emoji = c.direction === "LONG" ? "🚀" : "🪂";
    let footer = "_Mode Elite (80+) | Smart Entry_";
    if (c.volRatio >= 2.5) footer = "🔥 VOLUME EXPLOSIF : Setup Majeur";
    
    const levierConseille = c.riskPct > 4 ? "2x" : (c.riskPct > 2.5 ? "3x" : "4x");

    const msg = `⚡ *JTF DISCOVERY v0.9 (Safe)* ⚡\n\n${emoji} *${c.symbol}* — ${c.direction}\n📊 Score: ${c.score}/100\n💡 Raison: _${c.reason}_\n\n📉 *Limit Entry:* ${c.limitEntry} (Recommandé)\n🔹 Market: ${c.price}\n\n🛑 SL: ${c.sl} (-${c.riskPct}%)\n🎯 TP: ${c.tp}\n\n📏 *Levier:* ${levierConseille}\n⚖️ *OB Ratio:* ${c.obRatio}\n📢 Volume: x${c.volRatio}\n\n${footer}`;
    
    await sendTelegram(msg); 
    console.log(`✅ Signal Discovery envoyé: ${c.symbol}`);
  }
}

async function main(){
  console.log("🔥 JTF DISCOVERY v0.9 (Safe) démarré.");
  await sendTelegram("🔥 *JTF DISCOVERY v0.9 (Sécurité BTC Active) activé.*");
  while(true){ try { await scanDiscovery(); } catch(e) { console.error("Discovery Error:", e); } await sleep(SCAN_INTERVAL_MS); }
}

export const startDiscovery = main;
