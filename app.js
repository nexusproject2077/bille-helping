// ===== Imports Firebase (SDK v12.14.0) =====
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  setDoc,
  updateDoc,
  getDoc,
  getDocs,
  collection,
  query,
  where,
  orderBy,
  startAt,
  endAt,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";
// Librairie geohash de Firebase pour les requetes de proximite
import {
  geohashForLocation,
  geohashQueryBounds,
  distanceBetween
} from "https://cdn.jsdelivr.net/npm/geofire-common@6.0.0/dist/geofire-common/index.esm.js";

// ===== Configuration du projet Firebase =====
const firebaseConfig = {
  apiKey: "AIzaSyA7ZBYnnB6vWTkDQBmjRQ0AyY4lG3PtiKg",
  authDomain: "bille-helping.firebaseapp.com",
  projectId: "bille-helping",
  storageBucket: "bille-helping.firebasestorage.app",
  messagingSenderId: "1054050764975",
  appId: "1:1054050764975:web:a3cb255705a9d5d39f2c5a",
  measurementId: "G-6EVPS9S839"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ===== Constantes =====
const GRID_DEGREES = 0.01; // ~1.1 km : taille de la grille de floutage
const SEARCH_RADIUS_M = 50000; // rayon de recherche : 50 km

// ===== Elements du DOM =====
const authZone = document.getElementById("auth-zone");
const appZone = document.getElementById("app-zone");
const tabLogin = document.getElementById("tab-login");
const tabSignup = document.getElementById("tab-signup");
const signupFields = document.getElementById("signup-fields");
const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");
const pseudoInput = document.getElementById("pseudo");
const birthdateInput = document.getElementById("birthdate");
const genderInput = document.getElementById("gender");
const seekingInput = document.getElementById("seeking");
const consentAge = document.getElementById("consent-age");
const consentData = document.getElementById("consent-data");
const btnSubmit = document.getElementById("btn-submit");
const btnLogout = document.getElementById("btn-logout");
const statusEl = document.getElementById("status");
const welcomePseudo = document.getElementById("welcome-pseudo");
const geoStatus = document.getElementById("geo-status");
const btnGeo = document.getElementById("btn-geo");
const nearby = document.getElementById("nearby");
const nearbyList = document.getElementById("nearby-list");

let mode = "login";
let currentProfile = null;

// ===== Bascule connexion / inscription =====
function setMode(newMode) {
  mode = newMode;
  if (mode === "signup") {
    tabSignup.classList.add("active");
    tabLogin.classList.remove("active");
    signupFields.classList.remove("hidden");
    btnSubmit.textContent = "Creer mon compte";
  } else {
    tabLogin.classList.add("active");
    tabSignup.classList.remove("active");
    signupFields.classList.add("hidden");
    btnSubmit.textContent = "Se connecter";
  }
  showStatus("", "");
}
tabLogin.addEventListener("click", () => setMode("login"));
tabSignup.addEventListener("click", () => setMode("signup"));

function showStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = "status " + (type || "");
}

function translateError(code) {
  const messages = {
    "auth/email-already-in-use": "Cette adresse e-mail est deja utilisee.",
    "auth/invalid-email": "Adresse e-mail invalide.",
    "auth/weak-password": "Le mot de passe doit faire au moins 6 caracteres.",
    "auth/user-not-found": "Aucun compte avec cette adresse.",
    "auth/wrong-password": "Mot de passe incorrect.",
    "auth/invalid-credential": "E-mail ou mot de passe incorrect.",
    "auth/missing-password": "Merci de saisir un mot de passe.",
    "auth/too-many-requests": "Trop de tentatives. Reessaie plus tard."
  };
  return messages[code] || "Une erreur est survenue : " + code;
}

function calculateAge(birthdate) {
  const today = new Date();
  const birth = new Date(birthdate);
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age;
}

function validateSignup() {
  if (!pseudoInput.value.trim()) return "Choisis un pseudo.";
  if (!birthdateInput.value) return "Indique ta date de naissance.";
  const age = calculateAge(birthdateInput.value);
  if (age < 18) return "Tu dois avoir 18 ans ou plus pour t'inscrire.";
  if (age > 120) return "Date de naissance invalide.";
  if (!genderInput.value) return "Indique ton genre.";
  if (!seekingInput.value) return "Indique ce que tu recherches.";
  if (!consentAge.checked) return "Tu dois certifier avoir 18 ans ou plus.";
  if (!consentData.checked) return "Tu dois accepter le traitement de tes donnees.";
  return null;
}

// ===== Soumission auth =====
btnSubmit.addEventListener("click", async () => {
  const email = emailInput.value.trim();
  const password = passwordInput.value;
  if (!email || !password) {
    showStatus("Remplis l'e-mail et le mot de passe.", "error");
    return;
  }

  if (mode === "login") {
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (error) {
      showStatus(translateError(error.code), "error");
    }
    return;
  }

  const validationError = validateSignup();
  if (validationError) {
    showStatus(validationError, "error");
    return;
  }

  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await setDoc(doc(db, "users", cred.user.uid), {
      pseudo: pseudoInput.value.trim(),
      birthdate: birthdateInput.value,
      gender: genderInput.value,
      seeking: seekingInput.value,
      identityVerified: false,
      location: null,
      geohash: null,
      consent: {
        age18: true,
        dataProcessing: true,
        consentedAt: serverTimestamp()
      },
      createdAt: serverTimestamp()
    });
    showStatus("Compte cree avec succes !", "success");
  } catch (error) {
    showStatus(translateError(error.code), "error");
  }
});

