import http from 'http';
import process from 'process';

// --- IMPORTS DES MODULES ---
// Utilise try/catch pour ne pas tout planter si un fichier manque
async function loadBot(name, path) {
    try {
        const module = await import(path);
        if (module.default) module.default(); // Si export default
        else if (module.startDegen) module.startDegen(); // Cas spécifique degen
        else if (module.startAutoselect) module.startAutoselect(); // Cas spécifique autoselect
        // Ajoute ici d'autres noms de fonctions si besoin (ex: startDiscovery)
        else {
            // Tente de lancer la première fonction exportée trouvée
            const keys = Object.keys(module);
            if (keys.length > 0 && typeof module[keys[0]] === 'function') {
                module[keys[0]]();
            }
        }
        console.log(`✅ ${name} lancé.`);
    } catch (e) {
        console.error(`⚠️ Impossible de lancer ${name} :`, e.message);
    }
}

// --- 1. SERVEUR HTTP (CRITIQUE POUR RAILWAY) ---
const requestListener = function (req, res) {
  res.writeHead(200);
  res.end('JTF Bot is running!');
};

const port = process.env.PORT || 8080;
const server = http.createServer(requestListener);

server.listen(port, () => {
    console.log(`🌍 Serveur HTTP écoutant sur le port ${port} (Requis pour Railway)`);
    
    // --- 2. LANCEMENT DES BOTS ---
    console.log("🚀 Démarrage des modules JTF...");

    // Lance les bots sans bloquer le thread principal
    loadBot("DEGEN Sniper", "./degen.js");
    loadBot("AUTOSELECT", "./autoselect.js");
    
    // Si tu as discovery.js ou swing.js, décommente :
    // loadBot("DISCOVERY", "./discovery.js");
    // loadBot("SWING", "./swing.js");
});

// --- GESTION DES ERREURS GLOBALES ---
process.on('uncaughtException', (err) => {
    console.error('🔥 CRASH NON GÉRÉ :', err);
    // On ne quitte PAS le process pour garder le conteneur vivant
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('🔥 PROMESSE REJETÉE :', reason);
});
