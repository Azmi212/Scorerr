# scorerr

`scorerr` est dans sa première phase, **Radarr Integration Probe**. Cette version reçoit des webhooks JSON, les conserve dans SQLite et valide le cycle de vie d'une file de tâches. Elle ne contacte jamais Radarr et ne déclenche aucun grab ni téléchargement.

## Fonctionnement actuel

- `POST /api/webhooks/radarr` répond avec HTTP 202 à un JSON valide ;
- le corps exact reçu est conservé dans `payloadRaw` ;
- `payloadRawHash` sert au diagnostic ;
- `eventFingerprint`, calculé après tri récursif des propriétés JSON, détecte les doublons ;
- un événement inédit crée une tâche `pending` dans la même transaction SQLite ;
- le worker réclame atomiquement une tâche et la termine avec `result = probe_observed` ;
- un verrou `processing` expiré est remis en attente tant que le maximum de tentatives n'est pas atteint ;
- une tâche expirée ayant atteint ce maximum passe à `failed` ;
- aucun traitement n'a d'effet de bord.

Une tentative est comptée lorsque le worker réclame la tâche. La récupération d'un verrou expiré ne l'incrémente pas une seconde fois.

## Prérequis de développement

- Node.js 24 LTS et npm ;
- Git pour publier le projet ;
- Docker Desktop ou Docker Engine avec Compose pour tester l'image localement.

## Installation et démarrage local

Dans le dossier `scorerr` :

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

L'API applique seule les migrations et écoute par défaut sur `http://127.0.0.1:3000`. La base locale est créée dans `./data/scorerr.db`.

Dans un second terminal :

```powershell
npm run dev:worker
```

Le worker n'applique jamais les migrations. Il attend que l'API ait créé le schéma.

## Tester le webhook localement

```powershell
$body = '{"eventType":"Test","movie":{"id":42,"title":"Demo"}}'
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3000/api/webhooks/radarr -ContentType 'application/json' -Body $body
```

