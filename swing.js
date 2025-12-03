// swing.js — JTF SWING v1.8 (API v2 + Stable + Data Logs + Leverage + Anti-Top Filter)

import fetch from "node-fetch";
import { DEBUG } from "./debug.js";

// ========= TELEGRAM =========
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

async function sendTelegram(msg){
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try{
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: msg,
        parse_mode:"Markdown"
      })
    });
  }catch{}
}

// ========= DEBUG =========
function logDebug(...args){
  if (DEBUG.global || DEBUG.swing){
    console.log("[SWING DEBUG]", ...args);
  }
}

// ========= CONFIG =========
const SCAN_INTERVAL_MS = 30 * 60_000; // 30 minutes

// Seuils "JDS swing" (calibrés sur la vraie échelle du score)
const JDS_READY = 45;
const JDS_PRIME = 55;

// Limite de risque
const MAX_ATR_1H   = 1.8;   // % max pour l'ATR 1h
const MAX_VOLA_24  = 25;    // % de range 24h max
const MAX_VWAP_4H  = 4;     // écart max en % du VWAP 4h

// ========= SYMBOLS (USDT-futures, API v2) =========
const SYMBOLS = [
  "BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT",
  "AVAXUSDT","LINKUSDT","DOTUSDT","TRXUSDT","ADAUSDT",
  "NEARUSDT","ATOMUSDT","OPUSDT","INJUSDT","UNIUSDT",
  "LTCUSDT","TIAUSDT","SEIUSDT"
];

// ========= STATE =========
const prevOI     = new Map();
const lastAlerts = new Map();

const sleep = ms => new Promise(r => setTimeout(r, ms));
const num   = (v,d=4)=>v==null?null:+(+v).toFixed(d);
const clamp = (x,min,max)=>Math.max(min,Math.min(max,x));

// ========= SAFE FETCH =========
async function safeGetJson(url){
  try{
    logDebug("safeGetJson", url);
    const r = await fetch(url,{ headers:{Accept:"application/json"} });
    if (!r.ok){
      logDebug("HTTP ERROR", r.status, url);
      return null;
    }
    return await r.json();
  }catch(e){
    logDebug("safeGetJson ERROR", url, e);
    return null;
  }
}

// ========= API v2 =========
async function getCandles(symbol, seconds, limit=400){
  logDebug("getCandles", symbol, seconds);
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}&granularity=${seconds}&limit=${limit}&productType=usdt-futures`
  );
  if (!j?.data?.length) return [];
  return j.data.map(c => ({
    t:+c[0], o:+c[1], h:+c[2], l:+c[3], c:+c[4], v:+c[5]
  })).sort((a,b)=>a.t-b.t);
}

async function getTicker(symbol){
  logDebug("getTicker", symbol);
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/ticker?symbol=${symbol}&productType=usdt-futures`
  );
  return j?.data ? (Array.isArray(j.data)?j.data[0]:j.data) : null;
}

async function getDepth(symbol){
  logDebug("getDepth", symbol);
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/merge-depth?symbol=${symbol}&productType=usdt-futures&limit=20`
  );
  if (!j?.data) return { bids:[], asks:[] };
  const d = Array.isArray(j.data) ? j.data[0] : j.data;
  return {
    bids: d.bids?.map(x=>[+x[0],+x[1]]) || [],
    asks: d.asks?.map(x=>[+x[0],+x[1]]) || []
  };
}

async function getOI(symbol){
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/open-interest?symbol=${symbol}&productType=usdt-futures`
  );
  const d = j?.data;
  return Array.isArray(d) ? d[0] : d;
}

// ========= INDICATORS =========
function atr(c, p=14){
  if (c.length < p+1) return null;
  let s = 0;
  for (let i=1;i<=p;i++){
    const tr = Math.max(
      c[i].h - c[i].l,
      Math.abs(c[i].h - c[i-1].c),
      Math.abs(c[i].l - c[i-1].c)
    );
    s += tr;
  }
  return s/p;
}

function rsi(cl, p=14){
  if (cl.length < p+1) return null;
  let g=0,l=0;
  for (let i=1;i<=p;i++){
    const d = cl[i]-cl[i-1];
    d>=0 ? g+=d : l-=d;
  }
  g/=p; l=(l/p)||1e-9;
  let v = 100-100/(1+(g/l));

  for (let i=p+1;i<cl.length;i++){
    const d = cl[i]-cl[i-1];
    g = (g*(p-1)+Math.max(d,0))/p;
    l = ((l*(p-1)+Math.max(-d,0))/p)||1e-9;
    v = 100-100/(1+(g/l));
  }
  return v;
}

