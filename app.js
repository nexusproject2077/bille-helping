// ============================================================
// BILLE HELPING — Application
// ============================================================

// ===== Imports Firebase (SDK v12.14.0) =====
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, onAuthStateChanged, deleteUser
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import {
  getFirestore, doc, setDoc, updateDoc, getDoc, getDocs, deleteDoc,
  collection, query, where, orderBy, startAt, endAt, addDoc,
  onSnapshot, serverTimestamp, Timestamp
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";
import {
  geohashForLocation, geohashQueryBounds, distanceBetween
} from "https://cdn.jsdelivr.net/npm/geofire-common@6.0.0/dist/geofire-common/index.esm.js";

// ===== Configuration =====
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
const GRID_DEGREES = 0.01;        // ~1.1 km de floutage
const SEARCH_RADIUS_M = 50000;    // 50 km
const INTERESTS = [
  "Sport", "Musique", "Cinema", "Voyages", "Cuisine", "Jeux video",
  "Lecture", "Sorties", "Nature", "Art", "Tech", "Fitness"
];
// Intentions de rencontre (mise en relation entre adultes consentants)
const INTENTIONS = [
  "Ce soir", "Sans lendemain", "Plan regulier", "Discuter d'abord",
  "Amities", "Relation", "On verra"
];
// Categories de signalement considerees comme manifestement illicites (DSA / droit penal)
const ILLEGAL_REPORT_REASONS = ["mineur", "image-intime-non-consentie", "non-consentement"];
// Duree pendant laquelle le statut "Disponible maintenant" reste actif (3 h)
const LOOKING_NOW_WINDOW_MS = 3 * 60 * 60 * 1000;

// ===== Etat global =====
let mode = "login";
let currentUser = null;       // firebase auth user
let currentProfile = null;    // doc Firestore
let onbPhotos = [];           // {url, path}
let onbInterests = [];
let onbIntentions = [];
let swipeQueue = [];          // profils a swiper
let activeChat = null;        // {matchId, otherUid, otherName}
let chatUnsub = null;         // unsubscribe du listener chat
let matchesUnsub = null;
let unreadCounts = {};        // { matchId: nombre de non-lus }
let unreadUnsubs = {};        // { matchId: unsubscribe }

// ===== Helpers DOM =====
const $ = (id) => document.getElementById(id);
const screens = {
  landing: $("landing-screen"),
  auth: $("auth-screen"),
  onboarding: $("onboarding-screen"),
  app: $("app-screen")
};
function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.add("hidden"));
  screens[name].classList.remove("hidden");
}

// Toast (notification legere)
let toastTimer = null;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 2600);
}

// ----- Landing -----
$("btn-landing-start").addEventListener("click", () => showScreen("auth"));
$("btn-landing-cgu").addEventListener("click", () => $("cgu-panel").classList.remove("hidden"));
$("btn-auth-back").addEventListener("click", () => showScreen("landing"));

function translateError(code) {
  const m = {
    "auth/email-already-in-use": "Cette adresse e-mail est deja utilisee.",
    "auth/invalid-email": "Adresse e-mail invalide.",
    "auth/weak-password": "Mot de passe : 6 caracteres minimum.",
    "auth/invalid-credential": "E-mail ou mot de passe incorrect.",
    "auth/too-many-requests": "Trop de tentatives. Reessaie plus tard."
  };
  return m[code] || "Erreur : " + code;
}

function calculateAge(birthdate) {
  const t = new Date(), b = new Date(birthdate);
  let a = t.getFullYear() - b.getFullYear();
  const md = t.getMonth() - b.getMonth();
  if (md < 0 || (md === 0 && t.getDate() < b.getDate())) a--;
  return a;
}

// ============================================================
// AUTH : bascule connexion / inscription
// ============================================================
function setMode(newMode) {
  mode = newMode;
  if (mode === "signup") {
    $("tab-signup").classList.add("active");
    $("tab-login").classList.remove("active");
    $("signup-fields").classList.remove("hidden");
    $("btn-submit").textContent = "Creer mon compte";
  } else {
    $("tab-login").classList.add("active");
    $("tab-signup").classList.remove("active");
    $("signup-fields").classList.add("hidden");
    $("btn-submit").textContent = "Se connecter";
  }
  $("auth-status").textContent = "";
}
$("tab-login").addEventListener("click", () => setMode("login"));
$("tab-signup").addEventListener("click", () => setMode("signup"));

function authStatus(msg, type) {
  const el = $("auth-status");
  el.textContent = msg;
  el.className = "status " + (type || "");
}

function validateSignup() {
  if (!$("pseudo").value.trim()) return "Choisis un pseudo.";
  if (!$("birthdate").value) return "Indique ta date de naissance.";
  const age = calculateAge($("birthdate").value);
  if (age < 18) return "Tu dois avoir 18 ans ou plus.";
  if (age > 120) return "Date de naissance invalide.";
  if (!$("gender").value) return "Indique ton genre.";
  if (!$("seeking").value) return "Indique ce que tu recherches.";
  if (!$("consent-age").checked) return "Tu dois certifier avoir 18 ans ou plus.";
  if (!$("consent-data").checked) return "Tu dois accepter le traitement des donnees.";
  if (!$("consent-adult").checked) return "Tu dois accepter l'acces au contenu adulte entre adultes consentants.";
  return null;
}

$("btn-submit").addEventListener("click", async () => {
  const email = $("email").value.trim();
  const password = $("password").value;
  if (!email || !password) { authStatus("Remplis l'e-mail et le mot de passe.", "error"); return; }

  if (mode === "login") {
    try { await signInWithEmailAndPassword(auth, email, password); }
    catch (e) { authStatus(translateError(e.code), "error"); }
    return;
  }

  const err = validateSignup();
  if (err) { authStatus(err, "error"); return; }

  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await setDoc(doc(db, "users", cred.user.uid), {
      pseudo: $("pseudo").value.trim(),
      birthdate: $("birthdate").value,
      gender: $("gender").value,
      seeking: $("seeking").value,
      bio: "",
      interests: [],
      intentions: [],
      photos: [],
      identityVerified: false,
      location: null,
      geohash: null,
      lookingNow: false,
      lookingNowAt: null,
      profileComplete: false,
      visibility: { age: true, distance: true, bio: true, interests: true, discoverable: true },
      searchPrefs: { maxDistance: 50, ageMin: 18, ageMax: 80 },
      blocked: [],
      consent: { age18: true, dataProcessing: true, adultContent: true, consentedAt: serverTimestamp() },
      createdAt: serverTimestamp()
    });
    authStatus("Compte cree !", "success");
  } catch (e) { authStatus(translateError(e.code), "error"); }
});

// ============================================================
// ONBOARDING : completion de profil obligatoire
// ============================================================

