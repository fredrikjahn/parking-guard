# parking-guard

Provider-baserad Next.js/TypeScript backend-engine för parkeringsdetektion, regelutvärdering och notifieringar.

## Stack

- Next.js (App Router) + TypeScript
- Supabase Postgres via `@supabase/supabase-js` (service role för server jobs)
- Zod för validering

## Snabbstart

1. Installera beroenden:

```bash
npm install
```

2. Kopiera env:

```bash
cp .env.example .env.local
```

3. Generera krypteringsnyckel för `TOKEN_ENCRYPTION_KEY_B64` (32 bytes):

```bash
openssl rand -base64 32
```

4. Kör migrations i Supabase SQL editor i ordning:
- `supabase/migrations/001_init.sql`
- `supabase/migrations/002_rls.sql`
- `supabase/migrations/003_seed.sql`

5. Starta appen:

```bash
npm run dev
```

## Endpoints

- `GET /api/health`
- `GET /api/vehicle/oauth/start?provider=tesla_fleet`
- `GET /api/vehicle/oauth/callback?provider=tesla_fleet&code=...&state=...`
- `GET /api/vehicle/vehicles`
- `POST /api/vehicle/register`
- `GET /api/rules/within?lat=59.3293&lng=18.0686&radius=50`
- `POST /api/jobs/tick` med header `x-cron-secret: <CRON_SECRET>`

## Tesla Fleet region and registration

- `TESLA_API_BASE` styr vilken Fleet API-region som används (NA/EU).
- Tesla partner registration kräver publik nyckelfil på:
  - `/.well-known/appspecific/com.tesla.3p.public-key.pem`
- Om `GET /api/vehicle/vehicles` returnerar `412` med `must be registered`, kör:

```bash
curl -X POST http://localhost:3000/api/vehicle/register
```

- Försök sedan igen:

```bash
curl http://localhost:3000/api/vehicle/vehicles
```

- Om `POST /api/vehicle/register` returnerar `401` med text om partner token behöver du konfigurera Tesla partner authentication enligt deras docs.

## Tesla key setup

1. Generera RSA-nycklar (2048-bit):

```bash
./scripts/gen-tesla-keys.sh
```

2. Public key skrivs till:
   - `public/.well-known/appspecific/com.tesla.3p.public-key.pem`

3. Private key skrivs lokalt till:
   - `tesla-private-key.pem` (är git-ignorerad)

4. Lägg private key i Vercel env senare som:
   - `TESLA_PARTNER_PRIVATE_KEY_PEM`

5. Efter att public key uppdaterats i `public/` måste appen redeployas.

6. Debug-check:
   - `GET /api/tesla/public-key`

## Hur engine tick fungerar

- Läser aktiv vehicle-connection och första fordonet för dev-user.
- Hämtar telemetri från vehicle provider.
- Uppdaterar/skapar `parking_events` och detekterar PARKED baserat på stillestånd + drift.
- Resolverar jurisdiktion + aktiva rules sources för positionen.
- Kör rules provider och sparar `rule_hits`.
- Trigger notifiering via notifier (MVP: log + email-stub).
- Idempotens: skickar inte om samma SOFT/HARD-notis för samma event.
- TTL-cache för rules-check per event för att minska spam.

## RLS

RLS är aktiverat på tabeller med användardata. Policies begränsar användare till egna rader via `auth.uid()`.

Notera: Supabase service role bypassar RLS. Serverjobs i denna app använder service role och måste därför hanteras säkert.

## TODO för production

- Multi-user auth och korrekt koppling mellan session/user/provider.
- Full Tesla Fleet implementation (korrekta endpoints, fordon, telemetri, retries, rate limits).
- Djupare parsing av Stockholm LTF payload (servicedagar inom 12h m.m.).
- Push-notiser (APNS/FCM) istället för placeholder.
- Robust schemaläggning/queue (istället för enkel cron endpoint).
- Observability (metrics/tracing) och dead-letter/alerting.
