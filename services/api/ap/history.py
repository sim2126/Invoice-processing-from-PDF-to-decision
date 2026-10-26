"""Seeded workspace history: real fixture PDFs decided by the real rules engine.

New workspaces open with the invoices received over the previous weeks. Each is
decided the way ``finalize`` decides an upload — verified evidence, the same
policy evaluation against the balances left by earlier invoices, and the same
decision, commitment, audit and event records — then any recorded reviewer
action (choosing an order, putting an invoice on hold) is applied in time
order. Nothing calls a model; extraction and provenance are marked imported.

Documents are served from the fixtures built into the image (``fixture/`` keys),
never copied into per-workspace storage.
"""

import copy
import hashlib
import json
from datetime import datetime, timedelta
from functools import lru_cache

from sqlalchemy import insert

from .checks import group_events, po_source, read_message
from .config import FIXTURES, POLICY_VERSION, SCHEMA_VERSION
from .db import Audit, Commitment, Decision, Event, Invoice, Revision, Run, uid
from .documents import verify_evidence
from .pipeline import po_dict, vendor_dict
from .rules import decimal, evaluate, identity
from .storage import FIXTURE_PREFIX

DIRECTORY = FIXTURES / "history"
IMPORTED = "imported"
REVIEW_SECONDS = 4.6
TABLES = [
    ("invoice", Invoice),
    ("revision", Revision),
    ("run", Run),
    ("decision", Decision),
    ("commitment", Commitment),
    ("event", Event),
    ("audit", Audit),
]


def available() -> bool:
    return (DIRECTORY / "manifest.json").is_file()


@lru_cache(maxsize=1)
def dataset():
    """Load once per process. Evidence depends only on the fixed page and extraction."""
    manifest = json.loads((DIRECTORY / "manifest.json").read_text("utf-8"))
    items = []
    for item in manifest["items"]:
        data = json.loads((DIRECTORY / item["extraction"]).read_text("utf-8"))
        pages = json.loads((DIRECTORY / item["page_data"]).read_text("utf-8"))
        items.append(
            {
                **item,
                "data": data,
                "page_data": pages,
                "evidence": verify_evidence(data, pages),
                "sha256": hashlib.sha256((DIRECTORY / item["file"]).read_bytes()).hexdigest(),
            }
        )
    return tuple(items)


def at(value: str) -> datetime:
    return datetime.fromisoformat(value)


