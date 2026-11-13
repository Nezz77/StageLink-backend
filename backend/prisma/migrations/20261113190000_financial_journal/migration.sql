CREATE TYPE "JournalAccountKind" AS ENUM ('clearing', 'available', 'reserved');
CREATE TYPE "JournalPurpose" AS ENUM ('service', 'deposit');

CREATE TABLE financial_accounts (
  id uuid PRIMARY KEY,
  scope varchar(120) NOT NULL CHECK (length(scope) > 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  purpose "JournalPurpose" NOT NULL,
  kind "JournalAccountKind" NOT NULL,
  posting_revision bigint NOT NULL DEFAULT 0,
  UNIQUE (scope, currency, purpose, kind),
  UNIQUE (id, currency, purpose)
);

CREATE TABLE journal_transactions (
  id uuid PRIMARY KEY,
  source varchar(60) NOT NULL CHECK (length(source) > 0),
  reference varchar(160) NOT NULL CHECK (length(reference) > 0),
  currency char(3) NOT NULL,
  purpose "JournalPurpose" NOT NULL,
  posted_at timestamptz(3),
  UNIQUE (source, reference),
  UNIQUE (id, currency, purpose)
);

CREATE TABLE journal_entries (
  transaction_id uuid NOT NULL,
  account_id uuid NOT NULL,
  currency char(3) NOT NULL,
  purpose "JournalPurpose" NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor <> 0),
  PRIMARY KEY (transaction_id, account_id),
  FOREIGN KEY (transaction_id, currency, purpose) REFERENCES journal_transactions(id, currency, purpose),
  FOREIGN KEY (account_id, currency, purpose) REFERENCES financial_accounts(id, currency, purpose)
);
CREATE INDEX journal_entries_account_id_idx ON journal_entries(account_id);

CREATE FUNCTION guard_journal_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  posted timestamptz;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Journal entries are immutable' USING ERRCODE = '23514';
  END IF;
  SELECT posted_at INTO posted FROM journal_transactions WHERE id = NEW.transaction_id FOR UPDATE;
  IF posted IS NOT NULL THEN
    RAISE EXCEPTION 'Posted journals cannot receive entries' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER journal_entry_guard BEFORE INSERT OR UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION guard_journal_entry();

CREATE FUNCTION guard_journal_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  entry record;
  balance numeric;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.posted_at IS NOT NULL THEN
      RAISE EXCEPTION 'Create a journal before posting it' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'Journal transactions cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF OLD.posted_at IS NOT NULL OR NEW.posted_at IS NULL OR
     ROW(OLD.id, OLD.source, OLD.reference, OLD.currency, OLD.purpose)
       IS DISTINCT FROM ROW(NEW.id, NEW.source, NEW.reference, NEW.currency, NEW.purpose) THEN
    RAISE EXCEPTION 'Journal transactions are immutable after posting' USING ERRCODE = '23514';
  END IF;

  IF (SELECT count(*) < 2 OR COALESCE(sum(amount_minor), 0) <> 0
      FROM journal_entries WHERE transaction_id = NEW.id) THEN
    RAISE EXCEPTION 'Journal entries must balance' USING ERRCODE = '23514';
  END IF;

  FOR entry IN
    SELECT e.account_id, e.amount_minor, a.kind
    FROM journal_entries e JOIN financial_accounts a ON a.id = e.account_id
    WHERE e.transaction_id = NEW.id ORDER BY e.account_id
  LOOP
    -- A row update serializes writers and forces stale repeatable-read transactions to retry.
    UPDATE financial_accounts SET posting_revision = posting_revision + 1 WHERE id = entry.account_id;
    IF entry.kind <> 'clearing' AND entry.amount_minor < 0 THEN
      SELECT COALESCE(sum(e.amount_minor), 0) INTO balance
      FROM journal_entries e JOIN journal_transactions j ON j.id = e.transaction_id
      WHERE e.account_id = entry.account_id AND j.posted_at IS NOT NULL;
      IF balance + entry.amount_minor < 0 THEN
        RAISE EXCEPTION 'Insufficient journal funds' USING ERRCODE = 'SL001';
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER journal_transaction_guard BEFORE INSERT OR UPDATE OR DELETE ON journal_transactions
  FOR EACH ROW EXECUTE FUNCTION guard_journal_transaction();

CREATE FUNCTION guard_financial_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(OLD.id, OLD.scope, OLD.currency, OLD.purpose, OLD.kind)
       IS DISTINCT FROM ROW(NEW.id, NEW.scope, NEW.currency, NEW.purpose, NEW.kind) THEN
    RAISE EXCEPTION 'Financial account identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER financial_account_guard BEFORE UPDATE ON financial_accounts
  FOR EACH ROW EXECUTE FUNCTION guard_financial_account();

CREATE FUNCTION post_financial_journal(
  transaction_id uuid, command_source varchar, command_reference varchar,
  journal_currency char(3), journal_purpose "JournalPurpose", postings jsonb
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  journal journal_transactions%ROWTYPE;
  stored jsonb;
BEGIN
  INSERT INTO journal_transactions (id, source, reference, currency, purpose)
  VALUES (transaction_id, command_source, command_reference, journal_currency, journal_purpose)
  ON CONFLICT (source, reference) DO NOTHING
  RETURNING * INTO journal;

  IF NOT FOUND THEN
    SELECT * INTO STRICT journal FROM journal_transactions
    WHERE source = command_source AND reference = command_reference;
    SELECT jsonb_object_agg(account_id::text, amount_minor::text) INTO stored
    FROM journal_entries e WHERE e.transaction_id = journal.id;
    IF journal.posted_at IS NULL OR journal.currency <> journal_currency OR journal.purpose <> journal_purpose
       OR stored IS DISTINCT FROM postings THEN
      RAISE EXCEPTION 'Journal command key already used' USING ERRCODE = 'SL002';
    END IF;
    RETURN journal.id;
  END IF;

  INSERT INTO journal_entries (transaction_id, account_id, currency, purpose, amount_minor)
  SELECT journal.id, key::uuid, journal.currency, journal.purpose, value::bigint
  FROM jsonb_each_text(postings);

  UPDATE journal_transactions SET posted_at = clock_timestamp() WHERE id = journal.id;
  RETURN journal.id;
END;
$$;
