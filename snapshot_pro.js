// snapshot_prov2.js
// Version améliorée : Ts par ligne + OI + Price+VWAP, avec fallback API v2->v1 et résumé texte/JSON.
// Requis: Node.js 18+ (fetch natif). Aucune dépendance externe.

const fs = require('fs');
const { execSync } = require('child_process');

// Liste de symboles (USDT Perp Bitget)
const SYMBOLS = [
  // Majors
  "BTCUSDT_UMCBL", "ETHUSDT_UMCBL", "BNBUSDT_UMCBL", "SOLUSDT_UMCBL",
  "XRPUSDT_UMCBL", "ADAUSDT_UMCBL", "DOGEUSDT_UMCBL", "AVAXUSDT_UMCBL",
  "DOTUSDT_UMCBL", "TRXUSDT_UMCBL",

  // Layer 2 / DeFi
  "ARBUSDT_UMCBL", "OPUSDT_UMCBL", "MATICUSDT_UMCBL", "SUIUSDT_UMCBL",
  "INJUSDT_UMCBL", "ATOMUSDT_UMCBL", "APTUSDT_UMCBL", "FTMUSDT_UMCBL",
  "NEARUSDT_UMCBL", "GRTUSDT_UMCBL",

  // Exchange tokens & infra
  "LTCUSDT_UMCBL", "BCHUSDT_UMCBL", "LINKUSDT_UMCBL", "HBARUSDT_UMCBL",
  "EGLDUSDT_UMCBL", "ICPUSDT_UMCBL", "VETUSDT_UMCBL", "FILUSDT_UMCBL",
  "RNDRUSDT_UMCBL", "AAVEUSDT_UMCBL",

  // Meme / Hype tokens
  "PEPEUSDT_UMCBL", "FLOKIUSDT_UMCBL", "SHIBUSDT_UMCBL", "BONKUSDT_UMCBL",
  "WIFUSDT_UMCBL", "DOGSUSDT_UMCBL", "POPCATUSDT_UMCBL", "COQUSDT_UMCBL",
  "MOGUSDT_UMCBL", "LADYSUSDT_UMCBL",

  // AI / Narrative tokens
  "TAOUSDT_UMCBL", "FETUSDT_UMCBL", "OCEANUSDT_UMCBL", "AGIXUSDT_UMCBL",
  "PIXELUSDT_UMCBL", "PORTALUSDT_UMCBL", "ACEUSDT_UMCBL", "ARKUSDT_UMCBL",
  "SEIUSDT_UMCBL", "ASTERUSDT_UMCBL"
];

const OUT_JSON = 'snapshot_pro.json';
const OUT_TXT  = 'snapshot_pro.txt';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function safeGetJson(url) {
  try {
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) {
      // HTTP non-2xx
      return null;
    }
    const json = await res.json();
    return json;
  } catch (e) {
    console.error("⚠️ Fetch error:", e.message);
    return null;
  }
}

function baseSymbol(sym) { return sym.replace('_UMCBL', ''); }

async function getCandles(symbol, seconds, limit = 400) {
  const base = baseSymbol(symbol);
  // v2
  const v2 = `https://api.bitget.com/api/v2/mix/market/candles?symbol=${base}&granularity=${seconds}&productType=usdt-futures&limit=${limit}`;
  let j = await safeGetJson(v2);
  if (j && j.data && Array.isArray(j.data) && j.data.length) {
    return j.data.map(c => ({
      t: +c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5]
    })).sort((a,b)=>a.t-b.t);
  }
  // v1 fallback
  const v1 = `https://api.bitget.com/api/mix/v1/market/candles?symbol=${symbol}&granularity=${seconds}&limit=${limit}`;
  j = await safeGetJson(v1);
  if (j && j.data && Array.isArray(j.data) && j.data.length) {
    return j.data.map(c => ({
      t: +c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5]
    })).sort((a,b)=>a.t-b.t);
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

function percent(a,b){ return b ? (a/b - 1)*100 : 0; }

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
  if(r<=0) return null;
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

