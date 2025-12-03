// signals_registry.js
// Petit registre global pour éviter les doublons entre bots (Discovery, Degen, Swing, Top30…)

const lastSignals = new Map();

// fenêtre par défaut : 20 min
const GLOBAL_WINDOW_MS = 20 * 60_000;

export function registerSignal(source, symbol, direction) {
  lastSignals.set(symbol, {
    source,
    direction,
    ts: Date.now()
  });
}

export function isRecentlySignaled(symbol, windowMs = GLOBAL_WINDOW_MS) {
  const info = lastSignals.get(symbol);
  if (!info) return false;
  return (Date.now() - info.ts) < windowMs;
}