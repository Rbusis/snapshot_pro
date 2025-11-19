import fetch from "node-fetch";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// intervalle entre deux scans (ms)
const SCAN_INTERVAL_MS = 60_000; // 60s
// seuil JDS pour envoyer une alerte
const JDS_ALERT_THRESHOLD = 80;
// anti-spam : délai min entre deux alertes pour une même paire/direction
const MIN_ALERT_DELAY_MS = 15 * 60_000; // 15 minutes

// mémoire des dernières alertes
const lastAlerts = new Map(); // key: "BTCUSDT_UMCBL-LONG" -> timestamp

// petit helper de pause
function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

// envoi Telegram
async function sendTelegramMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error("❌ TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID manquant.");
    return;
  }

  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const body = {
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: "Markdown"
    };

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      console.error("❌ Erreur envoi Telegram:", await res.text());
    }
  } catch (err) {
    console.error("❌ Erreur réseau Telegram:", err.message);
  }
}

// fetch tickers Bitget (UMCBL = futures perp USDT)
async function fetchBitgetTickers() {
  const url = "https://api.bitget.com/api/v2/mix/market/tickers?productType=umcbl";

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error("HTTP Bitget: " + res.status + " " + (await res.text()));
  }

  const json = await res.json();
  if (json.code !== "00000") {
    throw new Error("Réponse Bitget non OK: " + JSON.stringify(json));
  }

  return json.data || [];
}

/**
 * JDS simplifié à partir d'un ticker Bitget.
 * Utilise :
 *  - position dans le range 24h (bas / haut)
 *  - variation 24h %
 *  - volume USDT 24h
 *
 * Retourne { jdsLong, jdsShort } entre 0 et 100.
 */
function computeJDSFromTicker(t) {
  const last = Number(t.lastPr);
  const high = Number(t.high24h);
  const low = Number(t.low24h);
  const change = Number(t.changeUtc); // % variation 24h
  const volUSDT = Number(t.usdValue); // volume 24h en USDT

  if (!isFinite(last) || !isFinite(high) || !isFinite(low) || high === low) {
    return { jdsLong: 0, jdsShort: 0 };
  }

  // position dans le range 24h (0 = bas, 1 = haut)
  const pos = (last - low) / (high - low);

  // score de volume : log10 normalisé, clampé à 0–1
  const volScore = Math.min(1, Math.log10(volUSDT + 1) / 6); // gros vol -> proche de 1

  // variation 24h clampée entre -10 et +10 %
  const maxChange = 10;
  const ch = Math.max(-maxChange, Math.min(maxChange, change));
  const changeScoreLong = (maxChange + ch) / (2 * maxChange); // 0–1
  const changeScoreShort = (maxChange - ch) / (2 * maxChange); // 0–1

  // range: long intéressant si bas de range, short si haut de range
  const rangeScoreLong = Math.max(0, 0.4 - pos) / 0.4; // 1 quand pos = 0
  const rangeScoreShort = Math.max(0, pos - 0.6) / 0.4; // 1 quand pos = 1

  const jdsLong =
    100 *
    (0.5 * rangeScoreLong + 0.3 * changeScoreLong + 0.2 * volScore);

  const jdsShort =
    100 *
    (0.5 * rangeScoreShort + 0.3 * changeScoreShort + 0.2 * volScore);

  return { jdsLong, jdsShort };
}

function shouldSendAlert(symbol, direction, jds) {
  if (jds < JDS_ALERT_THRESHOLD) return false;

  const key = `${symbol}-${direction}`;
  const now = Date.now();
  const last = lastAlerts.get(key) || 0;

  if (now - last < MIN_ALERT_DELAY_MS) {
    return false; // trop récent, on skip
  }

  lastAlerts.set(key, now);
  return true;
}

async function scanOnce() {
  console.log("🔍 Scan JTF…");

  const tickers = await fetchBitgetTickers();
  if (!tickers.length) {
    console.log("⚠️ Aucun ticker récupéré.");
    return;
  }

  // on peut limiter au TOP 30 les plus liquides via usdValue
  const sorted = [...tickers].sort(
    (a, b) => Number(b.usdValue) - Number(a.usdValue)
  );
  const top = sorted.slice(0, 30);

  let bestLong = null;
  let bestShort = null;

  for (const t of top) {
    const { jdsLong, jdsShort } = computeJDSFromTicker(t);

    if (!bestLong || jdsLong > bestLong.jds) {
      bestLong = {
        symbol: t.symbol,
        jds: jdsLong,
        lastPr: t.lastPr,
        high24h: t.high24h,
        low24h: t.low24h,
        changeUtc: t.changeUtc,
        usdValue: t.usdValue
      };
    }

    if (!bestShort || jdsShort > bestShort.jds) {
      bestShort = {
        symbol: t.symbol,
        jds: jdsShort,
        lastPr: t.lastPr,
        high24h: t.high24h,
        low24h: t.low24h,
        changeUtc: t.changeUtc,
        usdValue: t.usdValue
      };
    }
  }

  // Alerte LONG
  if (bestLong && shouldSendAlert(bestLong.symbol, "LONG", bestLong.jds)) {
    const e = bestLong;
    const msg =
      `*JTF ALERT – LONG*\n` +
      `Pair: \`${e.symbol}\`\n` +
      `JDS: *${e.jds.toFixed(1)}*\n` +
      `Prix: ${e.lastPr}\n` +
      `24h: Low=${e.low24h} | High=${e.high24h} | Δ=${e.changeUtc}%\n` +
      `Vol 24h ≈ ${Number(e.usdValue).toFixed(0)} USDT\n\n` +
      `_Idée_: bas de range + reprise de momentum. Vérifie le setup complet (ΔVWAP, RSI, OI…) dans ton JTF avant d’entrer.`;

    console.log("🚀 Alerte LONG:", e.symbol, "JDS", e.jds.toFixed(1));
    await sendTelegramMessage(msg);
  }

  // Alerte SHORT
  if (bestShort && shouldSendAlert(bestShort.symbol, "SHORT", bestShort.jds)) {
    const e = bestShort;
    const msg =
      `*JTF ALERT – SHORT*\n` +
      `Pair: \`${e.symbol}\`\n` +
      `JDS: *${e.jds.toFixed(1)}*\n` +
      `Prix: ${e.lastPr}\n` +
      `24h: Low=${e.low24h} | High=${e.high24h} | Δ=${e.changeUtc}%\n` +
      `Vol 24h ≈ ${Number(e.usdValue).toFixed(0)} USDT\n\n` +
      `_Idée_: haut de range + essoufflement potentiel. Confirme avec ton JTF (ΔVWAP, structure, liquidités) avant de short.`;

    console.log("📉 Alerte SHORT:", e.symbol, "JDS", e.jds.toFixed(1));
    await sendTelegramMessage(msg);
  }

  console.log("✅ Scan terminé.");
}

async function main() {
  console.log("🚀 JTF Telegram Bot + JDS Scanner démarré.");
  await sendTelegramMessage("🟢 JTF Scanner démarré sur Railway (scan toutes les 60s).");

  while (true) {
    try {
      await scanOnce();
    } catch (err) {
      console.error("❌ Erreur dans scanOnce:", err.message);
    }
    await sleep(SCAN_INTERVAL_MS);
  }
}

main();