"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, fileUpload, removal, type CompanyDocument } from "@/lib/api";
import { dayLabel } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { keys, useDocuments } from "@/lib/queries";
import {
  IconArchive,
  IconChevronLeft,
  IconChevronRight,
  IconExternal,
  IconEye,
  IconFile,
  IconPlus,
} from "./icons";
import { useShell } from "./shell-context";
import { Drawer, ErrorNotice, Loading } from "./ui";

const POLICY = [
  {
    title: "Matching",
    rules: [
      { text: "The supplier must be on the approved list and active.", value: "Supplier list" },
      {
        text: "The invoice must name an open purchase order from the same supplier. If none is printed, a person or a cited company document confirms it.",
        value: "Never guessed",
      },
      { text: "Each line must match an item on the order, in the same unit.", value: "Item + unit" },
    ],
  },
  {
    title: "Amounts",
    rules: [
      { text: "Unit price may exceed the order price only within both limits.", value: "≤ 1% and ≤ $1.00" },
      { text: "Lines, tax and total must add up.", value: "± $0.01" },
      {
        text: "Prices are compared net of tax; the PO budget counts the full amount including tax.",
        value: "Net price · gross budget",
      },
      {
        text: "No invoice can take an order past its limit or ordered quantity, counting everything already billed to it.",
        value: "Cumulative",
      },
    ],
  },
  {
    title: "Duplicates",
    rules: [
      { text: "Uploading the same file twice opens the original run.", value: "File fingerprint" },
      {
        text: "The same supplier, invoice number, date and total is blocked, even in a different PDF.",
        value: "Business identity",
      },
    ],
  },
  {
    title: "Decisions",
    rules: [
      {
        text: "Blocked outranks review, and approval needs every check to pass.",
        value: "Blocked › Review › Approved",
      },
      {
        text: "Approval reserves budget for payment prep. It does not pay the supplier.",
        value: "Two-way match",
      },
      {
        text: "People can confirm an order, request a correction or reject. Nobody can approve past a failed check.",
        value: "No override",
      },
    ],
  },
];

