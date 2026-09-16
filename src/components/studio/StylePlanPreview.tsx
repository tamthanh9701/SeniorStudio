import type { ExecutionPlan } from "@/lib/ai/execution-plan";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

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
    <Card role="region" aria-label="Style plan preview" className="gap-3 p-4">
      <CardHeader className="p-0">
        <CardTitle className="text-sm">Generation plan</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 p-0">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          {fields.filter((field) => field.value !== null).map((field) => (
            <div key={field.label} className="flex min-w-0 flex-col gap-0.5">
              <dt className="text-muted-foreground">{field.label}</dt>
              <dd className="truncate font-medium text-foreground">{field.value}</dd>
            </div>
          ))}
        </dl>
        <div className="text-xs text-muted-foreground">
          <span>References</span>
          <p className="mt-1 font-medium text-foreground">{refs.length ? refs.join(", ") : "No references"}</p>
        </div>
        {plan.explanation && <p className="text-xs text-muted-foreground">{plan.explanation}</p>}
        {plan.warnings && plan.warnings.length > 0 && (
          <Alert variant="default" role="alert" className="px-3 py-2">
            <AlertTitle className="text-xs">Before you generate</AlertTitle>
            <ul className="space-y-1">
              {plan.warnings.map((warning) => (
                <li key={warning} className="text-xs text-warning">{warning}</li>
              ))}
            </ul>
          </Alert>
        )}
        {plan.compiledPrompt && (
          <Collapsible>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" className="h-11 w-full justify-start px-2 text-xs font-normal text-muted-foreground hover:text-foreground">
                Compiled prompt
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-accent p-3 text-[11px] text-foreground">{plan.compiledPrompt}</pre>
            </CollapsibleContent>
          </Collapsible>
        )}
      </CardContent>
    </Card>
  );
}
