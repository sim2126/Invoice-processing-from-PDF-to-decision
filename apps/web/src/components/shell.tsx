"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, ApiError, getSession, type Session } from "@/lib/api";
import { initials } from "@/lib/format";
import { detailOptions, useInvoices } from "@/lib/queries";
import { ShellContext, type Shell } from "./shell-context";
import {
  IconChevronRight,
  IconInvoices,
  IconOrders,
  IconOverview,
  IconPlus,
  IconPolicy,
  IconSelector,
  IconSuppliers,
  IconTick,
  Logo,
} from "./icons";
import { Confirm, ErrorNotice, Loading } from "./ui";
import { UploadPanel } from "./upload-panel";

const NAV = [
  { href: "/", label: "Overview", Icon: IconOverview },
  { href: "/invoices", label: "Invoices", Icon: IconInvoices },
  { href: "/suppliers", label: "Suppliers", Icon: IconSuppliers },
  { href: "/purchase-orders", label: "Purchase orders", Icon: IconOrders },
  { href: "/policy", label: "Policy", Icon: IconPolicy },
] as const;

const PAGE_NAMES: Record<string, string> = {
  "/": "Overview",
  "/invoices": "Invoices",
  "/suppliers": "Suppliers",
  "/purchase-orders": "Purchase orders",
  "/policy": "Policy",
};

const ROLE: Record<Session["user"]["role"], string> = {
  owner: "Owner",
  reviewer: "Reviewer",
  viewer: "Viewer",
};

