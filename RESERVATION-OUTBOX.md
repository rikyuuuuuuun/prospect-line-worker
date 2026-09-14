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

Foundation release keeps the existing reservation handler active. After this
release is deployed, POST `/health/reservation-storage`, then GET it after the
alarm runs. This uses one fixed synthetic marker, never GAS or LINE. A `synced`
marker proves durable storage and scheduled execution in production, without
creating a real reservation. This endpoint exposes no booking data.

Validation: `npm test` runs browser/policy regression tests and actual workerd
SQLite Durable Object tests, with all outbound requests mocked. `npm run check`
checks production bundling. Real LINE device latency is a separate measurement.
