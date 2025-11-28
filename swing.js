// swing.js — JTF SWING BOT v1.3 (API v2 Only)

import fetch from "node-fetch";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

const SCAN_INTERVAL_MS   = 30 * 60_000;
const MIN_ALERT_DELAY_MS = 30 * 60_000;

const SYMBOLS = [
"BTCUSDT_UMCBL","ETHUSDT_UMCBL","BNBUSDT_UMCBL","SOLUSDT_UMCBL","XRPUSDT_UMCBL",
"AVAXUSDT_UMCBL","LINKUSDT_UMCBL","DOTUSDT_UMCBL","TRXUSDT_UMCBL","ADAUSDT_UMCBL",
"NEARUSDT_UMCBL","ATOMUSDT_UMCBL","OPUSDT_UMCBL","INJUSDT_UMCBL","UNIUSDT_UMCBL",
"LTCUSDT_UMCBL","TIAUSDT_UMCBL","SEIUSDT_UMCBL"
];

const JDS_THRESHOLD_READY = 75;
const JDS_THRESHOLD_PRIME = 85;

const MAX_ATR_1H_PCT         = 1.8;
const MAX_VOLA_24            = 25;
const MAX_VWAP_4H_DEVIATION  = 4;

const prevOI     = new Map();
const lastAlerts = new Map();

const sleep  = ms => new Promise(res=>setTimeout(res,ms));
const num    = (v,d=4)=>v==null?null:+(+v).toFixed(d);
const clamp  = (x,min,max)=>Math.max(min,Math.min(max,x));
const baseSymbol = s => s.replace("_UMCBL","");

async function safeGetJson(url){
try{
const r = await fetch(url,{headers:{Accept:"application/json"}});
return r.ok ? await r.json() : null;
}catch{return null;}
}

function percent(a,b){ return b?(a/b -1)*100:null; }

// ===== API v2 =====

async function getCandles(symbol,seconds,limit=400){
const base = baseSymbol(symbol);
const url  = `https://api.bitget.com/api/v2/mix/market/candles?symbol=${base}&granularity=${seconds}&productType=usdt-futures&limit=${limit}`;
const j = await safeGetJson(url);
if(j?.data?.length){
return j.data.map(c=>({t:+c[0],o:+c[1],h:+c[2],l:+c[3],c:+c[4],v:+c[5]})).sort((a,b)=>a.t-b.t);
}
return [];
}

async function getTicker(symbol){
const base = baseSymbol(symbol);
const j = await safeGetJson(`https://api.bitget.com/api/v2/mix/market/ticker?symbol=${base}&productType=usdt-futures`);
return j?.data ?? null;
}

async function getDepth(symbol){
const base = baseSymbol(symbol);
const j = await safeGetJson(`https://api.bitget.com/api/v2/mix/market/depth?symbol=${base}&limit=20&productType=usdt-futures`);
if(j?.data?.bids && j.data.asks){
return {
bids:j.data.bids.map(x=>[+x[0],+x[1]]),
asks:j.data.asks.map(x=>[+x[0],+x[1]])
};
}
return {bids:[],asks:[]};
}

async function getOI(symbol){
const base = baseSymbol(symbol);
const j = await safeGetJson(`https://api.bitget.com/api/v2/mix/market/open-interest?symbol=${base}&productType=usdt-futures`);
return j?.data ?? null;
}

// ===== INDICATEURS =====

function atr(c,p=14){
if(c.length<p+1) return null;
let s=0;
for(let i=1;i<=p;i++){
const tr=Math.max(
c[i].h-c[i].l,
Math.abs(c[i].h-c[i-1].c),
Math.abs(c[i].l-c[i-1].c)
);
s+=tr;
}
return s/p;
}

function rsi(closes,p=14){
if(closes.length<p+1) return null;
let g=0,l=0;
for(let i=1;i<=p;i++){
const d=closes[i]-closes[i-1];
d>=0?g+=d:l-=d;
}
g/=p; l=(l/p)||1e-9;
let rs=g/l;
let v=100-100/(1+rs);
for(let i=p+1;i<closes.length;i++){
const d=closes[i]-closes[i-1];
g=(g*(p-1)+Math.max(d,0))/p;
l=((l*(p-1)+Math.max(-d,0))/p)||1e-9;
rs=g/l;
v=100-100/(1+rs);
}
return v;
}

