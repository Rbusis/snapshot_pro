// market_bias.js — Moteur de biais directionnel dynamique basé sur le BTC
import fetch from "node-fetch";

async function safeGetJson(url) {
    try {
        const r = await fetch(url, { headers: { Accept: "application/json" } });
        if (!r.ok) return null;
        return await r.json();
    } catch (e) {
        return null;
    }
}

/**
 * Récupère la tendance du BTC
 * @returns {Promise<{bias: string, btcTrend: number, label: string}>}
 */
export async function getMarketBias() {
    try {
        const symbol = "BTCUSDT";
        // On regarde le ticker pour le prix actuel et le changement 24h
        const tkj = await safeGetJson(`https://api.bitget.com/api/v2/mix/market/ticker?symbol=${symbol}&productType=usdt-futures`);
        const tk = tkj?.data?.[0] || tkj?.data;

        if (!tk) return { bias: "BOTH", btcTrend: 0, label: "NEUTRAL (No Data)" };

        const last = +(tk.lastPr ?? tk.markPrice ?? tk.close);
        const change24 = +(tk.change24h || 0);

        // On récupère les bougies 4h pour le VWAP (tendance de fond)
        const cj = await safeGetJson(`https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}&granularity=14400&limit=24&productType=usdt-futures`);
        const candles = cj?.data ? cj.data.map(c => ({
            t: +c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5]
        })).sort((a, b) => a.t - b.t) : [];

        if (candles.length < 2) {
            return { bias: "BOTH", btcTrend: change24, label: "NEUTRAL (No Candles)" };
        }

        // Calcul simple du VWAP 4h
        let pv = 0, v = 0;
        for (const x of candles) {
            const p = (x.h + x.l + x.c) / 3;
            pv += p * x.v; v += x.v;
        }
        const vwap4h = v ? pv / v : last;
        const distVWAP = ((last / vwap4h) - 1) * 100;

        let bias = "BOTH";
        let label = "NEUTRAL";

        if (distVWAP > 0.5 && change24 > 0) {
            bias = "BOTH"; // On autorise tout mais on favorise LONG
            label = "BULLISH";
        } else if (distVWAP < -0.5 && change24 < 0) {
            bias = "BOTH"; // On autorise tout mais on favorise SHORT
            label = "BEARISH";
        }

        return { bias, btcTrend: distVWAP, label, change24 };
    } catch (e) {
        console.error("[MARKET_BIAS ERROR]", e);
        return { bias: "BOTH", btcTrend: 0, label: "ERROR" };
    }
}

/**
 * Applique l'asymétrie de score basée sur le biais
 * @param {string} direction - LONG ou SHORT
 * @param {object} marketContext - Le résultat de getMarketBias()
 * @returns {number} - Le bonus/malus à appliquer au score
 */
export function getBiasScoreAdjustment(direction, marketContext) {
    if (!marketContext) return 0;

    const { label } = marketContext;

    if (label === "BULLISH") {
        return direction === "LONG" ? 5 : -5; // Phase 5: Reduced from 10 to 5
    }
    if (label === "BEARISH") {
        return direction === "SHORT" ? 5 : -5; // Phase 5: Reduced from 10 to 5
    }

    return 0;
}
