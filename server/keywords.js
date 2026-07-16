// Synthèse de l'Évaluation Éclair : extraction de mots-clés depuis les
// réponses de l'équipe, épinglés comme "rappel de prudence" au cycle suivant.

const STOPWORDS = new Set([
  'a', 'ai', 'aient', 'ainsi', 'alors', 'apres', 'après', 'as', 'assez',
  'au', 'aucun', 'aussi', 'autre', 'autres', 'aux', 'avaient', 'avait',
  'avec', 'avoir', 'avons', 'beaucoup', 'bien', 'c', 'ca', 'car', 'ce',
  'cela', 'celle', 'celles', 'celui', 'ces', 'cet', 'cette', 'ceux', 'chaque',
  'chez', 'comme', 'd', 'dans', 'de', 'des', 'deux', 'donc', 'dont', 'du',
  'elle', 'elles', 'en', 'encore', 'entre', 'est', 'et', 'etaient', 'etait',
  'ete', 'etre', 'eu', 'fait', 'faire', 'fais', 'faisait', 'faut', 'fois',
  'font', 'gens', 'il', 'ils', 'j', 'je', 'jour', 'jours', 'l', 'la', 'le',
  'les', 'leur', 'leurs', 'lors', 'lui', 'm', 'ma', 'mais', 'me', 'meme',
  'mes', 'moi', 'moins', 'mon', 'n', 'ne', 'ni', 'nos', 'notre', 'nous',
  'on', 'ont', 'ou', 'où', 'par', 'parce', 'pas', 'pendant', 'peu', 'peut',
  'plus', 'pour', 'pourquoi', 'pu', 'puis', 'qu', 'quand', 'que', 'quel',
  'quelle', 'quelque', 'quelques', 'qui', 'quoi', 'ralenti', 'ralentis',
  'rien', 's', 'sa', 'sans', 'se', 'ses', 'si', 'son', 'sont', 'sous',
  'sur', 't', 'ta', 'tes', 'toi', 'ton', 'tous', 'tout', 'toute', 'toutes',
  'tres', 'très', 'trop', 'tu', 'un', 'une', 'vers', 'vos', 'votre', 'vous',
  'y', 'été', 'étaient', 'était', 'être',
]);

function normalize(word) {
  return word
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

export function extractKeywords(texts, max = 5) {
  const counts = new Map();
  const original = new Map();
  for (const text of texts) {
    const words = (text || '').split(/[^a-zA-Zàâäéèêëîïôöùûüçœ-]+/);
    for (const word of words) {
      if (word.length < 3) continue;
      const key = normalize(word);
      if (STOPWORDS.has(key) || STOPWORDS.has(word.toLowerCase())) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
      if (!original.has(key)) original.set(key, word.toLowerCase());
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([key, count]) => ({ word: original.get(key), count }));
}