function vwap(c){
  let pv=0, v=0;
  for (const x of c){
    const p = (x.h + x.l + x.c)/3;
    pv += p*x.v; v += x.v;
  }
  return v ? pv/v : null;
}

function positionInDay(last,low,high){
  if (high <= low) return null;
  return ((last-low)/(high-low))*100;
}

// ========= PROCESS =========
async function processSymbol(symbol){
  logDebug("processSymbol", symbol);

  const [tk, oi] = await Promise.all([
    getTicker(symbol),
    getOI(symbol)
  ]);

  if (!tk){
    console.log(`[SWING DROP] ${symbol} — no ticker data`);
    return null;
  }

  const last = +(
    tk.lastPr ?? tk.markPrice ?? tk.last ?? tk.close ?? null
  );
  if (!last){
    console.log(`[SWING DROP] ${symbol} — invalid price`);
    return null;
  }

  const high24 = tk.high24h != null ? +tk.high24h : null;
  const low24  = tk.low24h  != null ? +tk.low24h  : null;

  const openI = oi?.amount != null ? +oi.amount : null;
  const prev  = prevOI.get(symbol) ?? null;
  const deltaOI = (prev!=null && openI!=null && prev!==0)
    ? ((openI-prev)/prev)*100
    : null;
  prevOI.set(symbol, openI ?? prev);

  const [c15, c1h, c4h] = await Promise.all([
    getCandles(symbol, 900, 400),   // 15m
    getCandles(symbol, 3600, 400),  // 1h
    getCandles(symbol, 14400, 400)  // 4h
  ]);

  if (!c15.length || !c1h.length || !c4h.length){
    console.log(
      `[SWING DROP] ${symbol} — missing candles ` +
      `(15m=${c15.length},1h=${c1h.length},4h=${c4h.length})`
    );
    return null;
  }

  await getDepth(symbol); // pas utilisé dans le score, mais prêt si on veut l'ajouter plus tard

  const volaPct = (high24!=null && low24!=null)
    ? ((high24-low24)/last)*100
    : null;

  const tend24 = (high24>low24 && last)
    ? (((last-low24)/(high24-low24))*200 - 100)
    : null;

  const posDay = positionInDay(last, low24, high24);

  const v1h = vwap(c1h.slice(-48));
  const v4h = vwap(c4h.slice(-48));
  const dVWAP1h = v1h ? ((last/v1h -1)*100) : null;
  const dVWAP4h = v4h ? ((last/v4h -1)*100) : null;

  const atr1 = atr(c1h,14);
  const atr4 = atr(c4h,14);

  const rsi15 = rsi(c15.map(x=>x.c));
  const rsi1h = rsi(c1h.map(x=>x.c));
  const rsi4h = rsi(c4h.map(x=>x.c));

  const atr1hPct = atr1 ? (atr1/last)*100 : null;
  const atr4hPct = atr4 ? (atr4/last)*100 : null;

  const deltaOIpct    = deltaOI   != null ? +num(deltaOI,3)   : null;
  const deltaVWAP1h   = dVWAP1h   != null ? +num(dVWAP1h,4)   : null;
  const deltaVWAP4h   = dVWAP4h   != null ? +num(dVWAP4h,4)   : null;
  const volaPctFixed  = volaPct   != null ? +num(volaPct,4)   : null;
  const atr1hPctFixed = atr1hPct  != null ? +num(atr1hPct,4)  : null;
  const atr4hPctFixed = atr4hPct  != null ? +num(atr4hPct,4)  : null;

  // Log DATA pour Swing
  console.log(
    `[SWING DATA] ${symbol} | P=${last} | Vola24=${volaPctFixed!=null?volaPctFixed.toFixed(2):"n/a"}% | ` +
    `ATR1h=${atr1hPctFixed!=null?atr1hPctFixed.toFixed(2):"n/a"}% | ` +
    `ΔVWAP1h=${deltaVWAP1h!=null?deltaVWAP1h.toFixed(3):"n/a"} | ` +
    `ΔVWAP4h=${deltaVWAP4h!=null?deltaVWAP4h.toFixed(3):"n/a"} | ` +
    `ΔOI=${deltaOIpct!=null?deltaOIpct.toFixed(3):"n/a"} | ` +
    `RSI(15m/1h/4h)=${num(rsi15,1)}/${num(rsi1h,1)}/${num(rsi4h,1)}`
  );

  return {
    symbol,
    last,
    volaPct: volaPctFixed,
    tend24,
    posDay,
    deltaVWAP1h,
    deltaVWAP4h,
    deltaOIpct,
    atr1hPct: atr1hPctFixed,
    atr4hPct: atr4hPctFixed,
    rsi: {
      "15m": rsi15!=null ? +num(rsi15,2) : null,
      "1h":  rsi1h!=null ? +num(rsi1h,2) : null,
      "4h":  rsi4h!=null ? +num(rsi4h,2) : null
    }
  };
}

