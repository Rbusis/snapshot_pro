import fs from 'fs';

const csvPath = '/Users/raphaelblanchon/Downloads/CFTT/Suivi_Trades_Phase2/Sheet 1-Suivi_Trades_Phase2.csv';

function analyzeTP() {
    const content = fs.readFileSync(csvPath, 'utf8');
    const lines = content.split('\n');

    const bots = ['DEGEN', 'DISCOVERY', 'SWING', 'TOP 30'];
    const botStats = {};
    bots.forEach(b => {
        botStats[b] = {
            total: 0,
            tp_total: 0,
            tp_unique: 0,
            tp1_only: 0,
            tp1_tp2: 0,
            avg_pnl_tp: 0,
            sum_pnl_tp: 0
        };
    });

    for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(';');
        if (cols.length < 12) continue;

        const botName = cols[4]?.trim();
        if (!botStats[botName]) continue;

        const exitRaison = cols[11]?.toUpperCase();
        const notes = cols[12]?.toUpperCase() || "";
        const pnl = parseFloat(cols[10]?.replace(',', '.')) || 0;

        botStats[botName].total++;

        if (exitRaison === 'TP' || notes.includes('TP')) {
            botStats[botName].tp_total++;
            botStats[botName].sum_pnl_tp += pnl;

            if (notes.includes('TP UNIQUE') || notes.includes('UNIQUE')) {
                botStats[botName].tp_unique++;
            } else if (notes.includes('TP1 & TP2') || (notes.includes('TP1') && notes.includes('TP2'))) {
                botStats[botName].tp1_tp2++;
            } else if (notes.includes('TP1')) {
                botStats[botName].tp1_only++;
            } else {
                // Default to unique if not specified and was a TP
                botStats[botName].tp_unique++;
            }
        }
    }

    console.log("# TAKE PROFIT PERFORMANCE ANALYSIS (PHASE 2)\n");

    bots.forEach(bot => {
        const s = botStats[bot];
        if (s.total === 0) return;

        const tpRate = (s.tp_total / s.total * 100).toFixed(1);
        const avgPnLTp = s.tp_total > 0 ? (s.sum_pnl_tp / s.tp_total).toFixed(2) : "0.00";

        console.log(`## ${bot}`);
        console.log(`- Total Trades: ${s.total}`);
        console.log(`- Total TP Hit: ${s.tp_total} (${tpRate}% Hit Rate)`);
        console.log(`- Avg PnL on TP: ${avgPnLTp} USDT`);
        console.log(`- Breakdown:`);
        console.log(`  > Unique TP: ${s.tp_unique}`);
        console.log(`  > TP1 Only:  ${s.tp1_only}`);
        console.log(`  > TP1 & TP2: ${s.tp1_tp2}`);

        // Strategy evaluation
        if (bot === 'TOP 30' && s.tp1_tp2 > 0) {
            console.log(`- Observation: TOP 30 capte souvent les deux TPs quand il gagne.`);
        }
        if (bot === 'DISCOVERY' && s.tp_unique > 10) {
            console.log(`- Observation: TP Unique est très efficace sur DISCOVERY.`);
        }
        console.log("");
    });
}

analyzeTP();
