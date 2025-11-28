// index.js — CHEF D'ORCHESTRE ULTIME (Staggered Launch v1.0)
// Lance le serveur Web + 5 Bots avec décalages intelligents
// Objectif : éviter tout appel API simultané → zéro rate-limit Bitget

import http from "http";
import { startAutoselect } from "./autoselect.js";
import { startDiscovery } from "./discovery.js";
import { startDegen } from "./degen.js";
import { startSwing } from "./swing.js";
import { startMQI } from "./mqi.js";

// ========= KEEPALIVE RAILWAY =========
const PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end("🤖 JTF PENTA-BOT RUNNING (Autoselect + Discovery + Degen + Swing + MQI)");
}).listen(PORT, () => {
  console.log(`🛡️ Serveur Global sur port ${PORT}`);
});

// ========= LANCEMENT DES BOTS AVEC DÉCALAGE =========
// Pourquoi ? → éviter que tous les bots fassent 150 requêtes simultanées
// Chaque bot démarre à un moment différent → charge répartie → zéro erreur API

console.log("🏁 Démarrage orchestré de la flotte JTF…");

// Helper pour attendre
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

async function launchBots() {

  // 1. Autoselect (TOP 30) — priorité max
  startAutoselect().catch(e => console.error("❌ CRASH Autoselect:", e));
  console.log("🚀 Autoselect démarré (t=0s)");

  // 2. Discovery — décalage 20 sec
  await sleep(20_000);
  startDiscovery().catch(e => console.error("❌ CRASH Discovery:", e));
  console.log("🚀 Discovery démarré (t=+20s)");

  // 3. Degen — décalage 40 sec
  await sleep(20_000);
  startDegen().catch(e => console.error("❌ CRASH Degen:", e));
  console.log("🚀 Degen démarré (t=+40s)");

  // 4. Swing — décalage 60 sec
  await sleep(20_000);
  startSwing().catch(e => console.error("❌ CRASH Swing:", e));
  console.log("🚀 Swing démarré (t=+60s)");

  // 5. MQI — décalage 120 sec (indépendant + faible fréquence)
  await sleep(60_000);
  startMQI().catch(e => console.error("❌ CRASH MQI:", e));
  console.log("🚀 MQI démarré (t=+120s)");
}

launchBots();