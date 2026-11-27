# Payment configuration capabilities

Authenticated clients can read `GET /api/v1/payments/capabilities` before presenting payment choices. The response uses `Cache-Control: no-store` and a PostgreSQL `checkedAt` timestamp. It contains no credentials, merchant identifiers, callback URLs or payment records. It makes no gateway requests.

Each checkout gateway reports its configuration and whether this account meets the email verification and customer membership requirements. `unavailableReasons` distinguishes `GATEWAY_NOT_CONFIGURED`, `EMAIL_VERIFICATION_REQUIRED` and `CUSTOMER_MEMBERSHIP_REQUIRED`. Membership follows the existing payment-order rule: a customer role can coexist with another active role.

Stripe configuration requires the test secret key and webhook secret. PayHere configuration requires the sandbox merchant ID, secret and notification URL. These flags describe the server configuration. They do not establish merchant eligibility, LKR acceptance, account capabilities, booking ownership, an accepted quotation or a valid unpaid order. The checkout endpoints still enforce those requirements. Both `merchantEligibilityChecked` and `bookingEligibilityChecked` remain false.

Only an email-verified session currently acting as administrator receives `adminExecution`; other accounts receive null. It reports configured Stripe test refund and transfer execution, full PayHere sandbox refund execution, and manual sandbox payout reconciliation. Existing captures can be refunded with configured PayHere retrieval credentials even if checkout credentials have been removed. The execution routes enforce authorization for each refund and payout.

Partial PayHere refunds, PayHere provider payouts, manual bank payouts, production documents and live financial totals remain explicitly disabled. All advertised routes use test/sandbox money. `liveMoneyMovementEnabled` remains false. An internal reservation is not proof of a bank payout.

For hosted merchant evidence, use the existing verified-administrator Stripe capability check and staging payment smoke workflow. Consult [Stripe key modes](https://docs.stripe.com/keys) and [PayHere sandbox testing](https://support.payhere.lk/sandbox-and-testing) when configuring test accounts. Frontend payment-option wiring and corresponding Figma flows remain pending.

Validation covers default configuration, independent account requirements, administrator visibility, disabled and revoked sessions, credential omission and historical full PayHere refund configuration. The HTTP test rejects external network requests and verifies that the payment order count does not change.