class Seeder:
    def __init__(self, workspace_id, vendors, orders):
        self.workspace_id = workspace_id
        self.vendors = [vendor_dict(v) for v in vendors]
        self.orders = [po_dict(p) for p in orders]
        self.order_ids = {p["reference"]: p["id"] for p in self.orders}
        self.commitments = []
        self.prior = {}
        self.current = {}
        self.rows = {name: [] for name, _ in TABLES}

    def event(self, run_id, stage, state, message, when):
        self.rows["event"].append(
            {"run_id": run_id, "stage": stage, "state": state, "message": message, "at": when}
        )

    def audit(self, invoice, run_id, actor, action, before, after, reason, when):
        self.rows["audit"].append(
            {
                "id": uid(),
                "invoice_id": invoice["id"],
                "run_id": run_id,
                "actor": actor,
                "action": action,
                "revision": invoice["revision"],
                "policy_version": POLICY_VERSION,
                "before": before,
                "after": after,
                "reason": reason,
                "at": when,
            }
        )

    def decide(self, invoice, item, number, selections, provenance, start, seconds, opening):
        """What process + finalize record for one run, at the time it happened."""
        data = copy.deepcopy(item["data"])
        evidence = copy.deepcopy(item["evidence"])
        others = [p for key, p in self.prior.items() if key != invoice["id"]]
        result = evaluate(
            data,
            evidence,
            self.vendors,
            self.orders,
            self.commitments,
            others,
            selections,
            start.date(),
        )
        run_id, decision_id = uid(), uid()
        finished = start + timedelta(seconds=seconds)
        invoice.update(revision=number, current_run=run_id, current_decision=decision_id)
        self.rows["run"].append(
            {
                "id": run_id,
                "invoice_id": invoice["id"],
                "revision": number,
                "state": "COMPLETED",
                "attempt": 1,
                "model": IMPORTED,
                "usage": {},
                "created_at": start,
                "started_at": start + timedelta(seconds=0.4),
                "finished_at": finished,
            }
        )
        self.rows["revision"].append(
            {
                "id": uid(),
                "invoice_id": invoice["id"],
                "number": number,
                "extraction": data,
                "selections": selections,
                "provenance": {
                    **provenance,
                    "model": IMPORTED,
                    "schema": SCHEMA_VERSION,
                    "prompt": IMPORTED,
                    "evidence": evidence,
                    "document_hash": invoice["sha256"],
                    "ai_po_selection": None,
                },
            }
        )
        for offset, (stage, state, message) in enumerate(opening):
            self.event(run_id, stage, state, message, start + timedelta(seconds=0.2 * offset))
        self.event(
            run_id,
            "read",
            "passed",
            read_message(item["page_data"]),
            start + timedelta(seconds=1.1),
        )
        self.event(
            run_id,
            "extract",
            "passed",
            "Structured invoice facts received. Approval is determined by the policy checks.",
            start + timedelta(seconds=seconds * 0.6),
        )
        checked = finished - timedelta(seconds=0.6)
        self.event(
            run_id,
            "checks",
            "passed",
            "Evidence, matching, arithmetic, duplicate and cumulative checks recorded.",
            checked,
        )
        for index, (stage, state, message) in enumerate(
            group_events(result, data, po_source=po_source(data, selections))
        ):
            self.event(run_id, stage, state, message, checked + timedelta(seconds=0.05 * index))
        outcome = result["outcome"]
        self.event(
            run_id,
            "decision",
            "passed" if outcome == "APPROVED" else "blocked" if outcome == "BLOCKED" else "review",
            result["summary"],
            finished,
        )
        self.rows["decision"].append(
            {
                "id": decision_id,
                "invoice_id": invoice["id"],
                "run_id": run_id,
                "revision": number,
                "outcome": outcome,
                "policy_version": POLICY_VERSION,
                "document_hash": invoice["sha256"],
                "schema_version": SCHEMA_VERSION,
                "prompt_version": IMPORTED,
                "model": IMPORTED,
                "extraction": {**data, "verified_evidence": evidence},
                "checks": result["checks"],
                "summary": result["summary"],
                "next_action": result["next_action"],
                "owner": result["owner"],
                "vendor_id": result["vendor_id"],
                "po_id": result["po_id"],
                "comparison": result["comparison"],
                "duplicate_id": result["duplicate_id"],
                "assistant": {"status": IMPORTED},
                "created_at": finished,
            }
        )
        if outcome == "APPROVED":
            self.rows["commitment"].append(
                {
                    "id": uid(),
                    "workspace_id": self.workspace_id,
                    "po_id": result["po_id"],
                    "invoice_id": invoice["id"],
                    "vendor_id": result["vendor_id"],
                    "identity": identity(data["invoice_number"]),
                    "invoice_date": data["invoice_date"],
                    "currency": data["currency"],
                    "amount": decimal(data["total"]),
                    "quantities": result["allocations"],
                    "historical": False,
                }
            )
            self.commitments.append(
                {
                    "po_id": result["po_id"],
                    "amount": data["total"],
                    "quantities": result["allocations"],
                }
            )
        self.audit(
            invoice,
            run_id,
            "Policy engine",
            "DECISION",
            {},
            {"outcome": outcome, "decision_id": decision_id},
            result["summary"],
            finished,
        )
        self.prior[invoice["id"]] = {
            "invoice_id": invoice["id"],
            "vendor_id": result["vendor_id"],
            "reference": data.get("invoice_number"),
            "total": data.get("total"),
            "date": data.get("invoice_date"),
            "currency": data.get("currency"),
        }
        self.current[invoice["id"]] = {
            "outcome": outcome,
            "selections": selections,
            "provenance": self.rows["revision"][-1]["provenance"],
        }
        return run_id

    def receive(self, item, when):
        invoice = {
            "id": uid(),
            "workspace_id": self.workspace_id,
            "filename": item["filename"],
            "sha256": item["sha256"],
            "object_key": f"{FIXTURE_PREFIX}history/{item['file']}",
            "pages": item["pages"],
            "page_data": item["page_data"],
            "revision": 1,
            "current_run": None,
            "current_decision": None,
            "human_touched": False,
            "created_at": when,
            "source": "history",
            "workflow": None,
            "workflow_to": None,
            "workflow_note": None,
            "workflow_by": None,
            "workflow_at": None,
        }
        self.rows["invoice"].append(invoice)
        opening = [
            ("intake", "passed", f"PDF accepted · {item['pages']} page(s). Queued for processing.")
        ]
        run_id = self.decide(invoice, item, 1, {}, {}, when, item["seconds"], opening)
        self.audit(
            invoice,
            run_id,
            "AP inbox",
            "UPLOAD",
            {},
            {"filename": item["filename"], "sha256": item["sha256"], "source": "history"},
            "Invoice received by email.",
            when,
        )
        return invoice

    def review(self, invoice, item, action, when):
        """A reviewer confirms the order, exactly as the review endpoint records it."""
        current = self.current[invoice["id"]]
        order = next(p for p in self.orders if p["reference"] == action["po"])
        before = {
            "purchase_order": current["selections"].get("po_id") or item["data"]["po_reference"]
        }
        number = invoice["revision"] + 1
        invoice["human_touched"] = True
        run_id = self.decide(
            invoice,
            item,
            number,
            {**current["selections"], "po_id": order["id"]},
            {**current["provenance"], "corrections": [], "source_revision": number - 1},
            when,
            REVIEW_SECONDS,
            [
                (
                    "review",
                    "passed",
                    "Reviewer changes recorded. All checks will run against current PO balances.",
                )
            ],
        )
        self.audit(
            invoice,
            run_id,
            action["by"],
            "REVIEW",
            before,
            {"purchase_order": order["reference"]},
            action["reason"],
            when,
        )

    def hold(self, invoice, action, when):
        """Only an invoice that needs review can wait on someone, as with the endpoint."""
        if self.current[invoice["id"]]["outcome"] != "NEEDS_REVIEW":
            raise ValueError(f"History invoice {invoice['filename']} cannot be put on hold.")
        invoice.update(
            workflow="ON_HOLD",
            workflow_to=action["to"],
            workflow_note=action["message"],
            workflow_by=action["by"],
            workflow_at=when,
        )
        self.audit(
            invoice,
            invoice["current_run"],
            action["by"],
            "HOLD",
            {"workflow": None},
            {"to": action["to"], "message": action["message"]},
            action["message"],
            when,
        )

    def build(self, items):
        steps = []
        for item in items:
            steps.append((at(item["received_at"]), 0, item["index"], item, None))
            for action in item["actions"]:
                steps.append((at(action["at"]), 1, item["index"], item, action))
        steps.sort(key=lambda step: step[:3])
        invoices = {}
        for when, _, index, item, action in steps:
            if action is None:
                invoices[index] = self.receive(item, when)
            elif action["kind"] == "review":
                self.review(invoices[index], item, action, when)
            elif action["kind"] == "hold":
                self.hold(invoices[index], action, when)
            else:
                raise ValueError(f"Unknown history action {action['kind']}")
        return self.rows


def seed_history(db, workspace_id, vendors, orders):
    """Insert the decided history in a few batched statements, parents first."""
    rows = Seeder(workspace_id, vendors, orders).build(dataset())
    for name, model in TABLES:
        if rows[name]:
            db.execute(insert(model), rows[name])
    return len(rows["invoice"])
