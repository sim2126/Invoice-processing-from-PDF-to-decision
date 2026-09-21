"""Initial schema and immutable financial records."""

from alembic import op
from ap.db import Base

revision = "001"
down_revision = None


def upgrade():
    Base.metadata.create_all(op.get_bind())
    op.execute("""
    CREATE FUNCTION reject_immutable_change() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'Financial history is immutable'; END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER immutable_decision BEFORE UPDATE OR DELETE ON decision
      FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
    CREATE TRIGGER immutable_commitment BEFORE UPDATE OR DELETE ON commitment
      FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
    CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON audit
      FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
    """)


def downgrade():
    raise RuntimeError("Destructive downgrade disabled; restore an approved backup.")
