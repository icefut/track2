// /api/track.js
// Vercel serverless-funktion som anropar Ship24 API
// + plockar både PostNord-nummer och CityMail-nummer
// + ETA från CSV-regler (postnord/citymail)

const fs = require("fs");
const path = require("path");

// ====== ETA RULES (CSV) ======
const ETA_CSV_FILENAME = "eta-logistics-rules-icefot.csv";
let ETA_RULES_CACHE = null;

function stripBom(s) {
  if (!s) return s;
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

// Minimal CSV parser (din CSV har inga kommatecken i fälten)
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
  if (citymailNumber) return "citymail";
  if (postnordNumber) return "postnord";

  const tn = String(trackingNumber || "").toUpperCase();
  if (tn.startsWith("BC") && tn.endsWith("CN")) return "citymail";
  if (tn.startsWith("UJ") || tn.startsWith("003")) return "postnord";

  return "unknown";
}

function pickLatestEventStatus(events) {
  if (!Array.isArray(events) || events.length === 0) return "";

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
        estimated_delivery:
          r.eta_label_sv ||
          `${r.eta_min_business_days}–${r.eta_max_business_days} arbetsdagar`,
        eta_min_business_days: r.eta_min_business_days,
        eta_max_business_days: r.eta_max_business_days,
        eta_note_sv: r.note_sv || "",
        matched_rule: { carrier: r.carrier, priority: r.priority, match_type: r.match_type, match_value: r.match_value },
      };
    }
  }

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

// ====== Din befintliga logik ======
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

  pushTn(tracker?.trackingNumber);
  pushTn(shipment?.trackingNumber);

  return Array.from(new Set(out));
}

function pickPostnordNumber(allTn) {
  return (
    allTn.find((tn) => tn.startsWith("UJ") && tn.endsWith("SE")) ||
    allTn.find((tn) => tn.startsWith("003")) ||
    null
  );
}

function pickCitymailNumber(allTn) {
  return allTn.find((tn) => tn.startsWith("BC") && tn.endsWith("CN")) || null;
}

module.exports = async (req, res) => {
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
    res.status(500).json({ ok: false, error: "SHIP24_API_KEY är inte satt på servern" });
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

    const allTrackingNumbers = normalizeTrackingNumbers(shipment, tracker);
    const postnordNumber = pickPostnordNumber(allTrackingNumbers);
    const citymailNumber = pickCitymailNumber(allTrackingNumbers);

    // ====== ETA (NYTT) ======
    const trackingNumberResolved = tracker.trackingNumber || shipment.trackingNumber || value;

    const carrierDetected = detectCarrier({
      citymailNumber,
      postnordNumber,
      trackingNumber: trackingNumberResolved,
    });

    const latestStatusText = pickLatestEventStatus(events);

    const eta = estimateDeliveryFromRules({
      carrier: carrierDetected,
      latestStatusText,
      milestone,
    });

    const normalized = {
      ok: true,
      mode,
      httpStatusFromShip24: response.status,
      trackingNumber: trackingNumberResolved,
      clientTrackerId: tracker.clientTrackerId || null,

      postnordNumber,
      citymailNumber,

      statusMilestone: milestone,
      statusSwedish: mapStatusMilestoneToSwedish(milestone),
      lastUpdate: tracking.metadata?.generatedAt || null,

      // ✅ NYTT: ETA
      carrierDetected,
      latestStatusText,
      estimated_delivery: eta.estimated_delivery,
      eta_min_business_days: eta.eta_min_business_days,
      eta_max_business_days: eta.eta_max_business_days,
      eta_note_sv: eta.eta_note_sv,
      eta_matched_rule: eta.matched_rule, // för debug (kan tas bort)

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
