import fs from 'fs';

const csvFile = '/Users/raphaelblanchon/Downloads/AES/Suivi_Trades_Phase4/Suivi_Trades_Phase4.csv';
const outputFile = '/Users/raphaelblanchon/Downloads/AES/Suivi_Trades_Phase4/Suivi_Trades_Phase4_Clean.csv';

try {
    const content = fs.readFileSync(csvFile, 'utf8');
    const lines = content.split('\n');
    const newLines = lines.map(line => {
        if (!line.trim()) return line;
        const cols = line.split(';');
        // Keep only columns 0 to 15 (16 columns)
        // Original has columns up to 23 (24 columns total)
        return cols.slice(0, 16).join(';');
    });

    fs.writeFileSync(outputFile, newLines.join('\n'));
    console.log(`Cleaned CSV written to ${outputFile}`);

} catch (err) {
    console.error(`Error: ${err.message}`);
}
