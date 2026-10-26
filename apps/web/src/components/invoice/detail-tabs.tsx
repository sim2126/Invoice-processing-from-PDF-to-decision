"use client";
import type {
  AiMatchAfter,
  Audit,
  Detail,
  Evidence,
  InvoiceStatus,
  PurchaseOrder,
} from "@/lib/api";
import { cx, longDate, moment, money, qty, units } from "@/lib/format";
import { lineFacts } from "@/lib/lines";
import { parseQuantity, plainText } from "@/lib/plain";
import { REASON_LABEL, STATUS_DOT, STATUS_LABEL } from "@/lib/status";
import { WAIT_SUPPLIER } from "@/lib/steps";
import { noMatchText } from "@/lib/verdict";
import { IconDownload, IconExternal } from "../icons";
import { Pill } from "../ui";

type Row = { label: string; value: string; field?: string; mono?: boolean; missing?: boolean };

function CiteButton({
  evidence,
  label,
  focus,
  onCite,
}: {
  evidence?: Evidence;
  label: string;
  focus: string | null;
  onCite: (field: string) => void;
}) {
  if (!evidence?.page) return null;
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
      p{evidence.page}
      <span className="tm-sr">
        , show {label} on the page
        {evidence.status === "unverified" ? " (not confirmed on the page)" : ""}
      </span>
    </button>
  );
}

