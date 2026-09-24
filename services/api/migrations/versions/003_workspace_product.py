"""Company profiles, scoped team access, reference documents and AI provenance."""

import uuid

import sqlalchemy as sa
from alembic import op
from ap.db import CompanyDocument, Invitation, Member

revision = "003"
down_revision = "002"


def upgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    for table, column in [("workspace", "company"), ("decision", "assistant")]:
        if column not in {c["name"] for c in inspector.get_columns(table)}:
            op.add_column(table, sa.Column(column, sa.JSON(), nullable=False, server_default="{}"))
    for table in [Member.__table__, Invitation.__table__, CompanyDocument.__table__]:
        table.create(bind, checkfirst=True)
    workspaces = (
        bind.execute(
            sa.text(
                "SELECT id, token_hash, csrf FROM workspace WHERE NOT EXISTS "
                "(SELECT 1 FROM member WHERE member.workspace_id = workspace.id)"
            )
        )
        .mappings()
        .all()
    )
    for workspace in workspaces:
        bind.execute(
            Member.__table__.insert().values(
                id=str(uuid.uuid4()),
                workspace_id=workspace["id"],
                name="Prabhakar Kumar",
                email="prabhakar@example.com",
                role="owner",
                token_hash=workspace["token_hash"],
                csrf=workspace["csrf"],
                active=True,
            )
        )


def downgrade():
    raise RuntimeError("Restore a reviewed backup instead of deleting team and AI history.")
