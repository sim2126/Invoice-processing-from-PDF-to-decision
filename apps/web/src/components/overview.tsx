"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  action,
  api,
  type CompanyDocument,
  type InboxItem,
  type InvoiceRow,
  type UploadResult,
} from "@/lib/api";
import {
  cents,
  clock,
  dayKey,
  dayLabel,
  isoDayKey,
  money,
  moneyCents,
  receivedLabel,
} from "@/lib/format";
import { useNow } from "@/lib/hooks";
import {
  actionRows,
  blockedTotal,
  outcomesByWeek,
  overviewSummary,
  stopReasons,
  type Week,
} from "@/lib/overview";
import {
  keys,
  refreshWorkspace,
  useInbox,
  useInvoices,
  useSupplierNames,
} from "@/lib/queries";
import { nextStep, reasonText, supplierLabel } from "@/lib/status";
import { IconArrowRight, IconTick } from "./icons";
import { useShell } from "./shell-context";
import { ErrorNotice, Loading, Pill, StatusPill } from "./ui";

const SERIES = [
  { key: "auto", label: "Straight through", short: "Straight", color: "var(--ok-dot)" },
  { key: "person", label: "Needed a person", short: "Person", color: "var(--warn-dot)" },
  { key: "blocked", label: "Blocked", short: "Blocked", color: "var(--bad-dot)" },
] as const;

