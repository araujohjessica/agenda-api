import { Router } from "express";
import Joi from "joi";
import db from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { HttpError, validate, wrap } from "../utils/http.js";
import { eachDate, fromMinutes, slotInstant, toISODate, toMinutes, todayBrasilia } from "../utils/time.js";
import financeRoutes from "./finance.js";
import { fireAndForget, notifyBooked } from "../services/notifications.js";
import { bookSlot, findAppointment, findOrCreateClient, listAppointments } from "../services/appointments.js";

const router = Router();
router.use(requireAuth, requireRole("professional"));
router.use("/finance", financeRoutes);

const date = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/);
const time = Joi.string().pattern(/^([01]\d|2[0-3]):[0-5]\d$/);

// ---------- Configurações e regras ----------
const profileOf = (id) => {
  const p = db.prepare("SELECT slug, headline, bio, accepting_bookings, min_notice_hours, cancel_limit_hours, session_minutes, office_address, office_city, session_price_cents FROM professionals WHERE user_id = ?").get(id);
  const { session_price_cents, ...rest } = p;
  return { ...rest, accepting_bookings: !!p.accepting_bookings, session_price: session_price_cents == null ? null : session_price_cents / 100 };
};

router.get("/settings", wrap((req, res) => res.json(profileOf(req.user.id))));

router.put("/settings", wrap((req, res) => {
  const b = validate(
    Joi.object({
      slug: Joi.string().lowercase().pattern(/^[a-z0-9-]{3,60}$/),
      headline: Joi.string().trim().max(200).allow("", null),
      bio: Joi.string().trim().max(2000).allow("", null),
      accepting_bookings: Joi.boolean(),
      min_notice_hours: Joi.number().integer().min(0).max(720),
      cancel_limit_hours: Joi.number().integer().min(0).max(720),
      session_minutes: Joi.number().integer().min(10).max(480),
      office_address: Joi.string().trim().max(300).allow("", null),
      office_city: Joi.string().trim().max(100).allow("", null),
      session_price: Joi.number().min(0).max(100000).precision(2).allow(null),
    }).min(1),
    req.body,
  );
  const cur = db.prepare("SELECT * FROM professionals WHERE user_id = ?").get(req.user.id);
  const next = {
    ...cur, ...b,
    accepting_bookings: "accepting_bookings" in b ? +b.accepting_bookings : cur.accepting_bookings,
    office_address: "office_address" in b ? b.office_address || null : cur.office_address,
    office_city: "office_city" in b ? b.office_city || null : cur.office_city,
    session_price_cents: "session_price" in b ? (b.session_price == null ? null : Math.round(b.session_price * 100)) : cur.session_price_cents,
  };
  if (b.slug && b.slug !== cur.slug && db.prepare("SELECT 1 FROM professionals WHERE slug = ?").get(b.slug))
    throw new HttpError(409, "Este endereço já está em uso por outra agenda.");
  db.prepare(`UPDATE professionals SET slug=?, headline=?, bio=?, accepting_bookings=?, min_notice_hours=?, cancel_limit_hours=?, session_minutes=?, office_address=?, office_city=?, session_price_cents=? WHERE user_id=?`)
    .run(next.slug, next.headline, next.bio, next.accepting_bookings, next.min_notice_hours, next.cancel_limit_hours, next.session_minutes, next.office_address, next.office_city, next.session_price_cents, req.user.id);
  res.json(profileOf(req.user.id));
}));

// ---------- Locais ----------
const locationSchema = Joi.object({
  kind: Joi.string().valid("online", "in_person").required(),
  name: Joi.string().trim().min(2).max(80).required(),
  detail: Joi.string().trim().max(200).allow("", null),
  is_default: Joi.boolean(),
});

const ownLocation = (req) => {
  const l = db.prepare("SELECT * FROM locations WHERE id = ? AND professional_id = ?").get(req.params.id, req.user.id);
  if (!l) throw new HttpError(404, "Local não encontrado");
  return l;
};

router.get("/locations", wrap((req, res) =>
  res.json(db.prepare("SELECT id, kind, name, detail, is_default, active FROM locations WHERE professional_id = ? ORDER BY active DESC, is_default DESC, id").all(req.user.id))));

router.post("/locations", wrap((req, res) => {
  const b = validate(locationSchema, req.body);
  const first = !db.prepare("SELECT 1 FROM locations WHERE professional_id = ? AND active = 1").get(req.user.id);
  const makeDefault = b.is_default || first;
  const id = db.transaction(() => {
    if (makeDefault) db.prepare("UPDATE locations SET is_default = 0 WHERE professional_id = ?").run(req.user.id);
    return db.prepare("INSERT INTO locations (professional_id, kind, name, detail, is_default) VALUES (?, ?, ?, ?, ?)")
      .run(req.user.id, b.kind, b.name, b.detail || null, makeDefault ? 1 : 0).lastInsertRowid;
  })();
  res.status(201).json(db.prepare("SELECT * FROM locations WHERE id = ?").get(id));
}));

