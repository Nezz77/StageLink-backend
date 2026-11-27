BEGIN;

CREATE FUNCTION record_manual_sandbox_payout_documents(p_settlement_id uuid)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO booking_documents (id, booking_id, kind, source_id, snapshot)
  SELECT gen_random_uuid(), p.booking_id, 'settlement', j.id, jsonb_build_object(
    'version', 3,
    'kind', 'settlement',
    'issuedAt', to_char(j.posted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'grossMinor', p.gross_minor,
    'platformFeeMinor', p.platform_fee_minor,
    'netMinor', p.net_minor,
    'destinationRevision', s.destination_revision,
    'manualSettlement', jsonb_strip_nulls(jsonb_build_object(
      'state', movement.state, 'settlementId', s.id, 'revision', s.revision, 'journalId', j.id,
      'originalJournalId', movement.original_journal_id
    ))
  )
  FROM manual_sandbox_payouts s
  JOIN payout_orders p ON p.id = s.payout_id
  LEFT JOIN manual_sandbox_payout_reversals r ON r.settlement_id = s.id
  CROSS JOIN LATERAL (VALUES
    (s.journal_id, 'settled', NULL::uuid, 'payout.sandbox.manual.settle', s.id::text),
    (r.journal_id, 'reversed', s.journal_id, 'payout.sandbox.manual.reversal', r.id::text)
  ) AS movement(journal_id, state, original_journal_id, source, reference)
  JOIN journal_transactions j ON j.id = movement.journal_id AND j.source = movement.source
    AND j.reference = movement.reference
  WHERE s.id = p_settlement_id AND s.journal_id IS NOT NULL
    AND p.damage_claim_id IS NULL AND p.arbitration_id IS NULL AND s.amount_minor = p.net_minor
    AND j.posted_at IS NOT NULL AND j.currency = 'LKR' AND j.purpose = 'service'
  ON CONFLICT (booking_id, kind, source_id) DO NOTHING;
$$;

CREATE FUNCTION issue_manual_sandbox_payout_statement()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM record_manual_sandbox_payout_documents(NEW.id);
  RETURN NULL;
END;
$$;

CREATE FUNCTION issue_manual_sandbox_payout_reversal_statement()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM record_manual_sandbox_payout_documents(NEW.settlement_id);
  RETURN NULL;
END;
$$;

CREATE TRIGGER manual_sandbox_payout_statements
AFTER INSERT OR UPDATE OF journal_id ON manual_sandbox_payouts
FOR EACH ROW WHEN (NEW.journal_id IS NOT NULL) EXECUTE FUNCTION issue_manual_sandbox_payout_statement();

CREATE TRIGGER manual_sandbox_payout_reversal_statements
AFTER INSERT ON manual_sandbox_payout_reversals
FOR EACH ROW EXECUTE FUNCTION issue_manual_sandbox_payout_reversal_statement();

DO $$
BEGIN
  PERFORM record_manual_sandbox_payout_documents(s.id)
  FROM manual_sandbox_payouts s WHERE s.journal_id IS NOT NULL;
END;
$$;

COMMIT;
