// ===== DEBUG CONTROL (GLOBAL + PER BOT) =====
// Nous importons simplement le fichier debug.js ici.
// Plus rien ne doit se trouver après l'import.
import { DEBUG } from "./debug.js";

// index.js — CHEF D'ORCHESTRE ULTIME (MQI OFF)
// Serveur Web + 4 Bots : Autoselect, Discovery, Degen, Swing

import http from "http";
import { startAutoselect } from "./autoselect.js";
import { startDiscovery } from "./discovery.js";
import { startDegen } from "./degen.js";
import { startSwing } from "./swing.js";

// ========= KEEPALIVE RAILWAY =========
const PORT = process.env.PORT || 8088;

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