"use client";
import { Button } from "@/components/ui/button";
import {
  amount,
  api,
  fieldValue,
  mutation,
  stamp,
  type Detail,
  type Evidence,
  type Session,
  type UploadResult,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { ValidationChecks } from "./validation-checks";
import * as Tabs from "@radix-ui/react-tabs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Copy,
  FileCheck2,
  FileSearch,
  FileText,
  History,
  LoaderCircle,
  Maximize2,
  Minus,
  Plus,
  RotateCcw,
  ScanLine,
  ShieldCheck,
  WifiOff,
  X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  Badge,
  ErrorNotice,
  Policy,
  StateIcon,
  status,
  statusLabels,
} from "./common";
import { ReviewDialog } from "./review-dialog";

export function InvoiceWorkspace({
  id,
  session,
}: {
  id: string;
  session: Session;
}) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["invoice", id],
    queryFn: () => api<Detail>(`/invoices/${id}`),
    refetchInterval: (q) =>
      ["RUNNING", "QUEUED"].includes(q.state.data?.run.state || "")
        ? 3000
        : false,
  });
  const [disconnected, setDisconnected] = useState(false);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(100);
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [mobilePane, setMobilePane] = useState("review");
  const [reviewOpen, setReviewOpen] = useState(false);
  const active =
    query.data && ["QUEUED", "RUNNING"].includes(query.data.run.state);
  useEffect(() => {
    if (!active) return;
    const source = new EventSource(`/api/invoices/${id}/events`);
    source.onopen = () => setDisconnected(false);
    source.onerror = () => setDisconnected(true);
    source.addEventListener("progress", () => {
      void client.invalidateQueries({ queryKey: ["invoice", id] });
    });
    source.addEventListener("session_expired", () => {
      source.close();
      void client.invalidateQueries({ queryKey: ["session"] });
    });
    return () => source.close();
  }, [active, client, id]);
  const retry = useMutation({
    mutationFn: () =>
      api<UploadResult>(
        `/invoices/${id}/retry`,
        mutation(session.csrf, {
          expected_revision: query.data?.invoice.revision,
        }),
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: ["invoice", id] }),
  });
  if (query.isPending)
    return (
      <div className="loading-screen">
        <LoaderCircle className="spin" />
        Opening invoice workspace…
      </div>
    );
  if (query.error || !query.data)
    return (
      <div className="workspace-page">
        <Link className="back-link" href="/">
          <ArrowLeft size={16} />
          Invoices
        </Link>
        <ErrorNotice error={query.error} />
        <Button variant="outline" onClick={() => query.refetch()}>
          Try again
        </Button>
      </div>
    );
  const data = query.data,
    inv = data.invoice,
    decision = data.decision,
    currentStatus = status(inv);
  const reveal = (e: Evidence) => {
    setEvidence(e);
    if (e.page) setPage(e.page);
    if (window.matchMedia("(max-width: 700px)").matches) setZoom(200);
    setMobilePane("source");
  };
  return (
    <div className="workspace-page">
      <Link className="back-link" href="/">
        <ArrowLeft size={15} />
        Back to work queue
      </Link>
      <div className="invoice-heading">
        <div>
          <div className="invoice-title">
            <h1>{inv.reference || inv.filename}</h1>
            <Badge state={currentStatus} />
          </div>
          <p>
            {inv.vendor || "Invoice details are being read"}
            <span>·</span>Received {stamp(inv.created_at)}
            <span>·</span>Revision {inv.revision}
          </p>
        </div>
        <div className="invoice-heading-amount">
          <strong>{amount(inv.total, inv.currency || "USD")}</strong>
          <span>{inv.currency || "Currency pending"}</span>
        </div>
      </div>
      <div className="workspace-tools">
        <div>
          <span className="tiny-dot" />
          {active ? "Checks are running" : "Saved to this workspace"}
          {active && disconnected && (
            <span className="connection-note">
              <WifiOff size={13} />
              Live connection interrupted · status polling is active
            </span>
          )}
        </div>
        <a className="text-button" href={`/api/invoices/${id}/export`} download>
          <ArrowDownToLine size={15} />
          Export decision
        </a>
      </div>
      <div
        className="mobile-pane-tabs"
        role="group"
        aria-label="Workspace view"
      >
        <button
          aria-pressed={mobilePane === "review"}
          onClick={() => setMobilePane("review")}
        >
          <FileCheck2 size={16} />
          Review
        </button>
        <button
          aria-pressed={mobilePane === "source"}
          onClick={() => {
            setZoom(200);
            setMobilePane("source");
          }}
        >
          <FileText size={16} />
          Source document
        </button>
      </div>
      <div className="workspace-grid">
        <section
          className={cn(
            "document-pane",
            mobilePane !== "source" && "mobile-hidden",
          )}
          aria-label="Source document"
        >
          <div className="pane-heading">
            <h2>
              <FileText size={17} />
              Source document
            </h2>
            <a
              href={`/api/invoices/${id}/source`}
              className="icon-button"
              aria-label="Download original PDF"
            >
              <ArrowDownToLine size={16} />
            </a>
          </div>
          <div className="document-toolbar">
            <div>
              <button
                className="icon-button"
                aria-label="Previous page"
                disabled={page <= 1}
                onClick={() => {
                  setPage(page - 1);
                  setEvidence(null);
                }}
              >
                <ChevronLeft size={17} />
              </button>
              <span>
                Page <strong>{page}</strong> of {data.pages}
              </span>
              <button
                className="icon-button"
                aria-label="Next page"
                disabled={page >= data.pages}
                onClick={() => {
                  setPage(page + 1);
                  setEvidence(null);
                }}
              >
                <ChevronRight size={17} />
              </button>
            </div>
            <div>
              <button
                className="icon-button"
                aria-label="Zoom out"
                disabled={zoom <= 75}
                onClick={() => setZoom(zoom - 25)}
              >
                <Minus size={15} />
              </button>
              <span>{zoom}%</span>
              <button
                className="icon-button"
                aria-label="Zoom in"
                disabled={zoom >= 200}
                onClick={() => setZoom(zoom + 25)}
              >
                <Plus size={15} />
              </button>
              <button
                className="icon-button"
                aria-label="Fit document"
                onClick={() => setZoom(100)}
              >
                <Maximize2 size={14} />
              </button>
            </div>
          </div>
          {evidence && (
            <div className="evidence-banner">
              <ScanLine size={15} />
              <span>
                {evidence.field.replaceAll("_", " ")} ·{" "}
                {evidence.bbox
                  ? "Source highlighted"
                  : "Cited page; no reliable highlight"}
              </span>
              <button
                className="icon-button"
                onClick={() => setEvidence(null)}
                aria-label="Clear evidence highlight"
              >
                <X size={14} />
              </button>
            </div>
          )}
          <div
            className="document-canvas"
            tabIndex={0}
            role="region"
            aria-label="Scrollable invoice page"
          >
            {data.events.some(
              (e) => e.stage === "read" && e.state === "passed",
            ) || data.extraction ? (
              <div className="document-page" style={{ width: `${zoom}%` }}>
                {/* Pages are rendered safely by the server; no embedded PDF script executes. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/invoices/${id}/pages/${page}`}
                  alt={`Invoice source, page ${page}. Extracted text and cited values are available in the fields tab.`}
                />
                {evidence?.bbox && evidence.page === page && (
                  <span
                    className="source-highlight"
                    style={{
                      left: `${evidence.bbox[0] * 100}%`,
                      top: `${evidence.bbox[1] * 100}%`,
                      width: `${(evidence.bbox[2] - evidence.bbox[0]) * 100}%`,
                      height: `${(evidence.bbox[3] - evidence.bbox[1]) * 100}%`,
                    }}
                  />
                )}
              </div>
            ) : (
              <div className="document-pending">
                <FileText size={38} />
                <strong>Preparing source pages</strong>
                <p>
                  The original PDF is saved. Readable pages appear when
                  processing starts.
                </p>
              </div>
            )}
          </div>
          <div className="document-caption">
            <ShieldCheck size={13} />
            Original document preserved · {inv.filename}
          </div>
        </section>
        <section
          className={cn(
            "review-pane",
            mobilePane !== "review" && "mobile-hidden",
          )}
          aria-label="Invoice review"
        >
          <div
            className={cn(
              "decision-banner",
              `decision-${currentStatus.toLowerCase()}`,
            )}
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <span className="decision-symbol">
              <StateIcon state={currentStatus} size={22} />
            </span>
            <div>
              <div className="decision-kicker">
                {currentStatus === "APPROVED"
                  ? "READY FOR THE NEXT STEP"
                  : currentStatus === "NEEDS_REVIEW"
                    ? "YOUR ATTENTION IS NEEDED"
                    : currentStatus === "BLOCKED"
                      ? "COMMITMENT WITHHELD"
                      : "DOCUMENT PROCESSING"}
              </div>
              <h2>{statusLabels[currentStatus]}</h2>
              <p>{inv.summary}</p>
              {decision && inv.decision_applicable && (
                <span className="action-owner">
                  Next owner <strong>{decision.owner}</strong>
                </span>
              )}
            </div>
          </div>
          {data.run.state === "FAILED" && (
            <div className="review-action-block">
              <p>
                Source and history are preserved. This is an execution failure;
                no new commercial decision was made.
              </p>
              <Button onClick={() => retry.mutate()} disabled={retry.isPending}>
                <RotateCcw size={16} />
                Retry processing
              </Button>
              <ErrorNotice error={retry.error} />
            </div>
          )}
          {decision && !inv.decision_applicable && (
            <div className="revision-notice">
              Previous decision: {statusLabels[decision.outcome]} on revision{" "}
              {decision.revision}. New checks are required for revision{" "}
              {inv.revision}.
            </div>
          )}
          {data.extraction && !active && inv.outcome !== "APPROVED" && (
            <div className="review-bottom">
              <div>
                <strong>Resolve with evidence</strong>
                <span>
                  Record a correction or confirm a match. All checks run again.
                </span>
              </div>
              <Button onClick={() => setReviewOpen(true)}>
                <FileSearch size={16} />
                Review & resolve
                <ArrowRight size={15} />
              </Button>
            </div>
          )}
          <RunTimeline data={data} />
          <Tabs.Root defaultValue="checks" className="review-tabs">
            <Tabs.List className="detail-tabs" aria-label="Invoice details">
              <Tabs.Trigger value="checks">
                Checks{decision && <span>{decision.checks.length}</span>}
              </Tabs.Trigger>
              <Tabs.Trigger value="fields">Fields</Tabs.Trigger>
              <Tabs.Trigger value="po">PO comparison</Tabs.Trigger>
              <Tabs.Trigger value="history">History</Tabs.Trigger>
            </Tabs.List>
            <Tabs.Content value="checks" className="tab-content">
              <div className="checks-heading">
                <h3>Validation checks</h3>
                <Policy>
                  <button className="text-button">
                    AP-2026.1
                    <ArrowUpRight size={12} />
                  </button>
                </Policy>
              </div>
              {decision ? (
                <ValidationChecks checks={decision.checks} />
              ) : (
                <div className="checks-pending">
                  <FileSearch size={25} />
                  <p>
                    Checks appear here as the document is read and evaluated.
                  </p>
                </div>
              )}
              {decision?.duplicate_id && (
                <Link
                  className="duplicate-link"
                  href={`/invoices/${decision.duplicate_id}`}
                >
                  <Copy size={15} />
                  View the original invoice
                  <ArrowUpRight size={14} />
                </Link>
              )}
            </Tabs.Content>
            <Tabs.Content value="fields" className="tab-content">
              <div className="checks-heading">
                <h3>Extracted fields</h3>
                <span className="muted">Select evidence to view source</span>
              </div>
              {data.extraction ? (
                <>
                  <div className="field-list">
                    {[
                      "vendor_name",
                      "vendor_identifier",
                      "invoice_number",
                      "invoice_date",
                      "due_date",
                      "po_reference",
                      "currency",
                      "subtotal",
                      "header_discount",
                      "shipping",
                      "tax",
                      "tax_rate",
                      "total",
                    ].map((field) => (
                      <Field
                        key={field}
                        field={field}
                        value={fieldValue(data.extraction, field)}
                        evidence={data.evidence.find((e) => e.field === field)}
                        reveal={reveal}
                      />
                    ))}
                  </div>
                  {data.extraction.lines.map((line, index) => (
                    <div className="line-fields" key={index}>
                      <h4>
                        Line {index + 1} · {line.description}
                      </h4>
                      {[
                        "sku",
                        "quantity",
                        "unit",
                        "unit_price",
                        "discount",
                        "total",
                      ].map((field) => (
                        <Field
                          key={field}
                          field={field}
                          value={String(line[field as keyof typeof line] ?? "")}
                          evidence={data.evidence.find(
                            (e) => e.field === `lines.${index}.${field}`,
                          )}
                          reveal={reveal}
                        />
                      ))}
                    </div>
                  ))}
                </>
              ) : (
                <p className="muted">
                  No complete extraction is available yet.
                </p>
              )}
            </Tabs.Content>
            <Tabs.Content value="po" className="tab-content">
              <POComparison data={data} />
            </Tabs.Content>
            <Tabs.Content value="history" className="tab-content">
              <div className="checks-heading">
                <h3>Audit history</h3>
                <History size={16} />
              </div>
              <p className="audit-note">
                Actor names identify demo sessions, not verified people. Earlier
                decisions stay immutable.
              </p>
              <div className="audit-list">
                {data.audit.map((a) => (
                  <article key={a.id}>
                    <span className="audit-dot" />
                    <div>
                      <strong>
                        {a.action === "REVIEW"
                          ? "Review changes recorded"
                          : a.action === "DECISION"
                            ? "Decision recorded"
                            : a.action === "RETRY"
                              ? "Processing retried"
                              : "Invoice received"}
                      </strong>
                      <small>
                        {stamp(a.at)} · {a.actor} · Revision {a.revision}
                      </small>
                      <p>{a.reason}</p>
                      {a.action === "REVIEW" && (
                        <div className="diff-list">
                          {Object.keys(a.after).map((field) => (
                            <div key={field}>
                              <span>{field.replaceAll("_", " ")}</span>
                              <del>
                                {String(a.before[field] ?? "Not selected")}
                              </del>
                              <ArrowRight size={13} />
                              <ins>{String(a.after[field])}</ins>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </article>
                ))}
              </div>
              <h3 className="history-title">Decision history</h3>
              {data.history.map((d) => (
                <details className="historical-decision" key={d.id}>
                  <summary>
                    <Badge state={d.outcome} />
                    Revision {d.revision}
                    <ChevronDown size={13} />
                  </summary>
                  <p>{d.summary}</p>
                  <small>
                    {stamp(d.created_at)} · {d.policy_version}
                  </small>
                  <ul>
                    {d.checks
                      .filter((c) => c.state !== "passed")
                      .map((c, i) => (
                        <li key={i}>{c.message}</li>
                      ))}
                  </ul>
                </details>
              ))}
            </Tabs.Content>
          </Tabs.Root>
          {inv.outcome === "APPROVED" && (
            <div className="resolved-state">
              <CheckCheck size={17} />
              <span>
                {inv.human_touched
                  ? "Resolved through review. Your changes and the new decision are saved in history."
                  : "One accepted commitment recorded. Re-uploading this file will return this invoice."}
              </span>
            </div>
          )}
        </section>
      </div>
      <footer className="workspace-footer">
        <ShieldCheck size={14} />
        Evidence informs the review. Policy determines the decision.
        <span>Two-way matching · No payment executed</span>
      </footer>
      <ReviewDialog
        open={reviewOpen}
        setOpen={setReviewOpen}
        data={data}
        session={session}
      />
    </div>
  );
}

export function Field({
  field,
  value,
  evidence,
  reveal,
}: {
  field: string;
  value: string;
  evidence?: Evidence;
  reveal: (e: Evidence) => void;
}) {
  return (
    <div className="field-row">
      <span>{field.replaceAll("_", " ")}</span>
      <strong>{value || "Not stated"}</strong>
      {evidence ? (
        <button
          className={cn(
            "evidence-link",
            evidence.status === "unverified" && "unverified",
          )}
          onClick={() => reveal(evidence)}
        >
          <ScanLine size={12} />
          {evidence.label}
          <ArrowUpRight size={11} />
        </button>
      ) : (
        <small>—</small>
      )}
    </div>
  );
}

export function RunTimeline({ data }: { data: Detail }) {
  const stages = [
    ["intake", "Received"],
    ["read", "Read document"],
    ["extract", "Extract fields"],
    ["checks", "Run checks"],
    ["decision", "Decision"],
  ];
  const events = data.events.filter((e) => e.run_id === data.run.id);
  return (
    <details
      className="run-timeline"
      open={["QUEUED", "RUNNING"].includes(data.run.state) || undefined}
    >
      <summary>
        <span>
          <span
            className={cn(
              "tiny-dot",
              ["QUEUED", "RUNNING"].includes(data.run.state) && "pulse",
            )}
          />
          Live run
        </span>
        <span>
          {data.run.state === "COMPLETED"
            ? "Completed"
            : data.run.state === "FAILED"
              ? "Interrupted"
              : "In progress"}{" "}
          · Attempt {data.run.attempt}
          <ChevronDown size={14} />
        </span>
      </summary>
      <div className="run-stages">
        {stages.map(([key, label]) => {
          const latest = events
            .filter(
              (e) =>
                e.stage === key ||
                (key === "intake" && ["retry", "review"].includes(e.stage)),
            )
            .at(-1);
          return (
            <div
              key={key}
              className={cn("run-stage", latest && `stage-${latest.state}`)}
            >
              {latest ? (
                <StateIcon state={latest.state} size={16} />
              ) : (
                <Circle size={16} />
              )}
              <span>{label}</span>
            </div>
          );
        })}
      </div>
      <ol className="run-events">
        {events.map((event) => (
          <li key={event.id}>
            <time>
              {new Date(event.at).toLocaleTimeString("en-US", {
                hour12: false,
              })}
            </time>
            <span>{event.message}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}

export function POComparison({ data }: { data: Detail }) {
  const p = data.decision?.comparison;
  if (!p?.po_reference)
    return (
      <div className="checks-pending">
        <FileSearch size={25} />
        <h3>Purchase order not confirmed</h3>
        <p>
          {data.candidates.orders.length} supported candidates. Select an order
          in Review & resolve to run the comparison.
        </p>
      </div>
    );
  return (
    <>
      <div className="checks-heading">
        <h3>{p.po_reference}</h3>
        <span className="po-tag">Gross USD basis</span>
      </div>
      <div className="po-balance">
        <div>
          <span>Approved ceiling</span>
          <strong>{amount(p.ceiling)}</strong>
        </div>
        <div>
          <span>Previously committed</span>
          <strong>{amount(p.committed_before)}</strong>
        </div>
        <div className="po-remaining">
          <span>Available before invoice</span>
          <strong>{amount(p.remaining_before)}</strong>
        </div>
        <div>
          <span>This invoice</span>
          <strong>{amount(data.invoice.total)}</strong>
        </div>
        <div>
          <span>Remaining after decision</span>
          <strong>{amount(p.remaining_after)}</strong>
        </div>
        {p.shortfall && p.shortfall !== "0.00" && (
          <div className="po-shortfall">
            <span>Shortfall · procurement action</span>
            <strong>{amount(p.shortfall)}</strong>
          </div>
        )}
      </div>
      <p className="audit-note">
        Previously paid seed invoices are included once in accepted commitments.
        Review and blocked invoices consume no amount.
      </p>
      {p.lines?.map((line, index) => (
        <div className="po-line" key={index}>
          <strong>
            {line.sku} · {line.description}
          </strong>
          <div>
            <span>Invoice quantity</span>
            <span>
              {line.invoice_quantity} {line.unit}
            </span>
          </div>
          <div>
            <span>Unit price · Invoice / PO</span>
            <span>
              {amount(line.invoice_price)} / {amount(line.po_price)}
            </span>
          </div>
        </div>
      ))}
      {p.normalized && (
        <div className="normalized">
          <h4>Normalized amounts</h4>
          <span>Net {amount(p.normalized.net)}</span>
          <span>Tax {amount(p.normalized.tax)}</span>
          <strong>Gross {amount(p.normalized.gross)}</strong>
        </div>
      )}
    </>
  );
}
