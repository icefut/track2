// GET /api/track?tn=4PX3003133621569CN   (gamla ?value= fungerar också)
// Spårar valfritt nummer via Ship24 – alla transportörer.
"use strict";

const { cleanTrackingNumber, fetchTracking, buildResult } = require("./_lib/tracking");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const raw = (req.query.tn || req.query.value || "").toString();
  const tn = cleanTrackingNumber(raw);
  if (!tn) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(400).json({ ok: false, code: "invalid", error: "Det ser inte ut som ett giltigt spårningsnummer. Kontrollera att du skrivit hela numret." });
  }

  const apiKey = process.env.SHIP24_API_KEY;
  if (!apiKey) {
    console.error("SHIP24_API_KEY saknas");
    return res.status(500).json({ ok: false, code: "config", error: "Spårningen är tillfälligt otillgänglig. Försök igen om en stund." });
  }

  try {
    const r = await fetchTracking(tn, apiKey);
    const tracking = r.json?.data?.trackings?.[0];

    if (!r.ok || !tracking) {
      console.warn("[track] Ship24", r.status, JSON.stringify(r.json?.errors || r.json || {}).slice(0, 300));
      res.setHeader("Cache-Control", "public, s-maxage=60");
      const status = r.status === 429 ? 503 : r.status >= 500 ? 502 : 404;
      return res.status(status).json({
        ok: false,
        code: r.status === 429 ? "busy" : "not_found",
        error:
          r.status === 429
            ? "Många spårar just nu – försök igen om en minut."
            : "Vi hittade ingen information för det numret ännu. Nya spårningsnummer kan ta 1–3 dagar innan de börjar uppdateras.",
      });
    }

    const result = buildResult(tracking, tn);

    // Cacha på Vercels CDN: snabbare sida + färre Ship24-anrop.
    // Levererade paket ändras inte -> längre cache. Utan händelser -> kort cache.
    const ttl = result.phase === "delivered" ? 6 * 3600 : result.events.length ? 15 * 60 : 60;
    res.setHeader("Cache-Control", `public, s-maxage=${ttl}, stale-while-revalidate=${ttl * 2}`);
    return res.status(200).json(result);
  } catch (err) {
    console.error("[track] error", err && err.message);
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({ ok: false, code: "error", error: "Kunde inte hämta spårningen just nu. Försök igen om en stund." });
  }
};
