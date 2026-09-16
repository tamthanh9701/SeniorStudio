"use client";

import { useSyncExternalStore } from "react";
import { vnDayKey } from "@/lib/format/datetime";

/**
 * The workspace calendar day (`YYYY-MM-DD`, GMT+7) as the client sees it.
 *
 * The server cannot know the reader's "today" without pinning the render to a
 * moment, so the server snapshot is `null` and the real key arrives with the
 * first client render. `useSyncExternalStore` is used rather than a state
 * effect because it is the same store on both sides of hydration: React
 * renders the server snapshot first and only then re-renders from the client
 * snapshot, so there is nothing for a hydration mismatch to latch onto.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

let cachedKey: string | null = null;
let cachedAt = 0;

function subscribe(): () => void {
  // Nothing to subscribe to: the snapshot changes at most once a day and every
  // consumer re-reads it on its next render.
  return () => {};
}

function getSnapshot(): string | null {
  const now = Date.now();
  // Re-reading the clock on every call would hand React a new value on each
  // render pass; the day key itself only moves at midnight in GMT+7.
  if (cachedKey === null || now - cachedAt >= DAY_MS) {
    cachedKey = vnDayKey(now);
    cachedAt = now;
  }
  return cachedKey;
}

function getServerSnapshot(): string | null {
  return null;
}

export function useTodayKey(): string | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
