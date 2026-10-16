import crypto from "crypto";
import db from "../db.js";
import { HttpError } from "../utils/http.js";
import { hoursUntil, slotInstant, toMinutes, fromMinutes } from "../utils/time.js";

const SELECT = `
  SELECT a.id, a.code, a.status, a.client_notes, a.consent, a.created_at, a.cancelled_at, a.cancelled_by, a.cancel_reason,
         s.id AS slot_id, s.date, s.start_time, s.end_time,
         l.id AS location_id, l.kind AS location_kind, l.name AS location_name, l.detail AS location_detail,
         p.user_id AS professional_id, pu.name AS professional_name, p.headline AS professional_headline,
         p.office_address, p.office_city, CASE WHEN p.session_price_cents IS NULL THEN NULL ELSE p.session_price_cents / 100.0 END AS session_price,
         c.id AS client_id, c.name AS client_name, c.email AS client_email, c.phone AS client_phone
  FROM appointments a
  JOIN slots s ON s.id = a.slot_id
  JOIN professionals p ON p.user_id = a.professional_id
  JOIN users pu ON pu.id = p.user_id
  JOIN users c ON c.id = a.client_id
  LEFT JOIN locations l ON l.id = a.location_id
`;

export const findAppointment = (id) => db.prepare(`${SELECT} WHERE a.id = ?`).get(id);
export const findAppointmentByCode = (code) => db.prepare(`${SELECT} WHERE a.code = ?`).get(code);

export function listAppointments({ professionalId, clientId, status, from, to }) {
  const where = [];
  const params = [];
  if (professionalId) (where.push("a.professional_id = ?"), params.push(professionalId));
  if (clientId) (where.push("a.client_id = ?"), params.push(clientId));
  if (status) (where.push("a.status = ?"), params.push(status));
  if (from) (where.push("s.date >= ?"), params.push(from));
  if (to) (where.push("s.date <= ?"), params.push(to));
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return db.prepare(`${SELECT} ${clause} ORDER BY s.date, s.start_time`).all(...params);
}

function newCode() {
  for (;;) {
    const code = `AG-${crypto.randomInt(100000, 999999)}`;
    if (!db.prepare("SELECT 1 FROM appointments WHERE code = ?").get(code)) return code;
  }
}

// Encontra ou cria o cliente pelo e-mail. Quem agenda sem conta fica com senha em branco
// (pode defini-la depois em POST /api/auth/register).
export function findOrCreateClient({ name, email, phone }) {
  const existing = db.prepare("SELECT id, role FROM users WHERE email = ?").get(email);
  if (existing) {
    if (existing.role !== "client") throw new HttpError(409, "Este e-mail pertence a uma conta profissional e não pode ser usado para agendar.");
    if (phone) db.prepare("UPDATE users SET phone = COALESCE(phone, ?) WHERE id = ?").run(phone, existing.id);
    return existing.id;
  }
  return db
    .prepare("INSERT INTO users (name, email, phone, role) VALUES (?, ?, ?, 'client')")
    .run(name, email, phone || null).lastInsertRowid;
}

function assertBookable(slot, rules, { enforceNotice }) {
  if (!slot || slot.status !== "open") throw new HttpError(409, "Este horário não está mais disponível. Escolha outro horário.");
  if (!rules.accepting_bookings && enforceNotice) throw new HttpError(409, "A agenda está pausada no momento. Tente novamente mais tarde.");
  if (slotInstant(slot.date, slot.start_time) <= new Date()) throw new HttpError(409, "Este horário já passou. Escolha outro horário.");
  if (enforceNotice && hoursUntil(slot.date, slot.start_time) < rules.min_notice_hours)
    throw new HttpError(409, `Só é possível agendar com pelo menos ${rules.min_notice_hours} horas de antecedência.`);
}

const getRules = (professionalId) =>
  db.prepare("SELECT accepting_bookings, min_notice_hours, cancel_limit_hours FROM professionals WHERE user_id = ?").get(professionalId);

