# Budget FCFA

Application web installable (PWA). Les données restent dans le navigateur du téléphone (IndexedDB). Aucun serveur ne les reçoit.

## Avant de changer de version
Si l'ancienne application contient des données, ouvre-la et fais « Exporter Sauvegarde JSON ». Une nouvelle adresse n'a pas accès aux données de l'ancienne : il faudra restaurer ce fichier dans Réglages.

## Mise en ligne (HTTPS obligatoire pour l'installation et le code)
1. Crée un dépôt GitHub, dépose le contenu de ce dossier à la racine.
2. Settings > Pages > Deploy from a branch > main, dossier /(root).
3. Ouvre l'adresse dans Chrome (Android) ou Safari (iPhone), puis installe : menu > « Installer l'application » ou Partager > « Sur l'écran d'accueil ».

Après le premier chargement, l'application fonctionne sans réseau.

## Publier une mise à jour
Change le numéro `CACHE` dans `sw.js`, sinon le téléphone garde l'ancienne version.

## Fichiers
`core.js` calculs, `db.js` stockage et migration, `app.js` interface, `sw.js` hors ligne.