// Calcule le pourcentage de completion
function computeCompletion() {
  let score = 0;
  if (onbPhotos.length >= 1) score += 50;          // photo obligatoire = gros poids
  if ($("bio-input").value.trim().length >= 10) score += 25;
  if (onbInterests.length >= 1) score += 25;
  return score;
}

function updateProgress() {
  const pct = computeCompletion();
  $("onb-progress-fill").style.width = pct + "%";
  $("onb-progress-label").textContent = pct + "%";
  // Le bouton n'est actif qu'a 100%
  const btn = $("btn-finish-onboarding");
  if (pct >= 100) {
    btn.disabled = false;
    btn.style.opacity = "1";
    btn.style.cursor = "pointer";
  } else {
    btn.disabled = true;
    btn.style.opacity = "0.5";
    btn.style.cursor = "not-allowed";
  }
}

// ----- Photos -----
function renderOnbPhotos() {
  const grid = $("photo-grid");
  grid.innerHTML = "";
  onbPhotos.forEach((p, i) => {
    const thumb = document.createElement("div");
    thumb.className = "photo-thumb";
    const img = document.createElement("img");
    img.src = p.url;
    const rm = document.createElement("button");
    rm.className = "remove";
    rm.textContent = "\u00d7";
    rm.addEventListener("click", () => removeOnbPhoto(i));
    thumb.appendChild(img);
    thumb.appendChild(rm);
    grid.appendChild(thumb);
  });
  updateProgress();
}

async function removeOnbPhoto(i) {
  onbPhotos.splice(i, 1);
  renderOnbPhotos();
}

$("btn-add-photo").addEventListener("click", () => $("photo-input").click());

// Compresse une image (canvas) et renvoie une dataURL base64 legere
function compressImage(file, maxSize, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        // Redimensionne pour que le plus grand cote = maxSize
        if (width > height) {
          if (width > maxSize) { height = height * (maxSize / width); width = maxSize; }
        } else {
          if (height > maxSize) { width = width * (maxSize / height); height = maxSize; }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        // JPEG compresse en base64
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

$("photo-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (onbPhotos.length >= 6) { photoStatus("Maximum 6 photos.", "error"); return; }
  if (!file.type.startsWith("image/")) { photoStatus("Choisis une image.", "error"); return; }

  photoStatus("Traitement de la photo...", "");
  try {
    // Compression : max 800px, qualite 0.7 -> reste leger pour Firestore
    const dataUrl = await compressImage(file, 800, 0.7);
    // Securite : Firestore limite un document a 1 Mo. On verifie la taille.
    if (dataUrl.length > 900000) {
      const smaller = await compressImage(file, 600, 0.6);
      onbPhotos.push({ url: smaller });
    } else {
      onbPhotos.push({ url: dataUrl });
    }
    renderOnbPhotos();
    photoStatus("", "");
  } catch (err) {
    photoStatus("Erreur lors du traitement de la photo.", "error");
    console.error(err);
  }
  $("photo-input").value = "";
});

function photoStatus(msg, type) {
  const el = $("photo-status");
  el.textContent = msg;
  el.className = "status " + (type || "");
}

// ----- Bio -----
$("bio-input").addEventListener("input", () => {
  $("bio-count").textContent = $("bio-input").value.length;
  updateProgress();
});

// ----- Interets -----
function renderInterests() {
  const box = $("interests-chips");
  box.innerHTML = "";
  INTERESTS.forEach((label) => {
    const chip = document.createElement("button");
    chip.className = "chip" + (onbInterests.includes(label) ? " selected" : "");
    chip.textContent = label;
    chip.addEventListener("click", () => {
      if (onbInterests.includes(label)) {
        onbInterests = onbInterests.filter((x) => x !== label);
      } else {
        onbInterests.push(label);
      }
      renderInterests();
      updateProgress();
    });
    box.appendChild(chip);
  });
}

// ----- Intentions -----
function renderIntentions() {
  const box = $("intentions-chips");
  if (!box) return;
  box.innerHTML = "";
  INTENTIONS.forEach((label) => {
    const chip = document.createElement("button");
    chip.className = "chip intention" + (onbIntentions.includes(label) ? " selected" : "");
    chip.textContent = label;
    chip.addEventListener("click", () => {
      if (onbIntentions.includes(label)) {
        onbIntentions = onbIntentions.filter((x) => x !== label);
      } else {
        onbIntentions.push(label);
      }
      renderIntentions();
    });
    box.appendChild(chip);
  });
}

// ----- Validation finale -----
$("btn-finish-onboarding").addEventListener("click", async () => {
  if (computeCompletion() < 100) return;
  try {
    await updateDoc(doc(db, "users", currentUser.uid), {
      photos: onbPhotos,
      bio: $("bio-input").value.trim(),
      interests: onbInterests,
      intentions: onbIntentions,
      profileComplete: true
    });
    currentProfile.photos = onbPhotos;
    currentProfile.bio = $("bio-input").value.trim();
    currentProfile.interests = onbInterests;
    currentProfile.intentions = onbIntentions;
    currentProfile.profileComplete = true;
    enterApp();
  } catch (e) {
    photoStatus("Erreur : " + e.message, "error");
  }
});

$("btn-logout-onb").addEventListener("click", () => signOut(auth));

// Prepare l'ecran d'onboarding avec les donnees existantes
function initOnboarding() {
  onbPhotos = currentProfile.photos || [];
  onbInterests = currentProfile.interests || [];
  onbIntentions = currentProfile.intentions || [];
  $("bio-input").value = currentProfile.bio || "";
  $("bio-count").textContent = ($("bio-input").value || "").length;
  renderOnbPhotos();
  renderInterests();
  renderIntentions();
  updateProgress();
  showScreen("onboarding");
}

// ============================================================
// APP : navigation entre onglets
// ============================================================
function switchView(name) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
  $("view-" + name).classList.add("active");
  document.querySelector('.nav-btn[data-view="' + name + '"]').classList.add("active");
  if (name === "discover") loadSwipeQueue();
  if (name === "messages") loadMatches();
  if (name === "profile") renderProfile();
}
document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
});

function enterApp() {
  showScreen("app");
  startMatchesListener();  // ecoute globale pour les badges de notification
  switchView("discover");
}

// Ecoute permanente des matchs pour alimenter les pastilles meme hors onglet Messages
function startMatchesListener() {
  if (matchesUnsub) matchesUnsub();
  const q = query(
    collection(db, "matches"),
    where("users", "array-contains", currentUser.uid)
  );
  matchesUnsub = onSnapshot(q, (snap) => {
    snap.forEach((d) => listenUnread(d.id));
  });
}