function isActive(pathname: string, href: string) {
  return href === "/"
    ? pathname === "/"
    : pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const client = useQueryClient();
  const session = useQuery({
    queryKey: ["session"],
    queryFn: getSession,
    retry: false,
    staleTime: 300_000,
  });
  const ready = session.data;
  const invoices = useInvoices(!!ready);
  const review =
    invoices.data?.invoices.filter((i) => i.status === "NEEDS_REVIEW")
      .length ?? 0;
  const [upload, setUpload] = useState({ open: false, key: 0 });
  const [freshOpen, setFreshOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const notify = useCallback((text: string) => {
    clearTimeout(timer.current);
    setToast(text);
    timer.current = setTimeout(() => setToast(null), 3200);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  const openUpload = useCallback(
    () => setUpload((u) => ({ open: true, key: u.key + 1 })),
    [],
  );
  const fresh = useMutation({
    mutationFn: () => api<Session>("/session", { method: "POST" }),
    onSuccess: (data) => {
      client.clear();
      client.setQueryData(["session"], data);
      sessionStorage.setItem("ap_started", "1");
      setFreshOpen(false);
      router.push("/");
      notify("Fresh workspace ready");
    },
  });
  const shell = useMemo<Shell | null>(
    () => (ready ? { session: ready, notify, openUpload } : null),
    [ready, notify, openUpload],
  );

  const ended =
    session.error instanceof ApiError && session.error.status === 401;
  if (session.error && (!ready || ended)) {
    return (
      <main id="main" className="tm-full">
        <div>
          <Logo size={40} />
          <h1>{ended ? "Your session has ended" : "We couldn’t connect"}</h1>
          <p className="tm-muted">{session.error.message}</p>
          <button
            className="tm-btn tm-btn-primary"
            onClick={() => fresh.mutate()}
            disabled={fresh.isPending}
          >
            {fresh.isPending ? "Starting…" : "Start a fresh workspace"}
          </button>
          {!ended && (
            <button
              className="tm-btn tm-btn-line"
              onClick={() => session.refetch()}
            >
              Try again
            </button>
          )}
          <ErrorNotice error={fresh.error} />
        </div>
      </main>
    );
  }

  const company = ready?.company.name ?? "Juniper Labs";
  return (
    <ShellContext.Provider value={shell}>
      <div className="tm-app">
        <a className="tm-skip" href="#main">
          Skip to main content
        </a>
        <div className="tm-side">
          <Link href="/" className="tm-brand">
            <Logo />
            <span className="tm-wordmark">Tickmark</span>
          </Link>
          <div className="tm-ws">
            <span className="tm-ws-mark" aria-hidden="true">
              {initials(company)}
            </span>
            <div className="tm-stack-text">
              <span style={{ fontWeight: 550, fontSize: 13.5 }}>{company}</span>
              <span className="tm-faint" style={{ fontSize: 12 }}>
                Accounts payable · {ready?.company.currency ?? "USD"}
              </span>
            </div>
          </div>
          <nav className="tm-nav" aria-label="Main">
            <span className="tm-nav-label">Workspace</span>
            {NAV.map(({ href, label, Icon }) => (
              <Link
                key={href}
                href={href}
                className="tm-nav-item"
                aria-current={isActive(pathname, href) ? "page" : undefined}
              >
                <Icon size={17} />
                {label}
                {href === "/invoices" && review > 0 && (
                  <span className="tm-count">
                    <span aria-hidden="true">{review}</span>
                    <span className="tm-sr">, {review} need review</span>
                  </span>
                )}
              </Link>
            ))}
          </nav>
          {ready && (
            <UserMenu session={ready} onFresh={() => setFreshOpen(true)} />
          )}
        </div>
        <div className="tm-main">
          <header className="tm-top">
            <Crumbs pathname={pathname} enabled={!!ready} />
            {ready && ready.user.role !== "viewer" && (
              <button className="tm-btn tm-btn-primary" onClick={openUpload}>
                <IconPlus size={16} />
                <span className="tm-btn-label">Add invoices</span>
              </button>
            )}
          </header>
          <main id="main" className="tm-page" tabIndex={-1}>
            {ready ? (
              <>
                {!ready.extraction_ready && (
                  <div className="tm-banner" role="note" style={{ marginBottom: 16 }}>
                    Reading new invoices is paused right now. Anything you add is
                    saved and can be read again once it’s back.
                  </div>
                )}
                {children}
              </>
            ) : (
              <Loading label="Opening your workspace…" />
            )}
          </main>
        </div>
      </div>
      {ready && upload.open && (
        <UploadPanel
          key={upload.key}
          onClose={() => setUpload((u) => ({ ...u, open: false }))}
        />
      )}
      <Confirm
        open={freshOpen}
        onOpenChange={setFreshOpen}
        title="Start a fresh workspace"
        description={`Opens a new ${company} workspace with the original suppliers, orders, balances and invoice history. This one stays as it is, and this browser switches to the new one.`}
      >
        <ErrorNotice error={fresh.error} />
        <div className="tm-dialog-actions">
          <button
            className="tm-btn tm-btn-line"
            onClick={() => setFreshOpen(false)}
          >
            Keep this workspace
          </button>
          <button
            className="tm-btn tm-btn-primary"
            onClick={() => fresh.mutate()}
            disabled={fresh.isPending}
          >
            {fresh.isPending ? "Starting…" : "Start fresh workspace"}
          </button>
        </div>
      </Confirm>
      <div role="status" aria-live="polite" className="tm-toast-region">
        {toast && (
          <div className="tm-toast">
            <IconTick size={15} style={{ color: "#7EE2A8" }} />
            {toast}
          </div>
        )}
      </div>
    </ShellContext.Provider>
  );
}

function Crumbs({ pathname, enabled }: { pathname: string; enabled: boolean }) {
  const match = /^\/invoices\/([^/]+)/.exec(pathname);
  const id = match ? decodeURIComponent(match[1]) : "";
  const detail = useQuery({ ...detailOptions(id), enabled: enabled && !!id });
  let current = PAGE_NAMES[pathname] ?? "Tickmark";
  if (id) {
    const invoice = detail.data?.invoice;
    current = invoice
      ? invoice.reference ||
        (invoice.status === "CHECKING" ? "New invoice" : "Invoice without a number")
      : "Invoice";
  }
  return (
    <nav className="tm-crumbs" aria-label="Breadcrumb">
      <ol>
        {id && (
          <li>
            <Link className="tm-crumb-link" href="/invoices">
              Invoices
            </Link>
            <IconChevronRight size={14} />
          </li>
        )}
        <li>
          <span aria-current="page" className="tm-ellipsis">
            {current}
          </span>
        </li>
      </ol>
    </nav>
  );
}

function UserMenu({
  session,
  onFresh,
}: {
  session: Session;
  onFresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <div className="tm-side-foot" ref={root}>
      <button
        ref={button}
        className="tm-user"
        aria-expanded={open}
        aria-controls="tm-user-menu"
        aria-label={`${session.user.name}, account menu`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="tm-avatar" aria-hidden="true">
          {initials(session.user.name)}
        </span>
        <span className="tm-stack-text tm-user-text" style={{ flex: 1 }}>
          <span style={{ fontWeight: 550, fontSize: 13 }}>{session.user.name}</span>
          <span className="tm-faint" style={{ fontSize: 12 }}>
            AP team · {ROLE[session.user.role]}
          </span>
        </span>
        <IconSelector size={15} className="tm-user-text tm-faint" />
      </button>
      <div className="tm-menu" id="tm-user-menu" hidden={!open}>
        <button
          className="tm-menu-item"
          onClick={() => {
            setOpen(false);
            onFresh();
          }}
        >
          Start a fresh workspace
          <span>Original orders, balances and invoice history</span>
        </button>
      </div>
    </div>
  );
}
