# Danab Project Documentation

## 1) What We Are Building

Danab is a web platform for renting portable power banks at physical stations.

Customer flow:
1. User scans a station QR code (for example `station58.danab.site`).
2. User enters phone + confirms payment.
3. System places a payment hold.
4. System unlocks a battery slot and verifies physical ejection.
5. Only after verified ejection, system captures payment and creates rental record.

Business goal:
- Fast, reliable rentals.
- Strong trust: users must never be charged without delivery.

---

## 2) High-Level Architecture

### Frontend
- Framework: Next.js App Router + React + TypeScript + Tailwind.
- Landing/marketing pages: `app/page.tsx`, `components/landing/*`
- Rental UI: `app/station/page.tsx`, `components/payment/*`
- Payment processing screen: `app/payment/page.tsx`, `components/payment/PaymentProcessingPage.tsx`

### Backend
- Implemented inside Next.js route handlers:
  - `app/api/pay/route.ts`
  - `app/api/mobile/stations/route.ts`
  - `app/api/blacklist/check/[phoneNumber]/route.ts`
  - `app/api/timezone/route.ts`
- Core business logic: `lib/server/payment/*`

### Integrations
- Payment provider: Waafi (preauthorize/commit/cancel).
- Station hardware API: HeyCharge.
- Database: Firestore (via Firebase Admin).
- Alerts: Telegram bot (optional).

---

## 3) Critical Trust Rule

Non-negotiable rule:
- Payment capture happens only after battery ejection is verified.

Current implementation enforces:
1. Preauthorize payment hold.
2. Send unlock command.
3. Verify battery is no longer present in slot.
4. Retry unlock if not confirmed.
5. If still not ejected: cancel hold, mark slot problem, alert ops.
6. Capture payment only on confirmed success.

Primary implementation file:
- `lib/server/payment/process-payment.ts`

---

## 4) Domain and Station Routing

### Production pattern
- Each station uses a subdomain: `stationXX.danab.site`
- Middleware rewrites station subdomain traffic to `/station`.

Key files:
- `middleware.ts`
- `lib/server/station-config.ts`

### Preview/testing behavior
- On localhost or Vercel preview, station cards route to:
  - `/station?stationCode=XX`
- This allows station testing without real subdomains.

Key files:
- `components/landing/Stations.tsx`
- `lib/client/station.ts`

---

## 5) Data Model (Operational)

Firestore collections used by this app include:
- `rentalsTrans` (rental transactions)
- `blacklist`
- `battery_reservations`
- `battery_state`
- `phone_payment_locks`
- `problem_slots`

Main logic files:
- `lib/server/payment/rentals.ts`
- `lib/server/payment/battery-lock.ts`
- `lib/server/payment/battery-state.ts`
- `lib/server/payment/blacklist.ts`
- `lib/server/payment/heycharge.ts`

---

## 6) Environment Variables

Core required variables:
- `FIREBASE_CREDENTIALS_B64`
- `WAAFI_API_KEY`
- `WAAFI_API_USER_ID`
- `WAAFI_MERCHANT_UID`
- `WAAFI_URL`
- `HEYCHARGE_API_KEY`
- `HEYCHARGE_DOMAIN`
- `STATION_58_IMEI` ... `STATION_62_IMEI` (and more as needed)

Optional:
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

Important:
- Never commit real secrets to Git.
- Rotate keys immediately if exposed.

---

## 7) Local Development

Install and run:
```bash
npm install
npm run dev
```

Build check:
```bash
npm run build
```

Main local URLs:
- Home: `http://localhost:3000`
- Station test: `http://localhost:3000/station?stationCode=58`

---

## 8) Deployment Model

Recommended:
- Domain + DNS: Cloudflare
- Hosting: Vercel project under company account

Safe migration approach:
1. Keep DNS records identical during nameserver cutover.
2. Verify Cloudflare active.
3. Move station subdomains one by one to new Vercel targets.
4. Verify each station is valid in Vercel before moving next.

Deployment references:
- `DEPLOYMENT.md`
- `STATION_URLS.md`

---

## 9) Operational Runbook (Paid But No Ejection)

If user reports payment but no battery:
1. Check logs for transaction and station.
2. Confirm whether ejection was verified.
3. Confirm hold was cancelled if ejection failed.
4. Check `problem_slots` for affected slot.
5. Validate station hardware health.
6. Use Telegram alerts for incident trace if enabled.

---

## 10) Known Product Notes

- UI currently shows multiple payment method labels, but backend flow is Waafi-centric.
- Middleware file name warning exists in newer Next.js (`middleware` moving toward `proxy` naming).
- Current rate-limiting is in-memory; distributed enforcement may be needed later.

---

## 11) AI Quick Context

Use this summary for AI assistants:

```yaml
project: Danab Power Bank Rental
stack:
  frontend: Next.js + React + TypeScript + Tailwind
  backend: Next.js route handlers
  database: Firebase Firestore
  integrations: [Waafi, HeyCharge, Telegram]
critical_rule: "Never capture payment unless physical ejection is verified"
core_payment_file: lib/server/payment/process-payment.ts
station_routing:
  production: stationXX.danab.site -> /station
  preview: /station?stationCode=XX
```

