// index.js — CHEF D'ORCHESTRE ULTIME
// Lance le serveur Web + 3 Bots (Autoselect, Discovery, Degen)

import http from "http";
import { startAutoselect } from "./autoselect.js";
import { startDiscovery } from "./discovery.js";
import { startDegen } from "./degen.js"; // <--- NOUVEAU

// ========= RAILWAY KEEPALIVE =========
const PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end("🤖 JTF TRI-BOT IS RUNNING (Autoselect + Discovery + Degen)");
}).listen(PORT, () => {
  console.log(`🛡️ Serveur Global écoute sur le port ${PORT}`);
});

// ========= LANCEMENT DES MOTEURS =========

console.log("🏁 Démarrage de la flotte (3 Bots)...");

// 1. Bot Top 30 (Autoselect)
startAutoselect().catch(e => console.error("❌ CRASH Autoselect:", e));

// 2. Bot Mid-Caps (Discovery)
startDiscovery().catch(e => console.error("❌ CRASH Discovery:", e));

// 3. Bot Low-Caps (Degen) - NOUVEAU
startDegen().catch(e => console.error("❌ CRASH Degen:", e));
