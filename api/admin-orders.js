// POST /api/admin-orders   (header: x-admin-token: <ADMIN_TOKEN>)
// Lägger in nya ordrar i Supabase. Klistra in i valfritt format på /admin.html:
//  - samma format som gamla orders-data.js  ({ order_number: "...", email: "...", tracking_number: "..." })
//  - eller en rad per order: 37157, kund@mail.se, 4PX3003133621569CN  (komma, semikolon eller tabb)
"use strict";

const crypto = require("crypto");
const { supabaseConfig, supabaseRequest, cleanOrderNumber, cleanEmail, fixTn } = require("./_lib/orders");

const EMAIL_RE = /[A-Z0-9._%+'-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const TN_RE = /\b(4?PX\d{10,}CN|[A-Z]{2}\d{9}[A-Z]{2}|[A-Z]{1,4}\d{8,}[A-Z]{0,3}|\d{12,})\b/i;

function parseOrders(text) {
  const rows = [];
  const src = String(text || "");

  // Format 1: JS-objekt som i orders-data.js
  const objRe = /order_number\s*:\s*["']?([^"',\n}]+)["']?[\s\S]*?email\s*:\s*["']([^"']+)["'][\s\S]*?tracking_number\s*:\s*["']([^"']+)["']/g;
  let m;
  while ((m = objRe.exec(src))) rows.push({ order_number: m[1], email: m[2], tracking_number: m[3] });

  // Format 2: en rad per order
  if (!rows.length) {
    for (const line of src.split(/\r?\n/)) {
      const l = line.trim();
      if (!l) continue;
      const email = (l.match(EMAIL_RE) || [])[0];
      const rest = email ? l.replace(email, " ") : l;
      const tn = (rest.match(TN_RE) || [])[0];
      const rest2 = tn ? rest.replace(tn, " ") : rest;
      const order = (rest2.match(/\b\d{3,8}\b/) || [])[0];
      if (email && tn && order) rows.push({ order_number: order, email, tracking_number: tn });
    }
  }

  const seen = new Set();
  const clean = [];
  const invalid = [];
  for (const r of rows) {
    const row = {
      order_number: cleanOrderNumber(r.order_number),
      email: cleanEmail(r.email),
      tracking_number: fixTn(r.tracking_number),
    };
    if (!row.order_number || !EMAIL_RE.test(row.email) || !/^[A-Z0-9]{6,40}$/.test(row.tracking_number)) {
      invalid.push(r);
      continue;
    }
    const key = row.order_number + "|" + row.tracking_number;
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push(row);
  }
  return { rows: clean, invalid };
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const token = process.env.ADMIN_TOKEN;
  if (!token || token.length < 12) return res.status(500).json({ ok: false, error: "ADMIN_TOKEN (minst 12 tecken) är inte satt i Vercel." });
  if (!safeEqual(req.headers["x-admin-token"], token)) return res.status(401).json({ ok: false, error: "Fel lösenord." });

  const cfg = supabaseConfig();
  if (!cfg) return res.status(500).json({ ok: false, error: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY saknas i Vercel." });

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = { text: body };
    }
  }
  const { rows, invalid } = parseOrders(body?.text || "");
  if (!rows.length) return res.status(400).json({ ok: false, error: "Hittade inga giltiga rader.", invalid: invalid.length });

  const dryRun = !!body?.dryRun;
  if (dryRun) return res.status(200).json({ ok: true, dryRun: true, count: rows.length, invalid: invalid.length, preview: rows.slice(0, 5) });

  try {
    let saved = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      await supabaseRequest(`${cfg.table}?on_conflict=order_number,tracking_number`, {
        method: "POST",
        body: chunk,
        prefer: "resolution=merge-duplicates,return=minimal",
      });
      saved += chunk.length;
    }
    return res.status(200).json({ ok: true, saved, invalid: invalid.length });
  } catch (e) {
    console.error("[admin-orders]", e.message);
    return res.status(500).json({ ok: false, error: "Kunde inte spara till Supabase: " + e.message.slice(0, 200) });
  }
};

module.exports.parseOrders = parseOrders;
