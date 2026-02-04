// /api/track-order.js
const ORDERS = require("./orders-data");
const fs = require("fs");
const path = require("path");

// ====== ETA RULES (CSV) ======
const ETA_CSV_FILENAME = "eta-logistics-rules-icefot.csv";
let ETA_RULES_CACHE = null;

function stripBom(s) {
  if (!s) return s;
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

// Minimal CSV parser som klarar: inga kommatecken i fält (vilket vi har i din template)
function parseCsvSimple(csvText) {
  const text = stripBom(csvText).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];

  const headers = lines[0].split(",").map((h) => h.trim());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",").map((p) => p.trim());
    const obj = {};
    for (let j = 0; j < headers.length; j++) obj[headers[j]] = parts[j] ?? "";
    rows.push(obj);
  }
  return rows;
}

function loadEtaRules() {
  if (ETA_RULES_CACHE) return ETA_RULES_CACHE;

  const csvPath = path.join(__dirname, ETA_CSV_FILENAME);
  const raw = fs.readFileSync(csvPath, "utf8");
  const parsed = parseCsvSimple(raw);

  const rules = parsed
    .map((r) => ({
      carrier: (r.carrier || "").toLowerCase().trim(),
      priority: Number(r.priority || 9999),
      match_type: (r.match_type || "contains").toLowerCase().trim(),
      match_value: String(r.match_value || "").trim(),
      eta_min_business_days: Number(r.eta_min_business_days || 0),
      eta_max_business_days: Number(r.eta_max_business_days || 0),
      eta_label_sv: String(r.eta_label_sv || "").trim(),
      note_sv: String(r.note_sv || "").trim(),
    }))
    .filter((r) => r.carrier && r.match_value);

  // Sort per carrier/priority
  rules.sort((a, b) => {
    if (a.carrier !== b.carrier) return a.carrier.localeCompare(b.carrier);
    return a.priority - b.priority;
  });

  ETA_RULES_CACHE = rules;
  return rules;
}

function normalizeForMatch(s) {
  return String(s || "").trim().toLowerCase();
}

function matchesRule(text, rule) {
  const t = normalizeForMatch(text);
  const v = normalizeForMatch(rule.match_value);

  if (!t || !v) return false;

  if (rule.match_type === "equals") return t === v;
  if (rule.match_type === "regex") {
    try {
      const re = new RegExp(rule.match_value, "i");
      return re.test(String(text || ""));
    } catch {
      return false;
    }
  }
  // default: contains
  return t.includes(v);
}

function detectCarrier({ citymailNumber, postnordNumber, trackingNumber }) {
  // Om CityMail finns → citymail, annars PostNord, annars unknown
  if (citymailNumber) return "citymail";
  if (postnordNumber) return "postnord";

  // fallback: ibland kan trackingNumber hintas
  const tn = String(trackingNumber || "").toUpperCase();
  if (tn.startsWith("BC") && tn.endsWith("CN")) return "citymail";
  if (tn.startsWith("UJ") || tn.startsWith("003")) return "postnord";

  return "unknown";
}

function pickLatestEventStatus(events) {
  if (!Array.isArray(events) || events.length === 0) return "";

  // Sortera efter datetime om möjligt (desc). Om datetime saknas behåll ordning.
  const parsed = events.map((e, idx) => {
    const dt = e.datetime || e.occurrenceDatetime || null;
    const ms = dt ? Date.parse(dt) : NaN;
    return { e, idx, ms };
  });

  parsed.sort((a, b) => {
    const aValid = Number.isFinite(a.ms);
    const bValid = Number.isFinite(b.ms);
    if (aValid && bValid) return b.ms - a.ms;
    if (aValid && !bValid) return -1;
    if (!aValid && bValid) return 1;
    return a.idx - b.idx;
  });

  return parsed[0]?.e?.status || "";
}

function estimateDeliveryFromRules({ carrier, latestStatusText, milestone }) {
  const rules = loadEtaRules();

  const carrierRules = rules.filter((r) => r.carrier === carrier);
  for (const r of carrierRules) {
    if (matchesRule(latestStatusText, r)) {
      return {
        estimated_delivery: r.eta_label_sv || `${r.eta_min_business_days}–${r.eta_max_business_days} arbetsdagar`,
        eta_min_business_days: r.eta_min_business_days,
        eta_max_business_days: r.eta_max_business_days,
        eta_note_sv: r.note_sv || "",
        matched_rule: { carrier: r.carrier, priority: r.priority, match_type: r.match_type, match_value: r.match_value },
      };
    }
  }

  // fallback om ingen match
  // (du kan göra mer avancerat här senare)
  if ((milestone || "").toLowerCase() === "delivered") {
    return {
      estimated_delivery: "Levererad",
      eta_min_business_days: 0,
      eta_max_business_days: 0,
      eta_note_sv: "",
      matched_rule: null,
    };
  }

  return {
    estimated_delivery: "Beräknad leverans saknas för denna status",
    eta_min_business_days: null,
    eta_max_business_days: null,
    eta_note_sv: "Uppskattning baserad på nuvarande status",
    matched_rule: null,
  };
}

// ====== Samma som i track.js ======
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

