import http from 'http';
import { spawn } from 'child_process';
import process from 'process';

// --- CONFIGURATION RAILWAY ---
const PORT = process.env.PORT || 8080;

// 1. Démarrage du "Faux Serveur" pour satisfaire Railway
const server = http.createServer((req, res) => {
    // On logue chaque ping pour vérifier que Railway nous parle
    console.log(`Ping reçu de Railway: ${req.method} ${req.url}`);
    res.writeHead(200);
    res.end('JTF Bot Controller is Active.');
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ SERVEUR WEB EN LIGNE (Port ${PORT})`);
    console.log(`⏳ Attente de 10 secondes avant de lancer le trading pour validation Railway...`);

    // 2. On attend que Railway valide le conteneur AVANT de lancer quoi que ce soit de lourd
    setTimeout(() => {
        console.log("🚀 DÉMARRAGE DES BOTS MAINTENANT...");
        startProcess('./degen.js', 'DEGEN');
        startProcess('./autoselect.js', 'AUTOSELECT');
    }, 10000); // 10 secondes de délai
});

// Système de "Keep-Alive" pour prouver que le script ne plante pas
setInterval(() => {
    console.log("💓 Heartbeat: Le processus principal est vivant...");
}, 5000);

// --- FONCTION DE LANCEMENT ROBUSTE ---
function startProcess(scriptPath, label) {
    // On utilise 'spawn' qui est plus détaché que 'fork'
    // Cela évite que le bot ne partage la même mémoire que le serveur web
    const child = spawn('node', [scriptPath], {
        stdio: 'inherit', // On redirige les logs du bot vers la console principale
        env: process.env  // On passe les variables d'environnement (API KEYS)
    });

    child.on('error', (err) => {
        console.error(`❌ ERREUR CRITIQUE sur ${label}:`, err.message);
    });

    child.on('exit', (code) => {
        console.log(`⚠️ ${label} s'est arrêté (Code ${code}). Le serveur web reste en ligne.`);
        // Optionnel: Relancer le bot automatiquement
        // setTimeout(() => startProcess(scriptPath, label), 5000); 
    });
}

// Gestion des crashs globaux pour ne JAMAIS fermer le conteneur
process.on('uncaughtException', (err) => console.error('🔥 CRASH GLOBAL EVITÉ :', err));
process.on('unhandledRejection', (reason) => console.error('🔥 PROMESSE REJETÉE :', reason));
