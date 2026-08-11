// ============================================================
// BILLE HELPING — Espace modération (admin)
// Réservé aux comptes ayant le custom claim { admin: true }.
// Toutes les opérations passent par le backend (/api/admin/*),
// qui revérifie le claim admin côté serveur.
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyA7ZBYnnB6vWTkDQBmjRQ0AyY4lG3PtiKg",
  authDomain: "bille-helping.firebaseapp.com",
  projectId: "bille-helping",
  storageBucket: "bille-helping.firebasestorage.app",
  messagingSenderId: "1054050764975",
  appId: "1:1054050764975:web:a3cb255705a9d5d39f2c5a"
};
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

const API_BASE = (typeof window !== "undefined" && window.__BILLE_API__) || "/api";
const $ = (id) => document.getElementById(id);

async function apiFetch(path, options = {}) {
  const user = auth.currentUser;
  if (!user) throw new Error("Non connecte.");
  const token = await user.getIdToken();
  const res = await fetch(API_BASE + path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    let msg = "Erreur " + res.status;
    try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (_) {}
    throw new Error(msg);
  }
  return res.json();
}

let toastTimer = null;
function toast(msg) {
  const el = $("admin-toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 2600);
}

function ageFromBirthdate(bd) {
  if (!bd) return "";
  const d = new Date(bd);
  if (isNaN(d)) return "";
  const diff = Date.now() - d.getTime();
  return Math.floor(diff / (365.25 * 24 * 3600 * 1000));
}

// ============================================================
// Connexion
// ============================================================
$("admin-login-btn").addEventListener("click", async () => {
  const email = $("admin-email").value.trim();
  const pass = $("admin-password").value;
  $("admin-login-status").textContent = "Connexion…";
  $("admin-login-status").className = "status";
  try {
    await signInWithEmailAndPassword(auth, email, pass);
  } catch (e) {
    $("admin-login-status").textContent = "Échec de connexion.";
    $("admin-login-status").className = "status error";
  }
});
$("admin-password").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("admin-login-btn").click();
});
$("admin-logout").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    $("admin-login").classList.remove("hidden");
    $("admin-dash").classList.add("hidden");
    return;
  }
  // Vérifie le claim admin
  let isAdmin = false;
  try {
    const res = await user.getIdTokenResult(true);
    isAdmin = res.claims.admin === true;
  } catch (_) {}
  if (!isAdmin) {
    $("admin-login-status").textContent = "Ce compte n'est pas administrateur.";
    $("admin-login-status").className = "status error";
    $("admin-login").classList.remove("hidden");
    $("admin-dash").classList.add("hidden");
    await signOut(auth);
    return;
  }
  $("admin-login").classList.add("hidden");
  $("admin-dash").classList.remove("hidden");
  loadUsers();
});

// ============================================================
// Onglets
// ============================================================
document.querySelectorAll(".admin-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".admin-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const which = tab.dataset.tab;
    $("admin-tab-users").classList.toggle("hidden", which !== "users");
    $("admin-tab-reports").classList.toggle("hidden", which !== "reports");
    if (which === "reports") loadReports();
    if (which === "users") loadUsers();
  });
});

// ============================================================
// Comptes
// ============================================================
async function loadUsers() {
  $("users-status").textContent = "Chargement…";
  try {
    const { users } = await apiFetch("/admin/users");
    $("users-status").textContent = users.length + " compte(s)";
    const list = $("users-list");
    list.innerHTML = "";
    users.forEach((u) => {
      const row = document.createElement("div");
      row.className = "admin-row";
      const thumb = document.createElement("div");
      thumb.className = "admin-thumb";
      if (u.photo) thumb.style.backgroundImage = `url(${u.photo})`;
      const info = document.createElement("div");
      info.className = "admin-row-info";
      const age = ageFromBirthdate(u.birthdate);
      info.innerHTML =
        `<div class="admin-row-name">${escapeHtml(u.pseudo || "(sans pseudo)")}` +
        (u.identityVerified ? ' <span class="admin-verified">✓ vérifié</span>' : "") +
        `</div><div class="admin-row-meta">${age ? age + " ans · " : ""}${u.photosCount} photo(s)` +
        `${u.blockedCount ? " · " + u.blockedCount + " bloqué(s)" : ""}</div>`;
      const btn = document.createElement("button");
      btn.className = "btn btn-ghost btn-small";
      btn.textContent = "Voir";
      btn.addEventListener("click", () => openUser(u.uid));
      row.appendChild(thumb);
      row.appendChild(info);
      row.appendChild(btn);
      list.appendChild(row);
    });
  } catch (e) {
    $("users-status").textContent = "Erreur : " + e.message;
  }
}

