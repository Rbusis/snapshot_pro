
// ======== Version 6.1 Enhancements ========
// Retry wrapper (3 tries)
async function safeGetJson(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (res.ok) return await res.json();
    } catch {}
    await sleep(200 * (i + 1));
  }
  console.error("⚠️ Fetch failed:", url);
  return null;
}



// Modify main() to handle partial range + retry for missing

// snapshot_prov2_final_top50.js
// Version améliorée (Top50) : Ts + OI + Price + VWAP + ΔVWAP + Mark + ΔOI + FR%,
// avec fallback API v2->v1, résumé texte/JSON, et persistance ΔOI via fichier précédent.
// Requis: Node.js 18+ (fetch natif). Aucune dépendance externe.

const fs = require('fs');
const { execSync } = require('child_process');

// ====== Configuration ======
const OUT_JSON = 'snapshot_pro.json';
const OUT_TXT  = 'snapshot_pro.txt';
const OUT_PREV = 'snapshot_pro_prev.json'; // mémorise { symbol: { oi, ts } } pour ΔOI

// Liste de symboles (USDT Perp Bitget) — 50 paires
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
  "ARBUSDT_UMCBL",
  "OPUSDT_UMCBL",
  "SUIUSDT_UMCBL",
  "INJUSDT_UMCBL",
  "ATOMUSDT_UMCBL",
  "APTUSDT_UMCBL",
  "NEARUSDT_UMCBL",
  "GRTUSDT_UMCBL",
  "LTCUSDT_UMCBL",
  "BCHUSDT_UMCBL",
  "LINKUSDT_UMCBL",
  "HBARUSDT_UMCBL",
  "EGLDUSDT_UMCBL",
  "ICPUSDT_UMCBL",
  "VETUSDT_UMCBL",
  "FILUSDT_UMCBL",
  "AAVEUSDT_UMCBL",
  "PEPEUSDT_UMCBL",
  "SHIBUSDT_UMCBL",
  "WIFUSDT_UMCBL",
  "DOGSUSDT_UMCBL",
  "POPCATUSDT_UMCBL",
  "PORTALUSDT_UMCBL",
  "TAOUSDT_UMCBL",
  "ACEUSDT_UMCBL",
  "ARKUSDT_UMCBL",
  "SEIUSDT_UMCBL",
  "ASTERUSDT_UMCBL",
  "ALTUSDT_UMCBL",
  "AGLDUSDT_UMCBL",
  "APEUSDT_UMCBL",
  "ARPAUSDT_UMCBL",
  "AXLUSDT_UMCBL",
  "BNTUSDT_UMCBL",
  "BEAMUSDT_UMCBL",
  "BOMEUSDT_UMCBL",
  "BSVUSDT_UMCBL",
  "CAKEUSDT_UMCBL",
  "CELRUSDT_UMCBL",
  "CTKUSDT_UMCBL",
  "CYBERUSDT_UMCBL",
  "CVXUSDT_UMCBL",
  "DENTUSDT_UMCBL",
  "DYMUSDT_UMCBL",
  "FLOKIUSDT_UMCBL",
  "HFTUSDT_UMCBL",
  "IOTXUSDT_UMCBL",
  "JTOUSDT_UMCBL",
  "LPTUSDT_UMCBL",
  "MAVUSDT_UMCBL",
  "MEMEUSDT_UMCBL",
  "METISUSDT_UMCBL",
  "NFPUSDT_UMCBL",
  "NKNUSDT_UMCBL",
  "OGNUSDT_UMCBL",
  "ORDIUSDT_UMCBL",
  "PENDLEUSDT_UMCBL",
  "PHBUSDT_UMCBL",
  "QNTUSDT_UMCBL",
  "SKLUSDT_UMCBL",
  "SLPUSDT_UMCBL",
  "SPELLUSDT_UMCBL",
  "TIAUSDT_UMCBL",
  "TONUSDT_UMCBL",
  "TURBOUSDT_UMCBL",
  "UMAUSDT_UMCBL",
  "WAXPUSDT_UMCBL",
  "WLDUSDT_UMCBL",
  "XAIUSDT_UMCBL",
  "XECUSDT_UMCBL",
  "XVGUSDT_UMCBL",
  "YGGUSDT_UMCBL",
  "ZETAUSDT_UMCBL",
  "POLYXUSDT_UMCBL",
  "PENDLEUSDT_UMCBL",
  "AEVOUSDT_UMCBL",
  "OMUSDT_UMCBL",
  "ONDOUSDT_UMCBL",
  "ORDIUSDT_UMCBL",
  "CAKEUSDT_UMCBL",
  "PHBUSDT_UMCBL",
  "ARKMUSDT_UMCBL",
  "TIAUSDT_UMCBL",
  "JUPUSDT_UMCBL",
  "BEAMUSDT_UMCBL",
  "ALTUSDT_UMCBL",
  "STRKUSDT_UMCBL",
  "PIXELUSDT_UMCBL",
  "NFPUSDT_UMCBL",
  "BOMEUSDT_UMCBL",
  "METISUSDT_UMCBL"
];

