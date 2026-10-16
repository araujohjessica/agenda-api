import { Router } from "express";
import Joi from "joi";
import db from "../db.js";
import { HttpError, validate, wrap } from "../utils/http.js";
import { slotInstant, todayBrasilia, toISODate } from "../utils/time.js";

const router = Router();
const date = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/);
const METHODS = ["pix", "cash", "card", "transfer"];
const cents = (reais) => Math.round(reais * 100);
const reais = (c) => (c == null ? null : c / 100);

const monthStart = (d) => `${d.slice(0, 7)}-01`;
const monthEnd = (d) => toISODate(new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7), 0)));
const addDays = (d, n) => toISODate(new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 86_400_000));

function period(query) {
  const today = todayBrasilia();
  const q = validate(Joi.object({ from: date, to: date }), query);
  const from = q.from ?? monthStart(today);
  const to = q.to ?? monthEnd(today);
  if (to < from) throw new HttpError(400, "A data final deve ser igual ou posterior à data inicial.");
  if ((new Date(to) - new Date(from)) / 86_400_000 > 800) throw new HttpError(400, "O período pode ter no máximo 2 anos.");
  return { from, to };
}

const APPT_ROWS = `
  SELECT a.id, a.code, a.status, a.price_cents, a.payment_status, a.payment_method, a.paid_cents, a.paid_at,
         s.date, s.start_time, c.id AS client_id, c.name AS client_name, c.email AS client_email
  FROM appointments a JOIN slots s ON s.id = a.slot_id JOIN users c ON c.id = a.client_id
  WHERE a.professional_id = ? AND s.date BETWEEN ? AND ?`;

function metrics(professionalId, from, to) {
  const rows = db.prepare(`${APPT_ROWS} ORDER BY s.date, s.start_time`).all(professionalId, from, to);
  const now = Date.now();
  const m = {
    total: rows.length, confirmed: 0, completed: 0, cancelled: 0, no_show: 0,
    received: 0, paid_count: 0, receivable_upcoming: 0, overdue: 0, overdue_count: 0, upcoming_count: 0,
    lost_no_show: 0, cancelled_value: 0, by_method: {},
  };
  for (const r of rows) {
    m[r.status]++;
    const price = r.price_cents ?? 0;
    if (r.payment_status === "paid") {
      const paid = r.paid_cents ?? price;
      m.received += paid; m.paid_count++;
      m.by_method[r.payment_method ?? "pix"] = (m.by_method[r.payment_method ?? "pix"] ?? 0) + paid;
      continue;
    }
    if (r.status === "cancelled") m.cancelled_value += price;
    else if (r.status === "no_show") m.lost_no_show += price;
    else if (slotInstant(r.date, r.start_time).getTime() > now) { m.receivable_upcoming += price; m.upcoming_count++; }
    else { m.overdue += price; m.overdue_count++; }
  }
  const expenses = db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS t, COUNT(*) AS n FROM expenses WHERE professional_id = ? AND date BETWEEN ? AND ?").get(professionalId, from, to);
  const slots = db.prepare("SELECT status, COUNT(*) AS n FROM slots WHERE professional_id = ? AND date BETWEEN ? AND ? GROUP BY status").all(professionalId, from, to);
  const slotCount = Object.fromEntries(slots.map((s) => [s.status, s.n]));
  const bookable = (slotCount.open ?? 0) + (slotCount.booked ?? 0);
  return { rows, m, expenses, slotCount, bookable };
}

