"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpRight,
  Eye,
  FileText,
  LoaderCircle,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import { api, stamp, type Session, type CompanyDocument } from "@/lib/api";
import { Button } from "../ui/button";
import { Dialog, DialogContent } from "../ui/dialog";
import { ErrorNotice } from "../common";
import { DemoLibrary } from "../demo-library";
import { Pending, PageHeading } from "./shared";

export function Documents({
  session,
  onUpload,
  onFresh,
  initialSamples = false,
}: {
  session: Session;
  onUpload: () => void;
  onFresh: () => void;
  initialSamples?: boolean;
}) {
  const [tab, setTab] = useState(initialSamples ? "samples" : "references");
  return (
    <div className="product-page documents-page">
      <PageHeading
        title="Documents"
        description="Company references and sample invoices, ready to open and use."
      />
      <div
        className="product-tabs settings-tabs"
        role="group"
        aria-label="Document sections"
      >
        <button
          aria-pressed={tab === "references"}
          onClick={() => setTab("references")}
        >
          Company references
        </button>
        <button
          aria-pressed={tab === "samples"}
          onClick={() => setTab("samples")}
        >
          Sample invoices
        </button>
      </div>
      {tab === "samples" ? (
        <DemoLibrary session={session} onUpload={onUpload} onFresh={onFresh} />
      ) : (
        <ReferenceDocuments session={session} />
      )}
    </div>
  );
}

function ReferenceDocuments({ session }: { session: Session }) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["documents", session.workspace],
    queryFn: () => api<CompanyDocument[]>("/documents"),
  });
  const [selected, setSelected] = useState<CompanyDocument | null>(null);
  const [page, setPage] = useState(1);
  const upload = useMutation({
    mutationFn: (file: File) => {
      const body = new FormData();
      body.append("file", file);
      return api<CompanyDocument>("/documents", {
        method: "POST",
        headers: { "X-CSRF-Token": session.csrf },
        body,
      });
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ["documents"] }),
  });
  const archive = useMutation({
    mutationFn: (id: string) =>
      api<void>(`/documents/${id}`, {
        method: "DELETE",
        headers: { "X-CSRF-Token": session.csrf },
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["documents"] }),
  });
  const addExample = useMutation({
    mutationFn: async () => {
      const source = await fetch("/api/scenarios/ambiguous/reference");
      if (!source.ok)
        throw new Error("The example reference could not be loaded.");
      return upload.mutateAsync(
        new File([await source.blob()], "project-assignment.pdf", {
          type: "application/pdf",
        }),
      );
    },
  });
  return (
    <>
      <section className="settings-card">
        <div className="document-heading">
          <div>
            <h2>Company references</h2>
            <p>
              Add project assignments or supplier reference PDFs for AI review.
            </p>
          </div>
          {session.user.role !== "viewer" && (
            <label
              className={`button button-outline upload-reference ${upload.isPending ? "upload-pending" : ""}`}
            >
              {upload.isPending ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <Plus size={17} />
              )}{" "}
              {upload.isPending ? "Reading document…" : "Upload document"}
              <input
                aria-label="Upload reference PDF"
                type="file"
                accept="application/pdf"
                disabled={upload.isPending}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) upload.mutate(file);
                  e.target.value = "";
                }}
              />
            </label>
          )}
        </div>
        <ErrorNotice error={query.error || upload.error || archive.error} />
        {query.isPending ? (
          <Pending />
        ) : (
          <div className="record-list">
            {query.data?.map((d) => (
              <div className="record-row" key={d.id}>
                <FileText size={23} />
                <div>
                  <strong>{d.filename}</strong>
                  <small>
                    {d.pages} pages · Uploaded by {d.uploaded_by} ·{" "}
                    {stamp(d.created_at)}
                  </small>
                </div>
                <Button
                  variant="outline"
                  aria-label={`Preview ${d.filename}`}
                  onClick={() => {
                    setSelected(d);
                    setPage(1);
                  }}
                >
                  <Eye size={17} />
                  Open
                </Button>
                {session.user.role !== "viewer" && (
                  <Button
                    variant="outline"
                    aria-label={`Archive ${d.filename}`}
                    disabled={archive.isPending}
                    onClick={() => archive.mutate(d.id)}
                  >
                    <Trash2 size={16} />
                    <span className="desktop-only">Archive</span>
                  </Button>
                )}
              </div>
            ))}
            {!query.data?.length && (
              <div className="product-empty">
                <FileText size={30} />
                <h3>Your company knowledge, in one place</h3>
                <p>
                  Upload a readable PDF. AI can cite relevant passages when
                  processing the next invoice.
                </p>
              </div>
            )}
          </div>
        )}
        <ErrorNotice error={addExample.error} />
        <div className="reference-example">
          <div>
            <strong>Try an evidence-backed PO match</strong>
            <p>
              Add the sample project assignment, then open “Two possible orders”
              and choose “Ask AI to review.”
            </p>
          </div>
          <Button
            variant="outline"
            disabled={
              addExample.isPending ||
              upload.isPending ||
              session.user.role === "viewer"
            }
            onClick={() => addExample.mutate()}
          >
            Add example reference
          </Button>
          <a
            href="/api/scenarios/ambiguous/reference"
            className="text-button"
            download
          >
            Download PDF
          </a>
        </div>
        <div className="reference-note">
          <Sparkles size={19} />
          <p>
            To resolve a missing purchase order, a reference should explicitly
            link the invoice number, supplier identifier, and PO number.
            Conflicting matches remain in To-do. Up to 20 PDFs, 10 pages each.
          </p>
        </div>
      </section>
      <Dialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <DialogContent
          className="reference-preview"
          title={selected?.filename || "Document preview"}
          description={
            selected
              ? `Uploaded by ${selected.uploaded_by} · Page ${page} of ${selected.pages}`
              : ""
          }
        >
          {selected && (
            <>
              <div className="preview-controls">
                <Button
                  variant="outline"
                  disabled={page <= 1}
                  onClick={() => setPage(page - 1)}
                >
                  Previous
                </Button>
                <span>
                  {page} / {selected.pages}
                </span>
                <Button
                  variant="outline"
                  disabled={page >= selected.pages}
                  onClick={() => setPage(page + 1)}
                >
                  Next
                </Button>
                <a
                  className="button button-outline"
                  href={`/api/documents/${selected.id}/source`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open PDF <ArrowUpRight size={16} />
                </a>
              </div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                className="reference-page-image"
                alt={`${selected.filename}, page ${page}`}
                src={`/api/documents/${selected.id}/pages/${page}`}
              />
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
