import fs from 'fs';

const csvPath = '/Users/raphaelblanchon/Downloads/CFTT/Suivi_Trades_Phase2/Sheet 1-Suivi_Trades_Phase2.csv';

function parseDuration(durationStr) {
    if (!durationStr) return 0;
    let totalMinutes = 0;

    const dayMatch = durationStr.match(/(\d+)d/);
    if (dayMatch) totalMinutes += parseInt(dayMatch[1]) * 24 * 60;

    const hourMatch = durationStr.match(/(\d+)h/);
    if (hourMatch) totalMinutes += parseInt(hourMatch[1]) * 60;

    const minMatch = durationStr.match(/(\d+)m/);
    if (minMatch) totalMinutes += parseInt(minMatch[1]);

    // Fallback if only digits are present (handle as minutes or hours depending on context, assuming minutes if small)
    if (totalMinutes === 0 && !isNaN(durationStr)) {
        totalMinutes = parseInt(durationStr);
    }

    return totalMinutes;
}

function analyzeTimePerformance() {
    const content = fs.readFileSync(csvPath, 'utf8');
    const lines = content.split('\n');

    const hourlyStats = {}; // { hour: { pnl: 0, count: 0, wins: 0 } }
    for (let i = 0; i < 24; i++) {
        hourlyStats[i] = { pnl: 0, count: 0, wins: 0, losses: 0, be: 0 };
    }

    for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(';');
        if (cols.length < 11) continue;

        const dateRaw = cols[1]; // format "29/12/2025"
        const timeRaw = cols[2]; // format "16:12" (Exit Time)
        const durationRaw = cols[3]; // format "1h", "1d 6h", etc.

        if (!timeRaw || !timeRaw.includes(':')) continue;

        const [exitH, exitM] = timeRaw.split(':').map(Number);
        const durationMins = parseDuration(durationRaw);

        // Calculate Entry Time
        let totalExitMins = exitH * 60 + exitM;
        let totalEntryMins = totalExitMins - durationMins;

        // Handle negative (prev day)
        while (totalEntryMins < 0) {
            totalEntryMins += 24 * 60;
        }

        const entryHour = Math.floor(totalEntryMins / 60) % 24;
        const pnl = parseFloat(cols[10]?.replace(',', '.')) || 0;
        const result = pnl > 0.05 ? 'WIN' : (pnl < -0.05 ? 'LOSS' : 'BE');

        if (isNaN(entryHour)) continue;

        hourlyStats[entryHour].pnl += pnl;
        hourlyStats[entryHour].count += 1;
        if (result === 'WIN') hourlyStats[entryHour].wins += 1;
        else if (result === 'LOSS') hourlyStats[entryHour].losses += 1;
        else hourlyStats[entryHour].be += 1;
    }

    console.log("# TIME-BASED ANALYSIS (BY ENTRY HOUR - PHASE 2)\n");

    const sessions = [
        { name: "ASIA (00:00 - 08:00)", range: [0, 7] },
        { name: "EUROPE (08:00 - 16:00)", range: [8, 15] },
        { name: "US (16:00 - 00:00)", range: [16, 23] }
    ];

    sessions.forEach(session => {
        let sPnL = 0;
        let sCount = 0;
        let sWins = 0;
        let sLosses = 0;

        for (let h = session.range[0]; h <= session.range[1]; h++) {
            sPnL += hourlyStats[h].pnl;
            sCount += hourlyStats[h].count;
            sWins += hourlyStats[h].wins;
            sLosses += hourlyStats[h].losses;
        }

        const wr = (sWins / (sWins + sLosses)) * 100;
        console.log(`## ${session.name}`);
        console.log(`- Trades: ${sCount}`);
        console.log(`- PnL: ${sPnL.toFixed(2)} USDT`);
        console.log(`- Win Rate: ${isNaN(wr) ? '0' : wr.toFixed(1)}%`);
        console.log("");
    });

    console.log("## HOURLY BREAKDOWN (ENTRY HOUR)");
    const sortedHours = Object.keys(hourlyStats).sort((a, b) => hourlyStats[b].pnl - hourlyStats[a].pnl);

    console.log("\nTop 3 Entry Hours:");
    sortedHours.slice(0, 3).forEach(h => {
        console.log(`- ${h}h: ${hourlyStats[h].pnl.toFixed(2)} USDT (${hourlyStats[h].count} trades)`);
    });

    console.log("\nBottom 3 Entry Hours:");
    sortedHours.slice(-3).reverse().forEach(h => {
        const hour = parseInt(h);
        console.log(`- ${hour}h: ${hourlyStats[hour].pnl.toFixed(2)} USDT (${hourlyStats[hour].count} trades)`);

        // Drill down for direction
        const drillDown = lines.slice(1).map(l => l.split(';')).filter(cols => {
            if (cols.length < 11) return false;
            const timeRaw = cols[2];
            const durationRaw = cols[3];
            if (!timeRaw || !timeRaw.includes(':')) return false;
            const [exitH, exitM] = timeRaw.split(':').map(Number);
            const durationMins = parseDuration(durationRaw);
            let totalEntryMins = (exitH * 60 + exitM) - durationMins;
            while (totalEntryMins < 0) totalEntryMins += 24 * 60;
            return Math.floor(totalEntryMins / 60) % 24 === hour;
        });

        const longs = drillDown.filter(c => c[7] === 'LONG');
        const shorts = drillDown.filter(c => c[7] === 'SHORT');
        const longPnL = longs.reduce((s, c) => s + (parseFloat(c[10]?.replace(',', '.')) || 0), 0);
        const shortPnL = shorts.reduce((s, c) => s + (parseFloat(c[10]?.replace(',', '.')) || 0), 0);

        console.log(`  > LONG:  ${longs.length} tr | PnL: ${longPnL.toFixed(2)} USDT`);
        console.log(`  > SHORT: ${shorts.length} tr | PnL: ${shortPnL.toFixed(2)} USDT`);
    });
}

analyzeTimePerformance();