router.get("/summary", wrap((req, res) => {
  const { from, to } = period(req.query);
  const id = req.user.id;
  const cur = metrics(id, from, to);
  const days = Math.round((new Date(to) - new Date(from)) / 86_400_000) + 1;
  const prevTo = addDays(from, -1), prevFrom = addDays(prevTo, -(days - 1));
  const prev = metrics(id, prevFrom, prevTo);
  const { m } = cur;
  const pct = (a, b) => (b > 0 ? Math.round(((a - b) / b) * 1000) / 10 : null);
  const done = m.completed + m.no_show;

  res.json({
    period: { from, to, days },
    appointments: {
      total: m.total, confirmed: m.confirmed, completed: m.completed, cancelled: m.cancelled, no_show: m.no_show,
      upcoming: m.upcoming_count, cancellation_rate: m.total ? Math.round((m.cancelled / m.total) * 1000) / 10 : 0,
      no_show_rate: done ? Math.round((m.no_show / done) * 1000) / 10 : 0,
    },
    revenue: {
      received: reais(m.received), paid_count: m.paid_count,
      receivable_upcoming: reais(m.receivable_upcoming), overdue: reais(m.overdue), overdue_count: m.overdue_count,
      expected_total: reais(m.received + m.receivable_upcoming + m.overdue),
      average_ticket: m.paid_count ? reais(Math.round(m.received / m.paid_count)) : 0,
      lost_no_show: reais(m.lost_no_show), cancelled_value: reais(m.cancelled_value),
      by_method: Object.fromEntries(Object.entries(m.by_method).map(([k, v]) => [k, reais(v)])),
    },
    expenses: { total: reais(cur.expenses.t), count: cur.expenses.n },
    net_result: reais(m.received - cur.expenses.t),
    occupancy: {
      booked_slots: cur.slotCount.booked ?? 0, open_slots: cur.slotCount.open ?? 0, blocked_slots: cur.slotCount.blocked ?? 0,
      rate: cur.bookable ? Math.round(((cur.slotCount.booked ?? 0) / cur.bookable) * 1000) / 10 : 0,
    },
    previous: {
      period: { from: prevFrom, to: prevTo }, received: reais(prev.m.received), appointments: prev.m.total,
      received_change_pct: pct(m.received, prev.m.received), appointments_change_pct: pct(m.total, prev.m.total),
    },
  });
}));

router.get("/monthly", wrap((req, res) => {
  const { months } = validate(Joi.object({ months: Joi.number().integer().min(1).max(36).default(12) }), req.query);
  const today = todayBrasilia();
  const list = [];
  let y = +today.slice(0, 4), mo = +today.slice(5, 7);
  for (let i = 0; i < months; i++) { list.unshift(`${y}-${String(mo).padStart(2, "0")}`); if (--mo === 0) { mo = 12; y--; } }
  const from = `${list[0]}-01`, to = monthEnd(`${list[list.length - 1]}-01`);

  const appts = db.prepare(`
    SELECT substr(s.date,1,7) AS month, COUNT(*) AS booked,
           SUM(a.status = 'completed') AS completed, SUM(a.status = 'cancelled') AS cancelled, SUM(a.status = 'no_show') AS no_show,
           COALESCE(SUM(CASE WHEN a.payment_status = 'paid' THEN COALESCE(a.paid_cents, a.price_cents, 0) END), 0) AS received,
           COALESCE(SUM(CASE WHEN a.status IN ('confirmed','completed') AND a.payment_status != 'paid' THEN COALESCE(a.price_cents, 0) END), 0) AS pending
    FROM appointments a JOIN slots s ON s.id = a.slot_id
    WHERE a.professional_id = ? AND s.date BETWEEN ? AND ? GROUP BY month`).all(req.user.id, from, to);
  const exp = db.prepare("SELECT substr(date,1,7) AS month, SUM(amount_cents) AS total FROM expenses WHERE professional_id = ? AND date BETWEEN ? AND ? GROUP BY month").all(req.user.id, from, to);
  const A = Object.fromEntries(appts.map((r) => [r.month, r])), E = Object.fromEntries(exp.map((r) => [r.month, r.total]));
  res.json(list.map((month) => ({
    month, booked: A[month]?.booked ?? 0, completed: A[month]?.completed ?? 0, cancelled: A[month]?.cancelled ?? 0, no_show: A[month]?.no_show ?? 0,
    received: reais(A[month]?.received ?? 0), pending: reais(A[month]?.pending ?? 0), expenses: reais(E[month] ?? 0),
    net: reais((A[month]?.received ?? 0) - (E[month] ?? 0)),
  })));
}));

