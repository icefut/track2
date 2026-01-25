// /api/track.js
// Vercel serverless-funktion som anropar Ship24 API
// Söker via spårningsnummer (4PX) eller ordernummer via clientTrackerId
// + Stöd för CityMail som alternativ "lokalt" spårnummer (förutom PostNord)

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

function lc(s) {
  return (s || "").toString().toLowerCase();
}

// Hjälpfunktion: sortera events senaste först
function sortEventsDesc(events) {
  return [...events].sort((a, b) => {
    const da = new Date(a?.datetime || a?.occurrenceDatetime || 0).getTime();
    const db = new Date(b?.datetime || b?.occurrenceDatetime || 0).getTime();
    return db - da;
  });
}

// Försök avgöra om det verkar vara PostNord/CityMail utifrån event-data
function detectCarrierHint(events, shipment, tracker) {
  const hay = [
    ...(events || []).flatMap((e) => [
      lc(e.courierCode),
      lc(e.sourceCode),
      lc(e.location),
      lc(e.status),
      lc(e.eventTrackingNumber),
    ]),
    lc(shipment?.delivery?.service),
    ...(shipment?.trackingNumbers || []).map((t) => lc(t?.tn)),
    ...(tracker?.courierCode || []).map((c) => lc(c)),
  ]
    .filter(Boolean)
    .join(" ");

  if (hay.includes("postnord") || hay.includes("dk-post")) return "PostNord";
  if (hay.includes("citymail")) return "CityMail";
  return "Okänt";
}

module.exports = async (req, res) => {
  // CORS + JSON
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");

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
  const ship24Body = { trackingNumber: value };
  if (mode === "order") {
    ship24Body.searchBy = "clientTrackerId";
  }

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

    // Status milestone
    const milestone = shipment.statusMilestone || tracker.statusMilestone || null;

    // Alla trackingNumbers som Ship24 listar
    const allTNs = (shipment.trackingNumbers || [])
      .map((t) => t?.tn)
      .filter(Boolean);

    // 1) PostNord: som innan (UJ... eller 003...)
    const postnordNumber =
      allTNs.find((tn) => tn && (tn.startsWith("UJ") || tn.startsWith("003"))) || null;

    // 2) CityMail: försök hitta via events (courier/source/status)
    const eventsSorted = sortEventsDesc(events);

    const citymailEvent = eventsSorted.find((e) => {
      const hay = [lc(e?.courierCode), lc(e?.sourceCode), lc(e?.location), lc(e?.status)].join(" ");
      return hay.includes("citymail");
    });

    // Primärt: eventTrackingNumber
    let citymailNumber = citymailEvent?.eventTrackingNumber || null;

    // Fallback: om vi ser CityMail i events men inte har eventTrackingNumber,
    // ta "annat" trackingNumber som inte är 4PX..CN och inte PostNord-numret
    if (!citymailNumber && citymailEvent) {
      citymailNumber =
        allTNs.find((tn) => {
          if (!tn) return false;
          if (tn === postnordNumber) return false;
          // undvik original 4PX..CN
          if (tn.startsWith("4PX") && tn.endsWith("CN")) return false;
          return true;
        }) || null;
    }

    // Carrier hint (för UI-text)
    const carrierHint = detectCarrierHint(events, shipment, tracker);

    // Bygg lista lokala spårnummer som UI kan visa (PostNord först)
    const localCarriers = [];
    if (postnordNumber) {
      localCarriers.push({
        carrier: "PostNord",
        trackingNumber: postnordNumber,
        url: `https://portal.postnord.com/tracking/details/${encodeURIComponent(postnordNumber)}`,
      });
    }
    if (citymailNumber) {
      localCarriers.push({
        carrier: "CityMail",
        trackingNumber: citymailNumber,
        url: `https://tracking.citymail.se/?search=${encodeURIComponent(citymailNumber)}`,
      });
    }

    const normalized = {
      ok: true,
      mode,
      httpStatusFromShip24: response.status,

      trackingNumber: tracker.trackingNumber || shipment.trackingNumber || value,
      clientTrackerId: tracker.clientTrackerId || null,

      // Gamla fält (PostNord) + nya (CityMail)
      postnordNumber,
      citymailNumber,
      carrierHint,
      localCarriers,

      statusMilestone: milestone,
      statusSwedish: mapStatusMilestoneToSwedish(milestone),

      // För "Senast uppdaterad" (behåller din logik)
      lastUpdate: tracking.metadata?.generatedAt || null,

      events: events.map((e) => ({
        datetime: e.datetime || e.occurrenceDatetime || null,
        location: e.location || null,
        status: e.status || null,
        courierCode: e.courierCode || null,
        sourceCode: e.sourceCode || null,
        eventTrackingNumber: e.eventTrackingNumber || null,
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
