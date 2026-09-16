"use client";

import { LoaderCircle, Scissors } from "lucide-react";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type ExportPlan = {
  compiledPrompt?: string;
  referenceIds?: string[];
  effectiveModelId?: string;
  planHash?: string;
  warnings?: string[];
  explanation?: string;
};

const EXPORT_PROMPT = "Remove the background: keep the same subject, composition and lighting, on a fully transparent background.";
const EXPORT_MODEL = "openai/gpt-image-2";

/**
 * Re-generates an image with a transparent background through the provider.
 *
 * The plan is resolved first and shown with its cost warning, so the provider
 * call only happens after the user has seen the prompt and approved it. On a
 * style image the result arrives as a candidate version that must be kept.
 */
export default function ExportTransparentDialog({
  styleId,
  assetId,
  versionId,
}: {
  /** Set for a style image: the job then belongs to the style group. */
  styleId?: string | null;
  assetId: string;
  versionId: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<ExportPlan | null>(null);
  const [queued, setQueued] = useState(false);

  const resolvePlan = async () => {
    setBusy("plan");
    setError(null);
    setPlan(null);
    setQueued(false);
    try {
      const response = await fetch("/api/ai-execution-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation: "image_to_image",
          requestedModelId: EXPORT_MODEL,
          styleId: styleId ?? undefined,
          sourceVersionId: versionId,
          prompt: EXPORT_PROMPT,
          referenceIds: [],
          size: "auto",
          quality: "auto",
          count: 1,
          costMode: "strict_1000",
          preserveRequestedModel: true,
          background: "transparent",
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(`${body.error?.code ?? "PLAN_FAILED"}: ${body.error?.message ?? "Unable to resolve the export plan"}`);
        return;
      }
      setPlan(body.plan as ExportPlan);
    } catch {
      setError("NETWORK_ERROR: Unable to resolve the export plan");
    } finally {
      setBusy(null);
    }
  };

  const enqueue = async () => {
    setBusy("enqueue");
    setError(null);
    try {
      const response = styleId
        ? await fetch(`/api/styles/${styleId}/ai-jobs`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              operation: "image_to_image",
              model: EXPORT_MODEL,
              prompt: EXPORT_PROMPT,
              sourceVersionId: versionId,
              referenceIds: [],
              size: "auto",
              quality: "auto",
              count: 1,
              costMode: "strict_1000",
              background: "transparent",
              consent: { planHash: plan?.planHash },
            }),
          })
        : await fetch(`/api/assets/${assetId}/ai-jobs`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              operation: "image_to_image",
              model: EXPORT_MODEL,
              prompt: EXPORT_PROMPT,
              sourceVersionId: versionId,
              count: 1,
              size: "auto",
              quality: "auto",
              costMode: "strict_1000",
              background: "transparent",
            }),
          });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(`${body.error?.code ?? "ENQUEUE_FAILED"}: ${body.error?.message ?? "Unable to queue the export"}`);
        return;
      }
      setQueued(true);
    } catch {
      setError("NETWORK_ERROR: Unable to queue the export");
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        onClick={() => { setOpen(true); void resolvePlan(); }}
        aria-label="Export without background"
      >
        <Scissors className="size-4" aria-hidden />
        <span className="hidden sm:inline">Export without background</span>
      </Button>
      <Dialog open={open} onOpenChange={(next) => { if (!next && busy === null) setOpen(false); }}>
        <DialogContent className="max-h-[85dvh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Export without background</DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground">
              The image is generated again from this version, keeping the subject, composition and lighting on a transparent background.
            </DialogDescription>
          </DialogHeader>

          {error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription className="text-xs">{error}</AlertDescription>
            </Alert>
          )}
          {busy === "plan" && (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" aria-hidden /> Preparing the export plan…
            </p>
          )}

          {plan && !queued && (
            <div className="space-y-3">
              <dl className="space-y-1 text-xs">
                <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Model</dt><dd className="font-medium">{plan.effectiveModelId ?? EXPORT_MODEL}</dd></div>
                <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Background</dt><dd className="font-medium">transparent</dd></div>
              </dl>
              {plan.compiledPrompt && (
                <div>
                  <p className="text-xs text-muted-foreground">Compiled prompt</p>
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-accent p-2 text-[11px]">{plan.compiledPrompt}</pre>
                </div>
              )}
              {plan.warnings?.map((warning) => (
                <p key={warning} className="text-xs text-warning" role="alert">{warning}</p>
              ))}
              <Alert variant="default" className="px-3 py-2">
                <AlertDescription className="text-xs">
                  Your provider bills this as one image generation. {styleId ? "The result is added to this style as a candidate you review and keep." : "The result is added to this project."}
                </AlertDescription>
              </Alert>
            </div>
          )}

          {queued && (
            <Alert variant="default" role="status">
              <AlertDescription className="text-xs text-success">
                Queued. {styleId ? "Keep the candidate version once it finishes to make it the current image." : "The finished image appears in this project."}
              </AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy !== null}>Close</Button>
            {!queued && (
              <Button
                type="button"
                onClick={() => void (plan ? enqueue() : resolvePlan())}
                disabled={busy !== null || (plan !== null && !plan.planHash && Boolean(styleId))}
              >
                {busy === "enqueue" ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : null}
                {plan ? "Generate without background" : "Prepare plan"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
