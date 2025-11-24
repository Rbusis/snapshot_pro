// degen.js — JTF DEGEN v0.10 (Calm Mode)
// Mises à jour : Single-Shot + Global Cooldown (15m) + Retry Pattern

import fetch from "node-fetch";

// ========= CONFIG =========
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const SCAN_INTERVAL_MS   = 5 * 60_000;
const MIN_ALERT_DELAY_MS = 15 * 60_000;     // Anti-spam par paire
const GLOBAL_COOLDOWN_MS = 15 * 60_000;     // 🔥 NOUVEAU : 15 min de pause après un trade global (Degen est plus rapide)
const BTC_DUMP_THRESHOLD = -0.3;            // On garde -0.3 pour Degen (plus tolérant que Discovery)
const SYMBOL_UPDATE_INTERVAL = 60 * 60_000;

let DEGEN_SYMBOLS = [];
let lastSymbolUpdate = 0;
let lastGlobalTradeTime = 0; // 🔥 NOUVEAU : Timestamp du dernier signal envoyé
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
  // Essai V2
  let j = await safeGetJson(`https://api.bitget.com/api/v2/mix/market/candles?symbol=${base}&granularity=${seconds}&productType=usdt-futures&limit=${limit}`);
  if(j?.data?.length){
    return j.data.map(c=>({ t:+c[0],o:+c[1],h:+c[2],l:+c[3],c:+c[4],v:+c[5] })).sort((a,b)=>a.t-b.t);
  }
  // Fallback V1
  j = await safeGetJson(`https://api.bitget.com/api/mix/v1/market/candles?symbol=${symbol}&granularity=${seconds}&limit=${limit}`);
  if(j?.data?.length){
    return j.data.map(c=>({ t:+c[0],o:+c[1],h:+c[2],l:+c[3],c:+c[4],v:+c[5] })).sort((a,b)=>a.t-b.t);
  }
  return [];
}

// 🔥 FONCTION ROBUSTE (RETRY PATTERN) 🔥
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
    
    if (i < MAX_RETRIES - 1) {
      console.log(`⚠️ DEGEN: Echec lecture BTC (Tentative ${i+1}/${MAX_RETRIES})... Retry dans 2s.`);
      await sleep(2000); 
    }
  }
  return null;
}

async function updateDegenList() {
  try {
    const j = await safeGetJson("https://api.bitget.com/api/mix/v1/market/tickers?productType=umcbl");
    if (!j?.data) return FALLBACK_LOWCAPS;
    const valid = j.data.filter(t => t.symbol.endsWith("_UMCBL") && !t.symbol.startsWith("USDC") && (+t.usdtVolume > 1000000) && !IGNORE_LIST.includes(t.symbol));
    valid.sort((a,b) => (+b.usdtVolume) - (+a.usdtVolume));
    const lowCaps = valid.slice(50, 150).map(t => t.symbol);
    console.log(`🔄 DEGEN List: ${lowCaps.length} paires.`);
    return lowCaps.length > 5 ? lowCaps : FALLBACK_LOWCAPS;
  } catch { return FALLBACK_LOWCAPS; }
}

async function getTicker(symbol){ const j = await safeGetJson(`https://api.bitget.com/api/mix/v1/market/ticker?symbol=${symbol}`); return j?.data ?? null; }
async function getFunding(symbol){ const j = await safeGetJson(`https://api.bitget.com/api/mix/v1/market/currentFundRate?symbol=${symbol}`); return j?.data ?? null; }
async function getDepth(symbol){ const j = await safeGetJson(`https://api.bitget.com/api/mix/v1/market/depth?symbol=${symbol}&limit=20`); return (j?.data?.bids && j?.data?.asks) ? j.data : null; }

// ========= INDICATEURS =========

