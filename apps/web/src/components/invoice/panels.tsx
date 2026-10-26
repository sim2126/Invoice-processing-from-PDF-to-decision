"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  action,
  api,
  mutation,
  type CompanyDocument,
  type Detail,
  type HoldRequest,
  type PurchaseOrder,
  type RejectRequest,
  type ReviewRequest,
  type UploadResult,
} from "@/lib/api";
import { money } from "@/lib/format";
import { keys, useDocuments, useInbox, useSuppliers } from "@/lib/queries";
import { supplierName } from "@/lib/steps";
import { aiReview, buildDraft, noMatchText } from "@/lib/verdict";
import { IconCopy, IconDocSearch } from "../icons";
import { useShell } from "../shell-context";
import { Drawer, ErrorNotice } from "../ui";

function invoiceName(detail: Detail) {
  return detail.invoice.reference ?? detail.extraction?.invoice_number ?? "this invoice";
}

/** Words of a supplier name, for ordering likely matches first. */
function words(name: string) {
  return new Set(
    name
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1 && !["llc", "inc", "co", "ltd", "corp", "the"].includes(w)),
  );
}

export function ChoosePanel({
  detail,
  orders,
  onClose,
  onStarted,
}: {
  detail: Detail;
  orders: PurchaseOrder[];
  onClose: () => void;
  onStarted: () => Promise<void>;
}) {
  const { session, notify } = useShell();
  const inv = detail.invoice;
  const [pick, setPick] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  const review = useMutation({
    mutationFn: (body: ReviewRequest) =>
      api<UploadResult>(
        `/invoices/${encodeURIComponent(inv.id)}/review`,
        mutation(session.csrf, body),
      ),
    onSuccess: async (_, body) => {
      onClose();
      notify(
        body.po_id
          ? "Order confirmed · every check runs again"
          : "Checking company documents · every check runs again",
      );
      await onStarted();
    },
  });
  const client = useQueryClient();
  const documents = useDocuments();
  const inbox = useInbox();
  const candidates = detail.candidates.orders;
  const leftOn = (id: string) => orders.find((o) => o.id === id)?.remaining;
  const picked = candidates.find((c) => c.id === pick);
  const pickedLeft = picked ? leftOn(picked.id) : undefined;
  const reasonShort = reason.trim().length < 8;
  const searching = review.isPending && !review.variables?.po_id;
  const number = invoiceName(detail);
  const onFile = documents.data?.length;
  const lastCheck = aiReview(detail).miss;
  // An unsaved email that mentions this invoice may be the missing evidence.
  const mention =
    number !== "this invoice"
      ? (inbox.data ?? []).find(
          (item) =>
            item.kind === "document" &&
            !item.document_id &&
            item.subject.toLowerCase().includes(number.toLowerCase()),
        )
      : undefined;
  const save = useMutation({
    mutationFn: (key: string) =>
      api<CompanyDocument>(`/inbox/${encodeURIComponent(key)}/save`, action(session.csrf)),
    onSuccess: async (document) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: keys.inbox }),
        client.invalidateQueries({ queryKey: keys.documents }),
      ]);
      notify(`Saved to company documents · ${document.filename}`);
    },
  });

  function confirm() {
    setTried(true);
    if (!pick || reasonShort) return;
    review.mutate({
      expected_revision: inv.revision,
      reason: reason.trim(),
      po_id: pick,
      corrections: [],
    });
  }

  return (
    <Drawer
      open
      onOpenChange={(open) => !open && onClose()}
      busy={review.isPending}
      title="Choose the purchase order"
      description="Pick the order this invoice belongs to. Every check runs again."
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          confirm();
        }}
      >
        <div className="tm-drawer-b">
          <div className="tm-diff">
            <span>Invoice</span>
            <strong className="tm-mono">{number}</strong>
            <span>Supplier</span>
            <strong>{supplierName(detail) ?? "—"}</strong>
            <span>Amount</span>
            <strong>{money(inv.total)}</strong>
          </div>
          {lastCheck && !searching && (
            <p className="tm-note" role="note">
              Last AI check: {noMatchText(lastCheck)}.
            </p>
          )}
          {mention && (
            <div className="tm-note tm-note-row" role="note">
              <span style={{ flex: 1, minWidth: 0 }}>
                An email in the inbox mentions {number}: “{mention.subject}”.
              </span>
              <button
                type="button"
                className="tm-btn tm-btn-line tm-btn-sm"
                disabled={save.isPending || review.isPending}
                onClick={() => save.mutate(mention.key)}
              >
                {save.isPending ? "Saving…" : "Save to company documents"}
              </button>
            </div>
          )}
          <ErrorNotice error={save.error} />
          <fieldset className="tm-options">
            <legend>Open orders that could cover it</legend>
            {candidates.length === 0 && (
              <p className="tm-muted" style={{ fontSize: 13 }}>
                This supplier has no open purchase order.
              </p>
            )}
            {candidates.map((c) => {
              const line = c.lines[0];
              const left = leftOn(c.id);
              return (
                <label className="tm-option" key={c.id}>
                  <input
                    type="radio"
                    name="tm-order"
                    value={c.id}
                    checked={pick === c.id}
                    onChange={() => setPick(c.id)}
                  />
                  <span className="tm-radio" aria-hidden="true" />
                  <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                    <span style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <span className="tm-mono" style={{ fontWeight: 600 }}>
                        {c.reference}
                      </span>
                      {left != null && (
                        <span className="tm-num" style={{ fontWeight: 550 }}>
                          {money(left)} left
                        </span>
                      )}
                    </span>
                    <span className="tm-muted" style={{ fontSize: 12.5 }}>
                      {c.description}
                      {line ? ` · ${money(String(line.unit_price))} per ${String(line.unit)}` : ""}
                    </span>
                  </span>
                </label>
              );
            })}
          </fieldset>
          {session.company.ai_assistance && !searching && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <button
                type="button"
                className="tm-btn tm-btn-line"
                disabled={review.isPending || save.isPending}
                aria-describedby="tm-docs-on-file"
                onClick={() =>
                  review.mutate({
                    expected_revision: inv.revision,
                    reason: "Asked AI to check company documents for the purchase order.",
                    corrections: [],
                  })
                }
              >
                <IconDocSearch size={16} />
                Ask AI to check company documents
              </button>
              <span id="tm-docs-on-file" className="tm-hint">
                {onFile == null
                  ? "Counting documents…"
                  : `${onFile} ${onFile === 1 ? "document" : "documents"} on file`}
              </span>
            </div>
          )}
          {searching && (
            <div className="tm-evidence" role="status">
              <span className="tm-muted" style={{ fontSize: 12.5 }}>
                Asking AI to read the company documents for {number}…
              </span>
              <div className="tm-shimmer" />
              <div className="tm-shimmer" style={{ width: "70%" }} />
            </div>
          )}
          <div className="tm-field">
            <label htmlFor="tm-choose-reason">Reason · saved to the audit trail</label>
            <textarea
              id="tm-choose-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="What confirms this order?"
              aria-invalid={tried && reasonShort}
              aria-describedby="tm-choose-reason-hint"
            />
            <span
              id="tm-choose-reason-hint"
              className={tried && reasonShort ? "tm-bad-text" : "tm-hint"}
              style={{ fontSize: 12 }}
            >
              {tried && reasonShort
                ? "Add a reason of at least 8 characters."
                : "Needed when you pick an order. It appears in the invoice history."}
            </span>
          </div>
          {picked && (
            <div className="tm-diff">
              <span>Purchase order</span>
              <strong className="tm-mono">none → {picked.reference}</strong>
              <span>Reserved if approved</span>
              <strong>{money(inv.total)}</strong>
              {pickedLeft != null && (
                <>
                  <span>{picked.reference} left after</span>
                  <strong>{money(Number(pickedLeft) - Number(inv.total ?? 0))}</strong>
                </>
              )}
              <span>Then</span>
              <strong style={{ fontWeight: 500 }}>All 11 checks run again</strong>
            </div>
          )}
          <ErrorNotice error={review.error} />
        </div>
        <div className="tm-drawer-f">
          <button
            type="button"
            className="tm-btn tm-btn-line"
            onClick={onClose}
            disabled={review.isPending}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="tm-btn tm-btn-primary"
            disabled={review.isPending || !pick}
          >
            {review.isPending && review.variables?.po_id ? "Confirming…" : "Confirm and rerun checks"}
          </button>
        </div>
      </form>
    </Drawer>
  );
}

