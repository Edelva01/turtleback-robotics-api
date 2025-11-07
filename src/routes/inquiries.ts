import { Router } from "express";
import Joi from "joi";
import nodemailer from "nodemailer";
import { prisma } from "../prisma.js";

const router = Router();

const schema = Joi.object({
  name: Joi.string().min(2).max(100).required(),
  email: Joi.string().email().max(320).required(),
  phone: Joi.string().max(50).allow("", null, ''),
  ageGroup: Joi.string().valid("6-9", "9-13", "13+").required(),
  message: Joi.string().max(2000).allow("", null),
  source: Joi.string().max(120).default("website"),
  consent: Joi.boolean().default(true),
}).options({ stripUnknown: true });

function buildTransport() {
  const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null; // no-op if not configured
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT ?? 587),
    secure: String(SMTP_SECURE ?? "false") === "true",
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

// Public: create inquiry  -> POST /api/inquiries
router.post("/", async (req, res) => {
  const { value, error } = schema.validate(req.body, { abortEarly: false });
  if (error) return res.status(400).json({ ok: false, errors: error.details.map(d => d.message) });

  const rec = await prisma.inquiry.create({ data: value });

  // Best-effort notification email
  try {
    const t = buildTransport();
    if (t) {
      await t.sendMail({
        from: process.env.MAIL_FROM ?? "Turtleback Robotics Academy <noreply@example.com>",
        to: process.env.MAIL_TO ?? process.env.SMTP_USER,
        subject: `New Inquiry: ${value.name} (${value.ageGroup})`,
        text: JSON.stringify({ ...value, createdAt: rec.createdAt }, null, 2),
      });
    }
  } catch (err) {
    console.warn("[mail] send failed:", (err as Error).message);
  }

  return res.status(201).json({ ok: true, id: rec.id });
});

// Admin: list inquiries -> GET /api/admin/inquiries
// (we mount this same router at /api/admin/inquiries in server.ts)
router.get("/", async (req, res) => {
  if (req.header("x-admin-token") !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  const rows = await prisma.inquiry.findMany({ orderBy: { createdAt: "desc" } });
  return res.json({ ok: true, data: rows });
});

// (optional) Admin: get one by id -> GET /api/admin/inquiries/:id
router.get("/:id", async (req, res) => {
  if (req.header("x-admin-token") !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  const row = await prisma.inquiry.findUnique({ where: { id: req.params.id } });
  if (!row) return res.status(404).json({ ok: false, error: "not_found" });
  return res.json({ ok: true, data: row });
});

export default router;

