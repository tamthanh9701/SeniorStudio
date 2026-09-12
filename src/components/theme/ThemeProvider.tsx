"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

type Theme = "light" | "dark" | "system";
type ThemeContextValue = { theme: Theme; resolvedTheme: "light" | "dark"; setTheme: (theme: Theme) => void };

const ThemeContext = createContext<ThemeContextValue | null>(null);

function resolve(theme: Theme): "light" | "dark" {
  if (theme !== "system") return theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
export default function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("system");
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">("light");

  const preferenceRef = useRef<Theme>(theme);
  useEffect(() => {
    let stored: string | null = null;
    try { stored = window.localStorage.getItem("seniorstudio-theme"); } catch { /* fall back to system */ }
    const initial: Theme = stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
    preferenceRef.current = initial;
    setThemeState(initial);
    const apply = (next: Theme) => {
      const resolved = resolve(next);
      document.documentElement.dataset.theme = resolved;
      setResolvedTheme(resolved);
    };
    apply(initial);
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onMediaChange = () => { if (preferenceRef.current === "system") apply("system"); };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== "seniorstudio-theme") return;
      const next: Theme = event.newValue === "light" || event.newValue === "dark" || event.newValue === "system" ? event.newValue : "system";
      preferenceRef.current = next;
      setThemeState(next);
      apply(next);
    };
    media.addEventListener("change", onMediaChange);
    window.addEventListener("storage", onStorage);
    return () => { media.removeEventListener("change", onMediaChange); window.removeEventListener("storage", onStorage); };
  }, []);

  const setTheme = (next: Theme) => {
    preferenceRef.current = next;
    setThemeState(next);
    try { window.localStorage.setItem("seniorstudio-theme", next); } catch { /* in-memory preference still applies */ }
    const resolved = resolve(next);
    document.documentElement.dataset.theme = resolved;
    setResolvedTheme(resolved);
  };

  const value = useMemo(() => ({ theme, resolvedTheme, setTheme }), [theme, resolvedTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used inside ThemeProvider");
  return context;
}
