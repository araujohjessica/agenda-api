// Teste ponta a ponta: sobe a API real com um banco temporário e exercita todos os endpoints via HTTP.
import { spawn, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenda-e2e-"));
const env = { ...process.env, DATABASE_FILE: path.join(dir, "e2e.db"), PORT: "4199", JWT_SECRET: "e2e" };
spawnSync("node", ["scripts/seed.js"], { env, stdio: "ignore" });
const server = spawn("node", ["src/server.js"], { env: { ...env, EMAIL_USER: "", EMAIL_PASS: "" }, stdio: ["ignore", "pipe", "inherit"] });
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mailed = (to, subject) => new RegExp(`\\[email:dev\\] para ${to.replace(/[.+]/g, "\\$&")} \\| ${subject}`).test(serverLog);
const lastCode = (email) => [...serverLog.matchAll(new RegExp(`código de acesso para ${email}: (\\d{6})`, "g"))].pop()?.[1];
const BASE = "http://localhost:4199/api";

let passed = 0, failed = 0;
const check = (name, cond, extra = "") => {
  cond ? passed++ : failed++;
  console.log(`${cond ? "✔" : "✘"} ${name}${cond ? "" : `  ${extra}`}`);
};
async function call(method, url, { token, body, raw } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = raw ? await res.text() : await res.json().catch(() => null);
  return { status: res.status, data };
}
const iso = (offsetDays) => new Date(Date.now() - 3 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10);
const weekday = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();

try {
  for (let i = 0; i < 50; i++) { if ((await fetch(BASE + "/health").catch(() => null))?.ok) break; await new Promise((r) => setTimeout(r, 100)); }

  // ---- Auth
  let r = await call("GET", "/health"); check("GET /health", r.status === 200);
  r = await call("POST", "/auth/login", { body: { email: "profissional@exemplo.com", password: "errada" } });
  check("login com senha errada → 401", r.status === 401);
  r = await call("POST", "/auth/login", { body: { email: "profissional@exemplo.com", password: "123456" } });
  check("login profissional", r.status === 200 && r.data.user.role === "professional"); const pro = r.data.token;
  r = await call("POST", "/auth/login", { body: { email: "cliente@exemplo.com", password: "123456" } });
  check("login cliente", r.status === 200 && r.data.user.role === "client"); const cli = r.data.token;
  r = await call("GET", "/auth/me", { token: pro }); check("GET /auth/me profissional", r.status === 200 && r.data.professional.slug === "ana-beatriz-lima");
  r = await call("GET", "/auth/me"); check("sem token → 401", r.status === 401);
  r = await call("PUT", "/auth/me", { token: cli, body: { phone: "(11) 99999-0000" } }); check("PUT /auth/me", r.status === 200 && r.data.phone === "(11) 99999-0000");
  r = await call("PUT", "/auth/password", { token: cli, body: { current_password: "x", new_password: "654321" } }); check("trocar senha com atual errada → 401", r.status === 401);
  r = await call("PUT", "/auth/password", { token: cli, body: { current_password: "123456", new_password: "654321" } }); check("PUT /auth/password", r.status === 200);
  r = await call("PUT", "/auth/password", { token: cli, body: { current_password: "654321", new_password: "123456" } }); check("restaura senha", r.status === 200);
  r = await call("POST", "/auth/register", { body: { name: "Nova Cliente", email: "nova@teste.com", password: "123456" } }); check("POST /auth/register", r.status === 201 && !!r.data.token);
  r = await call("POST", "/auth/register", { body: { name: "Nova Cliente", email: "nova@teste.com", password: "123456" } }); check("registro duplicado → 409", r.status === 409);
  r = await call("GET", "/professional/settings", { token: cli }); check("cliente em rota de profissional → 403", r.status === 403);

  // ---- Configurações e locais
  r = await call("GET", "/professional/settings", { token: pro }); check("GET settings (padrão 4h/4h)", r.status === 200 && r.data.min_notice_hours === 4 && r.data.cancel_limit_hours === 4);
  r = await call("PUT", "/professional/settings", { token: pro, body: { min_notice_hours: 4, cancel_limit_hours: 4, headline: "Terapeuta" } }); check("PUT settings", r.status === 200 && r.data.headline === "Terapeuta");
  r = await call("PUT", "/professional/settings", { token: pro, body: { office_address: "Rua das Flores, 123 - Sala 204", office_city: "Pouso Alegre - MG", session_price: 150.5 } }); check("PUT endereço e valor", r.status === 200 && r.data.session_price === 150.5 && /Flores/.test(r.data.office_address) && r.data.office_city === "Pouso Alegre - MG");
  r = await call("PUT", "/professional/settings", { token: pro, body: { session_price: -1 } }); check("valor negativo → 400", r.status === 400 && /valor da consulta/.test(r.data.error));
  r = await call("GET", "/public/professionals/ana-beatriz-lima"); check("perfil público expõe endereço e valor", r.data.session_price === 150.5 && /Flores/.test(r.data.office_address) && r.data.office_city === "Pouso Alegre - MG");
  r = await call("GET", "/professional/locations", { token: pro }); check("GET locations (2 do seed)", r.data.length === 2); const [online, office] = r.data;
  r = await call("POST", "/professional/locations", { token: pro, body: { kind: "in_person", name: "Clínica Centro", detail: "Av. Paulista 1000" } }); check("POST location", r.status === 201); const extraLoc = r.data.id;
  r = await call("PUT", `/professional/locations/${extraLoc}`, { token: pro, body: { detail: "Av. Paulista 2000" } }); check("PUT location", r.data.detail === "Av. Paulista 2000");
  r = await call("DELETE", `/professional/locations/${extraLoc}`, { token: pro }); check("DELETE location", r.status === 200 && r.data.deactivated === false);

  // ---- Períodos e slots
  const d1 = iso(3), d2 = iso(4), d3 = iso(5);
  const days = [...new Set([weekday(d1), weekday(d2), weekday(d3)])];
  r = await call("POST", "/professional/periods", { token: pro, body: { start_date: d1, end_date: d3, weekdays: days, start_time: "08:00", end_time: "12:00", interval_minutes: 60, duration_minutes: 50, location_id: online.id } });
  check("POST period gera 12 horários", r.status === 201 && r.data.slots_created === 12, JSON.stringify(r.data)); const periodId = r.data.id;
  r = await call("POST", "/professional/periods", { token: pro, body: { start_date: d1, end_date: d3, weekdays: days, start_time: "08:00", end_time: "12:00", interval_minutes: 60, location_id: online.id } });
  check("período repetido → 409", r.status === 409);
  r = await call("POST", "/professional/periods", { token: pro, body: { start_date: d3, end_date: d1, weekdays: days, start_time: "08:00", end_time: "12:00", interval_minutes: 60 } }); check("período inválido → 400", r.status === 400);
  r = await call("GET", "/professional/periods", { token: pro }); check("GET periods", r.data.length === 1 && r.data[0].slots_total === 12);
  r = await call("POST", "/professional/slots", { token: pro, body: { date: d1, start_time: "14:00", location_id: office.id } }); check("POST slot avulso", r.status === 201 && r.data.end_time === "14:50"); const extraSlot = r.data.id;
  r = await call("PATCH", `/professional/slots/${extraSlot}`, { token: pro, body: { status: "blocked" } }); check("PATCH slot → blocked", r.data.status === "blocked");
  r = await call("DELETE", `/professional/slots/${extraSlot}`, { token: pro }); check("DELETE slot", r.status === 200);
  r = await call("GET", `/professional/slots?from=${d1}&to=${d3}`, { token: pro }); check("GET slots", r.data.length === 12);

  // ---- Público
  r = await call("GET", "/public/professionals/ana-beatriz-lima"); check("GET perfil público", r.status === 200 && r.data.locations.length === 2 && !("id" in r.data));
  r = await call("GET", "/public/professionals/xxx"); check("slug inexistente → 404", r.status === 404);
  r = await call("GET", `/public/professionals/ana-beatriz-lima/slots?from=${d1}&to=${d3}`); check("GET slots públicos", r.status === 200 && r.data.days.flatMap((d) => d.slots).length === 12);
  const slots = r.data.days.flatMap((d) => d.slots);
  r = await call("GET", `/public/professionals/ana-beatriz-lima/dates?month=${d1.slice(0, 7)}`); check("GET dates do mês", r.status === 200 && r.data.dates.length >= 1);

  const book = { slot_id: slots[0].id, name: "Maria Convidada", email: "maria@convidada.com", phone: "(11) 98888-7777", notes: "Primeira consulta", consent: true };
  r = await call("POST", "/public/professionals/ana-beatriz-lima/appointments", { body: { ...book, consent: false } }); check("sem consentimento → 400", r.status === 400);
  r = await call("POST", "/public/professionals/ana-beatriz-lima/appointments", { body: book });
  check("POST agendamento público", r.status === 201 && /^AG-\d{6}$/.test(r.data.code) && r.data.status === "confirmed"); const guest = r.data;
  await sleep(200);
  check("e-mail de confirmação ao cliente", mailed("maria@convidada.com", "Consulta confirmada"));
  check("e-mail de nova consulta à profissional", mailed("profissional@exemplo.com", `Nova consulta: Maria Convidada`));
  r = await call("POST", "/public/professionals/ana-beatriz-lima/appointments", { body: { ...book, email: "outra@pessoa.com" } }); check("mesmo horário → 409", r.status === 409);
  r = await call("GET", `/public/appointments/${guest.code}?email=maria@convidada.com`); check("GET agendamento por código", r.status === 200 && r.data.id === guest.id);
  r = await call("GET", `/public/appointments/${guest.code}?email=errado@x.com`); check("código + e-mail errado → 404", r.status === 404);
  r = await call("GET", `/public/appointments/${guest.code}/ics?email=maria@convidada.com`, { raw: true }); check("GET .ics público", r.status === 200 && r.data.includes("BEGIN:VEVENT"));
  r = await call("POST", "/auth/register", { body: { name: "Maria Convidada", email: "maria@convidada.com", password: "123456" } }); check("convidada define senha depois", r.status === 201);
  r = await call("GET", "/appointments", { token: r.data.token }); check("convidada vê o próprio agendamento", r.data.length === 1 && r.data[0].code === guest.code);

  // ---- Cliente logado
  r = await call("POST", "/appointments", { token: cli, body: { slot_id: slots[1].id, notes: "Olá", consent: true } }); check("POST /appointments (cliente)", r.status === 201); const mine = r.data;
  // ---- Acesso do cliente por código (sem senha)
  const CE = "cliente@exemplo.com";
  r = await call("POST", "/auth/client/request-code", { body: { email: "ninguem@teste.com" } }); check("código: e-mail sem agendamentos → 404", r.status === 404 && /cadastro/.test(r.data.error));
  r = await call("POST", "/auth/client/request-code", { body: { email: "nova@teste.com" } }); check("código: cliente cadastrado sem agendamentos entra", r.status === 200);
  r = await call("POST", "/auth/client/request-code", { body: { email: "profissional@exemplo.com" } }); check("código: e-mail de profissional → 404", r.status === 404);
  r = await call("POST", "/auth/client/request-code", { body: { email: CE } }); check("código: solicitar", r.status === 200 && !!lastCode(CE), JSON.stringify(r.data));
  r = await call("POST", "/auth/client/request-code", { body: { email: CE } }); check("código: reenvio imediato → 429", r.status === 429);
  const good = lastCode(CE), wrong = good === "000000" ? "111111" : "000000";
  r = await call("POST", "/auth/client/verify-code", { body: { email: CE, code: wrong } }); check("código incorreto → 401", r.status === 401);
  r = await call("POST", "/auth/client/verify-code", { body: { email: CE, code: good } }); check("código correto → token", r.status === 200 && r.data.user.role === "client" && !!r.data.token);
  const viaCode = r.data.token;
  r = await call("GET", "/appointments", { token: viaCode }); check("token por código acessa /appointments", r.status === 200 && r.data.length === 1);
  r = await call("POST", "/auth/client/verify-code", { body: { email: CE, code: good } }); check("código só vale uma vez → 401", r.status === 401);

  r = await call("GET", "/appointments", { token: cli }); check("GET /appointments cliente", r.data.length === 1);
  r = await call("GET", `/appointments/${mine.id}`, { token: cli }); check("GET /appointments/:id", r.status === 200 && r.data.location_name === "Online" && r.data.session_price === 150.5 && /Flores/.test(r.data.office_address));
  r = await call("GET", `/appointments/${guest.id}`, { token: cli }); check("agendamento de outro cliente → 404", r.status === 404);
  r = await call("GET", `/appointments/${mine.id}/ics`, { token: cli, raw: true }); check("GET /appointments/:id/ics", r.status === 200 && r.data.includes("DTSTART;TZID"));
  r = await call("POST", `/appointments/${mine.id}/reschedule`, { token: cli, body: { slot_id: slots[2].id } }); check("reschedule", r.status === 200 && r.data.slot_id === slots[2].id);
  await sleep(200);
  check("e-mails de remarcação (cliente e profissional)", mailed(CE, "Consulta remarcada —") && mailed("profissional@exemplo.com", "Consulta remarcada: Carla Mendes"));
  r = await call("GET", `/public/professionals/ana-beatriz-lima/slots?from=${d1}&to=${d3}`);
  check("horário antigo voltou a ficar livre", r.data.days.flatMap((d) => d.slots).some((s) => s.id === slots[1].id));
  r = await call("POST", `/appointments/${mine.id}/cancel`, { token: cli, body: { reason: "Imprevisto" } }); check("cancel", r.status === 200 && r.data.status === "cancelled" && r.data.cancelled_by === "client");
  await sleep(200);
  check("e-mails de cancelamento (cliente e profissional)", mailed(CE, "Consulta cancelada —") && mailed("profissional@exemplo.com", "Consulta cancelada: Carla Mendes"));
  r = await call("GET", `/public/professionals/ana-beatriz-lima/slots?from=${d1}&to=${d3}`);
  check("data cancelada volta a ficar livre para novo agendamento", r.data.days.flatMap((d) => d.slots).some((x) => x.id === slots[2].id));
  r = await call("POST", `/appointments/${mine.id}/cancel`, { token: cli, body: {} }); check("cancelar de novo → 409", r.status === 409);
  r = await call("POST", "/appointments", { token: cli, body: { slot_id: slots[2].id, consent: true } }); check("rebook após cancelamento", r.status === 201);

  // ---- Profissional: agendamentos
  r = await call("GET", "/professional/slots?from=" + d1 + "&to=" + d3 + "&status=booked", { token: pro }); check("slots booked com nome do cliente", r.data.length === 2 && r.data.every((s) => s.client_name));
  r = await call("PATCH", `/professional/slots/${slots[0].id}`, { token: pro, body: { status: "blocked" } }); check("bloquear slot ocupado → 409", r.status === 409);
  r = await call("DELETE", `/professional/slots/${slots[0].id}`, { token: pro }); check("apagar slot ocupado → 409", r.status === 409);
  r = await call("GET", "/appointments", { token: pro }); check("GET /appointments profissional", r.data.length === 3);
  r = await call("GET", "/appointments?status=cancelled", { token: pro }); check("filtro status", r.data.length === 1);
  r = await call("POST", "/professional/appointments", { token: pro, body: { slot_id: slots[5].id, name: "Paciente Manual", email: "manual@paciente.com" } }); check("profissional agenda para cliente", r.status === 201); const manual = r.data;
  r = await call("PATCH", `/professional/appointments/${manual.id}/status`, { token: pro, body: { status: "completed" } }); check("finalizar consulta futura → 409", r.status === 409);
  r = await call("POST", `/appointments/${manual.id}/reschedule`, { token: pro, body: { slot_id: slots[6].id } }); check("profissional remarca", r.status === 200);
  r = await call("POST", `/appointments/${manual.id}/cancel`, { token: pro, body: { reason: "Profissional indisponível" } }); check("profissional cancela", r.data.cancelled_by === "professional");
  r = await call("GET", "/professional/clients", { token: pro }); check("GET clients", r.status === 200 && r.data.length >= 3);
  r = await call("GET", "/professional/dashboard", { token: pro }); check("GET dashboard", r.status === 200 && "appointments_this_week" in r.data && r.data.next_appointment?.code);

  // ---- Regras de 4 horas: só aparecem horários a partir de 4h; cancelar/remarcar só com 4h de antecedência
  const brt = (hoursAhead) => { const d = new Date(Date.now() - 3 * 3600e3 + hoursAhead * 3600e3); return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16) }; };
  const near = brt(2), far = brt(5);
  r = await call("POST", "/professional/slots", { token: pro, body: { date: near.date, start_time: near.time } }); const soon = r.data;
  r = await call("POST", "/professional/slots", { token: pro, body: { date: far.date, start_time: far.time } }); const later = r.data;
  r = await call("GET", `/public/professionals/ana-beatriz-lima/slots?from=${near.date}&to=${far.date}`);
  const visible = r.data.days.flatMap((d) => d.slots).map((x) => x.id);
  check("horário a menos de 4h não aparece para o cliente", !visible.includes(soon.id));
  check("horário a mais de 4h aparece para o cliente", visible.includes(later.id));
  r = await call("POST", "/appointments", { token: cli, body: { slot_id: soon.id, consent: true } }); check("agendar a menos de 4h → 409", r.status === 409, JSON.stringify(r.data));
  r = await call("POST", "/professional/appointments", { token: pro, body: { slot_id: soon.id, name: "Carla Mendes", email: CE } }); check("profissional pode encaixar a menos de 4h", r.status === 201); const tight = r.data;
  r = await call("GET", `/public/professionals/ana-beatriz-lima/slots?from=${near.date}&to=${far.date}`);
  check("horário já marcado não aparece", !r.data.days.flatMap((d) => d.slots).some((x) => x.id === soon.id));
  r = await call("POST", `/appointments/${tight.id}/cancel`, { token: cli, body: {} }); check("cliente cancelar a menos de 4h → 409", r.status === 409 && /4 horas/.test(r.data.error), JSON.stringify(r.data));
  r = await call("POST", `/appointments/${tight.id}/reschedule`, { token: cli, body: { slot_id: later.id } }); check("cliente remarcar a menos de 4h → 409", r.status === 409 && /4 horas/.test(r.data.error));
  r = await call("POST", `/appointments/${tight.id}/cancel`, { token: pro, body: { reason: "Imprevisto da profissional" } }); check("profissional cancela a qualquer momento", r.status === 200);
  await sleep(200);
  check("cancelamento pela profissional: e-mail de desculpas ao cliente", mailed(CE, "Precisamos cancelar sua consulta"));
  check("cancelamento pela profissional: aviso à profissional", mailed("profissional@exemplo.com", "Consulta cancelada: Carla Mendes"));
  await call("PUT", "/professional/settings", { token: pro, body: { accepting_bookings: false } });
  r = await call("GET", `/public/professionals/ana-beatriz-lima/slots?from=${d1}&to=${d3}`); check("agenda pausada: sem horários públicos", r.data.days.length === 0);
  r = await call("POST", "/appointments", { token: cli, body: { slot_id: slots[7].id, consent: true } }); check("agenda pausada: agendar → 409", r.status === 409);
  await call("PUT", "/professional/settings", { token: pro, body: { accepting_bookings: true } });

  // ---- Financeiro
  const F = `from=${iso(-1)}&to=${iso(60)}`;
  r = await call("GET", `/professional/finance/summary?${F}`, { token: cli }); check("financeiro: cliente → 403", r.status === 403);
  r = await call("GET", `/professional/finance/summary?${F}`, { token: pro });
  check("financeiro: resumo de consultas", r.status === 200 && r.data.appointments.total >= 3 && r.data.appointments.cancelled >= 1, JSON.stringify(r.data.appointments));
  check("financeiro: a receber previsto", r.data.revenue.receivable_upcoming >= 150.5 && r.data.revenue.received === 0, JSON.stringify(r.data.revenue));
  check("financeiro: ocupação calculada", r.data.occupancy.booked_slots >= 1 && r.data.occupancy.rate > 0);
  r = await call("PATCH", `/professional/finance/payments/${mine.id}`, { token: pro, body: { status: "paid" } }); check("financeiro: consulta cancelada não gera cobrança → 409", r.status === 409);
  r = await call("PATCH", `/professional/finance/payments/${guest.id}`, { token: pro, body: { status: "paid", method: "pix" } });
  check("financeiro: registrar pagamento", r.status === 200 && r.data.payment_status === "paid" && r.data.paid_amount === 150.5 && r.data.payment_method === "pix", JSON.stringify(r.data));
  r = await call("POST", "/professional/finance/expenses", { token: pro, body: { description: "Aluguel da sala", category: "aluguel", amount: 50, date: iso(1) } }); check("financeiro: criar despesa", r.status === 201 && r.data.amount === 50); const exp = r.data;
  r = await call("POST", "/professional/finance/expenses", { token: pro, body: { description: "x", amount: 0, date: iso(1) } }); check("financeiro: despesa inválida → 400", r.status === 400);
  r = await call("GET", `/professional/finance/summary?${F}`, { token: pro });
  check("financeiro: recebido, despesas e resultado líquido", r.data.revenue.received === 150.5 && r.data.expenses.total === 50 && r.data.net_result === 100.5 && r.data.revenue.by_method.pix === 150.5 && r.data.revenue.average_ticket === 150.5, JSON.stringify([r.data.revenue, r.data.expenses, r.data.net_result]));
  r = await call("PUT", `/professional/finance/expenses/${exp.id}`, { token: pro, body: { amount: 60.25 } }); check("financeiro: editar despesa", r.data.amount === 60.25);
  r = await call("GET", `/professional/finance/expenses?${F}`, { token: pro }); check("financeiro: listar despesas", r.data.length === 1);
  r = await call("GET", `/professional/finance/transactions?${F}&payment=paid`, { token: pro }); check("financeiro: lançamentos pagos", r.data.length === 1 && r.data[0].client.name === "Maria Convidada");
  r = await call("GET", `/professional/finance/transactions?${F}&payment=pending`, { token: pro }); check("financeiro: lançamentos pendentes (sem canceladas)", r.data.length >= 1 && r.data.every((t) => t.payment_status !== "paid" && t.status !== "cancelled"));
  r = await call("GET", "/professional/finance/monthly?months=6", { token: pro }); check("financeiro: série mensal", r.data.length === 6 && r.data.some((m) => m.received === 150.5 && m.booked >= 3));
  r = await call("GET", `/professional/finance/top-clients?${F}`, { token: pro }); check("financeiro: ranking de clientes", r.data[0].name === "Maria Convidada" && r.data[0].received === 150.5);
  r = await call("GET", `/professional/finance/export.csv?${F}`, { token: pro, raw: true }); check("financeiro: exportar CSV", r.status === 200 && r.data.includes("Maria Convidada") && r.data.includes("150,50"));
  r = await call("PATCH", `/professional/finance/payments/${guest.id}`, { token: pro, body: { status: "pending" } }); check("financeiro: desfazer pagamento", r.data.payment_status === "pending" && r.data.paid_amount === null);
  r = await call("DELETE", `/professional/finance/expenses/${exp.id}`, { token: pro }); check("financeiro: remover despesa", r.status === 200);

  // ---- Remover período preserva consultas
  r = await call("DELETE", `/professional/periods/${periodId}`, { token: pro }); check("DELETE period", r.status === 200 && r.data.slots_removed > 0);
  r = await call("GET", `/professional/slots?from=${d1}&to=${d3}`, { token: pro }); check("consultas preservadas e nenhum horário livre sobra", r.data.some((s) => s.status === "booked") && r.data.every((s) => s.status !== "open"));
  r = await call("GET", "/rota-inexistente"); check("rota inexistente → 404", r.status === 404);
} finally {
  server.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${passed} ok, ${failed} falhas`);
process.exit(failed ? 1 : 0);
