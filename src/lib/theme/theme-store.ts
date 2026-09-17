"use client";

export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "seniorstudio-theme";
/** Components subscribed through useSyncExternalStore. */
const listeners = new Set<() => void>();
/**
 * The preference written in this tab. `localStorage` can be denied (a sandboxed
 * frame, storage switched off), so when the stored value cannot be read back the
 * write still has to survive as this tab's snapshot — otherwise the choice snaps
 * back to "system" on the very next read.
 */
let inMemoryTheme: Theme = "system";

function isTheme(value: string | null): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

/** The stored preference, or the last one written in this tab when there is none to read. */
export function readTheme(): Theme {
  if (typeof window === "undefined") return "system";
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isTheme(stored) ? stored : inMemoryTheme;
  } catch {
    return inMemoryTheme;
  }
}

/**
 * Subscribes to the stored preference: another tab writing the key is delivered by
 * the `storage` event, and a write in this tab notifies directly.
 */
export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  if (typeof window === "undefined") return () => { listeners.delete(listener); };
  const onStorage = (event: StorageEvent) => { if (event.key === STORAGE_KEY) { inMemoryTheme = isTheme(event.newValue) ? event.newValue : "system"; listener(); } };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** Stores the preference and notifies every subscriber. */
export function writeTheme(next: Theme): void {
  if (typeof window === "undefined") return;
  inMemoryTheme = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // An in-memory preference still applies for this tab.
  }
  for (const listener of listeners) listener();
}
