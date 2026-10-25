// Leveransprognos (ETA) med riktiga datum.
//
// Hur det fungerar:
// 1. Vi tar fram den mest avancerade fasen paketet nått (t.ex. "tullhantering").
// 2. Vi räknar arbetsdagar FRÅN NÄR fasen började (inte från idag) – annars "fryser"
//    prognosen när spårningen står still i flera dagar.
// 3. Intervallen är kalibrerade mot riktiga ICEFOT-leveranser (4PX -> PostNord/CityMail,
//    juni–sept 2026): antal arbetsdagar från fasens första händelse till "levererad".
// 4. Har prognosen passerats visar vi "något försenat" med ett nytt kort intervall i stället
//    för ett datum som redan varit.
"use strict";

const D = require("./dates");

// [min, troligast, max] arbetsdagar kvar från fasens start. Kalibrerat (p10 / median / p90).
const CROSS_BORDER = {
  label_created: [9, 12, 14],
  origin_facility: [6, 9, 11],
  departed_origin: [5, 7, 9],
  customs: [4, 6, 8],
  eu_hub: [3, 6, 8],
  in_sweden: { postnord: [1, 3, 6], citymail: [2, 4, 5], default: [1, 3, 6] },
  out_for_delivery: { postnord: [0, 0, 1], citymail: [1, 3, 5], default: [0, 0, 1] },
  failed_attempt: [1, 1, 3],
};

// Inrikes/okända försändelser (t.ex. PostNord, DHL, Budbee direkt inom Sverige)
const DOMESTIC = {
  label_created: [1, 2, 4],
  origin_facility: [1, 2, 3],
  departed_origin: [1, 2, 3],
  customs: [1, 2, 4],
  eu_hub: [1, 2, 4],
  in_sweden: [1, 1, 3],
  out_for_delivery: [0, 0, 0],
  failed_attempt: [1, 1, 2],
};

const WEEKDAYS = ["sön", "mån", "tis", "ons", "tor", "fre", "lör"];
const MONTHS = ["jan", "feb", "mars", "apr", "maj", "juni", "juli", "aug", "sep", "okt", "nov", "dec"];

function fmtDay(day) {
  return `${WEEKDAYS[day.getUTCDay()]} ${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]}`;
}

function rangeLabel(minDay, maxDay, todayDay) {
  const tomorrow = D.addDays(todayDay, 1);
  const same = (a, b) => a.getTime() === b.getTime();
  const name = (d) => (same(d, todayDay) ? "idag" : same(d, tomorrow) ? "imorgon" : fmtDay(d));
  if (same(minDay, maxDay)) {
    const n = name(minDay);
    return n[0].toUpperCase() + n.slice(1);
  }
  const a = name(minDay);
  return `${a[0].toUpperCase() + a.slice(1)} – ${name(maxDay)}`;
}

function pickTable(phase, crossBorder, carrier) {
  const table = crossBorder ? CROSS_BORDER : DOMESTIC;
  const entry = table[phase];
  if (!entry) return null;
  if (Array.isArray(entry)) return entry;
  return entry[carrier] || entry.default;
}

/**
 * @param {object} p
 * @param {string} p.phase
 * @param {Date|null} p.phaseStart        första händelsen i nuvarande fas
 * @param {Date|null} p.lastEventAt       senaste händelsen över huvud taget
 * @param {Date|null} p.firstEventAt
 * @param {boolean} p.crossBorder         internationell försändelse (t.ex. från Kina)
 * @param {string|null} p.lastMileCarrier "postnord" | "citymail" | ...
 * @param {string|null} p.courierEstimate ISO-datum från transportören (Ship24 estimatedDeliveryDate)
 * @param {boolean} p.exception
 * @param {Date} [p.now]
 */
