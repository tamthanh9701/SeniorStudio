import type { ExecutionPlan } from "@/lib/ai/execution-plan";

export function StylePlanPreview({ plan }: { plan: ExecutionPlan }) {
  const effective = plan.effectiveModelId;
  const requested = plan.requestedModelId;
  const fields: Array<{ label: string; value: string | null }> = [
    { label: "Model", value: requested === effective ? effective : `${requested} → ${effective}` },
    { label: "Provider", value: plan.provider },
    { label: "Size", value: plan.size },
    { label: "Quality", value: plan.quality },
    { label: "Count", value: String(plan.count) },
  ];
  if (plan.sourceVersionId) fields.push({ label: "Source version", value: plan.sourceVersionId });
  if (plan.styleRevision) fields.push({ label: "Style revision", value: plan.styleRevision });
  const refs = plan.referenceIds ?? [];

  return (
    <section className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4" aria-label="Style plan preview">
      <h3 className="text-sm font-semibold">Kế hoạch tạo ảnh</h3>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
        {fields.filter((field) => field.value !== null).map((field) => (
          <div key={field.label} className="flex flex-col gap-0.5">
            <dt className="text-[var(--muted)]">{field.label}</dt>
            <dd className="truncate font-medium text-[var(--text)]">{field.value}</dd>
          </div>
        ))}
      </dl>
      <div className="text-xs text-[var(--muted)]">
        <span>References</span>
        <p className="mt-1 font-medium text-[var(--text)]">{refs.length ? refs.join(", ") : "Không có references"}</p>
      </div>
      {plan.explanation && <p className="text-xs text-[var(--muted)]">{plan.explanation}</p>}
      {plan.warnings && plan.warnings.length > 0 && (
        <ul className="space-y-1">
          {plan.warnings.map((warning) => (
            <li key={warning} role="alert" className="text-xs text-[var(--warning)]">{warning}</li>
          ))}
        </ul>
      )}
      {plan.compiledPrompt && (
        <details className="text-xs">
          <summary className="cursor-pointer text-[var(--muted)] hover:text-[var(--text)]">Compiled prompt</summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--surface-hover)] p-3 text-[11px] text-[var(--text)]">{plan.compiledPrompt}</pre>
        </details>
      )}
    </section>
  );
}
