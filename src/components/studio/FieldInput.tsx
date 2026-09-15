"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { FieldMeta } from "@/lib/style/prompt-field-metadata";

export type FieldValue = string | string[] | number | boolean | null;

interface FieldInputProps {
  field: FieldMeta;
  inputId?: string;
  value: FieldValue;
  onChange: (value: FieldValue) => void;
}

// Radix Select reserves the empty string, so the native "Select…" option needs a sentinel value.
const UNSET_SELECT_VALUE = "__unset__";

export default function FieldInput({ field, inputId = field.key, value, onChange }: FieldInputProps) {
  const [tagInput, setTagInput] = useState("");
  const describedBy = `${inputId}-description`;

  if (field.type === "tags") {
    const tags = Array.isArray(value) ? value : [];
    return <div className="space-y-1.5">
      <Label className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground" htmlFor={`tag-${inputId}`}>{field.label}</Label>
      <p id={describedBy} className="text-xs text-muted-foreground">{field.description}</p>
      <div className="flex min-h-11 flex-wrap items-center gap-1.5 rounded-lg border bg-card px-2 py-1.5">
        {tags.map((tag) => <Badge key={tag} variant="secondary" className="gap-0.5 py-1 pr-1 pl-2">
          {tag}
          <Button type="button" variant="ghost" size="icon-sm" className="-my-1 shrink-0" aria-label={`Remove ${tag}`} onClick={() => onChange(tags.filter((item) => item !== tag))}>×</Button>
        </Badge>)}
        <Input
          id={`tag-${inputId}`}
          aria-describedby={describedBy}
          className="h-11 min-w-24 flex-1 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0 dark:bg-transparent"
          placeholder={tags.length === 0 ? field.placeholder : ""}
          value={tagInput}
          onChange={(event) => setTagInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && tagInput.trim()) {
              event.preventDefault();
              onChange([...tags, tagInput.trim()]);
              setTagInput("");
            } else if (event.key === "Backspace" && !tagInput && tags.length > 0) {
              onChange(tags.slice(0, -1));
            }
          }}
        />
      </div>
    </div>;
  }

  const shared = {
    id: inputId,
    "aria-describedby": describedBy,
    className: "w-full",
  };

  const control = field.type === "textarea" ? <Textarea {...shared} rows={3} placeholder={field.placeholder} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value || null)} />
    : field.type === "number" ? <Input {...shared} type="number" step="any" placeholder={field.placeholder} value={typeof value === "number" ? String(value) : ""} onChange={(event) => onChange(event.target.value ? Number(event.target.value) : null)} />
    : field.type === "select" && field.options ? <Select value={typeof value === "string" && value ? value : UNSET_SELECT_VALUE} onValueChange={(next) => onChange(next === UNSET_SELECT_VALUE ? null : next)}>
      <SelectTrigger {...shared}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={UNSET_SELECT_VALUE}>Select…</SelectItem>
        {field.options.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}
      </SelectContent>
    </Select>
    : field.type === "toggle" ? <Checkbox id={inputId} aria-describedby={describedBy} checked={value === true} onCheckedChange={(checked) => onChange(checked === true)} />
    : <Input {...shared} type={field.type === "color" ? "color" : "text"} placeholder={field.placeholder} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value || null)} />;

  return <div className="space-y-1.5">
    <Label className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground" htmlFor={inputId}>{field.label}</Label>
    <p id={describedBy} className="text-xs text-muted-foreground">{field.description}</p>
    {control}
  </div>;
}
