import http from ‘http’;
import { startAutoselect } from ‘./autoselect.js’;
import { startDiscovery } from ‘./discovery.js’;
import { startDegen } from ‘./degen.js’;
import { startSwing } from ‘./swing.js’;

const PORT = process.env.PORT || 8080;

http.createServer((req, res) => {
res.writeHead(200);
res.end(‘JTF QUAD-BOT IS RUNNING’);
}).listen(PORT, () => {
console.log(’Serveur ecoute sur le port ’ + PORT);
});

console.log(‘Demarrage de la flotte (4 Bots)…’);

startAutoselect().catch(e => console.error(‘CRASH Autoselect:’, e));
startDiscovery().catch(e => console.error(‘CRASH Discovery:’, e));
startDegen().catch(e => console.error(‘CRASH Degen:’, e));
startSwing().catch(e => console.error(‘CRASH Swing:’, e));