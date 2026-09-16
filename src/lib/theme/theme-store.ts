"use client";

export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "seniorstudio-theme";
/** Components subscribed through useSyncExternalStore. */
const listeners = new Set<() => void>();

function isTheme(value: string | null): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

/** The stored preference, or "system" when there is none to read. */
export function readTheme(): Theme {
  if (typeof window === "undefined") return "system";
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isTheme(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

/**
 * Subscribes to the stored preference: another tab writing the key is delivered by
 * the `storage` event, and a write in this tab notifies directly.
 */
export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  if (typeof window === "undefined") return () => { listeners.delete(listener); };
  const onStorage = (event: StorageEvent) => { if (event.key === STORAGE_KEY) listener(); };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** Stores the preference and notifies every subscriber. */
export function writeTheme(next: Theme): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // An in-memory preference still applies for this tab.
  }
  for (const listener of listeners) listener();
}
