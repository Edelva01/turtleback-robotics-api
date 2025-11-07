// server.ts
import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import inquiries from "./routes/inquiries.js";

const app = express();

app.use(helmet());
app.use(cors({ origin: (process.env.CORS_ORIGIN?.split(",") ?? ["http://localhost:5173"]) }));
app.use(express.json({ limit: "1mb" }));
app.use(morgan("dev"));
app.use(rateLimit({ windowMs: 60_000, max: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 60) }));

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "tra-api" }));

// Mount routers correctly
app.use("/api/inquiries", inquiries);           // POST /api/inquiries
app.use("/api/admin/inquiries", inquiries);     // GET /api/admin/inquiries (token header)

// Optional: 404 for API
app.use("/api", (_req, res) => res.status(404).json({ ok: false, error: "not_found" }));

const port = Number(process.env.PORT ?? process.env.API_PORT ?? 5174);
app.listen(port, () => console.log(`[api] listening on :${port}`));
