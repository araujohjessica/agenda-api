// Cria (ou atualiza a senha d)a profissional em produção. Sem dados de teste.
// Uso: PRO_NAME="Ana Beatriz Lima" PRO_EMAIL=... PRO_PASSWORD=... node scripts/create-professional.js
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import db, { initializeDatabase } from "../src/db.js";

dotenv.config();
initializeDatabase();
const { PRO_NAME, PRO_EMAIL, PRO_PASSWORD } = process.env;
if (!PRO_NAME || !PRO_EMAIL || !PRO_PASSWORD || PRO_PASSWORD.length < 8) {
  console.error("Informe PRO_NAME, PRO_EMAIL e PRO_PASSWORD (mínimo 8 caracteres).");
  process.exit(1);
}
const hash = bcrypt.hashSync(PRO_PASSWORD, 12);
db.transaction(() => {
  db.prepare(`INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'professional')
              ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash, name = excluded.name`)
    .run(PRO_NAME, PRO_EMAIL.toLowerCase(), hash);
  const prof = db.prepare("SELECT id FROM users WHERE email = ?").get(PRO_EMAIL.toLowerCase());
  db.prepare(`INSERT OR IGNORE INTO professionals (user_id, slug, headline, bio) VALUES (?, 'ana-beatriz-lima', ?, ?)`)
    .run(prof.id, "Terapeuta · Atendimento individual", "Um espaço de escuta e acolhimento.");
  if (!db.prepare("SELECT 1 FROM locations WHERE professional_id = ?").get(prof.id)) {
    const ins = db.prepare("INSERT INTO locations (professional_id, kind, name, detail, is_default) VALUES (?, ?, ?, ?, ?)");
    ins.run(prof.id, "online", "Online", "Google Meet", 1);
  }
})();
console.log(`Profissional pronta: ${PRO_EMAIL}`);