// `byProfessional` ignora antecedência mínima e agenda pausada (a própria profissional marcando).
export const bookSlot = db.transaction(({ slotId, clientId, notes, consent, professionalId, byProfessional = false }) => {
  const slot = db.prepare("SELECT * FROM slots WHERE id = ?").get(slotId);
  if (!slot || (professionalId && slot.professional_id !== professionalId)) throw new HttpError(404, "Horário não encontrado");
  assertBookable(slot, getRules(slot.professional_id), { enforceNotice: !byProfessional });

  const taken = db.prepare("UPDATE slots SET status = 'booked' WHERE id = ? AND status = 'open'").run(slotId);
  if (taken.changes === 0) throw new HttpError(409, "Este horário não está mais disponível. Escolha outro horário.");

  const id = db
    .prepare(
      `INSERT INTO appointments (code, slot_id, professional_id, client_id, location_id, client_notes, consent, price_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT session_price_cents FROM professionals WHERE user_id = ?))`,
    )
    .run(newCode(), slotId, slot.professional_id, clientId, slot.location_id, notes || null, consent ? 1 : 0, slot.professional_id).lastInsertRowid;
  return findAppointment(id);
});

// actor: 'client' respeita o prazo de cancelamento; 'professional' pode cancelar sempre.
export const cancelAppointment = db.transaction((appt, actor, reason) => {
  if (appt.status !== "confirmed") throw new HttpError(409, "Esta consulta não pode mais ser cancelada.");
  if (actor === "client") {
    const { cancel_limit_hours } = getRules(appt.professional_id);
    if (hoursUntil(appt.date, appt.start_time) < cancel_limit_hours)
      throw new HttpError(409, `Não é possível cancelar com menos de ${cancel_limit_hours} horas de antecedência. Entre em contato com a profissional.`);
  }
  db.prepare(
    "UPDATE appointments SET status = 'cancelled', cancelled_at = datetime('now'), cancelled_by = ?, cancel_reason = ? WHERE id = ?",
  ).run(actor, reason || null, appt.id);
  db.prepare("UPDATE slots SET status = 'open' WHERE id = ?").run(appt.slot_id);
  return findAppointment(appt.id);
});

export const rescheduleAppointment = db.transaction((appt, newSlotId, actor) => {
  if (appt.status !== "confirmed") throw new HttpError(409, "Esta consulta não pode mais ser remarcada.");
  const rules = getRules(appt.professional_id);
  if (actor === "client" && hoursUntil(appt.date, appt.start_time) < rules.cancel_limit_hours)
    throw new HttpError(409, `Não é possível remarcar com menos de ${rules.cancel_limit_hours} horas de antecedência. Entre em contato com a profissional.`);

  const slot = db.prepare("SELECT * FROM slots WHERE id = ?").get(newSlotId);
  if (!slot || slot.professional_id !== appt.professional_id) throw new HttpError(404, "Horário não encontrado");
  assertBookable(slot, rules, { enforceNotice: actor === "client" });

  if (db.prepare("UPDATE slots SET status = 'booked' WHERE id = ? AND status = 'open'").run(newSlotId).changes === 0)
    throw new HttpError(409, "Este horário não está mais disponível. Escolha outro horário.");
  db.prepare("UPDATE slots SET status = 'open' WHERE id = ?").run(appt.slot_id);
  db.prepare("UPDATE appointments SET slot_id = ?, location_id = ? WHERE id = ?").run(newSlotId, slot.location_id, appt.id);
  return findAppointment(appt.id);
});

export function buildIcs(a) {
  const stamp = (d, t) => `${d.replaceAll("-", "")}T${t.replace(":", "")}00`;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Agenda//PT-BR//",
    "BEGIN:VEVENT",
    `UID:${a.code}@agenda`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]|\.\d{3}/g, "")}`,
    `DTSTART;TZID=America/Sao_Paulo:${stamp(a.date, a.start_time)}`,
    `DTEND;TZID=America/Sao_Paulo:${stamp(a.date, a.end_time)}`,
    `SUMMARY:Consulta com ${a.professional_name}`,
    `LOCATION:${a.location_kind === "in_person" && (a.office_address || a.office_city) ? [a.office_address, a.office_city].filter(Boolean).join(", ") : `${a.location_name || ""}${a.location_detail ? ` - ${a.location_detail}` : ""}`}`,
    `DESCRIPTION:Código do agendamento ${a.code}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.join("\r\n");
}

export { toMinutes, fromMinutes };
