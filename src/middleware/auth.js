import jwt from "jsonwebtoken";
import db from "../db.js";
import { HttpError } from "../utils/http.js";

export const signToken = (user) =>
  jwt.sign({ sub: user.id, role: user.role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });

export function requireAuth(req, _res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return next(new HttpError(401, "Faça login para continuar."));
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = db.prepare("SELECT id, name, email, phone, role FROM users WHERE id = ?").get(payload.sub);
    if (!user) return next(new HttpError(401, "Sua sessão não é mais válida. Faça login novamente."));
    req.user = user;
    next();
  } catch {
    next(new HttpError(401, "Sua sessão expirou. Faça login novamente."));
  }
}

export const requireRole = (role) => (req, _res, next) =>
  req.user?.role === role ? next() : next(new HttpError(403, "Você não tem permissão para acessar esta área."));
