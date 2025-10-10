// snapshot_pro.js
// Version simple & robuste : 20 cryptos, résumé terminal + JSON/TXT, fallback API v2->v1, copie presse-papiers macOS.
// Aucune dépendance externe (utilise fetch natif de Node 18+).

const fs = require('fs');
const { execSync } = require('child_process');

const SYMBOLS = [
  "BTCUSDT_UMCBL",
  "ETHUSDT_UMCBL",
  "SOLUSDT_UMCBL",
  "XRPUSDT_UMCBL",
  "LINKUSDT_UMCBL",
  "AVAXUSDT_UMCBL",
  "ADAUSDT_UMCBL",
  "DOGEUSDT_UMCBL",
  "DOTUSDT_UMCBL",
  "BCHUSDT_UMCBL",
  "LTCUSDT_UMCBL",
  "APTUSDT_UMCBL",
  "OPUSDT_UMCBL",
  "ARBUSDT_UMCBL",
  "BNBUSDT_UMCBL",
  "ATOMUSDT_UMCBL",
  "INJUSDT_UMCBL",
  "SUIUSDT_UMCBL",
  "PEPEUSDT_UMCBL",
  "SEIUSDT_UMCBL"
];

const OUT_JSON = 'snapshot_pro.json';
const OUT_TXT  = 'snapshot_pro.txt';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function safeGetJson(url) {
  try {
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    const json = await res.json();
    return json;
  } catch (e) {
    console.error("⚠️ Fetch error:", e.message);
    return null;
  }
}

function baseSymbol(sym) {
  return sym.replace('_UMCBL', '');
}

// Fallback candles: d'abord v2, sinon v1
async function getCandles(symbol, seconds, limit = 200) {
  const base = baseSymbol(symbol);

  // v2
  const v2 = `https://api.bitget.com/api/v2/mix/market/candles?symbol=${base}&granularity=${seconds}&productType=usdt-futures&limit=${limit}`;
  let j = await safeGetJson(v2);
  if (j && j.data && Array.isArray(j.data) && j.data.length) {
    return j.data.map(c => ({
      t: +c[0],
      o: parseFloat(c[1]),
      h: parseFloat(c[2]),
      l: parseFloat(c[3]),
      c: parseFloat(c[4]),
      v: parseFloat(c[5]),
    })).sort((a,b)=>a.t-b.t);
  }

  // v1 fallback
  const v1 = `https://api.bitget.com/api/mix/v1/market/candles?symbol=${symbol}&granularity=${seconds}&limit=${limit}`;
  j = await safeGetJson(v1);
  if (j && j.data && Array.isArray(j.data) && j.data.length) {
    return j.data.map(c => ({
      t: +c[0],
      o: parseFloat(c[1]),
      h: parseFloat(c[2]),
      l: parseFloat(c[3]),
      c: parseFloat(c[4]),
      v: parseFloat(c[5]),
    })).sort((a,b)=>a.t-b.t);
  }

  console.error(`⚠️ Candles introuvables pour ${symbol} (${seconds}s)`);
  return [];
}

// Profondeur carnet (v1) pour calculer spread simple
async function getDepth(symbol, limit = 5) {
  const url = `https://api.bitget.com/api/mix/v1/market/depth?symbol=${symbol}&limit=${limit}`;
  const j = await safeGetJson(url);
  if (j && j.data && j.data.bids && j.data.asks) {
    const bids = j.data.bids.map(x => [parseFloat(x[0]), parseFloat(x[1])]);
    const asks = j.data.asks.map(x => [parseFloat(x[0]), parseFloat(x[1])]);
    return { bids, asks };
  }
  return { bids: [], asks: [] };
}

// Ticker/24h (v1)
async function getTicker(symbol) {
  const url = `https://api.bitget.com/api/mix/v1/market/ticker?symbol=${symbol}`;
  const j = await safeGetJson(url);
  if (j && j.data) return j.data;
  return null;
}

// Funding (v1)
async function getFunding(symbol) {
  const url = `https://api.bitget.com/api/mix/v1/market/currentFundRate?symbol=${symbol}`;
  const j = await safeGetJson(url);
  if (j && j.data) return j.data;
  return null;
}

// Open Interest (v1)
async function getOI(symbol) {
  const url = `https://api.bitget.com/api/mix/v1/market/open-interest?symbol=${symbol}`;
  const j = await safeGetJson(url);
  if (j && j.data) return j.data;
  return null;
}

