const { Resend } = require("resend");
const { createClient } = require("@supabase/supabase-js");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );

  const resend = new Resend(process.env.RESEND_API_KEY);
  const SHIP24_API_KEY = process.env.SHIP24_API_KEY;
  const TRACK_URL_BASE = process.env.TRACK_URL_BASE;

  // 1. Hämta alla ordrar
const { data: orders, error } = await supabase.from("Orders").select("*");


  if (error) {
    console.error("Supabase error:", error);
    return res
      .status(500)
      .json({ error: "supabase error", details: error.message || error });
  }

  let sentCount = 0;

  for (const order of orders || []) {
    if (!order.tracking_number || !order.email) continue;

    const currentStatus = await getShip24Status(
      order.tracking_number,
      SHIP24_API_KEY
    );
    if (!currentStatus) continue;

    const emailType = mapStatusToEmailType(currentStatus);
    if (!emailType) continue;

    if (emailType !== order.last_status) {
      await sendStatusEmail({
        resend,
        to: order.email,
        name: order.name,
        trackingNumber: order.tracking_number,
        emailType,
        trackUrl: TRACK_URL_BASE,
      });

      await supabase
        .from("orders")
        .update({
          last_status: emailType,
          last_checked_at: new Date().toISOString(),
        })
        .eq("id", order.id);

      sentCount++;
    }
  }

  return res.status(200).json({ ok: true, sentCount });
};

async function getShip24Status(trackingNumber, apiKey) {
  const res = await fetch(
    "https://api.ship24.com/public/v1/trackers/trackings",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Ship24-API-Key": apiKey,
      },
      body: JSON.stringify({ trackingNumbers: [trackingNumber] }),
    }
  );

  const json = await res.json();

  let tracker = null;
  if (json?.data?.trackings?.length) tracker = json.data.trackings[0];
  else if (Array.isArray(json?.data) && json.data.length)
    tracker = json.data[0];

  if (!tracker?.events?.length) return null;

  const latest = tracker.events[0];
  return latest.statusCode || latest.statusCategory || null;
}

function mapStatusToEmailType(status) {
  const s = status.toLowerCase();
  if (s.includes("delivered")) return "delivered";
  if (s.includes("pickup") || s.includes("out_for_delivery"))
    return "pickup_ready";
  if (s.includes("in_transit") || s.includes("transit")) return "in_transit";
  if (s.includes("created")) return "tracking_created";
  return null;
}

async function sendStatusEmail({
  resend,
  to,
  name,
  trackingNumber,
  emailType,
  trackUrl,
}) {
  const link = `${trackUrl}${encodeURIComponent(trackingNumber)}`;

  let subject = "";
  let html = "";

  if (emailType === "tracking_created") {
    subject = "Ditt spårningsnummer är skapat";
    html = `
      <p>Hej ${name || ""},</p>
      <p>Ditt paket har fått ett spårningsnummer: <b>${trackingNumber}</b>.</p>
      <p>Spåra din beställning: <a href="${link}">${link}</a></p>
      <p>Vänliga hälsningar<br/>Icefot</p>
    `;
  } else if (emailType === "in_transit") {
    subject = "Ditt paket är på väg";
    html = `
      <p>Hej ${name || ""},</p>
      <p>Ditt paket är nu på väg.</p>
      <p>Spåra här: <a href="${link}">${link}</a></p>
      <p>Vänliga hälsningar<br/>Icefot</p>
    `;
  } else if (emailType === "pickup_ready") {
    subject = "Ditt paket finns att hämta";
    html = `
      <p>Hej ${name || ""},</p>
      <p>Ditt paket har anlänt till utlämningsstället. Kom ihåg att hämta det i tid.</p>
      <p>Spåra här: <a href="${link}">${link}</a></p>
      <p>Vänliga hälsningar<br/>Icefot</p>
    `;
  } else if (emailType === "delivered") {
    subject = "Ditt paket är levererat";
    html = `
      <p>Hej ${name || ""},</p>
      <p>Enligt spårningen är ditt paket levererat.</p>
      <p>Vänliga hälsningar<br/>Icefot</p>
    `;
  } else {
    return;
  }

  await resend.emails.send({
    from: "Icefot <no-reply@icefot.se>",
    to,
    subject,
    html,
  });
}
