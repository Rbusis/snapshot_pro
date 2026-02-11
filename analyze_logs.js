import fs from 'fs';

const logFile = '/Users/raphaelblanchon/Downloads/AES/logs.1770717090866.json';

try {
    const rawData = fs.readFileSync(logFile, 'utf8');
    const logs = JSON.parse(rawData);

    console.log(`Total log entries: ${logs.length}`);

    const bots = ['DEGEN', 'DISCOVERY', 'SWING', 'MAJORS'];
    const summary = {};
    bots.forEach(bot => {
        summary[bot] = {
            scans: 0,
            signals: [],
            errors: [],
            debugs: 0,
            maxScore: 0,
            maxScoreDetails: ''
        };
    });

    logs.forEach(log => {
        const msg = log.message;
        const botMatch = msg.match(/\[(DEGEN|DISCOVERY|SWING|MAJORS)/i);
        const botName = botMatch ? botMatch[1].toUpperCase() : null;

        if (msg.includes('ERROR') || msg.toLowerCase().includes('fail') || msg.toLowerCase().includes('exception') || msg.includes('BLOCKED') || msg.includes('TRAP')) {
            if (botName) summary[botName].errors.push({ msg, timestamp: log.timestamp });
            else console.log(`Non-bot anomaly: ${msg}`);
        }

        if (msg.includes('Scan Summary') || msg.includes('SCAN STARTED') || msg.includes('SCANNING')) {
            if (botName) summary[botName].scans++;
        }

        if (msg.includes('SIGNAL') || msg.includes('🔥')) {
            if (botName) summary[botName].signals.push({ msg, timestamp: log.timestamp });
        }

        if (msg.includes('DEBUG')) {
            summary[botName].debugs++;
            const scoreMatch = msg.match(/Score: ([\d.]+)/) || msg.match(/JDS: ([\d.]+)/);
            if (scoreMatch) {
                const score = parseFloat(scoreMatch[1]);
                if (score > summary[botName].maxScore) {
                    summary[botName].maxScore = score;
                    summary[botName].maxScoreDetails = msg;
                }
            }
        }

        if (msg.includes('TELEGRAM') || msg.includes('TG')) {
            console.log(`Notification: ${msg} at ${log.timestamp}`);
        }
    });

    console.log('\n--- ANALYSIS SUMMARY ---');
    bots.forEach(bot => {
        console.log(`\nBot: ${bot}`);
        console.log(`  Scans: ${summary[bot].scans}`);
        console.log(`  Debug messages: ${summary[bot].debugs}`);
        console.log(`  Max Score found: ${summary[bot].maxScore}`);
        console.log(`  Max Score Details: ${summary[bot].maxScoreDetails}`);
        console.log(`  Signals found: ${summary[bot].signals.length}`);
        summary[bot].signals.forEach(s => console.log(`    - ${s.msg} (${s.timestamp})`));
        console.log(`  Errors found: ${summary[bot].errors.length}`);
        summary[bot].errors.forEach(e => console.log(`    - ${e.msg} (${e.timestamp})`));
    });

} catch (err) {
    console.error(`Error processing logs: ${err.message}`);
}
