# Support assignee inbox alerts

Changing a case assignment to another eligible administrator creates one `support` notification event in the same database transaction as the assignment and its audit entry. A member reply creates an event for the case's current assignee. Unassigned cases, self-assignment, staff replies, private notes and no-op assignments do not create an assignee alert. Existing public staff replies continue to notify the case owner.

The recipient must currently have the administrator role, a verified email and an enabled account. Reassignment sends later member-reply alerts to the new assignee. A disabled, unverified or role-revoked assignee is skipped. An alert records a historical change; it does not grant access to a case, and staff REST routes still require current administrator authorization.

Events contain recipient IDs, the `support` kind, case ID and an opaque event key. They contain no subject, reply, internal note, reason, attachment or contact details. Member reply alerts use the saved entry ID; assignment alerts use the saved case revision. The existing command keys, row locks, transactional outbox and unique notification keys prevent duplicate commands or worker redelivery from duplicating an inbox item.

The worker persists inbox rows and uses the existing account-scoped notification refresh signal. Clients subscribe to `notifications:changed` and reload `/api/v1/me/notifications`; missed signals recover through the same endpoint. Frontend navigation must resolve the case through its authorized API rather than treating the notification as permission. There is no email or SMS delivery in this flow.

HTTP and PostgreSQL tests exercise concurrent duplicate commands, no-op assignments, reassignment, ineligible recipients, unassigned cases, self-alert suppression, private-note isolation and duplicate outbox consumption. Client/Figma wiring and hosted queue verification remain pending.
