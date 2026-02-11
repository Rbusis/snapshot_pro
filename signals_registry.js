// signals_registry.js
import fs from "fs";
const REGISTRY_FILE = "./signals_history.json";

function loadHistory() {
  try {
    if (fs.existsSync(REGISTRY_FILE)) {
      const data = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8"));
      return new Map(Object.entries(data));
    }
  } catch (e) { console.error("[REGISTRY] Error loading history", e); }
  return new Map();
}

function saveHistory(map) {
  try {
    const data = Object.fromEntries(map);
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(data, null, 2));
  } catch (e) { console.error("[REGISTRY] Error saving history", e); }
}

const lastSignals = loadHistory();

// Fenêtre par défaut : 45 min (pour éviter la sur-exposition sur un même symbole)
const GLOBAL_WINDOW_MS = 45 * 60_000;

export function registerSignal(source, symbol, direction) {
  lastSignals.set(symbol, {
    source,
    direction,
    ts: Date.now()
  });
  saveHistory(lastSignals);
}

export function isRecentlySignaled(symbol, windowMs = GLOBAL_WINDOW_MS) {
  const info = lastSignals.get(symbol);
  if (!info) return false;
  return (Date.now() - info.ts) < windowMs;
}

/**
 * Filtre Midnight Taiwan (22h00 - 00h30 Taiwan)
 * Bloque les nouvelles entrées durant ce créneau risqué.
 */
export function isTimeBlocked() {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Taipei",
      hour: "numeric",
      minute: "numeric",
      hour12: false
    });
    const parts = formatter.formatToParts(now);
    const h = parseInt(parts.find(p => p.type === "hour").value);
    const m = parseInt(parts.find(p => p.type === "minute").value);

    // Blocage entre 22:00 et 00:30
    if (h >= 22) return true;
    if (h === 0 && m <= 30) return true;
  } catch (e) {
    console.error("[TIME FILTER ERROR]", e);
  }
  return false;
}