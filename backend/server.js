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
const vision = require("@google-cloud/vision");

// Sur Cloud Run, les identifiants proviennent du compte de service
// du service (Application Default Credentials). En local, definir
// GOOGLE_APPLICATION_CREDENTIALS vers un fichier de compte de service.
admin.initializeApp();
const db = admin.firestore();

// Client Google Vision (SafeSearch) — utilise les identifiants du service.
const visionClient = new vision.ImageAnnotatorClient();

// Stripe (verification d'identite) — initialise seulement si la cle est presente,
// pour que le service demarre normalement tant que Stripe n'est pas configure.
const stripe = process.env.STRIPE_SECRET_KEY
  ? require("stripe")(process.env.STRIPE_SECRET_KEY)
  : null;

// Controle d'age strict : si true, une verification sans date de naissance
// (dob) ne donne PAS le badge. Defaut false (souple) pour ne pas bloquer les
// vrais utilisateurs tant que l'acces a la dob n'est pas confirme cote Stripe.
const STRICT_AGE = process.env.STRICT_AGE === "true";

// Calcule l'age (annees) a partir d'une date de naissance Stripe { day, month, year }.
function ageFromDob(dob) {
  const today = new Date();
  let age = today.getFullYear() - dob.year;
  const monthDiff = today.getMonth() + 1 - dob.month;
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.day)) age--;
  return age;
}

const app = express();

// Webhook Stripe : la verification de signature exige le corps BRUT, donc
// cette route est declaree AVANT le parseur JSON global.
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).end();
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (e) {
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }
  try {
    const obj = event.data.object || {};
    const uid = obj.metadata && obj.metadata.uid;
    if (uid && event.type === "identity.verification_session.verified") {
      // Controle d'age : on relit la date de naissance verifiee par Stripe.
      // On ne stocke JAMAIS la piece d'identite ni la date de naissance :
      // uniquement le resultat (verifie) et l'age valide (entier).
      let age = null;
      try {
        const vs = await stripe.identity.verificationSessions.retrieve(obj.id, {
          expand: ["verified_outputs"],
        });
        const dob = vs.verified_outputs && vs.verified_outputs.dob;
        if (dob && dob.year) age = ageFromDob(dob);
      } catch (e) {
        console.error("verified_outputs retrieve error", e);
      }

      if (age === null && STRICT_AGE) {
        // STRICT : sans date de naissance verifiee, on ne valide pas.
        await db.doc(`users/${uid}`).update({
          identityVerified: false,
          ageVerified: false,
        });
        await notifyUser(uid, {
          type: "identity_needs_action",
          note: "Ta date de naissance n'a pas pu etre confirmee. Relance la verification depuis ton profil.",
        }).catch(() => {});
      } else if (age === null) {
        // SOUPLE (defaut) : identite confirmee, age non garanti par Stripe
        // (le 18+ reste couvert par la declaration a l'inscription).
        await db.doc(`users/${uid}`).update({
          identityVerified: true,
          ageVerified: false,
          identityReviewedAt: admin.firestore.FieldValue.serverTimestamp(),
          identityReviewedBy: "stripe-identity",
        });
        await notifyUser(uid, { type: "identity_verified" }).catch(() => {});
      } else if (age < 18) {
        // Mineur : refus automatique + retrait de la decouverte. Aucune DOB stockee.
        await db.doc(`users/${uid}`).update({
          identityVerified: false,
          ageVerified: false,
          underage: true,
          "visibility.discoverable": false,
        });
        await notifyUser(uid, {
          type: "identity_rejected",
          note: "Acces reserve aux 18 ans et plus : ton compte a ete restreint.",
        }).catch(() => {});
      } else {
        // Identite + age (>=18) confirmes. On ne stocke que le resultat + l'age.
        await db.doc(`users/${uid}`).update({
          identityVerified: true,
          ageVerified: true,
          age,
          identityReviewedAt: admin.firestore.FieldValue.serverTimestamp(),
          identityReviewedBy: "stripe-identity",
        });
        await notifyUser(uid, { type: "identity_verified" }).catch(() => {});
      }
    } else if (
      uid &&
      (event.type === "identity.verification_session.requires_input" ||
        event.type === "identity.verification_session.canceled")
    ) {
      // Verification echouee / a refaire : on previent l'utilisateur.
      await notifyUser(uid, {
        type: "identity_needs_action",
        note: "Ta verification n'a pas abouti. Tu peux la relancer depuis ton profil.",
      }).catch(() => {});
    }
  } catch (e) {
    console.error("stripe webhook handling error", e);
  }
  res.json({ received: true });
});