function ema(closes,p){
if(closes.length<p) return null;
const k=2/(p+1);
let e=closes[closes.length-p];
for(let i=closes.length-p+1;i<closes.length;i++){
e=closes[i]*k+e*(1-k);
}
return e;
}

function vwap(c){
let pv=0,v=0;
for(const x of c){
const p=(x.h+x.l+x.c)/3;
pv+=p*x.v;
v+=x.v;
}
return v?pv/v:null;
}

function positionInDay(last,low,high){
let r=high-low;
if(r<=0||last==null) return null;
return ((last-low)/r)*100;
}

function trendStrength(c,p=20){
if(c.length<p) return 0;
const r=c.slice(-p);
let u=0,d=0;
for(let i=1;i<r.length;i++){
if(r[i].c>r[i-1].c) u++;
else if(r[i].c<r[i-1].c) d++;
}
return ((u-d)/p)*100;
}

function analyzeOrderbook(depth){
if(!depth.bids.length||!depth.asks.length) return{imbalance:0,pressure:"neutral"};
const b=depth.bids.reduce((s,[,v])=>s+v,0);
const a=depth.asks.reduce((s,[,v])=>s+v,0);
const tot=b+a;
if(tot===0) return{imbalance:0,pressure:"neutral"};
const imb=((b-a)/tot)*100;
let p="neutral";
if(imb>15)p="bullish";
else if(imb<-15)p="bearish";
return{imbalance:num(imb,2),pressure:p};
}

// ===== SNAPSHOT =====

async function processSymbol(symbol){
const [tk,oi] = await Promise.all([getTicker(symbol),getOI(symbol)]);
if(!tk) return null;

const last=+tk.last;
const high24=+tk.high24h;
const low24=+tk.low24h;

const oI = oi ? +oi.amount : null;
const prev = prevOI.get(symbol) ?? null;
const deltaOI = (prev!=null && oI!=null && prev!==0)?((oI-prev)/prev)*100:null;
prevOI.set(symbol,oI ?? prev);

const [c15m,c1h,c4h] = await Promise.all([
getCandles(symbol,900,400),
getCandles(symbol,3600,400),
getCandles(symbol,14400,400)
]);

if(!c1h.length||!c4h.length||!c15m.length) return null;

const depth = await getDepth(symbol);
const oba = analyzeOrderbook(depth);

const volaPct = last && high24 && low24 ? ((high24-low24)/last)*100 : null;
const tend24  = high24>low24 && last ? (((last-low24)/(high24-low24))*200-100):null;
const posDay  = positionInDay(last,low24,high24);

const v1h = vwap(c1h.slice(-48));
const v4h = vwap(c4h.slice(-48));
const dVWAP1h = v1h?percent(last,v1h):null;
const dVWAP4h = v4h?percent(last,v4h):null;

const atr1=atr(c1h,14);
const atr4=atr(c4h,14);
const atr1Pct = atr1 && last?(atr1/last)*100:null;
const atr4Pct = atr4 && last?(atr4/last)*100:null;

const cl15 = c15m.map(x=>x.c);
const cl1  = c1h.map(x=>x.c);
const cl4  = c4h.map(x=>x.c);

return{
symbol,last,high24,low24,volaPct,tend24,posDay,
deltaVWAP1h:dVWAP1h!=null?num(dVWAP1h,4):null,
deltaVWAP4h:dVWAP4h!=null?num(dVWAP4h,4):null,
deltaOIpct:deltaOI!=null?num(deltaOI,3):null,
atr1hPct: atr1Pct!=null?num(atr1Pct,4):null,
atr4hPct: atr4Pct!=null?num(atr4Pct,4):null,
obImbalance:oba.imbalance,
obPressure:oba.pressure,
rsi:{"15m":num(rsi(cl15),2),"1h":num(rsi(cl1),2),"4h":num(rsi(cl4),2)},
c15m,c1h,c4h
};
}

