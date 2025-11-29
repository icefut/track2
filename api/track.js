const https = require("https");

function mapStatusToSwedish(milestone) {
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
    default:
      return "Ingen spårningsinformation ännu";
  }
}

const postnordRegex = /(UJ[0-9A-Z]{8,}|003[0-9]{8,})/;

function callShip24(apiKey, trackingNumber) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ trackingNumber });

    const options = {
      hostname: "api.ship24.com",
      path: "/public/v1/trackers/track",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          resolve({ statusCode: res.statusCode, body: json });
        } catch (err) {
          reject(new Error("Kunde inte tolka svar från Ship24: " + err.message));
        }
      });
    });

    req.on("error", (err) => {
      reject(err);
    });

    req.write(body);
    req.end();
  });
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const tn = req.query.tn;
  const apiKey = process.env.SHIP24_API_KEY;

  // Svara alltid med 200, men tala om om något är fel
  try {
    if (!tn) {
      res.status(200).json({
        ok: false,
        stage: "input",
        error: "Saknar tn (trackingnummer) i queryn",
      });
      return;
    }

    if (!apiKey) {
      res.status(200).json({
        ok: false,
        stage: "env",
        error: "SHIP24_API_KEY är inte satt på servern",
      });
      return;
    }

    const { statusCode, body } = await callShip24(apiKey, tn);

    if (statusCode < 200 || statusCode >= 300) {
      res.status(200).json({
        ok: false,
        stage: "ship24",
        httpStatusFromShip24: statusCode,
        ship24Response: body,
      });
      return;
    }

    const tracker =
      body &&
      body.data &&
      body.data.trackers &&
      body.data.trackers[0];

    const shipment = tracker && tracker.shipment;
    const events = (shipment && shipment.events) || [];
    const lastEvent = events[0] || null;
    const milestone = lastEvent && lastEvent.statusMilestone;

    let postnordNumber = null;
    for (const ev of events) {
      if (ev && typeof ev.status === "string") {
        const match = ev.status.match(postnordRegex);
        if (match) {
          postnordNumber = match[0];
          break;
        }
      }
    }

    res.status(200).json({
      ok: true,
      trackingNumber: tn,
      statusMilestone: milestone || null,
      statusSwedish: mapStatusToSwedish(milestone),
      postnordNumber,
      lastUpdate: lastEvent ? lastEvent.occurrenceDatetime : null,
      events: events.map((ev) => ({
        time: ev.occurrenceDatetime,
        rawStatus: ev.status,
        milestone: ev.statusMilestone,
        milestoneSwedish: mapStatusToSwedish(ev.statusMilestone),
      })),
      rawShip24: body,
    });
  } catch (err) {
    res.status(200).json({
      ok: false,
      stage: "exception",
      error: err.message || String(err),
    });
  }
};
