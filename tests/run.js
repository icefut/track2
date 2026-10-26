// Enkla tester: node tests/run.js
// Händelserna nedan är kopierade från riktiga ICEFOT-försändelser (med påhittade nummer).
"use strict";

const assert = require("assert");
const { buildResult, cleanTrackingNumber } = require("../api/_lib/tracking");
const D = require("../api/_lib/dates");
const { parseOrders } = require("../api/admin-orders");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ✓ " + name);
  } catch (e) {
    console.log("  ✗ " + name + "\n    " + e.message);
    process.exitCode = 1;
  }
}

const ev = (datetime, courierCode, status, location = null, extra = {}) => ({ datetime, occurrenceDatetime: datetime, courierCode, status, location, statusMilestone: "in_transit", ...extra });

// 4PX -> CityMail, levererad (riktig sekvens)
const CITYMAIL_DELIVERED = {
  tracker: { trackingNumber: "4PX3000000000001CN", createdAt: "2026-09-14T10:00:00Z" },
  shipment: { statusMilestone: "delivered", trackingNumbers: [{ tn: "4PX3000000000001CN" }, { tn: "BCMDP3000000000001CN" }] },
  events: [
    ev("2026-09-24T10:55:00.000Z", "citymail", "Paketet har levererats hem till dig", "425 30 Hisings kärra", { eventTrackingNumber: "BCMDP3000000000001CN", statusMilestone: "delivered" }),
    ev("2026-09-24T07:44:00.000Z", "citymail", "Paketet förbereds för leverans", null, { eventTrackingNumber: "BCMDP3000000000001CN" }),
    ev("2026-09-24T02:55:04.000Z", "4px", "Delivered", "425 30 Hisings kärra", { statusMilestone: "delivered" }),
    ev("2026-09-23T23:44:25.000Z", "4px", "Paketet förbereds för leverans", "SWEDEN"),
    ev("2026-09-23T04:27:00.000Z", "citymail", "Paket har ankommit till vår terminal", "Terminal Malmö", { eventTrackingNumber: "BCMDP3000000000001CN" }),
    ev("2026-09-22T20:27:32.000Z", "4px", "Paket har ankommit till vår terminal", "Terminal Malmö"),
    ev("2026-09-21T05:22:54.000Z", "4px", "Transiting in Destination Country"),
    ev("2026-09-20T14:52:16.000Z", "4px", "Transiting in Destination Country", "BE"),
    ev("2026-09-20T09:04:08.000Z", "4px", "Import Clearance"),
    ev("2026-09-20T07:04:08.000Z", "4px", "Transiting by Air or Ship"),
    ev("2026-09-19T02:02:28.000Z", "4px", "Transiting by Air or Ship"),
    ev("2026-09-16T20:41:01.000Z", "4px", "Operations in Warehouse", "Nancheng"),
    ev("2026-09-15T02:43:00.000Z", "4px", "Shipping information received", null, { statusMilestone: "info_received" }),
  ],
};

// 4PX på väg, senaste = tullen
function inTransitCustoms() {
  return {
    tracker: { trackingNumber: "4PX3000000000002CN", createdAt: "2026-10-14T10:00:00Z" },
    shipment: { statusMilestone: "in_transit", trackingNumbers: [{ tn: "4PX3000000000002CN" }, { tn: "UJ000000001SE" }] },
    events: [
      ev("2026-10-20T09:04:08.000Z", "4px", "Import Clearance"),
      ev("2026-10-20T07:04:08.000Z", "4px", "Transiting by Air or Ship"),
      ev("2026-10-17T20:41:01.000Z", "4px", "Operations in Warehouse", "Nancheng"),
      ev("2026-10-16T02:43:00.000Z", "4px", "Shipping information received", null, { statusMilestone: "info_received" }),
    ],
  };
}

