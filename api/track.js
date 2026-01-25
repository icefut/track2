// /api/track.js
// Vercel serverless-funktion som anropar Ship24 API
// + plockar både PostNord-nummer och CityMail-nummer om de finns.

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

function normalizeTrackingNumbers(shipment, tracker) {
  const out = [];

  // Ship24 kan returnera trackingNumbers på lite olika ställen/format.
  const pushTn = (tn) => {
    if (!tn) return;
    const v = String(tn).trim();
    if (!v) return;
    out.push(v);
  };

  const arr1 = shipment?.trackingNumbers;
  if (Array.isArray(arr1)) {
    for (const t of arr1) pushTn(t?.tn || t?.trackingNumber || t);
  }

  const arr2 = tracker?.trackingNumbers;
  if (Array.isArray(arr2)) {
    for (const t of arr2) pushTn(t?.tn || t?.trackingNumber || t);
  }

  // ibland kan numret ligga som "trackingNumber" direkt
  pushTn(tracker?.trackingNumber);
  pushTn(shipment?.trackingNumber);

  // dedupe
  return Array.from(new Set(out));
}

function pickPostnordNumber(allTn) {
  // Behåll din gamla logik + lite robustare
  return (
    allTn.find((tn) => tn.startsWith("UJ") && tn.endsWith("SE")) ||
    allTn.find((tn) => tn.startsWith("003")) ||
    null
  );
}

function pickCitymailNumber(allTn) {
  // Du sa: börjar med BC och slutar med CN
  return allTn.find((tn) => tn.startsWith("BC") && tn.endsWith("CN")) || null;
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

    // ✅ NYTT: plocka ut alla trackingNumbers och hitta både PostNord + CityMail
    const allTrackingNumbers = normalizeTrackingNumbers(shipment, tracker);

    const postnordNumber = pickPostnordNumber(allTrackingNumbers);
    const citymailNumber = pickCitymailNumber(allTrackingNumbers);

    const normalized = {
      ok: true,
      mode,
      httpStatusFromShip24: response.status,
      trackingNumber: tracker.trackingNumber || shipment.trackingNumber || value,
      clientTrackerId: tracker.clientTrackerId || null,

      postnordNumber,
      citymailNumber,

      // Om du vill felsöka ibland kan du kolla dessa:
      // allTrackingNumbers,

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
