"""Durable outbox reconciliation, safe to restart after DB commit/enqueue gaps."""

import logging
import time
from datetime import timedelta

from sqlalchemy import or_, select

from .db import Run, Session, now
from .pipeline import event
from .worker import process_invoice


def dispatch_once():
    with Session.begin() as db:
        runs = list(
            db.scalars(
                select(Run)
                .where(
                    or_(
                        Run.state == "QUEUED", (Run.state == "RUNNING") & (Run.lease_until < now())
                    ),
                    or_(Run.retry_at.is_(None), Run.retry_at <= now()),
                    or_(
                        Run.dispatched_at.is_(None),
                        Run.dispatched_at < now() - timedelta(seconds=45),
                    ),
                )
                .order_by(Run.created_at)
                .limit(10)
                .with_for_update(skip_locked=True)
            )
        )
        for run in runs:
            if run.attempt >= 3:
                run.state, run.finished_at = "FAILED", now()
                run.error = "The worker stopped repeatedly. No new decision was made. Retry after service recovery."
                event(db, run.id, "recovery", "failed", run.error)
                continue
            try:
                process_invoice.apply_async(args=[run.id], retry=False)
                run.dispatched_at = now()
                run.dispatch_count += 1
            except Exception as exc:
                logging.warning(
                    "Dispatch unavailable (%s); persisted run will be retried", type(exc).__name__
                )
                break


if __name__ == "__main__":
    while True:
        try:
            dispatch_once()
        except Exception as exc:
            logging.warning("Reconciler unavailable (%s)", type(exc).__name__)
        time.sleep(3)