router.put("/locations/:id", wrap((req, res) => {
  const cur = ownLocation(req);
  const b = validate(locationSchema.fork(["kind", "name"], (s) => s.optional()).keys({ active: Joi.boolean() }).min(1), req.body);
  db.transaction(() => {
    if (b.is_default) db.prepare("UPDATE locations SET is_default = 0 WHERE professional_id = ?").run(req.user.id);
    db.prepare("UPDATE locations SET kind=?, name=?, detail=?, is_default=?, active=? WHERE id=?").run(
      b.kind ?? cur.kind, b.name ?? cur.name, "detail" in b ? b.detail || null : cur.detail,
      "is_default" in b ? +b.is_default : cur.is_default, "active" in b ? +b.active : cur.active, cur.id);
  })();
  res.json(db.prepare("SELECT * FROM locations WHERE id = ?").get(cur.id));
}));

router.delete("/locations/:id", wrap((req, res) => {
  const l = ownLocation(req);
  const used = db.prepare("SELECT 1 FROM appointments WHERE location_id = ? LIMIT 1").get(l.id);
  if (used) {
    db.prepare("UPDATE locations SET active = 0, is_default = 0 WHERE id = ?").run(l.id);
    return res.json({ message: "Local desativado (possui agendamentos no histórico)", deactivated: true });
  }
  db.prepare("DELETE FROM locations WHERE id = ?").run(l.id);
  res.json({ message: "Local removido", deactivated: false });
}));

// ---------- Períodos (geram horários automaticamente) ----------
const periodSchema = Joi.object({
  start_date: date.required(),
  end_date: date.required(),
  weekdays: Joi.array().items(Joi.number().integer().min(0).max(6)).min(1).unique().required(), // 0=domingo ... 6=sábado
  start_time: time.required(),
  end_time: time.required(),
  interval_minutes: Joi.number().integer().min(10).max(480).required(),
  duration_minutes: Joi.number().integer().min(10).max(480),
  location_id: Joi.number().integer(),
});

router.get("/periods", wrap((req, res) => {
  const rows = db.prepare(`
    SELECT p.*, (SELECT COUNT(*) FROM slots s WHERE s.period_id = p.id) AS slots_total,
                (SELECT COUNT(*) FROM slots s WHERE s.period_id = p.id AND s.status = 'booked') AS slots_booked
    FROM availability_periods p WHERE p.professional_id = ? ORDER BY p.start_date DESC, p.id DESC`).all(req.user.id);
  res.json(rows.map((r) => ({ ...r, weekdays: JSON.parse(r.weekdays) })));
}));