Le premier appel renvoie `accepted: true`, `duplicate: false`, un `eventId` et un `taskId`. Relancer la commande renvoie `duplicate: true` sans créer de nouvelle tâche.

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/events
Invoke-RestMethod http://127.0.0.1:3000/health
```

## Variables du worker

| Variable                         | Valeur par défaut | Rôle                                                        |
| -------------------------------- | ----------------: | ----------------------------------------------------------- |
| `WORKER_POLL_INTERVAL_MS`        |            `1000` | Intervalle entre deux recherches de tâches.                 |
| `WORKER_SCHEMA_WAIT_INTERVAL_MS` |            `1000` | Attente tant que l'API n'a pas créé le schéma.              |
| `WORKER_LOCK_TIMEOUT_MS`         |          `300000` | Un verrou plus vieux que 5 minutes est considéré abandonné. |
| `WORKER_MAX_ATTEMPTS`            |               `3` | Nombre maximal de réclamations avant échec définitif.       |

Augmenter `WORKER_LOCK_TIMEOUT_MS` si un futur traitement normal peut durer plus longtemps. Une valeur trop courte pourrait considérer à tort un worker actif comme abandonné.

## Commandes npm

| Commande               | Rôle                                                           |
| ---------------------- | -------------------------------------------------------------- |
| `npm run dev`          | Démarre l'API avec rechargement automatique.                   |
| `npm run dev:worker`   | Démarre le worker avec rechargement automatique.               |
| `npm run build`        | Compile le TypeScript dans `dist/`.                            |
| `npm start`            | Démarre l'API compilée.                                        |
| `npm run start:worker` | Démarre le worker compilé.                                     |
| `npm run format`       | Formate le projet avec Prettier.                               |
| `npm run format:check` | Vérifie le formatage sans modifier les fichiers.               |
| `npm run lint`         | Exécute ESLint.                                                |
| `npm run typecheck`    | Vérifie TypeScript sans créer de fichiers.                     |
| `npm test`             | Exécute les tests Vitest.                                      |
| `npm run db:migrate`   | Applique manuellement les migrations pour le diagnostic local. |

## Image Docker locale

Le `Dockerfile` utilise plusieurs étapes. Les outils de compilation et les dépendances de développement restent dans l'étape de construction. L'image finale contient le JavaScript compilé et les seules dépendances de production, puis s'exécute avec l'utilisateur non-root `scorerr`.

```powershell
docker build -t scorerr:local .
docker compose config
docker compose up
```

Le fichier `compose.yml` est destiné au développement Docker local. Le fichier `compose.portainer.yml` utilise une image GHCR déjà construite et ne contient pas de directive `build:`.

## Publier le projet sur GitHub

### 1. Initialiser Git

Vérifiez d'abord que Git est installé :

```powershell
git --version
```

Depuis le dossier `scorerr`, initialisez le dépôt si nécessaire :

```powershell
git init
git branch -M main
git add .
git commit -m "Prepare first scorerr deployment"
```

Git peut demander votre nom et votre adresse de contribution. Utilisez l'identité que vous souhaitez afficher dans l'historique GitHub :

```powershell
git config --global user.name "VOTRE_NOM_PUBLIC"
git config --global user.email "VOTRE_EMAIL_GITHUB"
```

### 2. Créer le dépôt privé

1. Connectez-vous à GitHub.
2. Cliquez sur **New repository**.
3. Choisissez votre compte ou organisation comme propriétaire.
4. Nommez le dépôt `scorerr`.
5. Sélectionnez **Private**.
6. Ne demandez pas à GitHub de créer un README, un `.gitignore` ou une licence, car ils existent déjà localement.
7. Créez le dépôt.

### 3. Envoyer le projet

Remplacez `PROPRIETAIRE_GITHUB` par le propriétaire affiché par GitHub :

```powershell
git remote add origin https://github.com/PROPRIETAIRE_GITHUB/scorerr.git
git push -u origin main
```

GitHub peut demander une authentification dans le navigateur ou un jeton personnel. Ne placez jamais ce jeton dans un fichier du projet.

## GitHub Actions et GitHub Container Registry

Le workflow `.github/workflows/docker-publish.yml` s'exécute à chaque push sur `main` et peut aussi être lancé avec **Actions > Validate and publish Docker image > Run workflow**.

Il effectue, dans cet ordre :

1. `npm ci` ;
2. le contrôle Prettier ;
3. ESLint ;
4. le contrôle TypeScript ;
5. les tests ;
6. la construction Docker ;
7. la publication GHCR si toutes les validations réussissent.

L'image reçoit au minimum ces tags :

```text
ghcr.io/PROPRIETAIRE_GITHUB/scorerr:latest
ghcr.io/PROPRIETAIRE_GITHUB/scorerr:IDENTIFIANT_COMPLET_DU_COMMIT
```

Le workflow déclare les permissions minimales suivantes :

```yaml
permissions:
  contents: read
  packages: write