function rsi(c,p=14){ if(c.length<p+1) return null; let g=0,l=0; for(let i=1;i<=p;i++){ const d=c[i]-c[i-1]; d>=0?g+=d:l-=d; } g/=p; l=(l/p)||1e-9; let rs=g/l; let v=100-100/(1+rs); for(let i=p+1;i<c.length;i++){ const d=c[i]-c[i-1]; g=(g*(p-1)+Math.max(d,0))/p; l=((l*(p-1)+Math.max(-d,0))/p)||1e-9; rs=g/l; v=100-100/(1+rs); } return v; }
function vwap(c){ let pv=0,v=0; for(const x of c){ const p=(x.h+x.l+x.c)/3; pv+=p*x.v; v+=x.v; } return v?pv/v:null; }

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
  if(!rec || !rec.rsi5 || !rec.rsi15 || rec.volaPct < 3 || rec.volRatio < 2.0) return null;
  if (rec.rsi5 > 82 || rec.rsi5 < 18 || Math.abs(rec.priceVsVwap) > 5.0) return null;

  let direction=null, score=0, reason="";

  if (rec.priceVsVwap > 0.3 && rec.rsi15 > 50 && rec.rsi5 > 55 && rec.rsi5 < 80) {
    if (btcChange == null || isNaN(btcChange)) return null; 
    if (btcChange < BTC_DUMP_THRESHOLD) return null; 

    if (rec.obScore >= 0) {
      let s=50;
      if(rec.volRatio>3.0) s+=20; else if(rec.volRatio>2.0) s+=10;
      if(rec.rsi5>60) s+=10; if(rec.change24>3) s+=10; if(rec.obScore===1) s+=10;
      if (s >= 80) { direction="LONG"; score=s; reason=`Vol x${rec.volRatio.toFixed(1)} | OB Bull`; }
    }
  } else if (rec.priceVsVwap < -0.3 && rec.rsi15 < 50 && rec.rsi5 < 45 && rec.rsi5 > 20) {
    if (rec.obScore <= 0) {
      let s=50;
      if(rec.volRatio>3.0) s+=20; else if(rec.volRatio>2.0) s+=10;
      if(rec.rsi5<40) s+=10; if(rec.change24<-3) s+=10; if(rec.obScore===-1) s+=10;
      if (s >= 80) { direction="SHORT"; score=s; reason=`Vol x${rec.volRatio.toFixed(1)} | OB Bear`; }
    }
  }

  if (!direction) return null;

  const pullbackPct = clamp(rec.volaPct / 20, 0.4, 1.2); 
  let limitEntry = direction === "LONG" ? rec.last * (1 - pullbackPct/100) : rec.last * (1 + pullbackPct/100);

  const riskMult = 2.0; 
  const riskPct = clamp((rec.volaPct/5)*riskMult, 2.0, 10.0);
  const sl = direction==="LONG" ? rec.last*(1-riskPct/100) : rec.last*(1+riskPct/100);
  const tp = direction==="LONG" ? rec.last*(1+(riskPct*3)/100) : rec.last*(1-(riskPct*3)/100);
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

async function scanDegen(){
  const now = Date.now();
  const btcChange = await getBTCTrend();
  
  if (btcChange == null || isNaN(btcChange)) {
    console.error("⚠️ BTC DATA ERROR après retry : Scan Degen temporairement annulé.");
    return;
  }

  if(now - lastSymbolUpdate > SYMBOL_UPDATE_INTERVAL || DEGEN_SYMBOLS.length === 0){
    DEGEN_SYMBOLS = await updateDegenList(); lastSymbolUpdate = now;
  }
  
  // Log de suivi Calm Mode
  console.log(`🎰 DEGEN v0.10 | BTC: ${btcChange.toFixed(2)}% | Last Global Trade: ${Math.floor((now - lastGlobalTradeTime)/60000)}m ago`);
  
  const BATCH_SIZE = 5; const candidates = [];
  for(let i=0; i<DEGEN_SYMBOLS.length; i+=BATCH_SIZE){
    const batch = DEGEN_SYMBOLS.slice(i, i+BATCH_SIZE);
    const results = await Promise.all(batch.map(s => processDegen(s).catch(e=>null)));
    for(const r of results){ const s = analyzeCandidate(r, btcChange); if(s) candidates.push(s); }
    await sleep(400); 
  }
  
  // 🔥 SINGLE-SHOT : Max 1 trade (le meilleur)
  const best = candidates.sort((a,b) => b.score - a.score).slice(0, 1);
  
  for(const c of best){
    // 🔥 GLOBAL COOLDOWN CHECK (15 mins)
    const timeSinceLast = now - lastGlobalTradeTime;
    if (timeSinceLast < GLOBAL_COOLDOWN_MS) {
      console.log(`⏳ DEGEN Signal ${c.symbol} IGNORÉ : Cooldown Global actif (${Math.floor(timeSinceLast/60000)}/${GLOBAL_COOLDOWN_MS/60000} min).`);
      continue;
    }

    if(!checkAntiSpam(c.symbol, c.direction)) continue;
    
    const emoji = c.direction === "LONG" ? "💎" : "💣";
    let footer = "_Zone DEGEN (Calmed)_";
    if (c.volRatio >= 4.0) footer = "🔥 MEGA PUMP (x4) : ALERTE MAXIMALE !";
    
    const levierConseille = c.riskPct > 5 ? "2x" : "3x";

    const msg = `🎰 *JTF DEGEN v0.10 (Calm Mode)* 🎰\n\n${emoji} *${c.symbol}* — ${c.direction}\n📊 Score: ${c.score}/100\n💡 Raison: _${c.reason}_\n\n📉 *Limit Entry:* ${c.limitEntry} (Recommandé)\n🔹 Market: ${c.price}\n\n🛑 SL: ${c.sl} (-${c.riskPct}%)\n🎯 TP: ${c.tp}\n\n📏 *Levier:* ${levierConseille}\n⚖️ *OB Ratio:* ${c.obRatio}\n📢 Volume: x${c.volRatio}\n\n${footer}\n_Mise minimum conseillée_`;
    
    await sendTelegram(msg); 
    console.log(`✅ Signal DEGEN envoyé: ${c.symbol}`);
    
    // 🔥 ACTIVE LE COOLDOWN
    lastGlobalTradeTime = now;
  }
}

async function main(){
  console.log("🔥 JTF DEGEN v0.10 (Calm Mode) démarré.");
  await sendTelegram("🎰 *JTF DEGEN v0.10 (Calm Mode) activé.*");
  while(true){ try { await scanDegen(); } catch(e) { console.error("Degen Crash:", e); } await sleep(SCAN_INTERVAL_MS); }
}

export const startDegen = main;
