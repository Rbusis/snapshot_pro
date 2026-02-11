import fs from 'fs';

const csvFile = '/Users/raphaelblanchon/Downloads/AES/Suivi_Trades_Phase4/Suivi_Trades_Phase4.csv';

try {
    const content = fs.readFileSync(csvFile, 'utf8');
    const lines = content.split('\n');
    const header = lines[0].split(';');

    // Find column indices
    const idxPnL = header.indexOf('PnL_Net');
    const idxDirection = header.indexOf('Direction');
    const idxExitRaison = header.indexOf('Exit_Raison');
    const idxBot = header.indexOf('Bot');

    let totalPnL = 0;
    let pnlLong = 0;
    let pnlShort = 0;
    let totalLong = 0;
    let totalShort = 0;

    let stats = {
        SWING: { total: 0, tp: 0, sl: 0, be: 0, tpde: 0, slde: 0, long: 0, short: 0, pnlLong: 0, pnlShort: 0, pnl: 0 },
        MAJORS: { total: 0, tp: 0, sl: 0, be: 0, tpde: 0, slde: 0, long: 0, short: 0, pnlLong: 0, pnlShort: 0, pnl: 0 },
        DISCOVERY: { total: 0, tp: 0, sl: 0, be: 0, tpde: 0, slde: 0, long: 0, short: 0, pnlLong: 0, pnlShort: 0, pnl: 0 },
        DEGEN: { total: 0, tp: 0, sl: 0, be: 0, tpde: 0, slde: 0, long: 0, short: 0, pnlLong: 0, pnlShort: 0, pnl: 0 },
    };

    let pnlTPDe = 0;
    let pnlSLDe = 0;
    let pnlBE = 0;

    for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const cols = lines[i].split(';');
        if (!cols[0] || isNaN(parseInt(cols[0]))) continue; // Skip non-trade rows

        const pnl = parseFloat((cols[idxPnL] || '0').replace(',', '.'));
        const dir = (cols[idxDirection] || '').toUpperCase();
        const raison = (cols[idxExitRaison] || '').toUpperCase();
        const botName = (cols[idxBot] || '').toUpperCase().replace(' ', ''); // Handle "TOP 30" -> TOP30? No, let's stick to CSV names

        // Find correct bot key
        let botKey = botName;
        if (botName === 'TOP30' || botName === 'TOP 30') botKey = 'MAJORS'; // Phase 4 mapping
        if (botName === 'DISCO') botKey = 'DISCOVERY';

        if (!stats[botKey]) {
            // If it's a known bot with slightly different name
            if (botName.includes('SWING')) botKey = 'SWING';
            else if (botName.includes('DEGEN')) botKey = 'DEGEN';
            else if (botName.includes('DISCOVERY')) botKey = 'DISCOVERY';
            else if (botName.includes('MAJORS') || botName.includes('TOP')) botKey = 'MAJORS';
        }

        if (!isNaN(pnl)) {
            totalPnL += pnl;
            if (dir === 'LONG') {
                pnlLong += pnl;
                totalLong++;
            } else if (dir === 'SHORT') {
                pnlShort += pnl;
                totalShort++;
            }

            if (raison === 'TPDE') pnlTPDe += pnl;
            if (raison === 'SLDE') pnlSLDe += pnl;
            if (raison === 'BE') pnlBE += pnl;

            if (stats[botKey]) {
                stats[botKey].total++;
                if (raison === 'TP') stats[botKey].tp++;
                if (raison === 'SL') stats[botKey].sl++;
                if (raison === 'BE') stats[botKey].be++;
                if (raison === 'TPDE') stats[botKey].tpde++;
                if (raison === 'SLDE') stats[botKey].slde++;
                if (dir === 'LONG') {
                    stats[botKey].long++;
                    stats[botKey].pnlLong += pnl;
                } else if (dir === 'SHORT') {
                    stats[botKey].short++;
                    stats[botKey].pnlShort += pnl;
                }
                stats[botKey].pnl += pnl;
            }
        }
    }

    console.log('--- GLOBAL RECALCULATION ---');
    console.log(`Total PnL: ${totalPnL.toFixed(4)}`);
    console.log(`PnL Long: ${pnlLong.toFixed(4)}`);
    console.log(`PnL Short: ${pnlShort.toFixed(4)}`);
    console.log(`Total Long: ${totalLong}`);
    console.log(`Total Short: ${totalShort}`);
    console.log(`PnL TPDe: ${pnlTPDe.toFixed(4)}`);
    console.log(`PnL SLDe: ${pnlSLDe.toFixed(4)}`);
    console.log(`PnL BE: ${pnlBE.toFixed(4)}`);

    console.log('\n--- BY BOT ---');
    console.log(JSON.stringify(stats, null, 2));

} catch (err) {
    console.error(`Error: ${err.message}`);
}
