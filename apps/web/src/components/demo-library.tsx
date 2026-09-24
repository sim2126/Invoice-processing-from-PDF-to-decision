"use client";
import { Button } from "@/components/ui/button";
import { api, type Scenario, type Session, type UploadResult } from "@/lib/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownToLine,
  ArrowRight,
  CircleAlert,
  Copy,
  Eye,
  FileCheck2,
  FileSearch,
  FileText,
  LoaderCircle,
  Play,
  Plus,
  RotateCcw,
  ScanLine,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ErrorNotice, Policy } from "./common";
import { ScenarioPreview } from "./scenario-preview";

export function DemoLibrary({
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
  const scenarios = useQuery({
    queryKey: ["scenarios"],
    queryFn: () => api<Scenario[]>("/scenarios"),
  });
  const [preview, setPreview] = useState<Scenario | null>(null);
  const launch = useMutation({
    mutationFn: async (scenario: Scenario) => {
      const response = await fetch(`/api/scenarios/${scenario.id}/pdf`);
      if (!response.ok)
        throw new Error(
          "The sample could not be downloaded. Refresh your session and try again.",
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
  return (
    <div className="queue-page library-page">
      <div className="page-heading">
        <div>
          <h1>Demo library</h1>
          <p>A clean match. Four deliberate exceptions. All real PDFs.</p>
        </div>
        <Button variant="outline" onClick={onFresh}>
          <RotateCcw size={17} />
          Start fresh demo
        </Button>
      </div>
      <section className="library-intro" aria-label="How to try the demo">
        <div className="library-intro-copy">
          <span className="library-intro-icon">
            <FileSearch size={24} />
          </span>
          <div>
            <h2>Your test workspace is ready</h2>
            <p>
              Vendors, purchase orders and prior balances are included. Preview
              a document, then run it through the same checks as an upload.
            </p>
          </div>
        </div>
        <a
          className="button button-outline"
          href="/api/scenarios/pack"
          download
        >
          <ArrowDownToLine size={17} />
          Download demo pack (5 PDFs)
        </a>
      </section>
      <div className="library-section-heading">
        <h2>Choose a scenario</h2>
        <span>Run the clean match before the duplicate.</span>
      </div>
      <ErrorNotice error={launch.error || scenarios.error} />
      {scenarios.isPending && (
        <div className="loading-screen">
          <LoaderCircle className="spin" />
          Loading sample documents…
        </div>
      )}
      {scenarios.isError && (
        <Button variant="outline" onClick={() => scenarios.refetch()}>
          Try loading samples again
        </Button>
      )}
      <section
        className="scenario-grid"
        id="scenarios"
        aria-label="Built-in invoice samples"
      >
        {scenarios.data?.map((s, index) => {
          const Icon =
            [FileCheck2, Copy, CircleAlert, FileSearch, ScanLine][index] ||
            FileText;
          const theme =
            index === 0 ? "approved" : index === 1 ? "blocked" : "needs_review";
          return (
            <article className="scenario-card" key={s.id}>
              <div
                className={`scenario-art scenario-art-${index}`}
                aria-hidden="true"
              >
                {/* Generated from the actual PDF; the authenticated preview opens below. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/scenarios/${s.id}/preview`}
                  alt=""
                  loading="lazy"
                />
                <span className="sample-file-type">
                  <FileText size={13} /> PDF
                </span>
                <span className="scenario-number">0{index + 1}</span>
              </div>
              <div className="scenario-copy">
                <div className="scenario-kind">
                  <Icon size={16} />
                  {index === 0 ? "HAPPY PATH" : `EDGE CASE 0${index}`}
                </div>
                <h3>{s.title}</h3>
                <p>{s.description}</p>
                <span className="scenario-expected">Expected outcome</span>
                <span className={`badge status-${theme}`}>
                  <span className="status-dot" />
                  {s.expected}
                </span>
              </div>
              <div className="scenario-actions">
                <button
                  className="scenario-run"
                  onClick={() => launch.mutate(s)}
                  disabled={launch.isPending}
                  aria-label={`Run ${s.title}`}
                >
                  {launch.isPending && launch.variables?.id === s.id ? (
                    <LoaderCircle className="spin" size={16} />
                  ) : (
                    <Play size={15} />
                  )}
                  Run scenario
                </button>
                <button
                  className="scenario-preview-button"
                  disabled={launch.isPending}
                  onClick={() => {
                    launch.reset();
                    setPreview(s);
                  }}
                  aria-label={`Preview ${s.title} PDF`}
                  title="Preview PDF"
                >
                  <Eye size={19} />
                </button>
                <a
                  href={`/api/scenarios/${s.id}/pdf`}
                  download
                  aria-label={`Download ${s.title} PDF`}
                  title="Download PDF"
                >
                  <ArrowDownToLine size={18} />
                </a>
              </div>
            </article>
          );
        })}
        {scenarios.data && (
          <article className="scenario-card own-document-card">
            <span className="own-document-icon">
              <Plus size={28} />
            </span>
            <h3>Bring your own invoice</h3>
            <p>
              Upload a PDF or readable scan. We’ll check the evidence against
              this workspace’s vendor and purchase-order records.
            </p>
            <span className="upload-limit">
              PDF · Up to {session.max_pages} pages ·{" "}
              {session.max_bytes / 1048576} MB
            </span>
            <Button variant="outline" onClick={onUpload}>
              Upload invoice
              <ArrowRight size={16} />
            </Button>
          </article>
        )}
      </section>
      {preview && (
        <ScenarioPreview
          key={preview.id}
          scenario={preview}
          onClose={() => setPreview(null)}
          onRun={() => launch.mutate(preview)}
          pending={launch.isPending}
          error={launch.error}
        />
      )}
      <footer className="page-footer">
        <span>Synthetic documents. Real extraction and checks.</span>
        <Policy />
        <span>Two-way matching · USD</span>
      </footer>
    </div>
  );
}
