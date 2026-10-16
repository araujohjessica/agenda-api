import db from "../db.js";
import { sendMail } from "./email.js";
import { buildIcs } from "./appointments.js";

const FONT = "'Segoe UI',Helvetica,Arial,sans-serif";
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const brandName = () => process.env.EMAIL_APP_NAME || "Agenda";

const longDate = (d) =>
  new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${d}T12:00:00Z`));
const money = (v) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v);
const capitalize = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const officeText = (a) => [a.office_address, a.office_city].filter(Boolean).join(", ");
const paymentText = (a) => `O pagamento é feito via Pix${a.location_kind === "in_person" ? " no consultório" : ""}, no dia da consulta.`;
const placeText = (a) => [a.location_name, a.location_detail].filter(Boolean).join(" · ") || "A confirmar";

const TONES = {
  confirm: { gradient: "linear-gradient(135deg,#263d3f 0%,#2f5559 55%,#4a8f99 100%)", base: "#263d3f", accent: "#a9e2ea", chip: "#e9f7f8", chipText: "#2f7f8b" },
  cancel: { gradient: "linear-gradient(135deg,#4a2c3a 0%,#7a3d5a 55%,#b95f87 100%)", base: "#4a2c3a", accent: "#f8d3e2", chip: "#fdf1f6", chipText: "#b95f87" },
};

// Layout em tabelas + estilos inline (compatível com Gmail, Outlook e Apple Mail).
function layout({ tone, preheader, greeting, accent, intro, rows, highlight, cta, footer }) {
  const t = TONES[tone];
  const brand = esc(brandName());
  const rowsHtml = rows.filter(Boolean).map(([label, value], i, all) => `
    <tr><td style="padding:13px 0;${i < all.length - 1 ? "border-bottom:1px solid #e8eeec;" : ""}">
      <div style="font-family:${FONT};font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#98a5a3;margin-bottom:4px">${esc(label)}</div>
      <div style="font-family:${FONT};font-size:15px;color:#263d3f;font-weight:600;line-height:1.45">${esc(value)}</div>
    </td></tr>`).join("");
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:#eef3f1">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef3f1;padding:36px 12px"><tr><td align="center">
 <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px">
  <tr><td align="center" style="padding:0 0 18px;font-family:${FONT};font-size:13px;letter-spacing:.18em;text-transform:uppercase;color:#5d7476;font-weight:600">${brand}</td></tr>
  <tr><td style="background:#ffffff;border-radius:28px;overflow:hidden;box-shadow:0 20px 50px rgba(38,61,63,.10)">
   <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td style="background:${t.base};background-image:${t.gradient};padding:38px 36px 32px">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="width:44px;height:44px;border-radius:14px;background:#f8d3e2;text-align:center;font-size:22px;line-height:44px">&#129419;</td>
        <td style="padding-left:12px;font-family:Georgia,'Times New Roman',serif;font-size:26px;color:#ffffff">agenda</td>
      </tr></table>
      <div style="font-family:Georgia,'Times New Roman',serif;font-size:30px;line-height:1.2;color:#ffffff;margin-top:28px;letter-spacing:-.02em">${esc(greeting)}<br><span style="color:${t.accent};font-style:italic">${esc(accent)}</span></div>
    </td></tr>
    <tr><td style="padding:30px 36px 6px;font-family:${FONT};color:#4a5f61;font-size:15px;line-height:1.65">${intro}</td></tr>
    <tr><td style="padding:12px 36px 6px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7faf9;border:1px solid #e8eeec;border-radius:18px"><tr><td style="padding:6px 22px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rowsHtml}</table></td></tr></table></td></tr>
    ${highlight ? `<tr><td style="padding:12px 36px 0"><div style="background:${t.chip};color:${t.chipText};border-radius:14px;padding:14px 18px;font-family:${FONT};font-size:14px;line-height:1.55;font-weight:600">${esc(highlight)}</div></td></tr>` : ""}
    ${cta ? `<tr><td align="center" style="padding:24px 36px 0"><a href="${esc(cta.url)}" style="display:inline-block;background:#263d3f;color:#ffffff;text-decoration:none;font-family:${FONT};font-size:14px;font-weight:600;padding:14px 28px;border-radius:14px">${esc(cta.label)}</a></td></tr>` : ""}
    <tr><td style="padding:26px 36px 32px;font-family:${FONT};font-size:12.5px;line-height:1.6;color:#8b9a98">${footer}</td></tr>
   </table>
  </td></tr>
  <tr><td align="center" style="padding:22px 12px 0;font-family:${FONT};font-size:12px;line-height:1.6;color:#98a5a3">Agendamentos que respeitam o seu tempo.<br>&copy; ${new Date().getFullYear()} ${brand}</td></tr>
 </table>
</td></tr></table></body></html>`;
}

