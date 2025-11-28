import http from 'http';
import process from 'process';

// Fonction simple pour charger les modules sans planter
async function startBot(name, path) {
    try {
        console.log(`⏳ Chargement de ${name}...`);
        const module = await import(path);
        
        // Lance la fonction de démarrage trouvée
        if (module.startDegen) module.startDegen();
        else if (module.startAutoselect) module.startAutoselect();
        else if (module.default) module.default();
        
        console.log(`✅ ${name} DÉMARRÉ.`);
    } catch (e) {
        console.error(`❌ ÉCHEC ${name}:`, e.message);
    }
}

// --- CONFIGURATION DU SERVEUR (CRITIQUE) ---
const PORT = process.env.PORT || 8080;
const HOST = '0.0.0.0'; // <--- LA CLÉ EST ICI (Force l'écoute publique pour Railway)

const server = http.createServer((req, res) => {
    // Répond toujours 200 OK pour que Railway soit content
    res.writeHead(200);
    res.end('JTF Bot is running OK.');
});

// --- DÉMARRAGE ---
server.listen(PORT, HOST, () => {
    console.log(`🌍 SERVEUR HTTP OK : http://${HOST}:${PORT}`);
    console.log("🚀 Lancement des algorithmes de trading...");

    // Lance tes deux bots
    startBot("DEGEN Sniper", "./degen.js");
    startBot("AUTOSELECT", "./autoselect.js");
});

// --- ANTI-CRASH ---
process.on('uncaughtException', (err) => console.error('🔥 CRASH :', err));
process.on('unhandledRejection', (reason) => console.error('🔥 REJET :', reason));
