import { Router } from "express";
import Joi from "joi";
import db from "../db.js";
import { HttpError, validate, wrap } from "../utils/http.js";
import { slotInstant, todayBrasilia, toISODate } from "../utils/time.js";
import { fireAndForget, notifyBooked } from "../services/notifications.js";
import { bookSlot, buildIcs, findAppointmentByCode, findOrCreateClient } from "../services/appointments.js";

const router = Router();
const date = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/);

function getProfessional(slug) {
  const p = db.prepare(`
    SELECT u.id, u.name, p.slug, p.headline, p.bio, p.accepting_bookings, p.min_notice_hours, p.cancel_limit_hours, p.session_minutes, p.office_address, p.office_city, p.session_price_cents
    FROM professionals p JOIN users u ON u.id = p.user_id WHERE p.slug = ?`).get(slug);
  if (!p) throw new HttpError(404, "Profissional não encontrada");
  return p;
}

// Horários livres respeitando a antecedência mínima.
function freeSlots(p, from, to) {
  if (!p.accepting_bookings) return [];
  const limit = Date.now() + p.min_notice_hours * 3_600_000;
  return db.prepare(`
    SELECT s.id, s.date, s.start_time, s.end_time, l.id AS location_id, l.kind AS location_kind, l.name AS location_name, l.detail AS location_detail
    FROM slots s LEFT JOIN locations l ON l.id = s.location_id
    WHERE s.professional_id = ? AND s.status = 'open' AND s.date BETWEEN ? AND ?
    ORDER BY s.date, s.start_time`).all(p.id, from, to)
    .filter((s) => slotInstant(s.date, s.start_time).getTime() >= limit);
}

router.get("/professionals/:slug", wrap((req, res) => {
  const p = getProfessional(req.params.slug);
  const locations = db.prepare(
    "SELECT id, kind, name, detail, is_default FROM locations WHERE professional_id = ? AND active = 1 ORDER BY is_default DESC, id",
  ).all(p.id);
  const { id, session_price_cents, ...profile } = p;
  res.json({ ...profile, session_price: session_price_cents == null ? null : session_price_cents / 100, accepting_bookings: !!p.accepting_bookings, timezone: "America/Sao_Paulo", locations });
}));

router.get("/professionals/:slug/slots", wrap((req, res) => {
  const p = getProfessional(req.params.slug);
  const from = req.query.from || todayBrasilia();
  const defaultTo = toISODate(new Date(new Date(`${from}T00:00:00Z`).getTime() + 30 * 86_400_000));
  const q = validate(Joi.object({ from: date.required(), to: date.required() }), { from, to: req.query.to || defaultTo });
  const days = {};
  for (const s of freeSlots(p, q.from, q.to)) (days[s.date] ||= []).push(s);
  res.json({ from: q.from, to: q.to, days: Object.entries(days).map(([d, slots]) => ({ date: d, slots })) });
}));

router.get("/professionals/:slug/dates", wrap((req, res) => {
  const p = getProfessional(req.params.slug);
  const { month } = validate(Joi.object({ month: Joi.string().pattern(/^\d{4}-\d{2}$/).required() }), req.query);
  const counts = {};
  for (const s of freeSlots(p, `${month}-01`, `${month}-31`)) counts[s.date] = (counts[s.date] || 0) + 1;
  res.json({ month, dates: Object.entries(counts).map(([d, available]) => ({ date: d, available })) });
}));

const bookingSchema = Joi.object({
  slot_id: Joi.number().integer().required(),
  name: Joi.string().trim().min(2).max(120).required(),
  email: Joi.string().trim().email().lowercase().required(),
  phone: Joi.string().trim().max(30).allow("", null),
  notes: Joi.string().trim().max(2000).allow("", null),
  consent: Joi.boolean().valid(true).required().messages({ "any.only": "É necessário aceitar a política de privacidade" }),
});

router.post("/professionals/:slug/appointments", wrap((req, res) => {
  const p = getProfessional(req.params.slug);
  const body = validate(bookingSchema, req.body);
  const clientId = db.transaction(() => findOrCreateClient(body))();
  const appointment = bookSlot({ slotId: body.slot_id, clientId, notes: body.notes, consent: true, professionalId: p.id });
  fireAndForget(notifyBooked(appointment));
  res.status(201).json(appointment);
}));

// Consulta pública por código + e-mail (cliente que agendou sem criar conta).
function lookup(req) {
  const { email } = validate(Joi.object({ email: Joi.string().email().lowercase().required() }), req.query);
  const a = findAppointmentByCode(req.params.code.toUpperCase());
  if (!a || a.client_email.toLowerCase() !== email) throw new HttpError(404, "Agendamento não encontrado");
  return a;
}

router.get("/appointments/:code", wrap((req, res) => res.json(lookup(req))));
router.get("/appointments/:code/ics", wrap((req, res) => {
  const a = lookup(req);
  res.type("text/calendar").attachment(`consulta-${a.code}.ics`).send(buildIcs(a));
}));

export default router;
