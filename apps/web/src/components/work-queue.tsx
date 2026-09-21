"use client";
import { Button } from "@/components/ui/button";
import {
  amount,
  api,
  stamp,
  type Queue,
  type Scenario,
  type Session,
  type UploadResult,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownToLine,
  ArrowRight,
  CheckCheck,
  ChevronRight,
  CircleAlert,
  Clock3,
  Copy,
  FileCheck2,
  FileSearch,
  FileText,
  Inbox,
  LoaderCircle,
  Play,
  Plus,
  RotateCcw,
  ScanLine,
  Search,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Badge, ErrorNotice, Metric, Policy, status } from "./common";

export function WorkQueue({
  session,
  onUpload,
  onFresh,
}: {
  session: Session;
  onUpload: () => void;
  onFresh: () => void;
}) {
  const router = useRouter();
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["queue", session.workspace],
    queryFn: () => api<Queue>("/invoices"),
    refetchInterval: 5000,
  });
  const scenarios = useQuery({
    queryKey: ["scenarios"],
    queryFn: () => api<Scenario[]>("/scenarios"),
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
  const [filter, setFilter] = useState("ALL");
  const [sort, setSort] = useState("newest");
  const launch = useMutation({
    mutationFn: async (scenario: Scenario) => {
      const response = await fetch(`/api/scenarios/${scenario.id}/pdf`);
      if (!response.ok)
        throw new Error(
          "The sample document could not be downloaded. Refresh your session and try again.",
        );
      const body = new FormData();
      body.append("file", await response.blob(), scenario.file);
      return api<UploadResult>("/invoices", {
        method: "POST",
        headers: { "X-CSRF-Token": session.csrf },
        body,
      });
    },
    onSuccess: async (data) => {
      await client.invalidateQueries({ queryKey: ["queue"] });
      router.push(`/invoices/${data.id}`);
    },
  });
  const all = query.data?.invoices || [];
  const rows = all
    .filter(
      (i) =>
        (filter === "ALL" ||
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
          <div className="eyebrow">ACCOUNTS PAYABLE</div>
          <h1>
            Invoice queue<span className="heading-dot">.</span>
          </h1>
          <p>A clear view of what’s ready, and what needs a closer look.</p>
        </div>
        <Button onClick={onUpload}>
          <Plus size={18} /> Upload invoice
        </Button>
      </div>
      <section className="metrics" aria-label="Session metrics">
        <Metric
          label="Invoices processed"
          value={String(metrics?.processed ?? "—")}
          detail={`${metrics?.uploaded ?? 0} uploaded this session`}
          icon={<FileCheck2 size={18} />}
        />
        <Metric
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
          label="Automatically approved"
          value={metrics?.auto_rate == null ? "—" : `${metrics.auto_rate}%`}
          detail={`${metrics?.auto_approved ?? 0} approved without human changes`}
          icon={<CheckCheck size={18} />}
        />
        <Metric
          label="Median processing time"
          value={
            metrics?.median_seconds == null ? "—" : `${metrics.median_seconds}s`
          }
          detail={`${metrics?.duration_samples ?? 0} completed · ${metrics?.failed ?? 0} failed`}
          icon={<Clock3 size={18} />}
        />
      </section>
      <div className="scope-note">
        <span className="tiny-dot" />
        Current demo session · Unique invoices · Seeded history excluded
      </div>
      <section className="queue-surface" aria-label="Invoice work queue">
        <div
          className="table-tabs"
          role="group"
          aria-label="Filter invoice status"
        >
          {[
            ["ALL", "All invoices"],
            ["NEEDS_REVIEW", "Needs review"],
            ["APPROVED", "Approved"],
            ["BLOCKED", "Blocked"],
            ["PROCESSING", "Processing"],
            ["FAILED", "Failed"],
          ].map(([key, label]) => (
            <button
              key={key}
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
              className={cn("table-tab", filter === key && "selected")}
            >
              {label}
              <span>
                {key === "ALL"
                  ? all.length
                  : all.filter((i) =>
                      key === "PROCESSING"
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
                <th>Invoice / vendor</th>
                <th className="amount-cell">Amount</th>
                <th>Purchase order</th>
                <th>Status</th>
                <th>Next step</th>
                <th>Received</th>
                <th>
                  <span className="sr-only">Open</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id}>
                  <td>
                    <Link className="invoice-link" href={`/invoices/${i.id}`}>
                      <span className="file-cell">
                        <FileText size={18} />
                      </span>
                      <span>
                        <strong>{i.reference || i.filename}</strong>
                        <small>{i.vendor || "Reading document…"}</small>
                      </span>
                    </Link>
                  </td>
                  <td className="amount-cell">
                    <strong>{amount(i.total, i.currency || "USD")}</strong>
                    <small>{i.currency || "—"}</small>
                  </td>
                  <td>
                    <span className="po-tag">
                      {i.po_reference || "Not matched"}
                    </span>
                  </td>
                  <td>
                    <Badge state={status(i)} />
                  </td>
                  <td className="reason-cell">
                    <span title={i.summary}>
                      {i.outcome === "APPROVED" && i.execution === "COMPLETED"
                        ? "Ready for the next AP step"
                        : i.summary}
                    </span>
                  </td>
                  <td className="received-cell">{stamp(i.created_at)}</td>
                  <td>
                    <Link
                      className="row-arrow"
                      href={`/invoices/${i.id}`}
                      aria-label={`Review ${i.reference || i.filename}`}
                    >
                      <ChevronRight size={17} />
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
                {all.length
                  ? "No invoices match this view"
                  : "Your next clear decision starts here"}
              </h2>
              <p>
                {all.length
                  ? "Try another status or search term."
                  : "Upload an invoice, or try a scenario below. We’ll read the document, check the purchase order, and show the next step."}
              </p>
              <Button
                variant="outline"
                onClick={
                  all.length
                    ? () => {
                        setFilter("ALL");
                        setSearch("");
                      }
                    : onUpload
                }
              >
                {all.length ? "Clear filters" : "Upload your first invoice"}
                <ArrowRight size={15} />
              </Button>
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
      <section className="scenarios" id="scenarios">
        <div className="section-heading">
          <div>
            <span className="eyebrow">TAKE THE WORKFLOW FOR A SPIN</span>
            <h2>Real PDFs. Deliberate exceptions.</h2>
          </div>
          <button className="text-button" onClick={onFresh}>
            <RotateCcw size={14} />
            Start fresh demo
          </button>
        </div>
        <p className="scenario-intro">
          Five synthetic scenarios, using the same upload and extraction flow as
          your invoices.
        </p>
        <ErrorNotice error={launch.error || scenarios.error} />
        <div className="scenario-grid">
          {scenarios.data?.map((s, index) => {
            const Icon =
              [FileCheck2, Copy, CircleAlert, FileSearch, ScanLine][index] ||
              FileText;
            return (
              <article className="scenario-card" key={s.id}>
                <div className="scenario-top">
                  <span className={`scenario-symbol scenario-${index}`}>
                    <Icon size={19} />
                  </span>
                  <span className="scenario-number">0{index + 1}</span>
                </div>
                <h3>{s.title}</h3>
                <p>{s.description}</p>
                <span className="expected">{s.expected}</span>
                <div className="scenario-actions">
                  <button
                    onClick={() => launch.mutate(s)}
                    disabled={launch.isPending}
                    aria-label={`Run ${s.title}`}
                  >
                    {launch.isPending && launch.variables?.id === s.id ? (
                      <LoaderCircle className="spin" size={14} />
                    ) : (
                      <Play size={13} />
                    )}
                    Run scenario
                  </button>
                  <a
                    href={`/api/scenarios/${s.id}/pdf`}
                    download
                    aria-label={`Download ${s.title} PDF`}
                  >
                    <ArrowDownToLine size={16} />
                  </a>
                </div>
              </article>
            );
          })}
        </div>
      </section>
      <footer className="page-footer">
        <span>Designed for a considered decision.</span>
        <Policy />
        <span>Two-way matching · USD</span>
      </footer>
    </div>
  );
}
