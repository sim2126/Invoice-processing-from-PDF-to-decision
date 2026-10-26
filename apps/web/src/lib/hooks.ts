import { useSyncExternalStore } from "react";

/*
 * A shared clock for relative labels ("today 07:42", the current week).
 * Reading time through an external store keeps renders pure.
 */
let now = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribeClock(listener: () => void) {
  listeners.add(listener);
  if (timer === undefined) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      listeners.forEach((l) => l());
    }, 30_000);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

export function useNow() {
  return useSyncExternalStore(
    subscribeClock,
    () => now,
    () => now,
  );
}

const REDUCED = "(prefers-reduced-motion: reduce)";
function subscribeMotion(listener: () => void) {
  const media = window.matchMedia(REDUCED);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}

export function useReducedMotion() {
  return useSyncExternalStore(
    subscribeMotion,
    () => window.matchMedia(REDUCED).matches,
    () => false,
  );
}
