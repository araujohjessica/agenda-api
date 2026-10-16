// Cópia consistente do banco (API de backup do SQLite, segura com a API rodando).
// Uso: node scripts/backup.js [pasta-destino] [dias]  (mantém os últimos N dias e sempre os 5 mais recentes)
import Database from "better-sqlite3";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();
const source = path.resolve(process.env.DATABASE_FILE || "./data/agenda.db");
const dir = path.resolve(process.argv[2] || "./backups");
const days = Number(process.argv[3]) || 14;
fs.mkdirSync(dir, { recursive: true });

const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
const file = path.join(dir, `agenda-${stamp}.db`);
await new Database(source, { readonly: true }).backup(file);
fs.chmodSync(file, 0o600);

const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
const old = fs.readdirSync(dir).filter((f) => /^agenda-\d{4}-\d{2}-\d{2}-.*\.db$/.test(f)).sort().slice(0, -5).filter((f) => f.slice(7, 17) < cutoff);
old.forEach((f) => fs.unlinkSync(path.join(dir, f)));
console.log(`backup: ${file} (removidos ${old.length} antigos)`);
