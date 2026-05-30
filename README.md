# Bille Helping

Application web (PWA) de mise en relation entre adultes, construite avec une approche **privacy-by-design** et conforme RGPD.

## Stack technique

- **Front** : HTML / CSS / JavaScript vanilla (modules ES)
- **Auth** : Firebase Authentication (e-mail / mot de passe)
- **Base de donnees** : Cloud Firestore (region europe `eur3`)
- **Hebergement** : Firebase Hosting

## Principes de conformite

- Verification d'age stricte a l'inscription (refus des moins de 18 ans)
- Double consentement RGPD separe (age + traitement des donnees), horodate en base
- Donnees hebergees en region europeenne
- Champ `identityVerified` prevu pour brancher un prestataire KYC externe (l'app ne stocke jamais de piece d'identite)
- Geolocalisation prevue en mode **floute** (jamais de position exacte stockee)

## Structure

| Fichier | Role |
|---|---|
| `index.html` | Structure de la page (connexion / inscription) |
| `style.css` | Styles (theme sombre, liquid glass) |
| `app.js` | Logique : auth, ecriture/lecture du profil Firestore |
| `firestore.rules` | Regles de securite de la base |

## Securite

- La config Firebase cote client est publique par conception (protegee par les regles Firestore + restriction de domaine de la cle API).
- **Aucune cle privee** (KYC, paiement, token serveur) ne doit etre commitee. Utiliser un fichier `.env` ignore par git.

## Statut

Projet en developpement. Ne pas utiliser en production avant :
- Redaction et validation juridique de la politique de confidentialite et des CGU
- Mise en place de la moderation et du signalement
- Validation du cadre juridique global (donnees sensibles)

## Licence

Projet personnel - tous droits reserves.
