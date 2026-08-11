# Bille Helping

Application web (PWA) de mise en relation entre adultes, construite avec une approche **privacy-by-design** et conforme RGPD.

## Architecture

L'application est separee en deux unites deployables :

- **Frontend** (`frontend/`) — site statique servi par **Firebase Hosting**.
- **Backend** (`backend/`) — API Node/Express servie par **Cloud Run**, pour
  les operations privilegiees (export RGPD, suppression de compte, signalements)
  via le **Firebase Admin SDK**.

Firebase Hosting redirige `/api/**` vers le service Cloud Run (rewrite dans
`firebase.json`), donc le frontend appelle le backend en same-origin.

## Stack technique

- **Front** : HTML / CSS / JavaScript vanilla (modules ES) — Firebase Hosting
- **Back** : Node.js / Express + Firebase Admin SDK — Cloud Run
- **Auth** : Firebase Authentication (e-mail / mot de passe)
- **Base de donnees** : Cloud Firestore (region europe `eur3`)

## Principes de conformite

- Verification d'age stricte a l'inscription (refus des moins de 18 ans)
- Double consentement RGPD separe (age + traitement des donnees), horodate en base
- Donnees hebergees en region europeenne
- Champ `identityVerified` prevu pour brancher un prestataire KYC externe (l'app ne stocke jamais de piece d'identite)
- Geolocalisation prevue en mode **floute** (jamais de position exacte stockee)

## Fonctionnalites

- Decouverte par swipe (cartes) avec proximite geographique (geohash)
- **Matching par compatibilite** : score base sur les intentions communes,
  les centres d'interet communs, la proximite et la disponibilite
- **Intentions de rencontre** (« ce que je cherche ») affichees sur les cartes
- **Statut « Disponible maintenant »** ephemere (3 h, expiration automatique)
- Match mutuel + messagerie temps reel avec accuses de lecture
- Signalement aligne **DSA** (categories illicites traitees en priorite) + blocage
- Consentement RGPD **granulaire** (age, donnees, contenu adulte), horodate
- Export des donnees + suppression complete du compte (droit a l'oubli)

## Structure

| Chemin | Role |
|---|---|
| `frontend/index.html` | Structure des ecrans (auth, onboarding, app, chat, modales) |
| `frontend/style.css` | Styles (theme sombre, liquid glass) |
| `frontend/app.js` | Logique client : auth, profil, swipe/match, chat, moderation |
| `backend/server.js` | API Cloud Run : export RGPD, suppression de compte, signalements |
| `backend/Dockerfile` | Image du service Cloud Run |
| `firebase.json` | Config Firebase Hosting (public `frontend/`, rewrite `/api/**` → Cloud Run) |
| `firestore.rules` | Regles de securite de la base |
| `storage.rules` | Regles de securite du stockage |
| `legal/` | Modeles CGU, confidentialite, moderation, registre (a valider) |

## Deploiement

Prerequis : `firebase-tools` et `gcloud` installes et authentifies, et un
`.firebaserc` (copier `.firebaserc.example`, ou `firebase use bille-helping`).

```bash
# 1) Backend -> Cloud Run (serviceId/region alignes sur firebase.json)
cd backend
gcloud run deploy bille-backend --source . --region europe-west1 --allow-unauthenticated
cd ..

# 2) Frontend + regles -> Firebase Hosting / Firestore
firebase deploy --only hosting,firestore:rules
```

Voir `backend/README.md` pour le detail des endpoints et le dev local.

## Securite

- La config Firebase cote client est publique par conception (protegee par les regles Firestore + restriction de domaine de la cle API).
- **Aucune cle privee** (KYC, paiement, token serveur) ne doit etre commitee. Utiliser un fichier `.env` ignore par git.

## Statut

Projet en developpement. Des **modeles** de CGU, de politique de
confidentialite et de moderation sont fournis dans `legal/`. Ne pas utiliser
en production avant :
- **Validation juridique** des documents de `legal/` par un avocat specialise
- Mise en place d'une moderation back-office (les signalements sont deja
  collectes et priorises, mais leur traitement reste a outiller)
- Verification d'age via prestataire externe + AIPD/DPIA (donnees sensibles)

## Licence

Projet personnel - tous droits reserves.