btnLogout.addEventListener("click", async () => {
  await signOut(auth);
});

// ===== Floutage de la position =====
// Arrondit les coordonnees a la grille pour ne jamais stocker la position exacte.
function blurCoordinate(value) {
  return Math.round(value / GRID_DEGREES) * GRID_DEGREES;
}

// ===== Activation de la localisation =====
btnGeo.addEventListener("click", () => {
  if (!navigator.geolocation) {
    geoStatus.textContent = "Ton navigateur ne supporte pas la geolocalisation.";
    geoStatus.className = "geo-status error";
    return;
  }
  geoStatus.textContent = "Recuperation de ta position...";
  geoStatus.className = "geo-status";

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      // Position exacte recue du navigateur
      const exactLat = pos.coords.latitude;
      const exactLng = pos.coords.longitude;

      // On la floute IMMEDIATEMENT, avant tout stockage
      const lat = blurCoordinate(exactLat);
      const lng = blurCoordinate(exactLng);
      const hash = geohashForLocation([lat, lng]);

      try {
        const user = auth.currentUser;
        await updateDoc(doc(db, "users", user.uid), {
          location: { lat: lat, lng: lng },
          geohash: hash,
          locationUpdatedAt: serverTimestamp()
        });
        currentProfile.location = { lat, lng };
        currentProfile.geohash = hash;

        geoStatus.textContent = "Localisation activee (position arrondie a ~1 km).";
        geoStatus.className = "geo-status success";
        btnGeo.textContent = "Mettre a jour ma localisation";

        await loadNearby();
      } catch (e) {
        geoStatus.textContent = "Erreur lors de l'enregistrement : " + e.message;
        geoStatus.className = "geo-status error";
      }
    },
    (err) => {
      if (err.code === 1) {
        geoStatus.textContent = "Tu as refuse la localisation. Active-la pour voir les profils proches.";
      } else {
        geoStatus.textContent = "Impossible d'obtenir ta position.";
      }
      geoStatus.className = "geo-status error";
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 0 }
  );
});

// ===== Recherche des profils proches (via geohash) =====
async function loadNearby() {
  if (!currentProfile || !currentProfile.location) return;

  const center = [currentProfile.location.lat, currentProfile.location.lng];
  const bounds = geohashQueryBounds(center, SEARCH_RADIUS_M);
  const promises = [];

  // On lance une requete par "tranche" de geohash couvrant la zone
  for (const b of bounds) {
    const q = query(
      collection(db, "users"),
      orderBy("geohash"),
      startAt(b[0]),
      endAt(b[1])
    );
    promises.push(getDocs(q));
  }

  const snapshots = await Promise.all(promises);
  const results = [];

  for (const snap of snapshots) {
    for (const docSnap of snap.docs) {
      // On ignore son propre profil
      if (docSnap.id === auth.currentUser.uid) continue;
      const data = docSnap.data();
      if (!data.location) continue;

      // Distance reelle entre positions floutees (en km)
      const distKm = distanceBetween(
        [data.location.lat, data.location.lng],
        center
      );
      // On filtre les faux positifs du geohash (au-dela du rayon)
      if (distKm * 1000 > SEARCH_RADIUS_M) continue;

      results.push({
        pseudo: data.pseudo,
        gender: data.gender,
        distanceKm: distKm
      });
    }
  }

  results.sort((a, b) => a.distanceKm - b.distanceKm);
  renderNearby(results);
}

// ===== Affichage des profils proches =====
function renderNearby(profiles) {
  nearby.classList.remove("hidden");
  nearbyList.innerHTML = "";

  if (profiles.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-nearby";
    empty.textContent = "Personne dans ton secteur pour l'instant. Reviens plus tard !";
    nearbyList.appendChild(empty);
    return;
  }

  for (const p of profiles) {
    const card = document.createElement("div");
    card.className = "profile-card";

    const info = document.createElement("div");
    info.className = "info";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = p.pseudo;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = p.gender;
    info.appendChild(name);
    info.appendChild(meta);

    const dist = document.createElement("span");
    dist.className = "distance";
    dist.textContent = formatDistance(p.distanceKm);

    card.appendChild(info);
    card.appendChild(dist);
    nearbyList.appendChild(card);
  }
}

// ===== Formatage de la distance (approximatif) =====
function formatDistance(km) {
  if (km < 1) return "a moins d'1 km";
  return "a ~" + Math.round(km) + " km";
}

// ===== Surveillance de l'etat de connexion =====
onAuthStateChanged(auth, async (user) => {
  if (user) {
    authZone.classList.add("hidden");
    appZone.classList.remove("hidden");

    try {
      const snap = await getDoc(doc(db, "users", user.uid));
      if (snap.exists()) {
        currentProfile = snap.data();
        welcomePseudo.textContent = currentProfile.pseudo || user.email;

        // Si une localisation existe deja, on charge directement les profils
        if (currentProfile.location) {
          geoStatus.textContent = "Localisation deja activee.";
          geoStatus.className = "geo-status success";
          btnGeo.textContent = "Mettre a jour ma localisation";
          await loadNearby();
        }
      } else {
        welcomePseudo.textContent = user.email;
      }
    } catch (e) {
      welcomePseudo.textContent = user.email;
    }
  } else {
    authZone.classList.remove("hidden");
    appZone.classList.add("hidden");
    nearby.classList.add("hidden");
    currentProfile = null;
    showStatus("", "");
  }
});
