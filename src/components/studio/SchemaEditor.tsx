"use client";

import { useMemo, useState } from "react";
import { LoaderCircle, Save } from "lucide-react";
import FieldInput, { type FieldValue } from "./FieldInput";
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
    setSaving(false);
  };

  return <div className="space-y-4">
    {groups.map((group) => {
      const values = draft[group.key] && typeof draft[group.key] === "object" ? draft[group.key] as Record<string, unknown> : {};
      return <section key={group.key} className="rounded-xl border border-white/10 bg-black/10 p-3">
        <h4 className="font-medium text-[#d0d5dd]">{group.icon} {group.label}</h4>
        <p className="mt-1 text-xs text-[#667085]">{group.description}</p>
        <div className="mt-3 grid gap-3">
          {group.fields.map((field) => <FieldInput key={`${group.key}.${field.key}`} field={field} inputId={`${group.key}-${field.key}`} value={(values[field.key] ?? null) as FieldValue} onChange={(value) => setField(group.key, field.key, value)} />)}
        </div>
      </section>;
    })}
    {message && <p role="status" className="text-xs text-[#98a2b3]">{message}</p>}
    <button type="button" className="studio-button-primary w-full" disabled={saving} onClick={() => void save()}>{saving ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />} Save changes</button>
  </div>;
}
