// index.js — CHEF D'ORCHESTRE ULTIME (MQI OFF)
// Serveur Web + 4 Bots : Autoselect, Discovery, Degen, Swing

import http from "http";
import { startAutoselect } from "./autoselect.js";
import { startDiscovery } from "./discovery.js";
import { startDegen } from "./degen.js";
import { startSwing } from "./swing.js";

// ===== DEBUG CONTROL (GLOBAL + PER BOT) =====
export const DEBUG = {
  global: false,      // Active le debug pour tous les bots
  autoselect: false,  // Debug du bot AUTOSELECT
  discovery: false,   // Debug du bot DISCOVERY
  swing: false,       // Debug du bot SWING
  degen: false        // Debug du bot DEGEN
};

// ========= KEEPALIVE RAILWAY =========
const PORT = process.env.PORT || 8080;

http.createServer((req, res) => {
  res.writeHead(200);
  res.end("🤖 JTF QUAD-BOT IS RUNNING (Autoselect + Discovery + Degen + Swing)");
}).listen(PORT, () => {
  console.log(`🛡️ Serveur Global écoute sur le port ${PORT}`);
});

// ========= LANCEMENT ORCHESTRÉ =========

console.log("🏁 Démarrage orchestré de la flotte JTF…");

// --- Autoselect ---
(async () => {
  try {
    await startAutoselect();
  } catch (e) {
    console.error("❌ CRASH Autoselect:", e);
  }
})();

// --- Discovery ---
(async () => {
  try {
    await startDiscovery();
  } catch (e) {
    console.error("❌ CRASH Discovery:", e);
  }
})();

// --- Degen ---
(async () => {
  try {
    await startDegen();
  } catch (e) {
    console.error("❌ CRASH Degen:", e);
  }
})();

// --- Swing ---
(async () => {
  try {
    await startSwing();
  } catch (e) {
    console.error("❌ CRASH Swing:", e);
  }
})();

console.log("🚀 Bots JTF opérationnels. MQI retiré.");