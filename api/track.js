// /api/track.js
// Vercel serverless-funktion som anropar Ship24 API
// Returnerar både PostNord-nummer och CityMail-nummer om de finns.

function mapStatusMilestoneToSwedish(milestone) {
  switch (milestone) {
    case "info_received":
      return "Information mottagen (försändelsen är registrerad men ej skickad än)";
    case "in_transit":
      return "På väg";
    case "out_for_delivery":
      return "Ute för leverans";
    case "available_for_pickup":
      return "Klar för upphämtning hos ombud";
    case "delivered":
      return "Levererad";
    case "failed_attempt":
      return "Misslyckat leveransförsök";
    case "exception":
      return "Problem med försändelsen";
    case "pending":
      return "Ingen spårningsinformation ännu";
    default:
      return "Okänd status";
  }
}

function pickTrackingNumbers(shipment) {
  const list = Array.isArray(shipment?.trackingNumbers) ? shipment.trackingNumbers : [];

  // Alla tn som strängar
  const all = list.map((t) => (t?.tn || "").toString().trim()).filter(Boolean);

  // PostNord: ofta UJ...SE eller 003...
  const postnord =
    all.find((tn) => tn.startsWith("UJ") && tn.endsWith("SE")) ||
    all.find((tn) => tn.startsWith("003")) ||
    null;

  // CityMail (enligt dig): BC....CN
  const citymail =
    all.find((tn) => tn.startsWith("BC") && tn.endsWith("CN")) ||
    null;

  return { postnordNumber: postnord, citymailNumber: citymail, allTrackingNumbers: all };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  const value = (req.query.value || "").toString().trim();
  const mode = (req.query.mode || "tracking").toString().trim(); // "tracking" | "order"

  if (!value) return res.status(400).json({ ok: false, error: "Saknar värde (value) i query" });

  const apiKey = process.env.SHIP24_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ ok: false, error: "SHIP24_API_KEY är inte satt på servern" });
  }

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

    // 👇 NYTT: plocka både PostNord & CityMail
    const { postnordNumber, citymailNumber, allTrackingNumbers } = pickTrackingNumbers(shipment);

    const normalized = {
      ok: true,
      mode,
      httpStatusFromShip24: response.status,

      trackingNumber: tracker.trackingNumber || shipment.trackingNumber || value,
      clientTrackerId: tracker.clientTrackerId || null,

      postnordNumber,
      citymailNumber,

      // valfritt men bra för debug:
      allTrackingNumbers,

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
