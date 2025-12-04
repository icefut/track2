// /api/track-order.js
const ORDERS = require("./orders-data");

// Helper för IP-loggning (samma som i track.js)
function getClientIp(req) {
  return (
    req.headers["x-forwarded-for"] ||
    req.headers["x-real-ip"] ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  const order = (req.query.order || "").toString().trim();
  const email = (req.query.email || "").toString().trim().toLowerCase();
  const ip = getClientIp(req);

  console.log("[ORDER_TRACK_REQUEST]", { order, email, ip });

  if (!order || !email) {
    return res.status(400).json({
      ok: false,
      error: "order och email krävs"
    });
  }

  // Hitta match i lokal data
  const match = ORDERS.find(
    (o) =>
      o.order_number === order &&
      o.email.toLowerCase() === email
  );

  if (!match) {
    console.log("[ORDER_TRACK_NOT_FOUND]", { order, email });
    return res.status(404).json({
      ok: false,
      error: "Hittar ingen order med detta ordernummer och e-post"
    });
  }

  const trackingNumber = match.tracking_number;
  const apiKey = process.env.SHIP24_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      ok: false,
      error: "SHIP24_API_KEY saknas på servern"
    });
  }

  try {
    const body = {
      trackingNumber: trackingNumber,
    };

    const response = await fetch(
      "https://api.ship24.com/public/v1/trackers/track",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.log("[ORDER_TRACK_SHIP24_ERROR]", data);
      return res.status(response.status).json({
        ok: false,
        error: "Fel från Ship24",
        raw: data,
      });
    }

    // Hämta tracking-objekt (samma som i track.js)
    const tracking = data?.data?.trackings?.[0];
    if (!tracking) {
      return res.status(404).json({
        ok: false,
        error: "Ingen försändelse hittades hos Ship24",
        raw: data,
      });
    }

    // Gör exakt samma normalisering som i track.js
    const tracker = tracking.tracker || {};
    const shipment = tracking.shipment || {};
    const events = Array.isArray(tracking.events) ? tracking.events : [];

    const milestone = shipment.statusMilestone || tracker.statusMilestone || null;

    const normalized = {
      ok: true,
      mode: "order", // viktigt för debugging
      trackingNumber: tracker.trackingNumber || shipment.trackingNumber || trackingNumber,
      statusMilestone: milestone,
      statusSwedish: milestone, // frontend mappar själv
      lastUpdate: tracking.metadata?.generatedAt || null,
      postnordNumber:
        (shipment.trackingNumbers || [])
          .map((t) => t.tn)
          .find((tn) => tn && (tn.startsWith("UJ") || tn.startsWith("003"))) ||
        null,
      events: events.map((e) => ({
        datetime: e.datetime || e.occurrenceDatetime || null,
        location: e.location || null,
        status: e.status || null,
        courierCode: e.courierCode || null,
      })),
    };

    console.log("[ORDER_TRACK_SUCCESS]", normalized.trackingNumber);

    return res.status(200).json(normalized);

  } catch (err) {
    console.log("[ORDER_TRACK_EXCEPTION]", err);
    return res.status(500).json({
      ok: false,
      error: "Internt fel när Ship24 anropades",
    });
  }
};
