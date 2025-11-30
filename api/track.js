// DEBUG-VERSION av /api/track
// Denna skickar INTE svensk data, utan visar bara råsvar från Ship24
// så vi kan se exakt hur JSON:et ser ut.

const https = require("https");

const SHIP24_HOST = "api.ship24.com";
const SHIP24_PATH = "/public/v1/trackers/track";

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

    // Skicka tillbaka exakt vad Ship24 svarade, plus lite debug-info
    return res.status(200).json({
      ok: true,
      httpStatusFromShip24: statusCode,
      rawShip24: body,
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      stage: "exception",
      error: err.message || String(err),
    });
  }
};
