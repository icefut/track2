// Översättning av händelsetexter + klassning av varje händelse till en "fas".
// Klassningen använder i första hand Ship24:s standardiserade statusCode/statusMilestone
// (fungerar för ALLA transportörer) och faller tillbaka på textmatchning.
"use strict";

// Faser i ordning (rank). Högsta uppnådda fas styr status + ETA.
const PHASES = {
  pending: { rank: 0, step: 0, pct: 4 },
  label_created: { rank: 1, step: 1, pct: 12 },
  origin_facility: { rank: 2, step: 1, pct: 22 },
  departed_origin: { rank: 3, step: 2, pct: 36 },
  customs: { rank: 4, step: 2, pct: 48 },
  eu_hub: { rank: 5, step: 2, pct: 60 },
  in_sweden: { rank: 6, step: 3, pct: 74 },
  out_for_delivery: { rank: 7, step: 3, pct: 88 },
  failed_attempt: { rank: 7, step: 3, pct: 88 },
  available_for_pickup: { rank: 8, step: 4, pct: 96 },
  delivered: { rank: 9, step: 4, pct: 100 },
};

// statusCode (Ship24) -> fas
const CODE_TO_PHASE = {
  data_order_created: "label_created",
  data_delivery_proposed: "in_sweden",
  data_delivery_decided: "in_sweden",
  transit_handover: "origin_facility",
  transit_origin_country_departure: "departed_origin",
  customs_received: "customs",
  customs_cleared: "customs",
  customs_exception: "customs",
  destination_arrival: "in_sweden",
  delivery_out_for_delivery: "out_for_delivery",
  delivery_attempted: "failed_attempt",
  delivery_available_for_pickup: "available_for_pickup",
  delivery_delivered: "delivered",
};