const appUrl = () => (process.env.APP_URL || "").replace(/\/$/, "");
const rebookCta = () => (appUrl() ? { label: "Agendar um novo horário", url: appUrl() } : null);

function detailRows(a, { forProfessional = false } = {}) {
  return [
    ["Data", capitalize(longDate(a.date))],
    ["Horário", `${a.start_time} às ${a.end_time} (horário de Brasília)`],
    forProfessional ? ["Cliente", a.client_name] : ["Profissional", a.professional_name],
    forProfessional && ["Contato", [a.client_email, a.client_phone].filter(Boolean).join(" · ")],
    ["Local", placeText(a)],
    officeText(a) && ["Endereço do consultório", officeText(a)],
    a.session_price != null && ["Valor da consulta", money(a.session_price)],
    forProfessional && a.client_notes && ["Observações do cliente", a.client_notes],
    ["Código", a.code],
  ];
}

const firstName = (n) => String(n).split(" ")[0];
const professionalOf = (a) => db.prepare("SELECT name, email FROM users WHERE id = ?").get(a.professional_id);

async function dispatch(jobs) {
  const results = await Promise.allSettled(jobs.map((j) => sendMail(j)));
  results.forEach((r, i) => r.status === "rejected" && console.error(`Falha ao enviar e-mail para ${jobs[i].to}:`, r.reason?.message));
}

export async function notifyBooked(a) {
  const pro = professionalOf(a);
  const limit = db.prepare("SELECT cancel_limit_hours FROM professionals WHERE user_id = ?").get(a.professional_id).cancel_limit_hours;
  const when = `${capitalize(longDate(a.date))}, às ${a.start_time}`;
  await dispatch([
    {
      to: a.client_email,
      subject: `Consulta confirmada — ${when}`,
      text: `Olá, ${firstName(a.client_name)}! Sua consulta com ${a.professional_name} está confirmada para ${when}. Local: ${placeText(a)}${officeText(a) ? ` (${officeText(a)})` : ""}. ${a.session_price != null ? `Valor: ${money(a.session_price)}. ` : ""}${paymentText(a)} Código: ${a.code}.`,
      html: layout({
        tone: "confirm", preheader: `Consulta confirmada para ${when}.`, greeting: `Olá, ${firstName(a.client_name)}.`, accent: "Sua consulta está confirmada.",
        intro: `Reservamos o seu horário com <strong>${esc(a.professional_name)}</strong>. Confira abaixo os detalhes — o evento também segue anexado para você adicionar ao seu calendário.`,
        rows: detailRows(a), highlight: paymentText(a),
        footer: `Precisa remarcar ou cancelar? Acesse <strong>Meus horários</strong> no site com o e-mail ${esc(a.client_email)} até ${limit} horas antes da consulta.`,
      }),
      ics: buildIcs(a),
    },
    pro && {
      to: pro.email,
      subject: `Nova consulta: ${a.client_name} — ${when}`,
      text: `Nova consulta agendada: ${a.client_name} (${a.client_email}) em ${when}. Local: ${placeText(a)}. Código: ${a.code}.`,
      html: layout({
        tone: "confirm", preheader: `${a.client_name} agendou para ${when}.`, greeting: `Olá, ${firstName(pro.name)}.`, accent: "Você tem uma nova consulta.",
        intro: `<strong>${esc(a.client_name)}</strong> acabou de agendar um horário com você.`,
        rows: detailRows(a, { forProfessional: true }), highlight: paymentText(a),
        footer: "O horário já foi reservado na sua agenda. Você pode acompanhar tudo pelo painel administrativo.",
      }),
      ics: buildIcs(a),
    },
  ].filter(Boolean));
}

