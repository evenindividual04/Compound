-- Hardening: partial unique dedup indexes, transfer/split integrity triggers,
-- reconciled-entry freeze. See spec §4.3 — these are non-negotiable invariants.

-- Dedup must ignore tombstones and include amount + sign (spec §4.3.1).
CREATE UNIQUE INDEX "entries_external_unique" ON "entries" ("account_id", "external_id", "amount")
  WHERE "external_id" IS NOT NULL AND "deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "entries_hash_unique" ON "entries" ("account_id", "import_hash")
  WHERE "import_hash" IS NOT NULL AND "deleted_at" IS NULL;--> statement-breakpoint

-- Transfer legs: different accounts, no deleted legs, same-currency legs net to zero,
-- outflow negative / inflow positive. Deferred so both legs + link commit atomically.
CREATE OR REPLACE FUNCTION check_transfer() RETURNS trigger AS $$
DECLARE o entries%ROWTYPE; i entries%ROWTYPE;
BEGIN
  SELECT * INTO o FROM entries WHERE id = NEW.outflow_entry_id;
  SELECT * INTO i FROM entries WHERE id = NEW.inflow_entry_id;
  IF o.id IS NULL OR i.id IS NULL THEN RAISE EXCEPTION 'transfer leg missing'; END IF;
  IF o.account_id = i.account_id THEN RAISE EXCEPTION 'transfer legs on same account'; END IF;
  IF o.deleted_at IS NOT NULL OR i.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'transfer leg deleted'; END IF;
  IF o.currency = i.currency AND o.amount + i.amount <> 0 THEN RAISE EXCEPTION 'transfer legs do not net to zero'; END IF;
  IF o.amount >= 0 OR i.amount <= 0 THEN RAISE EXCEPTION 'outflow must be negative, inflow positive'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER transfer_integrity AFTER INSERT OR UPDATE ON transfers
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_transfer();--> statement-breakpoint

-- Soft-deleting a leg of a transfer must dissolve the transfer first.
CREATE OR REPLACE FUNCTION block_transfer_leg_delete() RETURNS trigger AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    IF EXISTS (SELECT 1 FROM transfers WHERE outflow_entry_id = NEW.id OR inflow_entry_id = NEW.id) THEN
      RAISE EXCEPTION 'cannot delete a leg of an existing transfer; dissolve the transfer first';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER transfer_leg_delete_guard BEFORE UPDATE ON entries
  FOR EACH ROW EXECUTE FUNCTION block_transfer_leg_delete();--> statement-breakpoint

-- Splits: must sum exactly to the parent amount, and a split parent carries no category
-- of its own (XOR). Deferred to COMMIT so multi-row split edits are atomic.
CREATE OR REPLACE FUNCTION check_splits() RETURNS trigger AS $$
DECLARE parent_amount numeric; split_sum numeric; split_count int; parent_cat uuid; eid uuid;
BEGIN
  eid := COALESCE(NEW.entry_id, OLD.entry_id);
  SELECT e.amount, t.category_id INTO parent_amount, parent_cat
    FROM entries e JOIN transactions t ON t.entry_id = e.id WHERE e.id = eid;
  IF parent_amount IS NULL THEN RAISE EXCEPTION 'splits require a transaction parent'; END IF;
  SELECT COALESCE(SUM(amount), 0), COUNT(*) INTO split_sum, split_count
    FROM transaction_splits WHERE entry_id = eid;
  IF split_count > 0 AND split_sum <> parent_amount THEN
    RAISE EXCEPTION 'splits must sum to entry amount (% vs %)', split_sum, parent_amount;
  END IF;
  IF split_count > 0 AND parent_cat IS NOT NULL THEN
    RAISE EXCEPTION 'split parent must have null category';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER splits_integrity AFTER INSERT OR UPDATE OR DELETE ON transaction_splits
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_splits();--> statement-breakpoint

-- Reconciled entries: financial core is frozen.
CREATE OR REPLACE FUNCTION freeze_reconciled() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'reconciled' AND (
    NEW.amount <> OLD.amount OR NEW.date <> OLD.date OR NEW.account_id <> OLD.account_id
    OR NEW.entry_type <> OLD.entry_type OR NEW.currency <> OLD.currency
  ) THEN
    RAISE EXCEPTION 'cannot modify financial core of reconciled entry';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER reconciled_freeze BEFORE UPDATE ON entries
  FOR EACH ROW EXECUTE FUNCTION freeze_reconciled();
