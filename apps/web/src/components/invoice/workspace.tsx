"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import {
  api,
  ApiError,
  mutation,
  type Detail,
  type InvoiceStatus,
  type UploadResult,
} from "@/lib/api";
import { useNow, useReducedMotion } from "@/lib/hooks";
import { keys, refreshWorkspace, useInvoices, usePurchaseOrders } from "@/lib/queries";
import { buildSteps, displaySteps, isFinal } from "@/lib/steps";
import { buildVerdict, type ActionKind } from "@/lib/verdict";
import { useShell } from "../shell-context";
import { Loading } from "../ui";
import { DecisionCard } from "./decision-card";
import { DocumentCard } from "./document-card";
import { ChoosePanel, ConfirmSupplierPanel, DraftPanel, RejectPanel } from "./panels";
import { useLiveDetail, useReveal } from "./use-live-run";

type PanelKind = "choose" | "confirm-supplier" | "procurement" | "supplier" | "reject";

/** The evidence behind each reason, outlined on the page once decided. */
const FLAG_FIELD: Record<string, string> = {
  totals: "total",
  budget: "total",
  price: "lines.0.unit_price",
  duplicate: "invoice_number",
  closed: "po_reference",
  inactive: "vendor_identifier",
  vendor: "vendor_identifier",
  item: "lines.0.sku",
};

