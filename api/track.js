// api/track.js
// Hämter spårning från Ship24 och returnerar svensk data till din frontend

const https = require("https");

const SHIP24_HOST = "api.ship24.com";
const SHIP24_PATH = "/public/v1/trackers/track";

// Översätt Ship24s statusMilestone till svenska
function mapStatusToSwedish(milestone) {
  switch (milestone) {
    case "info_received":
      return "Information mottagen – paketet är registrerat men inte skickat ännu";
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

// hitta PostNord-nummer i eventtext (UJ... eller 003...)
const postnordRegex = /(UJ[0-9A-Z]{8,}|003[0-9]{8,})/;

// Gör själva API-anropet till Ship24
function callShip24(apiKey, trackingNumber) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ trackingNumber });

    const options = {
      hostname: SHIP24_HOST,
      path: SHIP24_PATH,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`, // korrekt enligt Ship24
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
          reject(
            new Error("Kunde inte tolka svar från Ship24: " + err.message)
          );
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

  if (!tn) {
    return res.status(200).json({
      ok: false,
      stage: "input",
      error: "Saknar tn (trackingnummer) i queryn",
    });
  }

  if (!apiKey) {
    return res.status(200).json({
      ok: false,
      stage: "env",
      error: "SHIP24_API_KEY saknas i servern",
    });
  }

  try {
    const { statusCode, body } = await callShip24(apiKey, tn);

    if (statusCode < 200 || statusCode >= 300) {
      return res.status(200).json({
        ok: false,
        stage: "ship24",
        httpStatusFromShip24: statusCode,
        ship24Response: body,
      });
    }

    // ----- Plocka ut data robust (trackers / trackings, events / trackingEvents) -----
    const data = body && body.data ? body.data : null;

    let tracking = null;
    if (data) {
      if (Array.isArray(data.trackers) && data.trackers.length) {
        tracking = data.trackers[0];
      } else if (Array.isArray(data.trackings) && data.trackings.length) {
        tracking = data.trackings[0];
      }
    }

    let shipment = null;
    if (tracking) {
      if (tracking.shipment) {
        shipment = tracking.shipment;
      } else if (
        Array.isArray(tracking.shipments) &&
        tracking.shipments.length
      ) {
        shipment = tracking.shipments[0];
      }
    }

    let events = [];
    if (shipment) {
      if (Array.isArray(shipment.events)) {
        events = shipment.events;
      } else if (Array.isArray(shipment.trackingEvents)) {
        events = shipment.trackingEvents;
      }
    }

    // statistik / huvudstatus
    let statistics =
      (shipment && shipment.statistics) ||
      (tracking && tracking.statistics) ||
      null;

    let milestone =
      (statistics && statistics.statusMilestone) ||
      (events[0] && events[0].statusMilestone) ||
      null;

    if (!milestone && events.length) {
      const evWithMilestone = events.find(
        (ev) => ev && ev.statusMilestone
      );
      if (evWithMilestone) {
        milestone = evWithMilestone.statusMilestone;
      }
    }

    // senaste uppdatering
    let lastEvent = events.length ? events[0] : null;
    let lastUpdate =
      (lastEvent && lastEvent.occurrenceDatetime) ||
      (statistics &&
        statistics.timestamps &&
        (statistics.timestamps.inTransitDatetime ||
          statistics.timestamps.infoReceivedDatetime)) ||
      null;

    // leta PostNord-nummer i eventtext
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

    // bygg svar till frontend – enkelt och svenskt
    return res.status(200).json({
      ok: true,
      trackingNumber: tn,
      statusMilestone: milestone || null,
      statusSwedish: mapStatusToSwedish(milestone),
      postnordNumber,
      lastUpdate,
      events: events.map((ev) => ({
        time: ev.occurrenceDatetime,
        rawStatus: ev.status,
        milestone: ev.statusMilestone,
        milestoneSwedish: mapStatusToSwedish(ev.statusMilestone),
      })),
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      stage: "exception",
      error: err.message || String(err),
    });
  }
};