// ===== JDS SWING (inchangé) =====

function calculateJDSSwing(rec){
const {c15m,c1h,c4h}=rec;
const cl15=c15m.map(x=>x.c);
const cl1 =c1h.map(x=>x.c);
const cl4 =c4h.map(x=>x.c);
const last=rec.last;

let score=0;

// M1 trend
let m1=0;
let dP1h=null,dP4h=null;
if(cl1.length>6)dP1h=percent(cl1[cl1.length-1],cl1[cl1.length-7]);
if(cl4.length>6)dP4h=percent(cl4[cl4.length-1],cl4[cl4.length-7]);
if(dP1h!=null&&dP4h!=null){
if((dP1h>0&&dP4h>0)||(dP1h<0&&dP4h<0))m1+=12;
}
const e20=ema(cl1,20);
const e50=ema(cl1,50);
if(e20 && e50){
if(last>e20 && e20>e50)m1+=8;
}
const v1=rec.deltaVWAP1h, v4=rec.deltaVWAP4h;
if(v1!=null&&v4!=null){
if((v1>0&&v4>0)||(v1<0&&v4<0))m1+=5;
}
m1=clamp(m1,0,25);
score+=m1;

// M2 VWAP dist
let m2=0;
const d1=v1!=null?Math.abs(v1):null;
const d4=v4!=null?Math.abs(v4):null;
if(d1!=null&&d4!=null){
if(d1>=0.3&&d1<=2 && d4>=0.5 && d4<=3)m2=20;
}
score+=m2;

// M3 RSI
let m3=0;
const r15=rec.rsi["15m"],r1=rec.rsi["1h"],r4=rec.rsi["4h"];
if(r15!=null&&r1!=null&&r4!=null){
const avg=(r15+r1+r4)/3;
const spread=Math.max(r15,r1,r4)-Math.min(r15,r1,r4);
if(avg>38&&avg<62&&spread<=12)m3=20;
}
score+=m3;

// M4 Volatilité
let m4=0;
if(rec.atr1hPct!=null&&rec.volaPct!=null){
if(rec.atr1hPct<MAX_ATR_1H_PCT && rec.volaPct>2 && rec.volaPct<MAX_VOLA_24)m4=15;
}
score+=m4;

// M5 Daily
let m5=0;
if(rec.posDay!=null&&rec.tend24!=null){
if((rec.posDay>35&&rec.posDay<65)||Math.abs(rec.tend24)>30)m5=10;
}
score+=m5;

// M6 Flux (OI + OB)
let m6=0;
const dOI=rec.deltaOIpct, ob=rec.obImbalance;
if(dOI!=null && Math.abs(dOI)>0.5)m6+=6;
if(ob!=null && Math.abs(ob)>10)m6+=4;
m6=clamp(m6,0,10);
score+=m6;

return clamp(score,0,100);
}

// ===== DIRECTION =====

function detectDirection(rec,jds){
let L=0,S=0;
const v1=rec.deltaVWAP1h, v4=rec.deltaVWAP4h;
if(v1<0)L+=2; if(v1>0)S+=2;
if(v4<0)L+=2; if(v4>0)S+=2;

const r1=rec.rsi["1h"], r4=rec.rsi["4h"];
if(r1<50)L++; else S++;
if(r4<50)L++; else S++;

if(rec.obPressure==="bullish")L+=2;
if(rec.obPressure==="bearish")S+=2;

if(rec.deltaOIpct>0.5)L++;
if(rec.deltaOIpct<-0.5)S++;

return L>=S?"LONG":"SHORT";
}

// ===== TIMING =====

