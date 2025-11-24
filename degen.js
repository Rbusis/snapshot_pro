// degen.js — JTF DEGEN v1.0 (Lowcaps Momentum Sniper)
// ARCHITECTURE : Robust BTC Retry + Single-Shot + Global Cooldown (15m)
// LOGIQUE : Momentum Sniper (VolRatio > 2.5, Wicks Filters, VWAP Gaps)

import fetch from "node-fetch";
import { loadJson } from "./config/loadJson.js";
const top30 = loadJson("./config/top30.json");

function getDiscoveryList() {
  try {
    const raw = fs.readFileSync("./config/discovery_list.json", "utf8");
    return JSON.parse(raw);
  } catch (e) {
    console.log("⚠️ discovery_list.json introuvable — fallback []");
    return [];
  }
}

// ========= CONFIG =========
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const SCAN_INTERVAL_MS   = 5 * 60_000;
const MIN_ALERT_DELAY_MS = 15 * 60_000;     // Anti-spam par paire
const GLOBAL_COOLDOWN_MS = 15 * 60_000;     // Pause après un tir
const SYMBOL_UPDATE_INTERVAL = 60 * 60_000;

// Config Sécurité BTC (Prompt)
const BTC_DUMP_THRESHOLD_LONG = -0.7; // Pas de LONG si BTC < -0.7%
const BTC_PUMP_THRESHOLD_SHORT = 1.0; // Pas de SHORT si BTC > 1.0%

let DEGEN_SYMBOLS = [];
let lastSymbolUpdate = 0;
let lastGlobalTradeTime = 0;
const lastAlerts = new Map();

const FALLBACK_LOWCAPS = ["MAGICUSDT_UMCBL","GALAUSDT_UMCBL","ONEUSDT_UMCBL","CELOUSDT_UMCBL","KAVAUSDT_UMCBL"];
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

async function updateDegenList() {
  try {
    const j = await safeGetJson("https://api.bitget.com/api/mix/v1/market/tickers?productType=umcbl");
    if (!j?.data) return FALLBACK_LOWCAPS;

    const discoveryList = getDiscoveryList();

    const valid = j.data.filter(t =>
      t.symbol.endsWith("_UMCBL") &&
      !t.symbol.startsWith("USDC") &&
      (+t.usdtVolume > 1000000) &&
      !IGNORE_LIST.includes(t.symbol)
    );

    valid.sort((a,b) => (+b.usdtVolume) - (+a.usdtVolume));

    let lowCaps = valid.map(t => t.symbol);

    // 🔥 NOUVEAU : filtrage automatique
    lowCaps = lowCaps.filter(sym =>
      !top30.includes(sym) &&
      !discoveryList.includes(sym)
    );

    console.log(`🔄 DEGEN List (filtrée): ${lowCaps.length} paires.`);
    return lowCaps.length > 5 ? lowCaps : FALLBACK_LOWCAPS;

  } catch {
    return FALLBACK_LOWCAPS;
  }
}

async function getTicker(symbol){ const j = await safeGetJson(`https://api.bitget.com/api/mix/v1/market/ticker?symbol=${symbol}`); return j?.data ?? null; }
async function getFunding(symbol){ const j = await safeGetJson(`https://api.bitget.com/api/mix/v1/market/currentFundRate?symbol=${symbol}`); return j?.data ?? null; }
async function getDepth(symbol){ const j = await safeGetJson(`https://api.bitget.com/api/mix/v1/market/depth?symbol=${symbol}&limit=20`); return (j?.data?.bids && j?.data?.asks) ? j.data : null; }

// ========= INDICATEURS =========

function rsi(c,p=14){ if(c.length<p+1) return null; let g=0,l=0; for(let i=1;i<=p;i++){ const d=c[i]-c[i-1]; d>=0?g+=d:l-=d; } g/=p; l=(l/p)||1e-9; let rs=g/l; let v=100-100/(1+rs); for(let i=p+1;i<c.length;i++){ const d=c[i]-c[i-1]; g=(g*(p-1)+Math.max(d,0))/p; l=((l*(p-1)+Math.max(-d,0))/p)||1e-9; rs=g/l; v=100-100/(1+rs); } return v; }
function vwap(c){ let pv=0,v=0; for(const x of c){ const p=(x.h+x.l+x.c)/3; pv+=p*x.v; v+=x.v; } return v?pv/v:null; }

// Fonction pour calculer la taille des mèches (%)
function calcWicks(candle) {
  if(!candle) return { upper:0, lower:0 };
  const bodyTop = Math.max(candle.o, candle.c);
  const bodyBot = Math.min(candle.o, candle.c);
  const upper = ((candle.h - bodyTop) / candle.c) * 100;
  const lower = ((bodyBot - candle.l) / candle.c) * 100;
  return { upper, lower };
}