// PostNord-sista ledet, lastat för utkörning
const POSTNORD_LOADED = {
  tracker: { trackingNumber: "4PX3000000000003CN" },
  shipment: { statusMilestone: "in_transit", trackingNumbers: [{ tn: "4PX3000000000003CN" }, { tn: "UJ426900000SE" }] },
  events: [
    ev("2026-10-26T05:00:00.000Z", "4px", "The shipment item has been loaded.", "UMEÅ"),
    ev("2026-10-23T03:09:00.000Z", "4px", "The shipment item is under transportation.", "MALMÖ BREVTERMINAL MALMÖ"),
    ev("2026-10-22T08:07:00.000Z", "4px", "The shipment item has arrived at the country of destination."),
    ev("2026-10-20T07:38:00.000Z", "4px", "Transiting in Destination Country"),
    ev("2026-10-19T22:56:00.000Z", "4px", "Import Clearance"),
    ev("2026-10-17T23:25:00.000Z", "4px", "Transiting by Air or Ship"),
    ev("2026-10-15T22:28:00.000Z", "4px", "Operations in Warehouse", "Nancheng"),
  ],
};

// Inrikes DHL-paket (ingen 4PX) – visar att alla transportörer fungerar
const DHL_DOMESTIC = {
  tracker: { trackingNumber: "JJD000390000000001" },
  shipment: { statusMilestone: "in_transit", originCountryCode: "SE", destinationCountryCode: "SE", trackingNumbers: [{ tn: "JJD000390000000001" }] },
  events: [
    ev("2026-10-25T14:00:00.000Z", "dhl-se", "Försändelsen har ankommit till terminal", "Jönköping", { statusCode: null }),
    ev("2026-10-24T16:00:00.000Z", "dhl-se", "Försändelsen har hämtats", "Stockholm", { statusCode: "transit_handover" }),
  ],
};

// Okänd transportör med bara Ship24-koder
const UNKNOWN_CARRIER_PICKUP = {
  tracker: { trackingNumber: "ZZ123456789XX" },
  shipment: { statusMilestone: "available_for_pickup", trackingNumbers: [{ tn: "ZZ123456789XX" }] },
  events: [
    ev("2026-10-25T09:00:00.000Z", "some-courier", "Paket kvitterat i skåp", "Solna", { statusCode: "delivery_available_for_pickup", statusMilestone: "available_for_pickup" }),
    ev("2026-10-24T09:00:00.000Z", "some-courier", "Mottaget", "Solna", { statusCode: "transit_handover" }),
  ],
};

const NOW = new Date("2026-10-26T10:00:00Z"); // måndag

console.log("Datum");
test("helgdagar 2026: långfredag, midsommarafton, juldagen", () => {
  const h = D.swedishNonDeliveryDays(2026);
  assert(h.has("2026-04-03"));
  assert(h.has("2026-06-19"));
  assert(h.has("2026-12-25"));
});
test("arbetsdagar hoppar över helg", () => {
  const fri = D.ymdToDay("2026-10-23");
  assert.strictEqual(D.dayToYmd(D.addBusinessDays(fri, 1)), "2026-10-26");
});

console.log("Spårningsnummer");
test("rensar mellanslag och lägger till saknad 4:a", () => {
  assert.strictEqual(cleanTrackingNumber(" 4px 3002 3025 1231 8cn "), "4PX3002302512318CN");
  assert.strictEqual(cleanTrackingNumber("PX3002641386212CN"), "4PX3002641386212CN");
  assert.strictEqual(cleanTrackingNumber("<script>"), null);
});

console.log("CityMail levererad");
const r1 = buildResult(CITYMAIL_DELIVERED, "4PX3000000000001CN", NOW);
test("fas = levererad, 100%", () => {
  assert.strictEqual(r1.phase, "delivered");
  assert.strictEqual(r1.progress.pct, 100);
  assert.strictEqual(r1.eta.state, "delivered");
});
test("sista ledet = CityMail med rätt nummer + länk", () => {
  assert.strictEqual(r1.lastMile.id, "citymail");
  assert.strictEqual(r1.lastMile.trackingNumber, "BCMDP3000000000001CN");
  assert(r1.lastMile.url.includes("BCMDP3000000000001CN"));
});
test("dubbletter från 4PX bortplockade", () => {
  const terminal = r1.events.filter((e) => /terminal/i.test(e.status));
  assert.strictEqual(terminal.length, 1);
  assert.strictEqual(r1.events.filter((e) => e.phase === "delivered").length, 1);
});
test("översatt till svenska", () => {
  assert(r1.events.some((e) => e.status === "Tullhantering vid import"));
  assert(r1.events.some((e) => e.location === "Belgien"));
});

test("4PX visas inte för kunden (bara svenska transportören)", () => {
  assert(!r1.carriers.some((c) => c.id === "4px"));
  assert(!r1.events.some((e) => e.courier === "4PX"));
});

