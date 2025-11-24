// index.js — JTF DISCOVERY v0.1 (Railway / Telegram)
// CIBLE : Mid-Caps (Rank 31-80 Vol) | STRATÉGIE : Momentum & Breakout
// Stop Loss Large | Trend Following | Volume Spikes

import fetch from "node-fetch";
import http from "http";

// ========= RAILWAY KEEPALIVE =========
const PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end("JTF Discovery Bot is running...");
}).listen(PORT, () => {
  console.log(`🛡️ Discovery Server écoute sur le port ${PORT}`);
});

// ========= CONFIG =========

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

// Scan toutes les 5 minutes (nécessaire pour choper les pumps)
const SCAN_INTERVAL_MS   = 5 * 60_000;

// Anti-spam un peu plus long car on veut moins de bruit
const MIN_ALERT_DELAY_MS = 10 * 60_000;

// On stocke la liste dynamique ici
let DISCOVERY_SYMBOLS = [];
let lastSymbolUpdate = 0;
const SYMBOL_UPDATE_INTERVAL = 60 * 60_000; // Maj de la liste toutes les 1h

// Fallback : Des mid-caps populaires si l'API liste échoue
const FALLBACK_MIDCAPS = [
  "INJUSDT_UMCBL","RNDRUSDT_UMCBL","FETUSDT_UMCBL","AGIXUSDT_UMCBL",
  "ARBUSDT_UMCBL","OPUSDT_UMCBL","LDOUSDT_UMCBL","FILUSDT_UMCBL",
  "STXUSDT_UMCBL","IMXUSDT_UMCBL","SNXUSDT_UMCBL","FXSUSDT_UMCBL"
];

// ========= MÉMOIRE =========
const prevVolume = new Map(); // Pour détecter les spikes de volume
const lastAlerts = new Map();

// ========= UTILS =========
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

// ========= GESTION LISTE DYNAMIQUE (MID CAPS) =========

async function updateDiscoveryList() {
  try {
    // Récupère tous les tickers
    const url = "https://api.bitget.com/api/mix/v1/market/tickers?productType=umcbl";
    const j = await safeGetJson(url);
    
    if (!j || !j.data) return FALLBACK_MIDCAPS;

    // Filtre : USDT only, pas de USDC, Volume > 5M$ (éviter les cadavres)
    const valid = j.data.filter(t => 
      t.symbol.endsWith("_UMCBL") && 
      !t.symbol.startsWith("USDC") &&
      (+t.usdtVolume > 5000000) 
    );

    // Tri par volume décroissant
    valid.sort((a,b) => (+b.usdtVolume) - (+a.usdtVolume));

    // ON PREND LA TRANCHE 31 à 80 (Le "Ventre mou" explosif)
    // On skip le Top 30 (géré par le Bot 1)
    const midCaps = valid.slice(30, 80).map(t => t.symbol);

    console.log(`🔄 Discovery List mise à jour : ${midCaps.length} paires (Ex: ${midCaps[0]} ... ${midCaps[midCaps.length-1]})`);
    return midCaps.length > 5 ? midCaps : FALLBACK_MIDCAPS;

  } catch (e) {
    console.error("❌ Erreur Update List:", e.message);
    return FALLBACK_MIDCAPS;
  }
}

// ========= API BITGET DATA =========

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

// ========= INDICATEURS SIMPLE =========

function rsi(closes,p=14){
  if(closes.length<p+1) return null;
  let g=0,l=0;
  for(let i=1;i<=p;i++){
    const d=closes[i]-closes[i-1];
    if(d>=0) g+=d; else l-=d;
  }
  g/=p; l=(l/p)||1e-9;
  let rs=g/l; let val=100-100/(1+rs);
  for(let i=p+1;i<closes.length;i++){
    const d=closes[i]-closes[i-1];
    const G=Math.max(d,0), L=Math.max(-d,0);
    g=(g*(p-1)+G)/p;
    l=((l*(p-1)+L)/p)||1e-9;
    rs=g/l; val=100-100/(1+rs);
  }
  return val;
}

function vwap(c){
  let pv=0,v=0;
  for(const x of c){ const p=(x.h+x.l+x.c)/3; pv+=p*x.v; v+=x.v; }
  return v?pv/v:null;
}

// ========= ANALYSE PAR PAIRE (DISCOVERY STRATEGY) =========

