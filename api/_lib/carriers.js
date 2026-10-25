// Transportörer: namn, spårningslänkar och igenkänning av nummer.
// Ship24 känner igen 1500+ transportörer automatiskt – den här listan används bara
// för snygga namn och direktlänkar. Okända transportörer får namn från Ship24:s
// courier-lista och länk till deras webbplats.
"use strict";

const KNOWN = [
  { id: "postnord", match: /postnord|posten-se|sweden-post|^posten$/, name: "PostNord", url: "https://www.postnord.se/vara-verktyg/spara-brev-paket-och-pall?shipmentId={tn}", local: true },
  { id: "citymail", match: /citymail/, name: "CityMail", url: "https://tracking.citymail.se/?search={tn}", local: true },
  { id: "budbee", match: /budbee/, name: "Budbee", url: "https://budbee.com/", local: true },
  { id: "instabox", match: /instabox|instabee/, name: "Instabox", url: "https://instabox.io/", local: true },
  { id: "earlybird", match: /early-?bird/, name: "Early Bird", url: "https://earlybird.se/", local: true },
  { id: "airmee", match: /airmee/, name: "Airmee", url: "https://www.airmee.com/", local: true },
  { id: "bring", match: /bring/, name: "Bring", url: "https://tracking.bring.se/tracking/{tn}", local: true },
  { id: "schenker", match: /schenker/, name: "DB Schenker", url: "https://www.dbschenker.com/app/tracking-public/?refNumber={tn}", local: true },
  { id: "dhl", match: /^dhl/, name: "DHL", url: "https://www.dhl.com/se-sv/home/tracking.html?tracking-id={tn}&submit=1", local: true },
  { id: "ups", match: /^ups/, name: "UPS", url: "https://www.ups.com/track?loc=sv_SE&tracknum={tn}", local: true },
  { id: "fedex", match: /fedex/, name: "FedEx", url: "https://www.fedex.com/fedextrack/?trknbr={tn}", local: true },
  { id: "gls", match: /^gls/, name: "GLS", url: "https://gls-group.com/SE/sv/", local: true },
  { id: "dpd", match: /^dpd/, name: "DPD", url: "https://tracking.dpd.de/status/sv_SE/parcel/{tn}", local: true },
  { id: "4px", match: /4px/, name: "4PX", url: "https://track.4px.com/#/result/0/{tn}", local: false },
  { id: "yunexpress", match: /yun-?express|yuntrack/, name: "YunExpress", url: "https://www.yuntrack.com/parcelTracking?id={tn}", local: false },
  { id: "cainiao", match: /cainiao|aliexpress/, name: "Cainiao", url: "https://global.cainiao.com/newDetail.htm?mailNoList={tn}", local: false },
  { id: "yanwen", match: /yanwen/, name: "Yanwen", url: "https://track.yw56.com.cn/en/querydel?nums={tn}", local: false },
  { id: "chinapost", match: /china-?post|china-?ems/, name: "China Post", url: "https://www.ship24.com/tracking?p={tn}", local: false },
];

// Gissa transportör från själva numret (används när Ship24 inte anger courierCode)
const NUMBER_PATTERNS = [
  { id: "4px", re: /^4PX\d{10,}CN$/i },
  { id: "citymail", re: /^BC[A-Z]*\d{8,}CN$/i },
  { id: "postnord", re: /^[A-Z]{2}\d{9}SE$/i },
  { id: "postnord", re: /^00373\d{13,}$/ },
  { id: "dhl", re: /^JJD\d{10,}$/i },
  { id: "dhl", re: /^JVGL\d{10,}$/i },
  { id: "ups", re: /^1Z[0-9A-Z]{16}$/i },
  { id: "yunexpress", re: /^YT\d{16}$/i },
  { id: "cainiao", re: /^(LP|CNG|AE)\d{10,}/i },
  { id: "budbee", re: /^BUD[A-Z0-9]+$/i },
];

let courierListCache = null; // Map courierCode -> { name, website }

function setCourierList(list) {
  const map = new Map();
  for (const c of list || []) {
    if (c && c.courierCode) {
      map.set(String(c.courierCode).toLowerCase(), {
        name: c.courierName || c.courierCode,
        website: c.website || null,
        isPost: !!c.isPost,
        countryCode: c.countryCode || null,
      });
    }
  }
  courierListCache = map;
}

function knownFor(code) {
  const c = String(code || "").toLowerCase();
  if (!c) return null;
  return KNOWN.find((k) => k.id === c || k.match.test(c)) || null;
}

function detectFromNumber(tn) {
  const v = String(tn || "").trim();
  const hit = NUMBER_PATTERNS.find((p) => p.re.test(v));
  return hit ? hit.id : null;
}

function prettyCourierName(code) {
  const known = knownFor(code);
  if (known) return known.name;
  const fromList = courierListCache && courierListCache.get(String(code || "").toLowerCase());
  if (fromList) return fromList.name;
  if (!code) return "Transportör";
  return String(code)
    .split(/[-_]/)
    .map((w) => (w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

function trackingLink(code, tn) {
  const known = knownFor(code);
  if (known && known.url) {
    return known.url.includes("{tn}") ? known.url.replace("{tn}", encodeURIComponent(tn)) : known.url;
  }
  const fromList = courierListCache && courierListCache.get(String(code || "").toLowerCase());
  if (fromList && fromList.website) return fromList.website;
  return null;
}

function carrierId(code) {
  const known = knownFor(code);
  return known ? known.id : String(code || "").toLowerCase() || null;
}

function isLocalCarrier(code) {
  const known = knownFor(code);
  if (known) return known.local;
  const fromList = courierListCache && courierListCache.get(String(code || "").toLowerCase());
  return !!(fromList && fromList.countryCode && String(fromList.countryCode).toUpperCase() === "SE");
}

// Säkert utländsk (känd utländsk transportör, eller Ship24 anger annat land än SE)
function isForeignCarrier(code) {
  const known = knownFor(code);
  if (known) return !known.local;
  const fromList = courierListCache && courierListCache.get(String(code || "").toLowerCase());
  return !!(fromList && fromList.countryCode && String(fromList.countryCode).toUpperCase() !== "SE");
}

module.exports = {
  isForeignCarrier,
  KNOWN,
  setCourierList,
  hasCourierList: () => !!courierListCache,
  detectFromNumber,
  prettyCourierName,
  trackingLink,
  carrierId,
  isLocalCarrier,
};
