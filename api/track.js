// api/track.js
// Serverless-funktion för Vercel som hämtar spårning från Ship24
// och returnerar ett förenklat svar + loggar allt i Vercel Logs.

function mapStatusToSwedish(milestone) {
  if (!milestone) return "Okänt status";
  switch (milestone) {
    case "info_received":
      return "Information mottagen";
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
      return "Okänt status";
  }
}

function getClientIp(req) {
  return (
    req.headers["x-forwarded-for"] ||
    req.headers["x-real-ip"] ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

module.exports = async (req, res) => {
  // CORS (för säkerhets skull, om du vill bädda in någon annanstans)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const apiKey = process.env.SHIP24_API_KEY;
  if (!apiKey) {
    console.error("[TRACK_ERROR] SHIP24_API_KEY saknas på servern");
    res
      .status(500)
      .json({ ok: false, error: "SHIP24_API_KEY är inte satt på servern" });
    return;
  }

  // trackingNumber kan heta tn eller value i query
  const trackingNumber =
    req.query.tn || req.query.value || req.query.trackingNumber;

  const ip = getClientIp(req);

  console.log(
    "[TRACK_REQUEST]",
    new Date().toISOString(),
    "trackingNumber:",
    trackingNumber,
    "ip:",
    ip
  );

  if (!trackingNumber) {
    console.error("[TRACK_ERROR] Inget trackingnummer skickat");
    res
      .status(400)
      .json({ ok: false, error: "Inget trackingnummer skickades in" });
    return;
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
        body: JSON.stringify({ trackingNumber }),
      }
    );

    const raw = await response.json();

    if (!response.ok) {
      console.error(
        "[TRACK_ERROR] Ship24 svarade inte OK",
        response.status,
        JSON.stringify(raw)
      );
      res.status(500).json({
        ok: false,
        httpStatusFromShip24: response.status,
        error: "Ship24 svarade inte OK",
        rawShip24: raw,
      });
      return;
    }

    const trackings = raw?.data?.trackings || [];
    const tracking = trackings[0];

    if (!tracking) {
      console.error("[TRACK_ERROR] Ingen tracking hittades i Ship24-svar");
      res.status(404).json({
        ok: false,
        error: "Ingen spårning hittades för detta nummer",
        rawShip24: raw,
      });
      return;
    }

    const tracker = tracking.tracker || {};
    const shipment = tracking.shipment || {};
    const events = tracking.events || [];

    // Huvudspårnummer
    const finalTrackingNumber =
      tracker.trackingNumber ||
      (Array.isArray(shipment.trackingNumbers) &&
        shipment.trackingNumbers[0]?.tn) ||
      trackingNumber;

    // Försök hitta PostNord-nummer (UJ... eller 003...)
    let postnordNumber = null;

    if (Array.isArray(shipment.trackingNumbers)) {
      for (const t of shipment.trackingNumbers) {
        if (t?.tn && /^(UJ|003)/.test(t.tn)) {
          postnordNumber = t.tn;
          break;
        }
      }
    }

    if (!postnordNumber) {
      for (const ev of events) {
        if (
          ev?.eventTrackingNumber &&
          /^(UJ|003)/.test(ev.eventTrackingNumber)
        ) {
          postnordNumber = ev.eventTrackingNumber;
          break;
        }
      }
    }

    // Status + svensk text
    const statusMilestone =
      shipment.statusMilestone || tracking.statusMilestone || null;
    const statusSwedish = mapStatusToSwedish(statusMilestone);

    // Senaste uppdatering
    let lastUpdate = null;
    if (events.length > 0) {
      const sorted = [...events].sort((a, b) => {
        const da = new Date(a.occurrenceDatetime || a.datetime || 0).getTime();
        const db = new Date(b.occurrenceDatetime || b.datetime || 0).getTime();
        return db - da; // senaste först
      });
      const latest = sorted[0];
      lastUpdate = latest.occurrenceDatetime || latest.datetime || null;
    }

    // Förenklad lista med händelser
    const simplifiedEvents = events
      .slice()
      .sort((a, b) => {
        const da = new Date(a.occurrenceDatetime || a.datetime || 0).getTime();
        const db = new Date(b.occurrenceDatetime || b.datetime || 0).getTime();
        return db - da; // senaste först
      })
      .map((ev) => ({
        dateTime: ev.occurrenceDatetime || ev.datetime || null,
        description: ev.status || "",
        location: ev.location || "",
      }));

    const result = {
      ok: true,
      httpStatusFromShip24: response.status,
      trackingNumber: finalTrackingNumber,
      orderClientId: tracker.clientTrackerId || null,
      statusMilestone,
      statusSwedish,
      postnordNumber,
      lastUpdate,
      events: simplifiedEvents,
      rawShip24: raw,
    };

    console.log(
      "[TRACK_SUCCESS]",
      finalTrackingNumber,
      "status:",
      statusSwedish,
      "postnord:",
      postnordNumber || "none"
    );

    res.status(200).json(result);
  } catch (err) {
    console.error("[TRACK_ERROR]", trackingNumber, err.message);
    res.status(500).json({
      ok: false,
      error: "Något gick fel när vi hämtade spårningen",
    });
  }
};