export function InvoiceWorkspace({ id }: { id: string }) {
  const query = useLiveDetail(id);
  if (query.isPending)
    return (
      <div className="tm-view">
        <Loading label="Opening the invoice…" />
      </div>
    );
  if (!query.data) {
    const missing = query.error instanceof ApiError && query.error.status === 404;
    return (
      <div className="tm-view">
        <div className="tm-full">
          <div>
            <h1>{missing ? "Invoice not found" : "This invoice didn’t load"}</h1>
            <p className="tm-muted">
              {missing
                ? "It may belong to another workspace, or the link is incomplete."
                : query.error?.message}
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <Link className="tm-btn tm-btn-line" href="/invoices">
                All invoices
              </Link>
              {!missing && (
                <button className="tm-btn tm-btn-primary" onClick={() => query.refetch()}>
                  Try again
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }
  return <Workspace detail={query.data} />;
}

function Workspace({ detail }: { detail: Detail }) {
  const { session, notify } = useShell();
  const client = useQueryClient();
  const now = useNow();
  const reduced = useReducedMotion();
  const invoices = useInvoices();
  const orders = usePurchaseOrders();
  const inv = detail.invoice;

  const built = buildSteps(detail, now, { aiEnabled: session.company.ai_assistance });
  const reveal = useReveal(built.steps, detail.run.id, inv.status === "CHECKING", reduced);
  const view = displaySteps(built.steps, { active: built.active, shown: reveal.shown });
  const checking = built.active || view.revealing;
  const failed = built.failed && !checking;
  const status: InvoiceStatus = checking ? "CHECKING" : inv.status;
  const verdict =
    checking || failed
      ? null
      : buildVerdict(detail, {
          invoices: invoices.data?.invoices ?? [],
          orders: orders.data ?? [],
          now,
        });

  const [focus, setFocus] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [tab, setTab] = useState("checks");
  const [panel, setPanel] = useState<{ kind: PanelKind; key: number } | null>(null);

  const showEvidence = (field: string) => {
    const evidence = detail.evidence.find((e) => e.field === field);
    setFocus(field);
    if (evidence?.page) setPage(evidence.page);
  };
  const openPanel = (kind: PanelKind) =>
    setPanel((current) => ({ kind, key: (current?.key ?? 0) + 1 }));
  const closePanel = () => setPanel(null);

  /** A new run started (order chosen, AI asked, retry): watch it live. */
  const started = async () => {
    await client.invalidateQueries({ queryKey: keys.invoice(inv.id) });
    void refreshWorkspace(client);
    setFocus(null);
    setTab("checks");
    reveal.goLive();
  };
  /** Workflow changed without a new run (on hold, rejected). */
  const changed = async () => {
    await client.invalidateQueries({ queryKey: keys.invoice(inv.id) });
    await refreshWorkspace(client);
  };

  const retry = useMutation({
    mutationFn: () =>
      api<UploadResult>(
        `/invoices/${encodeURIComponent(inv.id)}/retry`,
        mutation(session.csrf, { expected_revision: inv.revision }),
      ),
    onSuccess: async () => {
      notify("Reading the document again");
      await started();
    },
  });
  // On hold: the reply arrived, so clear the hold and run every check again.
  const reply = useMutation({
    mutationFn: () =>
      api<UploadResult>(
        `/invoices/${encodeURIComponent(inv.id)}/review`,
        mutation(session.csrf, {
          expected_revision: inv.revision,
          reason: `Reply received from ${inv.workflow_to ?? "the supplier"}; checking again.`,
          corrections: [],
        }),
      ),
    onSuccess: async () => {
      notify("Reply received · every check runs again");
      await started();
    },
  });
  const onAction = (kind: ActionKind) => {
    if (kind === "choose-order") openPanel("choose");
    else if (kind === "confirm-supplier") openPanel("confirm-supplier");
    else if (kind === "ask-procurement") openPanel("procurement");
    else if (kind === "request-correction") openPanel("supplier");
    else if (kind === "reject") openPanel("reject");
    else if (kind === "reply-received") reply.mutate();
  };

  const readStep = built.steps.find((s) => s.key === "read");
  const extractStep = built.steps.find((s) => s.key === "extract");
  const reading =
    built.active &&
    (!readStep || !isFinal(readStep.state) || !extractStep || !isFinal(extractStep.state));
  const pagesReady =
    !!detail.extraction ||
    detail.events.some((e) => e.stage === "read" && e.state === "passed") ||
    (!built.active && !built.failed);
  const ordersList = orders.data ?? [];

  return (
    <div className="tm-view">
      {/* Decision first in reading order; on wide screens the document sits left. */}
      <div className="tm-detail">
        <DecisionCard
          detail={detail}
          status={status}
          run={{
            checking,
            failed,
            steps: view.steps,
            done: view.done,
            current: view.current,
          }}
          verdict={verdict}
          orders={ordersList}
          focus={focus}
          onCite={showEvidence}
          onAction={onAction}
          canAct={session.user.role !== "viewer"}
          tab={tab}
          onTab={setTab}
          onRetry={() => retry.mutate()}
          retrying={retry.isPending}
          retryError={retry.error}
          busyAction={reply.isPending ? "reply-received" : null}
          actionError={reply.error}
          live={!!reveal.shown}
          now={now}
        />
        <DocumentCard
          detail={detail}
          page={Math.min(page, Math.max(1, detail.pages))}
          onPage={(next) => {
            setPage(next);
            setFocus(null);
          }}
          zoom={zoom}
          onZoom={setZoom}
          focus={focus}
          flag={verdict ? (FLAG_FIELD[inv.reason_code ?? ""] ?? null) : null}
          reading={reading}
          pagesReady={pagesReady}
          arriving={!!reveal.shown && !reduced}
        />
      </div>
      {panel?.kind === "choose" && (
        <ChoosePanel
          key={panel.key}
          detail={detail}
          orders={ordersList}
          onClose={closePanel}
          onStarted={started}
        />
      )}
      {panel?.kind === "confirm-supplier" && (
        <ConfirmSupplierPanel
          key={panel.key}
          detail={detail}
          onClose={closePanel}
          onStarted={started}
        />
      )}
      {(panel?.kind === "procurement" || panel?.kind === "supplier") && (
        <DraftPanel
          key={panel.key}
          kind={panel.kind}
          detail={detail}
          orders={ordersList}
          onClose={closePanel}
          onChanged={changed}
        />
      )}
      {panel?.kind === "reject" && (
        <RejectPanel
          key={panel.key}
          detail={detail}
          onClose={closePanel}
          onChanged={changed}
        />
      )}
    </div>
  );
}
