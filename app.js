// Imports Firebase (SDK v12.14.0)
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
  getDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";

// Configuration du projet Firebase
const firebaseConfig = {
  apiKey: "AIzaSyA7ZBYnnB6vWTkDQBmjRQ0AyY4lG3PtiKg",
  authDomain: "bille-helping.firebaseapp.com",
  projectId: "bille-helping",
  storageBucket: "bille-helping.firebasestorage.app",
  messagingSenderId: "1054050764975",
  appId: "1:1054050764975:web:a3cb255705a9d5d39f2c5a",
  measurementId: "G-6EVPS9S839"
};

// Initialisation
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Elements du DOM
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
const loggedInEl = document.getElementById("logged-in");
const userEmailEl = document.getElementById("user-email");
const profileInfoEl = document.getElementById("profile-info");

// Mode courant : "login" ou "signup"
let mode = "login";

// Bascule entre connexion et inscription
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

// Affichage des messages de statut
function showStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = "status " + (type || "");
}

// Traduction des erreurs Firebase en francais
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

// Calcul de l'age a partir de la date de naissance
function calculateAge(birthdate) {
  const today = new Date();
  const birth = new Date(birthdate);
  let age = today.getFullYear() - birth.getFullYear();
  const monthDiff = today.getMonth() - birth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
    age--;
  }
  return age;
}

// Validation des champs d'inscription
function validateSignup() {
  if (!pseudoInput.value.trim()) {
    return "Choisis un pseudo.";
  }
  if (!birthdateInput.value) {
    return "Indique ta date de naissance.";
  }
  const age = calculateAge(birthdateInput.value);
  if (age < 18) {
    return "Tu dois avoir 18 ans ou plus pour t'inscrire.";
  }
  if (age > 120) {
    return "Date de naissance invalide.";
  }
  if (!genderInput.value) {
    return "Indique ton genre.";
  }
  if (!seekingInput.value) {
    return "Indique ce que tu recherches.";
  }
  if (!consentAge.checked) {
    return "Tu dois certifier avoir 18 ans ou plus.";
  }
  if (!consentData.checked) {
    return "Tu dois accepter le traitement de tes donnees.";
  }
  return null;
}

// Soumission (connexion ou inscription selon le mode)
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
      showStatus("Connecte !", "success");
    } catch (error) {
      showStatus(translateError(error.code), "error");
    }
    return;
  }

  // Mode inscription
  const validationError = validateSignup();
  if (validationError) {
    showStatus(validationError, "error");
    return;
  }

  try {
    // 1. Creation du compte d'authentification
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    const uid = cred.user.uid;

    // 2. Ecriture du profil dans Firestore avec consentement horodate
    await setDoc(doc(db, "users", uid), {
      pseudo: pseudoInput.value.trim(),
      birthdate: birthdateInput.value,
      gender: genderInput.value,
      seeking: seekingInput.value,
      identityVerified: false,
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

// Deconnexion
btnLogout.addEventListener("click", async () => {
  await signOut(auth);
  showStatus("Deconnecte.", "");
});

// Surveillance de l'etat de connexion
onAuthStateChanged(auth, async (user) => {
  if (user) {
    loggedInEl.classList.remove("hidden");
    userEmailEl.textContent = user.email;

    // Lecture du profil Firestore
    try {
      const snap = await getDoc(doc(db, "users", user.uid));
      if (snap.exists()) {
        const p = snap.data();
        profileInfoEl.textContent =
          p.pseudo + " - " + p.gender + " recherche " + p.seeking;
      } else {
        profileInfoEl.textContent = "(profil non renseigne)";
      }
    } catch (e) {
      profileInfoEl.textContent = "";
    }
  } else {
    loggedInEl.classList.add("hidden");
    userEmailEl.textContent = "";
    profileInfoEl.textContent = "";
  }
});