export function Overview() {
  const { session } = useShell();
  const now = useNow();
  const invoices = useInvoices();
  const names = useSupplierNames();
  const rows = invoices.data?.invoices ?? [];
  const summary = overviewSummary(rows, now);
  const company = session.company.name;
  const subtitle = summary.since
    ? `${company} · ${summary.decided.length} ${summary.decided.length === 1 ? "invoice" : "invoices"} from ${summary.suppliers} ${summary.suppliers === 1 ? "supplier" : "suppliers"} since ${dayLabel(summary.since, now)}`
    : `${company} · nothing processed yet`;

  return (
    <div className="tm-view">
      <div className="tm-head">
        <div>
          <h1>Overview</h1>
          <p>{invoices.data ? subtitle : company}</p>
        </div>
      </div>
      {invoices.isPending ? (
        <Loading label="Loading invoices…" />
      ) : invoices.error && !invoices.data ? (
        <ErrorNotice error={invoices.error} onRetry={() => invoices.refetch()} />
      ) : (
        <>
          <section className="tm-kpis" aria-label="Key figures">
            {summary.kpis.map((kpi, index) => (
              <div
                className="tm-kpi"
                key={kpi.label}
                style={{ animationDelay: `${index * 60}ms` }}
              >
                <span className="tm-kpi-l">{kpi.label}</span>
                <span className="tm-kpi-v">{kpi.value}</span>
                <span className="tm-kpi-s">{kpi.sub}</span>
              </div>
            ))}
          </section>
          <div className="tm-overview">
            <div className="tm-stackcol">
              <div className="tm-split">
                <OutcomesCard weeks={outcomesByWeek(rows, now)} />
                <ReasonsCard rows={rows} now={now} />
              </div>
              <LatestDecisions rows={summary.decided} now={now} names={names} />
            </div>
            <div className="tm-stackcol">
              <InboxCard rows={rows} now={now} />
              <NeedsAction rows={actionRows(rows)} now={now} names={names} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function OutcomesCard({ weeks }: { weeks: Week[] }) {
  const [table, setTable] = useState(false);
  const [hover, setHover] = useState(-1);
  const legend = { auto: 0, person: 0, blocked: 0 };
  for (const week of weeks) {
    legend.auto += week.auto;
    legend.person += week.person;
    legend.blocked += week.blocked;
  }
  const max = Math.max(0, ...weeks.map((w) => w.total));
  const top = Math.max(4, Math.ceil(max / 4) * 4);
  const unit = 132 / top;
  return (
    <section className="tm-card" aria-labelledby="tm-outcomes">
      <div className="tm-card-h">
        <h2 id="tm-outcomes">Outcomes by week</h2>
        <button
          type="button"
          className="tm-btn tm-btn-ghost tm-btn-sm"
          onClick={() => setTable((t) => !t)}
        >
          {table ? "Show chart" : "Show table"}
        </button>
      </div>
      <div className="tm-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="tm-legend">
          {SERIES.map((s) => (
            <span key={s.key}>
              <b style={{ background: s.color }} aria-hidden="true" />
              {s.label} · {legend[s.key]}
            </span>
          ))}
        </div>
        {table ? (
          <table className="tm-mini-table">
            <caption className="tm-sr">Outcomes by week</caption>
            <thead>
              <tr>
                <th scope="col">Week</th>
                {SERIES.map((s) => (
                  <th scope="col" key={s.key}>
                    {s.short}
                  </th>
                ))}
                <th scope="col">Total</th>
              </tr>
            </thead>
            <tbody>
              {weeks.map((w) => (
                <tr key={w.range}>
                  <th scope="row" style={{ fontWeight: 400, color: "var(--ink)" }}>
                    {w.range}
                  </th>
                  <td>{w.auto}</td>
                  <td>{w.person}</td>
                  <td>{w.blocked}</td>
                  <td style={{ fontWeight: 600 }}>{w.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div>
            <div className="tm-chart" role="group" aria-label="Invoices per week by outcome">
              {[top / 2, top].map((g) => (
                <div className="tm-gl" key={g} style={{ bottom: g * unit }} aria-hidden="true">
                  <span>{g}</span>
                </div>
              ))}
              {weeks.map((w, i) => {
                const segments = SERIES.map((s) => ({ ...s, count: w[s.key] })).filter(
                  (s) => s.count > 0,
                );
                return (
                  <div className="tm-col" key={w.range}>
                    {hover === i && (
                      <div className="tm-tip" aria-hidden="true">
                        <strong style={{ fontSize: 12, marginBottom: 2 }}>{w.range}</strong>
                        {SERIES.map((s) => (
                          <div key={s.key}>
                            <b style={{ background: s.color }} />
                            {s.label}
                            <em>{w[s.key]}</em>
                          </div>
                        ))}
                      </div>
                    )}
                    <span className="tm-col-total" aria-hidden="true">
                      {w.total}
                    </span>
                    <div
                      className="tm-stack"
                      aria-hidden="true"
                      style={{ height: w.total * unit, animationDelay: `${i * 70}ms` }}
                    >
                      {segments.map((s, j) => (
                        <span
                          key={s.key}
                          style={{
                            height: Math.max(2, s.count * unit - (j > 0 ? 2 : 0)),
                            background: s.color,
                          }}
                        />
                      ))}
                    </div>
                    <button
                      type="button"
                      className="tm-col-btn"
                      aria-label={`${w.range}: ${w.auto} straight through, ${w.person} needed a person, ${w.blocked} blocked`}
                      onMouseEnter={() => setHover(i)}
                      onMouseLeave={() => setHover(-1)}
                      onFocus={() => setHover(i)}
                      onBlur={() => setHover(-1)}
                      onClick={() => setHover((h) => (h === i ? -1 : i))}
                    />
                  </div>
                );
              })}
            </div>
            <div className="tm-xaxis" aria-hidden="true">
              {weeks.map((w) => (
                <span key={w.range}>{w.label}</span>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function ReasonsCard({ rows, now }: { rows: InvoiceRow[]; now: number }) {
  const reasons = stopReasons(rows, now);
  const blocked = blockedTotal(rows, now);
  const most = reasons[0]?.count ?? 1;
  return (
    <section className="tm-card tm-reasons" aria-labelledby="tm-reasons">
      <div className="tm-card-h">
        <h2 id="tm-reasons">Why invoices stopped</h2>
        <span className="tm-faint" style={{ fontSize: 12.5 }}>
          Last 6 weeks
        </span>
      </div>
      <div
        className="tm-card-b"
        tabIndex={0}
        role="region"
        aria-label="Reasons invoices stopped, scrollable"
      >
        {reasons.length ? (
          <ul aria-label="Reasons, most frequent first">
            {reasons.map((reason, index) => (
              <li className="tm-hbar" key={reason.label}>
                <span style={{ fontSize: 13 }}>{reason.label}</span>
                <span className="tm-num" style={{ fontSize: 12.5, fontWeight: 600 }}>
                  {reason.count}
                </span>
                <div className="tm-hbar-track" aria-hidden="true">
                  <div
                    className="tm-hbar-fill"
                    style={{
                      width: `${Math.round((reason.count / most) * 100)}%`,
                      animationDelay: `${120 + index * 60}ms`,
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="tm-muted" style={{ fontSize: 13, paddingTop: 8 }}>
            No invoice has stopped in the last six weeks.
          </p>
        )}
        <p className="tm-muted" style={{ fontSize: 12.5, marginTop: 10 }}>
          {blocked.count
            ? `${blocked.amount} stopped before payment across ${blocked.count} blocked ${blocked.count === 1 ? "invoice" : "invoices"}.`
            : "Nothing blocked yet."}
        </p>
      </div>
    </section>
  );
}

function LatestDecisions({
  rows,
  now,
  names,
}: {
  rows: InvoiceRow[];
  now: number;
  names: Map<string, string>;
}) {
  return (
    <section className="tm-card tm-grow" aria-labelledby="tm-latest">
      <div className="tm-card-h">
        <h2 id="tm-latest">Latest decisions</h2>
        <Link className="tm-link" href="/invoices">
          All invoices
          <IconArrowRight size={14} />
        </Link>
      </div>
      <div className="tm-card-b tm-xscroll">
        {rows.length === 0 ? (
          <div className="tm-empty">
            <strong>No decisions yet</strong>
            <span>Checked invoices appear here, newest first.</span>
          </div>
        ) : (
          <div
            className="tm-table tm-rows-wide tm-latest tm-compact"
            role="table"
            aria-labelledby="tm-latest"
          >
            <div className="tm-row tm-thead tm-cols-runs" role="row">
              <span role="columnheader">Invoice</span>
              <span role="columnheader" className="tm-wide-only">
                Supplier
              </span>
              <span role="columnheader" className="tm-r">
                Amount
              </span>
              <span role="columnheader">Status</span>
              <span role="columnheader" className="tm-wide-only">
                Next step
              </span>
              <span role="columnheader" className="tm-r tm-wide-only">
                Due
              </span>
            </div>
            {rows.map((row) => (
              <div className="tm-row is-link tm-cols-runs" role="row" key={row.id}>
                <span role="cell" className="tm-ellipsis">
                  <Link className="tm-rowlink tm-cell-id" href={`/invoices/${row.id}`}>
                    {row.reference ?? "No number"}
                  </Link>
                  <span className="tm-c-sub">{supplierLabel(row, names) ?? "—"}</span>
                </span>
                <span role="cell" className="tm-ellipsis tm-wide-only">
                  {supplierLabel(row, names) ?? "—"}
                </span>
                <span role="cell" className="tm-r tm-num" style={{ fontWeight: 550 }}>
                  {money(row.total, row.currency ?? "USD")}
                </span>
                <span role="cell">
                  <StatusPill status={row.status} />
                </span>
                <span role="cell" className="tm-cell-next tm-ellipsis tm-wide-only">
                  {nextStep(row)}
                </span>
                <span role="cell" className="tm-r tm-cell-meta tm-wide-only">
                  {dayLabel(row.due_date, now)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function InboxCard({ rows, now }: { rows: InvoiceRow[]; now: number }) {
  const { session, notify } = useShell();
  const router = useRouter();
  const client = useQueryClient();
  const inbox = useInbox();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const items = inbox.data ?? [];
  const unchecked = items.filter((i) => i.kind === "invoice" && !i.invoice_id);
  const canAct = session.user.role !== "viewer";
  const today = dayKey(new Date(now));
  const allToday = items.every((i) => isoDayKey(i.received_at) === today);
  const address = `invoices@${session.company.name.toLowerCase().replace(/[^a-z0-9]/g, "") || "company"}.com`;

  const check = useMutation({
    mutationFn: (key: string) =>
      api<UploadResult>(`/inbox/${encodeURIComponent(key)}/check`, action(session.csrf)),
    onSuccess: async (result) => {
      await client.invalidateQueries({ queryKey: keys.inbox });
      void refreshWorkspace(client);
      router.push(`/invoices/${result.id}`);
    },
  });
  const checkAll = useMutation({
    mutationFn: async (keysToCheck: string[]) => {
      for (const key of keysToCheck)
        await api<UploadResult>(`/inbox/${encodeURIComponent(key)}/check`, action(session.csrf));
      return keysToCheck.length;
    },
    onSuccess: (count) =>
      notify(`${count} ${count === 1 ? "invoice is" : "invoices are"} being checked`),
    onSettled: () => refreshWorkspace(client),
  });
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
  const busy = check.isPending || checkAll.isPending;
  const pending = (key: string) =>
    (check.isPending && check.variables === key) ||
    (checkAll.isPending && (checkAll.variables ?? []).includes(key));

  function status(item: InboxItem) {
    if (item.kind === "document")
      return item.document_id ? (
        <Pill tone="is-approved">Saved</Pill>
      ) : canAct ? (
        <button
          type="button"
          className="tm-btn tm-btn-line tm-btn-sm"
          aria-label={`Save document: ${item.subject}`}
          disabled={save.isPending}
          onClick={() => save.mutate(item.key)}
        >
          {save.isPending && save.variables === item.key ? "Saving…" : "Save"}
        </button>
      ) : null;
    if (item.invoice_id) {
      const row = byId.get(item.invoice_id);
      return row ? <StatusPill status={row.status} /> : <StatusPill status="CHECKING" />;
    }
    if (pending(item.key)) return <StatusPill status="CHECKING" />;
    return canAct ? (
      <button
        type="button"
        className="tm-btn tm-btn-line tm-btn-sm"
        aria-label={`Check invoice: ${item.subject}`}
        disabled={busy}
        onClick={() => check.mutate(item.key)}
      >
        Check
      </button>
    ) : null;
  }

  return (
    <section className="tm-card tm-inbox" aria-labelledby="tm-inbox">
      <div className="tm-card-h">
        <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
          <h2 id="tm-inbox">Inbox</h2>
          <span className="tm-faint tm-ellipsis" style={{ fontSize: 12 }}>
            {address}
            {items.length > 0 && allToday ? " · today" : ""}
          </span>
        </div>
        {canAct && unchecked.length > 0 && (
          <button
            type="button"
            className="tm-btn tm-btn-line tm-btn-sm"
            disabled={busy}
            onClick={() => checkAll.mutate(unchecked.map((i) => i.key))}
          >
            {checkAll.isPending ? "Checking…" : `Check all ${unchecked.length}`}
          </button>
        )}
      </div>
      <div className="tm-card-b">
        <ErrorNotice error={inbox.error ?? check.error ?? checkAll.error ?? save.error} />
        {inbox.isPending ? (
          <Loading label="Loading the inbox…" />
        ) : items.length === 0 ? (
          <div className="tm-empty" style={{ padding: "20px 16px" }}>
            <strong>Inbox is clear</strong>
            <span>Invoices emailed to {address} land here.</span>
          </div>
        ) : (
          <ul aria-label="Emails received">
            {items.map((item) => {
              const when = allToday ? clock(item.received_at) : receivedLabel(item.received_at, now);
              const content = (
                <>
                  <span className="tm-ellipsis" style={{ display: "block", fontSize: 13, fontWeight: 550 }}>
                    {item.subject}
                  </span>
                  <span className="tm-faint tm-ellipsis" style={{ display: "block", fontSize: 12 }}>
                    {item.sender} · {when}
                  </span>
                </>
              );
              return (
                <li
                  className="tm-row"
                  key={item.key}
                  style={{ gridTemplateColumns: "minmax(0, 1fr) auto", paddingTop: 8, paddingBottom: 8 }}
                >
                  {item.invoice_id ? (
                    <Link href={`/invoices/${item.invoice_id}`} style={{ minWidth: 0 }}>
                      {content}
                    </Link>
                  ) : (
                    <a
                      href={`/api/inbox/${encodeURIComponent(item.key)}/pdf`}
                      target="_blank"
                      rel="noreferrer"
                      style={{ minWidth: 0 }}
                    >
                      {content}
                      <span className="tm-sr"> (opens the PDF in a new tab)</span>
                    </a>
                  )}
                  <span>{status(item)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

function NeedsAction({
  rows,
  now,
  names,
}: {
  rows: InvoiceRow[];
  now: number;
  names: Map<string, string>;
}) {
  const today = dayKey(new Date(now));
  const waiting = rows.reduce((sum, r) => sum + cents(r.total), 0);
  return (
    <section className="tm-card tm-grow" aria-labelledby="tm-action">
      <div className="tm-card-h">
        <h2 id="tm-action">Needs action</h2>
        <span className="tm-faint tm-num" style={{ fontSize: 12.5 }}>
          {rows.length} open · {moneyCents(waiting)}
        </span>
      </div>
      <div className="tm-card-b">
        {rows.length === 0 ? (
          <div className="tm-empty">
            <IconTick size={22} style={{ color: "var(--ok-dot)" }} />
            <strong>Nothing waiting on you</strong>
            <span>New exceptions land here the moment a run stops.</span>
          </div>
        ) : (
          <ul aria-label="Invoices that need action, soonest due first">
            {rows.map((row) => {
              const overdue = !!row.due_date && row.due_date < today;
              return (
                <li
                  className="tm-row is-link"
                  key={row.id}
                  style={{ gridTemplateColumns: "minmax(0, 1fr) auto", alignItems: "start" }}
                >
                  <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      <Link className="tm-rowlink tm-cell-id" href={`/invoices/${row.id}`}>
                        {row.reference ?? "No number"}
                      </Link>
                      <span className="tm-faint tm-ellipsis" style={{ fontSize: 12.5 }}>
                        {supplierLabel(row, names)}
                      </span>
                    </div>
                    <span style={{ fontSize: 13, color: "var(--ink-2)" }}>
                      {reasonText(row.reason_code, row.reason) ?? row.summary}
                    </span>
                    <span className="tm-faint" style={{ fontSize: 12 }}>
                      <span className={overdue ? "tm-warn-text" : undefined}>
                        {overdue ? "Overdue · " : "Due "}
                        {dayLabel(row.due_date, now)}
                      </span>{" "}
                      · {nextStep(row)}
                    </span>
                  </div>
                  <div
                    style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}
                  >
                    <span className="tm-num" style={{ fontWeight: 550 }}>
                      {money(row.total, row.currency ?? "USD")}
                    </span>
                    <StatusPill status={row.status} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
