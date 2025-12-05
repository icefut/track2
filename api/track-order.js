// /api/track-order.js
const ORDERS = require("./orders-data");

// Samma som i track.js
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

// Helper för IP-loggning
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
      error: "order och email krävs",
    });
  }

  const match = ORDERS.find(
    (o) =>
      o.order_number === order &&
      o.email.toLowerCase() === email
  );

  if (!match) {
    console.log("[ORDER_TRACK_NOT_FOUND]", { order, email });
    return res.status(404).json({
      ok: false,
      error: "Hittar ingen order med detta ordernummer och e-post",
    });
  }

  const trackingNumber = match.tracking_number;
  const apiKey = process.env.SHIP24_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      ok: false,
      error: "SHIP24_API_KEY saknas på servern",
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

    const tracking = data?.data?.trackings?.[0];
    if (!tracking) {
      return res.status(404).json({
        ok: false,
        error: "Ingen försändelse hittades hos Ship24",
        raw: data,
      });
    }

    const tracker = tracking.tracker || {};
    const shipment = tracking.shipment || {};
    const events = Array.isArray(tracking.events) ? tracking.events : [];

    const milestone = shipment.statusMilestone || tracker.statusMilestone || null;

    const normalized = {
      ok: true,
      mode: "order",
      trackingNumber:
        tracker.trackingNumber ||
        shipment.trackingNumber ||
        trackingNumber,
      statusMilestone: milestone,
      statusSwedish: mapStatusMilestoneToSwedish(milestone),
      lastUpdate: tracking.metadata?.generatedAt || null,
      postnordNumber:
        (shipment.trackingNumbers || [])
          .map((t) => t.tn)
          .find(
            (tn) => tn && (tn.startsWith("UJ") || tn.startsWith("003"))
          ) || null,
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
