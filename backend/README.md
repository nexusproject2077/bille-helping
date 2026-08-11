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
| `POST` | `/api/photos/check` | Modération d'une photo de profil via Google Vision (bloque la nudité explicite) |
| `GET` | `/health` | Sonde de santé |

> **Google Vision** : activer l'API une fois avec `gcloud services enable vision.googleapis.com`.
> Le compte de service Cloud Run l'appelle avec ses identifiants par défaut. Seuil :
> `adult` = LIKELY/VERY_LIKELY est bloqué ; `racy` (suggestif) reste autorisé. Le chat n'est pas filtré.

### Modération (réservé aux admins)

Ces routes exigent un compte avec le **custom claim `admin: true`** (revérifié côté serveur) :

| Méthode | Route | Rôle |
|---|---|---|
| `GET` | `/api/admin/users` | Liste des comptes inscrits (résumé) |
| `GET` | `/api/admin/users/:uid` | Détail d'un compte (profil, e-mail, photos) |
| `DELETE` | `/api/admin/users/:uid` | Suppression + nettoyage complet (matchs, messages, likes envoyés **et reçus**) |
| `PATCH` | `/api/admin/users/:uid/verify` | Valide/retire l'identité (`{ verified: true|false }`) → pilote le badge |
| `POST` | `/api/admin/users/:uid/photos/delete` | Supprime une photo précise (`{ index }`) |
| `GET` | `/api/admin/reports` | Liste des signalements (urgents en premier) |

Le panel d'administration est servi par le frontend sur **`/admin.html`**.

Toutes les routes `/api/*` exigent le header `Authorization: Bearer <idToken>`
(jeton Firebase), vérifié via l'Admin SDK.

### Donner le rôle admin à un compte

Le rôle admin est un *custom claim* sur le compte Firebase. Depuis **Cloud Shell**
(ou en local avec `GOOGLE_APPLICATION_CREDENTIALS` défini), après que le compte
s'est déjà inscrit dans l'app :

```bash
cd backend
npm install
node scripts/set-admin.js merickoken54@gmail.com
```

L'utilisateur doit se **reconnecter** pour que le claim prenne effet, puis
`Profil → Espace modération` apparaît (et `/admin.html` devient accessible).

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
