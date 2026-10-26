// GET /api/track-order?order=37157&email=kund@exempel.se
// Slår upp ordern och returnerar spårning för det senaste paketet
// (+ lista med alla paket om ordern skickats i flera/omskick).
"use strict";

const { findTrackingNumbers } = require("./_lib/orders");
const { fetchTracking, buildResult } = require("./_lib/tracking");

const NOT_SHIPPED =
  "Vi hittar inget skickat paket för den ordern ännu. Det betyder oftast att ordern fortfarande packas – du får ett mejl med spårningsnummer så fort den skickats. Kontrollera också att ordernummer och e-post stämmer.";

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const order = (req.query.order || "").toString();
  const email = (req.query.email || "").toString();

  if (!order.trim() || !email.trim()) {
    return res.status(400).json({ ok: false, code: "invalid", error: "Fyll i både ordernummer och e-postadress." });
  }

  try {
    const numbers = await findTrackingNumbers(order, email);
    if (!numbers.length) {
      return res.status(404).json({ ok: false, code: "not_shipped", error: NOT_SHIPPED });
    }

    const apiKey = process.env.SHIP24_API_KEY;
    if (!apiKey) return res.status(500).json({ ok: false, code: "config", error: "Spårningen är tillfälligt otillgänglig." });

    const tn = numbers[0];
    const r = await fetchTracking(tn, apiKey, { orderNumber: order.replace(/\D/g, "") || undefined });
    const tracking = r.json?.data?.trackings?.[0];

    if (!r.ok || !tracking) {
      // Ordern är skickad men transportören har inte skannat den än
      return res.status(200).json({
        ok: true,
        trackingNumber: tn,
        packages: numbers,
        phase: "pending",
        progress: { pct: 4, step: 0 },
        carriers: [],
        lastMile: null,
        eta: {
          state: "unknown",
          title: "Inväntar första skanning",
          subtitle: "Din order är skickad. Spårningen brukar börja uppdateras inom 1–3 dagar.",
        },
        events: [],
      });
    }

    const result = buildResult(tracking, tn);
    result.packages = numbers;
    return res.status(200).json(result);
  } catch (err) {
    console.error("[track-order] error", err && err.message);
    return res.status(502).json({ ok: false, code: "error", error: "Kunde inte hämta ordern just nu. Försök igen om en stund." });
  }
};