// ============================================================
// PROFIL : affichage + visibilite + RGPD
// ============================================================
function renderProfile() {
  const p = currentProfile;
  // Photos
  const pc = $("profile-photos");
  pc.innerHTML = "";
  (p.photos || []).forEach((ph) => {
    const img = document.createElement("img");
    img.src = ph.url;
    pc.appendChild(img);
  });
  $("profile-name").textContent = p.pseudo;
  $("profile-age").textContent = calculateAge(p.birthdate) + " ans";
  $("profile-bio").textContent = p.bio || "";

  // Interets
  const pi = $("profile-interests");
  pi.innerHTML = "";
  (p.interests || []).forEach((it) => {
    const c = document.createElement("span");
    c.className = "chip-static";
    c.textContent = it;
    pi.appendChild(c);
  });

  // Intentions
  const pin = $("profile-intentions");
  if (pin) {
    pin.innerHTML = "";
    (p.intentions || []).forEach((it) => {
      const c = document.createElement("span");
      c.className = "chip-static intention";
      c.textContent = it;
      pin.appendChild(c);
    });
  }

  // Statut "Disponible maintenant" (expire automatiquement)
  if ($("looking-now")) $("looking-now").checked = isLookingNowActive(p);

  // Etat des toggles de visibilite
  const v = p.visibility || {};
  $("vis-age").checked = v.age !== false;
  $("vis-distance").checked = v.distance !== false;
  $("vis-bio").checked = v.bio !== false;
  $("vis-interests").checked = v.interests !== false;
  $("vis-discoverable").checked = v.discoverable !== false;

  // Preferences de recherche
  initSearchPrefs();

  // Etat geoloc
  if (p.location) {
    $("geo-status").textContent = "Localisation activee (arrondie a ~1 km).";
    $("btn-geo").textContent = "Mettre a jour ma localisation";
  } else {
    $("geo-status").textContent = "Localisation non activee.";
    $("btn-geo").textContent = "Activer ma localisation";
  }
}

// ----- Visibilite : sauvegarde a chaque changement -----
async function saveVisibility() {
  const visibility = {
    age: $("vis-age").checked,
    distance: $("vis-distance").checked,
    bio: $("vis-bio").checked,
    interests: $("vis-interests").checked,
    discoverable: $("vis-discoverable").checked
  };
  try {
    await updateDoc(doc(db, "users", currentUser.uid), { visibility });
    currentProfile.visibility = visibility;
    visStatus("Preferences enregistrees.", "success");
    setTimeout(() => visStatus("", ""), 1500);
  } catch (e) { visStatus("Erreur d'enregistrement.", "error"); }
}
function visStatus(msg, type) {
  const el = $("vis-status");
  el.textContent = msg;
  el.className = "status " + (type || "");
}
["vis-age", "vis-distance", "vis-bio", "vis-interests", "vis-discoverable"]
  .forEach((id) => $(id).addEventListener("change", saveVisibility));

// ----- Disponible maintenant (statut ephemere) -----
// Vrai si le membre s'est declare dispo il y a moins de LOOKING_NOW_WINDOW_MS.
function isLookingNowActive(p) {
  if (!p || !p.lookingNow || !p.lookingNowAt) return false;
  const ms = p.lookingNowAt.seconds ? p.lookingNowAt.seconds * 1000 : Date.parse(p.lookingNowAt);
  if (!ms) return false;
  return (Date.now() - ms) < LOOKING_NOW_WINDOW_MS;
}

const lookingNowEl = $("looking-now");
if (lookingNowEl) {
  lookingNowEl.addEventListener("change", async () => {
    const on = lookingNowEl.checked;
    try {
      await updateDoc(doc(db, "users", currentUser.uid), {
        lookingNow: on,
        lookingNowAt: on ? serverTimestamp() : null
      });
      currentProfile.lookingNow = on;
      // Approximation locale immediate (le serverTimestamp sera relu au prochain chargement)
      currentProfile.lookingNowAt = on ? { seconds: Math.floor(Date.now() / 1000) } : null;
      toast(on ? "Tu es visible comme disponible (3 h)." : "Statut disponible desactive.");
    } catch (e) {
      lookingNowEl.checked = !on;
      toast("Erreur : " + e.message);
    }
  });
}

// ----- Geolocalisation (floutee) -----
function blurCoordinate(v) { return Math.round(v / GRID_DEGREES) * GRID_DEGREES; }

$("btn-geo").addEventListener("click", () => {
  if (!navigator.geolocation) { $("geo-status").textContent = "Geolocalisation non supportee."; return; }
  $("geo-status").textContent = "Recuperation de ta position...";
  navigator.geolocation.getCurrentPosition(async (pos) => {
    const lat = blurCoordinate(pos.coords.latitude);
    const lng = blurCoordinate(pos.coords.longitude);
    const hash = geohashForLocation([lat, lng]);
    try {
      await updateDoc(doc(db, "users", currentUser.uid), {
        location: { lat, lng }, geohash: hash, locationUpdatedAt: serverTimestamp()
      });
      currentProfile.location = { lat, lng };
      currentProfile.geohash = hash;
      $("geo-status").textContent = "Localisation activee (arrondie a ~1 km).";
      $("btn-geo").textContent = "Mettre a jour ma localisation";
    } catch (e) { $("geo-status").textContent = "Erreur : " + e.message; }
  }, (err) => {
    $("geo-status").textContent = err.code === 1
      ? "Tu as refuse la localisation."
      : "Position indisponible.";
  }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 0 });
});

