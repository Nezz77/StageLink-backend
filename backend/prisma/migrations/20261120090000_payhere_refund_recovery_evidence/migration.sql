-- A lost response has no provider refund number. Keep pending submissions tied to
-- that number and require matching recovery evidence for a settlement without it.
DO $$
DECLARE previous_constraint text;
BEGIN
  SELECT conname INTO STRICT previous_constraint
  FROM pg_constraint
  WHERE conrelid = 'payhere_refund_executions'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%provider_refund_id%';
  EXECUTE format('ALTER TABLE payhere_refund_executions DROP CONSTRAINT %I', previous_constraint);
END;
$$;

ALTER TABLE payhere_refund_executions
  ADD CONSTRAINT payhere_refund_pending_reference
    CHECK (status <> 'pending' OR provider_refund_id IS NOT NULL);

CREATE FUNCTION validate_payhere_refund_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE checked_execution uuid;
BEGIN
  IF TG_TABLE_NAME = 'payhere_refund_executions' THEN
    checked_execution := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    checked_execution := OLD.execution_id;
  ELSE
    IF TG_OP = 'UPDATE' AND NEW.execution_id <> OLD.execution_id THEN
      RAISE EXCEPTION 'PayHere refund recovery cannot change its execution' USING ERRCODE = '23514';
    END IF;
    checked_execution := NEW.execution_id;
  END IF;

  IF EXISTS (
    SELECT 1 FROM payhere_refund_executions e
    WHERE e.id = checked_execution AND e.status = 'succeeded' AND e.provider_refund_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM payhere_refund_recoveries r
        JOIN payhere_attempts a ON a.id = r.attempt_id AND a.order_id = e.order_id
        WHERE r.execution_id = e.id AND r.journal_id = e.settlement_id
          AND r.payment_id = e.payment_id AND r.amount_minor = e.amount_minor
      )
  ) OR EXISTS (
    SELECT 1 FROM payhere_refund_recoveries r
    JOIN payhere_refund_executions e ON e.id = r.execution_id
    WHERE r.execution_id = checked_execution AND (
      e.status <> 'succeeded' OR e.settlement_id IS DISTINCT FROM r.journal_id
      OR e.payment_id <> r.payment_id OR e.amount_minor <> r.amount_minor
      OR NOT EXISTS (SELECT 1 FROM payhere_attempts a WHERE a.id = r.attempt_id AND a.order_id = e.order_id)
    )
  ) THEN
    RAISE EXCEPTION 'PayHere refund recovery evidence must match the settled execution' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER payhere_refund_execution_recovery_evidence
  AFTER INSERT OR UPDATE ON payhere_refund_executions DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_payhere_refund_recovery();

CREATE CONSTRAINT TRIGGER payhere_refund_recovery_evidence
  AFTER INSERT OR UPDATE OR DELETE ON payhere_refund_recoveries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_payhere_refund_recovery();
