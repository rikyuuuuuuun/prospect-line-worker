# Reservation submission redesign — 2026-09-13

The owner accepts up to one day of delay in public class reception state, waitlist state and available dates. This supersedes the live-policy reread requirement in REPAIR-P06.md and the startup redesign document. Production rollout of this reservation flow is authorized.

## Critical path

Previously: receipt permission → LINE identity verification → forced GAS class/date refresh → GAS durable reservation write → receipt permission again → LINE receipt → accepted screen.

Now: LINE identity verification → local signed-policy validation → GAS durable reservation write → accepted screen. The LINE receipt then sends independently in the browser. A stalled or rejected receipt cannot make a saved reservation appear unsaved. Closing the form before receipt completion may prevent the receipt, but the reservation remains saved.

## Public policy

- Dates and class state may be reused for less than 24 hours from the original GAS `generatedAt`. Cache insertion, fallback delivery and proof signing never renew that timestamp.
- Cache hits require no upstream read. Cache misses/expiry use the existing 8-second total read budget. Invalid/unknown/future timestamps still fail closed if a bounded refresh fails. Verified fallback may populate the cache only for the remaining part of its original 24-hour lifetime; neither its timestamp nor expiry is renewed. This avoids repeated GAS reads when GAS serves a verified snapshot.
- This is expiry-based refresh on demand, not a newly installed midnight cron job. Different edge locations may refresh at different times; policy age cannot exceed 24 hours. Administrative closures/waitlist changes may take up to 24 hours to affect an already displayed form.
- The API signs only public route, original generation time, dates, class state and fixed class. HMAC-SHA-256 uses the existing server-only GAS_FORWARD_KEY with a dedicated domain prefix. No new secret/binding or personal data store is needed.
- The form returns this proof on submit. The Worker verifies signature, route, age, class, reception type and date without contacting GAS for policy. LINE identity verification and input validation remain mandatory. Past dates are removed when delivering cached data and rejected at submission.
- Expired/invalid policy refreshes the form in place and requires the user to review and submit again. Children and other input stay on screen. Old HTML without a proof uses the bounded public cache path for rollout compatibility.

## Storage and recovery

- A successful response still requires GAS to return explicit `ok: true`. Empty or ambiguous storage responses cannot display acceptance. Reservation response-body reading stays within its existing per-attempt timeout.
- Existing request IDs and the GAS duplicate contract are preserved. There is one browser save request per click, an in-flight guard, and the same request ID on unchanged-content retries. This is not a new transactional guarantee in GAS.
- Receipt permission is checked once per receipt attempt after saving. A single pending LIFF operation survives the UI slow indicator; no duplicate send is started merely because a timer fires. Actual rejection permits a receipt-only retry.
- `/api/reservations` exposes `Server-Timing` for identity, policy, storage and total submit time; browser performance marks cover submit, saved, acceptance visible and receipt sent. No token, child information or receipt body is added to telemetry.
- Event application and webhook business behavior, Worker bindings and triggers remain unchanged.

## Validation and deployment

Run `node --check src/index.js`, `npm test`, and the existing CI Wrangler dry run. Tests cover policy expiry/tampering/route isolation, closed and waitlist states, cache loss, missing acknowledgement, slow receipt and retry behavior, and existing startup regressions. Use read-only production probes for all 30 venues after deploy; do not create real reservations or send real LINE test messages.

Rollback version before this change: `3f8b5879-24ce-4330-8cfe-0b5898b78d3a`, main commit `8a4f4cdbe925c496cfe67b65a0d91fffe241f333`.

Offline/CI results establish code behavior under fixtures. Actual mobile LINE submission latency and durable production booking success require an authenticated real booking and are not inferred from availability probes.

References: [Cloudflare Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/), [LINE LIFF sendMessages](https://developers.line.biz/en/reference/liff/#send-messages).
