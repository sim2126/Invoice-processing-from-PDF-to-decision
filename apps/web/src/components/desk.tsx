"use client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { api, ApiError, getSession, type Queue, type Session } from "@/lib/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Building2,
  ClipboardList,
  ChevronRight,
  CircleAlert,
  LayoutList,
  LoaderCircle,
  Play,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  ScanLine,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ErrorNotice, Policy, status } from "./common";
import { DemoLibrary } from "./demo-library";
import { InvoiceWorkspace } from "./invoice-workspace";
import { UploadDialog } from "./upload-dialog";
import { WorkQueue } from "./work-queue";

type DeskView = "all" | "attention" | "demo";

function Navigation({
  view,
  attention,
  onNavigate,
}: {
  view: DeskView;
  attention: number;
  onNavigate?: () => void;
}) {
  return (
    <nav aria-label="Main navigation">
      <Link
        className={`nav-item ${view === "all" ? "active" : ""}`}
        href="/"
        aria-label="Invoices"
        aria-current={view === "all" ? "page" : undefined}
        onClick={onNavigate}
      >
        <LayoutList size={21} />
        <span className="nav-label">Invoices</span>
      </Link>
      <Link
        className={`nav-item ${view === "attention" ? "active" : ""}`}
        href="/attention"
        aria-label={`Needs attention${attention ? ` (${attention})` : ""}`}
        aria-current={view === "attention" ? "page" : undefined}
        onClick={onNavigate}
      >
        <ClipboardList size={21} />
        <span className="nav-label">Needs attention</span>
        {attention > 0 && <span className="nav-count">{attention}</span>}
      </Link>
      <Link
        className={`nav-item ${view === "demo" ? "active" : ""}`}
        href="/demo"
        aria-label="Demo library"
        aria-current={view === "demo" ? "page" : undefined}
        onClick={onNavigate}
      >
        <Play size={20} />
        <span className="nav-label">Demo library</span>
      </Link>
      <Policy>
        <button className="nav-item" aria-label="Review policy">
          <ShieldCheck size={21} />
          <span className="nav-label">Review policy</span>
        </button>
      </Policy>
    </nav>
  );
}

