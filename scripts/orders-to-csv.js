// Gör om api/orders-data.js till orders.csv som du kan importera i Supabase
// (Table Editor > orders > Insert > Import data from CSV).
// Kör lokalt:  node scripts/orders-to-csv.js
// OBS: orders.csv innehåller kunddata – ladda INTE upp den till GitHub (den är gitignorerad).
const fs = require("fs");
const path = require("path");
const rows = require(path.join(__dirname, "..", "api", "orders-data.js"));

const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const seen = new Set();
const lines = ["order_number,email,tracking_number,created_at"];
// Ge raderna stigande tidsstämplar så att senast tillagda (t.ex. omskick) räknas som nyast
const base = Date.now() - rows.length * 1000;
rows.forEach((r, i) => {
  let tn = String(r.tracking_number || "").toUpperCase().trim();
  if (/^PX\d{13}CN$/.test(tn)) tn = "4" + tn;
  const order = String(r.order_number || "").replace(/[^0-9A-Za-z]/g, "");
  const email = String(r.email || "").trim().toLowerCase();
  if (!order || !tn || !email.includes("@")) return;
  const key = order + "|" + tn;
  if (seen.has(key)) return;
  seen.add(key);
  lines.push([order, email, tn, new Date(base + i * 1000).toISOString()].map(esc).join(","));
});
fs.writeFileSync(path.join(__dirname, "..", "orders.csv"), lines.join("\n") + "\n");
console.log(`Klart: ${lines.length - 1} rader -> orders.csv`);
