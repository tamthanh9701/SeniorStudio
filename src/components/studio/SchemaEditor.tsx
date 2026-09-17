"use client";

import { useMemo, useState } from "react";
import { ChevronDown, LoaderCircle, Save } from "lucide-react";
import FieldInput, { type FieldValue } from "./FieldInput";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { PROMPT_GROUPS } from "@/lib/style/prompt-field-metadata";
import type { PromptSchema } from "@/lib/style/prompt-schema";

interface SchemaEditorProps {
  styleId: string;
  schema: Record<string, unknown>;
  onSaved: () => Promise<unknown>;
}

export default function SchemaEditor({ styleId, schema, onSaved }: SchemaEditorProps) {
  const [draft, setDraft] = useState(schema);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const groups = useMemo(() => PROMPT_GROUPS.filter((group) => !group.condition || group.condition(draft as unknown as PromptSchema)), [draft]);

  const setField = (groupKey: string, fieldKey: string, value: FieldValue) => {
    setDraft((current) => ({
      ...current,
      [groupKey]: {
        ...((current[groupKey] && typeof current[groupKey] === "object" ? current[groupKey] : {}) as Record<string, unknown>),
        [fieldKey]: value,
      },
    }));
  };

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/styles/${styleId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schema: draft }),
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok) {
        setMessage("Schema saved.");
        await onSaved();
      } else {
        setMessage(`${body.error?.code ?? "UPDATE_FAILED"}: ${body.error?.message ?? "Unable to save schema"}`);
      }
    } catch {
      setMessage("NETWORK_ERROR: Unable to save schema");
    } finally {
      setSaving(false);
    }
  };

  return <div className="space-y-4">
    {groups.map((group) => {
      const values = draft[group.key] && typeof draft[group.key] === "object" ? draft[group.key] as Record<string, unknown> : {};
      return <Collapsible key={group.key} defaultOpen>
        <Card className="gap-2 py-3">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" className="group mx-3 h-auto justify-between gap-3 py-2 text-left whitespace-normal">
              <span className="min-w-0">
                <span className="block font-medium">{group.icon} {group.label}</span>
                <span className="mt-1 block text-xs font-normal text-muted-foreground">{group.description}</span>
              </span>
              <ChevronDown className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180" aria-hidden />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="grid gap-3">
              {group.fields.map((field) => <FieldInput key={`${group.key}.${field.key}`} field={field} inputId={`${group.key}-${field.key}`} value={(values[field.key] ?? null) as FieldValue} onChange={(value) => setField(group.key, field.key, value)} />)}
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>;
    })}
    {message && <p role="status" className="text-xs text-muted-foreground">{message}</p>}
    <Button type="button" className="w-full" disabled={saving} onClick={() => void save()}>{saving ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />} Save changes</Button>
  </div>;
}
