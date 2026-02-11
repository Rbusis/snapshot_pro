import http from "http";

import { startAutoselect } from "./autoselect.js";
import { startDiscovery } from "./discovery.js";
import { startDegen } from "./degen.js";
import { startSwing } from "./swing.js";

const PORT = process.env.PORT || 8080;

// Petit serveur keep-alive pour Railway
http.createServer((req, res) => {
  res.writeHead(200);
  res.end("🤖 QUAD-BOT RUNNING (Autoselect + Discovery + Degen + Swing)");
}).listen(PORT, () => {
  console.log(`🛡️ Serveur Global: port ${PORT} `);
});

console.log("🏁 Démarrage des bots…");

// Lancement SANS await, SANS IIFE, SANS blocage
startAutoselect();
startDiscovery();
startDegen();
startSwing();

console.log("🚀 Bots opérationnels.");