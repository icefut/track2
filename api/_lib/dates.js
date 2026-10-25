// Datum-hjälpare i svensk tid + arbetsdagar (helgfria vardagar, svenska helgdagar)
"use strict";

const TZ = "Europe/Stockholm";

// "YYYY-MM-DD" för ett Date-objekt i svensk tid
function ymdInSweden(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return null;
  // sv-SE ger formatet 2026-10-25
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

// Arbetar med "dagar" som UTC-midnatt för att slippa sommartidsproblem
function ymdToDay(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function dayToYmd(day) {
  return day.toISOString().slice(0, 10);
}

function addDays(day, n) {
  const x = new Date(day.getTime());
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

// Påskdagen (Anonymous Gregorian algorithm)
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

const holidayCache = new Map();

// Dagar då paket normalt inte delas ut i Sverige
function swedishNonDeliveryDays(year) {
  if (holidayCache.has(year)) return holidayCache.get(year);
  const set = new Set();
  const add = (m, d) => set.add(dayToYmd(new Date(Date.UTC(year, m - 1, d))));

  add(1, 1); // Nyårsdagen
  add(1, 6); // Trettondedag jul
  add(5, 1); // Första maj
  add(6, 6); // Nationaldagen
  add(12, 24); // Julafton
  add(12, 25); // Juldagen
  add(12, 26); // Annandag jul
  add(12, 31); // Nyårsafton

  const easter = easterSunday(year);
  set.add(dayToYmd(addDays(easter, -2))); // Långfredagen
  set.add(dayToYmd(addDays(easter, 1))); // Annandag påsk
  set.add(dayToYmd(addDays(easter, 39))); // Kristi himmelsfärd

  // Midsommarafton = fredagen mellan 19–25 juni
  for (let d = 19; d <= 25; d++) {
    const day = new Date(Date.UTC(year, 5, d));
    if (day.getUTCDay() === 5) set.add(dayToYmd(day));
  }

  holidayCache.set(year, set);
  return set;
}

function isBusinessDay(day) {
  const wd = day.getUTCDay();
  if (wd === 0 || wd === 6) return false;
  return !swedishNonDeliveryDays(day.getUTCFullYear()).has(dayToYmd(day));
}

// Lägg till n arbetsdagar. n=0 => samma dag om arbetsdag, annars nästa arbetsdag.
function addBusinessDays(day, n) {
  let x = new Date(day.getTime());
  if (n <= 0) {
    while (!isBusinessDay(x)) x = addDays(x, 1);
    return x;
  }
  let left = n;
  while (left > 0) {
    x = addDays(x, 1);
    if (isBusinessDay(x)) left--;
  }
  return x;
}

function businessDaysBetween(fromDay, toDay) {
  let n = 0;
  let x = new Date(fromDay.getTime());
  while (x < toDay) {
    x = addDays(x, 1);
    if (isBusinessDay(x)) n++;
  }
  return n;
}

function calendarDaysBetween(fromDay, toDay) {
  return Math.round((toDay - fromDay) / 86400000);
}

module.exports = {
  TZ,
  ymdInSweden,
  ymdToDay,
  dayToYmd,
  addDays,
  addBusinessDays,
  businessDaysBetween,
  calendarDaysBetween,
  isBusinessDay,
  swedishNonDeliveryDays,
};
