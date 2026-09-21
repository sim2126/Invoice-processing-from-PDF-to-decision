"use client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { api, ApiError, getSession, type Session } from "@/lib/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCheck,
  ChevronRight,
  CircleAlert,
  LayoutList,
  LoaderCircle,
  Play,
  ScanLine,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ErrorNotice, Policy } from "./common";
import { InvoiceWorkspace } from "./invoice-workspace";
import { UploadDialog } from "./upload-dialog";
import { WorkQueue } from "./work-queue";

export function Desk({ invoiceId }: { invoiceId?: string }) {
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
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <aside className="sidebar">
        <Link className="brand" href="/" aria-label="AP Review Desk home">
          <span className="brand-symbol">
            <ScanLine size={23} />
          </span>
          <span>
            AP Review<span className="brand-sub">DESK</span>
          </span>
        </Link>
        <div className="workspace-label">WORKSPACE</div>
        <nav aria-label="Main navigation">
          <Link className="nav-item active" href="/">
            <LayoutList size={18} /> Work queue <span className="nav-dot" />
          </Link>
          <Link className="nav-item" href="/#scenarios">
            <Play size={17} /> Demo scenarios
          </Link>
          <Policy>
            <button className="nav-item">
              <ShieldCheck size={18} /> Review policy
            </button>
          </Policy>
        </nav>
        <div className="sidebar-note">
          <span className="small-mark">
            <CheckCheck size={19} />
          </span>
          <p>
            Every invoice,
            <br />
            <strong>a clear next step.</strong>
          </p>
          <span>Evidence-led accounts payable.</span>
        </div>
        <div className="sidebar-bottom">
          <div className="company-avatar">N</div>
          <div>
            <strong>Northstar Studio</strong>
            <span>Fictional company</span>
          </div>
          <span className="company-dot" />
        </div>
      </aside>
      <div className="app-body">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Operations</span>
            <ChevronRight size={13} />
            <strong>Accounts payable</strong>
          </div>
          <div className="topbar-right">
            <span className="demo-pill">
              <span /> Synthetic demo workspace
            </span>
            <button
              className="session-avatar"
              aria-label="Start a fresh demo workspace"
              onClick={() => setFreshOpen(true)}
            >
              PK
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
                ) : (
                  <WorkQueue
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