// Les photos arrivent en base64 (data URI) : on releve la limite de corps.
app.use(express.json({ limit: "8mb" }));

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
// Notification de moderation adressee a un utilisateur (boite in-app).
// Ecrite par le backend (Admin SDK) ; l'utilisateur peut seulement lire /
// marquer comme lue (voir regles Firestore).
// ============================================================
async function notifyUser(uid, { type, reason, note }) {
  await db.collection(`users/${uid}/notifications`).add({
    type: type || "info",
    reason: reason || null,
    note: note || null,
    read: false,
    at: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// ============================================================
// Suppression complete d'un utilisateur (droit a l'oubli / moderation)
// Nettoie : matchs + messages, ses swipes envoyes, les swipes RECUS
// (les like/pass des autres qui le ciblent), le document, le compte Auth.
// ============================================================
async function deleteUserCompletely(uid) {
  // 1) Matchs de l'utilisateur (et leurs messages)
  const matchesSnap = await db
    .collection("matches")
    .where("users", "array-contains", uid)
    .get();
  for (const m of matchesSnap.docs) {
    await db.recursiveDelete(m.ref);
  }

  // 2) Likes/pass RECUS : swipes des autres utilisateurs qui ciblent cet uid.
  //    (Le champ `target` est ecrit cote client pour permettre cette requete.)
  const receivedSnap = await db
    .collectionGroup("swipes")
    .where("target", "==", uid)
    .get();
  for (const s of receivedSnap.docs) {
    await s.ref.delete();
  }

  // 3) Document utilisateur + sa sous-collection swipes (likes ENVOYES).
  //    Les photos sont en base64 dans le document : rien d'autre a nettoyer.
  await db.recursiveDelete(db.doc(`users/${uid}`));

  // 4) Compte Auth
  await admin.auth().deleteUser(uid).catch((e) => {
    // Si le compte Auth n'existe deja plus, on ignore.
    if (e.code !== "auth/user-not-found") throw e;
  });
}

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

// Reserve aux administrateurs (custom claim { admin: true } sur le compte Firebase).
function requireAdmin(req, res, next) {
  if (!req.user || req.user.admin !== true) {
    return res.status(403).json({ error: "Acces reserve aux administrateurs." });
  }
  next();
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
  try {
    await deleteUserCompletely(req.user.uid);
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
// POST /api/photos/check — moderation d'une photo de profil (Google Vision)
// Bloque la nudite explicite (SafeSearch "adult" LIKELY/VERY_LIKELY). Le
// contenu suggestif (racy) reste autorise. Ne s'applique PAS au chat.
// body : { image: "data:image/...;base64,..." }  ->  { allowed, adult, racy }
// ============================================================
const BLOCK_LEVELS = ["LIKELY", "VERY_LIKELY"];
app.post("/api/photos/check", requireAuth, async (req, res) => {
  const image = req.body && req.body.image;
  if (typeof image !== "string" || !image) {
    return res.status(400).json({ error: "Image manquante." });
  }
  const base64 = image.includes(",") ? image.split(",")[1] : image;
  try {
    const [result] = await visionClient.safeSearchDetection({ image: { content: base64 } });
    const s = result.safeSearchAnnotation || {};
    const adult = s.adult || "UNKNOWN";
    const racy = s.racy || "UNKNOWN";
    const allowed = !BLOCK_LEVELS.includes(adult);
    res.json({ allowed, adult, racy, reason: allowed ? null : "nudite" });
  } catch (e) {
    console.error("vision check error", e);
    // Fail-open : si Vision est indisponible, on ne bloque pas l'upload
    // (l'admin reste le dernier recours pour retirer une photo).
    res.json({ allowed: true, error: "vision_unavailable" });
  }
});

// ============================================================
// POST /api/verify/start — demarre une verification d'identite Stripe Identity
// Cree une VerificationSession et renvoie l'URL du parcours hebergé par Stripe.
// Le resultat arrive via le webhook (identity.verification_session.verified),
// qui met identityVerified=true. Aucune piece d'identite n'est stockee chez nous.
// body : { returnUrl }
// ============================================================
app.post("/api/verify/start", requireAuth, async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ error: "Verification d'identite non configuree." });
  }
  try {
    const session = await stripe.identity.verificationSessions.create({
      type: "document",
      metadata: { uid: req.user.uid },
      options: { document: { require_matching_selfie: true, require_live_capture: true } },
      return_url: (req.body && req.body.returnUrl) || undefined,
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error("verify start error", e);
    res.status(500).json({ error: "Impossible de demarrer la verification." });
  }
});

// ============================================================
// GET /api/places/nearby?lat=&lng= — cafes/bars autour d'un point
// (le point median FLOUTE calcule cote client ; jamais une position exacte).
// Utilise Google Places (New) avec une cle serveur (PLACES_API_KEY).
// ============================================================
app.get("/api/places/nearby", requireAuth, async (req, res) => {
  if (!process.env.PLACES_API_KEY) {
    return res.status(503).json({ error: "Suggestions de lieux non configurees." });
  }
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (!isFinite(lat) || !isFinite(lng)) {
    return res.status(400).json({ error: "Coordonnees invalides." });
  }
  try {
    const r = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": process.env.PLACES_API_KEY,
        "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.id",
      },
      body: JSON.stringify({
        includedTypes: ["cafe", "bar"],
        maxResultCount: 3,
        locationRestriction: {
          circle: { center: { latitude: lat, longitude: lng }, radius: 1500 },
        },
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      console.error("places error", data);
      return res.status(502).json({ error: "Places indisponible." });
    }
    const venues = (data.places || []).slice(0, 3).map((p) => {
      const name = p.displayName ? p.displayName.text : "Lieu";
      return {
        name,
        address: p.formattedAddress || "",
        mapsUrl:
          "https://www.google.com/maps/search/?api=1&query=" +
          encodeURIComponent(name) +
          (p.id ? "&query_place_id=" + p.id : ""),
      };
    });
    res.json({ venues });
  } catch (e) {
    console.error("places fetch error", e);
    res.status(500).json({ error: "Erreur lors de la recherche de lieux." });
  }
});

// ============================================================
// ADMIN — moderation (reserve aux comptes admin)
// ============================================================

// Liste des comptes inscrits (resume)
app.get("/api/admin/users", requireAuth, requireAdmin, async (_req, res) => {
  try {
    const snap = await db.collection("users").orderBy("createdAt", "desc").limit(500).get();
    const users = snap.docs.map((d) => {
      const u = d.data();
      return {
        uid: d.id,
        pseudo: u.pseudo || "",
        gender: u.gender || "",
        seeking: u.seeking || "",
        birthdate: u.birthdate || null,
        photosCount: Array.isArray(u.photos) ? u.photos.length : 0,
        photo: Array.isArray(u.photos) && u.photos[0] ? u.photos[0].url : null,
        identityVerified: u.identityVerified === true,
        profileComplete: u.profileComplete === true,
        lookingNow: u.lookingNow === true,
        blockedCount: Array.isArray(u.blocked) ? u.blocked.length : 0,
        createdAt: u.createdAt && u.createdAt.toDate ? u.createdAt.toDate().toISOString() : null,
      };
    });
    res.json({ users });
  } catch (e) {
    console.error("admin list users error", e);
    res.status(500).json({ error: "Echec du chargement des comptes." });
  }
});

// Detail complet d'un compte (profil + email + photos)
app.get("/api/admin/users/:uid", requireAuth, requireAdmin, async (req, res) => {
  const uid = req.params.uid;
  try {
    const doc = await db.doc(`users/${uid}`).get();
    if (!doc.exists) return res.status(404).json({ error: "Compte introuvable." });
    let email = null;
    try {
      const authUser = await admin.auth().getUser(uid);
      email = authUser.email || null;
    } catch (_) {}
    res.json({ uid, email, profile: doc.data() });
  } catch (e) {
    console.error("admin get user error", e);
    res.status(500).json({ error: "Echec du chargement du compte." });
  }
});

// Suppression d'un compte par l'admin (nettoyage complet)
app.delete("/api/admin/users/:uid", requireAuth, requireAdmin, async (req, res) => {
  try {
    await deleteUserCompletely(req.params.uid);
    res.json({ deleted: true });
  } catch (e) {
    console.error("admin delete user error", e);
    res.status(500).json({ error: "Echec de la suppression du compte." });
  }
});

// Validation / refus de l'identite d'un compte (pilote le badge verifie)
app.patch("/api/admin/users/:uid/verify", requireAuth, requireAdmin, async (req, res) => {
  const verified = req.body && req.body.verified === true;
  const note = req.body && req.body.note;
  try {
    await db.doc(`users/${req.params.uid}`).update({
      identityVerified: verified,
      identityReviewedAt: admin.firestore.FieldValue.serverTimestamp(),
      identityReviewedBy: req.user.uid,
    });
    // Previent l'utilisateur du resultat
    await notifyUser(req.params.uid, {
      type: verified ? "identity_verified" : "identity_rejected",
      note: note || null,
    }).catch(() => {});
    res.json({ ok: true, identityVerified: verified });
  } catch (e) {
    console.error("admin verify error", e);
    res.status(500).json({ error: "Echec de la mise a jour de la verification." });
  }
});

// Suppression d'une photo precise d'un compte (moderation)
app.post("/api/admin/users/:uid/photos/delete", requireAuth, requireAdmin, async (req, res) => {
  const index = Number(req.body && req.body.index);
  try {
    const ref = db.doc(`users/${req.params.uid}`);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: "Compte introuvable." });
    const photos = Array.isArray(doc.data().photos) ? doc.data().photos.slice() : [];
    if (!Number.isInteger(index) || index < 0 || index >= photos.length) {
      return res.status(400).json({ error: "Index de photo invalide." });
    }
    photos.splice(index, 1);
    await ref.update({ photos });
    // Previent l'utilisateur du retrait de sa photo (avec raison eventuelle)
    await notifyUser(req.params.uid, {
      type: "photo_removed",
      reason: (req.body && req.body.reason) || null,
      note: (req.body && req.body.note) || null,
    }).catch(() => {});
    res.json({ ok: true, photos });
  } catch (e) {
    console.error("admin delete photo error", e);
    res.status(500).json({ error: "Echec de la suppression de la photo." });
  }
});

// Envoi d'un message de moderation (avertissement) a un utilisateur
app.post("/api/admin/users/:uid/notify", requireAuth, requireAdmin, async (req, res) => {
  const { type, reason, note } = req.body || {};
  try {
    await notifyUser(req.params.uid, { type: type || "warning", reason, note });
    res.json({ ok: true });
  } catch (e) {
    console.error("admin notify error", e);
    res.status(500).json({ error: "Echec de l'envoi du message." });
  }
});

// Liste des signalements (urgents en premier)
app.get("/api/admin/reports", requireAuth, requireAdmin, async (_req, res) => {
  try {
    const snap = await db.collection("reports").orderBy("at", "desc").limit(500).get();
    const reports = snap.docs.map((d) => {
      const r = d.data();
      return {
        id: d.id,
        reporter: r.reporter,
        reported: r.reported,
        reason: r.reason,
        illegal: r.illegal === true,
        priority: r.priority || "normal",
        status: r.status || "pending",
        at: r.at && r.at.toDate ? r.at.toDate().toISOString() : null,
      };
    });
    // urgents d'abord
    reports.sort((a, b) => (a.priority === "urgent" ? -1 : 1) - (b.priority === "urgent" ? -1 : 1));
    res.json({ reports });
  } catch (e) {
    console.error("admin reports error", e);
    res.status(500).json({ error: "Echec du chargement des signalements." });
  }
});

// ============================================================
// Demarrage
// ============================================================
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`bille-backend en ecoute sur le port ${port}`);
});
