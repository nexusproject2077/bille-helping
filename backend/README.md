# Bille Helping — Backend (Cloud Run)

API des **opérations privilégiées**, exécutées côté serveur avec le
**Firebase Admin SDK** (qui contourne les règles Firestore). Le frontend
(Firebase Hosting) l'appelle en `/api/**` grâce à un *rewrite* Hosting →
Cloud Run, en joignant le jeton Firebase de l'utilisateur.

## Endpoints

| Méthode | Route | Rôle |
|---|---|---|
| `GET` | `/api/export` | Export RGPD des données de l'utilisateur (profil, swipes, matchs, messages) |
| `DELETE` | `/api/account` | Suppression complète du compte (droit à l'oubli : Firestore + Auth) |
| `POST` | `/api/report` | Enregistrement d'un signalement (priorisé DSA) + blocage |
| `GET` | `/health` | Sonde de santé |

Toutes les routes `/api/*` exigent le header `Authorization: Bearer <idToken>`
(jeton Firebase), vérifié via l'Admin SDK.

## Développement local

Node 20+ requis. Il faut un compte de service Firebase Admin (console
Firebase → Paramètres → Comptes de service → Générer une nouvelle clé).

```bash
cd backend
npm install
cp .env.example .env
# renseigner GOOGLE_APPLICATION_CREDENTIALS dans .env (chemin du fichier de clé)
node --env-file=.env server.js
```

Le service écoute sur `http://localhost:8080`.

## Déploiement sur Cloud Run

Depuis le dossier `backend/` (le `serviceId`/région doivent correspondre au
*rewrite* de `firebase.json`, soit `bille-backend` / `europe-west1`) :

```bash
gcloud run deploy bille-backend \
  --source . \
  --region europe-west1 \
  --allow-unauthenticated
```

> `--allow-unauthenticated` autorise l'invocation HTTP ; l'authentification
> **applicative** est assurée par le middleware qui vérifie le jeton Firebase.

Le **compte de service** du service Cloud Run doit avoir les droits Firestore
et Firebase Auth (par défaut, le compte de service Compute a l'accès Firestore ;
pour supprimer des comptes Auth, ajouter le rôle *Firebase Authentication Admin*).

## Câblage avec le frontend

`firebase.json` route `/api/**` vers ce service :

```json
"rewrites": [
  { "source": "/api/**", "run": { "serviceId": "bille-backend", "region": "europe-west1" } }
]
```

Le frontend appelle donc `/api/export`, `/api/account`, `/api/report` en
same-origin. Pour pointer vers une autre URL (dev), définir
`window.__BILLE_API__` avant le chargement de `app.js`.
