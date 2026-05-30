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

// ===== Etat global =====
let mode = "login";
let currentUser = null;       // firebase auth user
let currentProfile = null;    // doc Firestore
let onbPhotos = [];           // {url, path}
let onbInterests = [];
let swipeQueue = [];          // profils a swiper
let activeChat = null;        // {matchId, otherUid, otherName}
let chatUnsub = null;         // unsubscribe du listener chat
let matchesUnsub = null;
let unreadCounts = {};        // { matchId: nombre de non-lus }
let unreadUnsubs = {};        // { matchId: unsubscribe }

// ===== Helpers DOM =====
const $ = (id) => document.getElementById(id);
const screens = {
  auth: $("auth-screen"),
  onboarding: $("onboarding-screen"),
  app: $("app-screen")
};
function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.add("hidden"));
  screens[name].classList.remove("hidden");
}

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
      photos: [],
      identityVerified: false,
      location: null,
      geohash: null,
      profileComplete: false,
      visibility: { age: true, distance: true, bio: true, interests: true, discoverable: true },
      consent: { age18: true, dataProcessing: true, consentedAt: serverTimestamp() },
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

// ----- Validation finale -----
$("btn-finish-onboarding").addEventListener("click", async () => {
  if (computeCompletion() < 100) return;
  try {
    await updateDoc(doc(db, "users", currentUser.uid), {
      photos: onbPhotos,
      bio: $("bio-input").value.trim(),
      interests: onbInterests,
      profileComplete: true
    });
    currentProfile.photos = onbPhotos;
    currentProfile.bio = $("bio-input").value.trim();
    currentProfile.interests = onbInterests;
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
  $("bio-input").value = currentProfile.bio || "";
  $("bio-count").textContent = ($("bio-input").value || "").length;
  renderOnbPhotos();
  renderInterests();
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

  // Etat des toggles de visibilite
  const v = p.visibility || {};
  $("vis-age").checked = v.age !== false;
  $("vis-distance").checked = v.distance !== false;
  $("vis-bio").checked = v.bio !== false;
  $("vis-interests").checked = v.interests !== false;
  $("vis-discoverable").checked = v.discoverable !== false;

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
  const bounds = geohashQueryBounds(center, SEARCH_RADIUS_M);
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
      const data = d.data();
      if (!data.location || !data.profileComplete) continue;
      if (data.visibility && data.visibility.discoverable === false) continue;
      if (!matchesSeeking(currentProfile, data)) continue;

      const distKm = distanceBetween([data.location.lat, data.location.lng], center);
      if (distKm * 1000 > SEARCH_RADIUS_M) continue;

      queue.push({ uid: d.id, data, distanceKm: distKm });
    }
  }
  queue.sort((a, b) => a.distanceKm - b.distanceKm);
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

// Charge la liste des matchs (temps reel) pour l'affichage
function loadMatches() {
  $("chat-panel").classList.add("hidden");
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


  activeChat = { matchId, otherUid, otherName };
  $("chat-with").textContent = otherName;
  $("chat-messages").innerHTML = "";
  $("chat-panel").classList.remove("hidden");

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
    showScreen("auth");
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
