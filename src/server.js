import express from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import { initializeDatabase } from "./db.js";
import { errorHandler } from "./utils/http.js";
import authRoutes from "./routes/auth.js";
import publicRoutes from "./routes/public.js";
import professionalRoutes from "./routes/professional.js";
import appointmentRoutes from "./routes/appointments.js";

dotenv.config();
initializeDatabase();

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => res.json({ status: "ok", time: new Date().toISOString() }));
app.use("/api/auth", authRoutes);
app.use("/api/public", publicRoutes);
app.use("/api/professional", professionalRoutes);
app.use("/api/appointments", appointmentRoutes);

app.use((_req, res) => res.status(404).json({ error: "Recurso não encontrado." }));
app.use(errorHandler);

const port = process.env.PORT || 4100;
app.listen(port, () => console.log(`API Agenda rodando em http://localhost:${port}`));
