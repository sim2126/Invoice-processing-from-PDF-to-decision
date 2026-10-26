"use client";
import * as Tabs from "@radix-ui/react-tabs";
import Link from "next/link";
import type { Detail, InvoiceStatus, PurchaseOrder } from "@/lib/api";
import { cx, dayKey, dayLabel, isoDayKey, money, receivedLabel } from "@/lib/format";
import { plainRunError } from "@/lib/plain";
import { supplierName, type DisplayStep } from "@/lib/steps";
import { STATUS_TEXT } from "@/lib/status";
import { CITES, citeEvidence, type ActionKind, type CiteKey, type Verdict } from "@/lib/verdict";
import { IconExternal, StateIcon } from "../icons";
import { ErrorNotice, StatusPill } from "../ui";
import { ChecksList } from "./checks-list";
import { FieldsPanel, HistoryPanel, POPanel } from "./detail-tabs";

const ACTION_LABEL: Record<ActionKind, string> = {
  "view-po": "View purchase order",
  "ask-procurement": "Ask procurement",
  "choose-order": "Choose the order",
  "confirm-supplier": "Confirm the supplier",
  "request-correction": "Request a correction",
  "reply-received": "Reply received · check again",
  "open-original": "Open the original",
  reject: "Reject",
};

const VERDICT_ICON: Partial<Record<InvoiceStatus, string>> = {
  APPROVED: "passed",
  NEEDS_REVIEW: "review",
  BLOCKED: "blocked",
  ON_HOLD: "hold",
  REJECTED: "blocked",
};

export type Run = {
  checking: boolean;
  failed: boolean;
  steps: DisplayStep[];
  done: number;
  current: DisplayStep | null;
};