router.get("/top-clients", wrap((req, res) => {
  const { from, to } = period(req.query);
  res.json(db.prepare(`
    SELECT c.id, c.name, c.email,
           COUNT(*) AS appointments,
           SUM(a.status IN ('confirmed','completed')) AS active_appointments,
           COALESCE(SUM(CASE WHEN a.payment_status = 'paid' THEN COALESCE(a.paid_cents, a.price_cents, 0) END), 0) / 100.0 AS received
    FROM appointments a JOIN slots s ON s.id = a.slot_id JOIN users c ON c.id = a.client_id
    WHERE a.professional_id = ? AND s.date BETWEEN ? AND ?
    GROUP BY c.id ORDER BY received DESC, appointments DESC LIMIT 10`).all(req.user.id, from, to));
}));

const mapTx = (r) => ({
  id: r.id, code: r.code, date: r.date, start_time: r.start_time, status: r.status,
  client: { id: r.client_id, name: r.client_name, email: r.client_email },
  price: reais(r.price_cents), payment_status: r.payment_status, payment_method: r.payment_method,
  paid_amount: reais(r.paid_cents), paid_at: r.paid_at,
});

function transactions(req) {
  const { from, to } = period(req.query);
  const { payment } = validate(Joi.object({ payment: Joi.string().valid("all", "paid", "pending").default("all") }), req.query);
  let rows = db.prepare(`${APPT_ROWS} ORDER BY s.date DESC, s.start_time DESC`).all(req.user.id, from, to);
  if (payment === "paid") rows = rows.filter((r) => r.payment_status === "paid");
  if (payment === "pending") rows = rows.filter((r) => r.payment_status !== "paid" && r.status !== "cancelled");
  return rows.map(mapTx);
}

router.get("/transactions", wrap((req, res) => res.json(transactions(req))));

router.patch("/payments/:id", wrap((req, res) => {
  const b = validate(Joi.object({
    status: Joi.string().valid("paid", "pending").required(),
    method: Joi.string().valid(...METHODS),
    amount: Joi.number().min(0).max(100000).precision(2),
    price: Joi.number().min(0).max(100000).precision(2),
    paid_at: date,
  }), req.body);
  const a = db.prepare("SELECT * FROM appointments WHERE id = ? AND professional_id = ?").get(req.params.id, req.user.id);
  if (!a) throw new HttpError(404, "Agendamento não encontrado");
  if (a.status === "cancelled") throw new HttpError(409, "Consultas canceladas não geram cobrança.");
  const price = "price" in b ? cents(b.price) : a.price_cents;
  if (b.status === "paid") {
    db.prepare("UPDATE appointments SET price_cents=?, payment_status='paid', payment_method=?, paid_cents=?, paid_at=? WHERE id=?")
      .run(price, b.method ?? "pix", "amount" in b ? cents(b.amount) : price ?? 0, b.paid_at ?? todayBrasilia(), a.id);
  } else {
    db.prepare("UPDATE appointments SET price_cents=?, payment_status='pending', payment_method=NULL, paid_cents=NULL, paid_at=NULL WHERE id=?").run(price, a.id);
  }
  const row = db.prepare(`${APPT_ROWS.replace("WHERE a.professional_id = ? AND s.date BETWEEN ? AND ?", "WHERE a.id = ?")}`).get(a.id);
  res.json(mapTx(row));
}));

// ---------- Despesas ----------
const expenseSchema = Joi.object({
  description: Joi.string().trim().min(2).max(120).required(),
  category: Joi.string().trim().max(40).default("outros"),
  amount: Joi.number().greater(0).max(1000000).precision(2).required(),
  date: date.required(),
});
const mapExpense = (e) => ({ id: e.id, description: e.description, category: e.category, amount: reais(e.amount_cents), date: e.date });
const ownExpense = (req) => {
  const e = db.prepare("SELECT * FROM expenses WHERE id = ? AND professional_id = ?").get(req.params.id, req.user.id);
  if (!e) throw new HttpError(404, "Despesa não encontrada");
  return e;
};

