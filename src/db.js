import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const file = process.env.DATABASE_FILE || "./data/agenda.db";
if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });

const db = new Database(file);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

export function initializeDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      phone TEXT,
      password_hash TEXT,
      role TEXT NOT NULL CHECK (role IN ('professional','client')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS login_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS professionals (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      slug TEXT NOT NULL UNIQUE,
      headline TEXT,
      bio TEXT,
      accepting_bookings INTEGER NOT NULL DEFAULT 1,
      min_notice_hours INTEGER NOT NULL DEFAULT 4,
      cancel_limit_hours INTEGER NOT NULL DEFAULT 4,
      session_minutes INTEGER NOT NULL DEFAULT 50
    );

    CREATE TABLE IF NOT EXISTS locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      professional_id INTEGER NOT NULL REFERENCES professionals(user_id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('online','in_person')),
      name TEXT NOT NULL,
      detail TEXT,
      is_default INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS availability_periods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      professional_id INTEGER NOT NULL REFERENCES professionals(user_id) ON DELETE CASCADE,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      weekdays TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      interval_minutes INTEGER NOT NULL,
      duration_minutes INTEGER NOT NULL,
      location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      professional_id INTEGER NOT NULL REFERENCES professionals(user_id) ON DELETE CASCADE,
      period_id INTEGER REFERENCES availability_periods(id) ON DELETE SET NULL,
      location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
      date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','blocked','booked')),
      UNIQUE (professional_id, date, start_time)
    );
    CREATE INDEX IF NOT EXISTS idx_slots_lookup ON slots (professional_id, date, status);

    CREATE TABLE IF NOT EXISTS appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      slot_id INTEGER NOT NULL REFERENCES slots(id),
      professional_id INTEGER NOT NULL REFERENCES professionals(user_id),
      client_id INTEGER NOT NULL REFERENCES users(id),
      location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','cancelled','completed','no_show')),
      client_notes TEXT,
      consent INTEGER NOT NULL DEFAULT 0,
      cancelled_at TEXT,
      cancelled_by TEXT,
      cancel_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_per_slot ON appointments (slot_id) WHERE status = 'confirmed';
    CREATE INDEX IF NOT EXISTS idx_appt_client ON appointments (client_id);
    CREATE INDEX IF NOT EXISTS idx_appt_prof ON appointments (professional_id);
  `);

  // Migrações simples para bancos já existentes.
  const cols = db.prepare("PRAGMA table_info(professionals)").all().map((c) => c.name);
  if (!cols.includes("office_address")) db.exec("ALTER TABLE professionals ADD COLUMN office_address TEXT");
  if (!cols.includes("office_city")) db.exec("ALTER TABLE professionals ADD COLUMN office_city TEXT");
  if (!cols.includes("session_price_cents")) db.exec("ALTER TABLE professionals ADD COLUMN session_price_cents INTEGER");
  const apptCols = db.prepare("PRAGMA table_info(appointments)").all().map((c) => c.name);
  if (!apptCols.includes("price_cents")) {
    db.exec(`ALTER TABLE appointments ADD COLUMN price_cents INTEGER;
             ALTER TABLE appointments ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'pending';
             ALTER TABLE appointments ADD COLUMN payment_method TEXT;
             ALTER TABLE appointments ADD COLUMN paid_cents INTEGER;
             ALTER TABLE appointments ADD COLUMN paid_at TEXT;`);
    // Consultas já existentes passam a usar o valor atual da profissional.
    db.exec("UPDATE appointments SET price_cents = (SELECT session_price_cents FROM professionals p WHERE p.user_id = appointments.professional_id)");
  }
  db.exec(`CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    professional_id INTEGER NOT NULL REFERENCES professionals(user_id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'outros',
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    date TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_expenses_prof_date ON expenses (professional_id, date);`);
}

export default db;