// Indicateurs basiques
function ema(arr, period, accessor = (x)=>x) {
  if (!arr.length) return null;
  const k = 2/(period+1);
  let emaVal = accessor(arr[0]);
  for (let i=1;i<arr.length;i++){
    const v = accessor(arr[i]);
    emaVal = v*k + emaVal*(1-k);
  }
  return emaVal;
}

function rsi(closes, period=14) {
  if (closes.length < period+1) return null;
  let gains=0, losses=0;
  for (let i=1;i<=period;i++){
    const diff = closes[i]-closes[i-1];
    if (diff>=0) gains+=diff; else losses-=diff;
  }
  gains/=period; losses/=period || 1e-9;
  let rs = gains / losses;
  let r = 100 - 100/(1+rs);

  for (let i=period+1;i<closes.length;i++){
    const diff = closes[i]-closes[i-1];
    const gain = Math.max(diff,0);
    const loss = Math.max(-diff,0);
    gains = (gains*(period-1)+gain)/period;
    losses = (losses*(period-1)+loss)/period || 1e-9;
    rs = gains / losses;
    r = 100 - 100/(1+rs);
  }
  return r;
}

function percent(a,b){ // (a/b-1)*100
  if (!b) return 0;
  return (a/b - 1)*100;
}

function vwap(candles){
  let pv=0, v=0;
  for(const c of candles){
    const price=(c.h+c.l+c.c)/3;
    pv += price*c.v;
    v  += c.v;
  }
  return v? pv/v : null;
}

// Variation entre dernières close
function closeChangePct(candles, bars=1){
  if (candles.length < bars+1) return null;
  const a = candles[candles.length-1].c;
  const b = candles[candles.length-1-bars].c;
  return percent(a,b);
}

// Position du prix dans le range jour
function positionInDay(last, low24h, high24h){
  const rng = high24h - low24h;
  if (rng<=0) return null;
  return ((last - low24h) / rng) * 100;
}

// Volume profile très simple (bucket par pas dynamique)
function volumeNodes(candles, buckets=10){
  if (!candles.length) return [];
  const minP = Math.min(...candles.map(c=>c.l));
  const maxP = Math.max(...candles.map(c=>c.h));
  if (maxP<=minP) return [];
  const step = (maxP-minP)/buckets;
  const vols = new Array(buckets).fill(0);
  for(const c of candles){
    const p = c.c;
    let idx = Math.floor((p-minP)/step);
    if (idx>=buckets) idx=buckets-1;
    if (idx<0) idx=0;
    vols[idx]+=c.v;
  }
  const res = vols.map((v,i)=>({
    price: +(minP + (i+0.5)*step).toFixed(6),
    volume: +v.toFixed(2)
  }));
  res.sort((a,b)=>b.volume-a.volume);
  return res.slice(0,5);
}

