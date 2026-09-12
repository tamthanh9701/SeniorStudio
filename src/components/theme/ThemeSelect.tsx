"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "./ThemeProvider";

export default function ThemeSelect() {
  const { theme, setTheme } = useTheme();
  return (
    <div className="studio-card p-5">
      <div className="flex items-start gap-3">
        <span className="flex size-10 items-center justify-center rounded-xl bg-[var(--accent-subtle)] text-[var(--accent)]"><Sun className="size-5" /></span>
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">Appearance</h2>
          <p className="mt-1 text-sm leading-6 text-[var(--muted)]">Choose how SeniorStudio looks on this device.</p>
          <div className="mt-4 grid grid-cols-3 gap-2" role="radiogroup" aria-label="Theme">
            {(["system", "light", "dark"] as const).map((value) => {
              const Icon = value === "system" ? Monitor : value === "light" ? Sun : Moon;
              return <button key={value} type="button" role="radio" aria-checked={theme === value} onClick={() => setTheme(value)} className={`flex min-h-11 items-center justify-center gap-2 rounded-xl border px-3 text-sm font-medium transition ${theme === value ? "border-[var(--accent)] bg-[var(--accent-subtle)] text-[var(--accent)]" : "border-[var(--border)] text-[var(--muted)] hover:bg-[var(--surface-hover)]"}`}><Icon className="size-4" />{value[0].toUpperCase() + value.slice(1)}</button>;
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
