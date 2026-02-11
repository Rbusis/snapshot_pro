import fs from 'fs';

const csvPath = '/Users/raphaelblanchon/Downloads/AES/Suivi_Trades_Phase4/Suivi_Trades_Phase4/Trades-Sheet 1-Suivi_Trades_Phase4.csv';

function analyze() {
    const data = fs.readFileSync(csvPath, 'utf8');
    const lines = data.split('\n');
    const header = lines[0].split(';');

    // Header check
    // 6: Bot, 7: Score, 12: PnL_Net, 13: Exit_Raison, 9: Direction

    const stats = {
        totalTrades: 0,
        bots: {},
        directions: { LONG: { pnl: 0, count: 0 }, SHORT: { pnl: 0, count: 0 } },
        scores: [],
        winners: 0,
        losers: 0,
        be: 0,
        totalPnL: 0,
        scoreBuckets: {
            "80-84.9": { pnl: 0, count: 0, wins: 0 },
            "85-89.9": { pnl: 0, count: 0, wins: 0 },
            "90-100": { pnl: 0, count: 0, wins: 0 }
        },
        timeLimitImpact: {
            SL: 0,
            BE: 0,
            TP: 0,
            count: 0
        }
    };

    for (let i = 1; i < lines.length; i++) {
        const row = lines[i].split(';');
        if (row.length < 13 || !row[0] || i > 40) continue; // Only first 40 trades

        const bot = row[6];
        const scoreStr = row[7].replace(',', '.');
        const score = parseFloat(scoreStr);
        const pnl = parseFloat(row[12].replace(',', '.'));
        const reason = row[13];
        const direction = row[9];
        const notes = row[14];

        if (isNaN(pnl)) continue;

        stats.totalTrades++;
        stats.totalPnL += pnl;

        // Bot stats
        if (!stats.bots[bot]) stats.bots[bot] = { pnl: 0, count: 0, wins: 0, losses: 0, be: 0 };
        stats.bots[bot].count++;
        stats.bots[bot].pnl += pnl;

        // Direction stats
        if (stats.directions[direction]) {
            stats.directions[direction].count++;
            stats.directions[direction].pnl += pnl;
        }

        // Win/Loss/BE
        if (pnl > 0.05) { // Small buffer for "BE"
            stats.winners++;
            stats.bots[bot].wins++;
        } else if (pnl < -0.05) {
            stats.losers++;
            stats.bots[bot].losses++;
        } else {
            stats.be++;
            stats.bots[bot].be++;
        }

        // Score buckets
        let bucket = "";
        if (score >= 80 && score < 85) bucket = "80-84.9";
        else if (score >= 85 && score < 90) bucket = "85-89.9";
        else if (score >= 90) bucket = "90-100";

        if (bucket) {
            stats.scoreBuckets[bucket].count++;
            stats.scoreBuckets[bucket].pnl += pnl;
            if (pnl > 0.05) stats.scoreBuckets[bucket].wins++;
        }

        // Time limit
        if (notes && notes.includes('temps limite')) {
            stats.timeLimitImpact.count++;
            if (reason.includes('SL')) stats.timeLimitImpact.SL++;
            else if (reason.includes('BE')) stats.timeLimitImpact.BE++;
            else if (reason.includes('TP')) stats.timeLimitImpact.TP++;
        }
    }

    console.log("=== GLOBAL STATS (40 TRADES) ===");
    console.log(`Total PnL: ${stats.totalPnL.toFixed(4)}`);
    console.log(`Total Trades: ${stats.totalTrades}`);
    console.log(`Win Rate (excl. BE): ${((stats.winners / (stats.totalTrades - stats.be)) * 100).toFixed(2)}%`);
    console.log(`Winners: ${stats.winners}, Losers: ${stats.losers}, BE: ${stats.be}`);

    console.log("\n=== STATS BY BOT ===");
    for (const bot in stats.bots) {
        const b = stats.bots[bot];
        console.log(`${bot}: PnL=${b.pnl.toFixed(4)}, Count=${b.count}, WR=${((b.wins / (b.count - b.be)) * 100).toFixed(2)}%`);
    }

    console.log("\n=== STATS BY DIRECTION ===");
    console.log(`LONG: PnL=${stats.directions.LONG.pnl.toFixed(4)}, Count=${stats.directions.LONG.count}`);
    console.log(`SHORT: PnL=${stats.directions.SHORT.pnl.toFixed(4)}, Count=${stats.directions.SHORT.count}`);

    console.log("\n=== SCORE BUCKET PERFORMANCE ===");
    for (const bucket in stats.scoreBuckets) {
        const b = stats.scoreBuckets[bucket];
        const wr = b.count > 0 ? (b.wins / b.count * 100).toFixed(2) : 0;
        console.log(`${bucket}: PnL=${b.pnl.toFixed(4)}, Count=${b.count}, WinRate=${wr}%`);
    }

    console.log("\n=== TIME LIMIT IMPACT ===");
    console.log(`Trades affected by Time Limit: ${stats.timeLimitImpact.count}`);
    console.log(`Exited via SL: ${stats.timeLimitImpact.SL}`);
    console.log(`Exited via BE: ${stats.timeLimitImpact.BE}`);
    console.log(`Exited via TP: ${stats.timeLimitImpact.TP}`);
}

analyze();
