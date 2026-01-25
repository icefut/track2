// /api/track.js
// Vercel serverless-funktion som anropar Ship24 API
// Stöd: 4PX tracking + order (clientTrackerId)
// Extra: plockar ut PostNord + CityMail tracking numbers om de finns

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

// Hjälp: normalisera strängar för jämförelse
function norm(s) {
  return (s || "").toString().trim().toLowerCase();
}

// Försök hitta PostNord/CityMail i Ship24 trackingNumbers
function extractCarrierNumbers(shipment, tracker, inputValue) {
  const trackingNumbers = Array.isArray(shipment?.trackingNumbers)
    ? shipment.trackingNumbers
    : [];

  // Ship24 brukar ha objects typ:
  // { tn: "UJ...", courierCode: "postnord" } eller liknande.
  // Men ibland saknas courierCode, då får vi gissa.

  const all = trackingNumbers
    .map((t) => ({
      tn: (t?.tn || "").toString().trim(),
      courierCode: norm(t?.courierCode),
      courierName: (t?.courierName || "").toString().trim(),
    }))
    .filter((x) => x.tn);

  // PostNord: pattern + courier hint
  const postnord =
    all.find(
      (x) =>
        x.tn.startsWith("UJ") ||
        x.tn.startsWith("003") ||
        x.courierCode.includes("postnord") ||
        norm(x.courierName).includes("postnord")
    )?.tn || null;

  // CityMail: courier hint
  let citymail =
    all.find(
      (x) =>
        x.courierCode.includes("citymail") ||
        norm(x.courierName).includes("citymail")
    )?.tn || null;

  // Fallback: om Ship24 inte anger courier men numret finns ändå:
  // ta ett “annat” tracking number som inte är inputValue och inte är PostNord
  // (bra när CityMail-numret faktiskt finns men courierCode saknas)
  if (!citymail) {
    const inputTN = (inputValue || "").toString().trim();
    const mainTN =
      (tracker?.trackingNumber || shipment?.trackingNumber || inputTN).toString().trim();

    const candidate = all.find((x) => {
      if (!x.tn) return false;
      if (x.tn === postnord) return false;
      if (x.tn === inputTN) return false;
      if (x.tn === mainTN) return false;
      // undvik att vi råkar plocka 4PX igen
      if (x.tn.toUpperCase().startsWith("4PX") && x.tn.toUpperCase().endsWith("CN")) return false;
      return true;
    });

    citymail = candidate?.tn || null;
  }

  return {
    postnordNumber: postnord,
    citymailNumber: citymail,
    carrierTrackingNumbers: all, // bonus: allt som Ship24 skickar
  };
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

  const ship24Body = { trackingNumber: value };
  if (mode === "order") {
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

    const { postnordNumber, citymailNumber, carrierTrackingNumbers } =
      extractCarrierNumbers(shipment, tracker, value);

    const normalized = {
      ok: true,
      mode,
      httpStatusFromShip24: response.status,
      trackingNumber: tracker.trackingNumber || shipment.trackingNumber || value,
      clientTrackerId: tracker.clientTrackerId || null,

      // Viktigt: båda visas nu
      postnordNumber,
      citymailNumber,

      // Bonus om du vill visa fler carriers senare
      carrierTrackingNumbers,

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
