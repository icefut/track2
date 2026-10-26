// GET /api/check-shipments  – körs av Vercel Cron (se vercel.json)
// Kollar ej levererade paket i Supabase och mejlar kunden när statusen ändras.
//
// AV som standard. Slå på genom att sätta STATUS_EMAILS_ENABLED=true i Vercel.
// Kräver: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SHIP24_API_KEY, RESEND_API_KEY, CRON_SECRET
//
// Den gamla versionen fungerade aldrig: fel Ship24-endpoint, fel auth-header och
// olika tabellnamn ("Orders" vs "orders") – därför skickades inga mejl.
"use strict";

const { supabaseConfig, supabaseRequest } = require("./_lib/orders");
const { fetchTracking, buildResult } = require("./_lib/tracking");

const SITE = process.env.TRACK_SITE_URL || "https://trackicefot.se";
const FROM = process.env.STATUS_EMAIL_FROM || "ICEFOT <no-reply@icefot.se>";
const MAX_PER_RUN = Number(process.env.CHECK_MAX_PER_RUN || 40);

// Vilka faser som ger mejl (en gång var)
const EMAILS = {
  in_sweden: {
    subject: "Ditt paket har kommit till Sverige 🇸🇪",
    text: (eta) => `Goda nyheter – ditt paket har anlänt till Sverige och hanteras nu av ${eta.carrier || "den lokala transportören"}.${eta.title ? ` Beräknad leverans: <b>${eta.title}</b>.` : ""}`,
  },
  out_for_delivery: {
    subject: "Ditt paket är snart framme",
    text: () => "Ditt paket är ute för leverans eller förbereds för utkörning och bör vara hos dig mycket snart.",
  },
  available_for_pickup: {
    subject: "Ditt paket finns att hämta",
    text: () => "Ditt paket har kommit fram till ditt utlämningsställe. Kom ihåg att hämta det i tid och ta med legitimation.",
  },
  delivered: {
    subject: "Ditt paket är levererat ✅",
    text: () => "Enligt spårningen är ditt paket levererat. Vi hoppas att du blir nöjd med din tröja! Om du har en minut blir vi jätteglada för ett omdöme.",
  },
};

function esc(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function emailHtml({ orderNumber, trackingNumber, body }) {
  const link = `${SITE}/?tn=${encodeURIComponent(trackingNumber)}`;
  return `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111">
  <div style="max-width:520px;margin:0 auto;padding:28px 16px">
    <div style="font-weight:900;letter-spacing:.12em;font-size:20px;margin-bottom:18px">ICEFOT</div>
    <div style="background:#fff;border-radius:16px;padding:24px;border:1px solid #e4e4e7">
      <p style="margin:0 0 12px">Hej!</p>
      <p style="margin:0 0 16px;line-height:1.55">${body}</p>
      <p style="margin:0 0 20px;color:#52525b;font-size:14px">Order #${esc(orderNumber)} · ${esc(trackingNumber)}</p>
      <a href="${link}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:700">Följ ditt paket</a>
    </div>
    <p style="color:#71717a;font-size:12px;margin-top:16px">Frågor? Svara på det här mejlet eller skriv till kontakt@icefot.se</p>
  </div></body></html>`;
}

async function sendEmail(to, subject, html) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to, subject, html, reply_to: "kontakt@icefot.se" }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

module.exports = async (req, res) => {
  // Endast Vercel Cron (eller du med rätt hemlighet) får köra
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  if (process.env.STATUS_EMAILS_ENABLED !== "true") {
    return res.status(200).json({ ok: true, skipped: "STATUS_EMAILS_ENABLED är inte true" });
  }
  const cfg = supabaseConfig();
  if (!cfg || !process.env.SHIP24_API_KEY || !process.env.RESEND_API_KEY) {
    return res.status(500).json({ ok: false, error: "Saknar miljövariabler" });
  }

  // Äldst kontrollerade först, bara ej levererade, max 45 dagar gamla
  const since = new Date(Date.now() - 45 * 86400000).toISOString();
  const rows = await supabaseRequest(
    `${cfg.table}?select=id,order_number,email,tracking_number,last_status&or=(last_status.is.null,last_status.not.in.(delivered,exception))&created_at=gte.${since}&order=last_checked_at.asc.nullsfirst&limit=${MAX_PER_RUN}`
  );

  const report = [];
  for (const row of rows || []) {
    try {
      const r = await fetchTracking(row.tracking_number, process.env.SHIP24_API_KEY);
      const tracking = r.json?.data?.trackings?.[0];
      const patch = { last_checked_at: new Date().toISOString() };
      if (tracking) {
        const result = buildResult(tracking, row.tracking_number);
        const phase = result.exception ? "exception" : result.phase;
        patch.last_status = phase;
        const email = EMAILS[phase];
        // Första kontrollen (last_status tom) mejlar inte – annars får alla importerade gamla ordrar mejl.
        if (email && row.last_status && phase !== row.last_status) {
          const body = email.text({ title: result.eta?.title, carrier: result.lastMile?.name });
          await sendEmail(row.email, email.subject, emailHtml({ orderNumber: row.order_number, trackingNumber: row.tracking_number, body }));
          report.push({ order: row.order_number, phase, emailed: true });
        } else {
          report.push({ order: row.order_number, phase, emailed: false });
        }
      }
      await supabaseRequest(`${cfg.table}?id=eq.${row.id}`, { method: "PATCH", body: patch, prefer: "return=minimal" });
    } catch (e) {
      report.push({ order: row.order_number, error: e.message.slice(0, 120) });
    }
  }

  return res.status(200).json({ ok: true, checked: report.length, emailed: report.filter((r) => r.emailed).length, report });
};