export function FieldsPanel({
  detail,
  focus,
  onCite,
}: {
  detail: Detail;
  focus: string | null;
  onCite: (field: string) => void;
}) {
  const x = detail.extraction;
  const inv = detail.invoice;
  if (!x)
    return (
      <div className="tm-empty">
        <strong>No fields yet</strong>
        <span>Fields appear here once the document has been read.</span>
      </div>
    );
  const chosenPo =
    detail.decision && inv.decision_applicable
      ? detail.decision.comparison.po_reference
      : null;
  const rate = Number(x.tax_rate);
  const rows: Row[] = [
    { label: "Supplier", value: x.vendor_name ?? "Not printed", field: "vendor_name", missing: !x.vendor_name },
    { label: "Supplier ID", value: x.vendor_identifier ?? "Not printed", field: "vendor_identifier", mono: true, missing: !x.vendor_identifier },
    { label: "Invoice number", value: x.invoice_number ?? "Not printed", field: "invoice_number", mono: true, missing: !x.invoice_number },
    { label: "Invoice date", value: longDate(x.invoice_date), field: "invoice_date" },
    {
      label: "Due date",
      value: inv.due_date
        ? `${longDate(inv.due_date)}${inv.due_assumed ? " · Net 30" : ""}`
        : "Not printed",
      field: "due_date",
      missing: !inv.due_date,
    },
    {
      label: "Purchase order",
      value: x.po_reference ?? (chosenPo ? `${chosenPo} · confirmed later` : "Not printed"),
      field: "po_reference",
      mono: true,
      missing: !x.po_reference && !chosenPo,
    },
    { label: "Currency", value: x.currency ?? "Not printed", field: "currency", missing: !x.currency },
  ];
  if (x.tax_treatment === "inclusive")
    rows.push({
      label: "Tax basis",
      value: Number.isFinite(rate) && x.tax_rate != null
        ? `Prices include ${rate}% tax`
        : "Prices include tax",
      field: "tax_rate",
    });
  x.lines.forEach((line, index) => {
    rows.push(
      {
        label: `Line ${index + 1}`,
        value: `${line.sku || line.description || "Item"} · ${units(line.quantity, line.unit)}`,
        field: line.sku ? `lines.${index}.sku` : `lines.${index}.description`,
        mono: !!line.sku,
      },
      { label: "Unit price", value: money(line.unit_price), field: `lines.${index}.unit_price` },
      { label: "Line total", value: money(line.total), field: `lines.${index}.total` },
    );
  });
  if (x.subtotal != null) rows.push({ label: "Subtotal", value: money(x.subtotal), field: "subtotal" });
  if (x.header_discount != null) rows.push({ label: "Discount", value: money(x.header_discount), field: "header_discount" });
  if (x.shipping != null) rows.push({ label: "Shipping", value: money(x.shipping), field: "shipping" });
  rows.push(
    { label: "Tax", value: x.tax != null ? money(x.tax) : "Not printed", field: "tax" },
    { label: "Total", value: money(x.total), field: "total" },
  );
  const unverified = detail.evidence.some((e) => e.status === "unverified");
  return (
    <div className="tm-pad">
      <table className="tm-fields">
        <caption className="tm-sr">Extracted fields and where they appear</caption>
        <tbody>
          {rows.map((row, index) => {
            const evidence = row.field
              ? detail.evidence.find((e) => e.field === row.field)
              : undefined;
            return (
              <tr key={`${row.label}-${index}`}>
                <th scope="row">{row.label}</th>
                <td
                  className={cx(
                    row.mono && "tm-mono",
                    !row.mono && "tm-num",
                    (row.missing || evidence?.status === "unverified") && "tm-warn-text",
                  )}
                  style={row.mono ? { fontSize: 12.5 } : undefined}
                >
                  {row.value}
                </td>
                <td>
                  <CiteButton
                    evidence={evidence}
                    label={row.label}
                    focus={focus}
                    onCite={onCite}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {unverified && (
        <p className="tm-legend-note">
          <i aria-hidden="true" />
          <span>
            <strong>Amber values</strong> were read, but not found word-for-word
            on the page — common on scans; they can’t support an approval.
          </span>
        </p>
      )}
      <p className="tm-faint" style={{ fontSize: 12, marginTop: 12 }}>
        Each value links to where it appears on the page. A value with no
        source on the page can never support an approval.
      </p>
    </div>
  );
}

export function POPanel({
  detail,
  orders,
  status,
}: {
  detail: Detail;
  orders: PurchaseOrder[];
  status: InvoiceStatus;
}) {
  const inv = detail.invoice;
  const x = detail.extraction;
  const decision =
    detail.decision && inv.decision_applicable ? detail.decision : null;
  const cmp = decision?.comparison;
  const ref = cmp?.po_reference;
  const supplierPending =
    decision?.checks.find((c) => c.code === "vendor")?.state === "review";
  if (!ref) {
    const candidates = detail.candidates.orders;
    let intro: string;
    if (status === "CHECKING") intro = "The order is compared once the fields are read.";
    else if (supplierPending)
      intro = `${x?.po_reference ? `${x.po_reference} is printed on the invoice. ` : ""}${WAIT_SUPPLIER}: the order is matched once Tickmark knows who sent the invoice.`;
    else if (candidates.length)
      intro = x?.po_reference
        ? `${x.po_reference} isn’t an open order for this supplier. These open orders from the same supplier could cover it:`
        : "No purchase order is matched to this invoice yet. These open orders from the same supplier could cover it:";
    else
      intro = x?.po_reference
        ? `${x.po_reference} isn’t an open order for this supplier, and the supplier has no other open order.`
        : "No purchase order is matched to this invoice, and the supplier has no open order.";
    return (
      <div className="tm-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p style={{ fontSize: 13.5, color: "var(--ink-2)" }}>{intro}</p>
        {status !== "CHECKING" &&
          !supplierPending &&
          candidates.map((c) => {
            const order = orders.find((o) => o.id === c.id);
            const line = c.lines[0];
            return (
              <div className="tm-diff" key={c.id}>
                <span className="tm-mono" style={{ color: "var(--ink)", fontWeight: 600 }}>
                  {c.reference}
                </span>
                <strong>{order ? `${money(order.remaining)} left` : money(c.ceiling)}</strong>
                <span>{c.description}</span>
                <strong style={{ fontWeight: 500 }}>
                  {line ? `${money(String(line.unit_price))} per ${String(line.unit)}` : ""}
                </strong>
              </div>
            );
          })}
      </div>
    );
  }
  const order = orders.find((o) => o.reference === ref);
  const closed = order?.status === "CLOSED";
  const facts = lineFacts(detail);
  const inclusive = !!facts?.inclusive;
  const ceiling = Number(cmp.ceiling ?? order?.ceiling ?? 0);
  const before = Number(cmp.committed_before ?? 0);
  const total = Number(inv.total ?? 0);
  const usedPct = ceiling > 0 ? Math.min(100, (before / ceiling) * 100) : 0;
  const thisPct = ceiling > 0 ? Math.max(0, Math.min(100 - usedPct, (total / ceiling) * 100)) : 0;
  const approved = decision?.outcome === "APPROVED";
  const short = !approved && Number(cmp.shortfall ?? 0) > 0;
  const tone = STATUS_DOT[status];
  const lines = cmp.lines ?? [];
  return (
    <div className="tm-pad" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div>
          <div className="tm-mono" style={{ fontWeight: 600 }}>{ref}</div>
          <div className="tm-faint" style={{ fontSize: 12.5 }}>
            {[order?.description, order?.vendor.name].filter(Boolean).join(" · ")}
          </div>
        </div>
        {order && (
          <Pill tone={closed ? "is-hold" : ""}>{closed ? "Closed" : "Open"}</Pill>
        )}
      </div>
      <div
        className="tm-meter"
        role="img"
        aria-label={`Billed before ${money(before)}, this invoice ${money(total)}, limit ${money(ceiling)}`}
      >
        <span style={{ width: `${usedPct}%`, background: "var(--bar)" }} />
        <span style={{ width: `${thisPct}%`, background: tone }} />
      </div>
      <div className="tm-legend" aria-hidden="true">
        <span><b style={{ background: "var(--bar)" }} />Billed before</span>
        <span><b style={{ background: tone }} />This invoice</span>
        <span><b style={{ background: "var(--track)", boxShadow: "inset 0 0 0 1px var(--line-2)" }} />Left</span>
      </div>
      <div className="tm-diff">
        <span>Order limit</span><strong>{money(ceiling)}</strong>
        <span>Billed before this invoice</span><strong>{money(before)}</strong>
        <span>This invoice{inclusive ? " · including tax" : ""}</span>
        <strong>{money(total)}</strong>
        {inclusive && (
          <>
            <span>Tax included{facts?.rate ? ` (${facts.rate}%)` : ""}</span>
            <strong>{money(facts?.tax)}</strong>
          </>
        )}
        <span>
          {closed
            ? "Left"
            : short
              ? "Short by"
              : approved
                ? "Left after this invoice"
                : "Left · nothing reserved"}
        </span>
        <strong style={{ color: short ? "var(--bad)" : "var(--ink)" }}>
          {closed
            ? "Closed"
            : money(short ? cmp.shortfall : approved ? cmp.remaining_after : cmp.remaining_before)}
        </strong>
      </div>
      {inclusive && (
        <p className="tm-faint" style={{ fontSize: 12 }}>
          Prices are compared net of tax; the order budget counts the full amount
          including tax.
        </p>
      )}
      {lines.length > 0 && (
        <>
          <h3 style={{ fontSize: 13, fontWeight: 600, paddingTop: 4 }}>Line by line</h3>
          {lines.map((line, index) => {
            const extracted =
              detail.extraction?.lines.find(
                (l) => (l.sku ?? "").toLowerCase() === (line.sku ?? "").toLowerCase(),
              ) ?? detail.extraction?.lines[index];
            const row = facts?.rows.find((r) => r.sku === line.sku) ?? facts?.rows[index];
            const net = row?.net ?? Number(line.invoice_price);
            const po = Number(line.po_price);
            const quantity = Number(line.invoice_quantity);
            const poLine = order?.lines.find((l) => l.sku === line.sku);
            const check = decision?.checks.find((c) => c.code === `quantity_${line.sku}`);
            const counted = check ? parseQuantity(check.message) : null;
            const left = counted?.left ?? poLine?.remaining_quantity;
            const authorized = counted?.authorized ?? poLine?.quantity;
            const above = net - po > 0.0001;
            const priceIssue = inv.reason_code === "price" && above;
            const over = left != null && quantity > Number(left);
            return (
              <div className="tm-diff tm-diff-3" key={`${line.sku}-${index}`}>
                <span />
                <span className="tm-r" style={{ fontSize: 12 }}>Invoice</span>
                <span className="tm-r" style={{ fontSize: 12 }}>Purchase order</span>
                <span>Item</span>
                <strong className="tm-mono" style={{ fontSize: 12.5 }}>{extracted?.sku ?? line.sku}</strong>
                <strong className="tm-mono" style={{ fontSize: 12.5 }}>{line.sku}</strong>
                {inclusive && (
                  <>
                    <span>Unit price incl. tax</span>
                    <strong>{money(row?.gross ?? extracted?.unit_price)}</strong>
                    <strong className="tm-faint" style={{ fontWeight: 500 }}>—</strong>
                  </>
                )}
                <span>{inclusive ? "Unit price net" : "Unit price"}</span>
                <strong style={{ color: priceIssue ? "var(--bad)" : above ? "var(--warn)" : "var(--ink)" }}>
                  {money(net)}
                </strong>
                <strong>{money(po)}</strong>
                <span>Quantity</span>
                <strong style={{ color: over ? "var(--bad)" : "var(--ink)" }}>
                  {units(line.invoice_quantity, line.unit)}
                </strong>
                <strong>
                  {left != null && authorized != null
                    ? `${qty(left)} of ${qty(authorized)} left`
                    : "—"}
                </strong>
                <span>{inclusive ? "Line total net" : "Line total"}</span>
                <strong>{money(inclusive ? net * quantity : extracted?.total)}</strong>
                <strong>{money(quantity * po)}</strong>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

type Entry = {
  key: string;
  title: string;
  meta: string;
  note?: string;
  color: string;
  link?: { href: string; label: string };
};

function entryFor(audit: Audit, detail: Detail, now: number): Entry {
  const when = moment(audit.at, now);
  const after = audit.after as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const base = { key: audit.id, meta: `${audit.actor} · ${when}` };
  switch (audit.action) {
    case "UPLOAD":
      return {
        ...base,
        title:
          detail.invoice.source === "upload" && after.source !== "history"
            ? "Received"
            : "Received by email",
        meta: `${when} · ${text(after.filename) || detail.invoice.filename}`,
        color: "var(--grey-dot)",
      };
    case "DECISION": {
      const outcome = text(after.outcome) as InvoiceStatus;
      const decision = detail.history.find((d) => d.id === text(after.decision_id));
      // The decision's own reason names the root cause; the summary may not.
      const reason =
        decision?.reason ??
        (decision?.reason_code ? REASON_LABEL[decision.reason_code] : null) ??
        (outcome && outcome !== "APPROVED" ? plainText(audit.reason) : null);
      return {
        ...base,
        title: `Decision · ${STATUS_LABEL[outcome] ?? (outcome || "recorded")}`,
        meta: `${when} · policy ${audit.policy_version}`,
        note: outcome === "APPROVED" ? undefined : (reason ?? undefined),
        color: STATUS_DOT[outcome] ?? "var(--grey-dot)",
      };
    }
    case "AI_MATCH": {
      const match = after as Partial<AiMatchAfter>;
      return {
        ...base,
        title: `AI matched the order · ${match.po_reference ?? "purchase order"}`,
        note: match.document
          ? `From the company document “${match.document}”.`
          : audit.reason,
        link: match.document_id
          ? {
              href: `/api/documents/${encodeURIComponent(match.document_id)}/source`,
              label: `Open ${match.document ?? "the document"}`,
            }
          : undefined,
        color: "var(--accent)",
      };
    }
    case "AI_NO_MATCH":
      return {
        ...base,
        title: "AI found no matching company document",
        note: `${noMatchText(audit).replace(/\.\s*$/, "")}.`,
        color: "var(--warn-dot)",
      };
    case "REVIEW": {
      // "workflow" records a cleared hold, not a corrected invoice field.
      const fields = Object.keys(after).filter(
        (k) => k !== "purchase_order" && k !== "vendor_selection" && k !== "workflow",
      );
      const title = after.purchase_order
        ? `Order confirmed · ${text(after.purchase_order)}`
        : after.vendor_selection
          ? `Supplier confirmed · ${text(after.vendor_selection)}`
          : fields.length
            ? `Corrected ${fields.map((f) => f.replace(/^lines\.(\d+)\./, "line $1 ").replaceAll("_", " ")).join(", ")}`
            : /^Reply received/i.test(audit.reason)
              ? "Reply received · checking again"
              : /company documents/i.test(audit.reason)
                ? "Asked AI to check company documents"
                : "Checks run again";
      return { ...base, title, note: audit.reason, color: "var(--accent)" };
    }
    case "RETRY":
      return { ...base, title: "Asked to read the document again", color: "var(--accent)" };
    case "HOLD": {
      const to = text(after.to);
      return {
        ...base,
        title: /procurement/i.test(to)
          ? "Sent to procurement · on hold"
          : `Correction requested from ${to || "the supplier"} · on hold`,
        note: text(after.message) || audit.reason,
        color: "var(--hold-dot)",
      };
    }
    case "REJECT":
      return {
        ...base,
        title: "Rejected · nothing reserved",
        note: audit.reason,
        color: "var(--grey-dot)",
      };
    default:
      return {
        ...base,
        title: audit.action.charAt(0) + audit.action.slice(1).toLowerCase().replaceAll("_", " "),
        note: audit.reason,
        color: "var(--grey-dot)",
      };
  }
}

export function HistoryPanel({ detail, now }: { detail: Detail; now: number }) {
  const entries = [...detail.audit]
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .map((a) => entryFor(a, detail, now));
  return (
    <div className="tm-pad">
      {entries.length === 0 ? (
        <p className="tm-muted" style={{ fontSize: 13 }}>
          Nothing recorded yet.
        </p>
      ) : (
        <ol className="tm-history">
          {entries.map((entry) => (
            <li key={entry.key}>
              <span className="tm-history-dot" style={{ background: entry.color }} aria-hidden="true" />
              <div>
                <div style={{ fontWeight: 550, fontSize: 13.5 }}>{entry.title}</div>
                <div className="tm-faint" style={{ fontSize: 12 }}>{entry.meta}</div>
                {entry.note && <p className="tm-history-note">{entry.note}</p>}
                {entry.link && (
                  <a
                    className="tm-link"
                    style={{ marginTop: 4 }}
                    href={entry.link.href}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {entry.link.label}
                    <IconExternal size={13} />
                    <span className="tm-sr"> (opens in a new tab)</span>
                  </a>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
      <a
        className="tm-link"
        style={{ marginTop: 14 }}
        href={`/api/invoices/${encodeURIComponent(detail.invoice.id)}/export`}
        download
      >
        <IconDownload size={14} />
        Download decision record
      </a>
    </div>
  );
}
