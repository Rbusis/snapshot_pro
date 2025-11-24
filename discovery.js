// discovery.js — JTF DISCOVERY v1.0 (Midcaps Momentum Scanner)
// ARCHITECTURE : Robust BTC Retry + Single-Shot + Global Cooldown (30m)
// LOGIQUE : Midcap Scoring (Vol > 1.8, No Wicks, Clean VWAP Gap)

import fetch from "node-fetch";
import { loadJson } from "./config/loadJson.js";
const top30 = loadJson("./config/top30.json");

// ========= CONFIG =========
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const SCAN_INTERVAL_MS   = 5 * 60_000;
const MIN_ALERT_DELAY_MS = 15 * 60_000;     // Anti-spam par paire
const GLOBAL_COOLDOWN_MS = 30 * 60_000;     // Pause après un signal (Discovery est patient)
const SYMBOL_UPDATE_INTERVAL = 60 * 60_000;

// Config Sécurité BTC (Prompt v1.0)
const BTC_LIMIT_LONG  = -0.2; // Pas de LONG si BTC < -0.2%
const BTC_LIMIT_SHORT = 0.5;  // Pas de SHORT si BTC > +0.5%

let DISCOVERY_SYMBOLS = [];
let lastSymbolUpdate = 0;
let lastGlobalTradeTime = 0;
const lastAlerts = new Map();

const FALLBACK_MIDCAPS = ["INJUSDT_UMCBL","RNDRUSDT_UMCBL","FETUSDT_UMCBL","AGIXUSDT_UMCBL","ARBUSDT_UMCBL"];
const IGNORE_LIST = ["BTCUSDT_UMCBL","ETHUSDT_UMCBL","BNBUSDT_UMCBL","SOLUSDT_UMCBL","XRPUSDT_UMCBL","ADAUSDT_UMCBL","DOGEUSDT_UMCBL","AVAXUSDT_UMCBL","DOTUSDT_UMCBL","TRXUSDT_UMCBL","LINKUSDT_UMCBL","TONUSDT_UMCBL","SUIUSDT_UMCBL","APTUSDT_UMCBL","NEARUSDT_UMCBL","ARBUSDT_UMCBL","OPUSDT_UMCBL","INJUSDT_UMCBL","ATOMUSDT_UMCBL","AAVEUSDT_UMCBL","LTCUSDT_UMCBL","UNIUSDT_UMCBL","FILUSDT_UMCBL","XLMUSDT_UMCBL","RUNEUSDT_UMCBL","ALGOUSDT_UMCBL","PEPEUSDT_UMCBL","WIFUSDT_UMCBL","TIAUSDT_UMCBL","SEIUSDT_UMCBL"];

// Utils
const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const num   = (v,d=4)=>v==null?null:+(+v).toFixed(d);
const clamp = (x,min,max)=>Math.max(min,Math.min(max,x));
const baseSymbol = s => s.replace("_UMCBL","");

async function safeGetJson(url){
  try{ const r = await fetch(url,{ headers:{ Accept:"application/json" } }); return r.ok ? await r.json() : null; }catch{ return null; }
}

// ========= API BITGET (MOTEUR ROBUSTE) =========

async function getCandles(symbol, seconds, limit=100){
  const base = baseSymbol(symbol);
  let j = await safeGetJson(`https://api.bitget.com/api/v2/mix/market/candles?symbol=${base}&granularity=${seconds}&productType=usdt-futures&limit=${limit}`);
  if(j?.data?.length){
    return j.data.map(c=>({ t:+c[0],o:+c[1],h:+c[2],l:+c[3],c:+c[4],v:+c[5] })).sort((a,b)=>a.t-b.t);
  }
  j = await safeGetJson(`https://api.bitget.com/api/mix/v1/market/candles?symbol=${symbol}&granularity=${seconds}&limit=${limit}`);
  if(j?.data?.length){
    return j.data.map(c=>({ t:+c[0],o:+c[1],h:+c[2],l:+c[3],c:+c[4],v:+c[5] })).sort((a,b)=>a.t-b.t);
  }
  return [];
}

async function getBTCTrend() {
  const MAX_RETRIES = 3;
  for(let i = 0; i < MAX_RETRIES; i++) {
    const candles = await getCandles("BTCUSDT_UMCBL", 3600, 5); 
    if (candles && candles.length >= 2) {
      const current = candles[candles.length - 1];
      const open = current.o;
      const close = current.c;
      if (!open) return 0;
      return ((close - open) / open) * 100;
    }
    if (i < MAX_RETRIES - 1) await sleep(2000); 
  }
  return null;
}

