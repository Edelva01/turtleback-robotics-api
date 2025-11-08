import { Router } from "express";
import Joi from "joi";
import { prisma } from "../prisma.js";
import { Prisma } from "@prisma/client";
import nodemailer from "nodemailer";

const router = Router();

// Lightweight notifier (Slack webhook via env SLACK_WEBHOOK_URL)
const gfetch: any = (globalThis as any).fetch?.bind(globalThis);
async function notify(text: string) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url || !gfetch) return;
  try {
    await gfetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (e: any) {
    console.warn("[notify] slack error:", e?.message || e);
  }
}

// Email notification via Resend (optional)
async function sendEmail(subject: string, text: string, html?: string) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  const to = process.env.RESEND_TO;
  if (!key || !from || !to || !gfetch) return;
  const recipients = to.split(/\s*,\s*/).filter(Boolean);
  if (!recipients.length) return;
  try {
    const resp = await gfetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: recipients, subject, text, html }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      console.warn("[notify] resend error:", resp.status, body);
    }
  } catch (e: any) {
    console.warn("[notify] resend exception:", e?.message || e);
  }
}

// Email via SMTP (Gmail or other). Uses send-as alias via SMTP_FROM.
async function sendSMTPEmail({
  to,
  subject,
  text,
  html,
}: {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
}) {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 465);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || user;
  if (!host || !user || !pass) return; // disabled
  try {
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465, // true for 465, false for 587/STARTTLS
      auth: { user, pass },
    });

    await transporter.sendMail({
      from,
      to,
      subject,
      text,
      html,
    });
  } catch (e: any) {
    console.warn("[notify] smtp error:", e?.message || e);
  }
}

// Parent payload
const parentSchema = Joi.object({
  firstName: Joi.string().min(1).max(100).required(),
  lastName: Joi.string().min(1).max(100).required(),
  email: Joi.string().email().max(320).required(),
  phone: Joi.string().max(50).allow("", null),
  numberOfKids: Joi.number().integer().min(1).max(12).default(1),
  ageGroups: Joi.array()
    .items(Joi.string().valid("6-9", "9-13", "13-16", "16+"))
    .min(1)
    .required(),
  message: Joi.string().max(2000).allow("", null),
  newsletterOptIn: Joi.boolean().default(false),
  consent: Joi.boolean().valid(true).required(),
  source: Joi.string().max(120).default("website"),
  pagePath: Joi.string().max(512).allow("", null)
}).options({ stripUnknown: true });

// Partner payload
const partnerSchema = Joi.object({
  orgType: Joi.string().valid(
    "government","nonprofit","school","library","corporate_sponsor","faith_community","other"
  ).required(),
  orgTypeOther: Joi.string().max(200).when("orgType", { is: "other", then: Joi.required() }),
  orgName: Joi.string().min(2).max(200).required(),
  firstName: Joi.string().min(1).max(100).required(),
  lastName: Joi.string().min(1).max(100).required(),
  email: Joi.string().email().max(320).required(),
  phone: Joi.string().max(50).allow("", null),
  message: Joi.string().max(2000).allow("", null),
  consent: Joi.boolean().valid(true).required(),
  source: Joi.string().max(120).default("partners-page"),
  pagePath: Joi.string().max(512).allow("", null)
}).options({ stripUnknown: true });

