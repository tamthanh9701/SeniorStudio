"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { Card } from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useTheme } from "./ThemeProvider";

export default function ThemeSelect() {
  const { theme, setTheme } = useTheme();
  return (
    <Card className="p-5">
      <div className="flex items-start gap-3">
        <span className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary"><Sun className="size-5" /></span>
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">Appearance</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">Choose how SeniorStudio looks on this device.</p>
          <ToggleGroup
            type="single"
            spacing={2}
            value={theme}
            onValueChange={(value) => { if (value) setTheme(value as "light" | "dark" | "system"); }}
            aria-label="Theme"
            className="mt-4 grid w-full grid-cols-3"
          >
            {(["system", "light", "dark"] as const).map((value) => {
              const Icon = value === "system" ? Monitor : value === "light" ? Sun : Moon;
              return (
                <ToggleGroupItem
                  key={value}
                  value={value}
                  className="min-h-11 w-full rounded-xl border border-border px-3 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground data-[state=on]:border-primary data-[state=on]:bg-primary/10 data-[state=on]:text-primary"
                >
                  <Icon className="size-4" />{value[0].toUpperCase() + value.slice(1)}
                </ToggleGroupItem>
              );
            })}
          </ToggleGroup>
        </div>
      </div>
    </Card>
  );
}
