"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  Eye,
  FileText,
  LoaderCircle,
  Minus,
  Play,
  Plus,
  ScanLine,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  amount,
  api,
  type CompanyDocument,
  type FollowUpExample,
  type Queue,
  type Session,
  type UploadResult,
} from "@/lib/api";
import { Badge, ErrorNotice, status, statusLabels } from "./common";
import { Button } from "./ui/button";
import { Dialog, DialogContent } from "./ui/dialog";

type FileKind = "invoice" | "reference";
type Preview = { example: FollowUpExample; kind: FileKind };

function sourcePath(example: FollowUpExample, kind: FileKind) {
  return `/follow-up-examples/${encodeURIComponent(example.id)}/${kind}`;
}

export function FollowUpExamples({
  session,
  onReferences,
}: {
  session: Session;
  onReferences: () => void;
}) {
  const client = useQueryClient();
  const router = useRouter();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const examples = useQuery({
    queryKey: ["follow-up-examples", session.workspace],
    queryFn: () => api<FollowUpExample[]>("/follow-up-examples"),
  });
  const queue = useQuery({
    queryKey: ["queue", session.workspace],
    queryFn: () => api<Queue>("/invoices"),
    refetchInterval: 5000,
  });
  const documents = useQuery({
    queryKey: ["documents", session.workspace],
    queryFn: () => api<CompanyDocument[]>("/documents"),
  });
  const canWrite = session.user.role !== "viewer";
  const run = useMutation({
    mutationFn: async (example: FollowUpExample) => {
      const source = await fetch(`/api${sourcePath(example, "invoice")}`);
      if (!source.ok)
        throw new Error("The invoice could not be loaded. Try again.");
      const body = new FormData();
      body.append("file", await source.blob(), example.file);
      return api<UploadResult>("/invoices", {
        method: "POST",
        headers: { "X-CSRF-Token": session.csrf },
        body,
      });
    },
    onSuccess: async (result) => {
      await client.invalidateQueries({ queryKey: ["queue"] });
      router.push(`/invoices/${result.id}`);
    },
  });
  const addReference = useMutation({
    mutationFn: async (example: FollowUpExample) => {
      const source = await fetch(`/api${sourcePath(example, "reference")}`);
      if (!source.ok)
        throw new Error(
          "The supporting document could not be loaded. Try again.",
        );
      const body = new FormData();
      body.append("file", await source.blob(), example.reference_file);
      return api<CompanyDocument>("/documents", {
        method: "POST",
        headers: { "X-CSRF-Token": session.csrf },
        body,
      });
    },
    onSuccess: async (_, example) => {
      setAdded(example.id);
      await client.invalidateQueries({ queryKey: ["documents"] });
    },
  });

  return (
    <section className="followup-examples" aria-labelledby="followup-heading">
      <div className="followup-heading">
        <div>
          <h2 id="followup-heading">From a missing detail to a decision</h2>
          <p>
            Five fictional invoice and confirmation pairs. Try the request for
            information, add the reply as a PDF, then let AI review the
            evidence.
          </p>
        </div>
        <a
          className="button button-outline"
          href="/api/follow-up-examples/pack"
          download
        >
          <ArrowDownToLine size={17} /> Download all 10 PDFs
        </a>
      </div>
      <ol className="followup-steps" aria-label="Follow-up workflow">
        {[
          "Run invoice",
          "Review AI question and draft",
          "Add supporting document",
          "Open invoice and ask AI to review",
        ].map((step, index) => (
          <li key={step}>
            <span>{index + 1}</span>
            {step}
          </li>
        ))}
      </ol>
      <p className="followup-note">
        Each invoice starts without a purchase order. Four confirmations support
        approval; one reveals a budget shortfall. Drafts are available to copy;
        no messages are sent. Outcomes also depend on your current PO balances.
      </p>
      <ErrorNotice
        error={
          examples.error ||
          queue.error ||
          documents.error ||
          run.error ||
          addReference.error
        }
      />
      {examples.isPending && (
        <div className="product-empty" role="status">
          <LoaderCircle className="spin" size={24} /> Loading follow-up
          examples…
        </div>
      )}
      {examples.isError && (
        <Button variant="outline" onClick={() => examples.refetch()}>
          Try loading examples again
        </Button>
      )}
      <div className="followup-list">
        {examples.data?.map((example, index) => {
          const invoice = queue.data?.invoices.find(
            (item) => item.filename === example.file,
          );
          const reference = documents.data?.find(
            (item) => item.filename === example.reference_file,
          );
          const isRunning = run.isPending && run.variables.id === example.id;
          const isAdding =
            addReference.isPending && addReference.variables.id === example.id;
          return (
            <article
              className="followup-card"
              key={example.id}
              data-testid={`followup-${example.id}`}
              aria-labelledby={`followup-${example.id}`}
            >
              <div className="followup-card-heading">
                <span className="followup-number" aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div className="followup-summary">
                  <h3 id={`followup-${example.id}`}>{example.title}</h3>
                  <p>
                    {example.vendor} · {example.invoice_number}
                  </p>
                </div>
                <strong className="followup-amount">
                  {amount(example.amount)}
                </strong>
                {invoice && <Badge state={status(invoice)} />}
              </div>
              <p className="followup-description">{example.description}</p>
              <dl className="followup-outcomes">
                <div>
                  <dt>Before supporting document</dt>
                  <dd>
                    {statusLabels[example.expected_before] ||
                      example.expected_before}
                  </dd>
                </div>
                <div>
                  <dt>Expected after AI review</dt>
                  <dd>
                    {statusLabels[example.expected_after] ||
                      example.expected_after}
                  </dd>
                </div>
              </dl>
              <div className="followup-files">
                <ExampleFile
                  example={example}
                  kind="invoice"
                  onPreview={() => setPreview({ example, kind: "invoice" })}
                >
                  {invoice ? (
                    <Link
                      className="button button-outline"
                      href={`/invoices/${invoice.id}`}
                    >
                      Open invoice <ArrowRight size={16} />
                    </Link>
                  ) : (
                    <Button
                      disabled={
                        !canWrite ||
                        run.isPending ||
                        queue.isPending ||
                        queue.isError
                      }
                      onClick={() => run.mutate(example)}
                      aria-label={`Run invoice ${example.invoice_number}`}
                    >
                      {isRunning ? (
                        <LoaderCircle className="spin" size={16} />
                      ) : (
                        <Play size={15} />
                      )}
                      {isRunning ? "Submitting…" : "Run invoice"}
                    </Button>
                  )}
                </ExampleFile>
                <ExampleFile
                  example={example}
                  kind="reference"
                  onPreview={() => setPreview({ example, kind: "reference" })}
                >
                  {reference ? (
                    <span className="followup-added">
                      <Check size={16} /> Added to references
                    </span>
                  ) : (
                    <Button
                      variant="outline"
                      disabled={
                        !canWrite ||
                        addReference.isPending ||
                        documents.isPending ||
                        documents.isError
                      }
                      onClick={() => {
                        setAdded(null);
                        addReference.mutate(example);
                      }}
                      aria-label={`Add supporting document for ${example.invoice_number}`}
                    >
                      {isAdding ? (
                        <LoaderCircle className="spin" size={16} />
                      ) : (
                        <Plus size={16} />
                      )}
                      {isAdding ? "Adding…" : "Add supporting document"}
                    </Button>
                  )}
                </ExampleFile>
              </div>
              {added === example.id && reference && (
                <div className="followup-success" role="status">
                  <Check size={18} />
                  <div>
                    <strong>Supporting document added.</strong>{" "}
                    {invoice ? (
                      <>
                        Open{" "}
                        <Link href={`/invoices/${invoice.id}`}>
                          {example.invoice_number}
                        </Link>{" "}
                        and choose “Ask AI to review.”
                      </>
                    ) : (
                      <>Run this invoice to let AI use the new evidence.</>
                    )}{" "}
                    <button className="text-button" onClick={onReferences}>
                      View company references
                    </button>
                  </div>
                </div>
              )}
              <p className="followup-resolution">{example.resolution}</p>
            </article>
          );
        })}
      </div>
      {preview && (
        <FollowUpPreview
          key={`${preview.example.id}-${preview.kind}`}
          preview={preview}
          onClose={() => setPreview(null)}
        />
      )}
    </section>
  );
}

