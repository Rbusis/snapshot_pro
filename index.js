import http from "http";
import { DEBUG } from "./debug.js";

import { startAutoselect } from "./autoselect.js";
import { startDiscovery } from "./discovery.js";
import { startDegen } from "./degen.js";
import { startSwing } from "./swing.js";

const PORT = process.env.PORT || 8080;

http.createServer((req, res) => {
  res.writeHead(200);
  res.end("🤖 QUAD-BOT RUNNING (Autoselect + Discovery + Degen + Swing)");
}).listen(PORT, () => {
  console.log(`🛡️ Serveur Global : port ${PORT}`);
});

console.log("🏁 Démarrage des bots…");

(async()=>{ try{ await startAutoselect(); }catch(e){ console.error("CRASH AUTOSELECT",e); }})();
(async()=>{ try{ await startDiscovery(); }catch(e){ console.error("CRASH DISCOVERY",e); }})();
(async()=>{ try{ await startDegen(); }catch(e){ console.error("CRASH DEGEN",e); }})();
(async()=>{ try{ await startSwing(); }catch(e){ console.error("CRASH SWING",e); }})();

console.log("🚀 Bots opérationnels.");