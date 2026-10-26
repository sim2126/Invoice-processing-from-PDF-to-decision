import type {
  Assistance,
  Check,
  CheckGroup,
  Detail,
  InvoiceSource,
  RunEvent,
} from "./api";
import { moment, money } from "./format";
import { lineFacts, linesStepText } from "./lines";
import { plainCheck, plainRunError, plainText, type PlainContext } from "./plain";
import { groupOf, worstState } from "./status";

export type StepKey =
  | "received"
  | "read"
  | "extract"
  | "supplier"
  | "po"
  | "lines"
  | "totals"
  | "duplicate"
  | "budget"
  | "explain"
  | "decision";
export type StepState =
  | "passed"
  | "review"
  | "blocked"
  | "skipped"
  | "info"
  | "running"
  | "pending";
export type StepSection = "Read" | "Match" | "Check" | "Decide";
/** One individual rule check shown inside an expanded step. */
export type StepItem = { title: string; state: StepState; text: string };
export type Step = {
  key: StepKey;
  section: StepSection;
  label: string;
  state: StepState;
  detail: string;
  facts: { label: string; value: string }[];
  items: StepItem[];
};

/** Pipeline order: the AI explanation is written before the decision lands. */
export const PLAN: {
  key: StepKey;
  section: StepSection;
  label: string;
  group?: CheckGroup;
}[] = [
  { key: "received", section: "Read", label: "Received" },
  { key: "read", section: "Read", label: "Read the document" },
  { key: "extract", section: "Read", label: "Extract the fields", group: "document" },
  { key: "supplier", section: "Match", label: "Supplier is approved", group: "supplier" },
  { key: "po", section: "Match", label: "Purchase order", group: "po" },
  { key: "lines", section: "Match", label: "Lines match the order", group: "lines" },
  { key: "totals", section: "Check", label: "Totals add up", group: "totals" },
  { key: "duplicate", section: "Check", label: "Not a duplicate", group: "duplicate" },
  { key: "budget", section: "Check", label: "Within PO budget", group: "budget" },
  { key: "explain", section: "Decide", label: "Explanation" },
  { key: "decision", section: "Decide", label: "Decision" },
];

export function isFinal(state: StepState) {
  return state !== "running" && state !== "pending";
}

const CHANNEL: Record<InvoiceSource, string> = {
  upload: "Uploaded",
  inbox: "Emailed to the AP inbox",
  history: "Emailed to the AP inbox",
};

export const WAIT_SUPPLIER = "Waiting for the supplier to be confirmed";
export const WAIT_PO = "Waiting for a purchase order";

function fromEvent(state: string): StepState {
  if (state === "failed") return "blocked";
  if (state === "running" || state === "pending") return "running";
  if (state === "review" || state === "blocked" || state === "skipped") return state;
  return "passed";
}

/*
 * A dependent check that cannot run yet (no PO, no invoice number) reads as
 * "waiting" instead of a second warning: its cause is flagged in its own step
 * and the decision is unchanged.
 */
function dependency(message: string, hasNumber: boolean) {
  if (/^Select a supported purchase order/.test(message)) return WAIT_PO;
  if (/^Confirm vendor and invoice reference before checking duplicates/.test(message))
    return hasNumber
      ? "Can’t check until the supplier is confirmed"
      : "Can’t check without an invoice number";
  return null;
}

/** The approved supplier record matched to this invoice, if any. */
export function supplierRecord(detail: Detail) {
  const id = detail.invoice.vendor_id;
  return id ? (detail.candidates.vendors.find((v) => v.id === id) ?? null) : null;
}

/** The supplier's name: the approved record when matched, else as printed. */
export function supplierName(detail: Detail) {
  return (
    supplierRecord(detail)?.name ??
    detail.extraction?.vendor_name ??
    detail.invoice.vendor ??
    null
  );
}