async function processDegen(symbol) {
  const [tk, fr, depth] = await Promise.all([getTicker(symbol), getFunding(symbol), getDepth(symbol)]);
  if(!tk) return null;
  const last=+tk.last; 
  
  const [c5m, c15m] = await Promise.all([getCandles(symbol, 300), getCandles(symbol, 900)]);
  if(c5m.length < 50) return null;

  const closes5=c5m.map(x=>x.c); const closes15=c15m.map(x=>x.c);
  const rsi5=rsi(closes5,14); const rsi15=rsi(closes15,14);
  const vwap5=vwap(c5m.slice(-24));
  const priceVsVwap=vwap5?((last-vwap5)/vwap5)*100:0;
  
  // Wicks Analysis (sur la dernière bougie clôturée ou en cours si pertinent, ici dernière du tableau)
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

// ========= CERVEAU SNIPER =========

function analyzeCandidate(rec, btcChange) {
  // 1. HARD FILTERS (Éliminatoires)
  if(!rec || btcChange == null) return null;

  // Filtre #1 : Volume Spike (Le facteur roi)
  if (rec.volRatio < 2.5) return null; 

  // Filtre #5 : Volatilité saine (4-18%)
  // Exception : Si volRatio > 4 (mega pump), on tolère une vola > 20%
  if (rec.volaPct < 4) return null;
  if (rec.volaPct > 18 && rec.volRatio < 4.0) return null;

  // Filtre #2 : Gap VWAP Momentum (0.6% à 3.5%)
  // On élimine si le prix est collé au VWAP (pas de momentum) ou trop loin (trop tard)
  const gapAbs = Math.abs(rec.priceVsVwap);
  if (gapAbs < 0.6) return null; // Trop mou
  if (gapAbs > 4.5) return null; // Trop étendu

  let direction = null;

  // --- DÉTERMINATION DIRECTION & FILTRES SPÉCIFIQUES ---
  
  if (rec.priceVsVwap > 0) { // Potential LONG
    // Filtres Long
    if (btcChange < BTC_DUMP_THRESHOLD_LONG) return null; // BTC crash
    if (rec.rsi5 > 82) return null;                       // RSI Surchauffe
    if (rec.wicks.upper > 1.5) return null;               // Rejet (mèche haute)
    if (rec.obScore < 0) return null;                     // Orderbook Bearish
    direction = "LONG";
  } 
  else { // Potential SHORT
    // Filtres Short
    if (btcChange > BTC_PUMP_THRESHOLD_SHORT) return null;// BTC Pump
    if (rec.rsi5 < 18) return null;                       // RSI Surchauffe bas
    if (rec.wicks.lower > 1.5) return null;               // Rejet (mèche basse)
    if (rec.obScore > 0) return null;                     // Orderbook Bullish
    direction = "SHORT";
  }

  if (!direction) return null;

  // --- SCORING MODULE (0-100) ---
  let score = 0;

  // Module 1 : Volume Spike (Max 35 pts)
  // 2.5 -> 10pts, 5.0 -> 35pts
  score += Math.min(35, 10 + (rec.volRatio - 2.5) * 10);

  // Module 2 : Gap VWAP Momentum (Max 20 pts)
  // Zone idéale : 1.0% à 2.5%
  if (gapAbs >= 1.0 && gapAbs <= 2.5) score += 20;
  else if (gapAbs > 2.5 && gapAbs <= 3.5) score += 10;
  else score += 5;

  // Module 3 : RSI Dynamique (Max 15 pts)
  // Long ideal: 55-70 | Short ideal: 30-45
  if (direction === "LONG") {
    if (rec.rsi5 >= 55 && rec.rsi5 <= 75) score += 15;
    else if (rec.rsi5 > 50) score += 5;
  } else {
    if (rec.rsi5 <= 45 && rec.rsi5 >= 25) score += 15;
    else if (rec.rsi5 < 50) score += 5;
  }

  // Module 4 : OB Dominance (Max 15 pts)
  if (direction === "LONG" && rec.obScore === 1) score += 15;
  if (direction === "SHORT" && rec.obScore === -1) score += 15;

  // Module 5 : Tendance 24h (Max 10 pts)
  // On aime le momentum aligné avec la tendance jour
  if (direction === "LONG" && rec.change24 > 5) score += 10;
  if (direction === "SHORT" && rec.change24 < -5) score += 10;

  // Module 6 : Contexte BTC (Max 10 pts)
  if (direction === "LONG" && btcChange > 0) score += 10;
  if (direction === "SHORT" && btcChange < 0) score += 10;

  // SEUIL TAKE : 82
  if (score < 82) return null;

  // --- STRATÉGIE SORTIE ---
  
  // Entry : Limit Pullback
  // Plus le mouvement est étendu, plus on demande un pullback profond
  const pullbackFactor = clamp(gapAbs / 3, 0.5, 1.5); 
  let limitEntry = direction === "LONG" 
    ? rec.last * (1 - pullbackFactor/100) 
    : rec.last * (1 + pullbackFactor/100);

  // TP/SL basés sur la volatilité 24h
  // Lowcap = SL large nécessaire mais TP agressif
  const slPct = clamp(rec.volaPct / 3, 2.5, 6.0);
  const tpPct = slPct * 2; // R:R 1:2

  const sl = direction==="LONG" ? rec.last*(1-slPct/100) : rec.last*(1+slPct/100);
  const tp = direction==="LONG" ? rec.last*(1+tpPct/100) : rec.last*(1-tpPct/100);
  
  const levier = slPct > 4.5 ? "2x" : "3x";
  const obRatio = rec.asksVol > 0 ? (rec.bidsVol / rec.asksVol).toFixed(2) : "N/A";

  // Raison principale pour le log
  let mainReason = "Momentum";
  if (rec.volRatio > 4) mainReason = "Volume Nuke";
  else if (gapAbs > 2) mainReason = "VWAP Breakout";
  else if (Math.abs(rec.change24) > 10) mainReason = "Trend Continuation";

  return { 
    symbol:rec.symbol, direction, score: Math.floor(score), reason: mainReason,
    price:rec.last, 
    limitEntry: num(limitEntry, rec.last<1?5:3),
    sl:num(sl, rec.last<1?5:3), 
    tp:num(tp, rec.last<1?5:3), 
    riskPct:num(slPct,2), volRatio:num(rec.volRatio,1), vola:num(rec.volaPct,1), obRatio, levier
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

async function scanDegen(){
  const now = Date.now();
  const btcChange = await getBTCTrend();
  
  if (btcChange == null || isNaN(btcChange)) {
    console.error("⚠️ BTC DATA ERROR : Scan Degen annulé.");
    return;
  }

  if(now - lastSymbolUpdate > SYMBOL_UPDATE_INTERVAL || DEGEN_SYMBOLS.length === 0){
    DEGEN_SYMBOLS = await updateDegenList(); lastSymbolUpdate = now;
  }
  
  console.log(`🎯 DEGEN v1.0 | BTC: ${btcChange.toFixed(2)}% | Symbols: ${DEGEN_SYMBOLS.length} | Cooldown: ${Math.max(0, Math.floor((GLOBAL_COOLDOWN_MS - (now - lastGlobalTradeTime))/1000))}s`);
  
  const BATCH_SIZE = 5; const candidates = [];
  for(let i=0; i<DEGEN_SYMBOLS.length; i+=BATCH_SIZE){
    const batch = DEGEN_SYMBOLS.slice(i, i+BATCH_SIZE);
    const results = await Promise.all(batch.map(s => processDegen(s).catch(e=>null)));
    for(const r of results){ const s = analyzeCandidate(r, btcChange); if(s) candidates.push(s); }
    await sleep(400); 
  }
  
  // SINGLE SHOT : Le meilleur sinon rien
  const best = candidates.sort((a,b) => b.score - a.score).slice(0, 1);
  
  for(const c of best){
    // GLOBAL COOLDOWN
    const timeSinceLast = now - lastGlobalTradeTime;
    if (timeSinceLast < GLOBAL_COOLDOWN_MS) {
      console.log(`⏳ DEGEN Sniper: Signal ${c.symbol} (Score ${c.score}) ignoré par Cooldown.`);
      continue;
    }

    if(!checkAntiSpam(c.symbol, c.direction)) continue;
    
    const emoji = c.direction === "LONG" ? "🔫 🟢" : "🔫 🔴";
    const riskEmoji = c.volRatio > 4 ? "☢️" : "⚡";

    const msg = `🎯 *JTF DEGEN v1.0 (Sniper)* ${riskEmoji}\n\n${emoji} *${c.symbol}* — ${c.direction}\n🏅 *Score:* ${c.score}/100\n🔎 *Setup:* ${c.reason}\n\n📉 *Limit Entry:* ${c.limitEntry}\n🔹 Market: ${c.price}\n\n🎯 TP: ${c.tp}\n🛑 SL: ${c.sl} (-${c.riskPct}%)\n\n⚖️ *Levier:* ${c.levier} (Isolated)\n📊 *Vol:* x${c.volRatio} | *OB:* ${c.obRatio}\n\n_Wait for limit. No FOMO._`;
    
    await sendTelegram(msg); 
    console.log(`✅ SNIPER SHOT: ${c.symbol} (Score ${c.score})`);
    
    lastGlobalTradeTime = now;
  }
}

async function main(){
  console.log("🔫 JTF DEGEN v1.0 (Sniper Momentum) démarré.");
  await sendTelegram("🔫 *JTF DEGEN v1.0 (Sniper Logic) activé.*");
  while(true){ try { await scanDegen(); } catch(e) { console.error("Degen Crash:", e); } await sleep(SCAN_INTERVAL_MS); }
}

export const startDegen = main;
