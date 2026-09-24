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
  Users,
  Files,
  Settings2,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  ScanLine,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ErrorNotice, status } from "./common";
import { Documents, Suppliers, Settings, Profile } from "./product-pages";
import { InvoiceWorkspace } from "./invoice-workspace";
import { UploadDialog } from "./upload-dialog";
import { WorkQueue } from "./work-queue";

type DeskView =
  | "all"
  | "attention"
  | "demo"
  | "documents"
  | "suppliers"
  | "settings"
  | "profile";

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
        aria-label={`To-do${attention ? ` (${attention})` : ""}`}
        aria-current={view === "attention" ? "page" : undefined}
        onClick={onNavigate}
      >
        <ClipboardList size={21} />
        <span className="nav-label">To-do</span>
        {attention > 0 && <span className="nav-count">{attention}</span>}
      </Link>
      {(
        [
          ["suppliers", "Suppliers", Users],
          ["documents", "Documents", Files],
          ["settings", "Settings", Settings2],
        ] as const
      ).map(([key, label, Icon]) => (
        <Link
          key={key}
          className={`nav-item ${view === key || (key === "documents" && view === "demo") ? "active" : ""}`}
          href={`/${key}`}
          aria-label={label}
          aria-current={view === key ? "page" : undefined}
          onClick={onNavigate}
        >
          <Icon size={21} />
          <span className="nav-label">{label}</span>
        </Link>
      ))}
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
  const company = session.data?.company.name || "AP Review Desk";
  const user = session.data?.user;
  const initials = (user?.name || "Prabhakar Kumar")
    .split(" ")
    .map((n) => n[0])
    .slice(0, 2)
    .join("");
  const titles: Record<DeskView, string> = {
    all: "Invoices",
    attention: "To-do",
    demo: "Documents",
    documents: "Documents",
    suppliers: "Suppliers",
    settings: "Settings",
    profile: "Your profile",
  };
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
              {company}
              <span className="brand-sub">AP Review Desk</span>
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
        <Link
          href="/profile"
          className="sidebar-bottom profile-link"
          aria-label="Your profile"
        >
          <div className="company-avatar">{initials}</div>
          <div className="company-details">
            <strong>{user?.name || "Your profile"}</strong>
            <span>{user?.email || "Account settings"}</span>
          </div>
          <ChevronRight size={16} />
        </Link>
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
            <span>{company}</span>
            <ChevronRight size={13} />
            <strong>{invoiceId ? "Invoice review" : titles[view]}</strong>
          </div>
          <div className="topbar-right">
            <Link
              className="session-avatar"
              href="/profile"
              aria-label="Open your profile"
            >
              {initials}
            </Link>
          </div>
        </header>
        <main id="main">
          {session.isPending ? (
            <div className="loading-screen">
              <LoaderCircle className="spin" />
              Opening your workspace…
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
                Start a fresh workspace
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
                ) : view === "demo" || view === "documents" ? (
                  <Documents
                    session={session.data}
                    initialSamples={view === "demo"}
                    onUpload={() => setUploadOpen(true)}
                    onFresh={() => setFreshOpen(true)}
                  />
                ) : view === "suppliers" ? (
                  <Suppliers session={session.data} />
                ) : view === "settings" ? (
                  <Settings
                    session={session.data}
                    onFresh={() => setFreshOpen(true)}
                  />
                ) : view === "profile" ? (
                  <Profile session={session.data} />
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
          description={company}
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
              Start fresh workspace
            </Button>
          </div>
          <ErrorNotice error={fresh.error} />
        </DialogContent>
      </Dialog>
    </div>
  );
}
