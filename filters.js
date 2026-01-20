/**
 * filters.js - Filtres avancés pour la Phase 3
 * Fournit des indicateurs sur l'Orderbook, le Funding et l'Open Interest.
 */
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
 * Calcule l'imbalance de l'orderbook (Bid/Ask Ratio)
 * @param {string} symbol
 * @returns {Promise<number>} - Ratio > 1 (Bullish), < 1 (Bearish)
 */
export async function getOrderbookImbalance(symbol) {
    try {
        const url = `https://api.bitget.com/api/v2/mix/market/depth?symbol=${symbol}&limit=10&productType=usdt-futures`;
        const data = await safeGetJson(url);
        if (!data?.data) return 1;

        const { bids, asks } = data.data;
        // Somme des volumes sur les 10 meilleurs niveaux
        const sumBids = bids.reduce((sum, item) => sum + parseFloat(item[1]), 0);
        const sumAsks = asks.reduce((sum, item) => sum + parseFloat(item[1]), 0);

        if (sumAsks === 0) return 2; // Arbitraire si vide
        return sumBids / sumAsks;
    } catch (e) {
        return 1;
    }
}

/**
 * Récupère le taux de financement actuel
 * @param {string} symbol
 * @returns {Promise<number>}
 */
export async function getFundingRate(symbol) {
    try {
        const url = `https://api.bitget.com/api/v2/mix/market/ticker?symbol=${symbol}&productType=usdt-futures`;
        const data = await safeGetJson(url);
        if (!data?.data?.[0]) return 0;
        return parseFloat(data.data[0].fundingRate || 0);
    } catch (e) {
        return 0;
    }
}

/**
 * Détecte une impulsion ou une purge de l'Open Interest
 * @param {string} symbol
 * @returns {Promise<number>} - Changement en % de l'OI sur la dernière période
 */
export async function getOIImpulse(symbol) {
    try {
        // Bitget n'a pas forcément un endpoint simple pour l'impulsion OI directe en v2 market sans candles
        // On peut utiliser les ticker ou les stats si disponibles, ou comparer les candles si elles l'incluent
        // Pour la v2, l'OI est dans les stats du ticker
        const url = `https://api.bitget.com/api/v2/mix/market/ticker?symbol=${symbol}&productType=usdt-futures`;
        const data = await safeGetJson(url);
        if (!data?.data?.[0]) return 0;

        // On n'a qu'une valeur ponctuelle ici. Pour une impulsion, il faudrait comparer avec t-1.
        // Simplification pour Phase 3 : On renvoie la valeur absolue brute pour scoring relatif si besoin
        // Ou on assume que le bot stocke la valeur précédente si on veut une impulsion.
        return parseFloat(data.data[0].holdingAmount || data.data[0].openInterest || 0);
    } catch (e) {
        return 0;
    }
}

/**
 * Applique les filtres de sécurité pour un signal donné
 * @param {string} symbol
 * @param {string} direction
 * @param {number} currentScore
 * @returns {Promise<{isBlocked: boolean, reason: string, scoreAdj: number}>}
 */
export async function applyAdvancedFilters(symbol, direction, currentScore) {
    const imbalance = await getOrderbookImbalance(symbol);
    const funding = await getFundingRate(symbol);

    let scoreAdj = 0;
    let isBlocked = false;
    let reason = "";

    // 1. Filtre Orderbook (Anti-Mur)
    if (direction === "LONG" && imbalance < 0.7) {
        isBlocked = true;
        reason = "Orderbook Bearish (Imbalance < 0.7)";
    } else if (direction === "SHORT" && imbalance > 1.4) {
        isBlocked = true;
        reason = "Orderbook Bullish (Imbalance > 1.4)";
    }

    // 2. Filtre Funding (Anti-Euphorie)
    if (direction === "LONG" && funding > 0.03) {
        isBlocked = true;
        reason = `High Funding (${(funding * 100).toFixed(3)}%)`;
    }

    // 3. Scoring Bonus
    if (direction === "LONG" && imbalance > 1.2) scoreAdj += 5;
    if (direction === "SHORT" && imbalance < 0.8) scoreAdj += 5;

    return { isBlocked, reason, scoreAdj };
}
