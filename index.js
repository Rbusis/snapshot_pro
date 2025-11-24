// index.js — CHEF D'ORCHESTRE
// Rôle : Lance le serveur Web (Railway) + Les 2 Bots en parallèle

import http from "http";
// On importe les cerveaux de tes deux bots
import { startAutoselect } from "./autoselect.js";
import { startDiscovery } from "./discovery.js";

// ========= RAILWAY KEEPALIVE =========
// Un seul serveur HTTP pour tout le projet
const PORT = process.env.PORT || 8080;

http.createServer((req, res) => {
  res.writeHead(200);
  res.end("🤖 JTF MULTI-BOT IS RUNNING (Autoselect + Discovery)");
}).listen(PORT, () => {
  console.log(`🛡️ Serveur Global écoute sur le port ${PORT}`);
});

// ========= LANCEMENT DES MOTEURS =========

console.log("🏁 Démarrage des deux bots...");

// 1. Lance le Bot Top 30 (Autoselect)
startAutoselect().catch(e => {
  console.error("❌ CRASH Autoselect:", e);
});

// 2. Lance le Bot Mid-Cap (Discovery)
startDiscovery().catch(e => {
  console.error("❌ CRASH Discovery:", e);
});