async function processSymbol(symbol){
  // Ticker, Funding, OI
  const [tk, fr, oi] = await Promise.all([
    getTicker(symbol),
    getFunding(symbol),
    getOI(symbol)
  ]);

  if (!tk){
    console.error("⚠️ Erreur Bitget : Réponse invalide");
    return null;
  }

  const last = parseFloat(tk.last);
  const high24 = parseFloat(tk.high24h);
  const low24  = parseFloat(tk.low24h);
  const vol24  = parseFloat(tk.baseVolume);

  // Candles micro (1m, 5m) pour RSI/EMA/var
  const [c1m, c5m, c15m, c1h, c4h] = await Promise.all([
    getCandles(symbol, 60,  120),
    getCandles(symbol, 300, 120),
    getCandles(symbol, 900,  200),
    getCandles(symbol, 3600, 200),
    getCandles(symbol, 14400, 200)
  ]);

  // Profondeur (spread)
  const depth = await getDepth(symbol, 5);
  let spreadPct = null;
  if (depth.bids.length && depth.asks.length){
    const bestBid = depth.bids[0][0];
    const bestAsk = depth.asks[0][0];
    spreadPct = Math.abs((bestAsk - bestBid)/((bestAsk+bestBid)/2))*100;
  }

  // Indicateurs
  const closes1m = c1m.map(x=>x.c);
  const closes5m = c5m.map(x=>x.c);

  const ema20_1m = closes1m.length ? ema(c1m, 20, x=>x.c) : null;
  const ema20_5m = closes5m.length ? ema(c5m, 20, x=>x.c) : null;

  const rsi_1m = closes1m.length ? rsi(closes1m, 14) : null;
  const rsi_5m = closes5m.length ? rsi(closes5m, 14) : null;

  const var15m = c15m.length ? closeChangePct(c15m, 1) : null;
  const var1h  = c1h.length  ? closeChangePct(c1h,  1) : null;
  const var4h  = c4h.length  ? closeChangePct(c4h,  1) : null;

  const volaPct = last ? ((high24 - low24)/last)*100 : null;
  const tend24  = (high24>low24 && last) ? (((last-low24)/(high24-low24))*200 - 100) : null;

  const posDay  = positionInDay(last, low24, high24);
  const vwap1h  = vwap(c1h.slice(-48)); // approx 2 jours 1h
  const nodes1h = volumeNodes(c1h.slice(-120), 10); // top 5 nodes

  const fundingRate = fr ? parseFloat(fr.fundingRate) : null;
  const openInterest = oi ? parseFloat(oi.amount) : null;

  // Résumé lisible
  const line = [
    `• ${symbol.padEnd(13)} | P=${last} | 24h{H=${high24},L=${low24},Vol=${vol24}}`,
    `| Vola=${volaPct?volaPct.toFixed(2):'n/a'}% | Tend=${tend24?tend24.toFixed(2):'n/a'}%`,
    `| FR=${fundingRate??'n/a'} | OI=${openInterest??'n/a'}`,
    `| PosDay=${posDay?posDay.toFixed(2):'n/a'}%`,
    `| Spread=${spreadPct!==null?spreadPct.toFixed(4):'n/a'}%`,
    `| RSI{1m=${rsi_1m? rsi_1m.toFixed(2):'n/a'},5m=${rsi_5m? rsi_5m.toFixed(2):'n/a'}}`,
    `| EMA20{1m=${ema20_1m? ema20_1m.toFixed(6):'n/a'},5m=${ema20_5m? ema20_5m.toFixed(6):'n/a'}}`,
    `| Var{15m=${var15m!==null?var15m.toFixed(2):'n/a'}%,1h=${var1h!==null?var1h.toFixed(2):'n/a'}%,4h=${var4h!==null?var4h.toFixed(2):'n/a'}%}`,
    `| VWAP=${vwap1h? vwap1h.toFixed(6):'n/a'}`,
    nodes1h.length ? `| TopNodes=${nodes1h.map(n=>`${n.price}(${n.volume})`).join('|')}` : ''
  ].join(' ');

  // JSON compact & complet
  const out = {
    symbol,
    last,
    high24h: high24,
    low24h: low24,
    volume24h: vol24,
    volatilitePct: volaPct !== null ? +volaPct.toFixed(2) : null,
    tendance24h: tend24 !== null ? +tend24.toFixed(2) : null,
    fundingRate,
    openInterest,
    positionInDayPct: posDay !== null ? +posDay.toFixed(2) : null,
    spreadPct: spreadPct !== null ? +spreadPct.toFixed(5) : null,
    rsi: { "1m": rsi_1m!==null? +rsi_1m.toFixed(2): null, "5m": rsi_5m!==null? +rsi_5m.toFixed(2): null },
    ema20: { "1m": ema20_1m!==null? +ema20_1m.toFixed(6): null, "5m": ema20_5m!==null? +ema20_5m.toFixed(6): null },
    variationPct: {
      "15m": var15m!==null ? +var15m.toFixed(2) : null,
      "1h":  var1h !==null ? +var1h.toFixed(2)  : null,
      "4h":  var4h !==null ? +var4h.toFixed(2)  : null,
    },
    vwap1h: vwap1h!==null? +vwap1h.toFixed(6) : null,
    volumeProfile1hTop: nodes1h,
    timestamp: new Date().toISOString()
  };

  return { line, json: out };
}

async function main(){
  console.log("📡 Récupération microstructure (simple)…");

  const results = [];
  const lines = [];

  for (let i=0;i<SYMBOLS.length;i++){
    const s = SYMBOLS[i];
    const r = await processSymbol(s);
    if (r){
      lines.push(r.line);
      results.push(r.json);
    }
    // Anti-throttle léger
    await sleep(120);
  }

  // Sauvegardes
  fs.writeFileSync(OUT_JSON, JSON.stringify(results, null, 2));
  fs.writeFileSync(OUT_TXT, lines.join('\n'));

  // Affichage + copie macOS
  console.log("✅", OUT_JSON, "et", OUT_TXT, "générés.");
  try {
    execSync(`cat ${OUT_TXT} | pbcopy`, { stdio: 'ignore' });
    console.log("🧷 Résumé copié dans le presse-papiers (macOS).");
  } catch {
    // ignore si pas macOS
  }

  console.log("\n— APERÇU —");
  console.log(lines.slice(0, 8).join('\n'));
  if (lines.length > 8) console.log(`… (+${lines.length-8} lignes)`);
}

main().catch(e=>{
  console.error("Erreur fatale:", e);
  process.exit(1);
});