// Textregler (körs på originaltexten, case-insensitive). Ordning spelar roll: första träff vinner.
const TEXT_RULES = [
  // Levererad – men inte "kunde inte levereras" o.s.v.
  { re: /(not|couldn'?t|could not|unable to|ej|inte|kunde inte)\s+(be\s+)?deliver|undeliver|levereras inte|returnera/i, phase: null, exception: true },
  { re: /ready for pick ?up|available for pick ?up|kan hämtas|finns att hämta|redo att hämtas|ankommit till ombud|hos ditt ombud|till (ditt )?ombud|utlämningsställe|paketbox|pickup point|service point/i, phase: "available_for_pickup" },
  { re: /\bdelivered\b|har levererats|levererad\b|utlämnad|utlämnat|har hämtats av mottagaren|collected by (the )?recipient/i, phase: "delivered" },
  { re: /delivery attempt|leveransförsök|ingen hemma|failed attempt/i, phase: "failed_attempt" },
  { re: /out for delivery|ute för leverans|har lastats|been loaded|on (its|the) way to you|på väg till dig|förbereds för leverans|levereras idag|uppdaterats till turbo/i, phase: "out_for_delivery" },
  { re: /text message notification|sms-?notis|avisering skickad|notification has been sent/i, phase: "out_for_delivery", weak: true },
  { re: /arrived at the country of destination|ankom till destinationslandet|ankommit till vår terminal|ankommit till terminal|brevterminal|terminal (malmö|malmo|stockholm|göteborg|goteborg)|under transportation|under transport\b|försändelsen är under transport|sorting center|sorteras|sorteringsterminal|processed at|arrived at (the )?(delivery|local)|lokal terminal|paketet är i sverige/i, phase: "in_sweden" },
  { re: /handed over to a partner|partner for transportation|lokal transportör/i, phase: "in_sweden" },
  { re: /transiting in destination country|arrive in transit center|arrived? (at|in) transit cent|outbound from transit center|lämnat transitcentret|ankom till transitcenter/i, phase: "eu_hub" },
  { re: /import clearance|customs|tull|released from customs/i, phase: "customs" },
  { re: /arrival to the destination airport|destination airport|destinationsflygplats/i, phase: "customs" },
  { re: /transiting by air|air or ship|hand(ed)? over to airline|departure from|departed|flight|flyg|avgick|överlämnat till flygbolag|export|left the origin|depart from facility|lämnade anläggning/i, phase: "departed_origin" },
  { re: /operations in warehouse|arrived at facility|shipment arrived at facility|picked up|hämtad av transportör|accepted|received by|collected|inbound|warehouse|lager|ankom till anläggning/i, phase: "origin_facility" },
  { re: /picking in origin|beställning på en leverans|väntar på paketet|information received|shipping information|parcel information|order (created|received)|label created|fraktinformation|paketinformation|väntar på ditt paket|vantar pa ditt paket|notification from your shipper|avisering mottagen|elektronisk|pre-?advice|registrerad/i, phase: "label_created" },
];

const EXCEPTION_RE = /return(ed)? to sender|returned|retur|lost|förlorad|destroyed|destruerad|refused|vägrad|customs rejected/i;

function classifyEvent(ev) {
  const code = String(ev.statusCode || "").toLowerCase();
  const text = String(ev.status || "");
  const milestone = String(ev.statusMilestone || "").toLowerCase();

  if (code.startsWith("exception_") || code === "delivery_refused" || code === "customs_rejected") {
    return { phase: null, exception: true };
  }

  // Texten först: den är kalibrerad mot riktiga 4PX/PostNord/CityMail-händelser
  // (Ship24 kodar t.ex. 4PX "Transiting in Destination Country" som ankomst, fast paketet är i Belgien).
  for (const r of TEXT_RULES) {
    if (r.re.test(text)) {
      if (r.exception) return { phase: null, exception: true };
      return { phase: r.phase, exception: false, weak: !!r.weak };
    }
  }

  // Okänd text -> Ship24:s standardiserade statusCode (fungerar för alla transportörer)
  if (code && CODE_TO_PHASE[code]) {
    return { phase: CODE_TO_PHASE[code], exception: false };
  }

  if (EXCEPTION_RE.test(text)) return { phase: null, exception: true };

  // Fallback: Ship24-milstolpe
  switch (milestone) {
    case "delivered":
      return { phase: "delivered" };
    case "available_for_pickup":
      return { phase: "available_for_pickup" };
    case "out_for_delivery":
      return { phase: "out_for_delivery" };
    case "failed_attempt":
      return { phase: "failed_attempt" };
    case "in_transit":
      return { phase: "origin_facility" };
    case "info_received":
      return { phase: "label_created" };
    case "exception":
      return { phase: null, exception: true };
    default:
      return { phase: null };
  }
}

// ===== Översättning till svenska =====
const TRANSLATIONS = [
  [/^operations in warehouse\.?$/i, "Paketet hanteras på lagret"],
  [/^transiting by air or ship\.?$/i, "Under internationell transport"],
  [/^import clearance\.?$/i, "Tullhantering vid import"],
  [/^transiting in destination country\.?$/i, "Under transport i Europa"],
  [/^parcel outbound from transit center\.?$/i, "Paketet har lämnat transitcentret"],
  [/^arrive in transit center\.?$/i, "Ankom till transitcenter"],
  [/^released from customs:?\s*customs cleared\.?$/i, "Tullklarerad"],
  [/^arrival to the destination airport\.?$/i, "Ankom till destinationsflygplats"],
  [/^departure from the original airport\.?$/i, "Avgick från ursprungsflygplats"],
  [/^hand over to airline\.?$/i, "Överlämnat till flygbolag"],
  [/^shipping information received\.?$/i, "Fraktinformation mottagen"],
  [/^parcel information received\.?$/i, "Paketinformation mottagen"],
  [/^shipment information received\.?$/i, "Fraktinformation mottagen"],
  [/^shipment arrived at facility and measured\.?$/i, "Ankom till anläggning och registrerades"],
  [/^shipment picked up\.?$/i, "Hämtad av transportör"],
  [/^depart from facility to service provider\.?$/i, "Lämnade anläggningen för vidare transport"],
  [/^the shipment item is under transportation\.?$/i, "Paketet transporteras inom Sverige"],
  [/^the shipment item has arrived at the country of destination\.?$/i, "Paketet har anlänt till Sverige"],
  [/^the shipment item has been loaded\.?$/i, "Paketet är lastat för utkörning"],
  [/^a text message notification has been sent to the recipient\.?$/i, "SMS-avisering har skickats till mottagaren"],
  [/^the shipment item has been delivered at the recipient'?s door\.?$/i, "Paketet har levererats till din dörr"],
  [/^the shipment item has been delivered to the recipient'?s mailbox\.?$/i, "Paketet har levererats till din brevlåda"],
  [/^the shipment item has been delivered to the recipients mailbox\.?$/i, "Paketet har levererats till din brevlåda"],
  [/^the shipment item has been delivered to (a|the) service point\.?$/i, "Paketet finns att hämta hos ditt ombud"],
  [/^the shipment item is available for pick ?up\.?$/i, "Paketet finns att hämta"],
  [/^your item is being processed at our sorting cent(er|re)\.?$/i, "Paketet sorteras hos transportören"],
  [/^the shipment item has been handed over to a partner for transportation to the final destination\.?$/i, "Paketet har lämnats över till lokal transportör"],
  [/^we have received a notification from your shipper.*$/i, "Avsändaren har aviserat paketet – vi väntar på att det ska lämnas in"],
  [/^picking in origin country\.?$/i, "Ordern plockas och packas hos avsändaren"],
  [/^export declaration\.?$/i, "Exportdeklaration klar"],
  [/^delivered\.?$/i, "Levererad"],
  [/^out for delivery\.?$/i, "Ute för leverans"],
  [/^in transit\.?$/i, "Under transport"],
  [/^arrived at destination country\.?$/i, "Ankom till destinationslandet"],
  [/^departed from origin country\.?$/i, "Har lämnat ursprungslandet"],
  [/^customs clearance (completed|cleared)\.?$/i, "Tullklarerad"],
  [/^customs clearance\.?$/i, "Tullhantering"],
  [/^picked up\.?$/i, "Hämtad av transportör"],
  [/^delivery attempted\.?$/i, "Leveransförsök gjordes"],
];

function translateStatus(text) {
  if (!text) return "";
  const t = String(text).trim();
  for (const [re, sv] of TRANSLATIONS) if (re.test(t)) return sv;
  return t.endsWith(".") ? t.slice(0, -1) : t;
}

const COUNTRY_NAMES = {
  SE: "Sverige", SWEDEN: "Sverige", BE: "Belgien", BELGIUM: "Belgien", NL: "Nederländerna",
  DE: "Tyskland", DK: "Danmark", HK: "Hongkong", CN: "Kina", CHINA: "Kina", PL: "Polen",
  HU: "Ungern", FR: "Frankrike", GB: "Storbritannien", UK: "Storbritannien", US: "USA",
  NO: "Norge", FI: "Finland", LV: "Lettland", LT: "Litauen", EE: "Estland", AE: "Förenade Arabemiraten",
};

function prettyLocation(loc) {
  if (!loc) return "";
  let s = String(loc).trim();
  const upper = s.toUpperCase();
  if (COUNTRY_NAMES[upper]) return COUNTRY_NAMES[upper];
  s = s.replace(/,?\s*China$/i, ", Kina");
  // "MALMÖ BREVTERMINAL MALMÖ" -> "Malmö brevterminal"
  if (s === upper && /[A-ZÅÄÖ]{3,}/.test(s)) {
    s = s.toLowerCase().replace(/(^|[\s,(-])([a-zåäö])/g, (m, p, c) => p + c.toUpperCase());
    s = s.replace(/^(\S+) (Brevterminal|Terminal) \1$/i, "$1 $2").replace(/ Brevterminal/, " brevterminal");
  }
  return s;
}

module.exports = { PHASES, classifyEvent, translateStatus, prettyLocation };
