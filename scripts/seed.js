// Cria os usuários de teste e a configuração inicial da profissional. Idempotente.
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import db, { initializeDatabase } from "../src/db.js";

dotenv.config();
initializeDatabase();
const hash = bcrypt.hashSync("123456", 10);

db.transaction(() => {
  db.prepare(`INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'professional')
              ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash`)
    .run("Ana Beatriz Lima", "profissional@exemplo.com", hash);
  const prof = db.prepare("SELECT id FROM users WHERE email = ?").get("profissional@exemplo.com");
  db.prepare(`INSERT OR IGNORE INTO professionals (user_id, slug, headline, bio) VALUES (?, 'ana-beatriz-lima', ?, ?)`)
    .run(prof.id, "Terapeuta · Atendimento individual", "Um espaço de escuta e acolhimento.");
  if (!db.prepare("SELECT 1 FROM locations WHERE professional_id = ?").get(prof.id)) {
    const ins = db.prepare("INSERT INTO locations (professional_id, kind, name, detail, is_default) VALUES (?, ?, ?, ?, ?)");
    ins.run(prof.id, "online", "Online", "Google Meet", 1);
    ins.run(prof.id, "in_person", "Consultório", "Sala 204", 0);
  }
  db.prepare(`INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'client')
              ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash`)
    .run("Carla Mendes", "cliente@exemplo.com", hash);
})();

console.log("Seed concluído: profissional@exemplo.com (profissional) e cliente@exemplo.com (cliente), senha 123456");
