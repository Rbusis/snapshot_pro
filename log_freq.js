import fs from 'fs';

const logFile = '/Users/raphaelblanchon/Downloads/AES/logs.1770717090866.json';

try {
    const rawData = fs.readFileSync(logFile, 'utf8');
    const logs = JSON.parse(rawData);

    const messageFreq = {};
    logs.forEach(log => {
        // Normalize message (remove symbol names for better grouping)
        const msg = log.message.replace(/[A-Z0-9]+USDT/, 'SYMBOL');
        messageFreq[msg] = (messageFreq[msg] || 0) + 1;
    });

    const sorted = Object.entries(messageFreq).sort((a, b) => b[1] - a[1]);

    console.log('--- MESSAGE FREQUENCY ---');
    sorted.slice(0, 50).forEach(([msg, count]) => {
        console.log(`${count.toString().padStart(5)} | ${msg}`);
    });

} catch (err) {
    console.error(`Error: ${err.message}`);
}