// CLI range support (doit venir après la déclaration de SYMBOLS)
const args = process.argv.slice(2);
let rangeFrom = 0, rangeTo = SYMBOLS.length;
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--from=")) rangeFrom = parseInt(args[i].split("=")[1]);
  if (args[i].startsWith("--to=")) rangeTo = parseInt(args[i].split("=")[1]);
}


const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const num = (v, d=6) => (v===null || v===undefined || Number.isNaN(+v)) ? null : +(+v).toFixed(d);

function baseSymbol(sym) { return sym.replace('_UMCBL', ''); }

async function safeGetJson(url) {
  try {
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.error("⚠️ Fetch error:", e.message);
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
    return j.data.map(c => ({ t:+c[0], o:+c[1], h:+c[2], l:+c[3], c:+c[4], v:+c[5] })).sort((a,b)=>a.t-b.t);
  }
  // v1 fallback
  const v1 = `https://api.bitget.com/api/mix/v1/market/candles?symbol=${symbol}&granularity=${seconds}&limit=${limit}`;
  j = await safeGetJson(v1);
  if (j && j.data && Array.isArray(j.data) && j.data.length) {
    return j.data.map(c => ({ t:+c[0], o:+c[1], h:+c[2], l:+c[3], c:+c[4], v:+c[5] })).sort((a,b)=>a.t-b.t);
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

// Mark price (v1)
async function getMarkPrice(symbol) {
  // Endpoint mark price (v1)
  const url = `https://api.bitget.com/api/mix/v1/market/mark-price?symbol=${symbol}`;
  const j = await safeGetJson(url);
  if (j && j.data && (j.data.markPrice || j.data.markPrice === 0)) {
    return +j.data.markPrice;
  }
  // fallback: sometimes ticker contains mark if API changes
  const tk = await getTicker(symbol);
  if (tk && tk.markPrice) return +tk.markPrice;
  return null;
}

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
function ema(arr, period, accessor=(x)=>x) {
  if (!arr.length) return null;
  const k = 2/(period+1);
  let emaVal = accessor(arr[0]);
  for (let i=1;i<arr.length;i++) {
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
  gains/=period; losses = (losses/period) || 1e-9;
  let rs = gains / losses;
  let r = 100 - 100/(1+rs);
  for (let i=period+1;i<closes.length;i++){
    const diff = closes[i]-closes[i-1];
    const gain = Math.max(diff,0);
    const loss = Math.max(-diff,0);
    gains = (gains*(period-1)+gain)/period;
    losses = ((losses*(period-1)+loss)/period) || 1e-9;
    rs = gains / losses;
    r = 100 - 100/(1+rs);
  }
  return r;
}

function percent(a,b){ return b ? (a/b - 1)*100 : null; }

function vwap(candles){
  let pv=0,v=0;
  for(const c of candles){
    const p=(c.h+c.l+c.c)/3;
    pv+=p*c.v;
    v+=c.v;
  }
  return v?pv/v:null;
}

function closeChangePct(candles,bars=1){
  if(candles.length<bars+1) return null;
  const a=candles[candles.length-1].c;
  const b=candles[candles.length-1-bars].c;
  return percent(a,b);
}

function positionInDay(last, low24h, high24h){
  const r=high24h-low24h;
  if(r<=0 || last===null) return null;
  return ((last-low24h)/r)*100;
}

function volumeNodes(candles,buckets=10){
  if(!candles.length) return [];
  const minP=Math.min(...candles.map(c=>c.l));
  const maxP=Math.max(...candles.map(c=>c.h));
  if(maxP<=minP) return [];
  const step=(maxP-minP)/buckets;
  const vols=new Array(buckets).fill(0);
  for(const c of candles){
    const p=c.c;
    let idx=Math.floor((p-minP)/step);
    if(idx>=buckets) idx=buckets-1;
    if(idx<0) idx=0;
    vols[idx]+=c.v;
  }
  const res=vols.map((v,i)=>({
    price:+(minP+(i+0.5)*step).toFixed(6),
    volume:+v.toFixed(2)
  }));
  res.sort((a,b)=>b.volume-a.volume);
  return res.slice(0,5);
}

// ---- Persist ΔOI helpers ----
function loadPrevOIMap() {
  try {
    const raw = fs.readFileSync(OUT_PREV, 'utf-8');
    const obj = JSON.parse(raw);
    // expect { [symbol]: { oi: number, ts: string } }
    return obj && typeof obj === 'object' ? obj : {};
  } catch { return {}; }
}

function savePrevOIMap(map) {
  try {
    fs.writeFileSync(OUT_PREV, JSON.stringify(map, null, 2));
  } catch (e) {
    console.error("⚠️ Impossible d'écrire", OUT_PREV, e.message);
  }
}

// ---- Core symbol processing ----
async function processSymbol(symbol, prevOIMap){
  const [tk, fr, oi] = await Promise.all([getTicker(symbol), getFunding(symbol), getOI(symbol)]);
  if (!tk) return null;

  const last = +tk.last;
  const high24 = +tk.high24h;
  const low24 = +tk.low24h;
  const vol24 = +tk.baseVolume;

  const [c1m,c5m,c15m,c1h,c4h] = await Promise.all([
    getCandles(symbol,60,120),
    getCandles(symbol,300,120),
    getCandles(symbol,900,400),
    getCandles(symbol,3600,400),
    getCandles(symbol,14400,400)
  ]);

  const [depth, markPrice] = await Promise.all([getDepth(symbol,5), getMarkPrice(symbol)]);

  let spreadPct=null;
  if(depth.bids.length&&depth.asks.length){
    const b=depth.bids[0][0];
    const a=depth.asks[0][0];
    spreadPct = ((a-b)/((a+b)/2))*100;
    if (spreadPct < 0) spreadPct = -spreadPct;
  }

  const closes1m=c1m.map(x=>x.c),
        closes5m=c5m.map(x=>x.c),
        closes15m=c15m.map(x=>x.c),
        closes1h=c1h.map(x=>x.c),
        closes4h=c4h.map(x=>x.c);

  const ema20_1m=ema(c1m,20,x=>x.c);
  const ema20_5m=ema(c5m,20,x=>x.c);

  const rsi_1m=rsi(closes1m,14);
  const rsi_5m=rsi(closes5m,14);
  const rsi_15m=rsi(closes15m,14);
  const rsi_1h=rsi(closes1h,14);
  const rsi_4h=rsi(closes4h,14);

  const var15m=closeChangePct(c15m,1);
  const var1h=closeChangePct(c1h,1);
  const var4h=closeChangePct(c4h,1);

  const volaPct = (last && high24 && low24) ? ((high24-low24)/last)*100 : null;
  const tend24  = (high24>low24 && last) ? (((last-low24)/(high24-low24))*200-100) : null;
  const posDay  = positionInDay(last,low24,high24);

  const fundingRate = fr ? +fr.fundingRate * 100 : null; // en %
  const openInterest = oi ? +oi.amount : null;

  const vwap1h = vwap(c1h.slice(-48));
  const deltaVWAP = (vwap1h && last) ? percent(last, vwap1h) : null;

  // ΔOI vs précédent snapshot
  const prev = prevOIMap[symbol]?.oi ?? null;
  const deltaOI = (openInterest!==null && prev!==null && prev!==0) ? ((openInterest - prev)/prev)*100 : null;

  const nodes1h=volumeNodes(c1h.slice(-120),10);
  const ts = new Date().toISOString();

  // -------- line (TXT) --------
  const lineParts = [
    `• ${symbol.padEnd(13)} |`,
    `P=${num(last,6)} |`,
    `Mark=${markPrice!==null?num(markPrice,6):'n/a'} |`,
    `VWAP=${vwap1h!==null?num(vwap1h,6):'n/a'} |`,
    `ΔVWAP=${deltaVWAP!==null?num(deltaVWAP,2):'n/a'}% |`,
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
    `Var{15m=${var15m!==null?num(var15m,2):'n/a'}%,1h=${var1h!==null?num(var1h,2):'n/a'}%,4h=${var4h!==null?num(var4h,2):'n/a'}%}`,
    nodes1h.length?` | TopNodes=${nodes1h.map(n=>`${n.price}(${n.volume})`).join('|')}`:'',
    ` | Ts=${ts}`
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
      "1m": rsi_1m!==null?num(rsi_1m,2):null,
      "5m": rsi_5m!==null?num(rsi_5m,2):null,
      "15m": rsi_15m!==null?num(rsi_15m,2):null,
      "1h": rsi_1h!==null?num(rsi_1h,2):null,
      "4h": rsi_4h!==null?num(rsi_4h,2):null
    },
    ema20: {
      "1m": ema20_1m!==null?num(ema20_1m,6):null,
      "5m": ema20_5m!==null?num(ema20_5m,6):null
    },
    variationPct: {
      "15m": var15m!==null?num(var15m,2):null,
      "1h": var1h!==null?num(var1h,2):null,
      "4h": var4h!==null?num(var4h,2):null
    },
    vwap1h: vwap1h!==null?num(vwap1h,6):null,
    deltaVWAPpct: deltaVWAP!==null?num(deltaVWAP,4):null,
    volumeProfile1hTop: nodes1h,
    timestamp: ts
  };

  // pour persister ΔOI la prochaine fois
  const nextPrev = { oi: openInterest ?? null, ts };
  return { line, json: out, nextPrev };
}

// ---- Main ----

async function main(){
  console.log("📡 Snapshot Bitget Top100 v6.1 (resilient)…");
  const prevOIMap = loadPrevOIMap();
  const nextPrevMap = {};
  const results=[], lines=[];

  const total = SYMBOLS.length;
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
    await sleep(150);
  }

  // Relance manquants si coupure
  if (results.length < slice.length) {
    const missing = slice.filter(s => !results.find(r => r.symbol === s));
    if (missing.length > 0) {
      console.warn(`⏩ Relance des ${missing.length} symboles manquants...`);
      for (const s of missing) {
        try {
          const r = await processSymbol(s, prevOIMap);
          if (r) {
            lines.push(r.line);
            results.push(r.json);
            nextPrevMap[s] = { oi: r.nextPrev.oi, ts: r.nextPrev.ts };
          }
        } catch (e) {
          console.error(`Erreur (relance) sur ${s}:`, e.message);
        }
        await sleep(250);
      }
    }
  }

  // Sauvegarde finale
  fs.writeFileSync(OUT_JSON, JSON.stringify(results, null, 2));
  fs.writeFileSync(OUT_TXT, lines.join('\n'));
  savePrevOIMap(nextPrevMap);

  console.log(`✅ ${results.length}/${slice.length} cryptos traitées avec succès.`);
  if (results.length < slice.length) console.warn("⚠️ Certaines cryptos manquent au snapshot !");

  try {
    execSync(`cat ${OUT_TXT} | pbcopy`,{stdio:'ignore'});
    console.log("🧷 Résumé copié dans le presse-papiers (macOS).");
  } catch {}

  console.log(lines.slice(0,8).join('\n'));
  if(lines.length>8) console.log(`…(+${lines.length-8} lignes)`);
}

main().catch(e=>{console.error("Erreur fatale:",e);process.exit(1);});
(e=>{console.error("Erreur fatale:",e);process.exit(1);});