function ExampleFile({
  example,
  kind,
  onPreview,
  children,
}: Preview & { onPreview: () => void; children: React.ReactNode }) {
  const filename = kind === "invoice" ? example.file : example.reference_file;
  const label = kind === "invoice" ? "Invoice" : "Supporting document";
  return (
    <div className="followup-file">
      <FileText size={22} aria-hidden="true" />
      <div className="followup-file-copy">
        <strong>{label}</strong>
        <span>
          {kind === "invoice"
            ? example.invoice_number
            : example.reference_title}
        </span>
        <small>{filename}</small>
      </div>
      <div className="followup-file-tools">
        <Button
          variant="ghost"
          size="icon"
          onClick={onPreview}
          aria-label={`Preview ${label.toLowerCase()} for ${example.invoice_number}`}
          title={`Preview ${label.toLowerCase()}`}
        >
          <Eye size={19} />
        </Button>
        <a
          className="button button-ghost button-icon"
          href={`/api${sourcePath(example, kind)}`}
          aria-label={`Download ${label.toLowerCase()} for ${example.invoice_number}`}
          title="Download PDF"
          download
        >
          <ArrowDownToLine size={18} />
        </a>
      </div>
      <div className="followup-file-action">{children}</div>
    </div>
  );
}

function FollowUpPreview({
  preview,
  onClose,
}: {
  preview: Preview;
  onClose: () => void;
}) {
  const { example, kind } = preview;
  const [zoom, setZoom] = useState(100);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const filename = kind === "invoice" ? example.file : example.reference_file;
  const title =
    kind === "invoice"
      ? `Invoice ${example.invoice_number}`
      : example.reference_title;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="sample-preview-dialog followup-preview-dialog"
        title={title}
        description="Preview the original PDF. Viewing a document does not add it to the workspace."
      >
        <div className="sample-preview-toolbar">
          <span>{filename} · Page 1</span>
          <div>
            <button
              aria-label="Zoom out preview"
              disabled={zoom <= 75}
              onClick={() => setZoom(zoom - 25)}
            >
              <Minus size={16} />
            </button>
            <span aria-live="polite">{zoom}%</span>
            <button
              aria-label="Zoom in preview"
              disabled={zoom >= 200}
              onClick={() => setZoom(zoom + 25)}
            >
              <Plus size={16} />
            </button>
            <button aria-label="Fit preview" onClick={() => setZoom(100)}>
              <ScanLine size={16} />
            </button>
          </div>
        </div>
        <div
          className="sample-preview-canvas"
          tabIndex={0}
          role="region"
          aria-label="Follow-up PDF preview"
        >
          {!loaded && !failed && (
            <p role="status">
              <LoaderCircle className="spin" size={18} /> Loading document…
            </p>
          )}
          {failed ? (
            <div className="sample-preview-error" role="alert">
              <p>
                The preview could not load. Try again or download the original
                PDF below.
              </p>
              <Button
                variant="outline"
                onClick={() => {
                  setFailed(false);
                  setLoaded(false);
                  setAttempt(attempt + 1);
                }}
              >
                Retry preview
              </Button>
            </div>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api${sourcePath(example, kind)}/preview?attempt=${attempt}`}
              alt={`${title}, original PDF page 1`}
              style={{ width: `${zoom}%` }}
              onLoad={() => setLoaded(true)}
              onError={() => setFailed(true)}
            />
          )}
        </div>
        <div className="sample-preview-context">
          <p>{kind === "invoice" ? example.description : example.resolution}</p>
        </div>
        <div className="sample-preview-actions">
          <a
            className="text-button"
            href={`/api${sourcePath(example, kind)}`}
            download
          >
            <ArrowDownToLine size={16} /> Download PDF
          </a>
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