export function Desk({
  invoiceId,
  view = "all",
}: {
  invoiceId?: string;
  view?: DeskView;
}) {
  const router = useRouter();
  const client = useQueryClient();
  const session = useQuery({
    queryKey: ["session"],
    queryFn: getSession,
    retry: false,
    staleTime: 300000,
  });
  const [uploadOpen, setUploadOpen] = useState(false);
  const [freshOpen, setFreshOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const queue = useQuery({
    queryKey: ["queue", session.data?.workspace],
    queryFn: () => api<Queue>("/invoices"),
    enabled: !!session.data,
    refetchInterval: 5000,
  });
  const attention =
    queue.data?.invoices.filter((invoice) =>
      ["NEEDS_REVIEW", "BLOCKED", "FAILED"].includes(status(invoice)),
    ).length || 0;
  const fresh = useMutation({
    mutationFn: () => api<Session>("/session", { method: "POST" }),
    onSuccess: (data) => {
      client.clear();
      client.setQueryData(["session"], data);
      sessionStorage.setItem("ap_started", "1");
      setFreshOpen(false);
      router.push("/");
    },
  });
  return (
    <div className={`app-shell ${collapsed ? "sidebar-collapsed" : ""}`}>
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <aside className="sidebar">
        <div className="sidebar-brand-row">
          <Link className="brand" href="/" aria-label="AP Review Desk home">
            <span className="brand-symbol">
              <ScanLine size={23} />
            </span>
            <span className="brand-name">
              AP Review Desk
              <span className="brand-sub">Invoice operations</span>
            </span>
          </Link>
          <button
            className="sidebar-toggle icon-button"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed(!collapsed)}
          >
            {collapsed ? (
              <PanelLeftOpen size={18} />
            ) : (
              <PanelLeftClose size={18} />
            )}
          </button>
        </div>
        <div className="workspace-label">WORKSPACE</div>
        <Navigation view={view} attention={attention} />
        <div className="sidebar-context">
          <ShieldCheck size={18} />
          <div>
            <strong>Every invoice, a clear next step.</strong>
            <p>Evidence, checks and review history in one place.</p>
          </div>
        </div>
        <div className="sidebar-bottom">
          <div className="company-avatar">NS</div>
          <div className="company-details">
            <strong>Northstar Studio</strong>
            <span>Demo workspace · USD</span>
          </div>
        </div>
      </aside>
      <div className="app-body">
        <header className="topbar">
          <button
            className="mobile-menu-button icon-button"
            aria-label="Open navigation"
            onClick={() => setMobileNavOpen(true)}
          >
            <Menu size={23} />
          </button>
          <div className="breadcrumb">
            <Building2 size={16} />
            <span>Northstar Studio</span>
            <ChevronRight size={13} />
            <strong>
              {invoiceId
                ? "Invoice review"
                : view === "demo"
                  ? "Demo library"
                  : view === "attention"
                    ? "Needs attention"
                    : "Invoices"}
            </strong>
          </div>
          <div className="topbar-right">
            <button
              className="session-avatar"
              aria-label="Start a fresh demo workspace"
              onClick={() => setFreshOpen(true)}
            >
              NS
            </button>
          </div>
        </header>
        <main id="main">
          {session.isPending ? (
            <div className="loading-screen">
              <LoaderCircle className="spin" />
              Opening your private demo workspace…
            </div>
          ) : session.error ? (
            <div className="session-error">
              <CircleAlert size={32} />
              <h1>
                {session.error instanceof ApiError &&
                session.error.status === 401
                  ? "Your session has ended"
                  : "We couldn’t connect"}
              </h1>
              <p>{session.error.message}</p>
              <Button onClick={() => fresh.mutate()} disabled={fresh.isPending}>
                Start a fresh demo
              </Button>
              <ErrorNotice error={fresh.error} />
            </div>
          ) : (
            session.data && (
              <>
                {!session.data.extraction_ready && (
                  <div className="configuration-notice">
                    <CircleAlert size={17} />
                    Document extraction is not connected. Uploads are saved;
                    processing will need a retry after configuration.
                  </div>
                )}
                {invoiceId ? (
                  <InvoiceWorkspace id={invoiceId} session={session.data} />
                ) : view === "demo" ? (
                  <DemoLibrary
                    session={session.data}
                    onUpload={() => setUploadOpen(true)}
                    onFresh={() => setFreshOpen(true)}
                  />
                ) : (
                  <WorkQueue
                    key={view}
                    attentionOnly={view === "attention"}
                    session={session.data}
                    onUpload={() => setUploadOpen(true)}
                    onFresh={() => setFreshOpen(true)}
                  />
                )}
                <UploadDialog
                  open={uploadOpen}
                  setOpen={setUploadOpen}
                  session={session.data}
                />
              </>
            )
          )}
        </main>
      </div>
      <Dialog open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <DialogContent
          className="navigation-dialog"
          title="AP Review Desk"
          description="Northstar Studio · Demo workspace"
        >
          <Navigation
            view={view}
            attention={attention}
            onNavigate={() => setMobileNavOpen(false)}
          />
        </DialogContent>
      </Dialog>
      <Dialog open={freshOpen} onOpenChange={setFreshOpen}>
        <DialogContent
          title="Start with a clean desk"
          description="Create a new isolated workspace with the original purchase-order balances. Your current workspace remains separate; this browser will switch to the new one."
        >
          <div className="dialog-actions">
            <Button variant="outline" onClick={() => setFreshOpen(false)}>
              Keep this workspace
            </Button>
            <Button onClick={() => fresh.mutate()} disabled={fresh.isPending}>
              {fresh.isPending && <LoaderCircle className="spin" size={16} />}
              Start fresh demo
            </Button>
          </div>
          <ErrorNotice error={fresh.error} />
        </DialogContent>
      </Dialog>
    </div>
  );
}
