"use client";
import { Button } from "@/components/ui/button";
import { amount, api, stamp, type Queue, type Session } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  CheckCheck,
  CircleAlert,
  Clock3,
  FileCheck2,
  FileText,
  Inbox,
  LoaderCircle,
  Plus,
  RotateCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Badge, ErrorNotice, Metric, Policy, status } from "./common";

export function WorkQueue({
  session,
  onUpload,
  onFresh,
  attentionOnly = false,
}: {
  session: Session;
  attentionOnly?: boolean;
  onUpload: () => void;
  onFresh: () => void;
}) {
  const query = useQuery({
    queryKey: ["queue", session.workspace],
    queryFn: () => api<Queue>("/invoices"),
    refetchInterval: 5000,
  });
  const [search, setSearch] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (
        event.key === "/" &&
        !(event.target instanceof HTMLInputElement) &&
        !(event.target instanceof HTMLTextAreaElement)
      ) {
        event.preventDefault();
        searchInput.current?.focus();
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
  const [filter, setFilter] = useState(attentionOnly ? "ATTENTION" : "ALL");
  const [sort, setSort] = useState("newest");
  const all = query.data?.invoices || [];
  const caughtUp =
    attentionOnly &&
    !all.some((i) => ["NEEDS_REVIEW", "BLOCKED", "FAILED"].includes(status(i)));
  const rows = all
    .filter(
      (i) =>
        (filter === "ALL" ||
          (filter === "ATTENTION" &&
            ["NEEDS_REVIEW", "BLOCKED", "FAILED"].includes(status(i))) ||
          status(i) === filter ||
          (filter === "PROCESSING" &&
            ["RUNNING", "QUEUED"].includes(status(i)))) &&
        `${i.reference} ${i.vendor} ${i.filename} ${i.po_reference}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort((a, b) =>
      sort === "amount"
        ? Number(b.total || 0) - Number(a.total || 0)
        : sort === "oldest"
          ? a.created_at.localeCompare(b.created_at)
          : b.created_at.localeCompare(a.created_at),
    );
  const metrics = query.data?.metrics;
  return (
    <div className="queue-page">
      <div className="page-heading">
        <div>
          <h1>{attentionOnly ? "Needs attention" : "Invoices"}</h1>
          <p>
            {attentionOnly
              ? "Resolve exceptions, confirm details, and get invoices moving."
              : "Every invoice, its evidence, and a clear next step."}
          </p>
        </div>
        <Button onClick={onUpload}>
          <Plus size={18} /> Upload invoice
        </Button>
      </div>
      {!attentionOnly && (
        <>
          <section className="metrics" aria-label="Session metrics">
            <Metric
              label="Invoices processed"
              value={String(metrics?.processed ?? "—")}
              detail={`${metrics?.uploaded ?? 0} uploaded this session`}
              icon={<FileCheck2 size={18} />}
            />
            <Metric
              tone="review"
              label="Needs your review"
              value={String(metrics?.review ?? "—")}
              detail={
                metrics?.review_rate == null
                  ? "No completed invoices yet"
                  : `${metrics.review_rate}% of completed invoices`
              }
              icon={<CircleAlert size={18} />}
            />
            <Metric
              tone="approved"
              label="Automatically approved"
              value={metrics?.auto_rate == null ? "—" : `${metrics.auto_rate}%`}
              detail={`${metrics?.auto_approved ?? 0} approved without human changes`}
              icon={<CheckCheck size={18} />}
            />
            <Metric
              label="Median processing time"
              value={
                metrics?.median_seconds == null
                  ? "—"
                  : `${metrics.median_seconds}s`
              }
              detail={`${metrics?.duration_samples ?? 0} completed · ${metrics?.failed ?? 0} failed`}
              icon={<Clock3 size={18} />}
            />
          </section>
          <div className="scope-note">
            <span className="tiny-dot" />
            Current demo session · Unique invoices · Seeded history excluded
          </div>
        </>
      )}
      <section className="queue-surface" aria-label="Invoice work queue">
        <div
          className="table-tabs"
          role="group"
          aria-label="Filter invoice status"
        >
          {(attentionOnly
            ? [
                ["ATTENTION", "Needs action"],
                ["NEEDS_REVIEW", "Needs review"],
                ["BLOCKED", "Blocked"],
                ["FAILED", "Failed"],
              ]
            : [
                ["ALL", "All invoices"],
                ["NEEDS_REVIEW", "Needs review"],
                ["APPROVED", "Approved"],
                ["BLOCKED", "Blocked"],
                ["PROCESSING", "Processing"],
                ["FAILED", "Failed"],
              ]
          ).map(([key, label]) => (
            <button
              key={key}
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
              className={cn(
                "table-tab",
                `filter-${key.toLowerCase()}`,
                filter === key && "selected",
              )}
            >
              {label}
              <span>
                {key === "ALL"
                  ? all.length
                  : all.filter((i) =>
                      key === "ATTENTION"
                        ? ["NEEDS_REVIEW", "BLOCKED", "FAILED"].includes(
                            status(i),
                          )
                        : key === "PROCESSING"
                          ? ["QUEUED", "RUNNING"].includes(status(i))
                          : status(i) === key,
                    ).length}
              </span>
            </button>
          ))}
        </div>
        <div className="table-toolbar">
          <label className="searchbox">
            <Search size={17} />
            <input
              aria-label="Search invoices"
              ref={searchInput}
              placeholder="Search invoice, vendor or PO…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <kbd>/</kbd>
          </label>
          <label className="sort-select">
            <SlidersHorizontal size={15} />
            <span className="sr-only">Sort invoices</span>
            <select
              aria-label="Sort invoices"
              value={sort}
              onChange={(e) => setSort(e.target.value)}
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="amount">Highest amount</option>
            </select>
          </label>
        </div>
        <ErrorNotice error={query.error} />
        <div className="table-scroll">
          <table className="invoice-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Invoice / vendor</th>
                <th className="amount-cell">Amount</th>
                <th>Purchase order</th>
                <th>Next step</th>
                <th>
                  <span className="sr-only">Open invoice</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id}>
                  <td data-label="Status">
                    <Badge state={status(i)} />
                  </td>
                  <td className="invoice-identity" data-label="Invoice">
                    <Link className="invoice-link" href={`/invoices/${i.id}`}>
                      <strong>{i.reference || i.filename}</strong>
                      <small>{i.vendor || "Reading document…"}</small>
                    </Link>
                    <time className="received-time" dateTime={i.created_at}>
                      {stamp(i.created_at)}
                    </time>
                  </td>
                  <td className="amount-cell" data-label="Amount">
                    <strong>{amount(i.total, i.currency || "USD")}</strong>
                    <small>{i.currency || "—"}</small>
                  </td>
                  <td className="po-cell" data-label="Purchase order">
                    <span className="po-tag">
                      {i.po_reference || "Not matched"}
                    </span>
                  </td>
                  <td className="reason-cell" data-label="Next step">
                    <span title={i.summary}>
                      {i.outcome === "APPROVED" && i.execution === "COMPLETED"
                        ? "Ready for the next AP step"
                        : i.summary}
                    </span>
                  </td>
                  <td className="open-cell">
                    <Link
                      className="row-arrow"
                      href={`/invoices/${i.id}`}
                      aria-label={`Review ${i.reference || i.filename}`}
                    >
                      <ArrowRight size={18} />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {query.isPending ? (
          <div className="table-empty">
            <LoaderCircle className="spin" size={26} />
            <strong>Loading your queue…</strong>
          </div>
        ) : (
          !rows.length && (
            <div className="table-empty">
              <span className="empty-symbol">
                <Inbox size={31} />
              </span>
              <h2>
                {caughtUp
                  ? "You’re all caught up"
                  : all.length
                    ? "No invoices match this view"
                    : "Your next clear decision starts here"}
              </h2>
              <p>
                {caughtUp
                  ? "Invoices that need a decision or a retry will appear here."
                  : all.length
                    ? "Try another status or search term."
                    : "Upload an invoice, or explore the demo library. We’ll read the document, check the purchase order, and show the next step."}
              </p>
              {caughtUp && all.length > 0 ? (
                <Link className="button button-outline" href="/">
                  View all invoices <ArrowRight size={15} />
                </Link>
              ) : (
                <Button
                  variant="outline"
                  onClick={
                    all.length
                      ? () => {
                          setFilter(attentionOnly ? "ATTENTION" : "ALL");
                          setSearch("");
                        }
                      : onUpload
                  }
                >
                  {all.length ? "Clear filters" : "Upload your first invoice"}
                  <ArrowRight size={15} />
                </Button>
              )}
              {!all.length && (
                <Link className="empty-library-link" href="/demo">
                  Explore demo library <ArrowRight size={15} />
                </Link>
              )}
            </div>
          )
        )}
        <div className="table-footer">
          <span>
            {rows.length} of {all.length} invoices
          </span>
          <span>
            <ShieldCheck size={13} />
            Private to workspace {session.workspace}
          </span>
        </div>
      </section>
      <section
        className="demo-callout"
        id="scenarios"
        aria-label="Try the demo"
      >
        <span className="demo-callout-icon">
          <FileText size={22} />
        </span>
        <div>
          <h2>See how a clear decision gets made</h2>
          <p>
            Five built-in PDFs, from a clean match to the exceptions that
            matter.
          </p>
        </div>
        <Link className="button button-outline" href="/demo">
          Demo library <ArrowRight size={17} />
        </Link>
        <button className="text-button fresh-demo-link" onClick={onFresh}>
          <RotateCcw size={15} />
          Start fresh demo
        </button>
      </section>
      <footer className="page-footer">
        <span>Original evidence. Every decision recorded.</span>
        <Policy />
        <span>Two-way matching · USD</span>
      </footer>
    </div>
  );
}