export function buildSteps(
  detail: Detail,
  now: number,
  options: { aiEnabled?: boolean } = {},
) {
  const { invoice, run, evidence } = detail;
  const x = detail.extraction;
  const active = run.state === "QUEUED" || run.state === "RUNNING";
  const failed = run.state === "FAILED";
  const settled = !active && !failed;
  const decision =
    detail.decision && invoice.decision_applicable ? detail.decision : null;
  const latest = new Map<string, RunEvent>();
  for (const e of detail.events) if (e.run_id === run.id) latest.set(e.stage, e);
  const checks = decision?.checks ?? [];
  const cmp = decision?.comparison;
  const assistant = (decision?.assistant ?? {}) as Assistance;
  const printedPo = x?.po_reference ?? null;
  const record = supplierRecord(detail);
  const known = evidence.length > 0;
  const scanned = evidence.some((e) => e.method === "ocr");
  const pageWord = `${detail.pages} ${detail.pages === 1 ? "page" : "pages"}`;
  const facts = lineFacts(detail);
  const context: PlainContext = {
    printedPo,
    unit: facts?.unit ?? x?.lines[0]?.unit ?? null,
  };

  // Order-dependent checks can say nothing until the supplier is confirmed.
  const vendorCheck = checks.find((c) => c.code === "vendor");
  const supplierEvent = latest.get("check:supplier");
  const supplierUnconfirmed =
    (vendorCheck?.state ?? (supplierEvent ? fromEvent(supplierEvent.state) : null)) ===
    "review";
  const poConfirmed = decision
    ? !!cmp?.po_reference
    : latest.get("check:po")?.state === "passed";
  const waitForSupplier = (group: CheckGroup) =>
    group === "po" && printedPo
      ? `${printedPo} printed · waiting for the supplier to be confirmed`
      : WAIT_SUPPLIER;

  const itemFor = (check: Check): StepItem => {
    const group = groupOf(check);
    if (
      supplierUnconfirmed &&
      check.state === "review" &&
      (group === "po" || group === "budget")
    )
      return { title: check.title, state: "skipped", text: waitForSupplier(group) };
    const waiting =
      check.state === "review" ? dependency(check.message, !!x?.invoice_number) : null;
    return waiting
      ? { title: check.title, state: "skipped", text: waiting }
      : { title: check.title, state: check.state as StepState, text: plainCheck(check, context) };
  };
  const inGroup = (group: CheckGroup) =>
    checks.filter((c) => groupOf(c) === group).map(itemFor);

  const steps: Step[] = [];
  const push = (
    key: StepKey,
    state: StepState,
    detailText: string,
    stepFacts: Step["facts"] = [],
    items: StepItem[] = [],
  ) => {
    const plan = PLAN.find((p) => p.key === key)!;
    steps.push({
      key,
      section: plan.section,
      label: plan.label,
      state,
      detail: detailText,
      facts: stepFacts,
      items,
    });
  };

  push(
    "received",
    "passed",
    `${invoice.filename} · ${pageWord}${known ? (scanned ? " · scanned image" : " · PDF with text") : ""}`,
    [
      { label: "Channel", value: CHANNEL[invoice.source] ?? "Uploaded" },
      { label: "File check", value: "New file, not seen before" },
    ],
  );

  const readEvent = latest.get("read");
  const readState: StepState = readEvent
    ? fromEvent(readEvent.state)
    : settled
      ? "passed"
      : "pending";
  push(
    "read",
    readState,
    known
      ? scanned
        ? `Scanned ${detail.pages === 1 ? "page" : pageWord} · text recognised with OCR`
        : "Text layer found · no OCR needed"
      : readEvent && readState === "passed"
        ? plainText(readEvent.message)
        : `${pageWord} read`,
    [
      { label: "Pages", value: String(detail.pages) },
      ...(known
        ? [
            {
              label: "Method",
              value: scanned ? "Text recognised from the scan" : "Embedded text",
            },
          ]
        : []),
    ],
  );

  const extractEvent = latest.get("extract");
  const docEvent = latest.get("check:document");
  const docItems = inGroup("document");
  let extractState: StepState;
  if (extractEvent?.state === "running") extractState = "running";
  else if (docEvent) extractState = fromEvent(docEvent.state);
  else if (docItems.length)
    extractState = worstState(docItems.map((i) => i.state)) ?? "passed";
  else extractState = settled ? "passed" : "pending";
  const linked = evidence.filter((e) => e.status !== "unverified").length;
  const lineCount = x?.lines.length ?? 0;
  const docIssue =
    docItems.find((i) => i.state === "blocked") ??
    docItems.find((i) => i.state === "review");
  let extractDetail: string;
  if (extractState === "review" || extractState === "blocked")
    extractDetail =
      docIssue?.text ??
      (docEvent ? plainText(docEvent.message) : "Some fields need a closer look");
  else if (!decision)
    // Counts appear with the decision, so nothing on screen changes later.
    extractDetail = active
      ? "Fields read · each value is being linked to the page"
      : "Fields extracted";
  else if (known)
    extractDetail =
      linked === evidence.length
        ? `${linked} fields · ${lineCount} ${lineCount === 1 ? "line" : "lines"} · each value linked to the page`
        : `${linked} of ${evidence.length} fields linked to the page`;
  else extractDetail = "Fields extracted";
  push(
    "extract",
    extractState,
    extractDetail,
    known && decision
      ? [
          { label: "Linked to the page", value: `${linked} of ${evidence.length} values` },
          { label: "Lines", value: String(lineCount) },
          { label: "Rule", value: "Nothing is inferred" },
        ]
      : [],
    docItems,
  );

  const adjusted = [x?.header_discount, x?.shipping].some((v) => Number(v ?? 0) !== 0);
  const passedSummary = (group: CheckGroup): string | null => {
    switch (group) {
      case "supplier":
        return record ? `${record.name} · ${record.identifier}` : null;
      case "po": {
        if (!decision) return null;
        const po = checks.find((c) => c.code === "po" && c.state === "passed");
        const base = po ? plainText(po.message) : (cmp?.po_reference ?? null);
        if (!base) return null;
        const how = assistant.auto_matched
          ? "matched from a company document"
          : printedPo
            ? "printed on the invoice"
            : invoice.human_touched
              ? "confirmed by a reviewer"
              : null;
        return how ? `${base} · ${how}` : base;
      }
      case "lines":
        return decision && facts ? linesStepText(facts) : null;
      case "totals": {
        const n = cmp?.normalized;
        if (!n) return null;
        if (facts?.inclusive)
          return `Net ${money(n.net)} + ${facts.rate ? `${facts.rate}% ` : ""}tax ${money(n.tax)} = total ${money(x?.total ?? n.gross)} · prices include tax`;
        return `${adjusted ? "Net" : "Lines"} ${money(n.net)} + tax ${money(n.tax)} = total ${money(x?.total ?? n.gross)}`;
      }
      case "duplicate":
        return x?.invoice_number
          ? `No earlier ${x.invoice_number} from ${record?.name ?? x.vendor_name ?? "this supplier"}`
          : null;
      case "budget":
        if (!cmp?.remaining_before) return null;
        return decision?.outcome === "APPROVED" && cmp.remaining_after
          ? `${money(cmp.remaining_before)} left · ${money(cmp.remaining_after)} after this invoice`
          : `${money(cmp.remaining_before)} left on ${cmp.po_reference}`;
      default:
        return null;
    }
  };

  const assist = latest.get("assist");
  const aiPending =
    active &&
    options.aiEnabled !== false &&
    !(assist && (assist.state === "passed" || assist.state === "review"));

  for (const plan of PLAN) {
    if (!plan.group || plan.group === "document") continue;
    const group = plan.group;
    const event = latest.get(`check:${group}`);
    const items = inGroup(group);
    let state: StepState = event
      ? fromEvent(event.state)
      : items.length
        ? (worstState(items.map((i) => i.state)) ?? "passed")
        : "pending";
    let text = "";
    if (event && state === "review") {
      const waiting = dependency(event.message, !!x?.invoice_number);
      if (waiting && !items.some((i) => i.state === "review" || i.state === "blocked")) {
        state = "skipped";
        text = waiting;
      }
    }
    const dependent = group === "po" || group === "lines" || group === "budget";
    if (dependent && supplierUnconfirmed && isFinal(state) && state !== "blocked") {
      state = "skipped";
      text = waitForSupplier(group);
    } else if (
      group === "lines" &&
      !poConfirmed &&
      isFinal(state) &&
      state !== "review" &&
      state !== "blocked"
    ) {
      // Never "matches the order" without an order.
      state = "skipped";
      text = WAIT_PO;
    } else if (group === "po" && state === "review" && !printedPo && aiPending) {
      // The AI step may still settle the order from a company document.
      state = "running";
      text = "No PO printed · checking company documents";
    }
    if (!text) {
      const issue =
        items.find((i) => i.state === "blocked") ?? items.find((i) => i.state === "review");
      if (state === "review" || state === "blocked")
        text =
          issue?.text ??
          (event ? plainText(event.message, undefined, { ...context, state }) : "Needs a closer look");
      else if (state === "skipped")
        text =
          (event?.state === "skipped" ? plainText(event.message) : null) ??
          items.find((i) => i.state === "skipped")?.text ??
          "Not needed";
      else if (state === "passed")
        text =
          passedSummary(group) ??
          (event
            ? plainText(event.message, undefined, { ...context, state })
            : (items[0]?.text ?? ""));
    }
    push(plan.key, state, text, [], items);
  }

  let explainState: StepState = "pending";
  let explainDetail = "";
  const ready = "Plain-language summary · with sources";
  const unavailable = "Not available this time · the checks above still decide";
  if (assist?.state === "running") explainState = "running";
  else if (decision) {
    if (assistant.status === "ready") {
      explainState = "info";
      explainDetail = ready;
    } else {
      explainState = "skipped";
      explainDetail =
        assistant.status === "disabled"
          ? "Turned off for this workspace"
          : assistant.status === "unavailable"
            ? unavailable
            : "Not needed · decided from the checks";
    }
  } else if (assist) {
    explainState = assist.state === "passed" ? "info" : "skipped";
    explainDetail = assist.state === "passed" ? ready : unavailable;
  } else if (active && options.aiEnabled === false) {
    explainState = "skipped";
    explainDetail = "Turned off for this workspace";
  }
  push("explain", explainState, explainDetail);

  const decisionEvent = latest.get("decision");
  const outcome =
    decision?.outcome ??
    (decisionEvent
      ? decisionEvent.state === "passed"
        ? "APPROVED"
        : decisionEvent.state === "blocked"
          ? "BLOCKED"
          : "NEEDS_REVIEW"
      : null);
  const decisionState: StepState = decision
    ? outcome === "APPROVED"
      ? "passed"
      : outcome === "BLOCKED"
        ? "blocked"
        : "review"
    : decisionEvent
      ? fromEvent(decisionEvent.state)
      : "pending";
  const po = cmp?.po_reference ?? invoice.po_reference;
  push(
    "decision",
    decisionState,
    outcome === "APPROVED"
      ? `Approved · ${money(invoice.total)} reserved${po ? ` on ${po}` : ""}`
      : outcome === "BLOCKED"
        ? "Blocked · nothing reserved"
        : outcome
          ? "Needs review · nothing reserved yet"
          : "",
    [
      {
        label: "Policy",
        value: decision?.policy_version ?? String(detail.policy?.version ?? "AP-2026.1"),
      },
      { label: "Order of precedence", value: "Blocked › Review › Approved" },
      ...(decision ? [{ label: "Decided", value: moment(decision.created_at, now) }] : []),
    ],
  );

  if (failed) {
    // An interrupted run marks the first unfinished step; later ones never ran.
    const stuck = steps.find((s) => !isFinal(s.state));
    if (stuck) {
      stuck.state = "blocked";
      stuck.detail = plainRunError(run.error);
    }
  }
  return { steps, active, failed };
}

export type DisplayStep = Step & { display: StepState };

/**
 * Applies the visual reveal: a step shows its result only once revealed
 * (`shown` = null reveals everything). The first unrevealed step, and any
 * step the pipeline reports as running, show as running.
 */
export function displaySteps(
  steps: Step[],
  options: { active: boolean; shown: Set<StepKey> | null },
) {
  const visible = (s: Step) =>
    isFinal(s.state) && (!options.shown || options.shown.has(s.key));
  const revealing =
    !!options.shown && steps.some((s) => isFinal(s.state) && !visible(s));
  const cursor =
    options.active || revealing ? (steps.find((s) => !visible(s))?.key ?? null) : null;
  const list: DisplayStep[] = steps.map((s) => ({
    ...s,
    display: visible(s)
      ? s.state
      : s.key === cursor || s.state === "running"
        ? "running"
        : "pending",
  }));
  const done = list.filter((s) => isFinal(s.display)).length;
  return {
    steps: list,
    revealing,
    done,
    current: list.find((s) => s.key === cursor) ?? null,
  };
}
