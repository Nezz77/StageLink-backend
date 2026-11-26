BEGIN;

-- Generate records from posted journals so API retries and older writers share the same source.
CREATE FUNCTION record_stripe_bank_payout_documents(settlement stripe_bank_payout_settlements)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO booking_documents (id, booking_id, kind, source_id, snapshot)
  SELECT gen_random_uuid(), p.booking_id, 'settlement', j.id, jsonb_strip_nulls(jsonb_build_object(
    'version', 2,
    'kind', 'settlement',
    'issuedAt', to_char(j.posted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'grossMinor', p.gross_minor,
    'platformFeeMinor', p.platform_fee_minor,
    'netMinor', p.net_minor,
    'destinationRevision', d.destination_revision,
    'damageClaimId', p.damage_claim_id,
    'arbitrationId', p.arbitration_id,
    'bankSettlement', jsonb_build_object(
      'state', movement.state, 'settlementId', (settlement).id, 'journalId', j.id,
      'originalJournalId', movement.original_journal_id, 'reason', movement.reason
    )
  ))
  FROM stripe_payout_transfers t
  JOIN payout_orders p ON p.id = t.payout_id
  JOIN stripe_payout_destination_links d ON d.id = t.destination_link_id
  CROSS JOIN LATERAL (VALUES
    ((settlement).journal_id, 'settled', NULL::uuid, NULL::text, 'stripe.test.bank_payout.settled'),
    ((settlement).reversal_journal_id, 'reversed', (settlement).journal_id, (settlement).review_reason,
      'stripe.test.bank_payout.reversal')
  ) AS movement(journal_id, state, original_journal_id, reason, journal_source)
  JOIN journal_transactions j
    ON j.id = movement.journal_id AND j.source = movement.journal_source AND j.reference = (settlement).id::text
  WHERE t.id = (settlement).transfer_id AND j.posted_at IS NOT NULL AND j.currency = 'LKR'
  ON CONFLICT (booking_id, kind, source_id) DO NOTHING;
$$;

CREATE FUNCTION issue_stripe_bank_payout_documents()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM record_stripe_bank_payout_documents(NEW);
  RETURN NULL;
END;
$$;

CREATE TRIGGER stripe_bank_payout_documents
AFTER INSERT OR UPDATE OF journal_id, reversal_journal_id ON stripe_bank_payout_settlements
FOR EACH ROW EXECUTE FUNCTION issue_stripe_bank_payout_documents();

-- The trigger's table lock serializes the backfill with concurrent settlement writers.
DO $$
BEGIN
  PERFORM record_stripe_bank_payout_documents(s)
  FROM stripe_bank_payout_settlements s
  WHERE s.journal_id IS NOT NULL;
END;
$$;

COMMIT;
