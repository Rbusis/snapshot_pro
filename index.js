import http from 'http';
import { fork } from 'child_process'; // Module natif Node pour lancer des processus séparés

// 1. CONFIGURATION DU SERVEUR (Pour Railway)
const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('JTF Controller is Online');
});

// 2. DÉMARRAGE DU SERVEUR (Immédiat)
server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ CONTENEUR STABILISÉ sur le port ${PORT}`);
    console.log(`🚀 Lancement des processus de trading en parallèle...`);

    // 3. LANCEMENT ISOLÉ DES BOTS
    // Si un bot crash, il ne tue pas le conteneur principal
    lancerBot('./degen.js', 'DEGEN');
    lancerBot('./autoselect.js', 'AUTOSELECT');
});

function lancerBot(scriptPath, nom) {
    // On utilise "fork" pour créer un processus enfant indépendant
    const child = fork(scriptPath);

    child.on('spawn', () => {
        console.log(`🔹 Processus ${nom} démarré avec succès (PID: ${child.pid})`);
    });

    child.on('error', (err) => {
        console.error(`❌ Erreur critique sur ${nom}:`, err.message);
    });

    child.on('exit', (code) => {
        if (code !== 0) {
            console.error(`⚠️ ${nom} s'est arrêté (Code: ${code}). Le serveur reste en ligne.`);
            // Optionnel : On peut redémarrer le bot automatiquement ici si on veut
        }
    });
}
