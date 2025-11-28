import http from 'http';
import process from 'process'; // Ta syntaxe préférée

// --- CONFIGURATION SERVEUR (Indispensable pour Railway) ---
const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('JTF Bot is Active');
});

// On démarre le serveur D'ABORD pour valider le Health Check
server.listen(PORT, '0.0.0.0', async () => {
    console.log(`✅ SERVEUR EN LIGNE sur le port ${PORT}`);
    console.log("🚀 Lancement des bots via import...");

    // --- LANCEMENT DES BOTS ---
    try {
        // 1. Degen
        // On utilise import() dynamique pour ne pas bloquer le chargement du serveur
        const degen = await import('./degen.js');
        if (degen.startDegen) {
            degen.startDegen(); // On APPELLE la fonction, ce qui lance la boucle while(true)
            console.log("🔹 DEGEN v1.1 démarré.");
        } else {
            console.error("⚠️ Fonction startDegen introuvable dans degen.js");
        }

        // 2. Autoselect
        const autoselect = await import('./autoselect.js');
        if (autoselect.startAutoselect) {
            autoselect.startAutoselect(); // On APPELLE la fonction
            console.log("🔹 AUTOSELECT v0.8.4 démarré.");
        } else {
            console.error("⚠️ Fonction startAutoselect introuvable dans autoselect.js");
        }

    } catch (e) {
        console.error("❌ Erreur fatale au lancement des bots :", e);
    }
});

// Anti-crash global
process.on('uncaughtException', (err) => console.error('🔥 Crash non géré :', err));
process.on('unhandledRejection', (reason) => console.error('🔥 Promesse rejetée :', reason));
