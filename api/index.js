// Point d'entrée serverless Vercel : toutes les routes /api/* sont redirigées
// ici par vercel.json, et l'application Express traite la requête d'origine.
import app from '../server/app.js';

export default app;
