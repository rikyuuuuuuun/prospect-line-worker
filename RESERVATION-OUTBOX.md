# Durable reservation acceptance

The reservation outbox stores each authenticated reservation and its retry alarm
in one SQLite Durable Object transaction. It acknowledges only after commit.
Every GAS attempt carries the original `reservation_form` payload and request ID;
the GAS receiver's existing request-ID deduplication handles a lost response.
Only explicit `{ok:true}` removes the temporary personal-data copy. A receipt/hash
tombstone remains so a retry cannot create another reservation.

The next alarm is committed before calling GAS. Failed attempts back off from
30 seconds to one hour, without discarding an accepted reservation. The Worker
logs `reservation_sync_retry` and `reservation_synced` with only receipt ID,
route and attempt count. Investigate repeated failures in Workers Logs; retain
the Durable Object export and alarm handler in every deployment until pending
reservations are synced. Do not delete the namespace or roll back to a version
which lacks this class. Fixing the forwarding configuration/backend allows the
persisted alarm to recover without the reservation holder repeating the form.

The foundation release was deployed before switching the reservation handler.
To check the infrastructure, POST `/health/reservation-storage`, then GET it after the
alarm runs. This uses one fixed synthetic marker, never GAS or LINE. A `synced`
marker proves durable storage and scheduled execution in production, without
creating a real reservation. This endpoint exposes no booking data.

The active reservation handler verifies a route-bound signed LINE session and
the signed daily availability policy, then commits to the outbox. The browser
prepares the LINE session while the person types. The session expires within
15 minutes and never later than the verified LINE ID token; it stays in memory
only. The reservation POST persists neither tokens nor session/policy proofs.
Legacy HTML still verifies LINE directly, with a six-second bounded request.

Successful acceptance immediately shows the receipt and an enabled close button.
The LINE chat copy is independent. Its receipt number allows the signed LINE
webhook handler to recognize a copy of an already accepted reservation, avoiding
an intake race while GAS is still syncing. Only known receipts from the matching
LINE user and venue are filtered; normal chat and older messages are forwarded.

Recovery: `reservation_sync_retry` includes the Durable Object ID for locating
its storage in Cloudflare's object inspector. Restore the GAS connection/backend
first, then allow its retained alarm to retry. Do not manually insert an extra
booking with a new ID. The pre-activation foundation commit is
`3ee369aaa9e1f1864ea5c693953d393f7152d821`; it preserves the class and retry handler
if the HTTP/UI changes need to be reverted. Do not roll back before that release.

Validation: `npm test` runs browser/policy regression tests and actual workerd
SQLite Durable Object tests, with all outbound requests mocked. `npm run check`
checks production bundling. Real LINE device latency is a separate measurement.
