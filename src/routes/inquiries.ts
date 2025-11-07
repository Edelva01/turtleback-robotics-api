import { Router } from "express";
import Joi from "joi";
import { prisma } from "../prisma.js";

const router = Router();

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
          SELECT id, code FROM age_groups WHERE code IN (${prisma.join(ageGroups)}) AND active = true ORDER BY sort_order;`;

        if (!agRows.length) throw new Error("Invalid age group codes");
        const primaryAgeGroupId = agRows[0].id;

        await tx.$executeRaw`
          INSERT INTO inquiry_parent (inquiry_id, number_of_kids, primary_age_group_id)
          VALUES (${inquiryId}, ${numberOfKids ?? 1}, ${primaryAgeGroupId});`;

        // Insert selected age groups
        const inserts = agRows.map(r => tx.$executeRaw`
          INSERT INTO inquiry_age_groups (inquiry_id, age_group_id)
          VALUES (${inquiryId}, ${r.id})
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
          VALUES (${inquiryId}, ${org[0].id}, ${orgType === 'other' ? orgTypeOther : null}, ${orgName});`;

        return inquiryId;
      });

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
  const rows = await prisma.$queryRaw<any[]>`SELECT * FROM inquiries ORDER BY created_at DESC LIMIT 200;`;
  return res.json({ ok: true, data: rows });
});

export default router;

