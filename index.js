// index.js — CHEF D'ORCHESTRE ULTIME (MQI OFF)
// Serveur Web + 4 Bots : Autoselect, Discovery, Degen, Swing

import process from "process"; // 1. Import explicite système
import http from "http";
import { startAutoselect } from "./autoselect.js";
import { startDiscovery } from "./discovery.js";
import { startDegen } from "./degen.js";
import { startSwing } from "./swing.js";

// 2. FIX GLOBAL : Rend 'process' disponible pour tous les modules enfants
// Cela empêche définitivement les "ReferenceError: process is not defined" au démarrage
global.process = process;

// ========= SÉCURITÉ GLOBALE (CRASH-PROOF) =========

// Empêche le container de s'arrêter sur une erreur non gérée
process.on('uncaughtException', (err) => {
  console.error('🔥 CRITICAL: Uncaught Exception Global:', err);
  // On ne quitte PAS le processus
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🔥 CRITICAL: Unhandled Rejection Global:', reason);
  // On ne quitte PAS le processus
});

// ========= KEEPALIVE RAILWAY =========
const PORT = process.env.PORT || 8080;

http.createServer((req, res) => {
  res.writeHead(200);
  res.end("🤖 JTF QUAD-BOT IS RUNNING (Autoselect + Discovery + Degen + Swing)");
}).listen(PORT, () => {
  console.log(`🛡️ Serveur Global écoute sur le port ${PORT}`);
});

// ========= LANCEMENT ORCHESTRÉ =========

console.log("🏁 Démarrage orchestré de la flotte JTF (Mode API v2 - Secure)...");

// --- Autoselect ---
(async () => {
  try {
    // Petit délai pour laisser le système s'initier
    await new Promise(r => setTimeout(r, 1000));
    await startAutoselect();
  } catch (e) {
    console.error("❌ CRASH INIT Autoselect:", e);
  }
})();

// --- Discovery ---
(async () => {
  try {
    await new Promise(r => setTimeout(r, 2000)); // Décalage pour éviter surcharge API
    await startDiscovery();
  } catch (e) {
    console.error("❌ CRASH INIT Discovery:", e);
  }
})();

// --- Degen ---
(async () => {
  try {
    await new Promise(r => setTimeout(r, 3000));
    await startDegen();
  } catch (e) {
    console.error("❌ CRASH INIT Degen:", e);
  }
})();

// --- Swing ---
(async () => {
  try {
    await new Promise(r => setTimeout(r, 4000));
    await startSwing();
  } catch (e) {
    console.error("❌ CRASH INIT Swing:", e);
  }
})();

console.log("🚀 Bots JTF lancés avec séquenceur.");