```

`packages: write` permet au `GITHUB_TOKEN` automatique de publier l'image. Aucun secret personnel n'est requis dans le workflow. Si une organisation interdit l'écriture des packages par les workflows, un administrateur doit l'autoriser dans **Settings > Actions > General > Workflow permissions**.

### Vérifier l'image

1. Ouvrez l'onglet **Actions** du dépôt.
2. Ouvrez la dernière exécution et vérifiez que toutes les étapes sont vertes.
3. Depuis la page du dépôt ou du profil propriétaire, ouvrez **Packages**.
4. Ouvrez le package `scorerr` et vérifiez la présence des tags `latest` et du commit.

## Rendre GHCR accessible à Portainer

Deux possibilités existent.

### Option simple : package public

Dans les paramètres du package GHCR `scorerr`, ouvrez **Package settings**, puis **Change visibility** et choisissez **Public**. Le dépôt GitHub peut rester privé. Portainer pourra télécharger l'image sans identifiant.

### Option privée

Conservez le package privé et créez dans GitHub un Personal Access Token classique ayant uniquement la permission `read:packages`. Ajoutez ensuite un registre dans Portainer :

- registre : `ghcr.io` ;
- utilisateur : votre nom d'utilisateur GitHub ;
- mot de passe : le jeton personnel `read:packages`.

Le `GITHUB_TOKEN` du workflow ne peut pas être réutilisé dans Portainer : il est temporaire et limité à l'exécution GitHub Actions. Ne placez pas le jeton Portainer dans le Compose.

## Déployer dans Portainer

### 1. Préparer les variables

Remplacez les placeholders par vos valeurs :

```dotenv
SCORERR_IMAGE=ghcr.io/PROPRIETAIRE_GITHUB/scorerr:latest
PORT_SCORERR=3000
DOCKER_NETWORK_NAME=scorerr-network
SCORERR_VOLUME_NAME=scorerr-data
WORKER_LOCK_TIMEOUT_MS=300000
WORKER_MAX_ATTEMPTS=3
```

`PORT_SCORERR` est le port publié sur le réseau local. Ne l'exposez pas directement sur Internet et ne créez pas de redirection de ce port sur votre routeur.

### 2. Créer la Stack

1. Dans Portainer, ouvrez **Stacks**, puis **Add stack**.
2. Nommez-la `scorerr`.
3. Choisissez l'éditeur Web.
4. Copiez le contenu de `compose.portainer.yml` dans l'éditeur.
5. Ajoutez les variables ci-dessus dans **Environment variables**.
6. Vérifiez que `SCORERR_IMAGE` ne contient plus `PROPRIETAIRE_GITHUB`.
7. Cliquez sur **Deploy the stack**.

Le service `api` applique les migrations, puis devient healthy. Le service `worker` attend ce healthcheck et vérifie aussi lui-même que les tables existent. Gardez exactement un réplica de chaque service avec SQLite.

### 3. Vérifier le déploiement

Dans Portainer :

1. ouvrez les conteneurs de la Stack ;
2. vérifiez que `api` est **healthy** ;
3. ouvrez les logs de `worker` et recherchez `worker ready` ;
4. vérifiez qu'aucune erreur de permission `/data` n'apparaît.

Depuis un PC du même réseau, remplacez les placeholders :

```powershell
$body = '{"eventType":"Test","movie":{"id":42,"title":"Demo"}}'
Invoke-RestMethod -Method Post -Uri http://ADRESSE_IP_DU_SERVEUR:PORT_SCORERR/api/webhooks/radarr -ContentType 'application/json' -Body $body
Invoke-RestMethod http://ADRESSE_IP_DU_SERVEUR:PORT_SCORERR/api/events
Invoke-RestMethod http://ADRESSE_IP_DU_SERVEUR:PORT_SCORERR/health
```

Le worker doit ensuite journaliser la réclamation et la fin de la tâche avec `probe_observed`. Le payload brut n'est pas écrit dans les logs.

## Arrêter ou supprimer proprement la Stack

Pour arrêter temporairement, utilisez **Stop** sur les deux conteneurs ou sur la Stack selon votre version de Portainer. Le volume reste présent.

Pour supprimer la Stack :

1. ouvrez la Stack `scorerr` ;
2. choisissez **Delete this stack** ;
3. ne sélectionnez aucune option demandant de supprimer les volumes ;
4. vérifiez ensuite dans **Volumes** que `scorerr-data` existe toujours.

En ligne de commande, l'équivalent sûr est :

```powershell
docker compose -f compose.portainer.yml down
```

N'ajoutez pas `--volumes` ou `-v`, car cela demanderait la suppression du volume SQLite.

## Sécurité et limites

- l'API webhook n'est pas authentifiée : elle doit rester sur un réseau local de confiance ;
- la limite du payload est de 1 Mio par défaut ;
- les logs structurés ne contiennent pas le payload brut ;
- SQLite convient à un seul réplica API et à une charge légère ;
- un arrêt brutal peut laisser une tâche `processing`, mais le worker la récupère après `WORKER_LOCK_TIMEOUT_MS` ;
- le volume persistant n'est pas une sauvegarde ;
- aucune URL, clé API ou connexion Radarr n'existe dans cette version.
