import fs from 'fs';

const phase3Path = '/Users/raphaelblanchon/Downloads/AES/Suivi_Trades_Phase3/Suivi_Trades_Phase3.csv';
const phase4Path = '/Users/raphaelblanchon/Downloads/AES/Suivi_Trades_Phase4/Suivi_Trades_Phase4/Trades-Sheet 1-Suivi_Trades_Phase4.csv';

function getStats(path, botName) {
    const data = fs.readFileSync(path, 'utf8');
    const lines = data.split('\n');
    const stats = {
        pnl: 0,
        count: 0,
        wins: 0,
        losses: 0,
        be: 0,
        avgScore: 0,
        scoreSum: 0,
        tpTotal: 0,
        tpPartial: 0,
        tpFull: 0
    };

    for (let i = 1; i < lines.length; i++) {
        const row = lines[i].split(';');
        if (row.length < 13 || row[6] !== botName) continue;

        const pnl = parseFloat(row[12].replace(',', '.'));
        const scoreStr = row[7].replace(',', '.');
        const score = isNaN(parseFloat(scoreStr)) ? null : parseFloat(scoreStr);
        const reason = row[13] || "";
        const notes = row[14] || "";

        if (isNaN(pnl)) continue;

        stats.count++;
        stats.pnl += pnl;
        if (score !== null) {
            stats.scoreSum += score;
        }

        if (pnl > 0.05) {
            stats.wins++;
            if (reason.includes('TP')) {
                stats.tpTotal++;
                if (notes.includes('TP1 & TP2') || notes.includes('TP2')) stats.tpFull++;
                else if (notes.includes('TP1')) stats.tpPartial++;
            }
        } else if (pnl < -0.05) {
            stats.losses++;
        } else {
            stats.be++;
        }
    }
    stats.avgScore = stats.count > 0 ? stats.scoreSum / stats.count : 0;
    return stats;
}

const disc3 = getStats(phase3Path, 'DISCOVERY');
const disc4 = getStats(phase4Path, 'DISCOVERY');

console.log("=== COMPARAISON DISCOVERY PHASE 3 vs 4 ===");
console.log("\n--- PHASE 3 ---");
console.log(`Trades: ${disc3.count}`);
console.log(`PnL Total: ${disc3.pnl.toFixed(4)}`);
console.log(`Win Rate: ${((disc3.wins / (disc3.count - disc3.be)) * 100).toFixed(2)}%`);
console.log(`Avg PnL/Trade: ${(disc3.pnl / disc3.count).toFixed(4)}`);
console.log(`TP Partiels (TP1 only): ${disc3.tpPartial}`);
console.log(`TP Full (TP1 & TP2): ${disc3.tpFull}`);

console.log("\n--- PHASE 4 ---");
console.log(`Trades: ${disc4.count}`);
console.log(`PnL Total: ${disc4.pnl.toFixed(4)}`);
console.log(`Win Rate: ${((disc4.wins / (disc4.count - disc4.be)) * 100).toFixed(2)}%`);
console.log(`Avg PnL/Trade: ${(disc4.pnl / disc4.count).toFixed(4)}`);
console.log(`TP Partiels (TP1 only): ${disc4.tpPartial}`);
console.log(`TP Full (TP1 & TP2): ${disc4.tpFull}`);
