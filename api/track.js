// api/track.js
// En enkel Vercel Serverless Function som anropar Ship24 och returnerar svensk data

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

// En enkel regex för att hitta PostNord-nummer, typ UJxxxxxxxx eller 003xxxxxxxx
const postnordRegex = /(UJ[0-9A-Z]{8,}|003[0-9]{8,})/;

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const tn = req.query.tn;
  if (!tn) {
    res.status(400).json({ error: "Saknar tn (trackingnummer) i queryn" });
    return;
  }

  const apiKey = process.env.SHIP24_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "SHIP24_API_KEY är inte satt på servern" });
    return;
  }

  try {
    const response = await fetch("https://api.ship24.com/public/v1/trackers/track", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        trackingNumber: tn
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      res.status(response.status).json({
        error: "Fel från Ship24",
        details: data,
      });
