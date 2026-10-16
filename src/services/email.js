import nodemailer from "nodemailer";

let transporter;
const configured = () => !!(process.env.EMAIL_USER && process.env.EMAIL_PASS);

function getTransporter() {
  const port = Number(process.env.EMAIL_PORT || 465);
  transporter ??= nodemailer.createTransport({
    host: process.env.EMAIL_HOST || "smtp.gmail.com",
    port,
    secure: port === 465,
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  });
  return transporter;
}

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Layout em tabelas + estilos inline para funcionar em Gmail, Outlook e Apple Mail.
export function accessCodeHtml({ name, code, brand }) {
  const digits = code.split("").map((d) =>
    `<td style="width:46px;height:58px;background:#f1fafb;border:1px solid #cfe9ed;border-radius:12px;text-align:center;font-family:'Segoe UI',Helvetica,Arial,sans-serif;font-size:28px;font-weight:700;color:#263d3f">${d}</td><td style="width:8px"></td>`,
  ).join("");
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:#eef3f1">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">Seu código de acesso: ${esc(code)}. Válido por 10 minutos.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef3f1;padding:36px 12px">
 <tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px">
   <tr><td align="center" style="padding:0 0 18px;font-family:'Segoe UI',Helvetica,Arial,sans-serif;font-size:13px;letter-spacing:.18em;text-transform:uppercase;color:#5d7476;font-weight:600">${esc(brand)}</td></tr>
   <tr><td style="background:#ffffff;border-radius:28px;overflow:hidden;box-shadow:0 20px 50px rgba(38,61,63,.10)">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
     <tr><td style="background:#263d3f;background-image:linear-gradient(135deg,#263d3f 0%,#2f5559 55%,#4a8f99 100%);padding:40px 36px 34px" align="left">
       <table role="presentation" cellpadding="0" cellspacing="0"><tr>
         <td style="width:44px;height:44px;border-radius:14px;background:#f8d3e2;text-align:center;font-size:22px;line-height:44px">&#129419;</td>
         <td style="padding-left:12px;font-family:Georgia,'Times New Roman',serif;font-size:26px;color:#ffffff;letter-spacing:-.01em">agenda</td>
       </tr></table>
       <div style="font-family:Georgia,'Times New Roman',serif;font-size:32px;line-height:1.2;color:#ffffff;margin-top:30px;letter-spacing:-.02em">Olá, ${esc(name)}.<br><span style="color:#a9e2ea;font-style:italic">Seu acesso chegou.</span></div>
     </td></tr>
     <tr><td style="padding:34px 36px 8px;font-family:'Segoe UI',Helvetica,Arial,sans-serif;color:#4a5f61;font-size:15px;line-height:1.65">
       Use o código abaixo para entrar na sua área e ver, remarcar ou cancelar seus horários. Sem senha para lembrar.
     </td></tr>
     <tr><td align="center" style="padding:20px 36px 10px">
       <table role="presentation" cellpadding="0" cellspacing="0"><tr>${digits}</tr></table>
     </td></tr>
     <tr><td align="center" style="padding:14px 36px 30px;font-family:'Segoe UI',Helvetica,Arial,sans-serif;font-size:13px;color:#8b9a98">
       <span style="display:inline-block;background:#fdf1f6;color:#b95f87;border-radius:999px;padding:7px 16px;font-weight:600">&#9201; Válido por 10 minutos &middot; uso único</span>
     </td></tr>
     <tr><td style="padding:0 36px"><div style="height:1px;background:#e8eeec"></div></td></tr>
     <tr><td style="padding:24px 36px 34px;font-family:'Segoe UI',Helvetica,Arial,sans-serif;font-size:12.5px;line-height:1.6;color:#8b9a98">
       <strong style="color:#5d7476">Não foi você?</strong> Basta ignorar este e-mail — ninguém acessa seus horários sem o código. Por segurança, nunca compartilhe este número com ninguém.
     </td></tr>
    </table>
   </td></tr>
   <tr><td align="center" style="padding:22px 12px 0;font-family:'Segoe UI',Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:#98a5a3">
     Agendamentos que respeitam o seu tempo.<br>&copy; ${new Date().getFullYear()} ${esc(brand)}
   </td></tr>
  </table>
 </td></tr>
</table></body></html>`;
}

// Envio genérico. Sem credenciais (desenvolvimento), apenas registra no log do servidor.
export async function sendMail({ to, subject, text, html, ics }) {
  if (!configured()) {
    console.log(`[email:dev] para ${to} | ${subject}`);
    return;
  }
  const brand = process.env.EMAIL_APP_NAME || "Agenda";
  await getTransporter().sendMail({
    from: `"${brand}" <${process.env.EMAIL_USER}>`,
    to,
    subject,
    text,
    html,
    ...(ics ? { icalEvent: { method: "PUBLISH", filename: "consulta.ics", content: ics } } : {}),
  });
}

// Sem credenciais configuradas (desenvolvimento), o código é impresso no log do servidor.
export async function sendAccessCode(to, name, code) {
  if (!configured()) {
    console.log(`[email:dev] código de acesso para ${to}: ${code}`);
    return;
  }
  const brand = process.env.EMAIL_APP_NAME || "Agenda";
  await getTransporter().sendMail({
    from: `"${brand}" <${process.env.EMAIL_USER}>`,
    to,
    subject: `${code} é o seu código de acesso — ${brand}`,
    text: `Olá, ${name}! Seu código de acesso é ${code}. Ele vale por 10 minutos e só pode ser usado uma vez.`,
    html: accessCodeHtml({ name, code, brand }),
  });
}