async function updateDiscoveryList() {
  try {
    const j = await safeGetJson("https://api.bitget.com/api/mix/v1/market/tickers?productType=umcbl");
    if (!j?.data) return FALLBACK_MIDCAPS;

    const valid = j.data.filter(t => 
      t.symbol.endsWith("_UMCBL") &&
      !t.symbol.startsWith("USDC") &&
      (+t.usdtVolume > 5000000) &&
      !IGNORE_LIST.includes(t.symbol)
    );

    valid.sort((a,b) => (+b.usdtVolume) - (+a.usdtVolume));

    const midCaps = valid.slice(0, 50).map(t => t.symbol);

    // 🔥 NOUVEAU : écriture dans discovery_list.json
    try {
      fs.writeFileSync("./config/discovery_list.json", JSON.stringify(midCaps, null, 2));
      console.log(`📝 Discovery : liste midcaps écrite (${midCaps.length} paires).`);
    } catch (e) {
      console.error("❌ Impossible d'écrire discovery_list.json:", e);
    }

    return midCaps.length > 5 ? midCaps : FALLBACK_MIDCAPS;

  } catch {
    return FALLBACK_MIDCAPS;
  }
}

async function getTicker(symbol){ const j = await safeGetJson(`https://api.bitget.com/api/mix/v1/market/ticker?symbol=${symbol}`); return j?.data ?? null; }
async function getFunding(symbol){ const j = await safeGetJson(`https://api.bitget.com/api/mix/v1/market/currentFundRate?symbol=${symbol}`); return j?.data ?? null; }
async function getDepth(symbol){ const j = await safeGetJson(`https://api.bitget.com/api/mix/v1/market/depth?symbol=${symbol}&limit=20`); return (j?.data?.bids && j?.data?.asks) ? j.data : null; }

// ========= INDICATEURS =========

function rsi(c,p=14){ if(c.length<p+1) return null; let g=0,l=0; for(let i=1;i<=p;i++){ const d=c[i]-c[i-1]; d>=0?g+=d:l-=d; } g/=p; l=(l/p)||1e-9; let rs=g/l; let v=100-100/(1+rs); for(let i=p+1;i<c.length;i++){ const d=c[i]-c[i-1]; g=(g*(p-1)+Math.max(d,0))/p; l=((l*(p-1)+Math.max(-d,0))/p)||1e-9; rs=g/l; v=100-100/(1+rs); } return v; }
function vwap(c){ let pv=0,v=0; for(const x of c){ const p=(x.h+x.l+x.c)/3; pv+=p*x.v; v+=x.v; } return v?pv/v:null; }

// Fonction pour calculer les mèches (Wicks)
function calcWicks(candle) {
  if(!candle) return { upper:0, lower:0 };
  const bodyTop = Math.max(candle.o, candle.c);
  const bodyBot = Math.min(candle.o, candle.c);
  const upper = ((candle.h - bodyTop) / candle.c) * 100;
  const lower = ((bodyBot - candle.l) / candle.c) * 100;
  return { upper, lower };
}

// ========= ANALYSE TECHNIQUE =========

async function processDiscovery(symbol) {
  const [tk, fr, depth] = await Promise.all([getTicker(symbol), getFunding(symbol), getDepth(symbol)]);
  if(!tk) return null;
  const last=+tk.last; 
  
  const [c5m, c15m] = await Promise.all([getCandles(symbol, 300, 100), getCandles(symbol, 900, 100)]);
  if(c5m.length < 50) return null;

  const closes5=c5m.map(x=>x.c); const closes15=c15m.map(x=>x.c);
  const rsi5=rsi(closes5,14); const rsi15=rsi(closes15,14);
  const vwap5=vwap(c5m.slice(-24));
  const priceVsVwap=vwap5?((last-vwap5)/vwap5)*100:0;
  
  const currentCandle = c5m[c5m.length-1];
  const wicks = calcWicks(currentCandle);
  
  const lastVol=c5m[c5m.length-1].v; const avgVol=c5m.slice(-11,-1).reduce((a,b)=>a+b.v,0)/10;
  const volRatio=avgVol>0?lastVol/avgVol:1;
  const volaPct=(+tk.high24h - +tk.low24h)/last*100;
  
  let obScore=0, bidsVol=0, asksVol=0;
  if (depth) {
    bidsVol=depth.bids.slice(0,10).reduce((a,x)=>a+(+x[1]),0);
    asksVol=depth.asks.slice(0,10).reduce((a,x)=>a+(+x[1]),0);
    if(asksVol>0){ const r=bidsVol/asksVol; if(r>1.2) obScore=1; else if(r<0.8) obScore=-1; }
  }

  return { symbol, last, volaPct, rsi5, rsi15, priceVsVwap, volRatio, change24:(+tk.priceChangePercent)*100, obScore, bidsVol, asksVol, wicks };
}