async function processDiscovery(symbol) {
  // 1. Ticker & Candles
  const [tk, fr] = await Promise.all([
    getTicker(symbol),
    getFunding(symbol)
  ]);
  if(!tk) return null;

  const last   = +tk.last;
  const vol24  = +tk.usdtVolume; // ou baseVolume selon API, usdtVolume est mieux pour le tri
  const change24 = (+tk.priceChangePercent) * 100; // Vérifier format API, parfois c'est direct 0.05
  
  // Candles 15m (Tendance) et 1h (Structure)
  const [c15m, c1h] = await Promise.all([
    getCandles(symbol, 900, 100),  // 15m
    getCandles(symbol, 3600, 100)  // 1h
  ]);

  if(c15m.length < 50 || c1h.length < 50) return null;

  const closes15 = c15m.map(x=>x.c);
  const closes1h = c1h.map(x=>x.c);
  
  // --- INDICATEURS ---

  // 1. RSI (Momentum)
  const rsi15 = rsi(closes15, 14);
  const rsi1h = rsi(closes1h, 14);

  // 2. VWAP & Tendance
  const vwap15 = vwap(c15m.slice(-24)); // VWAP local
  const priceVsVwap = vwap15 ? ((last - vwap15)/vwap15)*100 : 0;

  // 3. Volume Spike Detection (Explosion de volume)
  // On compare le volume de la dernière bougie 15m à la moyenne des 10 précédentes
  const lastVol = c15m[c15m.length-1].v;
  const avgVol  = c15m.slice(-11, -1).reduce((a,b)=>a+b.v, 0) / 10;
  const volRatio = avgVol > 0 ? lastVol / avgVol : 1;

  // 4. Volatilité (ATR like simplifié en %)
  const high24 = +tk.high24h;
  const low24  = +tk.low24h;
  const volaPct = (high24 - low24) / last * 100;

  return {
    symbol,
    last,
    volaPct,
    rsi15,
    rsi1h,
    priceVsVwap,
    volRatio,
    change24,
    funding: fr ? +fr.fundingRate * 100 : 0
  };
}

// ========= LOGIQUE DE SIGNAL (MOMENTUM) =========

function analyzeCandidate(rec) {
  if(!rec || !rec.rsi15 || !rec.rsi1h) return null;

  let direction = null;
  let score = 0;
  let reason = "";

  // --- FILTRES DE BASE ---
  // On ne veut pas de truc mort
  if (rec.volaPct < 3) return null; // Pas assez de vola = ennuyeux pour un degen bot

  // --- LOGIQUE LONG (BREAKOUT) ---
  // Conditions :
  // 1. Prix au dessus du VWAP (C'est haussier)
  // 2. RSI 1h en zone forte (> 55) mais pas suracheté extrême (>85)
  // 3. RSI 15m pousse fort
  // 4. Volume Spike présent (> 1.5x moyenne)
  
  if (rec.priceVsVwap > 0.5 && rec.rsi1h > 55 && rec.rsi15 > 50) {
    let s = 50;
    if (rec.volRatio > 2.0) s += 20; // Gros volume !
    else if (rec.volRatio > 1.5) s += 10;

    if (rec.rsi15 > 60 && rec.rsi15 < 80) s += 10; // Sweet spot momentum
    if (rec.change24 > 5) s += 10; // Déjà en pump daily

    if (s >= 70) {
      direction = "LONG";
      score = s;
      reason = `Vol x${rec.volRatio.toFixed(1)} | RSI Structure Bull`;
    }
  }

  // --- LOGIQUE SHORT (CRASH/DUMP) ---
  // Conditions inverse + prudence sur les shorts en bull run
  else if (rec.priceVsVwap < -0.5 && rec.rsi1h < 45 && rec.rsi15 < 50) {
    let s = 50;
    if (rec.volRatio > 2.0) s += 15; // Panic sell volume
    else if (rec.volRatio > 1.5) s += 10;

    if (rec.rsi15 < 40 && rec.rsi15 > 20) s += 10; // Sweet spot dump
    if (rec.change24 < -5) s += 10; // Déjà en dump daily

    if (s >= 70) {
      direction = "SHORT";
      score = s;
      reason = `Vol x${rec.volRatio.toFixed(1)} | RSI Structure Bear`;
    }
  }

  if (!direction) return null;

  // --- GESTION RISQUE (DISCOVERY MODE) ---
  // Stop Loss plus large car Mid Caps plus volatiles
  const riskMult = 2.0; // On laisse respirer
  const slDist = (rec.volaPct / 5) * riskMult; // Estimation dynamique
  const riskPct = clamp(slDist, 1.5, 8.0); // Min 1.5%, Max 8% de SL

  const sl = direction === "LONG" 
    ? rec.last * (1 - riskPct/100)
    : rec.last * (1 + riskPct/100);
  
  // TP Vise la lune (Risk Reward 1:2.5 mini)
  const tp = direction === "LONG"
    ? rec.last * (1 + (riskPct * 2.5)/100)
    : rec.last * (1 - (riskPct * 2.5)/100);

  return {
    symbol: rec.symbol,
    direction,
    score,
    reason,
    price: rec.last,
    sl: num(sl, rec.last<1?5:3),
    tp: num(tp, rec.last<1?5:3),
    riskPct: num(riskPct, 2),
    volRatio: num(rec.volRatio, 1),
    vola: num(rec.volaPct, 1)
  };
}