export function ConfirmSupplierPanel({
  detail,
  onClose,
  onStarted,
}: {
  detail: Detail;
  onClose: () => void;
  onStarted: () => Promise<void>;
}) {
  const { session, notify } = useShell();
  const inv = detail.invoice;
  const suppliers = useSuppliers();
  const [pick, setPick] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  const review = useMutation({
    mutationFn: (body: ReviewRequest) =>
      api<UploadResult>(
        `/invoices/${encodeURIComponent(inv.id)}/review`,
        mutation(session.csrf, body),
      ),
    onSuccess: async () => {
      onClose();
      notify("Supplier confirmed · every check runs again");
      await onStarted();
    },
  });
  const printed = detail.extraction?.vendor_name ?? inv.vendor ?? "Not printed";
  const printedId = detail.extraction?.vendor_identifier ?? null;
  const printedPo = detail.extraction?.po_reference ?? null;
  // Likely matches first; the person still chooses.
  const target = words(`${printed} ${printedId ?? ""}`);
  const options = (suppliers.data ?? [])
    .filter((s) => s.active)
    .map((s) => ({
      supplier: s,
      score: [...words(`${s.name} ${s.identifier}`)].filter((w) => target.has(w)).length,
    }))
    .sort((a, b) => b.score - a.score || a.supplier.name.localeCompare(b.supplier.name))
    .map((o) => o.supplier);
  const picked = options.find((s) => s.id === pick);
  const reasonShort = reason.trim().length < 8;

  function confirm() {
    setTried(true);
    if (!pick || reasonShort) return;
    review.mutate({
      expected_revision: inv.revision,
      reason: reason.trim(),
      vendor_id: pick,
      corrections: [],
    });
  }

  return (
    <Drawer
      open
      onOpenChange={(open) => !open && onClose()}
      busy={review.isPending}
      title="Confirm the supplier"
      description="Pick the approved supplier who sent this invoice. Every check runs again."
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          confirm();
        }}
      >
        <div className="tm-drawer-b">
          <div className="tm-diff">
            <span>Invoice</span>
            <strong className="tm-mono">{invoiceName(detail)}</strong>
            <span>Supplier as printed</span>
            <strong>{printed}</strong>
            {printedId && (
              <>
                <span>Supplier ID as printed</span>
                <strong className="tm-mono">{printedId}</strong>
              </>
            )}
            <span>Amount</span>
            <strong>{money(inv.total)}</strong>
          </div>
          <fieldset className="tm-options">
            <legend>Approved suppliers</legend>
            {suppliers.isPending && (
              <p className="tm-muted" style={{ fontSize: 13 }}>
                Loading suppliers…
              </p>
            )}
            {options.map((s) => (
              <label className="tm-option" key={s.id}>
                <input
                  type="radio"
                  name="tm-supplier"
                  value={s.id}
                  checked={pick === s.id}
                  onChange={() => setPick(s.id)}
                />
                <span className="tm-radio" aria-hidden="true" />
                <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                  <span style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <span style={{ fontWeight: 600 }}>{s.name}</span>
                    <span className="tm-mono tm-muted" style={{ fontSize: 12 }}>
                      {s.identifier}
                    </span>
                  </span>
                  <span className="tm-muted" style={{ fontSize: 12.5 }}>
                    {s.open_orders} open {s.open_orders === 1 ? "order" : "orders"}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          <ErrorNotice error={suppliers.error} />
          <div className="tm-field">
            <label htmlFor="tm-supplier-reason">Reason · saved to the audit trail</label>
            <textarea
              id="tm-supplier-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="What confirms who sent this invoice?"
              aria-invalid={tried && reasonShort}
              aria-describedby="tm-supplier-reason-hint"
            />
            <span
              id="tm-supplier-reason-hint"
              className={tried && reasonShort ? "tm-bad-text" : "tm-hint"}
              style={{ fontSize: 12 }}
            >
              {tried && reasonShort
                ? "Add a reason of at least 8 characters."
                : "For example, the remittance details or a call with the supplier."}
            </span>
          </div>
          {picked && (
            <div className="tm-diff">
              <span>Supplier</span>
              <strong>
                {printed} → {picked.name}
              </strong>
              <span>Purchase order</span>
              <strong style={{ fontWeight: 500 }}>
                {printedPo ? `${printedPo} is matched next` : "Matched next, or chosen after"}
              </strong>
              <span>Then</span>
              <strong style={{ fontWeight: 500 }}>All 11 checks run again</strong>
            </div>
          )}
          <ErrorNotice error={review.error} />
        </div>
        <div className="tm-drawer-f">
          <button
            type="button"
            className="tm-btn tm-btn-line"
            onClick={onClose}
            disabled={review.isPending}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="tm-btn tm-btn-primary"
            disabled={review.isPending || !pick}
          >
            {review.isPending ? "Confirming…" : "Confirm and rerun checks"}
          </button>
        </div>
      </form>
    </Drawer>
  );
}

export function DraftPanel({
  kind,
  detail,
  orders,
  onClose,
  onChanged,
}: {
  kind: "procurement" | "supplier";
  detail: Detail;
  orders: PurchaseOrder[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { session, notify } = useShell();
  const inv = detail.invoice;
  const [draft] = useState(() =>
    buildDraft(detail, kind, {
      orders,
      user: session.user.name,
      company: session.company.name,
    }),
  );
  const [to, setTo] = useState(draft.to);
  const [body, setBody] = useState(draft.body);
  const [copied, setCopied] = useState<"" | "done" | "failed">("");
  const [tried, setTried] = useState(false);
  const toInvalid = to.trim().length < 2 || to.trim().length > 120;
  const bodyInvalid = body.trim().length < 8 || body.trim().length > 4000;
  const hold = useMutation({
    mutationFn: (request: HoldRequest) =>
      api<UploadResult>(
        `/invoices/${encodeURIComponent(inv.id)}/hold`,
        mutation(session.csrf, request),
      ),
    onSuccess: async () => {
      onClose();
      notify(`Marked as sent · ${invoiceName(detail)} is on hold`);
      await onChanged();
    },
  });

  async function copy() {
    try {
      await navigator.clipboard.writeText(body);
      setCopied("done");
    } catch {
      setCopied("failed");
    }
  }

  return (
    <Drawer
      open
      onOpenChange={(open) => !open && onClose()}
      busy={hold.isPending}
      title={kind === "procurement" ? "Ask procurement" : "Request a correction"}
      description="Drafted from the checks. Edit anything before you send it."
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          setTried(true);
          if (toInvalid || bodyInvalid) return;
          hold.mutate({
            expected_revision: inv.revision,
            to: to.trim(),
            message: body.trim(),
          });
        }}
      >
        <div className="tm-drawer-b">
          <div className="tm-field">
            <label htmlFor="tm-draft-to">To</label>
            <input
              id="tm-draft-to"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              aria-invalid={tried && toInvalid}
              autoComplete="off"
            />
          </div>
          <div className="tm-diff">
            <span>About</span>
            <strong className="tm-mono" style={{ fontSize: 12.5 }}>
              {draft.about}
            </strong>
          </div>
          <div className="tm-field">
            <label htmlFor="tm-draft-body">Message · drafted from the checks</label>
            <textarea
              id="tm-draft-body"
              style={{ minHeight: 232 }}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              aria-invalid={tried && bodyInvalid}
              aria-describedby="tm-draft-hint"
            />
            {tried && (toInvalid || bodyInvalid) && (
              <span className="tm-bad-text" style={{ fontSize: 12 }} role="alert">
                {toInvalid
                  ? "Say who the message goes to."
                  : "Write a message between 8 and 4,000 characters."}
              </span>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <button
              type="button"
              className="tm-btn tm-btn-line tm-btn-sm"
              onClick={() => void copy()}
            >
              <IconCopy size={14} />
              Copy message
            </button>
            <span className="tm-hint" role="status">
              {copied === "done"
                ? "Copied to the clipboard"
                : copied === "failed"
                  ? "Select the text to copy it"
                  : ""}
            </span>
          </div>
          <p id="tm-draft-hint" className="tm-hint">
            Tickmark doesn’t send email. Send this from your own inbox, then
            mark it as sent: the invoice waits On hold and the message is kept
            in its history.
          </p>
          <ErrorNotice error={hold.error} />
        </div>
        <div className="tm-drawer-f">
          <button
            type="button"
            className="tm-btn tm-btn-line"
            onClick={onClose}
            disabled={hold.isPending}
          >
            Cancel
          </button>
          <button type="submit" className="tm-btn tm-btn-primary" disabled={hold.isPending}>
            {hold.isPending ? "Saving…" : "Mark as sent"}
          </button>
        </div>
      </form>
    </Drawer>
  );
}

export const REJECT_REASONS = [
  "Not our order, or billed to the wrong company",
  "Amounts can’t be reconciled",
  "Already billed or already paid",
  "Supplier is not approved",
];

function defaultReason(code: string | null) {
  if (code === "duplicate") return 2;
  if (code === "totals" || code === "price" || code === "budget") return 1;
  if (code === "inactive" || code === "vendor") return 3;
  return 0;
}

export function RejectPanel({
  detail,
  onClose,
  onChanged,
}: {
  detail: Detail;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { session, notify } = useShell();
  const inv = detail.invoice;
  const [choice, setChoice] = useState(() => defaultReason(inv.reason_code));
  const reject = useMutation({
    mutationFn: (request: RejectRequest) =>
      api<UploadResult>(
        `/invoices/${encodeURIComponent(inv.id)}/reject`,
        mutation(session.csrf, request),
      ),
    onSuccess: async () => {
      onClose();
      notify(`Rejected · ${invoiceName(detail)} is closed`);
      await onChanged();
    },
  });
  const vendor = supplierName(detail) ?? "the supplier";
  return (
    <Drawer
      open
      onOpenChange={(open) => !open && onClose()}
      busy={reject.isPending}
      title="Reject invoice"
      description="Closes the invoice and records why."
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          reject.mutate({
            expected_revision: inv.revision,
            reason: REJECT_REASONS[choice],
          });
        }}
      >
        <div className="tm-drawer-b">
          <p style={{ fontSize: 13.5, color: "var(--ink-2)" }}>
            Rejecting closes {invoiceName(detail)} from {vendor} and records the
            reason in its history. Nothing is reserved against any order.
          </p>
          <fieldset className="tm-options">
            <legend>Reason</legend>
            {REJECT_REASONS.map((label, index) => (
              <label className="tm-option" key={label}>
                <input
                  type="radio"
                  name="tm-reject"
                  checked={choice === index}
                  onChange={() => setChoice(index)}
                />
                <span className="tm-radio" aria-hidden="true" />
                <span style={{ fontSize: 13.5 }}>{label}</span>
              </label>
            ))}
          </fieldset>
          <ErrorNotice error={reject.error} />
        </div>
        <div className="tm-drawer-f">
          <button
            type="button"
            className="tm-btn tm-btn-line"
            onClick={onClose}
            disabled={reject.isPending}
          >
            Cancel
          </button>
          <button type="submit" className="tm-btn tm-btn-primary" disabled={reject.isPending}>
            {reject.isPending ? "Rejecting…" : "Reject invoice"}
          </button>
        </div>
      </form>
    </Drawer>
  );
}
