"use client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import type { Scenario } from "@/lib/api";
import {
  ArrowDownToLine,
  LoaderCircle,
  Minus,
  Play,
  Plus,
  ScanLine,
} from "lucide-react";
import { useState } from "react";
import { ErrorNotice } from "./common";

export function ScenarioPreview({
  scenario,
  onClose,
  onRun,
  pending,
  error,
}: {
  scenario: Scenario;
  onClose: () => void;
  onRun: () => void;
  pending: boolean;
  error: Error | null;
}) {
  const [zoom, setZoom] = useState(100);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="sample-preview-dialog"
        title={scenario.title}
        description="Preview the original sample before running it. Viewing a PDF does not submit an invoice."
      >
        <div className="sample-preview-toolbar">
          <span>{scenario.file} · Page 1</span>
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
          aria-label="Sample PDF preview"
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
            // The API serves a rendering of the original PDF with session cookies.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/scenarios/${scenario.id}/preview?attempt=${attempt}`}
              alt={`Original sample invoice: ${scenario.title}`}
              style={{ width: `${zoom}%` }}
              onLoad={() => setLoaded(true)}
              onError={() => setFailed(true)}
            />
          )}
        </div>
        <div className="sample-preview-context">
          <strong>Expected: {scenario.expected}</strong>
          <p>{scenario.description}</p>
        </div>
        <ErrorNotice error={error} />
        <div className="sample-preview-actions">
          <a
            className="text-button"
            href={`/api/scenarios/${scenario.id}/pdf`}
            download
          >
            <ArrowDownToLine size={16} /> Download PDF
          </a>
          <Button onClick={onRun} disabled={pending}>
            {pending ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Play size={15} />
            )}
            {pending ? "Submitting…" : "Run this scenario"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
