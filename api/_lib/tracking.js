// Hämtar spårning från Ship24 och bygger ett rent svar till sidan.
// Fungerar för alla transportörer som Ship24 stödjer (1500+), inte bara 4PX.
"use strict";

const { PHASES, classifyEvent, translateStatus, prettyLocation } = require("./statuses");
const carriers = require("./carriers");
const { estimate } = require("./eta");

const SHIP24 = "https://api.ship24.com/public/v1";

// Rensa och validera ett spårningsnummer
function cleanTrackingNumber(input) {
  let v = String(input || "")
    .toUpperCase()
    .replace(/[\s\-–.#]/g, "")
    .trim();
  // Vanligt skrivfel: "PX3002…CN" saknar 4:an
  if (/^PX\d{13}CN$/.test(v)) v = "4" + v;
  if (!/^[A-Z0-9]{6,40}$/.test(v)) return null;
  return v;
}

async function ship24(path, { method = "GET", body, apiKey, timeoutMs = 9000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(SHIP24 + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, ok: res.ok, json };
  } finally {
    clearTimeout(timer);
  }
}

// Courier-listan (namn + webbplats för alla 1500+ transportörer). Cachas per serverinstans.
let courierPromise = null;
function ensureCourierList(apiKey) {
  if (carriers.hasCourierList()) return Promise.resolve();
  if (!courierPromise) {
    courierPromise = ship24("/couriers", { apiKey, timeoutMs: 4000 })
      .then((r) => {
        if (r.ok) carriers.setCourierList(r.json?.data?.couriers || []);
      })
      .catch(() => {})
      .finally(() => {
        if (!carriers.hasCourierList()) courierPromise = null;
      });
  }
  return courierPromise;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchTracking(trackingNumber, apiKey, extra = {}) {
  const body = {
    trackingNumber,
    destinationCountryCode: "SE",
    ...extra,
  };

  // Hämta courier-listan parallellt (blockerar inte länge)
  const couriersReady = ensureCourierList(apiKey);

  let r = await ship24("/trackers/track", { method: "POST", body, apiKey });

  // Helt nya nummer: Ship24 hämtar data i bakgrunden – första svaret kan sakna händelser.
  // Ett nytt anrop några sekunder senare ger oftast full historik (kostar inget extra, samma tracker).
  const t0 = r.json?.data?.trackings?.[0];
  if (r.ok && t0 && (!t0.events || t0.events.length === 0)) {
    const created = Date.parse(t0.tracker?.createdAt || "");
    if (!Number.isFinite(created) || Date.now() - created < 2 * 60 * 1000) {
      await sleep(2500);
      const r2 = await ship24("/trackers/track", { method: "POST", body, apiKey });
      if (r2.ok && r2.json?.data?.trackings?.[0]?.events?.length) r = r2;
    }
  }

  await Promise.race([couriersReady, sleep(1500)]);
  return r;
}

function eventTime(e) {
  const v = e.datetime || e.occurrenceDatetime || null;
  const ms = v ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function normKey(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

// Bygger svaret som sidan visar
function buildResult(tracking, requestedTn, now = new Date()) {
  const tracker = tracking.tracker || {};
  const shipment = tracking.shipment || {};
  const rawEvents = Array.isArray(tracking.events) ? tracking.events : [];

  // --- Alla spårningsnummer ---
  const allTn = new Set();
  const addTn = (x) => {
    const v = x && (x.tn || x.trackingNumber || x);
    if (typeof v === "string" && v.trim()) allTn.add(v.trim().toUpperCase());
  };
  addTn(tracker.trackingNumber);
  (shipment.trackingNumbers || []).forEach(addTn);
  rawEvents.forEach((e) => {
    addTn(e.eventTrackingNumber);
    addTn(e.trackingNumber);
  });
  addTn(requestedTn);
  const mainTn = (tracker.trackingNumber || requestedTn || "").toUpperCase();

  // --- Händelser: klassa, sortera nyast först ---
  const evs = rawEvents
    .map((e, idx) => {
      const ms = eventTime(e);
      const cls = classifyEvent(e);
      return {
        idx,
        ms,
        raw: e,
        phase: cls.phase,
        weak: !!cls.weak,
        exception: !!cls.exception,
        courier: e.courierCode ? String(e.courierCode).toLowerCase() : null,
        tn: (e.eventTrackingNumber || e.trackingNumber || "").toUpperCase() || null,
        text: translateStatus(e.status),
        location: prettyLocation(e.location),
      };
    })
    .sort((a, b) => (b.ms ?? -Infinity) - (a.ms ?? -Infinity) || a.idx - b.idx);

  // --- Transportörer inblandade ---
  // Första ledet = transportören på den äldsta händelsen. Sista ledet = senaste "lokala" transportören.
  const couriersSeen = [];
  for (const e of [...evs].reverse()) if (e.courier && !couriersSeen.includes(e.courier)) couriersSeen.push(e.courier);
  // Komplettera med nummer-mönster (PostNord-nummer UJ…SE, CityMail BC…CN osv.)
  const numberCarriers = new Map(); // carrierId -> tn
  for (const tn of allTn) {
    const id = carriers.detectFromNumber(tn);
    if (id && !numberCarriers.has(id)) numberCarriers.set(id, tn);
  }

  const firstMile = couriersSeen[0] || carriers.detectFromNumber(mainTn) || null;
  let lastMile = null;
  for (const e of evs) {
    if (e.courier && e.courier !== firstMile) {
      lastMile = e.courier;
      break;
    }
  }
  if (!lastMile) {
    for (const [id] of numberCarriers) {
      if (id !== carriers.carrierId(firstMile) && carriers.isLocalCarrier(id)) {
        lastMile = id;
        break;
      }
    }
  }

  // Länkar för varje transportör med rätt nummer
  const carrierList = [];
  const addCarrier = (code, role) => {
    if (!code) return;
    const id = carriers.carrierId(code);
    if (carrierList.some((c) => c.id === id)) return;
    const ev = evs.find((e) => e.courier === code && e.tn);
    const tn = numberCarriers.get(id) || (ev && ev.tn) || mainTn;
    carrierList.push({
      id,
      code,
      name: carriers.prettyCourierName(code),
      trackingNumber: tn,
      url: carriers.trackingLink(code, tn),
      role,
      local: carriers.isLocalCarrier(code),
    });
  };
  addCarrier(lastMile, "last_mile");
  addCarrier(firstMile, "first_mile");
  for (const c of couriersSeen) addCarrier(c, "other");
  for (const [id] of numberCarriers) addCarrier(id, "other");

  const lastMileId = lastMile ? carriers.carrierId(lastMile) : null;

  // --- Är det en internationell försändelse? ---
  const origin = String(shipment.originCountryCode || "").toUpperCase();
  const crossBorder =
    (origin && origin !== "SE") ||
    (firstMile && carriers.isForeignCarrier(firstMile)) ||
    evs.some((e) => e.phase === "customs" || e.phase === "departed_origin" || e.phase === "eu_hub");

  // --- Avancerad fas ---
  let best = { phase: "pending", rank: 0 };
  for (const e of evs) {
    if (!e.phase || e.weak) continue;
    const rank = PHASES[e.phase].rank;
    if (rank > best.rank) best = { phase: e.phase, rank };
  }
  // Svaga signaler (SMS-avisering) räknas bara om inget starkare finns
  if (best.rank < PHASES.in_sweden.rank && evs.some((e) => e.weak)) best = { phase: "in_sweden", rank: PHASES.in_sweden.rank };

  // Ship24:s egen milstolpe kan vara mer avancerad (t.ex. för okända transportörer)
  const shipMilestone = String(shipment.statusMilestone || "").toLowerCase();
  const msMap = { delivered: "delivered", available_for_pickup: "available_for_pickup", out_for_delivery: "out_for_delivery" };
  if (msMap[shipMilestone] && PHASES[msMap[shipMilestone]].rank > best.rank) {
    best = { phase: msMap[shipMilestone], rank: PHASES[msMap[shipMilestone]].rank };
  }

  // Misslyckat leveransförsök: bara aktuellt om det är det senaste som hänt
  if (best.phase === "failed_attempt" || best.phase === "out_for_delivery") {
    const latestClassified = evs.find((e) => e.phase && !e.weak);
    if (latestClassified && latestClassified.phase === "failed_attempt") best = { phase: "failed_attempt", rank: PHASES.failed_attempt.rank };
    else if (best.phase === "failed_attempt") best = { phase: "out_for_delivery", rank: PHASES.out_for_delivery.rank };
  }

  // Fasens start = äldsta händelsen i den fasen
  const phaseEvents = evs.filter((e) => e.phase === best.phase && e.ms != null);
  const phaseStartMs = phaseEvents.length ? Math.min(...phaseEvents.map((e) => e.ms)) : null;
  const timed = evs.filter((e) => e.ms != null);
  const lastEventMs = timed.length ? timed[0].ms : null;
  const firstEventMs = timed.length ? timed[timed.length - 1].ms : null;
  const deliveredEv = evs.find((e) => e.phase === "delivered" && e.ms != null);

  // Undantag (retur, förlorat) räknas bara om det är senaste händelsen och inte levererat
  const exception =
    best.phase !== "delivered" &&
    (shipMilestone === "exception" || (evs[0] && evs[0].exception));

  const eta = estimate({
    phase: best.phase,
    phaseStart: phaseStartMs != null ? new Date(phaseStartMs) : null,
    lastEventAt: lastEventMs != null ? new Date(lastEventMs) : null,
    firstEventAt: firstEventMs != null ? new Date(firstEventMs) : null,
    deliveredAt: deliveredEv ? new Date(deliveredEv.ms) : null,
    crossBorder: !!crossBorder,
    lastMileCarrier: lastMileId,
    courierEstimate: shipment.delivery?.estimatedDeliveryDate || null,
    exception,
    now,
  });

  // --- Händelselista: ta bort dubbletter (4PX speglar ofta PostNord/CityMail) ---
  const out = [];
  const hasLocalDelivered = evs.some((e) => e.phase === "delivered" && e.courier && e.courier !== firstMile);
  for (const e of evs) {
    if (!e.text) continue;
    if (hasLocalDelivered && e.phase === "delivered" && e.courier === firstMile) continue;
    const key = normKey(e.text);
    const dup = out.find((o) => o._key === key && o._ms != null && e.ms != null && Math.abs(o._ms - e.ms) < 36 * 3600 * 1000);
    if (dup) {
      // behåll den lokala transportörens version
      if (dup._courier === firstMile && e.courier && e.courier !== firstMile) {
        Object.assign(dup, { datetime: e.ms ? new Date(e.ms).toISOString() : null, location: e.location || dup.location, courier: carriers.prettyCourierName(e.courier), _courier: e.courier, _ms: e.ms });
      } else if (!dup.location && e.location) {
        dup.location = e.location;
      }
      continue;
    }
    out.push({
      datetime: e.ms != null ? new Date(e.ms).toISOString() : null,
      hasNoTime: !!e.raw.hasNoTime,
      status: e.text,
      location: e.location || null,
      courier: e.courier ? carriers.prettyCourierName(e.courier) : null,
      phase: e.phase,
      _key: key,
      _ms: e.ms,
      _courier: e.courier,
    });
  }
  // Dölj utländsk första-lednings-transportör (t.ex. 4PX) för kunden – sätt
  // SHOW_ORIGIN_CARRIER=true i Vercel om du vill visa den.
  const hideOrigin = crossBorder && process.env.SHOW_ORIGIN_CARRIER !== "true";
  const events = out.map(({ _key, _ms, _courier, ...rest }) => {
    if (hideOrigin && _courier && _courier === firstMile && carriers.isForeignCarrier(_courier)) rest.courier = null;
    return rest;
  });
  const visibleCarriers = hideOrigin ? carrierList.filter((c) => !(c.role === "first_mile" && carriers.isForeignCarrier(c.code))) : carrierList;

  const meta = PHASES[best.phase] || PHASES.pending;

  return {
    ok: true,
    trackingNumber: mainTn,
    phase: best.phase,
    exception: !!exception,
    progress: { pct: exception ? Math.min(meta.pct, 70) : meta.pct, step: meta.step },
    crossBorder: !!crossBorder,
    carriers: visibleCarriers,
    lastMile: visibleCarriers.find((c) => c.role === "last_mile") || null,
    eta,
    lastEventAt: lastEventMs != null ? new Date(lastEventMs).toISOString() : null,
    checkedAt: new Date().toISOString(),
    events,
    // Bakåtkompatibla fält (gamla sidan / mejl)
    statusMilestone: shipment.statusMilestone || null,
    postnordNumber: numberCarriers.get("postnord") || null,
    citymailNumber: numberCarriers.get("citymail") || null,
  };
}

module.exports = { cleanTrackingNumber, fetchTracking, buildResult, ship24 };