async function processSymbol(symbol){
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

  const depth = await getDepth(symbol,5);
  let spreadPct=null;
  if(depth.bids.length&&depth.asks.length){
    const b=depth.bids[0][0];
    const a=depth.asks[0][0];
    spreadPct=Math.abs((a-b)/((a+b)/2))*100;
  }

  const closes1m=c1m.map(x=>x.c),
        closes5m=c5m.map(x=>x.c),
        closes15m=c15m.map(x=>x.c),
        closes1h=c1h.map(x=>x.c),
        closes4h=c4h.map(x=>x.c);

  const ema20_1m=ema(c1m,20,x=>x.c),
        ema20_5m=ema(c5m,20,x=>x.c);

  const rsi_1m=rsi(closes1m,14),
        rsi_5m=rsi(closes5m,14),
        rsi_15m=rsi(closes15m,14),
        rsi_1h=rsi(closes1h,14),
        rsi_4h=rsi(closes4h,14);

  const var15m=closeChangePct(c15m,1),
        var1h=closeChangePct(c1h,1),
        var4h=closeChangePct(c4h,1);

  const volaPct=last?((high24-low24)/last)*100:null;
  const tend24=(high24>low24&&last)?(((last-low24)/(high24-low24))*200-100):null;
  const posDay=positionInDay(last,low24,high24);
  const fundingRate=fr?+fr.fundingRate:null;
  const openInterest=oi?+oi.amount:null;
  const vwap1h=vwap(c1h.slice(-48));
  const nodes1h=volumeNodes(c1h.slice(-120),10);
  const ts = new Date().toISOString();

  const lineParts = [
    `• ${symbol.padEnd(13)} | P=${last} | VWAP=${vwap1h?vwap1h.toFixed(6):'n/a'} | OI=${openInterest??'n/a'} | FR=${fundingRate??'n/a'}`,
    `| 24h{H=${high24},L=${low24},Vol=${vol24}} | Vola=${volaPct?volaPct.toFixed(2):'n/a'}% | Tend=${tend24?tend24.toFixed(2):'n/a'}%`,
    `| PosDay=${posDay?posDay.toFixed(2):'n/a'}% | Spread=${spreadPct!==null?spreadPct.toFixed(4):'n/a'}%`,
    `| RSI{1m=${rsi_1m?rsi_1m.toFixed(2):'n/a'},5m=${rsi_5m?rsi_5m.toFixed(2):'n/a'},15m=${rsi_15m?rsi_15m.toFixed(2):'n/a'},1h=${rsi_1h?rsi_1h.toFixed(2):'n/a'},4h=${rsi_4h?rsi_4h.toFixed(2):'n/a'}}`,
    `| Var{15m=${var15m!==null?var15m.toFixed(2):'n/a'}%,1h=${var1h!==null?var1h.toFixed(2):'n/a'}%,4h=${var4h!==null?var4h.toFixed(2):'n/a'}%}`,
    `| EMA20{1m=${ema20_1m?ema20_1m.toFixed(6):'n/a'},5m=${ema20_5m?ema20_5m.toFixed(6):'n/a'}}`,
    nodes1h.length?`| TopNodes=${nodes1h.map(n=>`${n.price}(${n.volume})`).join('|')}`:'',
    `| Ts=${ts}`
  ];
  const line = lineParts.filter(Boolean).join(' ');

  const out={
    symbol,
    last,
    high24h: high24,
    low24h: low24,
    volume24h: vol24,
    volatilitePct: volaPct!==null?+volaPct.toFixed(2):null,
    tendance24h: tend24!==null?+tend24.toFixed(2):null,
    fundingRate,
    openInterest,
    positionInDayPct: posDay!==null?+posDay.toFixed(2):null,
    spreadPct: spreadPct!==null?+spreadPct.toFixed(5):null,
    rsi: {
      "1m": rsi_1m!==null?+rsi_1m.toFixed(2):null,
      "5m": rsi_5m!==null?+rsi_5m.toFixed(2):null,
      "15m": rsi_15m!==null?+rsi_15m.toFixed(2):null,
      "1h": rsi_1h!==null?+rsi_1h.toFixed(2):null,
      "4h": rsi_4h!==null?+rsi_4h.toFixed(2):null
    },
    ema20: {
      "1m": ema20_1m!==null?+ema20_1m.toFixed(6):null,
      "5m": ema20_5m!==null?+ema20_5m.toFixed(6):null
    },
    variationPct: {
      "15m": var15m!==null?+var15m.toFixed(2):null,
      "1h": var1h!==null?+var1h.toFixed(2):null,
      "4h": var4h!==null?+var4h.toFixed(2):null
    },
    vwap1h: vwap1h!==null?+vwap1h.toFixed(6):null,
    volumeProfile1hTop: nodes1h,
    timestamp: ts
  };
  return { line, json: out };
}

async function main(){
  console.log("📡 Snapshot Bitget (v2: Ts + OI + Price+VWAP)…");
  const results=[],lines=[];
  for(const s of SYMBOLS){
    try {
      const r=await processSymbol(s);
      if(r){ lines.push(r.line); results.push(r.json); }
    } catch (e) {
      console.error(`Erreur sur ${s}:`, e.message);
    }
    await sleep(150);
  }
  fs.writeFileSync(OUT_JSON, JSON.stringify(results, null, 2));
  fs.writeFileSync(OUT_TXT, lines.join('\n'));
  console.log("✅ snapshot_pro.json et snapshot_pro.txt générés.");
  try {
    execSync(`cat ${OUT_TXT} | pbcopy`,{stdio:'ignore'});
    console.log("🧷 Résumé copié dans le presse-papiers (macOS).");
  } catch {}
  // Aperçu console
  console.log(lines.slice(0,8).join('\n'));
  if(lines.length>8) console.log(`…(+${lines.length-8} lignes)`);
}

main().catch(e=>{console.error("Erreur fatale:",e);process.exit(1);});
