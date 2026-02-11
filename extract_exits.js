import fs from 'fs';

const logFile = '/Users/raphaelblanchon/Downloads/AES/logs.1770717090866.json';
const csvFile = '/Users/raphaelblanchon/Downloads/AES/Suivi_Trades_Phase4/Suivi_Trades_Phase4.csv';

try {
    const rawData = fs.readFileSync(logFile, 'utf8');
    const logs = JSON.parse(rawData);

    console.log(`Total log entries: ${logs.length}`);

    const tradeExits = logs.filter(log =>
        !log.message.includes('DEBUG') &&
        !log.message.includes('Scan Summary') &&
        !log.message.includes('SCAN STARTED')
    );

    console.log(`Potential trade exits found: ${tradeExits.length}`);
    tradeExits.forEach(exit => {
        console.log(`[${exit.timestamp}] ${exit.message}`);
    });

} catch (err) {
    console.error(`Error: ${err.message}`);
}
