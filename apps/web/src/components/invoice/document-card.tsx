"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Detail, Evidence } from "@/lib/api";
import { cx } from "@/lib/format";
import { useReducedMotion } from "@/lib/hooks";
import { fieldName } from "@/lib/plain";
import {
  IconChevronLeft,
  IconChevronRight,
  IconDownload,
  IconFile,
  IconMinus,
  IconPlus,
} from "../icons";

export const ZOOMS = [0.75, 1, 1.25, 1.5, 1.75, 2];

function box(bbox: number[]): CSSProperties {
  const [x0, y0, x1, y1] = bbox;
  return {
    left: `calc(${x0 * 100}% - 3px)`,
    top: `calc(${y0 * 100}% - 2px)`,
    width: `calc(${(x1 - x0) * 100}% + 6px)`,
    height: `calc(${(y1 - y0) * 100}% + 4px)`,
  };
}

export function DocumentCard({
  detail,
  page,
  onPage,
  zoom,
  onZoom,
  focus,
  flag,
  reading,
  pagesReady,
  arriving,
}: {
  detail: Detail;
  page: number;
  onPage: (page: number) => void;
  zoom: number;
  onZoom: (zoom: number) => void;
  /** Evidence field the reader asked to see (citation chip / Fields tab). */
  focus: string | null;
  /** Field behind the reason the invoice stopped, outlined in amber. */
  flag: string | null;
  reading: boolean;
  pagesReady: boolean;
  arriving: boolean;
}) {
  const { invoice, pages, evidence } = detail;
  const reduced = useReducedMotion();
  const sheet = useRef<HTMLDivElement>(null);
  const [broken, setBroken] = useState<string | null>(null);
  const src = `/api/invoices/${encodeURIComponent(invoice.id)}/pages/${page}`;
  const scanned = evidence.some((e) => e.method === "ocr");
  const boxes = evidence.filter(
    (e): e is Evidence & { bbox: number[] } =>
      e.page === page && Array.isArray(e.bbox) && e.bbox.length === 4,
  );
  const focused = focus ? evidence.find((e) => e.field === focus) : undefined;
  const zoomIndex = ZOOMS.indexOf(zoom);

  useEffect(() => {
    if (!focus) return;
    const target =
      sheet.current?.querySelector<HTMLElement>(".tm-hl.is-focus") ?? sheet.current;
    target?.scrollIntoView({
      block: "center",
      inline: "nearest",
      behavior: reduced ? "auto" : "smooth",
    });
  }, [focus, page, reduced]);

  return (
    <section className="tm-card tm-doc-card" aria-labelledby="tm-doc-title">
      <div className="tm-card-h">
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <IconFile size={16} style={{ color: "var(--faint)", flex: "0 0 auto" }} />
          <h2
            id="tm-doc-title"
            className="tm-mono tm-ellipsis"
            style={{ fontSize: 12.5, fontWeight: 500 }}
          >
            {invoice.filename}
          </h2>
          <span className="tm-faint" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
            {pages} {pages === 1 ? "page" : "pages"}
            {scanned ? " · scanned" : ""}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
          {pages > 1 && (
            <div className="tm-pager" role="group" aria-label="Pages">
              <button
                className="tm-icon-btn"
                aria-label="Previous page"
                disabled={page <= 1}
                onClick={() => onPage(page - 1)}
              >
                <IconChevronLeft size={15} />
              </button>
              <span className="tm-pager-label" aria-live="polite">
                <span className="tm-sr">Page </span>
                {page}/{pages}
              </span>
              <button
                className="tm-icon-btn"
                aria-label="Next page"
                disabled={page >= pages}
                onClick={() => onPage(page + 1)}
              >
                <IconChevronRight size={15} />
              </button>
            </div>
          )}
          <button
            className="tm-icon-btn"
            aria-label="Zoom out"
            disabled={zoomIndex <= 0}
            onClick={() => onZoom(ZOOMS[Math.max(0, zoomIndex - 1)])}
          >
            <IconMinus size={15} />
          </button>
          <span className="tm-pager-label">{Math.round(zoom * 100)}%</span>
          <button
            className="tm-icon-btn"
            aria-label="Zoom in"
            disabled={zoomIndex >= ZOOMS.length - 1}
            onClick={() => onZoom(ZOOMS[Math.min(ZOOMS.length - 1, zoomIndex + 1)])}
          >
            <IconPlus size={15} />
          </button>
          <a
            className="tm-icon-btn"
            href={`/api/invoices/${encodeURIComponent(invoice.id)}/source`}
            aria-label="Download the original PDF"
            download
          >
            <IconDownload size={15} />
          </a>
        </div>
      </div>
      <div
        className="tm-card-b"
        tabIndex={0}
        role="region"
        aria-label="Invoice page, scrollable"
      >
        <div className="tm-docwrap" style={{ "--zoom": zoom } as CSSProperties}>
          {focused && (!focused.bbox || focused.status === "unverified") && (
            <p className="tm-doc-note">
              {focused.status === "unverified"
                ? `${fieldName(focused.field)}: not confirmed on the page.`
                : `${fieldName(focused.field)} is on page ${focused.page}; its exact position couldn’t be marked.`}
            </p>
          )}
          {pagesReady && broken !== src ? (
            <div className="tm-sheet" ref={sheet}>
              {reading && <div className="tm-scanline" aria-hidden="true" />}
              {/* Server-rendered page image; no PDF script runs in the browser. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={src}
                alt={`${invoice.filename}, page ${page} of ${pages}. The extracted values are listed in the Fields tab.`}
                onError={() => setBroken(src)}
              />
              {!reading &&
                boxes.map((e) => (
                  <span
                    key={e.field}
                    aria-hidden="true"
                    className={cx(
                      "tm-hl",
                      e.field === focus
                        ? "is-focus"
                        : e.field === flag
                          ? "is-flag"
                          : null,
                      arriving && "is-arriving",
                    )}
                    style={box(e.bbox)}
                  />
                ))}
            </div>
          ) : pagesReady ? (
            <div className="tm-empty" style={{ minHeight: 240 }}>
              <strong>The page image isn’t available</strong>
              <span>Download the original PDF to view it.</span>
            </div>
          ) : (
            <div className="tm-sheet is-placeholder" ref={sheet}>
              <span className="tm-sr">Preparing the page</span>
              {reading && <div className="tm-scanline" aria-hidden="true" />}
              <div className="tm-shimmer" style={{ width: "42%", height: 16 }} />
              <div className="tm-shimmer" style={{ width: "28%" }} />
              <div className="tm-shimmer" style={{ width: "64%", marginTop: 18 }} />
              <div className="tm-shimmer" style={{ width: "58%" }} />
              <div className="tm-shimmer" style={{ width: "100%", marginTop: 18 }} />
              <div className="tm-shimmer" style={{ width: "100%" }} />
              <div className="tm-shimmer" style={{ width: "36%", marginTop: 18, alignSelf: "flex-end" }} />
            </div>
          )}
        </div>
      </div>
      <p className="tm-sr" aria-live="polite">
        {focused?.page ? `Showing ${fieldName(focused.field)} on page ${focused.page}.` : ""}
      </p>
    </section>
  );
}
