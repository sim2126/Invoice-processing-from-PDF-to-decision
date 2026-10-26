"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { Detail, RunEvent } from "@/lib/api";
import { detailOptions, keys, refreshWorkspace } from "@/lib/queries";
import { isFinal, type Step, type StepKey } from "@/lib/steps";

/** Stages after which the stored invoice (decision, extraction) changes. */
const SETTLES = new Set(["decision", "processing", "recovery"]);

/**
 * Invoice detail with live progress: run events stream over SSE and are
 * merged into the cached detail; polling keeps it correct when the stream
 * drops (it refreshes faster while the stream is down).
 */
export function useLiveDetail(id: string) {
  const client = useQueryClient();
  const [streaming, setStreaming] = useState(true);
  const query = useQuery({
    ...detailOptions(id),
    refetchInterval: (q) => {
      const state = q.state.data?.run.state;
      if (state !== "QUEUED" && state !== "RUNNING") return false;
      return streaming ? 6000 : 2000;
    },
  });
  const runState = query.data?.run.state;
  const active = runState === "QUEUED" || runState === "RUNNING";
  const runId = query.data?.run.id;

  useEffect(() => {
    if (!active || !runId) return;
    const key = keys.invoice(id);
    const after =
      client
        .getQueryData<Detail>(key)
        ?.events.reduce((max, e) => Math.max(max, e.id), 0) ?? 0;
    const source = new EventSource(
      `/api/invoices/${encodeURIComponent(id)}/events?after=${after}`,
    );
    source.onopen = () => setStreaming(true);
    source.onerror = () => setStreaming(false);
    source.addEventListener("progress", (message) => {
      let event: RunEvent;
      try {
        event = JSON.parse(message.data) as RunEvent;
      } catch {
        return;
      }
      let newerRun = false;
      client.setQueryData<Detail>(key, (old) => {
        if (!old) return old;
        if (event.run_id !== old.run.id) {
          newerRun = true;
          return old;
        }
        if (old.events.some((e) => e.id === event.id)) return old;
        return { ...old, events: [...old.events, event] };
      });
      if (newerRun || SETTLES.has(event.stage))
        void client.invalidateQueries({ queryKey: key });
    });
    source.addEventListener("session_expired", () => {
      source.close();
      void client.invalidateQueries({ queryKey: ["session"] });
    });
    return () => source.close();
  }, [active, runId, id, client]);

  // However the run finished (stream or polling), refresh lists and balances.
  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && !active) void refreshWorkspace(client);
    wasActive.current = active;
  }, [active, client]);

  return query;
}

/**
 * Purely visual: while a run is watched live, steps that already have a
 * result are revealed one at a time (~120 ms apart). Nothing waits on the
 * server; with reduced motion everything shows at once.
 */
export function useReveal(
  steps: Step[],
  runId: string,
  initiallyLive: boolean,
  instant: boolean,
) {
  const [live, setLive] = useState(initiallyLive);
  const [shown, setShown] = useState<{ run: string; keys: StepKey[] }>({
    run: runId,
    keys: [],
  });
  const revealed = shown.run === runId ? shown.keys : [];
  const staggering = live && !instant;
  const next = staggering
    ? steps.find((s) => isFinal(s.state) && !revealed.includes(s.key))?.key
    : undefined;
  useEffect(() => {
    if (!next) return;
    const timer = setTimeout(() => {
      setShown((prev) => {
        const base = prev.run === runId ? prev.keys : [];
        return base.includes(next) ? prev : { run: runId, keys: [...base, next] };
      });
    }, 120);
    return () => clearTimeout(timer);
  }, [next, runId]);
  return {
    shown: staggering ? new Set(revealed) : null,
    goLive: () => setLive(true),
  };
}
