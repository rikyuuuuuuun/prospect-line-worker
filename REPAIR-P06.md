# P-06 availability repair candidate

Do not deploy until the final owner go-sign. This change rejects absent, empty, invalid or duplicate upstream class settings, and a missing fixed class. The frontend no longer fabricates open classes. Closed and waitlist settings are preserved.

An upstream fallback without verifiable original age is rejected; only this edge's bounded last-good copy may rescue it. An upstream fallback cannot refresh the edge cache timestamp. Ordinary stale responses are explicitly marked as fallback; expired and future-dated cache entries cannot rescue a failed upstream. Existing fresh, stale and emergency age limits remain in force. Reservation identity verification and backend submission validation remain the final authority.

Before deployment: run `npm test` and `node --check src/index.js`; capture the currently deployed Worker version and binding names (never secret values); verify the actual GAS availability response includes classes for every enabled route and that submission rechecks class state. Deploy only after go-sign, then read-only probe open/waitlist/closed fixture routes without sending real reservations. Restore the captured Worker version if availability fails.

The local VM tests prove the Worker paths under simulated cache and upstream failures. They do not establish which GAS revision is currently deployed.

## GAS v38 compatibility follow-up (2026-09-05)

Production GAS v38 reports build `2026-08-13-single-slot-auto1` and includes the original `generatedAt` on snapshots. The earlier blanket rejection of all fallback responses caused availability HTTP 502. A snapshot now requires a finite numeric original timestamp no more than 15 minutes old. Missing, future, invalid or expired timestamps require one bounded live refresh; an unverified result or fallback after that refresh fails closed. Snapshot fallback never renews edge cache age. Fresh edge entries keep the upstream generation time.

The current GAS supports the numbered classes at Muneoka Daini but does not re-read class/date policy during reservation storage. The Worker therefore supports those class names and explicitly refreshes and verifies class, reception type and selected date before forwarding a reservation. Failed verification does not call the reservation-storage path. Identity verification remains first. Availability reads and reservation writes are separate calls, so this does not provide transactional exclusion against an administrator edit between them.

Validation: 15 offline tests, including missing/duplicate classes, timestamp faults, no fallback-age renewal, build mismatch, numbered classes, and no reservation forwarding after failed verification. No real LINE message or reservation is used for verification. Keep the pre-release version as the rollback target and verify deployed code, bindings, health and all 30 public routes after rollout.
