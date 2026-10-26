# trackicefot.se – spårningssida för ICEFOT

Spårar **alla** transportörer som Ship24 stödjer (4PX, PostNord, CityMail, DHL, Budbee, Instabox, Bring, UPS m.fl.)
och visar en leveransprognos med riktiga datum.

## Vad som är nytt (v2)

- **Alla spårningsnummer** – carrier-oberoende logik baserad på Ship24:s standardiserade statusar + textregler.
  Rätt länk och nummer för PostNord/CityMail/DHL/Budbee osv. visas automatiskt.
- **Exakt prognos med datum** ("Tor 29 okt – ons 4 nov, troligast mån 2 nov") räknad från *när* paketet nådde
  nuvarande steg, i svenska arbetsdagar (helger + röda dagar borträknade). Kalibrerad mot riktiga ICEFOT-leveranser:
  backtest på 149 kontrollpunkter gav **90 % träff** i intervallet (gamla logiken: 30 %), snittfel 1,1 arbetsdag.
- **Försenat / ingen uppdatering** – passerad prognos ger nytt intervall. 7+ dagar utan skanning ger förklaring,
  14+ dagar ger "Kontakta oss" (samma regel som för förlorade paket).
- **Omskick** – en order med flera spårningsnummer visar det *senaste* paketet (förut visades det första = det förlorade).
- **4PX döljs** för kunden (bara svensk transportör visas). Sätt `SHOW_ORIGIN_CARRIER=true` om du vill visa den.
- **Snabbare och billigare** – svaren cachas på Vercels CDN (15 min, levererade 6 h) → färre Ship24-anrop.
- **Säkrare** – ingen XSS via händelsetexter, inga råa Ship24-svar eller kundmejl i loggar.
- Ny design i butikens stil, mobilanpassad, mörkt läge, FAQ, kopiera/dela, "senast spårade".

## ⚠️ Viktigt: kunddata

`api/orders-data.js` innehåller ~6 600 kunders e-post + ordernummer och repot är **publikt**.
1. Gör repot privat: GitHub → Settings → General → Danger Zone → *Change visibility* → Private
   (Vercel fortsätter deploya som vanligt).
2. Flytta ordrarna till Supabase (nedan) och ta sedan bort `api/orders-data.js`.

## Miljövariabler (Vercel → Settings → Environment Variables)

| Namn | Krävs | Beskrivning |
|---|---|---|
| `SHIP24_API_KEY` | ja | finns redan |
| `SUPABASE_URL` | för order-uppslag | Supabase → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | för order-uppslag | samma sida, *service_role* (hemlig – bara i Vercel) |
| `ADMIN_TOKEN` | för /admin.html | valfritt långt lösenord (minst 12 tecken) |
| `SHOW_ORIGIN_CARRIER` | nej | `true` = visa 4PX för kunden |
| `STATUS_EMAILS_ENABLED` | nej | `true` = automatiska statusmejl (kräver `RESEND_API_KEY` + `CRON_SECRET`) |

Utan Supabase används `api/orders-data.js` som tidigare, så inget går sönder under flytten.

## Flytta ordrarna till Supabase (en gång)

1. Supabase → SQL Editor → kör `supabase/schema.sql`.
2. Lokalt: `node scripts/orders-to-csv.js` → skapar `orders.csv` (laddas inte upp till GitHub).
3. Supabase → Table Editor → `orders` → Insert → *Import data from CSV* → välj `orders.csv`.
4. Lägg in `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` i Vercel och redeploya.
5. Testa en order på sidan → ta bort `api/orders-data.js` från repot.

## Lägga till nya ordrar

Gå till `trackicefot.se/admin.html`, skriv ditt `ADMIN_TOKEN` och klistra in ordrar – antingen i samma format som
gamla `orders-data.js` eller en rad per order (`37157, kund@mail.se, 4PX3003133621569CN`). Inget mer GitHub-pill.

## Test

```
node tests/run.js
```
