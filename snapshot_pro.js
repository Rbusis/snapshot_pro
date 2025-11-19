// snapshot_pro_TOP30v2.js
// Version 6.7 PRO : TOP30 Bitget USDT Perp
// - VWAP, ΔVWAP, OI, ΔOI, RSI, EMA, Var
// - ΔP_1m, ΔP_5m, ΔP_15m
// - Judicious Score (long/short) en 0–100
// - Volatility Spike Tag
// - Setup Ready Tags (READY_LONG / READY_SHORT)
// - Auto best LONG / best SHORT suggestion
//
// Node.js 18+ (fetch natif). Aucune dépendance externe.

const fs = require('fs');
const { execSync } = require('child_process');

// ====== Configuration sortie ======
const OUT_JSON = 'snapshot_pro.json';
const OUT_TXT  = 'snapshot_pro.txt';
const OUT_PREV = 'snapshot_pro_prev.json'; // mémorise { symbol: { oi, ts } }

// ====== Liste des 30 paires (USDT Perp Bitget) ======
const SYMBOLS = [
  "BTCUSDT_UMCBL",
  "ETHUSDT_UMCBL",
  "BNBUSDT_UMCBL",
  "SOLUSDT_UMCBL",
  "XRPUSDT_UMCBL",
  "ADAUSDT_UMCBL",
  "DOGEUSDT_UMCBL",
  "AVAXUSDT_UMCBL",
  "DOTUSDT_UMCBL",
  "TRXUSDT_UMCBL",
  "LINKUSDT_UMCBL",
  "TONUSDT_UMCBL",
  "SUIUSDT_UMCBL",
  "APTUSDT_UMCBL",
  "NEARUSDT_UMCBL",
  "ARBUSDT_UMCBL",
  "OPUSDT_UMCBL",
  "INJUSDT_UMCBL",
  "ATOMUSDT_UMCBL",
  "AAVEUSDT_UMCBL",
  "LTCUSDT_UMCBL",
  "UNIUSDT_UMCBL",
  "FILUSDT_UMCBL",
  "XLMUSDT_UMCBL",
  "RUNEUSDT_UMCBL",
  "ALGOUSDT_UMCBL",
  "PEPEUSDT_UMCBL",
  "WIFUSDT_UMCBL",
  "TIAUSDT_UMCBL",
  "SEIUSDT_UMCBL"
];

// ====== CLI support (range + options) ======
const args = process.argv.slice(2);
let rangeFrom = 0;
let rangeTo   = SYMBOLS.length;
let noClipboard = false;

for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--from=")) rangeFrom = parseInt(args[i].split("=")[1]);
  if (args[i].startsWith("--to="))   rangeTo   = parseInt(args[i].split("=")[1]);
  if (args[i] === "--no-clip" || args[i] === "--no-clipboard") noClipboard = true;
}

// ====== Utils ======
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const num = (v, d = 6) => (v === null || v === undefined || Number.isNaN(+v)) ? null : +(+v).toFixed(d);
const clamp = (x, min, max) => Math.max(min, Math.min(max, x));

function baseSymbol(sym) { 
  return sym.replace('_UMCBL', ''); 
}