function isTimingGood(rec,dir){
const c1=rec.c1h;
if(!c1||c1.length<22)return false;

const lc=c1[c1.length-1];
const cl=c1.map(x=>x.c);
const e20=ema(cl,20);
if(!lc||!e20)return false;

const bt=Math.max(lc.o,lc.c);
const bb=Math.min(lc.o,lc.c);
const tr=lc.h-lc.l||1e-9;
const up=lc.h-bt;
const low=bb-lc.l;

if(dir==="LONG"){
if(!(lc.c>e20 && low>tr*0.25))return false;
}else{
if(!(lc.c<e20 && up>tr*0.25))return false;
}

const v1=rec.deltaVWAP1h, v4=rec.deltaVWAP4h;
if(dir==="SHORT"){
if(v1<1.2||v4<0.5)return false;
}else{
if(v1>-1.2||v4>-0.5)return false;
}

if(rec.atr1hPct<0.35||rec.atr1hPct>1.6)return false;

const vols=c1.map(x=>x.v);
if(vols.length<21)return false;
const lastV=vols[vols.length-1], avg=vols.slice(-21,-1).reduce((a,b)=>a+b,0)/20;
if(lastV<avg*1.05)return false;

const dOI=rec.deltaOIpct;
if(dir==="LONG" && dOI<=0)return false;
if(dir==="SHORT"&& dOI>=0)return false;

return true;
}

// ===== CONDITIONS À ÉVITER =====

function shouldAvoidMarket(rec){
if(rec.volaPct<3)return"Vola<3%";
const r15=rec.rsi["15m"],r1=rec.rsi["1h"],r4=rec.rsi["4h"];
if(Math.max(r15,r1,r4)-Math.min(r15,r1,r4)<5)return"RSI trop plat";
if(rec.atr1hPct>MAX_ATR_1H_PCT)return"ATR1h trop haut";
if(rec.volaPct>MAX_VOLA_24)return"Vola excessive 24h";
if(Math.abs(rec.deltaVWAP4h)>MAX_VWAP_4H_DEVIATION)return"VWAP4h trop large";
return null;
}

function calculateTradePlan(rec,dir,jds){
const last=rec.last;
const atr1 = rec.atr1hPct? (rec.atr1hPct/100)*last: last*0.01;
const atr4 = rec.atr4hPct? (rec.atr4hPct/100)*last: last*0.015;

let pf=jds>=90?0.3:jds>=85?0.5:0.7;

let entry,sl,tp1,tp2;
if(dir==="LONG"){
entry = last-(pf*atr1);
sl    = entry-(1.2*atr4);
const d=entry-sl;
tp1   = entry+(1.0*d);
tp2   = entry+(2.0*d);
}else{
entry = last+(pf*atr1);
sl    = entry+(1.2*atr4);
const d=sl-entry;
tp1   = entry-(1.0*d);
tp2   = entry-(2.0*d);
}

const dec = last<0.0001?7:last<0.01?6:last<0.1?5:4;

entry=num(entry,dec);
sl=num(sl,dec);
tp1=num(tp1,dec);
tp2=num(tp2,dec);

let rr=null;
if(dir==="LONG" && +entry>+sl && +tp1>+entry)rr=(tp1-entry)/(entry-sl);
if(dir==="SHORT"&& +sl>+entry && +entry>+tp1)rr=(entry-tp1)/(sl-entry);
rr=rr!=null?num(rr,2):null;

return{entry,sl,tp1,tp2,rr};
}

function getRecommendedLeverage(v){
if(v<5)return"3x";
if(v<=10)return"2x";
return"1x";
}

function estimateDuration(jds,rec){
const t1=Math.abs(trendStrength(rec.c1h,48));
const t4=Math.abs(trendStrength(rec.c4h,24));
const avg=(t1+t4)/2;
if(jds>=90&&avg>40)return"3h–12h";
if(jds>=85)return"6h–24h";
if(jds>=75)return"12h–36h";
return"24h–48h";
}

function getMoveToBeCondition(){
return"TP1 atteint OU +1×ATR(1h) OU divergence RSI(15m)";
}

function shouldSendAlert(symbol,dir,state){
const k=`${symbol}-${dir}-${state}`;
const n=Date.now();
const l=lastAlerts.get(k);
if(!l){lastAlerts.set(k,n);return true;}
if(n-l<MIN_ALERT_DELAY_MS)return false;
lastAlerts.set(k,n);
return true;
}

