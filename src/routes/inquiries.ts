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
async function sendEmail(
  subject: string,
  text: string,
  html?: string,
  toOverride?: string | string[],
  bccOverride?: string | string[],
  replyToOverride?: string | string[]
) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  const to = process.env.RESEND_TO;
  if (!key || !from || (!to && !toOverride) || !gfetch) return;
  const recipients = toOverride
    ? (Array.isArray(toOverride) ? toOverride : [toOverride])
    : (to!.split(/\s*,\s*/).filter(Boolean));
  const bccEnv = process.env.RESEND_BCC;
  const bcc = bccOverride
    ? (Array.isArray(bccOverride) ? bccOverride : [bccOverride])
    : (bccEnv ? bccEnv.split(/\s*,\s*/).filter(Boolean) : undefined);
  const replyToEnv = process.env.RESEND_REPLY_TO;
  const reply_to = replyToOverride
    ? (Array.isArray(replyToOverride) ? replyToOverride : [replyToOverride])
    : (replyToEnv ? replyToEnv.split(/\s*,\s*/).filter(Boolean) : undefined);
  if (!recipients.length) return;
  try {
    const resp = await gfetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: recipients, subject, text, html, bcc, reply_to }),
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
        // Internal summary
        sendEmail(
          `New Parent Inquiry — ${firstName} ${lastName}`,
          parentSummary
        );
        // Parent receipt via Resend (HTML + reply-to + optional BCC)
        const logoUrl = process.env.EMAIL_LOGO_URL || '';
        const sigName = process.env.EMAIL_SIGNATURE_NAME || 'Eloi Delva';
        const sigTitle = process.env.EMAIL_SIGNATURE_TITLE || 'CEO';
        const sigEmail = process.env.EMAIL_SIGNATURE_EMAIL || 'robotics@elovainc.com';
        const sigAddress = process.env.EMAIL_SIGNATURE_ADDRESS || 'Turtleback Robotics Academy • 6815 Commons Drive • Prince George, VA 23875';
        const privacyText = process.env.EMAIL_PRIVACY_TEXT || 'We respect your privacy. We use your information only to respond to your inquiry and provide program updates you opt into. We do not sell or share personal information.';
        const privacyUrl = process.env.EMAIL_PRIVACY_URL || '';
        const niceHtml = `
          <table width="100%" cellpadding="0" cellspacing="0" style="font-family:Segoe UI,Arial,sans-serif;background:#f8fafc;padding:24px 0;">
            <tr>
              <td align="center">
                <table width="640" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:24px;">
                  <tr>
                    <td>
                      ${logoUrl ? `<div style=\"text-align:center;margin:0 0 16px\"><img src=\"${logoUrl}\" alt=\"Turtleback Robotics Academy\" height=\"56\" style=\"display:inline-block\"/></div>` : ''}
                      <h1 style="margin:0 0 8px;font-size:22px;color:#0f172a;">Thank you for contacting Turtleback Robotics Academy</h1>
                      <p style="margin:0 0 16px;color:#334155;font-size:16px;">Hi ${firstName},</p>
                      <p style="margin:0 0 16px;color:#334155;font-size:16px;">We’re excited that you’re considering our programs—great choice! Hands‑on robotics builds real‑world problem solving, creativity, and confidence. Our team has received your request and will follow up within 1–2 business days.</p>
                      <p style="margin:0 0 12px;color:#334155;font-size:16px;">Congratulations on taking a powerful step for your child’s growth. We care deeply about young learners and the communities we serve, and we’re honored to partner with you in their journey.</p>
                      <p style="margin:0 0 16px;color:#334155;font-size:16px;">Our classes strengthen STEM — <strong>Science, Technology, Engineering, and Mathematics</strong> — through meaningful projects, collaborative teamwork, and thoughtful coaching. Students develop creativity, perseverance, and communication while building real robots and solving authentic challenges.</p>
                      <div style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:8px;padding:12px 16px;margin:16px 0;">
                        <p style="margin:0 0 8px;color:#0f172a;font-weight:600;">Summary</p>
                        <ul style="margin:0;color:#334155;padding-left:18px;">
                          <li>Kids: ${numberOfKids ?? 1}</li>
                          <li>Age groups: ${(ageGroups || []).join(", ")}</li>
                        </ul>
                      </div>
                      <p style="margin:0 0 8px;color:#334155;font-size:16px;">If you have any updates or questions, simply reply to this email.</p>
                      <p style="margin:0 0 4px;color:#334155;font-size:16px;">— ${sigName}${sigTitle ? `, ${sigTitle}` : ''}</p>
                      <p style="margin:0 0 8px;color:#64748b;font-size:14px;">${sigAddress}${sigEmail ? ` • <a href=\"mailto:${sigEmail}\">${sigEmail}</a>` : ''}</p>
                      <hr style="border:none;border-top:1px solid #e2e8f0;margin:16px 0;"/>
                      <p style="margin:0;color:#94a3b8;font-size:12px;line-height:1.5;">${privacyText}${privacyUrl ? ` <a href=\"${privacyUrl}\">Privacy Policy</a>.` : ''}</p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>`;
        const replyTo = process.env.RESEND_REPLY_TO || (process.env.RESEND_FROM || '').match(/<([^>]+)>/)?.[1] || undefined;
        sendEmail(
          "Thanks for your interest — Turtleback Robotics Academy",
          `Hi ${firstName},\n\nWe’re excited that you’re considering our programs—great choice! Our team received your request and will follow up within 1–2 business days.\n\nCongratulations on taking a powerful step for your child’s growth. Our classes strengthen STEM (Science, Technology, Engineering, and Mathematics) while building creativity, teamwork, problem solving, and confidence.\n\nSummary\n- Kids: ${numberOfKids ?? 1}\n- Age groups: ${(ageGroups || []).join(", ")}\n\nReply to this email with any questions.\n\n— ${sigName}${sigTitle ? ", " + sigTitle : ""}\n${sigAddress}${sigEmail ? "\n" + sigEmail : ""}\n\nPrivacy: ${privacyText}${privacyUrl ? ` (${privacyUrl})` : ''}`,
          niceHtml,
          email,
          undefined,
          replyTo
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
        // Internal summary
        sendEmail(
          `New Partner Inquiry — ${orgName}`,
          partnerSummary
        );
        // Partner receipt via Resend (logo + signature + privacy)
        const logoUrl2 = process.env.EMAIL_LOGO_URL || '';
        const sigName2 = process.env.EMAIL_SIGNATURE_NAME || 'Eloi Delva';
        const sigTitle2 = process.env.EMAIL_SIGNATURE_TITLE || 'CEO';
        const sigEmail2 = process.env.EMAIL_SIGNATURE_EMAIL || 'robotics@elovainc.com';
        const sigAddress2 = process.env.EMAIL_SIGNATURE_ADDRESS || 'Turtleback Robotics Academy • 6815 Commons Drive • Prince George, VA 23875';
        const privacyText2 = process.env.EMAIL_PRIVACY_TEXT || 'We respect your privacy. We use your information only to respond to your inquiry and provide program updates you opt into. We do not sell or share personal information.';
        const privacyUrl2 = process.env.EMAIL_PRIVACY_URL || '';
        const partnerHtml = `
          <table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"font-family:Segoe UI,Arial,sans-serif;background:#f8fafc;padding:24px 0;\">\n            <tr>\n              <td align=\"center\">\n                <table width=\"640\" cellpadding=\"0\" cellspacing=\"0\" style=\"background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:24px;\">\n                  <tr>\n                    <td>\n                      ${logoUrl2 ? `<div style=\\\"text-align:center;margin:0 0 16px\\\"><img src=\\\"${logoUrl2}\\\" alt=\\\"Turtleback Robotics Academy\\\" height=\\\"56\\\" style=\\\"display:inline-block\\\"/></div>` : ''}
                      <h1 style=\"margin:0 0 8px;font-size:22px;color:#0f172a;\">Thank you for your partnership inquiry</h1>\n                      <p style=\"margin:0 0 16px;color:#334155;font-size:16px;\">Hi ${firstName},</p>\n                      <p style=\"margin:0 0 16px;color:#334155;font-size:16px;\">We appreciate your interest in partnering with Turtleback Robotics Academy. Our team will follow up within 1–2 business days to discuss next steps.</p>\n                      <div style=\"background:#f1f5f9;border:1px solid #e2e8f0;border-radius:8px;padding:12px 16px;margin:16px 0;\">\n                        <p style=\"margin:0 0 8px;color:#0f172a;font-weight:600;\">Summary</p>\n                        <ul style=\"margin:0;color:#334155;padding-left:18px;\">\n                          <li>Organization: ${orgName}</li>\n                          <li>Type: ${orgType}${orgType === 'other' && orgTypeOther ? ` (${orgTypeOther})` : ''}</li>\n                        </ul>\n                      </div>\n                      <p style=\"margin:0 0 8px;color:#334155;font-size:16px;\">If you have any updates or questions, simply reply to this email.</p>\n                      <p style=\"margin:0 0 4px;color:#334155;font-size:16px;\">— ${sigName2}${sigTitle2 ? `, ${sigTitle2}` : ''}</p>\n                      <p style=\"margin:0 0 8px;color:#64748b;font-size:14px;\">${sigAddress2}${sigEmail2 ? ` • <a href=\"mailto:${sigEmail2}\">${sigEmail2}</a>` : ''}</p>\n                      <hr style=\"border:none;border-top:1px solid #e2e8f0;margin:16px 0;\"/>\n                      <p style=\"margin:0;color:#94a3b8;font-size:12px;line-height:1.5;\">${privacyText2}${privacyUrl2 ? ` <a href=\"${privacyUrl2}\">Privacy Policy</a>.` : ''}</p>\n                    </td>\n                  </tr>\n                </table>\n              </td>\n            </tr>\n          </table>`;
        const replyTo2 = process.env.RESEND_REPLY_TO || (process.env.RESEND_FROM || '').match(/<([^>]+)>/)?.[1] || undefined;
        sendEmail(
          "Thank you — Turtleback Robotics Academy",
          `Hi ${firstName},\n\nWe appreciate your interest in partnering with Turtleback Robotics Academy. Our team will follow up within 1–2 business days.\n\nSummary\n- Organization: ${orgName}\n- Type: ${orgType}${orgType === 'other' && orgTypeOther ? ` (${orgTypeOther})` : ''}\n\nReply to this email with any questions.\n\n— ${sigName2}${sigTitle2 ? ", " + sigTitle2 : ""}\n${sigAddress2}${sigEmail2 ? "\n" + sigEmail2 : ""}\n\nPrivacy: ${privacyText2}${privacyUrl2 ? ` (${privacyUrl2})` : ''}`,
          partnerHtml,
          email,
          undefined,
          replyTo2
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
