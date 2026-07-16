// Point d'entrée local : serveur HTTP persistant.
// Sur Vercel, c'est api/index.js qui importe l'application (voir vercel.json).
import app from './app.js';
import { ensureReady, driver } from './db.js';

const PORT = process.env.PORT || 3000;

await ensureReady();
app.listen(PORT, () => {
  console.log(`Épure.app en écoute sur http://localhost:${PORT} (base : ${driver})`);
});
