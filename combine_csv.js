import fs from 'fs';

const tradesFile = '/Users/raphaelblanchon/Downloads/AES/Suivi_Trades_Phase4/Suivi_Trades_Phase4.csv';
const dashboardFile = '/Users/raphaelblanchon/Downloads/AES/Suivi_Trades_Phase4/Dashboard_Phase4.csv';
const outputFile = '/Users/raphaelblanchon/Downloads/AES/Suivi_Trades_Phase4/Suivi_Trades_Phase4_Complete.csv';

try {
    const dashboard = fs.readFileSync(dashboardFile, 'utf8');
    const trades = fs.readFileSync(tradesFile, 'utf8');

    const combined = dashboard + '\n\n' + trades;

    fs.writeFileSync(outputFile, combined);
    console.log(`Unified file created: ${outputFile}`);

} catch (err) {
    console.error(`Error: ${err.message}`);
}
