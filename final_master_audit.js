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
    if (totalMinutes === 0 && !isNaN(durationStr)) totalMinutes = parseInt(durationStr);
    return totalMinutes;
}

function analyze() {
    const content = fs.readFileSync(csvPath, 'utf8');
    const lines = content.split('\n');
    const data = [];

    for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(';');
        if (cols.length < 12) continue;

        const pnl = parseFloat(cols[10]?.replace(',', '.')) || 0;
        const timeRaw = cols[2];
        const durationRaw = cols[3];
        let entryHour = null;

        if (timeRaw && timeRaw.includes(':')) {
            const [exitH, exitM] = timeRaw.split(':').map(Number);
            const durationMins = parseDuration(durationRaw);
            let totalEntryMins = (exitH * 60 + exitM) - durationMins;
            while (totalEntryMins < 0) totalEntryMins += 24 * 60;
            entryHour = Math.floor(totalEntryMins / 60) % 24;
        }

        data.push({
            id: cols[0],
            date: cols[1],
            exitTime: cols[2],
            duration: cols[3],
            bot: cols[4]?.trim(),
            score: parseFloat(cols[5]?.replace(',', '.')) || 0,
            symbol: cols[6],
            direction: cols[7],
            pnl: pnl,
            reason: cols[11]?.toUpperCase() || "",
            notes: cols[12]?.toUpperCase() || "",
            entryHour: entryHour
        });
    }

    console.log("==============================================================");
    console.log("MASTER AUDIT PHASE 2 - FULL SYNTHESIS");
    console.log("==============================================================");

    // 1. SYMBOL PERFORMANCE (Toxic Symbols)
    const symbolStats = {};
    data.forEach(d => {
        if (!symbolStats[d.symbol]) symbolStats[d.symbol] = { pnl: 0, count: 0, wins: 0 };
        symbolStats[d.symbol].pnl += d.pnl;
        symbolStats[d.symbol].count++;
        if (d.pnl > 0.05) symbolStats[d.symbol].wins++;
    });

    const toxicSymbols = Object.entries(symbolStats)
        .sort((a, b) => a[1].pnl - b[1].pnl)
        .slice(0, 5);

    console.log("\n🚩 TOP 5 TOXIC SYMBOLS (Heavy Losses):");
    toxicSymbols.forEach(([sym, s]) => {
        console.log(`- ${sym.padEnd(12)}: ${s.pnl.toFixed(2).padStart(6)} USDT (${s.count} trades, WR: ${(s.wins / s.count * 100).toFixed(0)}%)`);
    });

    // 2. CONSECUTIVE LOSSES (Risk Audit)
    const bots = ['DEGEN', 'DISCOVERY', 'SWING', 'TOP 30'];
    console.log("\n⚠️ RISK AUDIT (Max Consecutive Losses):");
    bots.forEach(bot => {
        const botTrades = data.filter(d => d.bot === bot);
        let maxStreak = 0;
        let currentStreak = 0;
        botTrades.forEach(t => {
            if (t.pnl < -0.1) {
                currentStreak++;
                if (currentStreak > maxStreak) maxStreak = currentStreak;
            } else if (t.pnl > 0.1) {
                currentStreak = 0;
            }
        });
        console.log(`- ${bot.padEnd(10)}: Max ${maxStreak} consecutive losses`);
    });

    // 3. DIRECTIONAL BIAS vs MARKET
    console.log("\n📈 DIRECTIONAL EFFICIENCY:");
    const longPnl = data.filter(d => d.direction === 'LONG').reduce((s, d) => s + d.pnl, 0);
    const shortPnl = data.filter(d => d.direction === 'SHORT').reduce((s, d) => s + d.pnl, 0);
    const longCount = data.filter(d => d.direction === 'LONG').length;
    const shortCount = data.filter(d => d.direction === 'SHORT').length;

    console.log(`- LONG  : ${longCount} trades | Net PnL: ${longPnl.toFixed(2).padStart(6)} USDT | Avg: ${(longPnl / longCount).toFixed(2)}`);
    console.log(`- SHORT : ${shortCount} trades | Net PnL: ${shortPnl.toFixed(2).padStart(6)} USDT | Avg: ${(shortPnl / shortCount).toFixed(2)}`);

    // 4. THE "BAD HOUR" DRILL DOWN
    const h22 = data.filter(d => d.entryHour === 22);
    const h22Bots = {};
    h22.forEach(d => {
        if (!h22Bots[d.bot]) h22Bots[d.bot] = 0;
        h22Bots[d.bot] += d.pnl;
    });
    console.log("\n🕒 MIDNIGHT DRAIN DRILL-DOWN (22h TW Entry):");
    Object.entries(h22Bots).forEach(([bot, pnl]) => {
        console.log(`- ${bot.padEnd(10)}: ${pnl.toFixed(2).padStart(6)} USDT loss at 22h`);
    });

    // 5. CORRELATION RISK (Same Symbol, Same Time)
    let correlationEvents = 0;
    for (let i = 0; i < data.length; i++) {
        for (let j = i + 1; j < data.length; j++) {
            if (data[i].symbol === data[j].symbol && data[i].date === data[j].date && data[i].exitTime === data[j].exitTime) {
                correlationEvents++;
            }
        }
    }
    console.log(`\n🔗 CORRELATION RISK: ${correlationEvents} events (Multiple bots on same symbol/time).`);

    console.log("\n" + "=".repeat(62));
}

analyze();
