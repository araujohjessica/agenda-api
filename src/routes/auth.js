import { Router } from "express";
import bcrypt from "bcryptjs";
import Joi from "joi";
import crypto from "crypto";
import { sendAccessCode } from "../services/email.js";
import db from "../db.js";
import { requireAuth, signToken } from "../middleware/auth.js";
import { HttpError, validate, wrap } from "../utils/http.js";

const router = Router();

const registerSchema = Joi.object({
  name: Joi.string().trim().min(2).max(120).required(),
  email: Joi.string().trim().email().lowercase().required(),
  phone: Joi.string().trim().max(30).allow("", null),
  password: Joi.string().min(6).max(100).required(),
});

// Cadastro de cliente. Se o cliente já agendou sem conta (senha em branco), apenas define a senha.
router.post("/register", wrap((req, res) => {
  const body = validate(registerSchema, req.body);
  const hash = bcrypt.hashSync(body.password, 10);
  const existing = db.prepare("SELECT * FROM users WHERE email = ?").get(body.email);
  let userId;
  if (existing) {
    if (existing.role !== "client" || existing.password_hash) throw new HttpError(409, "Este e-mail já possui cadastro.");
    db.prepare("UPDATE users SET password_hash = ?, name = ?, phone = COALESCE(?, phone) WHERE id = ?")
      .run(hash, body.name, body.phone || null, existing.id);
    userId = existing.id;
  } else {
    userId = db.prepare("INSERT INTO users (name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, 'client')")
      .run(body.name, body.email, body.phone || null, hash).lastInsertRowid;
  }
  const user = db.prepare("SELECT id, name, email, phone, role FROM users WHERE id = ?").get(userId);
  res.status(201).json({ user, token: signToken(user) });
}));

router.post("/login", wrap((req, res) => {
  const { email, password } = validate(
    Joi.object({ email: Joi.string().trim().email().lowercase().required(), password: Joi.string().required() }),
    req.body,
  );
  const row = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!row?.password_hash || !bcrypt.compareSync(password, row.password_hash))
    throw new HttpError(401, "E-mail ou senha incorretos.");
  const user = { id: row.id, name: row.name, email: row.email, phone: row.phone, role: row.role };
  res.json({ user, token: signToken(user) });
}));

// ---- Acesso do cliente por código enviado ao e-mail (sem senha) ----
const CODE_TTL_MIN = 10;
const MAX_ATTEMPTS = 5;
const RESEND_SECONDS = 60;
const hashCode = (code) => crypto.createHash("sha256").update(`${code}:${process.env.JWT_SECRET}`).digest("hex");
const emailSchema = Joi.string().trim().email().lowercase().required();

router.post("/client/request-code", wrap(async (req, res) => {
  const { email } = validate(Joi.object({ email: emailSchema }), req.body);
  // Qualquer cliente cadastrado (com conta ou que já agendou) pode entrar.
  const user = db.prepare("SELECT id, name FROM users WHERE email = ? AND role = 'client'").get(email);
  if (!user) throw new HttpError(404, "Não encontramos cadastro ou agendamentos para este e-mail.");

  const last = db.prepare("SELECT (strftime('%s','now') - strftime('%s', created_at)) AS age FROM login_codes WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(user.id);
  if (last && last.age < RESEND_SECONDS) {
    const wait = RESEND_SECONDS - last.age;
    res.set("Retry-After", String(wait));
    throw new HttpError(429, `Aguarde ${wait}s para solicitar um novo código.`);
  }
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  db.transaction(() => {
    db.prepare("UPDATE login_codes SET used = 1 WHERE user_id = ? AND used = 0").run(user.id);
    db.prepare("INSERT INTO login_codes (user_id, code_hash, expires_at) VALUES (?, ?, datetime('now', ?))")
      .run(user.id, hashCode(code), `+${CODE_TTL_MIN} minutes`);
  })();
  try {
    await sendAccessCode(email, user.name.split(" ")[0], code);
  } catch (e) {
    console.error("Falha ao enviar e-mail:", e.message);
    db.prepare("UPDATE login_codes SET used = 1 WHERE user_id = ?").run(user.id);
    throw new HttpError(502, "Não foi possível enviar o e-mail agora. Tente novamente em instantes.");
  }
  res.json({ message: "Código enviado", expires_in_minutes: CODE_TTL_MIN, resend_after_seconds: RESEND_SECONDS });
}));

router.post("/client/verify-code", wrap((req, res) => {
  const { email, code } = validate(Joi.object({ email: emailSchema, code: Joi.string().pattern(/^\d{6}$/).required() }), req.body);
  const user = db.prepare("SELECT id, name, email, phone, role FROM users WHERE email = ? AND role = 'client'").get(email);
  const row = user && db.prepare("SELECT * FROM login_codes WHERE user_id = ? AND used = 0 ORDER BY id DESC LIMIT 1").get(user.id);
  if (!row) throw new HttpError(401, "Este código expirou ou já foi usado. Solicite um novo código.");
  if (db.prepare("SELECT datetime('now') > ? AS expired").get(row.expires_at).expired) throw new HttpError(401, "Este código expirou ou já foi usado. Solicite um novo código.");
  if (row.attempts >= MAX_ATTEMPTS) throw new HttpError(429, "Muitas tentativas incorretas. Solicite um novo código.");
  if (hashCode(code) !== row.code_hash) {
    db.prepare("UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?").run(row.id);
    throw new HttpError(401, "Código incorreto. Confira os números e tente novamente.");
  }
  db.prepare("UPDATE login_codes SET used = 1 WHERE id = ?").run(row.id);
  res.json({ user, token: signToken(user) });
}));

router.get("/me", requireAuth, wrap((req, res) => {
  const profile = req.user.role === "professional"
    ? db.prepare("SELECT slug, headline, bio FROM professionals WHERE user_id = ?").get(req.user.id)
    : null;
  res.json({ ...req.user, professional: profile });
}));

router.put("/me", requireAuth, wrap((req, res) => {
  const body = validate(
    Joi.object({ name: Joi.string().trim().min(2).max(120), phone: Joi.string().trim().max(30).allow("", null) }).min(1),
    req.body,
  );
  db.prepare("UPDATE users SET name = COALESCE(?, name), phone = CASE WHEN ? THEN ? ELSE phone END WHERE id = ?")
    .run(body.name ?? null, "phone" in body ? 1 : 0, body.phone || null, req.user.id);
  res.json(db.prepare("SELECT id, name, email, phone, role FROM users WHERE id = ?").get(req.user.id));
}));

router.put("/password", requireAuth, wrap((req, res) => {
  const { current_password, new_password } = validate(
    Joi.object({ current_password: Joi.string().required(), new_password: Joi.string().min(6).max(100).required() }),
    req.body,
  );
  const row = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(req.user.id);
  if (!bcrypt.compareSync(current_password, row.password_hash)) throw new HttpError(401, "A senha atual está incorreta.");
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(bcrypt.hashSync(new_password, 10), req.user.id);
  res.json({ message: "Senha alterada" });
}));

export default router;