async function sendTelegram(text){
if(!TELEGRAM_BOT_TOKEN||!TELEGRAM_CHAT_ID)return;
try{
await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,{
method:"POST",
headers:{"Content-Type":"application/json"},
body:JSON.stringify({chat_id:TELEGRAM_CHAT_ID,text,parse_mode:"Markdown"})
});
}catch(e){console.error("Telegram error:",e.message);}
}

// ===== SCAN =====

async function scanOnce(){
console.log("🔍 JTF SWING v1.3 — Scan");

const snaps=[];
for(let i=0;i<SYMBOLS.length;i+=5){
const batch=SYMBOLS.slice(i,i+5);
const res=await Promise.all(batch.map(s=>processSymbol(s).catch(()=>null)));
for(const r of res)if(r)snaps.push(r);
if(i+5<SYMBOLS.length)await sleep(800);
}

const ready=[],prime=[];
for(const rec of snaps){
const j=calculateJDSSwing(rec);
if(j<60)continue;

const avoid=shouldAvoidMarket(rec);
if(avoid)continue;

if(j<82 && rec.volaPct<6)continue;

const dir=detectDirection(rec,j);

if(dir==="LONG"&&rec.deltaOIpct<-2)continue;
if(dir==="SHORT"&&rec.deltaOIpct>2)continue;

if(!isTimingGood(rec,dir))continue;

const plan=calculateTradePlan(rec,dir,j);
const lev = getRecommendedLeverage(rec.volaPct);
const dur = estimateDuration(j,rec);

const setup={
symbol:rec.symbol,
direction:dir,
jds:num(j,1),
entry:plan.entry,
sl:plan.sl,
tp1:plan.tp1,
tp2:plan.tp2,
rr:plan.rr,
leverage:lev,
duration:dur,
moveToBe:getMoveToBeCondition(),
momentum:`RSI 15m:${rec.rsi["15m"]} | 1h:${rec.rsi["1h"]} | 4h:${rec.rsi["4h"]}`,
vwapContext:`VWAP 1h:${rec.deltaVWAP1h}% | 4h:${rec.deltaVWAP4h}%`
};

if(j>=JDS_THRESHOLD_PRIME)prime.push(setup);
else if(j>=JDS_THRESHOLD_READY)ready.push(setup);
}

let msg="";
if(!prime.length && !ready.length){
msg="📊 *JTF SWING — RAS*\nAucun setup READY/PRIME.";
await sendTelegram(msg);
return;
}

const sends = prime.length?prime:ready.slice(0,3);
const state = prime.length?"PRIME":"READY";

msg=`🎯 *JTF SWING — ${state}*\n\n`;
for(let i=0;i<sends.length;i++){
const s=sends[i];
if(!shouldSendAlert(s.symbol,s.direction,state))continue;
const emoji=s.direction==="LONG"?"📈":"📉";

msg+=`*${i+1}) ${baseSymbol(s.symbol)}*\n`;
msg+=`${emoji} *${s.direction}*\n`;
msg+=`💠 Entry: ${s.entry}\n`;
msg+=`🛡️ SL: ${s.sl}\n`;
msg+=`🎯 TP1:${s.tp1} | TP2:${s.tp2}\n`;
msg+=`📏 Levier: ${s.leverage} — R:R=${s.rr}\n`;
msg+=`⏱️ Durée: ${s.duration}\n`;
msg+=`🔄 Move to BE: ${s.moveToBe}\n`;
msg+=`🔥 JDS-SWING: ${s.jds}\n`;
msg+=`📊 Momentum: ${s.momentum}\n`;
msg+=`📍 VWAP: ${s.vwapContext}\n\n`;
}

await sendTelegram(msg);
}

// ===== MAIN =====

async function main(){
console.log("🚀 JTF SWING BOT v1.3 — API v2 READY");
await sendTelegram("🟢 *JTF SWING BOT v1.3* démarré.");
while(true){
try{ await scanOnce(); }
catch(e){console.error("Scan error:",e);}
await sleep(SCAN_INTERVAL_MS);
}
}

export const startSwing = main;