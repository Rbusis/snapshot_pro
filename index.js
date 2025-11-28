import http from 'http';
import process from 'process'; // ✅ Ta syntaxe exacte

// --- 1. CONFIGURATION DU SERVEUR (PRIORITÉ ABSOLUE) ---
// On récupère le port fourni par Railway ou on utilise 8080 par défaut
const PORT = process.env.PORT || 8080;

// Création d'un serveur ultra-léger qui répond toujours "200 OK"
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('JTF Bot is running.');
});

// --- 2. DÉMARRAGE DU SERVEUR ---
// On écoute sur 0.0.0.0 pour être sûr d'être vu par Railway
server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ SERVEUR HTTP EN LIGNE sur le port ${PORT}`);
    
    // Une fois (et seulement une fois) que le serveur est prêt, on lance les bots
    // On attend 1 seconde pour être sûr que Railway a validé le port
    setTimeout(() => {
        lancerLesBots();
    }, 1000);
});

// --- 3. FONCTION DE CHARGEMENT DES BOTS ---
async function lancerLesBots() {
    console.log("🚀 Lancement des algorithmes...");

    // Chargement de DEGEN
    try {
        const degen = await import('./degen.js');
        if (degen.startDegen) degen.startDegen(); 
        console.log("🔹 DEGEN lancé.");
    } catch (e) {
        console.error("⚠️ Erreur DEGEN:", e.message);
    }

    // Chargement de AUTOSELECT
    try {
        const auto = await import('./autoselect.js');
        if (auto.startAutoselect) auto.startAutoselect();
        console.log("🔹 AUTOSELECT lancé.");
    } catch (e) {
        console.error("⚠️ Erreur AUTOSELECT:", e.message);
    }
}

// --- 4. GESTION DES CRASHS ---
// Empêche le conteneur de s'arrêter si une erreur survient dans un bot
process.on('uncaughtException', (err) => {
    console.error('🔥 ERREUR NON GÉRÉE (Le bot continue) :', err.message);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('🔥 PROMESSE REJETÉE (Le bot continue) :', reason);
});