router.post("/periods", wrap((req, res) => {
  const b = validate(periodSchema, req.body);
  if (b.end_date < b.start_date) throw new HttpError(400, "A data final deve ser igual ou posterior à data inicial.");
  if (b.start_time >= b.end_time) throw new HttpError(400, "O horário final deve ser depois do horário inicial.");
  if ((new Date(b.end_date) - new Date(b.start_date)) / 86_400_000 > 366) throw new HttpError(400, "O período pode ter no máximo 1 ano.");

  const prof = profileOf(req.user.id);
  const duration = b.duration_minutes ?? prof.session_minutes;
  const location = b.location_id
    ? db.prepare("SELECT id FROM locations WHERE id = ? AND professional_id = ? AND active = 1").get(b.location_id, req.user.id)
    : db.prepare("SELECT id FROM locations WHERE professional_id = ? AND active = 1 ORDER BY is_default DESC, id LIMIT 1").get(req.user.id);
  if (!location) throw new HttpError(400, b.location_id ? "Escolha um local válido." : "Cadastre um local antes de criar períodos.");

  const result = db.transaction(() => {
    const periodId = db.prepare(`INSERT INTO availability_periods
      (professional_id, start_date, end_date, weekdays, start_time, end_time, interval_minutes, duration_minutes, location_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.user.id, b.start_date, b.end_date, JSON.stringify(b.weekdays), b.start_time, b.end_time, b.interval_minutes, duration, location.id).lastInsertRowid;
    const insert = db.prepare(`INSERT OR IGNORE INTO slots (professional_id, period_id, location_id, date, start_time, end_time)
      VALUES (?, ?, ?, ?, ?, ?)`);
    let created = 0, skipped = 0;
    for (const { date: d, weekday } of eachDate(b.start_date, b.end_date)) {
      if (!b.weekdays.includes(weekday)) continue;
      for (let t = toMinutes(b.start_time); t + duration <= toMinutes(b.end_time); t += b.interval_minutes) {
        const start = fromMinutes(t);
        if (slotInstant(d, start) <= new Date()) { skipped++; continue; }
        insert.run(req.user.id, periodId, location.id, d, start, fromMinutes(t + duration)).changes ? created++ : skipped++;
      }
    }
    return { periodId, created, skipped };
  })();
  if (result.created === 0) {
    db.prepare("DELETE FROM availability_periods WHERE id = ?").run(result.periodId);
    throw new HttpError(409, "Nenhum horário novo foi criado: os horários desse período já existem ou já passaram.");
  }
  res.status(201).json({ id: result.periodId, slots_created: result.created, slots_skipped: result.skipped });
}));

// Remove o período e os horários ainda livres; horários com consulta são preservados.
router.delete("/periods/:id", wrap((req, res) => {
  const p = db.prepare("SELECT id FROM availability_periods WHERE id = ? AND professional_id = ?").get(req.params.id, req.user.id);
  if (!p) throw new HttpError(404, "Período não encontrado");
  const removed = db.transaction(() => {
    const noHistory = "NOT EXISTS (SELECT 1 FROM appointments a WHERE a.slot_id = slots.id)";
    const n = db.prepare(`DELETE FROM slots WHERE period_id = ? AND status != 'booked' AND ${noHistory}`).run(p.id).changes;
    // Horários livres que já tiveram consulta (cancelada) ficam bloqueados para preservar o histórico.
    db.prepare("UPDATE slots SET status = 'blocked' WHERE period_id = ? AND status = 'open'").run(p.id);
    db.prepare("DELETE FROM availability_periods WHERE id = ?").run(p.id);
    return n;
  })();
  res.json({ message: "Período removido", slots_removed: removed });
}));

// ---------- Horários avulsos ----------
router.get("/slots", wrap((req, res) => {
  const q = validate(Joi.object({ from: date.required(), to: date.required(), status: Joi.string().valid("open", "blocked", "booked") }), req.query);
  const rows = db.prepare(`
    SELECT s.id, s.date, s.start_time, s.end_time, s.status, s.period_id, l.id AS location_id, l.name AS location_name,
           a.id AS appointment_id, a.code AS appointment_code, c.name AS client_name
    FROM slots s LEFT JOIN locations l ON l.id = s.location_id
    LEFT JOIN appointments a ON a.slot_id = s.id AND a.status = 'confirmed'
    LEFT JOIN users c ON c.id = a.client_id
    WHERE s.professional_id = ? AND s.date BETWEEN ? AND ? AND (? IS NULL OR s.status = ?)
    ORDER BY s.date, s.start_time`).all(req.user.id, q.from, q.to, q.status ?? null, q.status ?? null);
  res.json(rows);
}));

router.post("/slots", wrap((req, res) => {
  const b = validate(Joi.object({ date: date.required(), start_time: time.required(), end_time: time, location_id: Joi.number().integer() }), req.body);
  const prof = profileOf(req.user.id);
  const end = b.end_time ?? fromMinutes(toMinutes(b.start_time) + prof.session_minutes);
  if (end <= b.start_time) throw new HttpError(400, "O horário final deve ser depois do horário inicial.");
  if (slotInstant(b.date, b.start_time) <= new Date()) throw new HttpError(400, "Não é possível criar horários em datas ou horas que já passaram.");
  const loc = b.location_id
    ? db.prepare("SELECT id FROM locations WHERE id = ? AND professional_id = ? AND active = 1").get(b.location_id, req.user.id)
    : db.prepare("SELECT id FROM locations WHERE professional_id = ? AND active = 1 ORDER BY is_default DESC, id LIMIT 1").get(req.user.id);
  if (!loc) throw new HttpError(400, "Escolha um local válido para o horário.");
  const id = db.prepare("INSERT INTO slots (professional_id, location_id, date, start_time, end_time) VALUES (?, ?, ?, ?, ?)")
    .run(req.user.id, loc.id, b.date, b.start_time, end).lastInsertRowid;
  res.status(201).json(db.prepare("SELECT * FROM slots WHERE id = ?").get(id));
}));

const ownSlot = (req) => {
  const s = db.prepare("SELECT * FROM slots WHERE id = ? AND professional_id = ?").get(req.params.id, req.user.id);
  if (!s) throw new HttpError(404, "Horário não encontrado");
  return s;
};

router.patch("/slots/:id", wrap((req, res) => {
  const s = ownSlot(req);
  const { status } = validate(Joi.object({ status: Joi.string().valid("open", "blocked").required() }), req.body);
  if (s.status === "booked") throw new HttpError(409, "Este horário tem uma consulta marcada. Cancele a consulta primeiro.");
  db.prepare("UPDATE slots SET status = ? WHERE id = ?").run(status, s.id);
  res.json(db.prepare("SELECT * FROM slots WHERE id = ?").get(s.id));
}));

router.delete("/slots/:id", wrap((req, res) => {
  const s = ownSlot(req);
  if (s.status === "booked") throw new HttpError(409, "Este horário tem uma consulta marcada. Cancele a consulta primeiro.");
  if (db.prepare("SELECT 1 FROM appointments WHERE slot_id = ?").get(s.id)) {
    db.prepare("UPDATE slots SET status = 'blocked' WHERE id = ?").run(s.id);
    return res.json({ message: "Horário já teve consulta; foi bloqueado para preservar o histórico", blocked: true });
  }
  db.prepare("DELETE FROM slots WHERE id = ?").run(s.id);
  res.json({ message: "Horário removido" });
}));

// ---------- Agendamentos ----------
// Profissional marca consulta para um cliente (ignora antecedência mínima).
router.post("/appointments", wrap((req, res) => {
  const b = validate(Joi.object({
    slot_id: Joi.number().integer().required(),
    name: Joi.string().trim().min(2).max(120).required(),
    email: Joi.string().trim().email().lowercase().required(),
    phone: Joi.string().trim().max(30).allow("", null),
    notes: Joi.string().trim().max(2000).allow("", null),
  }), req.body);
  const clientId = db.transaction(() => findOrCreateClient(b))();
  const appointment = bookSlot({ slotId: b.slot_id, clientId, notes: b.notes, consent: false, professionalId: req.user.id, byProfessional: true });
  fireAndForget(notifyBooked(appointment));
  res.status(201).json(appointment);
}));

// Marca como realizada / não compareceu.
router.patch("/appointments/:id/status", wrap((req, res) => {
  const { status } = validate(Joi.object({ status: Joi.string().valid("completed", "no_show").required() }), req.body);
  const a = findAppointment(req.params.id);
  if (!a || a.professional_id !== req.user.id) throw new HttpError(404, "Agendamento não encontrado");
  if (a.status !== "confirmed") throw new HttpError(409, "Só é possível finalizar consultas confirmadas.");
  if (slotInstant(a.date, a.start_time) > new Date()) throw new HttpError(409, "A consulta ainda não aconteceu.");
  db.prepare("UPDATE appointments SET status = ? WHERE id = ?").run(status, a.id);
  res.json(findAppointment(a.id));
}));

router.get("/clients", wrap((req, res) => {
  res.json(db.prepare(`
    SELECT c.id, c.name, c.email, c.phone, COUNT(a.id) AS appointments_total,
           SUM(a.status = 'completed') AS completed, MAX(s.date) AS last_date
    FROM appointments a JOIN users c ON c.id = a.client_id JOIN slots s ON s.id = a.slot_id
    WHERE a.professional_id = ? GROUP BY c.id ORDER BY c.name`).all(req.user.id));
}));

// ---------- Painel ----------
router.get("/dashboard", wrap((req, res) => {
  const today = todayBrasilia();
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  const monday = toISODate(new Date(new Date(`${today}T00:00:00Z`).getTime() - ((dow + 6) % 7) * 86_400_000));
  const sunday = toISODate(new Date(new Date(`${monday}T00:00:00Z`).getTime() + 6 * 86_400_000));
  const one = (sql, ...p) => db.prepare(sql).get(...p).n;

  const week = listAppointments({ professionalId: req.user.id, status: "confirmed", from: monday, to: sunday });
  res.json({
    week: { from: monday, to: sunday },
    appointments_this_week: week.length,
    new_appointments_7d: one("SELECT COUNT(*) n FROM appointments WHERE professional_id = ? AND status != 'cancelled' AND created_at >= datetime('now','-7 days')", req.user.id),
    free_slots_this_week: one("SELECT COUNT(*) n FROM slots WHERE professional_id = ? AND status = 'open' AND date BETWEEN ? AND ? AND date >= ?", req.user.id, monday, sunday, today),
    accepting_bookings: profileOf(req.user.id).accepting_bookings,
    today: week.filter((a) => a.date === today),
    next_appointment: listAppointments({ professionalId: req.user.id, status: "confirmed", from: today }).find((a) => slotInstant(a.date, a.start_time) > new Date()) ?? null,
  });
}));

export default router;