export async function notifyCancelled(a) {
  const pro = professionalOf(a);
  const when = `${capitalize(longDate(a.date))}, às ${a.start_time}`;
  const byClient = a.cancelled_by === "client";
  const reason = a.cancel_reason ? [["Motivo informado", a.cancel_reason]] : [];
  const clientMail = byClient
    ? {
        to: a.client_email,
        subject: `Consulta cancelada — ${when}`,
        text: `Olá, ${firstName(a.client_name)}. Confirmamos o cancelamento da sua consulta com ${a.professional_name} em ${when}.${appUrl() ? ` Para agendar um novo horário: ${appUrl()}` : ""}`,
        html: layout({
          tone: "cancel", preheader: `Sua consulta de ${when} foi cancelada.`, greeting: `Olá, ${firstName(a.client_name)}.`, accent: "Sua consulta foi cancelada.",
          intro: "Confirmamos o cancelamento que você solicitou. O horário foi liberado na agenda.",
          rows: [...detailRows(a), ...reason], cta: rebookCta(),
          footer: "Quando quiser, é só voltar ao site e escolher um novo horário. Será um prazer te receber.",
        }),
      }
    : {
        // Cancelamento feito pela profissional: pede desculpas e convida a reagendar.
        to: a.client_email,
        subject: `Precisamos cancelar sua consulta — ${when}`,
        text: `Olá, ${firstName(a.client_name)}. Pedimos sinceras desculpas pelo transtorno: precisamos cancelar a sua consulta de ${when}. Há outros horários disponíveis para um novo agendamento${appUrl() ? ` em ${appUrl()}` : ""}.`,
        html: layout({
          tone: "cancel", preheader: `Pedimos desculpas: sua consulta de ${when} precisou ser cancelada.`, greeting: `Olá, ${firstName(a.client_name)}.`, accent: "Pedimos desculpas pelo transtorno.",
          intro: `Infelizmente precisamos <strong>cancelar a sua consulta</strong> com ${esc(a.professional_name)}. Sabemos que você se organizou para esse momento, e lamentamos muito a mudança.<br><br>A boa notícia: <strong>há outros horários disponíveis</strong> na agenda para você escolher um novo dia e horário, da forma que for mais conveniente.`,
          rows: [...detailRows(a), ...reason],
          highlight: "Outros horários estão disponíveis para novo agendamento.",
          cta: appUrl() ? { label: "Escolher um novo horário", url: appUrl() } : null,
          footer: `Acesse o site e escolha o melhor horário para você${appUrl() ? "" : " — a agenda está aberta"}. Mais uma vez, nossas desculpas pelo transtorno.`,
        }),
      };
  await dispatch([
    clientMail,
    pro && {
      to: pro.email,
      subject: `Consulta cancelada: ${a.client_name} — ${when}`,
      text: `A consulta de ${a.client_name} em ${when} foi cancelada${byClient ? " pelo cliente" : ""}. O horário voltou a ficar disponível.`,
      html: layout({
        tone: "cancel", preheader: `${a.client_name} — ${when}`, greeting: `Olá, ${firstName(pro.name)}.`, accent: "Uma consulta foi cancelada.",
        intro: byClient ? `<strong>${esc(a.client_name)}</strong> cancelou a consulta. O horário voltou a ficar <strong>disponível</strong> para novos agendamentos.` : "O cancelamento foi registrado e o horário voltou a ficar <strong>disponível</strong> para novos agendamentos.",
        rows: [...detailRows(a, { forProfessional: true }), ...reason],
        footer: "Nenhuma ação é necessária. A agenda já está atualizada.",
      }),
    },
  ].filter(Boolean));
}

export async function notifyRescheduled(a, before) {
  const pro = professionalOf(a);
  const when = `${capitalize(longDate(a.date))}, às ${a.start_time}`;
  const old = `${capitalize(longDate(before.date))}, às ${before.start_time}`;
  await dispatch([
    {
      to: a.client_email,
      subject: `Consulta remarcada — ${when}`,
      text: `Olá, ${firstName(a.client_name)}. Sua consulta foi remarcada de ${old} para ${when}. Código: ${a.code}.`,
      html: layout({
        tone: "confirm", preheader: `Nova data: ${when}.`, greeting: `Olá, ${firstName(a.client_name)}.`, accent: "Sua consulta foi remarcada.",
        intro: `Seu horário foi alterado de <strong>${esc(old)}</strong> para a nova data abaixo. O evento atualizado segue anexado.`,
        rows: detailRows(a), highlight: paymentText(a),
        footer: "O horário anterior foi liberado na agenda.",
      }),
      ics: buildIcs(a),
    },
    pro && {
      to: pro.email,
      subject: `Consulta remarcada: ${a.client_name} — ${when}`,
      text: `${a.client_name} remarcou de ${old} para ${when}.`,
      html: layout({
        tone: "confirm", preheader: `${a.client_name} — ${when}`, greeting: `Olá, ${firstName(pro.name)}.`, accent: "Uma consulta foi remarcada.",
        intro: `<strong>${esc(a.client_name)}</strong> mudou de <strong>${esc(old)}</strong> para a nova data abaixo. O horário anterior voltou a ficar disponível.`,
        rows: detailRows(a, { forProfessional: true }),
        footer: "A agenda já está atualizada.",
      }),
      ics: buildIcs(a),
    },
  ].filter(Boolean));
}

// Dispara sem bloquear a resposta da API: falha de e-mail nunca desfaz agendamento/cancelamento.
export const fireAndForget = (promise) => promise.catch((e) => console.error("Falha nas notificações:", e.message));