// ----- RGPD : export -----
$("btn-export").addEventListener("click", () => {
  const data = JSON.stringify(currentProfile, null, 2);
  const blob = new Blob([data], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "mes-donnees-bille-helping.json";
  a.click();
  URL.revokeObjectURL(url);
});

// ----- RGPD : suppression complete du compte -----
$("btn-delete").addEventListener("click", async () => {
  if (!confirm("Supprimer definitivement ton compte et toutes tes donnees ? Cette action est irreversible.")) return;
  try {
    // Les photos sont en base64 dans le document : le supprimer suffit.
    await deleteDoc(doc(db, "users", currentUser.uid));
    // Supprime le compte Auth
    await deleteUser(currentUser);
    alert("Compte supprime. A bientot !");
  } catch (e) {
    if (e.code === "auth/requires-recent-login") {
      alert("Pour des raisons de securite, reconnecte-toi puis reessaie la suppression.");
      signOut(auth);
    } else {
      alert("Erreur : " + e.message);
    }
  }
});

$("btn-logout").addEventListener("click", () => signOut(auth));

// ============================================================
// DECOUVRIR : swipe / like / match
// ============================================================

// Filtre selon l'orientation recherchee
function matchesSeeking(me, other) {
  if (me.seeking === "tous") return true;
  if (me.seeking === "hommes") return other.gender === "homme";
  if (me.seeking === "femmes") return other.gender === "femme";
  return true;
}

// Nombre d'elements communs entre deux listes
function sharedCount(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  const setB = new Set(b);
  return a.filter((x) => setB.has(x)).length;
}

// Score de compatibilite (0-100) : intentions communes > interets communs,
// bonus proximite et bonus "disponible maintenant".
function compatibilityScore(me, other, distKm, maxRadiusM) {
  let score = 0;
  // Intentions communes : fort poids (jusqu'a 45)
  score += Math.min(sharedCount(me.intentions, other.intentions), 3) * 15;
  // Centres d'interet communs : poids moyen (jusqu'a 30)
  score += Math.min(sharedCount(me.interests, other.interests), 3) * 10;
  // Proximite : plus c'est proche, plus le score monte (jusqu'a 15)
  const maxKm = (maxRadiusM || 50000) / 1000;
  score += Math.max(0, 15 * (1 - (distKm / maxKm)));
  // Bonus "disponible maintenant"
  if (isLookingNowActive(other)) score += 10;
  return score;
}

// Charge les profils proches a swiper
async function loadSwipeQueue() {
  $("swipe-empty").classList.add("hidden");
  if (!currentProfile.location) {
    $("card-stack").innerHTML = "";
    $("swipe-empty").classList.remove("hidden");
    $("swipe-empty").querySelector("p").textContent = "Active ta localisation dans ton profil.";
    return;
  }

  const center = [currentProfile.location.lat, currentProfile.location.lng];
  const prefs = currentProfile.searchPrefs || { maxDistance: 50, ageMin: 18, ageMax: 80 };
  const maxRadius = (prefs.maxDistance || 50) * 1000;
  const blocked = currentProfile.blocked || [];
  const bounds = geohashQueryBounds(center, maxRadius);
  const promises = bounds.map((b) =>
    getDocs(query(collection(db, "users"), orderBy("geohash"), startAt(b[0]), endAt(b[1])))
  );
  const snaps = await Promise.all(promises);

  // Recupere mes likes/pass deja faits
  const seenSnap = await getDocs(collection(db, "users", currentUser.uid, "swipes"));
  const seen = new Set();
  seenSnap.forEach((d) => seen.add(d.id));

  const queue = [];
  for (const snap of snaps) {
    for (const d of snap.docs) {
      if (d.id === currentUser.uid) continue;       // pas moi
      if (seen.has(d.id)) continue;                 // deja vu
      if (blocked.includes(d.id)) continue;         // bloque
      const data = d.data();
      if (!data.location || !data.profileComplete) continue;
      if (data.visibility && data.visibility.discoverable === false) continue;
      if (!matchesSeeking(currentProfile, data)) continue;

      // Filtre par tranche d'age
      const age = calculateAge(data.birthdate);
      if (age < prefs.ageMin || age > prefs.ageMax) continue;

      const distKm = distanceBetween([data.location.lat, data.location.lng], center);
      if (distKm * 1000 > maxRadius) continue;

      const item = { uid: d.id, data, distanceKm: distKm };
      item.compat = compatibilityScore(currentProfile, data, distKm, maxRadius);
      queue.push(item);
    }
  }
  // Tri par score de compatibilite (decroissant), la distance restant un facteur du score
  queue.sort((a, b) => b.compat - a.compat);
  swipeQueue = queue;
  renderSwipeCards();
}

function renderSwipeCards() {
  const stack = $("card-stack");
  stack.innerHTML = "";
  if (swipeQueue.length === 0) {
    $("swipe-empty").classList.remove("hidden");
    $("swipe-empty").querySelector("p").textContent = "Plus personne dans ton secteur pour l'instant.";
    return;
  }
  $("swipe-empty").classList.add("hidden");

  // On affiche les 3 prochaines cartes (la premiere au-dessus)
  const slice = swipeQueue.slice(0, 3);
  // On les ajoute en ordre inverse pour que la premiere soit au-dessus dans le DOM
  for (let i = slice.length - 1; i >= 0; i--) {
    const card = buildCard(slice[i]);
    card.dataset.depth = i; // 0 = dessus, 1 et 2 = dessous
    if (i === 0) card._enableDrag(); // drag seulement sur la carte du dessus
    stack.appendChild(card);
  }
}

function buildCard(item) {
  const d = item.data;
  const v = d.visibility || {};
  const card = document.createElement("div");
  card.className = "swipe-card";
  card.dataset.uid = item.uid;

  const photo = document.createElement("div");
  photo.className = "card-photo";
  if (d.photos && d.photos[0]) {
    photo.style.backgroundImage = "url('" + d.photos[0].url + "')";
  } else {
    photo.style.background = "linear-gradient(135deg, var(--primary), var(--accent))";
  }
  const grad = document.createElement("div");
  grad.className = "card-grad";

  // Badge "Disponible maintenant" (appose plus bas pour rester au-dessus)
  let dispo = null;
  if (isLookingNowActive(d)) {
    dispo = document.createElement("div");
    dispo.className = "card-dispo";
    dispo.textContent = "Dispo maintenant";
  }

  const info = document.createElement("div");
  info.className = "card-info";
  const name = document.createElement("div");
  name.className = "card-name";
  name.textContent = d.pseudo + (v.age !== false ? ", " + calculateAge(d.birthdate) : "");
  info.appendChild(name);

  const meta = document.createElement("div");
  meta.className = "card-meta";
  const bits = [];
  if (v.distance !== false) bits.push(formatDistance(item.distanceKm));
  meta.textContent = bits.join(" \u00b7 ");
  info.appendChild(meta);

  if (v.bio !== false && d.bio) {
    const bio = document.createElement("div");
    bio.className = "card-bio";
    bio.textContent = d.bio;
    info.appendChild(bio);
  }

  if (d.intentions && d.intentions.length) {
    const chips = document.createElement("div");
    chips.className = "card-chips";
    d.intentions.forEach((it) => {
      const c = document.createElement("span");
      c.className = "card-chip intention";
      c.textContent = it;
      chips.appendChild(c);
    });
    info.appendChild(chips);
  }

  if (v.interests !== false && d.interests && d.interests.length) {
    const chips = document.createElement("div");
    chips.className = "card-chips";
    d.interests.forEach((it) => {
      const c = document.createElement("span");
      c.className = "card-chip";
      c.textContent = it;
      chips.appendChild(c);
    });
    info.appendChild(chips);
  }

  // Stamps LIKE / NOPE
  const likeStamp = document.createElement("div");
  likeStamp.className = "swipe-stamp like"; likeStamp.textContent = "LIKE";
  const nopeStamp = document.createElement("div");
  nopeStamp.className = "swipe-stamp nope"; nopeStamp.textContent = "NOPE";

  card.appendChild(photo);
  card.appendChild(grad);
  if (dispo) card.appendChild(dispo);
  card.appendChild(likeStamp);
  card.appendChild(nopeStamp);
  card.appendChild(info);

  // Le drag sera active uniquement sur la carte du dessus (voir renderSwipeCards)
  card._enableDrag = () => enableDrag(card, likeStamp, nopeStamp);
  return card;
}

function formatDistance(km) {
  if (km < 1) return "a moins d'1 km";
  return "a ~" + Math.round(km) + " km";
}

// ----- Drag tactile / souris -----
function enableDrag(card, likeStamp, nopeStamp) {
  let startX = 0, currentX = 0, dragging = false;

  const onStart = (x) => { dragging = true; startX = x; card.style.transition = "none"; };
  const onMove = (x) => {
    if (!dragging) return;
    currentX = x - startX;
    const rot = currentX / 18;
    card.style.transform = "translateX(" + currentX + "px) rotate(" + rot + "deg)";
    likeStamp.style.opacity = currentX > 0 ? Math.min(currentX / 100, 1) : 0;
    nopeStamp.style.opacity = currentX < 0 ? Math.min(-currentX / 100, 1) : 0;
  };
  const onEnd = () => {
    if (!dragging) return;
    dragging = false;
    card.style.transition = "transform 0.3s ease, opacity 0.3s ease";
    if (currentX > 110) doSwipe("like");
    else if (currentX < -110) doSwipe("pass");
    else {
      card.style.transform = "";
      likeStamp.style.opacity = 0; nopeStamp.style.opacity = 0;
    }
    currentX = 0;
  };

  card.addEventListener("mousedown", (e) => onStart(e.clientX));
  window.addEventListener("mousemove", (e) => onMove(e.clientX));
  window.addEventListener("mouseup", onEnd);
  card.addEventListener("touchstart", (e) => onStart(e.touches[0].clientX), { passive: true });
  card.addEventListener("touchmove", (e) => onMove(e.touches[0].clientX), { passive: true });
  card.addEventListener("touchend", onEnd);
}

// Boutons like/pass
$("btn-like").addEventListener("click", () => doSwipe("like"));
$("btn-pass").addEventListener("click", () => doSwipe("pass"));

// ----- Action de swipe -----
async function doSwipe(action) {
  if (swipeQueue.length === 0) return;
  const item = swipeQueue[0];
  const topCard = $("card-stack").querySelector('.swipe-card[data-uid="' + item.uid + '"]');
  if (topCard) topCard.classList.add(action === "like" ? "gone-right" : "gone-left");

  // Enregistre le swipe
  try {
    await setDoc(doc(db, "users", currentUser.uid, "swipes", item.uid), {
      action, at: serverTimestamp()
    });
  } catch (e) { console.error(e); }

  // Si like, verifie le match mutuel
  if (action === "like") {
    try {
      const otherSwipe = await getDoc(doc(db, "users", item.uid, "swipes", currentUser.uid));
      if (otherSwipe.exists() && otherSwipe.data().action === "like") {
        await createMatch(item);
      }
    } catch (e) { console.error(e); }
  }

  swipeQueue.shift();
  setTimeout(() => renderSwipeCards(), 300);
}

// ----- Creation d'un match -----
async function createMatch(item) {
  const matchId = [currentUser.uid, item.uid].sort().join("_");
  try {
    await setDoc(doc(db, "matches", matchId), {
      users: [currentUser.uid, item.uid],
      names: {
        [currentUser.uid]: currentProfile.pseudo,
        [item.uid]: item.data.pseudo
      },
      photos: {
        [currentUser.uid]: (currentProfile.photos[0] || {}).url || "",
        [item.uid]: (item.data.photos[0] || {}).url || ""
      },
      createdAt: serverTimestamp(),
      lastMessage: ""
    });
    showMatchOverlay(item, matchId);
  } catch (e) { console.error("Erreur match :", e); }
}

function showMatchOverlay(item, matchId) {
  $("match-text").textContent = "Toi et " + item.data.pseudo + " vous etes likes !";
  $("match-overlay").classList.remove("hidden");
  $("btn-match-continue").onclick = () => $("match-overlay").classList.add("hidden");
  $("btn-match-message").onclick = () => {
    $("match-overlay").classList.add("hidden");
    switchView("messages");
    openChat(matchId, item.uid, item.data.pseudo);
  };
}

// ============================================================
// MESSAGES : liste des matchs + chat temps reel
// ============================================================

let listDisplayUnsub = null;

// ------------------------------------------------------------
// Mise en page responsive : sur grand ecran (PC), le panneau de
// discussion vit dans le volet droit de la vue Messages (2 colonnes) ;
// sur mobile il reste un panneau plein ecran attache au <body>.
// ------------------------------------------------------------
const desktopMQ = window.matchMedia("(min-width: 900px)");
function applyResponsiveLayout() {
  const pane = $("messages-chat-pane");
  const chat = $("chat-panel");
  if (!pane || !chat) return;
  if (desktopMQ.matches) {
    if (chat.parentElement !== pane) pane.appendChild(chat);
  } else if (chat.parentElement !== document.body) {
    document.body.appendChild(chat);
  }
}
desktopMQ.addEventListener("change", applyResponsiveLayout);
applyResponsiveLayout();

// Met en avant la conversation ouverte dans la liste (utile en 2 colonnes)
function setActiveRow(matchId) {
  document.querySelectorAll(".match-row").forEach((r) => {
    r.classList.toggle("active", !!matchId && r.dataset.matchId === matchId);
  });
}

// Charge la liste des matchs (temps reel) pour l'affichage
function loadMatches() {
  // On (re)entre dans Messages : on repart de la liste (placeholder a droite sur PC)
  $("chat-panel").classList.add("hidden");
  if (chatUnsub) { chatUnsub(); chatUnsub = null; }
  activeChat = null;
  setActiveRow(null);
  if (listDisplayUnsub) listDisplayUnsub();

  const q = query(
    collection(db, "matches"),
    where("users", "array-contains", currentUser.uid)
  );
  listDisplayUnsub = onSnapshot(q, (snap) => {
    const list = $("match-list");
    list.innerHTML = "";
    if (snap.empty) {
      $("no-matches").classList.remove("hidden");
      return;
    }
    $("no-matches").classList.add("hidden");

    const matches = [];
    snap.forEach((d) => matches.push({ id: d.id, ...d.data() }));
    // Tri par date de dernier message (recent en premier)
    matches.sort((a, b) => {
      const ta = a.lastMessageAt ? a.lastMessageAt.seconds : (a.createdAt ? a.createdAt.seconds : 0);
      const tb = b.lastMessageAt ? b.lastMessageAt.seconds : (b.createdAt ? b.createdAt.seconds : 0);
      return tb - ta;
    });

    matches.forEach((m) => {
      const otherUid = m.users.find((u) => u !== currentUser.uid);
      const otherName = m.names ? m.names[otherUid] : "Inconnu";
      const otherPhoto = m.photos ? m.photos[otherUid] : "";

      const row = document.createElement("div");
      row.className = "match-row";
      row.dataset.matchId = m.id;
      // Conserve la mise en avant si cette conversation est deja ouverte
      if (activeChat && activeChat.matchId === m.id) row.classList.add("active");

      const avatar = document.createElement("img");
      avatar.className = "match-avatar";
      if (otherPhoto) avatar.src = otherPhoto;
      const info = document.createElement("div");
      info.className = "match-info";
      const name = document.createElement("div");
      name.className = "match-name";
      name.textContent = otherName;
      const preview = document.createElement("div");
      preview.className = "match-preview";
      preview.textContent = m.lastMessage || "Dites-vous bonjour !";
      info.appendChild(name);
      info.appendChild(preview);

      row.appendChild(avatar);
      row.appendChild(info);

      // Pastille de non-lus pour cette conversation
      const badge = document.createElement("span");
      badge.className = "row-badge hidden";
      badge.id = "row-badge-" + m.id;
      row.appendChild(badge);

      row.addEventListener("click", () => openChat(m.id, otherUid, otherName));
      list.appendChild(row);

      // Ecoute les non-lus de cette conversation en temps reel
      listenUnread(m.id);
    });
  });
}

// Ecoute les messages non lus d'une conversation (recus par moi, non lus)
function listenUnread(matchId) {
  if (unreadUnsubs[matchId]) return; // deja ecoute
  const q = query(
    collection(db, "matches", matchId, "messages"),
    where("from", "!=", currentUser.uid),
    where("read", "==", false)
  );
  unreadUnsubs[matchId] = onSnapshot(q, (snap) => {
    unreadCounts[matchId] = snap.size;
    updateRowBadge(matchId, snap.size);
    updateTotalBadge();
  }, (err) => {
    // En cas d'erreur d'index, on retombe sur un comptage simple
    console.warn("listenUnread:", err.message);
  });
}

// Met a jour la pastille d'une ligne de conversation
function updateRowBadge(matchId, count) {
  const badge = document.getElementById("row-badge-" + matchId);
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count > 9 ? "9+" : count;
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }
}