// POST /api/inquiries (parent or partner)
router.post("/", async (req, res) => {
  const isPartner = "orgType" in req.body || req.body?.source === "partners-page";
  const { value, error } = (isPartner ? partnerSchema : parentSchema)
    .validate(req.body, { abortEarly: false });

  if (error) {
    return res.status(400).json({ ok: false, errors: error.details.map(d => d.message) });
  }

  try {
    if (!isPartner) {
      // Parent inquiry
      const {
        firstName, lastName, email, phone, message, numberOfKids,
        ageGroups, newsletterOptIn, source, pagePath
      } = value as any;

      const fullName = `${firstName} ${lastName}`.trim();

      const result = await prisma.$transaction(async (tx) => {
        // Insert inquiry
        const inserted = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO inquiries
            (kind, first_name, last_name, full_name, email, phone, message, newsletter_opt_in,
             consent, consent_at, source, page_path, status, spam_flag)
          VALUES
            ('parent', ${firstName}, ${lastName}, ${fullName}, ${email}, ${phone ?? null}, ${message ?? null},
             ${!!newsletterOptIn}, true, now(), ${source}, ${pagePath ?? null}, 'new', false)
          RETURNING id;`;

        const inquiryId = inserted[0].id;

        // Look up age group ids by code (ordered)
        const agRows = await tx.$queryRaw<{ id: string, code: string }[]>`
          SELECT id, code FROM age_groups WHERE code IN (${Prisma.join(ageGroups)}) AND active = true ORDER BY sort_order;`;

        if (!agRows.length) throw new Error("Invalid age group codes");
        const primaryAgeGroupId = agRows[0].id;

        await tx.$executeRaw`
          INSERT INTO inquiry_parent (inquiry_id, number_of_kids, primary_age_group_id)
          VALUES (CAST(${inquiryId} AS uuid), ${numberOfKids ?? 1}, CAST(${primaryAgeGroupId} AS uuid));`;

        // Insert selected age groups
        const inserts = agRows.map(r => tx.$executeRaw`
          INSERT INTO inquiry_age_groups (inquiry_id, age_group_id)
          VALUES (CAST(${inquiryId} AS uuid), CAST(${r.id} AS uuid))
          ON CONFLICT DO NOTHING;`);
        await Promise.all(inserts);

        if (newsletterOptIn) {
          await tx.$executeRaw`
            INSERT INTO newsletter_subscriptions
              (email, first_name, last_name, status, double_opt_in, source, subscribed_at, updated_at)
            VALUES
              (${email}, ${firstName}, ${lastName}, 'subscribed', false, ${source}, now(), now())
            ON CONFLICT (email) DO UPDATE
              SET first_name = EXCLUDED.first_name,
                  last_name  = EXCLUDED.last_name,
                  status     = 'subscribed',
                  updated_at = now();`;
        }

        return inquiryId;
      });

      // Fire-and-forget notifications
      const parentSummary =
        `New Parent Inquiry\n` +
        `Name: ${firstName} ${lastName}\n` +
        `Email: ${email}  Phone: ${phone || "-"}\n` +
        `Kids: ${numberOfKids ?? 1}  Ages: ${(ageGroups || []).join(", ")}\n` +
        `Message: ${(message ?? "").slice(0, 500)}\n` +
        `Page: ${pagePath || "-"}  Source: ${source}`;
      notify(parentSummary);
      // Prefer SMTP if configured, else Resend
      if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
        const internalTo = (process.env.SMTP_TO || "").split(/\s*,\s*/).filter(Boolean);
        if (internalTo.length) {
          sendSMTPEmail({ to: internalTo, subject: `New Parent Inquiry — ${firstName} ${lastName}`, text: parentSummary });
        }
        // Parent receipt
        sendSMTPEmail({
          to: email,
          subject: "We received your inquiry — Turtleback Robotics Academy",
          text:
            `Hi ${firstName},\n\n` +
            `Thanks for your interest in Turtleback Robotics Academy! ` +
            `We received your request and will follow up within 1–2 business days.\n\n` +
            `Summary:\n` +
            `- Kids: ${numberOfKids ?? 1}\n` +
            `- Age groups: ${(ageGroups || []).join(", ")}\n\n` +
            `If you have updates, just reply to this email.\n\n` +
            `— Turtleback Robotics Team`,
        });
      } else {
        sendEmail(
          `New Parent Inquiry — ${firstName} ${lastName}`,
          parentSummary
        );
      }

      return res.status(201).json({ ok: true, id: result });
    } else {
      // Partner inquiry
      const {
        orgType, orgTypeOther, orgName, firstName, lastName,
        email, phone, message, source, pagePath
      } = value as any;

      const fullName = `${firstName} ${lastName}`.trim();

      const result = await prisma.$transaction(async (tx) => {
        const inserted = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO inquiries
            (kind, first_name, last_name, full_name, email, phone, message, newsletter_opt_in,
             consent, consent_at, source, page_path, status, spam_flag)
          VALUES
            ('partner', ${firstName}, ${lastName}, ${fullName}, ${email}, ${phone ?? null}, ${message ?? null},
             false, true, now(), ${source}, ${pagePath ?? null}, 'new', false)
          RETURNING id;`;

        const inquiryId = inserted[0].id;

        const org = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM organization_types WHERE code = ${orgType} AND active = true LIMIT 1;`;
        if (!org.length) throw new Error("Invalid organization type");

        await tx.$executeRaw`
          INSERT INTO inquiry_partner (inquiry_id, org_type_id, org_type_other, org_name)
          VALUES (CAST(${inquiryId} AS uuid), CAST(${org[0].id} AS uuid), ${orgType === 'other' ? orgTypeOther : null}, ${orgName});`;

        return inquiryId;
      });

      // Fire-and-forget notifications
      const partnerSummary =
        `New Partner Inquiry\n` +
        `Org: ${orgName}  Type: ${orgType}${orgType === 'other' && orgTypeOther ? ` (${orgTypeOther})` : ''}\n` +
        `Contact: ${firstName} ${lastName}  Email: ${email}  Phone: ${phone || "-"}\n` +
        `Message: ${(message ?? "").slice(0, 500)}\n` +
        `Page: ${pagePath || "-"}  Source: ${source}`;
      notify(partnerSummary);
      if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
        const internalTo = (process.env.SMTP_TO || "").split(/\s*,\s*/).filter(Boolean);
        if (internalTo.length) {
          sendSMTPEmail({ to: internalTo, subject: `New Partner Inquiry — ${orgName}`, text: partnerSummary });
        }
        // Partner receipt (send to contact email)
        sendSMTPEmail({
          to: email,
          subject: "We received your partnership inquiry — Turtleback Robotics Academy",
          text:
            `Hi ${firstName},\n\n` +
            `Thanks for reaching out about partnering. ` +
            `We received your request and will follow up within 1–2 business days.\n\n` +
            `Summary:\n` +
            `- Organization: ${orgName}\n` +
            `- Type: ${orgType}${orgType === 'other' && orgTypeOther ? ` (${orgTypeOther})` : ''}\n\n` +
            `If you have updates, just reply to this email.\n\n` +
            `— Turtleback Robotics Team`,
        });
      } else {
        sendEmail(
          `New Partner Inquiry — ${orgName}`,
          partnerSummary
        );
      }

      return res.status(201).json({ ok: true, id: result });
    }
  } catch (e: any) {
    console.error("[inquiries] error:", e.message);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// Lookups (optional)
router.get("/lookups/age-groups", async (_req, res) => {
  const rows = await prisma.$queryRaw<{ code: string; label: string }[]>`
    SELECT code, label FROM age_groups WHERE active = true ORDER BY sort_order;`;
  res.json({ ok: true, data: rows });
});

router.get("/lookups/org-types", async (_req, res) => {
  const rows = await prisma.$queryRaw<{ code: string; label: string }[]>`
    SELECT code, label FROM organization_types WHERE active = true ORDER BY sort_order;`;
  res.json({ ok: true, data: rows });
});

// Admin minimal listing (token header)
router.get("/admin", async (req, res) => {
  if (req.header("x-admin-token") !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  const status = (req.query.status as string) || undefined;
  const q = (req.query.q as string) || undefined;
  if (status) {
    const rows = await prisma.$queryRaw<any[]>`
      SELECT * FROM inquiries
      WHERE status = ${status}
        AND (${q ?? null} IS NULL OR (full_name ILIKE '%' || ${q ?? ''} || '%' OR email ILIKE '%' || ${q ?? ''} || '%'))
      ORDER BY created_at DESC
      LIMIT 200;`;
    return res.json({ ok: true, data: rows });
  } else {
    const rows = await prisma.$queryRaw<any[]>`
      SELECT * FROM inquiries
      WHERE (${q ?? null} IS NULL OR (full_name ILIKE '%' || ${q ?? ''} || '%' OR email ILIKE '%' || ${q ?? ''} || '%'))
      ORDER BY created_at DESC
      LIMIT 200;`;
    return res.json({ ok: true, data: rows });
  }
});

// Update inquiry status: new | read | archived
router.patch("/admin/:id/status", async (req, res) => {
  if (req.header("x-admin-token") !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  const id = req.params.id;
  const status = (req.body?.status as string) || "";
  const allowed = new Set(["new", "read", "archived"]);
  if (!allowed.has(status)) {
    return res.status(400).json({ ok: false, error: "invalid_status" });
  }
  await prisma.$executeRaw`
    UPDATE inquiries SET status = ${status}, updated_at = now()
    WHERE id = CAST(${id} AS uuid)`;
  return res.json({ ok: true });
});

export default router;
