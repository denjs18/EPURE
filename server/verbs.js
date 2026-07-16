// Validation NLP locale du "verbe d'action" (module IA du TAF).
// Modèle léger hébergé en local, conformément au cahier des charges
// (alternative spaCy) : lexique de verbes d'action + analyse morphologique
// des infinitifs français (-er, -ir, -re, -oir) avec liste d'exclusion
// des noms communs homographes.

const ACTION_VERBS = new Set([
  'accompagner', 'acheter', 'actualiser', 'adapter', 'ajouter', 'ajuster',
  'améliorer', 'analyser', 'animer', 'anticiper', 'appeler', 'apprendre',
  'archiver', 'assembler', 'assurer', 'auditer', 'automatiser', 'benchmarker',
  'brancher', 'briefer', 'budgétiser', 'cadrer', 'calculer', 'calibrer',
  'capturer', 'cartographier', 'centraliser', 'changer', 'chercher',
  'chiffrer', 'choisir', 'clarifier', 'classer', 'cliquer', 'clore',
  'clôturer', 'coder', 'collecter', 'commander', 'communiquer', 'comparer',
  'compiler', 'compléter', 'composer', 'concevoir', 'configurer', 'confirmer',
  'connecter', 'consolider', 'construire', 'contacter', 'contrôler',
  'convertir', 'coordonner', 'corriger', 'créer', 'debugger', 'déboguer',
  'décider', 'découper', 'décrire', 'définir', 'déléguer', 'demander',
  'démarrer', 'déployer', 'designer', 'dessiner', 'détailler', 'déterminer',
  'développer', 'diagnostiquer', 'diffuser', 'documenter', 'écrire',
  'éditer', 'élaborer', 'embaucher', 'enregistrer', 'envoyer', 'estimer',
  'établir', 'étudier', 'évaluer', 'expédier', 'expliquer', 'explorer',
  'exporter', 'facturer', 'faire', 'filmer', 'finaliser', 'finir', 'fixer',
  'former', 'formuler', 'fournir', 'fusionner', 'générer', 'gérer',
  'identifier', 'illustrer', 'implémenter', 'importer', 'imprimer',
  'informer', 'installer', 'intégrer', 'interviewer', 'inventorier',
  'inviter', 'itérer', 'lancer', 'lire', 'lister', 'livrer', 'maquetter',
  'mesurer', 'mettre', 'migrer', 'modéliser', 'modifier', 'monter',
  'négocier', 'nettoyer', 'nommer', 'notifier', 'obtenir', 'optimiser',
  'organiser', 'orchestrer', 'paramétrer', 'partager', 'peaufiner',
  'photographier', 'piloter', 'planifier', 'positionner', 'poster',
  'préparer', 'présenter', 'prioriser', 'produire', 'programmer',
  'prospecter', 'prototyper', 'publier', 'qualifier', 'quantifier',
  'rappeler', 'rassembler', 'réaliser', 'recenser', 'recetter', 'rechercher',
  'recruter', 'rédiger', 'refactorer', 'refondre', 'régler', 'relancer',
  'relire', 'remplacer', 'remplir', 'rencontrer', 'renommer', 'réorganiser',
  'réparer', 'répondre', 'reporter', 'reprendre', 'résoudre', 'restructurer',
  'résumer', 'retirer', 'réunir', 'réviser', 'revoir', 'sécuriser',
  'segmenter', 'sélectionner', 'signer', 'simplifier', 'soumettre',
  'spécifier', 'standardiser', 'structurer', 'superviser', 'supprimer',
  'synchroniser', 'synthétiser', 'télécharger', 'tester', 'tourner',
  'traduire', 'traiter', 'transférer', 'transmettre', 'trier', 'unifier',
  'valider', 'vendre', 'vérifier', 'visiter',
]);

// Noms communs fréquents se terminant comme un infinitif (faux positifs).
const NOT_VERBS = new Set([
  'atelier', 'avenir', 'cadre', 'cahier', 'calendrier', 'centre', 'chantier',
  'chapitre', 'chiffre', 'clavier', 'courrier', 'cuir', 'dernier', 'devoir',
  'dossier', 'espoir', 'fenêtre', 'février', 'fichier', 'janvier', 'lettre',
  'livre', 'loisir', 'membre', 'métier', 'ministre', 'miroir', 'montre',
  'nombre', 'notre', 'offre', 'ordre', 'panier', 'papier', 'plaisir',
  'pouvoir', 'premier', 'quatre', 'registre', 'titre', 'trésor', 'votre',
]);

const INFINITIVE_ENDINGS = ['er', 'ir', 're', 'oir'];

export function checkActionVerb(title) {
  const trimmed = (title || '').trim();
  if (!trimmed) {
    return { valid: false, reason: 'empty' };
  }
  const firstWord = trimmed
    .split(/[\s'']+/)[0]
    .toLowerCase()
    .replace(/[^a-zàâäéèêëîïôöùûüçœ-]/gi, '');

  if (!firstWord) return { valid: false, reason: 'empty' };
  if (ACTION_VERBS.has(firstWord)) return { valid: true };
  if (NOT_VERBS.has(firstWord)) {
    return { valid: false, reason: 'not_a_verb' };
  }
  const looksInfinitive =
    firstWord.length >= 4 &&
    INFINITIVE_ENDINGS.some((ending) => firstWord.endsWith(ending));
  if (looksInfinitive) return { valid: true };
  return { valid: false, reason: 'not_a_verb' };
}

export const VERB_ERROR_MESSAGE = "Veuillez utiliser un verbe d'action";