// Met a jour la pastille totale sur l'onglet Messages
function updateTotalBadge() {
  const total = Object.values(unreadCounts).reduce((a, b) => a + b, 0);
  const badge = $("nav-msg-badge");
  if (total > 0) {
    badge.textContent = total > 9 ? "9+" : total;
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }
}

// Ouvre une conversation
function openChat(matchId, otherUid, otherName) {
  activeChat = { matchId, otherUid, otherName };
  $("chat-with").textContent = otherName;
  $("chat-messages").innerHTML = "";
  $("chat-panel").classList.remove("hidden");
  setActiveRow(matchId);

  if (chatUnsub) chatUnsub();
  const q = query(
    collection(db, "matches", matchId, "messages"),
    orderBy("at", "asc")
  );
  chatUnsub = onSnapshot(q, async (snap) => {
    const box = $("chat-messages");
    box.innerHTML = "";
    const toMarkRead = [];

    snap.forEach((d) => {
      const msg = d.data();
      const isMine = msg.from === currentUser.uid;
      const el = document.createElement("div");
      el.className = "msg " + (isMine ? "sent" : "received");

      const textSpan = document.createElement("span");
      textSpan.className = "msg-text";
      textSpan.textContent = msg.text;
      el.appendChild(textSpan);

      // Ticks uniquement sur MES messages (envoyes par moi)
      if (isMine) {
        const ticks = document.createElement("span");
        ticks.className = "msg-ticks" + (msg.read ? " read" : "");
        ticks.innerHTML = msg.read ? doubleTickSVG() : singleTickSVG();
        el.appendChild(ticks);
      }

      box.appendChild(el);

      // Si le message vient de l'autre et n'est pas lu -> a marquer comme lu
      if (!isMine && !msg.read) toMarkRead.push(d.id);
    });
    box.scrollTop = box.scrollHeight;

    // Marque les messages recus comme lus
    for (const msgId of toMarkRead) {
      try {
        await updateDoc(doc(db, "matches", matchId, "messages", msgId), { read: true });
      } catch (e) { console.error(e); }
    }
  });
}

