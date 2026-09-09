"use client";

import { useState } from "react";
import type { FieldMeta } from "@/lib/style/prompt-field-metadata";

export type FieldValue = string | string[] | number | boolean | null;

interface FieldInputProps {
  field: FieldMeta;
  inputId?: string;
  value: FieldValue;
  onChange: (value: FieldValue) => void;
}

export default function FieldInput({ field, inputId = field.key, value, onChange }: FieldInputProps) {
  const [tagInput, setTagInput] = useState("");
  const describedBy = `${inputId}-description`;

  if (field.type === "tags") {
    const tags = Array.isArray(value) ? value : [];
    return <div className="space-y-1.5">
      <label className="studio-label" htmlFor={`tag-${inputId}`}>{field.label}</label>
      <p id={describedBy} className="text-xs text-[#667085]">{field.description}</p>
      <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg border border-white/10 bg-black/20 px-2 py-1.5">
        {tags.map((tag) => <span key={tag} className="inline-flex items-center gap-1 rounded-md bg-white/10 px-2 py-1 text-xs">
          {tag}
          <button type="button" aria-label={`Remove ${tag}`} className="text-[#98a2b3] hover:text-white" onClick={() => onChange(tags.filter((item) => item !== tag))}>×</button>
        </span>)}
        <input
          id={`tag-${inputId}`}
          aria-describedby={describedBy}
          className="min-w-24 flex-1 bg-transparent px-1 py-1 text-sm outline-none"
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
    className: "studio-control w-full",
  };

  return <div className="space-y-1.5">
    <label className="studio-label" htmlFor={inputId}>{field.label}</label>
    <p id={describedBy} className="text-xs text-[#667085]">{field.description}</p>
    {field.type === "textarea" ? <textarea {...shared} rows={3} placeholder={field.placeholder} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value || null)} />
      : field.type === "number" ? <input {...shared} type="number" step="any" placeholder={field.placeholder} value={typeof value === "number" ? String(value) : ""} onChange={(event) => onChange(event.target.value ? Number(event.target.value) : null)} />
      : field.type === "select" && field.options ? <select {...shared} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value || null)}><option value="">Select…</option>{field.options.map((option) => <option key={option} value={option}>{option}</option>)}</select>
      : field.type === "toggle" ? <input id={inputId} aria-describedby={describedBy} type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} className="size-4 accent-white" />
      : <input {...shared} type={field.type === "color" ? "color" : "text"} placeholder={field.placeholder} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value || null)} />}
  </div>;
}
