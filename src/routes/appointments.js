import { Router } from "express";
import Joi from "joi";
import { requireAuth } from "../middleware/auth.js";
import { HttpError, validate, wrap } from "../utils/http.js";
import { fireAndForget, notifyBooked, notifyCancelled, notifyRescheduled } from "../services/notifications.js";
import {
  bookSlot, buildIcs, cancelAppointment, findAppointment, listAppointments, rescheduleAppointment,
} from "../services/appointments.js";

const router = Router();
router.use(requireAuth);

const date = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/);

// Carrega o agendamento garantindo que pertence ao usuário (cliente dono ou profissional responsável).
function owned(req) {
  const a = findAppointment(req.params.id);
  const mine = a && (req.user.role === "client" ? a.client_id === req.user.id : a.professional_id === req.user.id);
  if (!mine) throw new HttpError(404, "Agendamento não encontrado");
  return a;
}

router.get("/", wrap((req, res) => {
  const q = validate(
    Joi.object({ status: Joi.string().valid("confirmed", "cancelled", "completed", "no_show"), from: date, to: date }),
    req.query,
  );
  const scope = req.user.role === "client" ? { clientId: req.user.id } : { professionalId: req.user.id };
  res.json(listAppointments({ ...scope, ...q }));
}));

// Cliente logado agenda um horário.
router.post("/", wrap((req, res) => {
  if (req.user.role !== "client") throw new HttpError(403, "Contas profissionais não agendam por aqui. Use o painel da agenda.");
  const body = validate(
    Joi.object({
      slot_id: Joi.number().integer().required(),
      notes: Joi.string().trim().max(2000).allow("", null),
      consent: Joi.boolean().valid(true).required().messages({ "any.only": "É necessário aceitar a política de privacidade" }),
    }),
    req.body,
  );
  const appointment = bookSlot({ slotId: body.slot_id, clientId: req.user.id, notes: body.notes, consent: true });
  fireAndForget(notifyBooked(appointment));
  res.status(201).json(appointment);
}));

router.get("/:id", wrap((req, res) => res.json(owned(req))));

router.get("/:id/ics", wrap((req, res) => {
  const a = owned(req);
  res.type("text/calendar").attachment(`consulta-${a.code}.ics`).send(buildIcs(a));
}));

router.post("/:id/cancel", wrap((req, res) => {
  const { reason } = validate(Joi.object({ reason: Joi.string().trim().max(500).allow("", null) }), req.body);
  const cancelled = cancelAppointment(owned(req), req.user.role, reason);
  fireAndForget(notifyCancelled(cancelled));
  res.json(cancelled);
}));

router.post("/:id/reschedule", wrap((req, res) => {
  const { slot_id } = validate(Joi.object({ slot_id: Joi.number().integer().required() }), req.body);
  const before = owned(req);
  const updated = rescheduleAppointment(before, slot_id, req.user.role);
  fireAndForget(notifyRescheduled(updated, before));
  res.json(updated);
}));

export default router;