// Helper för IP-loggning
function getClientIp(req) {
  return (
    req.headers["x-forwarded-for"] ||
    req.headers["x-real-ip"] ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

// Plocka ut alla tracking numbers som Ship24 kan ge tillbaka
function collectAllTrackingNumbers(tracking, fallbackTrackingNumber) {
  const out = new Set();

  const tracker = tracking?.tracker || {};
  const shipment = tracking?.shipment || {};

  if (tracker.trackingNumber) out.add(String(tracker.trackingNumber));
  if (shipment.trackingNumber) out.add(String(shipment.trackingNumber));
  if (fallbackTrackingNumber) out.add(String(fallbackTrackingNumber));

  const arr = []
    .concat(Array.isArray(shipment.trackingNumbers) ? shipment.trackingNumbers : [])
    .concat(Array.isArray(tracker.trackingNumbers) ? tracker.trackingNumbers : []);

  for (const t of arr) {
    const tn = t?.tn || t?.trackingNumber || t;
    if (tn) out.add(String(tn));
  }

  return Array.from(out);
}

function pickPostNordNumber(allNumbers) {
  return allNumbers.find((tn) => tn && (tn.startsWith("UJ") || tn.startsWith("003"))) || null;
}

function pickCityMailNumber(allNumbers) {
  return (
    allNumbers.find((tn) => {
      if (!tn) return false;
      const s = String(tn).toUpperCase();
      return s.startsWith("BC") && s.endsWith("CN");
    }) || null
  );
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  const order = (req.query.order || "").toString().trim();
  const email = (req.query.email || "").toString().trim().toLowerCase();
  const ip = getClientIp(req);

  console.log("[ORDER_TRACK_REQUEST]", { order, email, ip });

  if (!order || !email) {
    return res.status(400).json({
      ok: false,
      error: "order och email krävs",
    });
  }

  const match = ORDERS.find((o) => o.order_number === order && o.email.toLowerCase() === email);

  if (!match) {
    console.log("[ORDER_TRACK_NOT_FOUND]", { order, email });
    return res.status(404).json({
      ok: false,
      error: "Hittar ingen order med detta ordernummer och e-post",
    });
  }

  const trackingNumber = match.tracking_number;
  const apiKey = process.env.SHIP24_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      ok: false,
      error: "SHIP24_API_KEY saknas på servern",
    });
  }

  try {
    const body = { trackingNumber };

    const response = await fetch("https://api.ship24.com/public/v1/trackers/track", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();

    if (!response.ok) {
      console.log("[ORDER_TRACK_SHIP24_ERROR]", data);
      return res.status(response.status).json({
        ok: false,
        error: "Fel från Ship24",
        raw: data,
      });
    }

    const tracking = data?.data?.trackings?.[0];
    if (!tracking) {
      return res.status(404).json({
        ok: false,
        error: "Ingen försändelse hittades hos Ship24",
        raw: data,
      });
    }

    const tracker = tracking.tracker || {};
    const shipment = tracking.shipment || {};
    const events = Array.isArray(tracking.events) ? tracking.events : [];

    const milestone = shipment.statusMilestone || tracker.statusMilestone || null;

    // Samla alla nummer + plocka både PostNord och CityMail
    const allNumbers = collectAllTrackingNumbers(tracking, trackingNumber);
    const postnordNumber = pickPostNordNumber(allNumbers);
    const citymailNumber = pickCityMailNumber(allNumbers);

    // ====== ETA (nytt) ======
    const carrierDetected = detectCarrier({
      citymailNumber,
      postnordNumber,
      trackingNumber: tracker.trackingNumber || shipment.trackingNumber || trackingNumber,
    });

    const latestStatusText = pickLatestEventStatus(events);
    const eta = estimateDeliveryFromRules({
      carrier: carrierDetected,
      latestStatusText,
      milestone,
    });

    const normalized = {
      ok: true,
      mode: "order",
      trackingNumber: tracker.trackingNumber || shipment.trackingNumber || trackingNumber,

      statusMilestone: milestone,
      statusSwedish: mapStatusMilestoneToSwedish(milestone),
      lastUpdate: tracking.metadata?.generatedAt || null,

      postnordNumber,
      citymailNumber,

      // ✅ NYTT: ETA i svaret
      carrierDetected,
      latestStatusText,
      estimated_delivery: eta.estimated_delivery,
      eta_min_business_days: eta.eta_min_business_days,
      eta_max_business_days: eta.eta_max_business_days,
      eta_note_sv: eta.eta_note_sv,
      eta_matched_rule: eta.matched_rule, // bra för debug (kan tas bort senare)

      events: events.map((e) => ({
        datetime: e.datetime || e.occurrenceDatetime || null,
        location: e.location || null,
        status: e.status || null,
        courierCode: e.courierCode || null,
      })),
    };

    console.log("[ORDER_TRACK_SUCCESS]", {
      trackingNumber: normalized.trackingNumber,
      postnordNumber,
      citymailNumber,
      carrierDetected,
      estimated_delivery: normalized.estimated_delivery,
    });

    return res.status(200).json(normalized);
  } catch (err) {
    console.log("[ORDER_TRACK_EXCEPTION]", err);
    return res.status(500).json({
      ok: false,
      error: "Internt fel när Ship24 anropades",
    });
  }
};
