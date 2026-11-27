BEGIN;

CREATE FUNCTION record_sandbox_refund_receipt(
  p_execution uuid, p_order uuid, p_journal uuid, p_amount integer, p_gateway text,
  p_claim uuid, p_arbitration uuid, p_reference text
)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO booking_documents (id, booking_id, kind, source_id, snapshot)
  SELECT gen_random_uuid(), o.booking_id, 'receipt', j.id, jsonb_build_object(
    'version', 2,
    'kind', 'receipt',
    'issuedAt', to_char(j.posted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'purpose', o.purpose,
    'amountMinor', p_amount,
    'gateway', gateway.label,
    'orderId', o.id,
    'disposition', 'refunded',
    'refundExecutionId', p_execution,
    'journalId', j.id,
    'refundContext', CASE WHEN p_arbitration IS NOT NULL THEN 'arbitration'
      WHEN p_claim IS NOT NULL THEN 'deposit_claim' ELSE 'cancellation' END
  )
  FROM payment_orders o
  JOIN journal_transactions j ON j.id = p_journal
  CROSS JOIN (VALUES ('stripe', 'test', 'Stripe'), ('payhere', 'sandbox', 'PayHere'))
    AS gateway(rail, environment, label)
  WHERE o.id = p_order AND gateway.rail = p_gateway AND j.posted_at IS NOT NULL AND j.currency = 'LKR'
    AND j.source = gateway.rail || '.' || gateway.environment || '.refund.settle' AND j.reference = p_reference
    AND EXISTS (
      SELECT 1 FROM journal_entries e
      JOIN financial_accounts a ON a.id = e.account_id
      WHERE e.transaction_id = j.id AND e.amount_minor = p_amount AND a.kind = 'clearing'
        AND a.scope = 'gateway:' || gateway.rail || ':' || gateway.environment
    )
  ON CONFLICT (booking_id, kind, source_id) DO NOTHING;
$$;

CREATE FUNCTION issue_sandbox_refund_receipt()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'succeeded' AND NEW.settlement_id IS NOT NULL THEN
    PERFORM record_sandbox_refund_receipt(
      NEW.id, NEW.order_id, NEW.settlement_id, NEW.amount_minor,
      CASE WHEN TG_TABLE_NAME = 'stripe_refund_executions' THEN 'stripe' ELSE 'payhere' END,
      NEW.damage_claim_id, NEW.arbitration_id, COALESCE(NEW.provider_refund_id, 'recovery:' || NEW.id::text)
    );
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER stripe_refund_receipts
AFTER INSERT OR UPDATE OF settlement_id ON stripe_refund_executions
FOR EACH ROW EXECUTE FUNCTION issue_sandbox_refund_receipt();

CREATE TRIGGER payhere_refund_receipts
AFTER INSERT OR UPDATE OF settlement_id ON payhere_refund_executions
FOR EACH ROW EXECUTE FUNCTION issue_sandbox_refund_receipt();

-- Install both triggers before backfilling so concurrent writers cannot miss the cutover.
DO $$
BEGIN
  PERFORM record_sandbox_refund_receipt(
    r.id, r.order_id, r.settlement_id, r.amount_minor, r.gateway, r.damage_claim_id, r.arbitration_id, r.reference
  )
  FROM (
    SELECT id, order_id, settlement_id, amount_minor, damage_claim_id, arbitration_id,
      'stripe' AS gateway, provider_refund_id::text AS reference
    FROM stripe_refund_executions WHERE status = 'succeeded'
    UNION ALL
    SELECT id, order_id, settlement_id, amount_minor, damage_claim_id, arbitration_id,
      'payhere', COALESCE(provider_refund_id, 'recovery:' || id::text)
    FROM payhere_refund_executions WHERE status = 'succeeded'
  ) r;
END;
$$;

COMMIT;