function estimate(p) {
  const now = p.now || new Date();
  const today = D.ymdToDay(D.ymdInSweden(now));
  const daysSinceLast = p.lastEventAt ? D.calendarDaysBetween(D.ymdToDay(D.ymdInSweden(p.lastEventAt)), today) : null;

  const base = {
    state: "unknown",
    title: "",
    subtitle: "",
    minDate: null,
    maxDate: null,
    likelyDate: null,
    daysSinceLastEvent: daysSinceLast,
    stale: false,
    contactUs: false,
  };

  if (p.phase === "delivered") {
    return { ...base, state: "delivered", title: "Levererad", subtitle: p.lastEventAt ? `Levererades ${fmtDay(D.ymdToDay(D.ymdInSweden(p.deliveredAt || p.lastEventAt)))}.` : "Paketet har levererats." };
  }

  if (p.phase === "available_for_pickup") {
    return { ...base, state: "pickup", title: "Klar att hämta", subtitle: "Paketet väntar på dig hos ombudet. Ta med legitimation och hämta inom liggtiden (oftast 7–14 dagar)." };
  }

  if (p.exception) {
    return { ...base, state: "exception", title: "Kontakta oss", subtitle: "Transportören rapporterar ett problem med försändelsen. Hör av dig så löser vi det.", contactUs: true };
  }

  if (p.phase === "pending" || !p.phaseStart) {
    return { ...base, state: "unknown", title: "Inväntar första skanning", subtitle: "Prognosen visas så fort transportören registrerat paketet. Det tar oftast 1–3 dagar efter att du fått spårningsnumret." };
  }

  // Transportörens egen prognos används för inrikes paket om den finns och är rimlig
  if (!p.crossBorder && p.courierEstimate) {
    const est = new Date(p.courierEstimate);
    if (!isNaN(est.getTime())) {
      const estDay = D.ymdToDay(D.ymdInSweden(est));
      if (estDay >= today) {
        return {
          ...base,
          state: "estimate",
          title: rangeLabel(estDay, estDay, today),
          subtitle: "Prognos från transportören.",
          minDate: D.dayToYmd(estDay),
          maxDate: D.dayToYmd(estDay),
          likelyDate: D.dayToYmd(estDay),
        };
      }
    }
  }

  const t = pickTable(p.phase, p.crossBorder, p.lastMileCarrier);
  if (!t) {
    return { ...base, state: "unknown", title: "Beräknas snart", subtitle: "Prognosen uppdateras automatiskt vid nästa skanning." };
  }

  const startDay = D.ymdToDay(D.ymdInSweden(p.phaseStart));
  let minDay = D.addBusinessDays(startDay, t[0]);
  let likelyDay = D.addBusinessDays(startDay, t[1]);
  let maxDay = D.addBusinessDays(startDay, t[2]);
  const firstPossible = D.addBusinessDays(today, 0); // idag om arbetsdag, annars nästa

  let state = "estimate";
  let subtitle = "Baserat på var paketet är nu och hur lång tid våra tidigare leveranser tagit.";

  if (maxDay < today) {
    // Prognosen har passerats -> visa nytt kort intervall framåt
    state = "delayed";
    minDay = firstPossible;
    likelyDay = D.addBusinessDays(today, 1);
    maxDay = D.addBusinessDays(today, 3);
    subtitle = "Paketet tar lite längre tid än vanligt, men är fortfarande på väg.";
  } else {
    if (minDay < firstPossible) minDay = firstPossible;
    if (likelyDay < minDay) likelyDay = minDay;
  }

  // Ute för leverans idag (och senaste händelsen är från idag)
  if (p.phase === "out_for_delivery" && p.lastMileCarrier !== "citymail" && daysSinceLast === 0) {
    minDay = firstPossible;
    likelyDay = firstPossible;
    maxDay = firstPossible;
  }

  const result = {
    ...base,
    state,
    title: rangeLabel(minDay, maxDay, today),
    subtitle,
    minDate: D.dayToYmd(minDay),
    maxDate: D.dayToYmd(maxDay),
    likelyDate: D.dayToYmd(likelyDay),
    likelyLabel: rangeLabel(likelyDay, likelyDay, today),
  };

  // Ingen ny skanning på länge
  if (daysSinceLast !== null && daysSinceLast >= 7) {
    result.stale = true;
    result.subtitle = `Ingen ny skanning på ${daysSinceLast} dagar. Under flyg- och tulltransport skannas paket ofta inte, så det är inte ovanligt.`;
  }
  if (daysSinceLast !== null && daysSinceLast >= 14) {
    result.state = "contact";
    result.title = "Kontakta oss";
    result.subtitle = `Spårningen har inte uppdaterats på ${daysSinceLast} dagar. Mejla oss med ditt ordernummer så kollar vi upp det direkt.`;
    result.contactUs = true;
  }

  return result;
}

module.exports = { estimate, CROSS_BORDER, DOMESTIC, fmtDay };
