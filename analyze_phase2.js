import fs from 'fs';

const csvPath = '/Users/raphaelblanchon/Downloads/CFTT/Suivi_Trades_Phase2/Sheet 1-Suivi_Trades_Phase2.csv';

const phase1 = {
    SWING: { pnl: -1.07, trades: 19, beRate: 26, shortRate: 63 },
    DISCOVERY: { pnl: -6.51, trades: 39, beRate: 15, longWR: 35 },
    DEGEN: { pnl: 0.17, trades: 51, beRate: 10, longWR: 44 },
    TOP30: { pnl: -6.77, trades: 40, beRate: 5, longWR: 30.8 },
    total: -14.18
};

function analyzePhase2() {
    const content = fs.readFileSync(csvPath, 'utf8');
    const lines = content.split('\n');

    const bots = ['DEGEN', 'DISCOVERY', 'SWING', 'TOP 30'];
    const data = {};
    bots.forEach(b => data[b] = { trades: [], longTrades: [], shortTrades: [] });

    for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(';');
        if (cols.length < 11) continue;

        const botNameRaw = cols[4];
        // Normalize bot name
        let botName = botNameRaw;
        if (botNameRaw === 'TOP30') botName = 'TOP 30';

        if (!data[botName]) continue;

        const direction = cols[7];
        const pnl = parseFloat(cols[10]?.replace(',', '.')) || 0;
        const result = pnl > 0.05 ? 'WIN' : (pnl < -0.05 ? 'LOSS' : 'BE');

        const trade = { direction, pnl, result };
        data[botName].trades.push(trade);
        if (direction === 'LONG') data[botName].longTrades.push(trade);
        else if (direction === 'SHORT') data[botName].shortTrades.push(trade);
    }

    console.log("# GLOBAL ANALYSIS: PHASE 2\n");

    let totalP2PnL = 0;

    bots.forEach(bot => {
        const b = data[bot];
        if (b.trades.length === 0) return;

        const pnl = b.trades.reduce((sum, t) => sum + t.pnl, 0);
        totalP2PnL += pnl;

        const wins = b.trades.filter(t => t.result === 'WIN').length;
        const losses = b.trades.filter(t => t.result === 'LOSS').length;
        const be = b.trades.filter(t => t.result === 'BE').length;
        const wr = (wins / (wins + losses)) * 100;

        const beRate = (be / b.trades.length) * 100;
        const shortPct = (b.shortTrades.length / b.trades.length) * 100;

        const longWins = b.longTrades.filter(t => t.result === 'WIN').length;
        const longLosses = b.longTrades.filter(t => t.result === 'LOSS').length;
        const longWR = (longWins / (longWins + longLosses)) * 100;

        console.log(`## ${bot}`);
        console.log(`- Trades: ${b.trades.length} (vs P1: ${phase1[bot]?.trades || '?'})`);
        console.log(`- PnL: ${pnl.toFixed(2)} USDT (vs P1: ${phase1[bot]?.pnl} USDT)`);
        console.log(`- Win Rate (Total): ${wr.toFixed(1)}%`);
        console.log(`- Win Rate (LONG): ${isNaN(longWR) ? 'N/A' : longWR.toFixed(1) + '%'} (vs P1: ${phase1[bot]?.longWR || '?'}%)`);
        console.log(`- BE Rate: ${beRate.toFixed(1)} % (vs P1: ${phase1[bot]?.beRate} %)`);
        console.log(`- Direction: ${shortPct.toFixed(0)}% SHORT / ${(100 - shortPct).toFixed(0)}% LONG`);
        console.log("");
    });

    console.log(`## TOTAL PHASE 2 PnL: ${totalP2PnL.toFixed(2)} USDT`);
    console.log(`## EVOLUTION vs PHASE 1: ${(totalP2PnL - phase1.total).toFixed(2)} USDT`);
}

analyzePhase2();
