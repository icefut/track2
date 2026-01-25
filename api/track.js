// /api/track.js (v2 - robust)
// Hämtar Ship24 tracking och letar PostNord + CityMail tracking numbers även om de ligger "djupt" i svaret.

function mapStatusMilestoneToSwedish(milestone) {
  switch (milestone) {
    case "info_received": return "Information mottagen (försändelsen är registrerad men ej skickad än)";
    case "in_transit": return "På väg";
    case "out_for_delivery": return "Ute för leverans";
    case "available_for_pickup": return "Klar för upphämtning hos ombud";
    case "delivered": return "Levererad";
    case "failed_attempt": return "Misslyckat leveransförsök";
    case "exception": return "Problem med försändelsen";
    case "pending": return "Ingen spårningsinformation ännu";
    default: return "Okänd status";
  }
}

// Rekursiv "scanner" som hittar första sträng som matchar regex i hela objektet
function findFirstStringMatch(obj, regex) {
  const stack = [obj];
  const seen = new Set();

  while (stack.length) {
    const cur = stack.pop();
    if (!cur) continue;

    if (typeof cur === "string") {
      const s = cur.trim();
      if (regex.test(s)) return s;
      continue;
    }

    if (typeof cur !== "object") continue;
    if (seen.has(cur)) continue;
    seen.add(cur);

    if (Array.isArray(cur)) {
      for (let i = 0; i < cur.length; i++) stack.push(cur[i]);
    } else {
      for (const k of Object.keys(cur)) stack.push(cur[k]);
    }
  }
  return null;
}

function pickFromShipmentTrackingNumbers(shipment) {
  const list = Array.isArray(shipment?.trackingNumbers) ? shipment.trackingNumbers : [];
  const all = list.map((t) => (t?.tn || "").toString().trim()).filter(Boolean);

  const postnord =
    all.find((tn) => tn.startsWith("UJ") && tn.endsWith("SE")) ||
    all.find((tn) => tn.startsWith("003")) ||
    null;

  const citymail =
    all.find((tn) => tn.startsWith("BC") && tn.endsWith("CN")) ||
    null;

  return { postnord, citymail, all };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  const value = (req.query.value || "").toString().trim();
  const mode = (req.query.mode || "tracking").toString().trim();

  if (!value) return res.status(400).json({ ok: false, error: "Saknar värde (value) i query" });

  const apiKey = process.env.SHIP24_API_KEY;
  if (!apiKey) return res.status(500).json({ ok: false, error: "SHIP24_API_KEY är inte satt på servern" });

  const ship24Body = { trackingNumber: value };
  if (mode === "order") ship24Body.searchBy = "clientTrackerId";

  try {
    const response = await fetch("https://api.ship24.com/public/v1/trackers/track", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(ship24Body),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        ok: false,
        error: "Fel från Ship24",
        httpStatusFromShip24: response.status,
        raw: data,
      });
    }

    const tracking = data?.data?.trackings?.[0];
    if (!tracking) {
      return res.status(404).json({
        ok: false,
        error: "Ingen försändelse hittades hos Ship24",
        httpStatusFromShip24: response.status,
        raw: data,
      });
    }

    const tracker = tracking.tracker || {};
    const shipment = tracking.shipment || {};
    const events = Array.isArray(tracking.events) ? tracking.events : [];

    const milestone = shipment.statusMilestone || tracker.statusMilestone || null;

    // 1) Försök från shipment.trackingNumbers (snabbast om det finns)
    const picked = pickFromShipmentTrackingNumbers(shipment);

    // 2) Fallback: scanna HELA tracking-objektet (här brukar Ship24 gömma secondary TN ibland)
    const postnordRegex = /^(UJ)[A-Z0-9]+SE$|^(003)[0-9]+/;
    const citymailRegex = /^(BC)[A-Z0-9]+CN$/;

    const scannedPostnord = findFirstStringMatch(tracking, postnordRegex);
    const scannedCitymail = findFirstStringMatch(tracking, citymailRegex);

    const postnordNumber = picked.postnord || scannedPostnord || null;
    const citymailNumber = picked.citymail || scannedCitymail || null;

    const normalized = {
      ok: true,
      mode,
      httpStatusFromShip24: response.status,

      trackingNumber: tracker.trackingNumber || shipment.trackingNumber || value,
      clientTrackerId: tracker.clientTrackerId || null,

      postnordNumber,
      citymailNumber,

      // Debug (bra tills du ser att allt funkar, sen kan vi ta bort)
      allTrackingNumbers: picked.all,

      statusMilestone: milestone,
      statusSwedish: mapStatusMilestoneToSwedish(milestone),
      lastUpdate: tracking.metadata?.generatedAt || null,

      events: events.map((e) => ({
        datetime: e.datetime || e.occurrenceDatetime || null,
        location: e.location || null,
        status: e.status || null,
        courierCode: e.courierCode || null,
      })),
    };

    return res.status(200).json(normalized);
  } catch (err) {
    console.error("Ship24 API error:", err);
    return res.status(500).json({ ok: false, error: "Internt fel när Ship24 API anropades" });
  }
};
