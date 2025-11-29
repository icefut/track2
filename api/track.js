// Enkel Vercel API Route som hämtar spårning från Ship24 och returnerar svensk data

const SHIP24_API = "https://api.ship24.com/public/v1/trackers/track";

function mapToSwedish(m) {
  switch (m) {
    case "info_received":
      return "Information mottagen – paketet är registrerat men inte skickat ännu";
    case "in_transit":
      return "På väg";
    case "out_for_delivery":
      return "Ute för leverans";
    case "available_for_pickup":
      return "Klar för upphämtning";
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

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const tn = req.query.tn;
  if (!tn) {
    return res.status(400).json({
      ok: false,
      error: "tracking_number_missing",
    });
  }

  const apiKey = process.env.SHIP24_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      ok: false,
      error: "API_KEY_MISSING",
    });
  }

  try {
    const ship24 = await fetch(SHIP24_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Ship24-API-Key": apiKey,
      },
      body: JSON.stringify({
        trackingNumbers: [tn],
      }),
    });

    const data = await ship24.json();

    if (!data?.data?.trackings?.length) {
      return res.json({
        ok: true,
        trackingNumber: tn,
        statusSwedish: "Ingen spårningsinformation ännu",
        events: [],
      });
    }

    const track = data.data.trackings[0];

    // Milestone
    const milestone = mapToSwedish(track.statusMilestone || "");

    // Events (NYTT – NU FUNKAR DET!)
    const events =
      track.events?.map((ev) => ({
        time: ev.datetime || null,
        rawStatus: ev.status || null,
        location: ev.location || null,
        milestoneSwedish: mapToSwedish(ev.status || ""),
      })) || [];

    const lastUpdate = track.lastUpdateDatetime || null;

    return res.json({
      ok: true,
      trackingNumber: tn,
      statusSwedish: milestone,
      events,
      lastUpdate,
      postnordNumber: track.postNordNumber || null,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "ship24_fetch_error",
      details: err.toString(),
    });
  }
}
