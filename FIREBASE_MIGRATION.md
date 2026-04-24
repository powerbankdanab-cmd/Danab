# Firebase Fresh Setup (No Data Migration)

We are **not** copying old Firebase data.
This project will run on a **new, clean Firestore**.

## Goal

- Keep payment safety strict:
  - `hold -> unlock -> verify -> capture`
  - Never capture without verified battery ejection
- Keep observability strong:
  - Every failure is logged
  - Critical failures alert support
- Keep reconciliation enabled:
  - Repair incomplete states (`captured` without rental, `capture_unknown`)

## 1) Configure New Firebase Project

1. Create new Firebase project (company-owned).
2. Create a service account with Firestore access.
3. Base64 encode the service account JSON.
4. Set runtime env:
   - `FIREBASE_CREDENTIALS_B64=<new_project_service_account_b64>`

This is enough because the backend reads Firestore through:
- [firebase-admin.ts](/C:/Users/cshii/OneDrive/Desktop/DANAB/lib/server/firebase-admin.ts)

## 2) Clean Firestore Schema (Collections)

Collections created by the app at runtime:

- `transactions`
  - durable payment state machine
  - statuses used in flow: `initiated`, `pending_payment`, `held`, `confirm_required`, `resolving`, `verified`, `captured`, `failed`, `capture_unknown`
- `rentalsTrans`
  - rental records after successful capture
- `errors`
  - structured reliability logging
- `battery_state`
  - battery claim/rental state consistency
- `battery_reservations`
  - short-lived reservation lock per battery
- `phone_payment_locks`
  - short-lived lock per phone to stop duplicate active payment flows
- `problem_slots`
  - bad station slots excluded from future rentals
- `alerts_queue`
  - durable retries for failed/rate-limited alerts
- `station_failures`
  - persistent station-level failure windowing

No seed data is required.

## 3) Payment Safety Flow (Must Stay)

1. Preauthorize Waafi hold
2. Unlock battery slot
3. Verify physical ejection with confidence checks
4. Only then capture Waafi
5. Create rental + finalize transaction

If verification fails:
- cancel hold
- mark failed
- log critical event
- alert support

## 4) Observability Requirements

For every real failure path:

1. `logError(...)` must run
2. error should persist in `errors` (or explicit critical console fallback if Firestore unavailable)
3. alert should send immediately or be queued in `alerts_queue` for retry

## 5) Reconciliation Safety

Keep internal reconciliation routes/workers enabled:

- repair `captured && rentalCreated=false`
- resolve `capture_unknown` via provider status checks
- keep idempotent writes and guarded state transitions

## 6) Fresh Environment Checklist

Required env vars:

- `FIREBASE_CREDENTIALS_B64`
- `WAAFI_API_KEY`
- `WAAFI_API_USER_ID`
- `WAAFI_MERCHANT_UID`
- `WAAFI_URL`
- `HEYCHARGE_API_KEY`
- `HEYCHARGE_DOMAIN`
- station IMEIs (`STATION_58_IMEI`, ...)
- alerting (`TWILIO_*`, optional Telegram if enabled)

## 7) Go-Live Smoke Test (Clean DB)

1. Deploy with new Firebase credentials.
2. Hit internal health endpoint(s) and alert test endpoint.
3. Run one low-value real payment:
   - confirm `transactions` doc created
   - confirm unlock + verification path
   - confirm capture only after verification
   - confirm `rentalsTrans` created
4. Simulate one failure:
   - ensure `errors` log written
   - ensure alert sent (or queued)

If all pass, proceed to production rollout.

