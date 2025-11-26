// index.js — CHEF D'ORCHESTRE ULTIME
// Lance le serveur Web + 5 Bots (Autoselect, Discovery, Degen, Swing, MQI)

import http from "http";
import { startAutoselect } from "./autoselect.js";
import { startDiscovery } from "./discovery.js";
import { startDegen } from "./degen.js";
import { startSwing } from "./swing.js";
import { startMQI } from "./mqi.js";   // <--- AJOUT MQI OBSERVER

// ========= RAILWAY KEEPALIVE =========
const PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end("🤖 JTF PENTA-BOT IS RUNNING (Autoselect + Discovery + Degen + Swing + MQI)");
}).listen(PORT, () => {
  console.log(`🛡️ Serveur Global écoute sur le port ${PORT}`);
});

// ========= LANCEMENT DES MOTEURS =========

console.log("🏁 Démarrage de la flotte (5 Bots)…");

// 1. Bot Top 30 (Autoselect)
startAutoselect().catch(e => console.error("❌ CRASH Autoselect:", e));

// 2. Bot Mid-Caps (Discovery)
startDiscovery().catch(e => console.error("❌ CRASH Discovery:", e));

// 3. Bot Low-Caps (Degen)
startDegen().catch(e => console.error("❌ CRASH Degen:", e));

// 4. Bot Swing Trading (Swing)
startSwing().catch(e => console.error("❌ CRASH Swing:", e));

// 5. Bot MQI Observer
startMQI().catch(e => console.error("❌ CRASH MQI:", e));