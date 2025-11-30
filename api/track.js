// /api/track.js
// Vercel serverless-funktion som anropar Ship24 API
// och kan söka antingen på spårningsnummer (4PX)
// eller på ordernummer via clientTrackerId.

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

module.exports = async (req, res) => {
  // CORS + JSON
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  const value = (req.query.value || "").toString().trim();
  const mode = (req.query.mode || "tracking").toString().trim(); // "tracking" | "order"

  if (!value) {
    res.status(400).json({ ok: false, error: "Saknar värde (value) i query" });
    return;
  }

  const apiKey = process.env.SHIP24_API_KEY;
  if (!apiKey) {
    res
      .status(500)
      .json({ ok: false, error: "SHIP24_API_KEY är inte satt på servern" });
    return;
  }

  // Bygg body till Ship24
  // Vi använder samma endpoint som tidigare: /public/v1/trackers/track
  // MEN om mode=order så talar vi om att vi söker via clientTrackerId.
  const ship24Body = {
    trackingNumber: value,
  };

  if (mode === "order") {
    // Här är den viktiga delen: vi säger till Ship24
    // att trackingNumber-fältet ska tolkas som clientTrackerId.
    ship24Body.searchBy = "clientTrackerId";
  }

  try {
    const response = await fetch(
      "https://api.ship24.com/public/v1/trackers/track",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(ship24Body),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      res.status(response.status).json({
        ok: false,
        error: "Fel från Ship24",
        httpStatusFromShip24: response.status,
        raw: data,
      });
      return;
    }

    // Normera Ship24-svaret
    const tracking = data?.data?.trackings?.[0];
    if (!tracking) {
      res.status(404).json({
        ok: false,
        error: "Ingen försändelse hittades hos Ship24",
        httpStatusFromShip24: response.status,
        raw: data,
      });
      return;
    }

    const tracker = tracking.tracker || {};
    const shipment = tracking.shipment || {};
    const events = Array.isArray(tracking.events) ? tracking.events : [];

    const milestone = shipment.statusMilestone || tracker.statusMilestone || null;

    const normalized = {
      ok: true,
      mode, // "tracking" eller "order"
      httpStatusFromShip24: response.status,
      trackingNumber: tracker.trackingNumber || shipment.trackingNumber || value,
      clientTrackerId: tracker.clientTrackerId || null,
      postnordNumber:
        (shipment.trackingNumbers || [])
          .map((t) => t.tn)
          .find((tn) => tn && (tn.startsWith("UJ") || tn.startsWith("003"))) ||
        null,
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

    res.status(200).json(normalized);
  } catch (err) {
    console.error("Ship24 API error:", err);
    res.status(500).json({
      ok: false,
      error: "Internt fel när Ship24 API anropades",
    });
  }
};