// ========= TELEGRAM & ANTI-SPAM =========

async function sendTelegram(text){
  if(!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try{
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,{
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" })
    });
  }catch(e){ console.error("Telegram Err:", e.message); }
}

function checkAntiSpam(symbol, direction){
  const key = `${symbol}-${direction}`;
  const now = Date.now();
  const last = lastAlerts.get(key);
  if(last && (now - last < MIN_ALERT_DELAY_MS)) return false;
  lastAlerts.set(key, now);
  return true;
}

// ========= MAIN ENGINE =========

async function scanDiscovery(){
  // 1. Mise à jour liste si nécessaire
  const now = Date.now();
  if(now - lastSymbolUpdate > SYMBOL_UPDATE_INTERVAL || DISCOVERY_SYMBOLS.length === 0){
    DISCOVERY_SYMBOLS = await updateDiscoveryList();
    lastSymbolUpdate = now;
  }

  console.log(`🚀 Discovery Scan sur ${DISCOVERY_SYMBOLS.length} Mid-Caps...`);

  // 2. Scan par paquets (Vitesse)
  const BATCH_SIZE = 5;
  const candidates = [];

  for(let i=0; i<DISCOVERY_SYMBOLS.length; i+=BATCH_SIZE){
    const batch = DISCOVERY_SYMBOLS.slice(i, i+BATCH_SIZE);
    const results = await Promise.all(
      batch.map(s => processDiscovery(s).catch(e=>null))
    );
    for(const r of results){
      const signal = analyzeCandidate(r);
      if(signal) candidates.push(signal);
    }
    await sleep(500); // Respect API limits
  }

  // 3. Filtrage et Envoi
  // On ne garde que les scores > 75 ou les Top 2
  const best = candidates.sort((a,b) => b.score - a.score).slice(0, 2);

  if(best.length === 0){
    console.log("💤 Rien d'intéressant sur le radar Discovery.");
    return;
  }

  for(const c of best){
    if(!checkAntiSpam(c.symbol, c.direction)) continue;

    const emoji = c.direction === "LONG" ? "🚀" : "🪂";
    const msg = 
`⚡ *JTF DISCOVERY (Mid-Caps)* ⚡

${emoji} *${c.symbol}* — ${c.direction}
📊 Score: ${c.score}/100
💡 Raison: _${c.reason}_

🔹 *Entry:* ${c.price}
🛑 *SL:* ${c.sl} (-${c.riskPct}%)
🎯 *TP:* ${c.tp} (~2.5R)

🌪️ *Volatilité:* ${c.vola}%
📢 *Volume Spike:* x${c.volRatio}

_Risque élevé (Mid-Cap). Levier faible conseillé (2x max)._`;

    await sendTelegram(msg);
    console.log(`✅ Signal envoyé: ${c.symbol} ${c.direction}`);
  }
}

// ========= LOOP =========

async function main(){
  console.log("🔥 JTF DISCOVERY v0.1 démarré.");
  await sendTelegram("🔥 *JTF DISCOVERY Bot démarré*\n_Cible: Rank 31-80 | Stratégie: Momentum_");
  
  while(true){
    try { await scanDiscovery(); } 
    catch(e) { console.error("Loop Error:", e.message); }
    await sleep(SCAN_INTERVAL_MS);
  }
}

main();