export function Policy() {
  return (
    <div className="tm-view">
      <div className="tm-head">
        <div>
          <h1>Policy AP-2026.1</h1>
          <p>
            The rules every run applies. AI reads the document and writes the
            explanation; these rules make the decision.
          </p>
        </div>
      </div>
      <div className="tm-policy">
        <section className="tm-card" aria-labelledby="tm-rules">
          <h2 id="tm-rules" className="tm-sr">
            Rules
          </h2>
          <div className="tm-card-b" tabIndex={0} role="region" aria-label="Rules, scrollable">

            {POLICY.map((group) => (
              <div className="tm-pad" key={group.title} style={{ borderBottom: "1px solid var(--line)" }}>
                <h2 style={{ fontSize: 13.5, fontWeight: 600, paddingBottom: 6 }}>{group.title}</h2>
                <ul>
                  {group.rules.map((rule) => (
                    <li className="tm-rule" key={rule.text}>
                      <span style={{ fontSize: 13.5, color: "var(--ink-2)" }}>{rule.text}</span>
                      <span className="tm-tag">{rule.value}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
        <CompanyDocuments />
      </div>
    </div>
  );
}

function CompanyDocuments() {
  const { session, notify } = useShell();
  const client = useQueryClient();
  const now = useNow();
  const documents = useDocuments();
  const [preview, setPreview] = useState<{ doc: CompanyDocument; key: number } | null>(null);
  const canAct = session.user.role !== "viewer";
  const upload = useMutation({
    mutationFn: (file: File) =>
      api<CompanyDocument>("/documents", fileUpload(session.csrf, file)),
    onSuccess: async (doc) => {
      await client.invalidateQueries({ queryKey: keys.documents });
      notify(`Added · ${doc.filename}`);
    },
  });
  const archive = useMutation({
    mutationFn: (doc: CompanyDocument) =>
      api<void>(`/documents/${encodeURIComponent(doc.id)}`, removal(session.csrf)),
    onSuccess: async (_, doc) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: keys.documents }),
        client.invalidateQueries({ queryKey: keys.inbox }),
      ]);
      notify(`Archived · ${doc.filename}`);
    },
  });
  const list = documents.data ?? [];
  return (
    <section className="tm-card" aria-labelledby="tm-documents" id="documents">
      <div className="tm-card-h">
        <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
          <h2 id="tm-documents">Company documents</h2>
          <span className="tm-faint" style={{ fontSize: 12 }}>
            {list.length} active · AI cites them as evidence
          </span>
        </div>
        {canAct && (
          <label className="tm-btn tm-btn-line tm-btn-sm">
            <IconPlus size={14} />
            {upload.isPending ? "Reading…" : "Add a PDF"}
            <input
              className="tm-sr"
              type="file"
              accept="application/pdf,.pdf"
              aria-label="Add a company document (PDF)"
              disabled={upload.isPending}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) upload.mutate(file);
                event.target.value = "";
              }}
            />
          </label>
        )}
      </div>
      <div className="tm-card-b">
        <p className="tm-muted" style={{ fontSize: 12.5, padding: "12px 16px 4px" }}>
          When an invoice has no purchase order, the AI reads these and quotes
          them. A document only settles the order when it names the invoice,
          the supplier and the PO together.
        </p>
        <div className="tm-pad" style={{ paddingTop: 8, paddingBottom: 0 }}>
          <ErrorNotice error={documents.error ?? upload.error ?? archive.error} />
        </div>
        {documents.isPending ? (
          <Loading label="Loading documents…" />
        ) : list.length === 0 ? (
          <div className="tm-empty" style={{ minHeight: 0, padding: "28px 16px" }}>
            <strong>No company documents yet</strong>
            <span>Add project assignments or supplier letters as PDFs.</span>
          </div>
        ) : (
          <ul aria-label="Company documents">
            {list.map((doc) => (
              <li className="tm-doc-row" key={doc.id}>
                <IconFile size={17} style={{ color: "var(--faint)" }} />
                <div style={{ minWidth: 0 }}>
                  <div className="tm-ellipsis" style={{ fontWeight: 550, fontSize: 13 }}>
                    {doc.filename}
                  </div>
                  <div className="tm-faint" style={{ fontSize: 12 }}>
                    {doc.pages} {doc.pages === 1 ? "page" : "pages"} · added by {doc.uploaded_by} ·{" "}
                    {dayLabel(doc.created_at, now)}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 2 }}>
                  <button
                    type="button"
                    className="tm-icon-btn"
                    aria-label={`Preview ${doc.filename}`}
                    onClick={() => setPreview((p) => ({ doc, key: (p?.key ?? 0) + 1 }))}
                  >
                    <IconEye size={16} />
                  </button>
                  {canAct && (
                    <button
                      type="button"
                      className="tm-icon-btn"
                      aria-label={`Archive ${doc.filename}`}
                      disabled={archive.isPending}
                      onClick={() => archive.mutate(doc)}
                    >
                      <IconArchive size={16} />
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      {preview && (
        <DocumentPreview
          key={preview.key}
          doc={preview.doc}
          onClose={() => setPreview(null)}
        />
      )}
    </section>
  );
}

function DocumentPreview({ doc, onClose }: { doc: CompanyDocument; onClose: () => void }) {
  const [page, setPage] = useState(1);
  return (
    <Drawer
      open
      onOpenChange={(open) => !open && onClose()}
      title={doc.filename}
      description={`Added by ${doc.uploaded_by} · ${doc.pages} ${doc.pages === 1 ? "page" : "pages"}`}
    >
      <div className="tm-drawer-b">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <div className="tm-pager" role="group" aria-label="Pages">
            <button
              type="button"
              className="tm-icon-btn"
              aria-label="Previous page"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              <IconChevronLeft size={15} />
            </button>
            <span className="tm-pager-label" aria-live="polite">
              <span className="tm-sr">Page </span>
              {page}/{doc.pages}
            </span>
            <button
              type="button"
              className="tm-icon-btn"
              aria-label="Next page"
              disabled={page >= doc.pages}
              onClick={() => setPage(page + 1)}
            >
              <IconChevronRight size={15} />
            </button>
          </div>
          <a
            className="tm-link"
            href={`/api/documents/${encodeURIComponent(doc.id)}/source`}
            target="_blank"
            rel="noreferrer"
          >
            Open the PDF
            <IconExternal size={13} />
            <span className="tm-sr"> (opens in a new tab)</span>
          </a>
        </div>
        <div className="tm-preview">
          {/* Server-rendered page image; the PDF itself is never embedded. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/documents/${encodeURIComponent(doc.id)}/pages/${page}`}
            alt={`${doc.filename}, page ${page} of ${doc.pages}`}
          />
        </div>
      </div>
    </Drawer>
  );
}
