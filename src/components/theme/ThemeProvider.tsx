"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { readTheme, subscribeTheme, writeTheme, type Theme } from "@/lib/theme/theme-store";

type ThemeContextValue = { theme: Theme; resolvedTheme: "light" | "dark"; setTheme: (theme: Theme) => void };

const ThemeContext = createContext<ThemeContextValue | null>(null);

function resolve(theme: Theme): "light" | "dark" {
  if (theme !== "system") return theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export default function ThemeProvider({ children }: { children: ReactNode }) {
  // The stored preference is external state: reading it through useSyncExternalStore
  // keeps the server render ("system") and every subscriber in step, including a
  // write from another tab.
  const theme = useSyncExternalStore(subscribeTheme, readTheme, () => "system" as Theme);
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    const apply = (next: Theme) => {
      const resolved = resolve(next);
      document.documentElement.dataset.theme = resolved;
      setResolvedTheme(resolved);
    };
    apply(theme);
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onMediaChange = () => { if (theme === "system") apply("system"); };
    media.addEventListener("change", onMediaChange);
    return () => media.removeEventListener("change", onMediaChange);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    writeTheme(next);
    const resolved = resolve(next);
    document.documentElement.dataset.theme = resolved;
    setResolvedTheme(resolved);
  }, []);

  const value = useMemo(() => ({ theme, resolvedTheme, setTheme }), [theme, resolvedTheme, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used inside ThemeProvider");
  return context;
}
