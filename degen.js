// degen.js — v1.4 (Clean Output + Debug Control)

import fetch from "node-fetch";
import { DEBUG } from "./debug.js";

// ========= CONFIG =========
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

const SCAN_INTERVAL_MS = 2 * 60_000; // Degen = rapide
const MIN_ALERT_DELAY_MS = 3 * 60_000;

// ========= DEBUG =========
function logDebug(...args){
  if (DEBUG.global || DEBUG.degen){
    console.log("[DEGEN DEBUG]", ...args);
  }
}

// ========= SYMBOLS =========
const SYMBOLS = [
  "BTCUSDT_UMCBL","ETHUSDT_UMCBL","SOLUSDT_UMCBL","BNBUSDT_UMCBL",
  "AVAXUSDT_UMCBL","DOGEUSDT_UMCBL","XRPUSDT_UMCBL","LINKUSDT_UMCBL",
  "DOTUSDT_UMCBL","SUIUSDT_UMCBL","WIFUSDT_UMCBL","PEPEUSDT_UMCBL",
  "TIAUSDT_UMCBL","INJUSDT_UMCBL","APTUSDT_UMCBL","TONUSDT_UMCBL"
];

// ========= STATE =========
const lastAlerts = new Map();

// ========= UTIL =========
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = (v,d=4)=>v==null?null:+(+v).toFixed(d);
const baseSymbol = s => s.replace("_UMCBL","");

async function safeGetJson(url){
  try{
    const r = await fetch(url, {headers:{Accept:"application/json"}});
    return r.ok ? await r.json() : null;
  }catch(e){
    logDebug("safeGetJson FAIL", url, e);
    return null;
  }
}

async function getTicker(symbol){
  logDebug("getTicker", symbol);
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/ticker?symbol=${baseSymbol(symbol)}&productType=usdt-futures`
  );
  return Array.isArray(j?.data) ? j.data[0] : j?.data ?? null;
}

async function getCandles(symbol,sec,limit=40){
  logDebug("getCandles", symbol, sec);
  const j = await safeGetJson(
    `https://api.bitget.com/api/v2/mix/market/candles?symbol=${baseSymbol(symbol)}&granularity=${sec}&limit=${limit}&productType=usdt-futures`
  );
  return j?.data ? j.data.map(c=>({
    t:+c[0], o:+c[1], h:+c[2], l:+c[3], c:+c[4], v:+c[5]
  })).sort((a,b)=>a.t-b.t) : [];
}

function percent(a,b){
  return b ? ((a/b)-1)*100 : null;
}

function closeChange(c,b=1){
  if(c.length < b+1) return null;
  return percent(c[c.length-1].c, c[c.length-1-b].c);
}

function rsi(cl,p=14){
  if(cl.length<p+1) return null;
  let g=0,l=0;
  for(let i=1;i<=p;i++){
    const d=cl[i]-cl[i-1];
    d>=0 ? g+=d : l-=d;
  }
  g/=p; l=(l/p)||1e-9;
  let rs=g/l; let v=100-100/(1+rs);
  for(let i=p+1;i<cl.length;i++){
    const d=cl[i]-cl[i-1];
    const G=Math.max(d,0), L=Math.max(-d,0);
    g=(g*(p-1)+G)/p;
    l=((l*(p-1)+L)/p)||1e-9;
    rs=g/l; v=100-100/(1+rs);
  }
  return v;
}

// ========= STRONG SETUP DEGEN =========
// Conditions agressives mais ultra filtrées
function isDegenSetup(rec){
  if(!rec) return false;

  const dp1  = rec.dP_1m;
  const dp5  = rec.dP_5m;
  const rsi1 = rec.rsi1m;

  // Explosion 1m + cohérence 5m + RSI confirmé
  if(dp1 > 0.35 && dp5 > 0.20 && rsi1 < 35) return "LONG";
  if(dp1 < -0.35 && dp5 < -0.20 && rsi1 > 70) return "SHORT";

  return false;
}

// ========= PROCESS SYMBOL =========
async function processSymbol(symbol){
  logDebug("processSymbol", symbol);

  const [tk,c1m,c5m] = await Promise.all([
    getTicker(symbol),
    getCandles(symbol,60,40),
    getCandles(symbol,300,40)
  ]);

  if(!tk || !c1m.length || !c5m.length) return null;

  const last = tk.lastPr ?? tk.markPrice ?? tk.last ?? null;
  const closes1 = c1m.map(x=>x.c);

  const dP1m = closeChange(c1m);
  const dP5m = closeChange(c5m);
  const rsi1m = rsi(closes1);

  return {
    symbol,
    last,
    dP_1m: num(dP1m,3),
    dP_5m: num(dP5m,3),
    rsi1m: num(rsi1m,2)
  };
}

// ========= ANTI-SPAM =========
function shouldSend(symbol,dir){
  const key = `${symbol}-${dir}`;
  const now = Date.now();
  const last = lastAlerts.get(key);

  if(!last){
    lastAlerts.set(key,now);
    return true;
  }

  if(now-last < MIN_ALERT_DELAY_MS) return false;

  lastAlerts.set(key,now);
  return true;
}

// ========= TELEGRAM =========
async function sendTelegram(text){
  if(!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try{
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,{
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body:JSON.stringify({chat_id:TELEGRAM_CHAT_ID,text,parse_mode:"Markdown"})
    });
  }catch(e){}
}

// ========= SCAN =========
async function scanOnce(){
  console.log("⚡ DEGEN scan…");

  const snapshots=[];
  const BATCH = 4;

  for(let i=0;i<SYMBOLS.length;i+=BATCH){
    const batch = SYMBOLS.slice(i,i+BATCH);
    const res = await Promise.all(batch.map(s=>processSymbol(s).catch(()=>null)));
    for(const r of res) if(r) snapshots.push(r);
    await sleep(300);
  }

  const signals=[];
  for(const rec of snapshots){
    const dir = isDegenSetup(rec);
    if(dir){
      signals.push({...rec, direction:dir});
    }
  }

  console.log(`DEGEN: ${snapshots.length} pairs | ${signals.length} setups`);

  if(!signals.length) return;

  // Envoi des signaux valides
  for(const s of signals){
    if(!shouldSend(s.symbol, s.direction)) continue;

    const emoji = s.direction==="LONG" ? "⚡🚀" : "⚡🪂";
    const msg =
`${emoji} ${s.direction} — ${s.symbol}

Entry: ${s.last}
dP 1m: ${s.dP_1m}%
dP 5m: ${s.dP_5m}%
RSI 1m: ${s.rsi1m}`;

    await sendTelegram(msg);
  }
}

// ========= MAIN =========
export async function startDegen(){
  console.log("🚀 DEGEN v1.4 started.");
  await sendTelegram("🟢 Degen ON.");
  while(true){
    try{
      await scanOnce();
    }catch(e){
      console.log("[DEGEN ERROR]", e);
    }
    await sleep(SCAN_INTERVAL_MS);
  }
}