let currentUserUid = null;
async function openUser(uid) {
  currentUserUid = uid;
  $("admin-user-status").textContent = "";
  $("admin-user-photos").innerHTML = "";
  $("admin-user-meta").innerHTML = "Chargement…";
  $("admin-user-modal").classList.remove("hidden");
  try {
    const { email, profile } = await apiFetch("/admin/users/" + uid);
    $("admin-user-name").textContent = profile.pseudo || "(sans pseudo)";
    $("admin-user-email").textContent = email || "";
    renderUserPhotos(uid, profile.photos || []);
    const age = ageFromBirthdate(profile.birthdate);
    $("admin-user-meta").innerHTML =
      `<div><strong>Identité :</strong> ${profile.identityVerified ? "✓ vérifiée" : "non vérifiée"}</div>` +
      `<div><strong>Âge :</strong> ${age || "?"}</div>` +
      `<div><strong>Genre :</strong> ${escapeHtml(profile.gender || "?")} · <strong>cherche :</strong> ${escapeHtml(profile.seeking || "?")}</div>` +
      `<div><strong>Bio :</strong> ${escapeHtml(profile.bio || "")}</div>` +
      `<div><strong>Intérêts :</strong> ${escapeHtml((profile.interests || []).join(", "))}</div>` +
      `<div><strong>Intentions :</strong> ${escapeHtml((profile.intentions || []).join(", "))}</div>`;
  } catch (e) {
    $("admin-user-meta").textContent = "Erreur : " + e.message;
  }
}

function renderUserPhotos(uid, photos) {
  const box = $("admin-user-photos");
  box.innerHTML = "";
  photos.forEach((ph, i) => {
    const cell = document.createElement("div");
    cell.className = "admin-photo";
    const img = document.createElement("img");
    img.src = ph.url;
    const del = document.createElement("button");
    del.className = "admin-photo-del";
    del.textContent = "×";
    del.title = "Supprimer cette photo";
    del.addEventListener("click", async () => {
      if (!confirm("Supprimer cette photo ?")) return;
      try {
        const { photos: updated } = await apiFetch("/admin/users/" + uid + "/photos/delete", {
          method: "POST",
          body: JSON.stringify({ index: i })
        });
        renderUserPhotos(uid, updated);
        toast("Photo supprimée.");
      } catch (e) { toast("Erreur : " + e.message); }
    });
    cell.appendChild(img);
    cell.appendChild(del);
    box.appendChild(cell);
  });
  if (!photos.length) box.innerHTML = '<p class="hint">Aucune photo.</p>';
}

$("admin-user-close").addEventListener("click", () => $("admin-user-modal").classList.add("hidden"));

$("admin-verify").addEventListener("click", () => setVerify(true));
$("admin-unverify").addEventListener("click", () => setVerify(false));
async function setVerify(verified) {
  if (!currentUserUid) return;
  try {
    await apiFetch("/admin/users/" + currentUserUid + "/verify", {
      method: "PATCH",
      body: JSON.stringify({ verified })
    });
    toast(verified ? "Identité validée." : "Validation retirée.");
    openUser(currentUserUid);
    loadUsers();
  } catch (e) { $("admin-user-status").textContent = "Erreur : " + e.message; }
}

$("admin-delete-user").addEventListener("click", async () => {
  if (!currentUserUid) return;
  if (!confirm("Supprimer définitivement ce compte et toutes ses données ? (matchs, messages, likes envoyés et reçus)")) return;
  try {
    await apiFetch("/admin/users/" + currentUserUid, { method: "DELETE" });
    $("admin-user-modal").classList.add("hidden");
    toast("Compte supprimé.");
    loadUsers();
  } catch (e) { $("admin-user-status").textContent = "Erreur : " + e.message; }
});

// ============================================================
// Signalements
// ============================================================
async function loadReports() {
  $("reports-status").textContent = "Chargement…";
  try {
    const { reports } = await apiFetch("/admin/reports");
    $("reports-status").textContent = reports.length + " signalement(s)";
    const list = $("reports-list");
    list.innerHTML = "";
    reports.forEach((r) => {
      const row = document.createElement("div");
      row.className = "admin-row";
      row.innerHTML =
        `<div class="admin-row-info"><div class="admin-row-name">` +
        `${r.illegal ? '<span class="admin-urgent">URGENT</span> ' : ""}${escapeHtml(r.reason)}</div>` +
        `<div class="admin-row-meta">signalé : ${escapeHtml(r.reported)} · par : ${escapeHtml(r.reporter)}` +
        `${r.at ? " · " + new Date(r.at).toLocaleString("fr-FR") : ""}</div></div>`;
      const btn = document.createElement("button");
      btn.className = "btn btn-ghost btn-small";
      btn.textContent = "Voir le compte";
      btn.addEventListener("click", () => openUser(r.reported));
      row.appendChild(btn);
      list.appendChild(row);
    });
    if (!reports.length) list.innerHTML = '<p class="hint">Aucun signalement.</p>';
  } catch (e) {
    $("reports-status").textContent = "Erreur : " + e.message;
  }
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