console.log("4PX i tullen");
const r2 = buildResult(inTransitCustoms(), "4PX3000000000002CN", NOW);
test("fas = tull, prognos med datum framåt", () => {
  assert.strictEqual(r2.phase, "customs");
  assert.strictEqual(r2.eta.state, "estimate");
  // tull 20 okt + 4..8 arbetsdagar = 26 okt .. 30 okt
  assert.strictEqual(r2.eta.minDate, "2026-10-26");
  assert.strictEqual(r2.eta.maxDate, "2026-10-30");
  assert.strictEqual(r2.lastMile.id, "postnord");
});
test("försenad om prognosen passerats", () => {
  const late = buildResult(inTransitCustoms(), "x", new Date("2026-11-02T10:00:00Z"));
  assert.strictEqual(late.eta.state, "delayed");
  assert(late.eta.minDate >= "2026-11-02");
  assert.strictEqual(late.eta.stale, true);
});
test("ingen skanning på 14+ dagar => kontakta oss", () => {
  const old = buildResult(inTransitCustoms(), "x", new Date("2026-11-05T10:00:00Z"));
  assert.strictEqual(old.eta.state, "contact");
  assert.strictEqual(old.eta.contactUs, true);
});

console.log("PostNord lastat");
const r3 = buildResult(POSTNORD_LOADED, "4PX3000000000003CN", NOW);
test("ute för leverans idag", () => {
  assert.strictEqual(r3.phase, "out_for_delivery");
  assert.strictEqual(r3.eta.title, "Idag");
  assert.strictEqual(r3.lastMile.id, "postnord");
  assert(r3.lastMile.url.includes("UJ426900000SE"));
});
test("plats snyggt formaterad", () => {
  assert(r3.events.some((e) => e.location === "Malmö brevterminal"));
});

console.log("Andra transportörer");
const r4 = buildResult(DHL_DOMESTIC, "JJD000390000000001", NOW);
test("DHL inrikes: i Sverige, kort prognos, DHL-länk", () => {
  assert.strictEqual(r4.crossBorder, false);
  assert.strictEqual(r4.phase, "in_sweden");
  assert.strictEqual(r4.carriers[0].name, "DHL");
  assert(r4.carriers[0].url.includes("dhl.com"));
  assert(r4.eta.maxDate <= "2026-10-28");
});
const r5 = buildResult(UNKNOWN_CARRIER_PICKUP, "ZZ123456789XX", NOW);
test("okänd transportör via Ship24-koder: klar att hämta", () => {
  assert.strictEqual(r5.phase, "available_for_pickup");
  assert.strictEqual(r5.eta.state, "pickup");
  assert.strictEqual(r5.carriers[0].name, "Some Courier");
});
test("inga händelser => väntar på första skanning", () => {
  const r = buildResult({ tracker: { trackingNumber: "LZ123" }, shipment: { statusMilestone: "pending" }, events: [] }, "LZ123", NOW);
  assert.strictEqual(r.phase, "pending");
  assert.strictEqual(r.eta.state, "unknown");
});
test("retur => undantag/kontakta oss", () => {
  const t = inTransitCustoms();
  t.events.unshift(ev("2026-10-24T09:00:00.000Z", "4px", "Returned to sender", null, { statusCode: "exception_return", statusMilestone: "exception" }));
  const r = buildResult(t, "x", NOW);
  assert.strictEqual(r.exception, true);
  assert.strictEqual(r.eta.state, "exception");
});

console.log("Admin-import");
test("läser gamla orders-data-formatet", () => {
  const { rows } = parseOrders(`{ order_number: "37160", email: "A@B.se", tracking_number: "4PX3003133618972CN" },\n{ order_number: "37159", email: "c@d.com", tracking_number: "PX3003133620135CN" }`);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].email, "a@b.se");
  assert.strictEqual(rows[1].tracking_number, "4PX3003133620135CN");
});
test("läser rader med komma/tabb", () => {
  const { rows } = parseOrders("37160\ta@b.se\t4PX3003133618972CN\n#37161; x@y.se; UJ426909956SE");
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[1].order_number, "37161");
});

console.log(`\n${passed} tester OK${process.exitCode ? " – men några misslyckades" : ""}`);
