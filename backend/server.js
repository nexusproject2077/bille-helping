// ============================================================
// BILLE HELPING — Backend API (Cloud Run)
// ------------------------------------------------------------
// Operations privilegiees, effectuees cote serveur avec le
// Firebase Admin SDK (qui contourne les regles Firestore) :
//   - GET    /api/export   : export RGPD des donnees de l'utilisateur
//   - DELETE /api/account  : suppression complete du compte (droit a l'oubli)
//   - POST   /api/report   : reception d'un signalement + blocage
//
// Toutes les routes /api/* exigent un jeton Firebase valide
// (header "Authorization: Bearer <idToken>"), verifie via Admin SDK.
// ============================================================

const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

// Sur Cloud Run, les identifiants proviennent du compte de service
// du service (Application Default Credentials). En local, definir
// GOOGLE_APPLICATION_CREDENTIALS vers un fichier de compte de service.
admin.initializeApp();
const db = admin.firestore();

const app = express();
app.use(express.json({ limit: "1mb" }));

// CORS : par defaut on autorise l'origine du site (Firebase Hosting).
// En production, le frontend appelle "/api/**" en same-origin via le
// rewrite Hosting -> Cloud Run, donc CORS n'est meme pas necessaire ;
// il sert surtout pour un appel direct a l'URL Cloud Run (dev/test).
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
app.use(
  cors({
    origin: allowedOrigins.length ? allowedOrigins : true,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ---- Constantes de moderation (alignees sur le frontend / DSA) ----
const VALID_REPORT_REASONS = [
  "mineur",
  "image-intime-non-consentie",
  "non-consentement",
  "harcelement",
  "prostitution",
  "faux-profil",
  "autre",
];
const ILLEGAL_REPORT_REASONS = [
  "mineur",
  "image-intime-non-consentie",
  "non-consentement",
];

// ============================================================
// Sante
// ============================================================
function health(_req, res) {
  res.json({ status: "ok", service: "bille-backend" });
}
app.get("/health", health);
app.get("/api/health", health);
app.get("/", health);

// ============================================================
// Middleware d'authentification (jeton Firebase obligatoire)
// ============================================================
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer (.+)$/);
  if (!match) {
    return res.status(401).json({ error: "Jeton d'authentification manquant." });
  }
  try {
    req.user = await admin.auth().verifyIdToken(match[1]);
    next();
  } catch (e) {
    return res.status(401).json({ error: "Jeton d'authentification invalide." });
  }
}

// ============================================================
// GET /api/export — export RGPD (droit d'acces / portabilite)
// ============================================================
app.get("/api/export", requireAuth, async (req, res) => {
  const uid = req.user.uid;
  try {
    const out = {
      exportedAt: new Date().toISOString(),
      account: { uid, email: req.user.email || null },
      profile: null,
      swipes: [],
      matches: [],
    };

    const userSnap = await db.doc(`users/${uid}`).get();
    if (userSnap.exists) out.profile = userSnap.data();

    const swipesSnap = await db.collection(`users/${uid}/swipes`).get();
    swipesSnap.forEach((d) => out.swipes.push({ id: d.id, ...d.data() }));

    const matchesSnap = await db
      .collection("matches")
      .where("users", "array-contains", uid)
      .get();
    for (const m of matchesSnap.docs) {
      const match = { id: m.id, ...m.data(), messages: [] };
      const msgs = await db.collection(`matches/${m.id}/messages`).orderBy("at", "asc").get();
      msgs.forEach((mm) => match.messages.push({ id: mm.id, ...mm.data() }));
      out.matches.push(match);
    }

    res.set("Content-Type", "application/json");
    res.send(JSON.stringify(out, null, 2));
  } catch (e) {
    console.error("export error", e);
    res.status(500).json({ error: "Echec de l'export des donnees." });
  }
});

// ============================================================
// DELETE /api/account — suppression complete (droit a l'oubli)
// ============================================================
app.delete("/api/account", requireAuth, async (req, res) => {
  const uid = req.user.uid;
  try {
    // 1) Supprime les matchs de l'utilisateur (et leurs messages)
    const matchesSnap = await db
      .collection("matches")
      .where("users", "array-contains", uid)
      .get();
    for (const m of matchesSnap.docs) {
      await db.recursiveDelete(m.ref);
    }

    // 2) Supprime le document utilisateur + sa sous-collection swipes
    //    (les photos sont stockees en base64 dans le document : rien d'autre a nettoyer)
    await db.recursiveDelete(db.doc(`users/${uid}`));

    // 3) Supprime le compte Auth
    await admin.auth().deleteUser(uid);

    res.json({ deleted: true });
  } catch (e) {
    console.error("delete account error", e);
    res.status(500).json({ error: "Echec de la suppression du compte." });
  }
});

// ============================================================
// POST /api/report — signalement + blocage
// body : { reported: <uid>, reason: <string> }
// ============================================================
app.post("/api/report", requireAuth, async (req, res) => {
  const uid = req.user.uid;
  const { reported, reason } = req.body || {};

  if (typeof reported !== "string" || !reported || reported === uid) {
    return res.status(400).json({ error: "Utilisateur signale invalide." });
  }
  if (!VALID_REPORT_REASONS.includes(reason)) {
    return res.status(400).json({ error: "Motif de signalement invalide." });
  }

  try {
    const illegal = ILLEGAL_REPORT_REASONS.includes(reason);
    await db.collection("reports").add({
      reporter: uid,
      reported,
      reason,
      illegal,
      priority: illegal ? "urgent" : "normal",
      status: "pending",
      at: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Ajoute le signale a la liste de blocage du signaleur
    await db.doc(`users/${uid}`).update({
      blocked: admin.firestore.FieldValue.arrayUnion(reported),
    });

    res.json({ ok: true, blocked: reported });
  } catch (e) {
    console.error("report error", e);
    res.status(500).json({ error: "Echec de l'enregistrement du signalement." });
  }
});

// ============================================================
// Demarrage
// ============================================================
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`bille-backend en ecoute sur le port ${port}`);
});
