// ============================================================
// Donne (ou retire) le role admin a un compte Firebase.
// Le role est un "custom claim" { admin: true } sur le compte Auth ;
// le backend le verifie pour autoriser les routes /api/admin/*.
//
// Usage (depuis backend/, avec des identifiants Admin dispo — Cloud Shell
// ou GOOGLE_APPLICATION_CREDENTIALS defini) :
//   node scripts/set-admin.js merickoken54@gmail.com          # accorde
//   node scripts/set-admin.js merickoken54@gmail.com --remove # retire
//
// L'utilisateur devra se reconnecter (ou rafraichir son jeton) pour que
// le claim prenne effet.
// ============================================================

const admin = require("firebase-admin");
admin.initializeApp();

const email = process.argv[2];
const remove = process.argv.includes("--remove");

if (!email) {
  console.error("Usage: node scripts/set-admin.js <email> [--remove]");
  process.exit(1);
}

(async () => {
  try {
    const user = await admin.auth().getUserByEmail(email);
    await admin.auth().setCustomUserClaims(user.uid, remove ? {} : { admin: true });
    console.log(
      `${remove ? "Role admin retire de" : "Role admin accorde a"} ${email} (uid ${user.uid}).`
    );
    console.log("L'utilisateur doit se reconnecter pour que le changement prenne effet.");
    process.exit(0);
  } catch (e) {
    console.error("Erreur:", e.message);
    process.exit(1);
  }
})();
