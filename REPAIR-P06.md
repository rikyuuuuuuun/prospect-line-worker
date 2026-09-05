# P-06 availability repair candidate

Do not deploy until the final owner go-sign. This change rejects absent, empty, invalid or duplicate upstream class settings, and a missing fixed class. The frontend no longer fabricates open classes. Closed and waitlist settings are preserved.

An upstream fallback without verifiable original age is rejected; only this edge's bounded last-good copy may rescue it. An upstream fallback cannot refresh the edge cache timestamp. Ordinary stale responses are explicitly marked as fallback; expired and future-dated cache entries cannot rescue a failed upstream. Existing fresh, stale and emergency age limits remain in force. Reservation identity verification and backend submission validation remain the final authority.

Before deployment: run `npm test` and `node --check src/index.js`; capture the currently deployed Worker version and binding names (never secret values); verify the actual GAS availability response includes classes for every enabled route and that submission rechecks class state. Deploy only after go-sign, then read-only probe open/waitlist/closed fixture routes without sending real reservations. Restore the captured Worker version if availability fails.

The local VM tests prove the Worker paths under simulated cache and upstream failures. They do not establish which GAS revision is currently deployed.
