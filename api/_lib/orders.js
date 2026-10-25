// Order-uppslag: ordernummer + e-post -> spårningsnummer.
//
// Källa 1 (rekommenderad): Supabase-tabell "orders" (privat, inget kunddata i GitHub).
//   Miljövariabler: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
// Källa 2 (fallback under flytten): api/orders-data.js
"use strict";

function cleanOrderNumber(v) {
  return String(v || "").replace(/[^0-9A-Za-z]/g, "").trim();
}

function cleanEmail(v) {
  return String(v || "").trim().toLowerCase();
}

function fixTn(tn) {
  let v = String(tn || "").toUpperCase().replace(/\s/g, "");
  if (/^PX\d{13}CN$/.test(v)) v = "4" + v;
  return v;
}

function supabaseConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/$/, ""), key, table: process.env.ORDERS_TABLE || "orders" };
}

async function supabaseRequest(path, { method = "GET", body, prefer } = {}) {
  const cfg = supabaseConfig();
  if (!cfg) throw new Error("Supabase not configured");
  const res = await fetch(`${cfg.url}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: cfg.key,
      Authorization: `Bearer ${cfg.key}`,
      "Content-Type": "application/json",
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!res.ok) {
    const err = new Error(`Supabase ${res.status}: ${typeof json === "string" ? json : JSON.stringify(json)}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

let localIndex = null;
function loadLocal() {
  if (localIndex) return localIndex;
  let rows = [];
  try {
    rows = require("../orders-data");
  } catch {
    rows = [];
  }
  const map = new Map();
  rows.forEach((r, i) => {
    const key = cleanOrderNumber(r.order_number);
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ email: cleanEmail(r.email), tracking_number: fixTn(r.tracking_number), _i: i });
  });
  localIndex = map;
  return map;
}

/**
 * Returnerar spårningsnummer för ordern (nyaste först), eller [] om ingen träff.
 */
async function findTrackingNumbers(orderNumber, email) {
  const order = cleanOrderNumber(orderNumber);
  const mail = cleanEmail(email);
  if (!order || !mail) return [];

  const cfg = supabaseConfig();
  if (cfg) {
    try {
      const rows = await supabaseRequest(
        `${cfg.table}?select=tracking_number,created_at&order_number=eq.${encodeURIComponent(order)}&email=eq.${encodeURIComponent(mail)}&order=created_at.desc`
      );
      const list = [...new Set((rows || []).map((r) => fixTn(r.tracking_number)).filter(Boolean))];
      if (list.length) return list;
    } catch (e) {
      console.error("[orders] Supabase-fel, använder fallback:", e.message);
    }
  }

  const hits = (loadLocal().get(order) || []).filter((r) => r.email === mail);
  // Senast tillagda rad = nyaste paketet (t.ex. omskick)
  return [...new Set(hits.sort((a, b) => b._i - a._i).map((r) => r.tracking_number))];
}

module.exports = { findTrackingNumbers, supabaseConfig, supabaseRequest, cleanOrderNumber, cleanEmail, fixTn };
