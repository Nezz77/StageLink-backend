# Live support conversation refresh

Support uses the existing authenticated Socket.IO WebSocket at `/api/v1/chat/socket.io`. Use the configured web origin and provide the access token in handshake `auth.accessToken`. Tokens do not go in URLs. Existing session checks, event limits and the shared limit of sixteen booking/support subscriptions apply.

Send `support:join` with `{ "caseId": "<uuid>" }` and an acknowledgement callback. The case owner or a verified active administrator can join an existing case; another member receives the same unavailable-case response as for a missing case. `support:leave` accepts the same body. These events read subscription state and can run during maintenance. Mutations continue through the existing REST endpoints with origin and CSRF protection.

Successful reply and status commands trigger `support:changed` with only `{ "caseId": "<uuid>" }`. Staff notes and assignment changes trigger the signal only for verified active administrators. Signals contain no reply body, private note, reason, assignee, author or attachment details. Every delivery authenticates the current session and rechecks case access; an invalidated staff session cannot keep receiving updates from a previously joined room.

After an acknowledgement, load the current case and conversation through REST. Reload after each signal. Members use `/cases/:id` and `/cases/:id/replies`; staff use `/admin/cases` and `/admin/cases/:id/entries`. Always rejoin and reload after reconnecting. REST history is authoritative and paginated; the signal is a best-effort refresh hint, with no promise of durable socket delivery. Idempotent retries can repeat a hint.

Updates publish after the database transaction commits. A Redis publish failure cannot roll back the saved reply. Redis distributes hints to API replicas using a shared `AUTH_RATE_PREFIX` and Redis database; the publishing API delivers locally and ignores its own Redis envelope. Instances must share that namespace for cross-replica delivery. No support write command is exposed on the socket.

Two-server integration coverage exercises replies, resolution/reopening, private note/assignment isolation, outsider and unverified administrator denial, session revocation, maintenance, subscription limits and REST catch-up after leaving a room. Frontend support controls, hosted proxy verification and Figma flows remain pending.
