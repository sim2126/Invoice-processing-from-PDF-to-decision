"""Human workflow states (on hold, rejected) and where each invoice came from."""

import sqlalchemy as sa
from alembic import op

revision = "004"
down_revision = "003"

COLUMNS = [
    sa.Column("workflow", sa.String(20), nullable=True),
    sa.Column("workflow_to", sa.String(120), nullable=True),
    sa.Column("workflow_note", sa.Text(), nullable=True),
    sa.Column("workflow_by", sa.String(80), nullable=True),
    sa.Column("workflow_at", sa.DateTime(timezone=True), nullable=True),
    sa.Column("source", sa.String(20), nullable=False, server_default="upload"),
]
CONSTRAINTS = {
    "invoice_workflow_check": "workflow IN ('ON_HOLD','REJECTED')",
    "invoice_source_check": "source IN ('upload','inbox','history')",
}


def upgrade():
    # Migration 001 creates tables from the current models on a fresh database,
    # so only add what an existing database is missing.
    inspector = sa.inspect(op.get_bind())
    existing = {c["name"] for c in inspector.get_columns("invoice")}
    for column in COLUMNS:
        if column.name not in existing:
            op.add_column("invoice", column)
    checks = {c["name"] for c in inspector.get_check_constraints("invoice")}
    for name, condition in CONSTRAINTS.items():
        if name not in checks:
            op.create_check_constraint(name, "invoice", condition)


def downgrade():
    raise RuntimeError("Restore a reviewed backup instead of discarding workflow history.")