// ========= SWING ENGINE =========
function calculateJDSSwing(rec){
  let score = 0;

  // RSI 15m extrêmes → énergie de swing
  if (rec.rsi["15m"] != null){
    if (rec.rsi["15m"] > 60) score += 12;
    if (rec.rsi["15m"] < 40) score += 12;
  }

  // Prix pas trop loin du VWAP 1h
  if (rec.deltaVWAP1h != null && Math.abs(rec.deltaVWAP1h) < 1.2) score += 10;

  // Construction / purge OI
  if (rec.deltaOIpct != null){
    if (rec.deltaOIpct >  1) score += 8;
    if (rec.deltaOIpct < -1) score += 8;
  }

  // ATR / Vola raisonnables
  if (rec.atr1hPct != null && rec.atr1hPct < MAX_ATR_1H)  score += 12;
  if (rec.volaPct  != null && rec.volaPct  < MAX_VOLA_24) score += 12;

  // Prix pas trop loin du VWAP 4h (swing macro cohérent)
  if (rec.deltaVWAP4h != null && Math.abs(rec.deltaVWAP4h) < MAX_VWAP_4H) score += 10;

  return score;
}

function detectDirection(rec, jds){
  if (rec.rsi["15m"] != null && rec.deltaVWAP1h != null){
    if (rec.rsi["15m"] > 55 && rec.deltaVWAP1h > 0) return "LONG";
    if (rec.rsi["15m"] < 45 && rec.deltaVWAP1h < 0) return "SHORT";
  }
  return "NEUTRAL";
}

function isTimingGood(rec, dir){
  if (rec.rsi["15m"] == null) return false;
  if (dir === "LONG")  return rec.rsi["15m"] > 55;
  if (dir === "SHORT") return rec.rsi["15m"] < 45;
  return false;
}

function shouldAvoid(rec){
  if (rec.atr1hPct != null && rec.atr1hPct > MAX_ATR_1H) return true;
  if (rec.volaPct  != null && rec.volaPct  > MAX_VOLA_24) return true;
  return false;
}

// 🔒 Filtre anti-top / anti-bottom (éviter d'entrer trop loin de la "fair value")
function isOverextended(rec, dir){
  const d1h = rec.deltaVWAP1h;
  const r1h = rec.rsi["1h"];

  if (dir === "LONG"){
    if (d1h != null && d1h > 3) return true;     // prix > +3% au-dessus VWAP 1h
    if (r1h != null && r1h > 70) return true;    // 1h en surachat
  }
  if (dir === "SHORT"){
    if (d1h != null && d1h < -3) return true;    // prix < -3% sous VWAP 1h
    if (r1h != null && r1h < 30) return true;    // 1h en survente extrême
  }
  return false;
}

// 📏 Levier dynamique en fonction de la vola 24h
function getRecommendedLeverage(volaPct){
  if (volaPct == null) return "3x";
  const v = Math.abs(volaPct);

  if (v < 3)  return "4x";
  if (v < 6)  return "3x";
  if (v < 10) return "2x";
  return "1x";
}

// Plan swing basé sur ATR 1h (~RR 2)
function buildPlan(rec, dir){
  const entry   = rec.last;
  const atrPerc = rec.atr1hPct != null ? rec.atr1hPct : 0.4; // fallback 0.4%
  const atrAbs  = entry * (atrPerc / 100);

  const sl = dir === "LONG" ? entry - atrAbs : entry + atrAbs;
  const tp = dir === "LONG" ? entry + atrAbs*2 : entry - atrAbs*2;

  return {
    entry: num(entry,4),
    sl:    num(sl,4),
    tp:    num(tp,4),
    rr:    2.0
  };
}