// SVG : un tick (envoye, non lu)
function singleTickSVG() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
}
// SVG : deux ticks (lu)
function doubleTickSVG() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 7 9 18 5 14"></polyline><polyline points="23 7 14 18 13.5 17.5"></polyline></svg>';
}

$("btn-back-messages").addEventListener("click", () => {
  $("chat-panel").classList.add("hidden");
  if (chatUnsub) { chatUnsub(); chatUnsub = null; }
  activeChat = null;
  setActiveRow(null);
});

// Envoi d'un message
async function sendMessage() {
  const text = $("chat-input").value.trim();
  if (!text || !activeChat) return;
  $("chat-input").value = "";
  try {
    await addDoc(collection(db, "matches", activeChat.matchId, "messages"), {
      from: currentUser.uid,
      text,
      read: false,
      at: serverTimestamp()
    });
    await updateDoc(doc(db, "matches", activeChat.matchId), {
      lastMessage: text,
      lastMessageAt: serverTimestamp(),
      lastSender: currentUser.uid
    });
  } catch (e) { console.error("Erreur envoi :", e); }
}
$("btn-send").addEventListener("click", sendMessage);
$("chat-input").addEventListener("keydown", (e) => { if (e.key === "Enter") sendMessage(); });

// ============================================================
// PROFIL DETAILLE (au tap sur une carte ou bouton info)
// ============================================================
let detailCurrent = null;

function openDetail(item) {
  detailCurrent = item;
  const d = item.data;
  const v = d.visibility || {};
  const gallery = $("detail-gallery");
  gallery.innerHTML = "";
  (d.photos || []).forEach((ph) => {
    const img = document.createElement("img");
    img.src = ph.url;
    gallery.appendChild(img);
  });
  $("detail-name").textContent = d.pseudo;
  $("detail-age").textContent = (v.age !== false) ? calculateAge(d.birthdate) + " ans" : "";
  $("detail-distance").textContent = (v.distance !== false) ? formatDistance(item.distanceKm) : "";
  $("detail-bio").textContent = (v.bio !== false) ? (d.bio || "") : "";
  const di = $("detail-interests");
  di.innerHTML = "";
  if (v.interests !== false) {
    (d.interests || []).forEach((it) => {
      const c = document.createElement("span");
      c.className = "chip-static";
      c.textContent = it;
      di.appendChild(c);
    });
  }
  const din = $("detail-intentions");
  if (din) {
    din.innerHTML = "";
    (d.intentions || []).forEach((it) => {
      const c = document.createElement("span");
      c.className = "chip-static intention";
      c.textContent = it;
      din.appendChild(c);
    });
  }
  $("detail-panel").classList.remove("hidden");
}
$("btn-detail-close").addEventListener("click", () => $("detail-panel").classList.add("hidden"));
$("btn-info").addEventListener("click", () => {
  if (swipeQueue.length > 0) openDetail(swipeQueue[0]);
});

