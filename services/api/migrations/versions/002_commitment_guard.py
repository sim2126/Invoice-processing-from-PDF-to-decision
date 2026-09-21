"""Defense-in-depth database guard for budgets, quantities and workspace alignment."""

from alembic import op

revision = "002"
down_revision = "001"


def upgrade():
    op.execute("""
    CREATE FUNCTION guard_commitment() RETURNS trigger AS $$
    DECLARE p purchase_order%ROWTYPE; used_amount numeric; item json; used_qty numeric;
    BEGIN
      PERFORM 1 FROM workspace WHERE id = NEW.workspace_id FOR UPDATE;
      SELECT * INTO p FROM purchase_order WHERE id = NEW.po_id FOR UPDATE;
      IF p.workspace_id <> NEW.workspace_id OR p.vendor_id <> NEW.vendor_id OR p.currency <> NEW.currency THEN
        RAISE EXCEPTION 'Commitment ownership mismatch';
      END IF;
      IF NEW.invoice_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM invoice WHERE id=NEW.invoice_id AND workspace_id=NEW.workspace_id
      ) THEN RAISE EXCEPTION 'Invoice ownership mismatch'; END IF;
      SELECT COALESCE(SUM(amount),0) INTO used_amount FROM commitment WHERE po_id=NEW.po_id;
      IF used_amount + NEW.amount > p.ceiling THEN RAISE EXCEPTION 'PO ceiling exceeded'; END IF;
      FOR item IN SELECT * FROM json_array_elements(p.lines) LOOP
        SELECT COALESCE(SUM(COALESCE((quantities ->> (item->>'sku'))::numeric,0)),0)
          INTO used_qty FROM commitment WHERE po_id=NEW.po_id;
        IF COALESCE((NEW.quantities ->> (item->>'sku'))::numeric,0) < 0 OR
           used_qty + COALESCE((NEW.quantities ->> (item->>'sku'))::numeric,0) > (item->>'quantity')::numeric
        THEN RAISE EXCEPTION 'PO quantity exceeded'; END IF;
      END LOOP;
      IF EXISTS (SELECT 1 FROM json_object_keys(NEW.quantities) AS k WHERE NOT EXISTS
        (SELECT 1 FROM json_array_elements(p.lines) AS l WHERE l->>'sku'=k))
      THEN RAISE EXCEPTION 'Unknown PO line allocation'; END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER commitment_guard BEFORE INSERT ON commitment
      FOR EACH ROW EXECUTE FUNCTION guard_commitment();
    """)


def downgrade():
    raise RuntimeError("Restore a reviewed backup instead of discarding financial safeguards.")