// Safe GET JSON silencieux (pas de logs, pour la vitesse)
async function safeGetJson(url) {
  try {
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ---- Market data helpers ----
async function getCandles(symbol, seconds, limit = 400) {
  const base = baseSymbol(symbol);
  // v2
  const v2 = `https://api.bitget.com/api/v2/mix/market/candles?symbol=${base}&granularity=${seconds}&productType=usdt-futures&limit=${limit}`;
  let j = await safeGetJson(v2);
  if (j && j.data && Array.isArray(j.data) && j.data.length) {
    return j.data
      .map(c => ({ t:+c[0], o:+c[1], h:+c[2], l:+c[3], c:+c[4], v:+c[5] }))
      .sort((a,b)=>a.t-b.t);
  }
  // v1 fallback
  const v1 = `https://api.bitget.com/api/mix/v1/market/candles?symbol=${symbol}&granularity=${seconds}&limit=${limit}`;
  j = await safeGetJson(v1);
  if (j && j.data && Array.isArray(j.data) && j.data.length) {
    return j.data
      .map(c => ({ t:+c[0], o:+c[1], h:+c[2], l:+c[3], c:+c[4], v:+c[5] }))
      .sort((a,b)=>a.t-b.t);
  }
  return [];
}

async function getDepth(symbol, limit = 5) {
  const url = `https://api.bitget.com/api/mix/v1/market/depth?symbol=${symbol}&limit=${limit}`;
  const j = await safeGetJson(url);
  if (j && j.data && j.data.bids && j.data.asks) {
    const bids = j.data.bids.map(x => [+x[0], +x[1]]);
    const asks = j.data.asks.map(x => [+x[0], +x[1]]);
    return { bids, asks };
  }
  return { bids: [], asks: [] };
}

async function getTicker(symbol) {
  const url = `https://api.bitget.com/api/mix/v1/market/ticker?symbol=${symbol}`;
  const j = await safeGetJson(url);
  return j && j.data ? j.data : null;
}

// Mark price
async function getMarkPrice(symbol) {
  const url = `https://api.bitget.com/api/mix/v1/market/mark-price?symbol=${symbol}`;
  const j = await safeGetJson(url);
  if (j && j.data && (j.data.markPrice || j.data.markPrice === 0)) {
    return +j.data.markPrice;
  }
  const tk = await getTicker(symbol);
  if (tk && tk.markPrice) return +tk.markPrice;
  return null;
}

// Funding *silencieux* (si ça échoue, FR = null)
async function getFunding(symbol) {
  const url = `https://api.bitget.com/api/mix/v1/market/currentFundRate?symbol=${symbol}`;
  const j = await safeGetJson(url);
  return j && j.data ? j.data : null;
}

async function getOI(symbol) {
  const url = `https://api.bitget.com/api/mix/v1/market/open-interest?symbol=${symbol}`;
  const j = await safeGetJson(url);
  return j && j.data ? j.data : null;
}

// ---- Indicators ----
function ema(arr, period, accessor = (x)=>x) {
  if (!arr.length) return null;
  const k = 2/(period+1);
  let emaVal = accessor(arr[0]);
  for (let i = 1; i < arr.length; i++) {
    const v = accessor(arr[i]);
    emaVal = v * k + emaVal * (1 - k);
  }
  return emaVal;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains=0, losses=0;
  for (let i=1; i<=period; i++) {
    const diff = closes[i] - closes[i-1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  gains /= period;
  losses = (losses / period) || 1e-9;
  let rs = gains / losses;
  let r = 100 - 100/(1+rs);
  for (let i=period+1; i<closes.length; i++) {
    const diff = closes[i] - closes[i-1];
    const gain = Math.max(diff,0);
    const loss = Math.max(-diff,0);
    gains = (gains*(period-1)+gain)/period;
    losses = ((losses*(period-1)+loss)/period) || 1e-9;
    rs = gains / losses;
    r = 100 - 100/(1+rs);
  }
  return r;
}

function percent(a,b){ 
  return b ? (a/b - 1)*100 : null; 
}

function vwap(candles) {
  let pv=0, v=0;
  for (const c of candles) {
    const p = (c.h + c.l + c.c) / 3;
    pv += p * c.v;
    v += c.v;
  }
  return v ? pv/v : null;
}

function closeChangePct(candles, bars = 1) {
  if (candles.length < bars + 1) return null;
  const a = candles[candles.length - 1].c;
  const b = candles[candles.length - 1 - bars].c;
  return percent(a, b);
}

function positionInDay(last, low24h, high24h) {
  const r = high24h - low24h;
  if (r <= 0 || last === null) return null;
  return ((last - low24h) / r) * 100;
}

function volumeNodes(candles, buckets = 10) {
  if (!candles.length) return [];
  const minP = Math.min(...candles.map(c => c.l));
  const maxP = Math.max(...candles.map(c => c.h));
  if (maxP <= minP) return [];
  const step = (maxP - minP) / buckets;
  const vols = new Array(buckets).fill(0);
  for (const c of candles) {
    const p = c.c;
    let idx = Math.floor((p - minP) / step);
    if (idx >= buckets) idx = buckets - 1;
    if (idx < 0) idx = 0;
    vols[idx] += c.v;
  }
  const res = vols.map((v,i)=>({
    price:+(minP + (i + 0.5) * step).toFixed(6),
    volume:+v.toFixed(2)
  }));
  res.sort((a,b)=>b.volume - a.volume);
  return res.slice(0,5);
}

// ---- Persist ΔOI helpers ----
function loadPrevOIMap() {
  try {
    const raw = fs.readFileSync(OUT_PREV, 'utf-8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function savePrevOIMap(map) {
  try {
    fs.writeFileSync(OUT_PREV, JSON.stringify(map, null, 2));
  } catch (e) {
    console.error("⚠️ Impossible d'écrire", OUT_PREV, e.message);
  }
}

// ---- Helper conversion : score [-1,1] → JDS [0,100] ----
function toScore100(x) {
  if (x === null || x === undefined || Number.isNaN(x)) return null;
  const z = (x + 1) / 2; // -1..1 -> 0..1
  return clamp(z * 100, 0, 100);
}

// ---- Core symbol processing ----
async function processSymbol(symbol, prevOIMap) {
  const [tk, fr, oi] = await Promise.all([
    getTicker(symbol), 
    getFunding(symbol), 
    getOI(symbol)
  ]);
  if (!tk) return null;

  const last   = +tk.last;
  const high24 = +tk.high24h;
  const low24  = +tk.low24h;
  const vol24  = +tk.baseVolume;

  const [c1m, c5m, c15m, c1h, c4h] = await Promise.all([
    getCandles(symbol, 60,   120),
    getCandles(symbol, 300,  120),
    getCandles(symbol, 900,  400),
    getCandles(symbol, 3600, 400),
    getCandles(symbol, 14400, 400)
  ]);

  const [depth, markPrice] = await Promise.all([
    getDepth(symbol,5), 
    getMarkPrice(symbol)
  ]);

  let spreadPct = null;
  if (depth.bids.length && depth.asks.length) {
    const b = depth.bids[0][0];
    const a = depth.asks[0][0];
    spreadPct = ((a - b) / ((a + b) / 2)) * 100;
    if (spreadPct < 0) spreadPct = -spreadPct;
  }

  const closes1m  = c1m.map(x => x.c);
  const closes5m  = c5m.map(x => x.c);
  const closes15m = c15m.map(x => x.c);
  const closes1h  = c1h.map(x => x.c);
  const closes4h  = c4h.map(x => x.c);

  const ema20_1m = ema(c1m, 20, x => x.c);
  const ema20_5m = ema(c5m, 20, x => x.c);

  const rsi_1m  = rsi(closes1m, 14);
  const rsi_5m  = rsi(closes5m, 14);
  const rsi_15m = rsi(closes15m,14);
  const rsi_1h  = rsi(closes1h, 14);
  const rsi_4h  = rsi(closes4h, 14);

  const var15m = closeChangePct(c15m, 1);
  const var1h  = closeChangePct(c1h, 1);
  const var4h  = closeChangePct(c4h, 1);

  // ΔP court terme
  const dP_1m  = closeChangePct(c1m, 1);
  const dP_5m  = closeChangePct(c5m, 1);   // 1 bar de 5m
  const dP_15m = closeChangePct(c15m, 1);  // 1 bar de 15m

  const volaPct = (last && high24 && low24) ? ((high24 - low24) / last) * 100 : null;
  const tend24  = (high24 > low24 && last) ? (((last - low24) / (high24 - low24)) * 200 - 100) : null;
  const posDay  = positionInDay(last, low24, high24);

  const fundingRate  = fr ? +fr.fundingRate * 100 : null;
  const openInterest = oi ? +oi.amount : null;

  const vwap1h    = vwap(c1h.slice(-48));
  const deltaVWAP = (vwap1h && last) ? percent(last, vwap1h) : null;

  // ΔOI vs précédent snapshot
  const prev    = prevOIMap[symbol]?.oi ?? null;
  const deltaOI = (openInterest !== null && prev !== null && prev !== 0)
    ? ((openInterest - prev) / prev) * 100
    : null;

  const nodes1h = volumeNodes(c1h.slice(-120), 10);
  const ts = new Date().toISOString();

  // ====== Judicious Score (momentum / mean reversion) ======
  // Normalisations symétriques [-1,1]
  const normLongFromDelta  = (dp) => dp === null ? 0 : clamp(-dp / 2, -1, 1); // -2% -> +1
  const normShortFromDelta = (dp) => dp === null ? 0 : clamp(dp / 2,  -1, 1); // +2% -> +1

  const m5L   = normLongFromDelta(dP_5m);
  const m15L  = normLongFromDelta(dP_15m);
  const m5S   = normShortFromDelta(dP_5m);
  const m15S  = normShortFromDelta(dP_15m);

  const dvwapL = deltaVWAP !== null ? clamp(-deltaVWAP / 2, -1, 1) : 0;
  const dvwapS = deltaVWAP !== null ? clamp( deltaVWAP / 2, -1, 1) : 0;

  const rsiL = rsi_15m !== null ? clamp((50 - rsi_15m) / 20, -1, 1) : 0; // 30 -> +1, 70 -> -1
  const rsiS = rsi_15m !== null ? clamp((rsi_15m - 50) / 20, -1, 1) : 0; // 70 -> +1, 30 -> -1

  // Poids : 40% ΔP15m, 20% ΔP5m, 20% ΔVWAP, 20% RSI15m
  const scoreLongRaw  = (m15L * 0.4) + (m5L * 0.2) + (dvwapL * 0.2) + (rsiL * 0.2);
  const scoreShortRaw = (m15S * 0.4) + (m5S * 0.2) + (dvwapS * 0.2) + (rsiS * 0.2);

  // Conversion en 0–100 (JDS utilisable par ton agent : seuil 80, etc.)
  const scoreLong100  = toScore100(scoreLongRaw);
  const scoreShort100 = toScore100(scoreShortRaw);

  // ====== Setup Ready Tags (pré-filtrage très simple, pas décision finale) ======
  const readyLong =
    scoreLong100 !== null && scoreLong100 >= 80 &&
    deltaVWAP !== null && deltaVWAP <= -1.2 &&
    rsi_15m !== null && rsi_15m <= 40 &&
    deltaOI !== null && deltaOI >= 0.5;

  const readyShort =
    scoreShort100 !== null && scoreShort100 >= 80 &&
    deltaVWAP !== null && deltaVWAP >= 1.2 &&
    rsi_15m !== null && rsi_15m >= 60 &&
    deltaOI !== null && deltaOI >= 0.5;

  let setupLabel = null;
  if (readyLong && readyShort) setupLabel = 'READY_LONG_SHORT';
  else if (readyLong)          setupLabel = 'READY_LONG';
  else if (readyShort)         setupLabel = 'READY_SHORT';

  // ====== Volatility Spike Tag ======
  const spikeTags = [];
  if (dP_1m  !== null && Math.abs(dP_1m)  >= 0.25) spikeTags.push('ΔP1m');
  if (dP_5m  !== null && Math.abs(dP_5m)  >= 0.8)  spikeTags.push('ΔP5m');
  if (dP_15m !== null && Math.abs(dP_15m) >= 1.5) spikeTags.push('ΔP15m');
  const volatilitySpike = spikeTags.length ? spikeTags.join(',') : null;

  // -------- line (TXT) --------
  const lineParts = [
    `• ${symbol.padEnd(13)} |`,
    `P=${num(last,6)} |`,
    `Mark=${markPrice!==null?num(markPrice,6):'n/a'} |`,
    `VWAP=${vwap1h!==null?num(vwap1h,6):'n/a'} |`,
    `ΔVWAP=${deltaVWAP!==null?num(deltaVWAP,2):'n/a'}% |`,
    `ΔP{1m=${dP_1m!==null?num(dP_1m,2):'n/a'}%,5m=${dP_5m!==null?num(dP_5m,2):'n/a'}%,15m=${dP_15m!==null?num(dP_15m,2):'n/a'}%} |`,
    `OI=${openInterest!==null?num(openInterest,2):'n/a'} |`,
    `ΔOI=${deltaOI!==null?num(deltaOI,2):'n/a'}% |`,
    `FR=${fundingRate!==null?num(fundingRate,4):'n/a'}% |`,
    `24h{H=${num(high24,6)},L=${num(low24,6)},Vol=${num(vol24,6)}} |`,
    `Vola=${volaPct!==null?num(volaPct,2):'n/a'}% |`,
    `Tend=${tend24!==null?num(tend24,2):'n/a'}% |`,
    `PosDay=${posDay!==null?num(posDay,2):'n/a'}% |`,
    `Spread=${spreadPct!==null?num(spreadPct,4):'n/a'}% |`,
    `RSI{1m=${rsi_1m!==null?num(rsi_1m,2):'n/a'},5m=${rsi_5m!==null?num(rsi_5m,2):'n/a'},15m=${rsi_15m!==null?num(rsi_15m,2):'n/a'},1h=${rsi_1h!==null?num(rsi_1h,2):'n/a'},4h=${rsi_4h!==null?num(rsi_4h,2):'n/a'}} |`,
    `EMA20{1m=${ema20_1m!==null?num(ema20_1m,6):'n/a'},5m=${ema20_5m!==null?num(ema20_5m,6):'n/a'}} |`,
    `Var{15m=${var15m!==null?num(var15m,2):'n/a'}%,1h=${var1h!==null?num(var1h,2):'n/a'}%,4h=${var4h!==null?num(var4h,2):'n/a'}%} |`,
    `JDS{L=${scoreLong100!==null?num(scoreLong100,1):'n/a'},S=${scoreShort100!==null?num(scoreShort100,1):'n/a'}}`,
    nodes1h.length ? `| TopNodes=${nodes1h.map(n=>`${n.price}(${n.volume})`).join('|')}` : '',
    volatilitySpike ? `| Spike=${volatilitySpike}` : '',
    setupLabel ? `| Setup=${setupLabel}` : '',
    `| Ts=${ts}`
  ];
  const line = lineParts.filter(Boolean).join(' ');

  // -------- json --------
  const out = {
    symbol,
    last: num(last,8),
    markPrice: markPrice!==null?num(markPrice,8):null,
    high24h: num(high24,8),
    low24h: num(low24,8),
    volume24h: num(vol24,8),
    volatilitePct: volaPct!==null?num(volaPct,2):null,
    tendance24h: tend24!==null?num(tend24,2):null,
    fundingRatePct: fundingRate!==null?num(fundingRate,6):null,
    openInterest: openInterest!==null?num(openInterest,6):null,
    deltaOIpct: deltaOI!==null?num(deltaOI,4):null,
    positionInDayPct: posDay!==null?num(posDay,2):null,
    spreadPct: spreadPct!==null?num(spreadPct,5):null,
    rsi: {
      "1m":  rsi_1m!==null?num(rsi_1m,2):null,
      "5m":  rsi_5m!==null?num(rsi_5m,2):null,
      "15m": rsi_15m!==null?num(rsi_15m,2):null,
      "1h":  rsi_1h!==null?num(rsi_1h,2):null,
      "4h":  rsi_4h!==null?num(rsi_4h,2):null
    },
    ema20: {
      "1m": ema20_1m!==null?num(ema20_1m,6):null,
      "5m": ema20_5m!==null?num(ema20_5m,6):null
    },
    variationPct: {
      "15m": var15m!==null?num(var15m,2):null,
      "1h":  var1h!==null?num(var1h,2):null,
      "4h":  var4h!==null?num(var4h,2):null
    },
    vwap1h: vwap1h!==null?num(vwap1h,6):null,
    deltaVWAPpct: deltaVWAP!==null?num(deltaVWAP,4):null,
    deltaPricePct: {
      "1m":  dP_1m!==null?num(dP_1m,4):null,
      "5m":  dP_5m!==null?num(dP_5m,4):null,
      "15m": dP_15m!==null?num(dP_15m,4):null
    },
    // JDS en 0–100 (à utiliser dans le JTF)
    judiciousScore: {
      long:  scoreLong100!==null?num(scoreLong100,1):null,
      short: scoreShort100!==null?num(scoreShort100,1):null
    },
    // Version brute [-1,1] gardée pour debug / backtest
    judiciousScoreRaw: {
      long:  num(scoreLongRaw,3),
      short: num(scoreShortRaw,3)
    },
    setupReady: {
      long: readyLong,
      short: readyShort,
      label: setupLabel
    },
    volatilitySpike: volatilitySpike,
    volumeProfile1hTop: nodes1h,
    timestamp: ts
  };

  const nextPrev = { oi: openInterest ?? null, ts };
  return { line, json: out, nextPrev };
}

// ---- Main ----
async function main() {
  console.log("📡 Snapshot Bitget TOP30 v6.7 PRO (Setup Tags)...");
  const prevOIMap   = loadPrevOIMap();
  const nextPrevMap = {};
  const results = [];
  const lines   = [];

  const slice = SYMBOLS.slice(rangeFrom, rangeTo);
  console.log(`🔁 Traitement de ${slice.length} cryptos (range ${rangeFrom}-${rangeTo})…`);

  for (const s of slice) {
    try {
      const r = await processSymbol(s, prevOIMap);
      if (r) {
        lines.push(r.line);
        results.push(r.json);
        nextPrevMap[s] = { oi: r.nextPrev.oi, ts: r.nextPrev.ts };
      }
    } catch (e) {
      console.error(`Erreur sur ${s}:`, e.message);
    }
    await sleep(140); // léger spacing pour calmer l'API Bitget
  }

  // Sauvegarde snapshots
  fs.writeFileSync(OUT_JSON, JSON.stringify(results, null, 2));
  fs.writeFileSync(OUT_TXT, lines.join('\n'));
  savePrevOIMap(nextPrevMap);

  console.log(`✅ ${results.length}/${slice.length} cryptos traitées.`);

  // ====== Détection best LONG / best SHORT ======
  let bestLong = null;
  let bestShort = null;

  for (const r of results) {
    const js = r.judiciousScore;
    if (!js) continue;
    if (js.long !== null && (bestLong === null || js.long > bestLong.judiciousScore.long)) {
      bestLong = r;
    }
    if (js.short !== null && (bestShort === null || js.short > bestShort.judiciousScore.short)) {
      bestShort = r;
    }
  }

  if (bestLong) {
    console.log(
      `💡 Best LONG: ${bestLong.symbol} | JScoreL=${bestLong.judiciousScore.long} | ` +
      `ΔP15m=${bestLong.deltaPricePct["15m"]}% | RSI15m=${bestLong.rsi["15m"]} | ΔVWAP=${bestLong.deltaVWAPpct}%` +
      (bestLong.volatilitySpike ? ` | Spike=${bestLong.volatilitySpike}` : '') +
      (bestLong.setupReady && bestLong.setupReady.label ? ` | Setup=${bestLong.setupReady.label}` : '')
    );
  }

  if (bestShort) {
    console.log(
      `💡 Best SHORT: ${bestShort.symbol} | JScoreS=${bestShort.judiciousScore.short} | ` +
      `ΔP15m=${bestShort.deltaPricePct["15m"]}% | RSI15m=${bestShort.rsi["15m"]} | ΔVWAP=${bestShort.deltaVWAPpct}%` +
      (bestShort.volatilitySpike ? ` | Spike=${bestShort.volatilitySpike}` : '') +
      (bestShort.setupReady && bestShort.setupReady.label ? ` | Setup=${bestShort.setupReady.label}` : '')
    );
  }

  // Copie presse-papiers (Mac) sauf si désactivé
  if (!noClipboard) {
    try {
      execSync(`cat ${OUT_TXT} | pbcopy`, { stdio: 'ignore' });
      console.log("🧷 Résumé copié dans le presse-papiers (macOS).");
    } catch {
      // pas grave si pbcopy n'existe pas
    }
  } else {
    console.log("📎 Option --no-clip active : pas de copie dans le presse-papiers.");
  }

  // Aperçu console (8 premières lignes)
  console.log(lines.slice(0,8).join('\n'));
  if (lines.length > 8) {
    console.log(`…(+${lines.length-8} lignes)`);
  }
}

main().catch(e => {
  console.error("Erreur fatale:", e);
  process.exit(1);
});