// ============================================================
// SIGNALEMENT + BLOCAGE
// ============================================================
let reportTarget = null;

function openReport(uid, fromChat) {
  reportTarget = { uid, fromChat: !!fromChat };
  document.querySelectorAll('input[name="report-reason"]').forEach((r) => (r.checked = false));
  $("report-status").textContent = "";
  $("report-modal").classList.remove("hidden");
}
$("btn-report").addEventListener("click", () => {
  if (detailCurrent) openReport(detailCurrent.uid, false);
});
$("btn-cancel-report").addEventListener("click", () => $("report-modal").classList.add("hidden"));

$("btn-confirm-report").addEventListener("click", async () => {
  const reason = document.querySelector('input[name="report-reason"]:checked');
  if (!reason) { $("report-status").textContent = "Choisis une raison."; $("report-status").className = "status error"; return; }
  try {
    // Enregistre le signalement (illicite manifeste => traitement prioritaire DSA)
    const illegal = ILLEGAL_REPORT_REASONS.includes(reason.value);
    await addDoc(collection(db, "reports"), {
      reporter: currentUser.uid,
      reported: reportTarget.uid,
      reason: reason.value,
      illegal,
      priority: illegal ? "urgent" : "normal",
      status: "pending",
      at: serverTimestamp()
    });
    // Bloque l'utilisateur (ajoute a ma liste de bloques)
    const blocked = currentProfile.blocked || [];
    if (!blocked.includes(reportTarget.uid)) blocked.push(reportTarget.uid);
    await updateDoc(doc(db, "users", currentUser.uid), { blocked });
    currentProfile.blocked = blocked;

    $("report-modal").classList.add("hidden");
    $("detail-panel").classList.add("hidden");
    if (reportTarget.fromChat) {
      $("chat-panel").classList.add("hidden");
      switchView("messages");
    }
    toast("Profil signale et bloque. Merci.");
    loadSwipeQueue();
  } catch (e) {
    $("report-status").textContent = "Erreur : " + e.message;
    $("report-status").className = "status error";
  }
});

// ============================================================
// MENU CONVERSATION (signaler / unmatch)
// ============================================================
$("btn-chat-menu").addEventListener("click", () => $("chat-menu-modal").classList.remove("hidden"));
$("btn-chat-menu-cancel").addEventListener("click", () => $("chat-menu-modal").classList.add("hidden"));
$("btn-chat-report").addEventListener("click", () => {
  $("chat-menu-modal").classList.add("hidden");
  if (activeChat) openReport(activeChat.otherUid, true);
});
$("btn-chat-unmatch").addEventListener("click", async () => {
  if (!activeChat) return;
  if (!confirm("Supprimer ce match ? La conversation sera perdue.")) return;
  try {
    await deleteDoc(doc(db, "matches", activeChat.matchId));
    $("chat-menu-modal").classList.add("hidden");
    $("chat-panel").classList.add("hidden");
    switchView("messages");
    toast("Match supprime.");
  } catch (e) { toast("Erreur : " + e.message); }
});

// ============================================================
// QUI M'A LIKE
// ============================================================
$("btn-open-likes").addEventListener("click", openLikes);
$("btn-likes-close").addEventListener("click", () => $("likes-panel").classList.add("hidden"));

async function openLikes() {
  $("likes-panel").classList.remove("hidden");
  const grid = $("likes-grid");
  grid.innerHTML = "";
  $("no-likes").classList.add("hidden");

  // On cherche les gens qui m'ont like (leur swipe sur moi = like)
  // Necessite de parcourir : approche simple via collectionGroup serait mieux,
  // mais on reste compatible : on lit les swipes ou la cible est moi.
  try {
    const likers = [];
    // On parcourt mes matchs potentiels : ceux qui m'ont like sans que je les aie vus
    const seenSnap = await getDocs(collection(db, "users", currentUser.uid, "swipes"));
    const iSwiped = new Set();
    seenSnap.forEach((d) => iSwiped.add(d.id));

    // On lit la sous-collection swipes de chaque user proche (limite : zone geo)
    if (currentProfile.location) {
      const center = [currentProfile.location.lat, currentProfile.location.lng];
      const bounds = geohashQueryBounds(center, SEARCH_RADIUS_M);
      const snaps = await Promise.all(bounds.map((b) =>
        getDocs(query(collection(db, "users"), orderBy("geohash"), startAt(b[0]), endAt(b[1])))
      ));
      for (const snap of snaps) {
        for (const userDoc of snap.docs) {
          if (userDoc.id === currentUser.uid) continue;
          if (iSwiped.has(userDoc.id)) continue; // deja traite
          try {
            const theirSwipe = await getDoc(doc(db, "users", userDoc.id, "swipes", currentUser.uid));
            if (theirSwipe.exists() && theirSwipe.data().action === "like") {
              likers.push({ uid: userDoc.id, data: userDoc.data() });
            }
          } catch (e) {}
        }
      }
    }

    if (likers.length === 0) {
      $("no-likes").classList.remove("hidden");
      return;
    }
    likers.forEach((l) => {
      const card = document.createElement("div");
      card.className = "like-card";
      const img = document.createElement("img");
      if (l.data.photos && l.data.photos[0]) img.src = l.data.photos[0].url;
      const name = document.createElement("div");
      name.className = "like-name";
      name.textContent = l.data.pseudo + ", " + calculateAge(l.data.birthdate);
      card.appendChild(img);
      card.appendChild(name);
      // Au clic : like en retour -> match direct
      card.addEventListener("click", async () => {
        await setDoc(doc(db, "users", currentUser.uid, "swipes", l.uid), { action: "like", at: serverTimestamp() });
        const dist = currentProfile.location
          ? distanceBetween([l.data.location.lat, l.data.location.lng], [currentProfile.location.lat, currentProfile.location.lng])
          : 0;
        await createMatch({ uid: l.uid, data: l.data, distanceKm: dist });
        $("likes-panel").classList.add("hidden");
      });
      grid.appendChild(card);
    });
  } catch (e) {
    console.error("openLikes:", e);
    $("no-likes").classList.remove("hidden");
  }
}

// ============================================================
// EDITION DU PROFIL
// ============================================================
let editPhotos = [];
let editInterests = [];
let editIntentions = [];

$("btn-edit-profile").addEventListener("click", openEdit);
$("btn-cancel-edit").addEventListener("click", () => $("edit-modal").classList.add("hidden"));

