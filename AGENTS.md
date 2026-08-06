# Consignes pour les agents

- Le produit s'appelle `scorerr`, toujours en minuscules dans le code et les identifiants techniques.
- Ne jamais contacter Radarr, Sonarr, Prowlarr, Seerr, Jellyseerr ou un client de téléchargement sans une demande explicite ultérieure.
- Ne jamais implémenter de grab ou de téléchargement dans la phase Integration Probe.
- Ne jamais inscrire de clé API, mot de passe ou secret dans le code ou le fichier Compose.
- L'adresse future de Radarr viendra d'une variable d'environnement et ne doit pas supposer `localhost`.
- Seule l'API applique les migrations. Le worker attend que le schéma existe.
- Préserver le payload webhook exact et garder l'idempotence fondée sur le JSON normalisé.
- Exécuter formatage, lint, vérification TypeScript et tests après toute modification importante.
