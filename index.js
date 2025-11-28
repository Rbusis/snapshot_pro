// index.js — CHEF D'ORCHESTRE ULTIME (Sans MQI, Discovery OFF temporairement)
// Lance le serveur Web + 3 Bots : Autoselect, Degen, Swing

import http from "http";
import { startAutoselect } from "./autoselect.js";
// import { startDiscovery } from "./discovery.js"; // Désactivé (bug d'export)
import { startDegen } from "./degen.js";
import { startSwing } from "./swing.js";

// ========= RAILWAY KEEPALIVE =========
const PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end("🤖 JTF BOT IS RUNNING (Autoselect + Degen + Swing) — Discovery OFF");
}).listen(PORT, () => {
  console.log(`🛡️ Serveur Global écoute sur le port ${PORT}`);
});

// ========= LANCEMENT DES MOTEURS =========

console.log("🏁 Démarrage orchestré de la flotte JTF…");

// 1) Bot Top 30 (Autoselect)
startAutoselect().catch(e => console.error("❌ CRASH Autoselect:", e));

// 2) Bot Low-Caps (Degen)
startDegen().catch(e => console.error("❌ CRASH Degen:", e));

// 3) Bot Swing Trading (Swing)
startSwing().catch(e => console.error("❌ CRASH Swing:", e));

console.log("🚀 Bots JTF opérationnels. MQI retiré, Discovery OFF (à corriger plus tard).");