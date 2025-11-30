// api/track.js
// Hämtar spårning från Ship24 och returnerar svensk data till din frontend

const https = require("https");

const SHIP24_HOST = "api.ship24.com";
const SHIP24_PATH = "/public/v1/trackers/track";

// Översätt Ship24s statusMilestone till svenska (grov nivå)
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

// Mer detaljerad översättning av den engelska status-texten (rawStatus)
function mapRawStatusToSwedish(status) {
  if (!status) return null;
  const s = status.toLowerCase();

  if (s.includes("delivered to the recipient's mailbox")) {
    return "Försändelsen har levererats till mottagarens brevlåda.";
  }
  if (s.includes("has been delivered to the recipients mailbox")) {
    return "Försändelsen har levererats till mottagarens brevlåda.";
  }
  if (s.includes("the shipment item has been loaded")) {
    return "Försändelsen har lastats.";
  }
  if (s.includes("is being processed at our sorting center")) {
    return "Försändelsen hanteras på vår sorteringsterminal.";
  }
  if (s.includes("is under transportation")) {
    return "Försändelsen är under transport.";
  }
  if (s.includes("has been handed over to a partner for transportation to the final destination")) {
    return "Försändelsen har överlämnats till en partner för vidare transport till slutdestinationen.";
  }
  if (s.includes("shipment picked up")) {
    return "Försändelsen har hämtats upp.";
  }
  if (s.includes("shipping information received")) {
    return "Fraktinformation har mottagits.";
  }
  if (s.includes("parcel information received")) {
    return "Paketinformation mottagen.";
  }
  if (s.includes("depart from facility to service provider")) {
    return "Försändelsen har lämnat anläggningen till transportör.";
  }
  if (s.includes("arrival to the destination airport")) {
    return "Ankomst till destinationsflygplats.";
  }
  if (s.includes("departure from the original airport")) {
    return "Avgång från ursprungsflygplats.";
  }
  if (s.includes("released from customs")) {
    return "Tullklarerad.";
  }
  if (s.includes("arrive in transit center")) {
    return "Ankomst till terminal.";
  }
  if (s.includes("parcel outbound from transit center")) {
    return "Försändelsen har lämnat terminalen.";
  }
  if (
    s.includes("we have received a notification from your shipper") &&
    s.includes("will be updated when the parcel is handed over to postnord")
  ) {
    return "Vi har fått information från avsändaren att en försändelse förbereds. Spårningen uppdateras när paketet har lämnats över till PostNord.";
  }

  // om vi inte känner igen texten -> null (frontend visar engelskan)
  return null;
}

// hitta PostNord-nummer: UJ... eller 003...
const postnordRegex = /(UJ[0-9A-Z]{8,}|003[0-9]{8,})/;

// Anropar Ship24 med https.request
function callShip24(apiKey, trackingNumber) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ trackingNumber });

    const options = {
      hostname: SHIP24_HOST,
      path: SHIP24_PATH,
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

    // -------- Plocka ut data ur rawShip24 --------
    const data = body && body.data ? body.data : null;
    if (!data || !Array.isArray(data.trackings) || !data.trackings.length) {
      return res.status(200).json({
        ok: true,
        trackingNumber: tn,
        statusMilestone: null,
        statusSwedish: "Ingen spårningsinformation ännu",
        postnordNumber: null,
        lastUpdate: null,
        events: [],
      });
    }

    const tracking = data.trackings[0];

    const shipment = tracking.shipment || null;
    const events = Array.isArray(tracking.events) ? tracking.events : [];

    // huvudstatus: från shipment.statusMilestone
    let milestone =
      (shipment && shipment.statusMilestone) ||
      tracking.statusMilestone ||
      null;

    // senaste uppdatering = första eventet (Ship24 skickar senaste först)
    const lastEvent = events.length ? events[0] : null;
    const lastUpdate = lastEvent
      ? lastEvent.occurrenceDatetime || lastEvent.datetime
      : null;

    // hitta PostNord-nummer
    let postnordNumber = null;

    // 1) Försök från shipment.trackingNumbers
    if (shipment && Array.isArray(shipment.trackingNumbers)) {
      for (const tnObj of shipment.trackingNumbers) {
        if (tnObj && typeof tnObj.tn === "string") {
          const m = tnObj.tn.match(postnordRegex);
          if (m) {
            postnordNumber = m[0];
            break;
          }
        }
      }
    }

    // 2) Om inte hittat, försök från events[*].eventTrackingNumber eller status-text
    if (!postnordNumber) {
      for (const ev of events) {
        if (ev && typeof ev.eventTrackingNumber === "string") {
          const m = ev.eventTrackingNumber.match(postnordRegex);
          if (m) {
            postnordNumber = m[0];
            break;
          }
        }
        if (!postnordNumber && ev && typeof ev.status === "string") {
          const m2 = ev.status.match(postnordRegex);
          if (m2) {
            postnordNumber = m2[0];
            break;
          }
        }
      }
    }

    // Bygg events-array för frontend
    const mappedEvents = events.map((ev) => {
      const raw = ev.status || "";
      const translated = mapRawStatusToSwedish(raw);

      return {
        time: ev.occurrenceDatetime || ev.datetime || null,
        rawStatus: raw,
        rawStatusSwedish: translated,
        location: ev.location || null,
        milestone: ev.statusMilestone || null,
        milestoneSwedish: mapStatusToSwedish(ev.statusMilestone),
      };
    });

    return res.status(200).json({
      ok: true,
      trackingNumber: tn,
      statusMilestone: milestone,
      statusSwedish: mapStatusToSwedish(milestone),
      postnordNumber,
      lastUpdate,
      events: mappedEvents,
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      stage: "exception",
      error: err.message || String(err),
    });
  }
};
