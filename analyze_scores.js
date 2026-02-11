import fs from 'fs';

const csvPath = '/Users/raphaelblanchon/Downloads/CFTT/Suivi_Trades_Phase2/Sheet 1-Suivi_Trades_Phase2.csv';

function analyze() {
    const content = fs.readFileSync(csvPath, 'utf8');
    const lines = content.split('\n');

    const bots = ['DEGEN', 'DISCOVERY', 'SWING', 'TOP 30'];
    const botData = {};
    bots.forEach(b => botData[b] = []);

    for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(';');
        if (cols.length < 11) continue;

        const botName = cols[4]?.trim();
        const scoreRaw = cols[5]?.replace(',', '.');
        const pnlRaw = cols[10]?.replace(',', '.');

        const score = parseFloat(scoreRaw);
        const pnl = parseFloat(pnlRaw);

        if (isNaN(score) || isNaN(pnl)) continue;
        if (!botData[botName]) botData[botName] = [];

        const entry = { score, pnl, result: pnl > 0.05 ? 'WIN' : (pnl < -0.05 ? 'LOSS' : 'BE') };
        botData[botName].push(entry);
    }

    function getStats(data, botName) {
        if (data.length === 0) return;

        const totalPnL = data.reduce((sum, d) => sum + d.pnl, 0);
        const wins = data.filter(d => d.result === 'WIN').length;
        const losses = data.filter(d => d.result === 'LOSS').length;
        const be = data.filter(d => d.result === 'BE').length;
        const wr = (wins / (wins + losses)) * 100;

        console.log(`\n=== ${botName} Analysis ===`);
        console.log(`Total Trades: ${data.length}`);
        console.log(`Total PnL: ${totalPnL.toFixed(2)} USDT`);
        console.log(`Win Rate (excl. BE): ${wr.toFixed(1)}%`);
        console.log(`Wins: ${wins} | Losses: ${losses} | BE: ${be}`);

        // Brackets
        const brackets = [
            { min: 60, max: 69.9, name: '60-69' },
            { min: 70, max: 79.9, name: '70-79' },
            { min: 80, max: 84.9, name: '80-84' },
            { min: 85, max: 89.9, name: '85-89' },
            { min: 90, max: 94.9, name: '90-94' },
            { min: 95, max: 100, name: '95-100' }
        ];

        console.log(`\nBrackets for ${botName}:`);
        brackets.forEach(b => {
            const bData = data.filter(d => d.score >= b.min && d.score <= b.max);
            if (bData.length === 0) return;

            const bPnL = bData.reduce((sum, d) => sum + d.pnl, 0);
            const bWins = bData.filter(d => d.result === 'WIN').length;
            const bLosses = bData.filter(d => d.result === 'LOSS').length;
            const bWR = (bWins / (bWins + bLosses)) * 100;

            console.log(`${b.name}: ${bData.length} tr | PnL: ${bPnL.toFixed(2).padStart(6)} | WR: ${isNaN(bWR) ? '0%' : bWR.toFixed(1) + '%'}`);
        });
    }

    Object.keys(botData).forEach(bot => getStats(botData[bot], bot));
}

analyze();
