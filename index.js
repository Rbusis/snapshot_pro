// index.js — CHEF D'ORCHESTRE ULTIME (Sans MQI)
// Lance le serveur Web + 4 Bots : Autoselect, Discovery, Degen, Swing

import http from "http";
import { startAutoselect } from "./autoselect.js";
import { startDiscovery } from "./discovery.js";
import { startDegen } from "./degen.js";
import { startSwing } from "./swing.js";

// ========= RAILWAY KEEPALIVE =========
const PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end("🤖 JTF QUAD-BOT IS RUNNING (Autoselect + Discovery + Degen + Swing)");
}).listen(PORT, () => {
  console.log(`🛡️ Serveur Global écoute sur le port ${PORT}`);
});

// ========= LANCEMENT DES MOTEURS =========

console.log("🏁 Démarrage orchestré de la flotte JTF…");

// 1) Bot Top 30 (Autoselect)
startAutoselect().catch(e => console.error("❌ CRASH Autoselect:", e));

// 2) Bot Mid-Caps (Discovery)
startDiscovery().catch(e => console.error("❌ CRASH Discovery:", e));

// 3) Bot Low-Caps (Degen)
startDegen().catch(e => console.error("❌ CRASH Degen:", e));

// 4) Bot Swing Trading (Swing)
startSwing().catch(e => console.error("❌ CRASH Swing:", e));

console.log("🚀 Bots JTF (4 moteurs) opérationnels. MQI retiré.");