function analyzeCandidate(rec, btcChange) {
  if(!rec || btcChange == null) return null;

  // 1. HARD FILTERS (Éliminatoires pour Midcaps)
  if (rec.volRatio < 1.8) return null;          // Volume requis
  if (rec.volaPct < 3 || rec.volaPct > 20) return null; // Volatilité saine seulement
  
  const gapAbs = Math.abs(rec.priceVsVwap);
  if (gapAbs < 0.5) return null; // Trop près du VWAP (bruit)
  if (gapAbs > 3.5) return null; // Trop loin (déjà pumpé/dumpé)
  
  if (rec.rsi5 > 78 || rec.rsi5 < 22) return null; // RSI Extrême = danger de retournement

  let direction = null;

  // --- DÉTERMINATION DIRECTION & FILTRES WICKS/BTC ---
  
  if (rec.priceVsVwap > 0) { // Candidat LONG
    if (btcChange < BTC_LIMIT_LONG) return null; // BTC chute
    if (rec.wicks.upper > 1.0) return null;      // Rejet (Mèche haute)
    if (rec.obScore < 0) return null;            // OB Bearish
    direction = "LONG";
  } else { // Candidat SHORT
    if (btcChange > BTC_LIMIT_SHORT) return null;// BTC monte trop
    if (rec.wicks.lower > 1.0) return null;      // Rejet (Mèche basse)
    if (rec.obScore > 0) return null;            // OB Bullish
    direction = "SHORT";
  }

  if (!direction) return null;

  // --- SCORING MODULE (0-100) ---
  let score = 0;

  // Mod 1: Volume (Max 30)
  if(rec.volRatio >= 3.5) score += 30;
  else if(rec.volRatio >= 2.5) score += 20;
  else score += 10;

  // Mod 2: Gap VWAP (Max 20)
  // Zone idéale : 1% - 2.5%
  if(gapAbs >= 1.0 && gapAbs <= 2.5) score += 20;
  else score += 10;

  // Mod 3: RSI (Max 15)
  // On veut du progressif, pas du saturé
  if (direction === "LONG") {
    if(rec.rsi5 >= 55 && rec.rsi5 <= 75) score += 15;
    else score += 5;
  } else {
    if(rec.rsi5 <= 45 && rec.rsi5 >= 25) score += 15;
    else score += 5;
  }

  // Mod 4: OB Dominance (Max 15)
  if ((direction === "LONG" && rec.obScore === 1) || (direction === "SHORT" && rec.obScore === -1)) score += 15;

  // Mod 5: Tendance 24h (Max 10)
  if ((direction === "LONG" && rec.change24 > 3) || (direction === "SHORT" && rec.change24 < -3)) score += 10;

  // Mod 6: Contexte BTC (Max 10)
  if ((direction === "LONG" && btcChange >= 0) || (direction === "SHORT" && btcChange <= 0)) score += 10;

  // SEUIL TAKE : 78
  if (score < 78) return null;

  // --- SORTIE ---
  
  // Entry : Pullback léger (Midcap = mouvement plus propre que Degen)
  const pullbackFactor = clamp(gapAbs / 4, 0.4, 1.0); 
  let limitEntry = direction === "LONG" 
    ? rec.last * (1 - pullbackFactor/100) 
    : rec.last * (1 + pullbackFactor/100);

  // Risk Management
  const riskMult = 2.0; 
  const riskPct = clamp((rec.volaPct/5)*riskMult, 2.0, 5.0); // SL 2% à 5% max
  const sl = direction==="LONG" ? rec.last*(1-riskPct/100) : rec.last*(1+riskPct/100);
  const tp = direction==="LONG" ? rec.last*(1+(riskPct*2)/100) : rec.last*(1-(riskPct*2)/100);
  
  const levier = riskPct > 4 ? "2x" : "3x"; // Midcap = levier modéré
  const obRatio = rec.asksVol > 0 ? (rec.bidsVol / rec.asksVol).toFixed(2) : "N/A";

  // Raison principale
  let mainReason = "Momentum Propre";
  if (rec.volRatio > 3) mainReason = "Volume Spike";
  else if (rec.obScore !== 0) mainReason = "Orderbook Pressure";

  return { 
    symbol:rec.symbol, direction, score: Math.floor(score), reason: mainReason,
    price:rec.last, 
    limitEntry: num(limitEntry, rec.last<1?5:3), 
    sl:num(sl, rec.last<1?5:3), 
    tp:num(tp, rec.last<1?5:3), 
    riskPct:num(riskPct,2), volRatio:num(rec.volRatio,1), vola:num(rec.volaPct,1), obRatio, levier
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
  
  if (btcChange == null || isNaN(btcChange)) {
    console.error("⚠️ BTC DATA ERROR après 3 tentatives: Scan Discovery ignoré.");
    return; 
  }

  if(now - lastSymbolUpdate > SYMBOL_UPDATE_INTERVAL || DISCOVERY_SYMBOLS.length === 0){
    DISCOVERY_SYMBOLS = await updateDiscoveryList(); lastSymbolUpdate = now;
    console.log(`🔄 Discovery List: ${DISCOVERY_SYMBOLS.length} paires.`);
  }
  
  console.log(`🚀 Discovery v1.0 | BTC: ${btcChange.toFixed(2)}% | Cooldown: ${Math.max(0, Math.floor((GLOBAL_COOLDOWN_MS - (now - lastGlobalTradeTime))/1000))}s`);
  
  const BATCH_SIZE = 5; const candidates = [];
  for(let i=0; i<DISCOVERY_SYMBOLS.length; i+=BATCH_SIZE){
    const batch = DISCOVERY_SYMBOLS.slice(i, i+BATCH_SIZE);
    const results = await Promise.all(batch.map(s => processDiscovery(s).catch(e=>null)));
    for(const r of results){ const s = analyzeCandidate(r, btcChange); if(s) candidates.push(s); }
    await sleep(400); 
  }
  
  // 🔥 SINGLE-SHOT : Le meilleur sinon rien
  const best = candidates.sort((a,b) => b.score - a.score).slice(0, 1);
  
  for(const c of best){
    // 🔥 GLOBAL COOLDOWN CHECK
    const timeSinceLast = now - lastGlobalTradeTime;
    if (timeSinceLast < GLOBAL_COOLDOWN_MS) {
      console.log(`⏳ Discovery Signal ${c.symbol} (Score ${c.score}) IGNORÉ par Cooldown.`);
      continue;
    }

    if(!checkAntiSpam(c.symbol, c.direction)) continue;

    const emoji = c.direction === "LONG" ? "🚀" : "🪂";
    let footer = "_Mode Midcap Momentum_";
    if (c.volRatio >= 3.0) footer = "🔥 HIGH MOMENTUM";

    const msg = `⚡ *JTF DISCOVERY v1.0* ⚡\n\n${emoji} *${c.symbol}* — ${c.direction}\n🏅 *Score:* ${c.score}/100\n🔎 *Setup:* ${c.reason}\n\n📉 *Limit Entry:* ${c.limitEntry}\n🔹 Market: ${c.price}\n\n🎯 TP: ${c.tp}\n🛑 SL: ${c.sl} (-${c.riskPct}%)\n\n⚖️ *Levier:* ${c.levier}\n📊 *Vol:* x${c.volRatio} | *OB:* ${c.obRatio}\n\n${footer}`;
    
    await sendTelegram(msg); 
    console.log(`✅ Signal Discovery envoyé: ${c.symbol}`);
    
    // 🔥 ACTIVE LE COOLDOWN
    lastGlobalTradeTime = now;
  }
}

async function main(){
  console.log("🔥 JTF DISCOVERY v1.0 (Midcap Momentum) démarré.");
  await sendTelegram("🔥 *JTF DISCOVERY v1.0 (Midcap Logic) activé.*");
  while(true){ try { await scanDiscovery(); } catch(e) { console.error("Discovery Crash:", e); } await sleep(SCAN_INTERVAL_MS); }
}

export const startDiscovery = main;