router.get("/expenses", wrap((req, res) => {
  const { from, to } = period(req.query);
  res.json(db.prepare("SELECT * FROM expenses WHERE professional_id = ? AND date BETWEEN ? AND ? ORDER BY date DESC, id DESC").all(req.user.id, from, to).map(mapExpense));
}));

router.post("/expenses", wrap((req, res) => {
  const b = validate(expenseSchema, req.body);
  const id = db.prepare("INSERT INTO expenses (professional_id, description, category, amount_cents, date) VALUES (?, ?, ?, ?, ?)")
    .run(req.user.id, b.description, b.category, cents(b.amount), b.date).lastInsertRowid;
  res.status(201).json(mapExpense(db.prepare("SELECT * FROM expenses WHERE id = ?").get(id)));
}));

router.put("/expenses/:id", wrap((req, res) => {
  const cur = ownExpense(req);
  const b = validate(expenseSchema.fork(["description", "amount", "date"], (s) => s.optional()).min(1), req.body);
  db.prepare("UPDATE expenses SET description=?, category=?, amount_cents=?, date=? WHERE id=?")
    .run(b.description ?? cur.description, b.category ?? cur.category, "amount" in b ? cents(b.amount) : cur.amount_cents, b.date ?? cur.date, cur.id);
  res.json(mapExpense(db.prepare("SELECT * FROM expenses WHERE id = ?").get(cur.id)));
}));

router.delete("/expenses/:id", wrap((req, res) => {
  db.prepare("DELETE FROM expenses WHERE id = ?").run(ownExpense(req).id);
  res.json({ message: "Despesa removida" });
}));

// ---------- Exportação CSV (separador ';' e BOM: abre direto no Excel em pt-BR) ----------
const csvCell = (v) => `"${String(v ?? "").replaceAll('"', '""')}"`;
const num = (v) => (v == null ? "" : v.toFixed(2).replace(".", ","));
const STATUS_PT = { confirmed: "Confirmada", completed: "Realizada", cancelled: "Cancelada", no_show: "Não compareceu" };
const METHOD_PT = { pix: "Pix", cash: "Dinheiro", card: "Cartão", transfer: "Transferência" };

router.get("/export.csv", wrap((req, res) => {
  const { type } = validate(Joi.object({ type: Joi.string().valid("transactions", "expenses").default("transactions") }), req.query);
  const { from, to } = period(req.query);
  let lines;
  if (type === "expenses") {
    const rows = db.prepare("SELECT * FROM expenses WHERE professional_id = ? AND date BETWEEN ? AND ? ORDER BY date").all(req.user.id, from, to);
    lines = [["Data", "Descrição", "Categoria", "Valor"], ...rows.map((e) => [e.date, e.description, e.category, num(e.amount_cents / 100)])];
  } else {
    lines = [["Data", "Horário", "Código", "Cliente", "E-mail", "Situação da consulta", "Valor", "Pagamento", "Forma", "Valor recebido", "Data do pagamento"],
      ...transactions(req).map((t) => [t.date, t.start_time, t.code, t.client.name, t.client.email, STATUS_PT[t.status], num(t.price),
        t.payment_status === "paid" ? "Pago" : t.status === "cancelled" ? "—" : "Pendente", METHOD_PT[t.payment_method] ?? "", num(t.paid_amount), t.paid_at ?? ""])];
  }
  res.type("text/csv; charset=utf-8").attachment(`${type === "expenses" ? "despesas" : "lancamentos"}-${from}-a-${to}.csv`)
    .send("﻿" + lines.map((l) => l.map(csvCell).join(";")).join("\r\n"));
}));

export default router;