export function DecisionCard({
  detail,
  status,
  run,
  verdict,
  orders,
  focus,
  onCite,
  onAction,
  canAct,
  tab,
  onTab,
  onRetry,
  retrying,
  retryError,
  busyAction,
  actionError,
  live,
  now,
}: {
  detail: Detail;
  status: InvoiceStatus;
  run: Run;
  verdict: Verdict | null;
  orders: PurchaseOrder[];
  focus: string | null;
  onCite: (field: string) => void;
  onAction: (kind: ActionKind) => void;
  canAct: boolean;
  tab: string;
  onTab: (tab: string) => void;
  onRetry: () => void;
  retrying: boolean;
  retryError: unknown;
  /** An action that runs directly (no panel) and is in flight. */
  busyAction: ActionKind | null;
  actionError: unknown;
  live: boolean;
  now: number;
}) {
  const inv = detail.invoice;
  const x = detail.extraction;
  const decision =
    detail.decision && inv.decision_applicable ? detail.decision : null;
  const po = decision?.comparison.po_reference ?? inv.po_reference ?? x?.po_reference;
  const number =
    inv.reference ?? x?.invoice_number ?? (run.checking && !x ? "New invoice" : "No invoice number");
  const vendor = supplierName(detail);
  // While checking, nothing is claimed that the run has not established yet.
  const subline = [
    vendor ?? (run.checking ? "Supplier checking…" : "Supplier not found"),
    po ?? (run.checking ? "PO checking…" : "no PO"),
    `received ${receivedLabel(inv.created_at, now)}`,
    inv.due_date ? `due ${dayLabel(inv.due_date, now)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const checkedOn = decision
    ? isoDayKey(decision.created_at) === dayKey(new Date(now))
      ? "today"
      : dayLabel(decision.created_at, now)
    : "";
  const ready =
    (decision?.assistant as { status?: string } | undefined)?.status === "ready";
  const policy = decision?.policy_version ?? "AP-2026.1";
  const total = run.steps.length;
  const announcement = run.checking
    ? `Checking: ${run.current?.label ?? "getting started"}`
    : verdict
      ? `${verdict.title}. ${verdict.summary}`
      : run.failed
        ? "This document couldn’t be read."
        : "";

  return (
    <section className="tm-card tm-dec-card" aria-labelledby="tm-invoice-title">
      <div className="tm-card-h tm-dec-h">
        <div className="tm-stack-text" style={{ gap: 3 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <h1 id="tm-invoice-title" className="tm-inv-no">
              {number}
            </h1>
            <StatusPill status={status} />
          </div>
          <span className="tm-faint" style={{ fontSize: 12.5 }}>
            {subline}
          </span>
        </div>
        <div className="tm-amount">
          <strong>{money(inv.total ?? x?.total)}</strong>
          <span className="tm-faint" style={{ fontSize: 12 }}>
            {inv.currency ?? x?.currency ?? "USD"}
          </span>
        </div>
      </div>
      <p className="tm-sr" aria-live="polite">
        {announcement}
      </p>

      {run.checking && (
        <div className="tm-run">
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 12,
            }}
          >
            <span style={{ fontWeight: 550, display: "inline-flex", alignItems: "center", gap: 8 }}>
              <span className="tm-run-dot" aria-hidden="true" />
              Checking · {run.current?.label ?? "Getting started"}
            </span>
            <span className="tm-faint" style={{ fontSize: 12.5, whiteSpace: "nowrap" }}>
              Step {Math.min(run.done + 1, total)} of {total}
            </span>
          </div>
          <div
            className="tm-progress"
            role="progressbar"
            aria-label="Checks completed"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={run.done}
            aria-valuetext={`${run.done} of ${total} steps done`}
          >
            <b style={{ width: `${(run.done / total) * 100}%` }} />
          </div>
        </div>
      )}

      {run.failed && (
        <div className="tm-verdict">
          <h2 className="tm-verdict-title" style={{ color: "var(--bad)" }}>
            <StateIcon state="blocked" size={22} announce={false} />
            <span>Couldn’t read this document</span>
          </h2>
          <p className="tm-verdict-summary">{plainRunError(detail.run.error)}</p>
          <div className="tm-verdict-foot">
            <span className="tm-faint" style={{ fontSize: 12.5 }}>
              Next ·{" "}
              <strong style={{ color: "var(--ink-2)", fontWeight: 550 }}>
                Read it again, or ask the supplier for a clearer copy
              </strong>
            </span>
            {canAct && (
              <button
                className="tm-btn tm-btn-primary tm-btn-sm"
                onClick={onRetry}
                disabled={retrying}
              >
                {retrying ? "Starting…" : "Read it again"}
              </button>
            )}
          </div>
          <ErrorNotice error={retryError} />
        </div>
      )}

      {verdict && (
        <div className="tm-verdict">
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 12,
            }}
          >
            <h2 className="tm-verdict-title" style={{ color: STATUS_TEXT[status] }}>
              <StateIcon
                state={VERDICT_ICON[status] ?? "review"}
                size={22}
                announce={false}
                animate={live}
              />
              <span>{verdict.title}</span>
            </h2>
            {checkedOn && (
              <span className="tm-faint" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
                Checked {checkedOn}
              </span>
            )}
          </div>
          <p className="tm-verdict-summary">{verdict.summary}</p>
          {verdict.why.length > 0 && (
            <ul className="tm-why" aria-label="Why">
              {verdict.why.map((why, index) => (
                <li key={index}>
                  <span>
                    {why.text}
                    {why.cites.map((key) => (
                      <Cite key={key} cite={key} detail={detail} focus={focus} onCite={onCite} />
                    ))}
                    {why.link && (
                      <a
                        className="tm-cite"
                        href={why.link.href}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {why.link.label}
                        <IconExternal size={11} />
                        <span className="tm-sr"> (opens in a new tab)</span>
                      </a>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="tm-verdict-foot">
            <span className="tm-faint" style={{ fontSize: 12.5 }}>
              Next ·{" "}
              <strong style={{ color: "var(--ink-2)", fontWeight: 550 }}>{verdict.next}</strong>
            </span>
            <div className="tm-actions">
              {verdict.actions.map((kind, index) => (
                <Action
                  key={kind}
                  kind={kind}
                  primary={index === 0 && kind !== "reject"}
                  po={po ?? null}
                  original={decision?.duplicate_id ?? null}
                  canAct={canAct}
                  busy={busyAction}
                  onAction={onAction}
                />
              ))}
            </div>
          </div>
          <ErrorNotice error={actionError} />
          <p className="tm-faint" style={{ fontSize: 11.5 }}>
            {inv.source === "history"
              ? `Decided by policy ${policy} from the checks below.`
              : `AI read the page${ready ? " and wrote the explanation" : ""}. The decision and every amount come from policy ${policy}.`}
          </p>
        </div>
      )}

      <Tabs.Root className="tm-tabs-root" value={tab} onValueChange={onTab}>
        <Tabs.List className="tm-tabs" aria-label="Invoice details">
          <Tabs.Trigger className="tm-tab" value="checks">
            {run.checking ? "Checking" : "Checks"}
          </Tabs.Trigger>
          <Tabs.Trigger className="tm-tab" value="fields">
            Fields
          </Tabs.Trigger>
          <Tabs.Trigger className="tm-tab" value="po">
            PO match
          </Tabs.Trigger>
          <Tabs.Trigger className="tm-tab" value="history">
            History
          </Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content className="tm-card-b" value="checks">
          <ChecksList steps={run.steps} detail={detail} live={live} />
        </Tabs.Content>
        <Tabs.Content className="tm-card-b" value="fields">
          <FieldsPanel detail={detail} focus={focus} onCite={onCite} />
        </Tabs.Content>
        <Tabs.Content className="tm-card-b" value="po">
          <POPanel detail={detail} orders={orders} status={status} />
        </Tabs.Content>
        <Tabs.Content className="tm-card-b" value="history">
          <HistoryPanel detail={detail} now={now} />
        </Tabs.Content>
      </Tabs.Root>
    </section>
  );
}

function Cite({
  cite,
  detail,
  focus,
  onCite,
}: {
  cite: CiteKey;
  detail: Detail;
  focus: string | null;
  onCite: (field: string) => void;
}) {
  const evidence = citeEvidence(detail.evidence, cite);
  if (!evidence) return null;
  const label = CITES[cite].label;
  return (
    <button
      type="button"
      className={cx(
        "tm-cite",
        focus === evidence.field && "is-on",
        evidence.status === "unverified" && "is-unverified",
      )}
      onClick={() => onCite(evidence.field)}
    >
      p{evidence.page} · {label}
      <span className="tm-sr">, show on the page</span>
    </button>
  );
}

function Action({
  kind,
  primary,
  po,
  original,
  canAct,
  busy,
  onAction,
}: {
  kind: ActionKind;
  primary: boolean;
  po: string | null;
  original: string | null;
  canAct: boolean;
  busy: ActionKind | null;
  onAction: (kind: ActionKind) => void;
}) {
  const className = cx(
    "tm-btn tm-btn-sm",
    primary && kind !== "view-po" && kind !== "open-original"
      ? "tm-btn-primary"
      : "tm-btn-line",
  );
  if (kind === "view-po")
    return (
      <Link
        className={className}
        href={po ? `/purchase-orders#${encodeURIComponent(po)}` : "/purchase-orders"}
      >
        {ACTION_LABEL[kind]}
      </Link>
    );
  if (kind === "open-original")
    return original ? (
      <Link className={className} href={`/invoices/${encodeURIComponent(original)}`}>
        {ACTION_LABEL[kind]}
      </Link>
    ) : null;
  if (!canAct) return null;
  return (
    <button
      type="button"
      className={className}
      disabled={busy !== null}
      onClick={() => onAction(kind)}
    >
      {busy === kind && kind === "reply-received" ? "Checking again…" : ACTION_LABEL[kind]}
    </button>
  );
}
