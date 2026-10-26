"use client";
import Link from "next/link";
import { useState } from "react";
import type { InvoiceRow } from "@/lib/api";
import { capitalize, dayLabel, money, receivedLabel } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { useInvoices, useSupplierNames } from "@/lib/queries";
import { nextStep, supplierLabel } from "@/lib/status";
import { IconSearch } from "./icons";
import { useShell } from "./shell-context";
import { ErrorNotice, Loading, StatusPill } from "./ui";

const FILTERS: {
  key: string;
  label: string;
  test: (row: InvoiceRow) => boolean;
  optional?: boolean;
}[] = [
  { key: "all", label: "All", test: () => true },
  { key: "checking", label: "Checking", test: (r) => r.status === "CHECKING" },
  { key: "review", label: "Needs review", test: (r) => r.status === "NEEDS_REVIEW" },
  { key: "hold", label: "On hold", test: (r) => r.status === "ON_HOLD" },
  { key: "approved", label: "Approved", test: (r) => r.status === "APPROVED" },
  // Same meaning as "Stopped before payment" on the overview.
  { key: "blocked", label: "Blocked", test: (r) => r.status === "BLOCKED" },
  { key: "rejected", label: "Rejected", test: (r) => r.status === "REJECTED" },
  {
    key: "failed",
    label: "Couldn’t read",
    test: (r) => r.status === "FAILED",
    optional: true,
  },
];

export function InvoiceList() {
  const { session, openUpload } = useShell();
  const now = useNow();
  const invoices = useInvoices();
  const names = useSupplierNames();
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const all = [...(invoices.data?.invoices ?? [])].sort(
    (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
  );
  const active = FILTERS.find((f) => f.key === filter) ?? FILTERS[0];
  const query = search.trim().toLowerCase();
  const rows = all.filter(
    (row) =>
      active.test(row) &&
      (!query ||
        [row.reference, supplierLabel(row, names), row.vendor, row.po_reference, row.filename]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(query)),
  );
  const review = all.filter((r) => r.status === "NEEDS_REVIEW").length;

  return (
    <div className="tm-view">
      <div className="tm-head">
        <div>
          <h1>Invoices</h1>
          <p>
            {all.length} {all.length === 1 ? "invoice" : "invoices"} · {review} need
            review · newest first
          </p>
        </div>
      </div>
      <section className="tm-card tm-grow" aria-label="Invoice list">
        <div
          className="tm-card-h"
          style={{ flexWrap: "wrap", paddingTop: 10, paddingBottom: 10 }}
        >
          <div className="tm-seg-ctl" role="group" aria-label="Filter by status">
            {FILTERS.filter((f) => !f.optional || all.some(f.test)).map((f) => (
              <button
                key={f.key}
                type="button"
                className="tm-seg-btn"
                aria-pressed={filter === f.key}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
                <em>{all.filter(f.test).length}</em>
              </button>
            ))}
          </div>
          <label className="tm-search">
            <IconSearch size={15} />
            <input
              type="search"
              aria-label="Search invoices"
              placeholder="Search invoice, supplier or PO"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
        </div>
        <div className="tm-card-b tm-xscroll">
          {invoices.isPending ? (
            <Loading label="Loading invoices…" />
          ) : invoices.error && !invoices.data ? (
            <div className="tm-pad">
              <ErrorNotice error={invoices.error} onRetry={() => invoices.refetch()} />
            </div>
          ) : rows.length === 0 ? (
            <div className="tm-empty" style={{ padding: "48px 16px" }}>
              {all.length ? (
                <>
                  <strong>No invoices match</strong>
                  <span>Try another status or clear the search.</span>
                  <button
                    type="button"
                    className="tm-btn tm-btn-line tm-btn-sm"
                    onClick={() => {
                      setFilter("all");
                      setSearch("");
                    }}
                  >
                    Show all invoices
                  </button>
                </>
              ) : (
                <>
                  <strong>No invoices yet</strong>
                  <span>Add a PDF, or check what arrived in the inbox.</span>
                  {session.user.role !== "viewer" && (
                    <button
                      type="button"
                      className="tm-btn tm-btn-primary tm-btn-sm"
                      onClick={openUpload}
                    >
                      Add invoices
                    </button>
                  )}
                </>
              )}
            </div>
          ) : (
            <div
              className="tm-table tm-rows-wide tm-compact"
              role="table"
              aria-label={`${active.label} invoices`}
            >
              <div className="tm-row tm-thead tm-cols-inv" role="row">
                <span role="columnheader">Status</span>
                <span role="columnheader">Invoice</span>
                <span role="columnheader" className="tm-wide-only">
                  Supplier
                </span>
                <span role="columnheader" className="tm-wide-only">
                  PO
                </span>
                <span role="columnheader" className="tm-r">
                  Amount
                </span>
                <span role="columnheader" className="tm-wide-only">
                  Next step
                </span>
                <span role="columnheader" className="tm-r tm-wide-only">
                  Due
                </span>
                <span role="columnheader" className="tm-r tm-wide-only">
                  Received
                </span>
              </div>
              {rows.map((row) => {
                const supplier = supplierLabel(row, names);
                return (
                  <div className="tm-row is-link tm-cols-inv" role="row" key={row.id}>
                    <span role="cell">
                      <StatusPill status={row.status} />
                    </span>
                    <span role="cell" className="tm-ellipsis">
                      <Link className="tm-rowlink tm-cell-id" href={`/invoices/${row.id}`}>
                        {row.reference ??
                          (row.status === "CHECKING" ? row.filename : "No number")}
                      </Link>
                      <span className="tm-c-sub">{supplier ?? "—"}</span>
                    </span>
                    <span role="cell" className="tm-ellipsis tm-wide-only">
                      {supplier ?? "—"}
                    </span>
                    <span
                      role="cell"
                      className="tm-mono tm-muted tm-wide-only"
                      style={{ fontSize: 12.5 }}
                    >
                      {row.po_reference ?? "—"}
                    </span>
                    <span role="cell" className="tm-r tm-num" style={{ fontWeight: 550 }}>
                      {money(row.total, row.currency ?? "USD")}
                    </span>
                    <span role="cell" className="tm-cell-next tm-ellipsis tm-wide-only">
                      {nextStep(row)}
                    </span>
                    <span role="cell" className="tm-r tm-cell-meta tm-wide-only">
                      {dayLabel(row.due_date, now)}
                    </span>
                    <span role="cell" className="tm-r tm-cell-meta tm-wide-only">
                      {capitalize(receivedLabel(row.created_at, now))}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