// Anti-spam Swing (par symbole+direction+state)
function shouldSend(symbol, dir, state){
  const key = `${symbol}-${dir}-${state}`;
  const now = Date.now();
  const last = lastAlerts.get(key);
  if (last && now-last < 30*60_000) return false; // 30min
  lastAlerts.set(key, now);
  return true;
}

// ===== SCAN =====
async function scanOnce(){
  const start = Date.now();
  console.log("🔍 [SWING] SCAN STARTED...");

  const snaps = [];
  for (let i=0;i<SYMBOLS.length;i+=5){
    const batch = SYMBOLS.slice(i,i+5);
    const res   = await Promise.all(
      batch.map(s => processSymbol(s).catch(()=>null))
    );
    for (const r of res) if (r) snaps.push(r);
    if (i+5 < SYMBOLS.length) await sleep(800);
  }

  const setups = [];

  for (const rec of snaps){
    const jds = calculateJDSSwing(rec);

    // 🔍 Log de calibration pour voir la distribution des scores
    console.log(`[SWING JDS] ${rec.symbol} => ${jds.toFixed(1)}`);

    if (jds < JDS_READY) continue;      // on garde que READY+

    if (shouldAvoid(rec)) continue;     // trop violent → no swing

    const dir = detectDirection(rec, jds);
    if (dir === "NEUTRAL") continue;
    if (!isTimingGood(rec, dir)) continue;

    // ❌ Filtre anti-top / anti-bottom (évite d'acheter après le pump comme BNB/XRP/LTC)
    if (isOverextended(rec, dir)){
      console.log(`[SWING FILTER] ${rec.symbol} ${dir} — OVEREXTENDED (ΔVWAP1h / RSI1h)`);
      continue;
    }

    const plan = buildPlan(rec, dir);
    const lev  = getRecommendedLeverage(rec.volaPct);

    const state = jds >= JDS_PRIME ? "PRIME" : "READY";

    setups.push({
      symbol: rec.symbol,
      dir,
      jds: +num(jds,1),
      state,
      entry: plan.entry,
      sl: plan.sl,
      tp: plan.tp,
      rr: plan.rr,
      leverage: lev,
      rec
    });
  }

  const duration = Date.now() - start;
  console.log(`[SWING] SCAN — ${SYMBOLS.length} PAIRS | ${duration} MS | ${setups.length} SETUP`);

  if (!setups.length) return;

  // On privilégie PRIME, sinon READY
  const prime  = setups.filter(s => s.state === "PRIME");
  const source = prime.length ? prime : setups;
  const label  = prime.length ? "PRIME" : "READY";

  // Top 3 setups max
  const chosen = source.sort((a,b)=>b.jds - a.jds).slice(0,3);

  let msg = `🎯 *JTF SWING v1.8 — ${label}*\n\n`;

  chosen.forEach((s,idx)=>{
    if (!shouldSend(s.symbol, s.dir, label)) return;
    const emoji = s.dir === "LONG" ? "📈" : "📉";

    msg += `*${idx+1}) ${s.symbol}*\n`;
    msg += `${emoji} *${s.dir}*\n`;
    msg += `💠 Entry: ${s.entry}\n`;
    msg += `🛡️ SL: ${s.sl}\n`;
    msg += `🎯 TP: ${s.tp}\n`;
    msg += `📏 Levier: ${s.leverage} — R:R ≈ ${s.rr.toFixed(1)}\n`;
    msg += `🔥 JDS-SWING: ${s.jds}\n`;
    msg += `📊 RSI 15m/1h/4h: ${s.rec.rsi["15m"]}/${s.rec.rsi["1h"]}/${s.rec.rsi["4h"]}\n`;
    msg += `📍 VWAP 1h/4h: ${s.rec.deltaVWAP1h}% / ${s.rec.deltaVWAP4h}%\n`;
    msg += `📉 ΔOI: ${s.rec.deltaOIpct}% | ATR1h: ${s.rec.atr1hPct}%\n\n`;
  });

  await sendTelegram(msg);
}

// ========= MAIN LOOP =========
export async function startSwing(){
  console.log("🔥 SWING v1.8 On");
  await sendTelegram("🟢 SWING v1.8 On");
  while(true){
    try{
      await scanOnce();
    }catch(e){
      console.error("[SWING ERROR]", e);
    }
    await sleep(SCAN_INTERVAL_MS);
  }
}