function openEdit() {
  editPhotos = [...(currentProfile.photos || [])];
  editInterests = [...(currentProfile.interests || [])];
  editIntentions = [...(currentProfile.intentions || [])];
  $("edit-bio").value = currentProfile.bio || "";
  $("edit-bio-count").textContent = ($("edit-bio").value || "").length;
  renderEditPhotos();
  renderEditInterests();
  renderEditIntentions();
  $("edit-modal").classList.remove("hidden");
}

function renderEditPhotos() {
  const grid = $("edit-photo-grid");
  grid.innerHTML = "";
  editPhotos.forEach((p, i) => {
    const thumb = document.createElement("div");
    thumb.className = "photo-thumb";
    const img = document.createElement("img");
    img.src = p.url;
    const rm = document.createElement("button");
    rm.className = "remove";
    rm.textContent = "\u00d7";
    rm.addEventListener("click", () => { editPhotos.splice(i, 1); renderEditPhotos(); });
    thumb.appendChild(img);
    thumb.appendChild(rm);
    grid.appendChild(thumb);
  });
}

function renderEditInterests() {
  const box = $("edit-interests");
  box.innerHTML = "";
  INTERESTS.forEach((label) => {
    const chip = document.createElement("button");
    chip.className = "chip" + (editInterests.includes(label) ? " selected" : "");
    chip.textContent = label;
    chip.addEventListener("click", () => {
      if (editInterests.includes(label)) editInterests = editInterests.filter((x) => x !== label);
      else editInterests.push(label);
      renderEditInterests();
    });
    box.appendChild(chip);
  });
}

function renderEditIntentions() {
  const box = $("edit-intentions");
  if (!box) return;
  box.innerHTML = "";
  INTENTIONS.forEach((label) => {
    const chip = document.createElement("button");
    chip.className = "chip intention" + (editIntentions.includes(label) ? " selected" : "");
    chip.textContent = label;
    chip.addEventListener("click", () => {
      if (editIntentions.includes(label)) editIntentions = editIntentions.filter((x) => x !== label);
      else editIntentions.push(label);
      renderEditIntentions();
    });
    box.appendChild(chip);
  });
}

$("edit-bio").addEventListener("input", () => {
  $("edit-bio-count").textContent = $("edit-bio").value.length;
});

$("btn-edit-add-photo").addEventListener("click", () => $("edit-photo-input").click());
$("edit-photo-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (editPhotos.length >= 6) { $("edit-photo-status").textContent = "Maximum 6 photos."; return; }
  $("edit-photo-status").textContent = "Traitement...";
  try {
    let dataUrl = await compressImage(file, 800, 0.7);
    if (dataUrl.length > 900000) dataUrl = await compressImage(file, 600, 0.6);
    editPhotos.push({ url: dataUrl });
    renderEditPhotos();
    $("edit-photo-status").textContent = "";
  } catch (err) { $("edit-photo-status").textContent = "Erreur."; }
  $("edit-photo-input").value = "";
});

$("btn-save-profile").addEventListener("click", async () => {
  if (editPhotos.length < 1) { $("edit-photo-status").textContent = "Au moins une photo requise."; $("edit-photo-status").className = "status error"; return; }
  try {
    await updateDoc(doc(db, "users", currentUser.uid), {
      photos: editPhotos,
      bio: $("edit-bio").value.trim(),
      interests: editInterests,
      intentions: editIntentions
    });
    currentProfile.photos = editPhotos;
    currentProfile.bio = $("edit-bio").value.trim();
    currentProfile.interests = editInterests;
    currentProfile.intentions = editIntentions;
    $("edit-modal").classList.add("hidden");
    renderProfile();
    toast("Profil mis a jour.");
  } catch (e) { $("edit-photo-status").textContent = "Erreur : " + e.message; }
});

// ============================================================
// PREFERENCES DE RECHERCHE
// ============================================================
function initSearchPrefs() {
  const p = currentProfile.searchPrefs || { maxDistance: 50, ageMin: 18, ageMax: 80 };
  $("pref-distance").value = p.maxDistance;
  $("pref-distance-val").textContent = p.maxDistance;
  $("pref-age-min").value = p.ageMin;
  $("pref-age-min-val").textContent = p.ageMin;
  $("pref-age-max").value = p.ageMax;
  $("pref-age-max-val").textContent = p.ageMax;
}
let prefTimer = null;
function onPrefChange() {
  $("pref-distance-val").textContent = $("pref-distance").value;
  $("pref-age-min-val").textContent = $("pref-age-min").value;
  $("pref-age-max-val").textContent = $("pref-age-max").value;
  if (prefTimer) clearTimeout(prefTimer);
  prefTimer = setTimeout(saveSearchPrefs, 600);
}
async function saveSearchPrefs() {
  const searchPrefs = {
    maxDistance: parseInt($("pref-distance").value, 10),
    ageMin: parseInt($("pref-age-min").value, 10),
    ageMax: parseInt($("pref-age-max").value, 10)
  };
  try {
    await updateDoc(doc(db, "users", currentUser.uid), { searchPrefs });
    currentProfile.searchPrefs = searchPrefs;
    $("pref-status").textContent = "Preferences enregistrees.";
    $("pref-status").className = "status success";
    setTimeout(() => ($("pref-status").textContent = ""), 1500);
  } catch (e) { $("pref-status").textContent = "Erreur."; }
}
["pref-distance", "pref-age-min", "pref-age-max"].forEach((id) => $(id).addEventListener("input", onPrefChange));

// ============================================================
// CGU
// ============================================================
$("btn-show-cgu").addEventListener("click", () => $("cgu-panel").classList.remove("hidden"));
$("btn-cgu-close").addEventListener("click", () => $("cgu-panel").classList.add("hidden"));

// ============================================================
// ORCHESTRATION : etat de connexion
// ============================================================
onAuthStateChanged(auth, async (user) => {
  // Nettoyage des listeners
  if (matchesUnsub) { matchesUnsub(); matchesUnsub = null; }
  if (listDisplayUnsub) { listDisplayUnsub(); listDisplayUnsub = null; }
  if (chatUnsub) { chatUnsub(); chatUnsub = null; }
  Object.values(unreadUnsubs).forEach((u) => u && u());
  unreadUnsubs = {};
  unreadCounts = {};

  if (!user) {
    currentUser = null;
    currentProfile = null;
    showScreen("landing");
    return;
  }

  currentUser = user;
  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    if (!snap.exists()) {
      // Profil pas encore cree (cas limite) : on deconnecte
      showScreen("auth");
      return;
    }
    currentProfile = snap.data();

    // Si profil incomplet -> onboarding obligatoire
    if (!currentProfile.profileComplete) {
      initOnboarding();
    } else {
      enterApp();
    }
  } catch (e) {
    console.error("Erreur chargement profil :", e);
    showScreen("auth");
  }
});
