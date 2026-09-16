"use client";

import { LoaderCircle, Sparkles } from "lucide-react";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";

type ProposalChange = { id?: string; group: string; field: string; current_value?: string; suggested_value: unknown; reason?: string };
type ProposalIssue = { id?: string; category?: string; evidence?: string; reason?: string; confidence?: string };
type Proposal = { id: string; baseUpdatedAt: string; drift_summary: string; confidence: string; issues: ProposalIssue[]; changes: ProposalChange[] };
type Quality = { overall?: number; grade?: string } & Record<string, unknown>;
type LintIssue = { code?: string; message?: string; path?: string } & Record<string, unknown>;

/**
 * Turns one generated image into a durable change to the style's own schema.
 *
 * Three steps, each on its own request so a failure never discards the previous
 * answer: review the drift, inspect the compiled prompt before and after, then
 * apply and (for a live style) confirm it for future generations.
 */
export default function PromptImprovementDialog({
  styleId,
  versionId,
  styleName,
}: {
  styleId: string;
  versionId: string;
  styleName: string;
}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"review" | "preview" | "apply">("review");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [preview, setPreview] = useState<{ compiledPromptBefore: string; compiledPromptAfter: string; quality: Quality; issues: LintIssue[] } | null>(null);
  const [applied, setApplied] = useState<{ updatedAt: string; quality: Quality } | null>(null);
  const [confirmedAt, setConfirmedAt] = useState<string | null>(null);
  const [isActive, setIsActive] = useState<boolean | null>(null);

  const errors = (body: { error?: { code?: string; message?: string } }, fallback: string) =>
    `${body.error?.code ?? fallback}: ${body.error?.message ?? fallback}`;

  const reset = () => {
    setStep("review");
    setError(null);
    setFeedback(null);
    setProposal(null);
    setPreview(null);
    setApplied(null);
    setConfirmedAt(null);
    setIsActive(null);
  };

  const runTune = async () => {
    setBusy("tune");
    setError(null);
    setFeedback(null);
    try {
      const response = await fetch(`/api/styles/${styleId}/tune`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ generatedVersionIds: [versionId], focus: "prompt" }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(errors(body, "TUNE_FAILED"));
        return;
      }
      const next = body.proposal as Proposal | undefined;
      if (!next?.changes?.length) {
        setFeedback("No prompt changes were suggested for this image.");
        return;
      }
      setProposal(next);
      setStep("preview");
      await runPreview(next.changes);
    } catch {
      setError("NETWORK_ERROR: Unable to review this image");
    } finally {
      setBusy(null);
    }
  };

  const runPreview = async (changes: ProposalChange[]) => {
    setBusy("preview");
    setError(null);
    try {
      const response = await fetch(`/api/styles/${styleId}/tune/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changes: changes.map((change) => ({ group: change.group, field: change.field, suggested_value: change.suggested_value })) }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(errors(body, "PREVIEW_FAILED"));
        return;
      }
      setPreview({
        compiledPromptBefore: String(body.compiledPromptBefore ?? ""),
        compiledPromptAfter: String(body.compiledPromptAfter ?? ""),
        quality: (body.quality ?? {}) as Quality,
        issues: Array.isArray(body.issues) ? (body.issues as LintIssue[]) : [],
      });
    } catch {
      setError("NETWORK_ERROR: Unable to preview the improved prompt");
    } finally {
      setBusy(null);
    }
  };

  const applyChanges = async () => {
    if (!proposal) return;
    setBusy("apply");
    setError(null);
    try {
      const response = await fetch(`/api/styles/${styleId}/tune/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          changes: proposal.changes.map((change) => ({ group: change.group, field: change.field, suggested_value: change.suggested_value })),
          baseUpdatedAt: proposal.baseUpdatedAt,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(errors(body, "APPLY_FAILED"));
        return;
      }
      setApplied({ updatedAt: String(body.style?.updated_at ?? ""), quality: (body.quality ?? {}) as Quality });
      setIsActive(body.style?.status === "active");
      setFeedback("The style now carries the improved prompt.");
      setStep("apply");
    } catch {
      setError("NETWORK_ERROR: Unable to apply the changes");
    } finally {
      setBusy(null);
    }
  };

  const confirmForGenerations = async () => {
    if (!applied?.updatedAt) return;
    setBusy("confirm");
    setError(null);
    try {
      const response = await fetch(`/api/styles/${styleId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "active", expectedUpdatedAt: applied.updatedAt }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(errors(body, "CONFIRM_FAILED"));
        return;
      }
      setConfirmedAt(String(body.style?.updated_at ?? applied.updatedAt));
      setFeedback("Confirmed. New generations use the improved prompt.");
    } catch {
      setError("NETWORK_ERROR: Unable to confirm the style");
    } finally {
      setBusy(null);
    }
  };

  const numberField = (quality: Quality) => (typeof quality.overall === "number" ? Math.round(quality.overall) : null);

  return (
    <>
      <Button
        type="button"
        variant="outline"
        onClick={() => { reset(); setOpen(true); void runTune(); }}
        aria-label="Improve prompt"
      >
        <Sparkles className="size-4" aria-hidden />
        <span className="hidden sm:inline">Improve prompt</span>
      </Button>
      <Dialog open={open} onOpenChange={(next) => { if (!next && busy === null) setOpen(false); }}>
        <DialogContent className="max-h-[85dvh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Improve the prompt for {styleName}</DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground">
              The generated image is compared with the style references, and the result is written into the style definition so every later generation uses it.
            </DialogDescription>
          </DialogHeader>

          {error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription className="text-xs">{error}</AlertDescription>
            </Alert>
          )}
          {feedback && (
            <Alert variant="default" role="status">
              <AlertDescription className="text-xs text-success">{feedback}</AlertDescription>
            </Alert>
          )}

          {busy === "tune" && (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" aria-hidden /> Comparing the image with the references…
            </p>
          )}

          {proposal && (
            <section className="space-y-2">
              <h3 className="text-sm font-medium">Review</h3>
              <p className="text-sm text-muted-foreground">{proposal.drift_summary || "No drift summary"}</p>
              <p className="text-xs text-muted-foreground">Confidence: {proposal.confidence || "unknown"}</p>
              {proposal.issues.length > 0 && (
                <ul className="space-y-1">
                  {proposal.issues.map((issue, index) => (
                    <li key={issue.id ?? index} className="text-xs text-muted-foreground">
                      {issue.category ?? "issue"}: {issue.reason ?? issue.evidence ?? ""} {issue.confidence ? `(${issue.confidence})` : ""}
                    </li>
                  ))}
                </ul>
              )}
              <ul className="space-y-1">
                {proposal.changes.map((change, index) => (
                  <li key={change.id ?? `${change.group}.${change.field}.${index}`} className="rounded-lg border border-border p-2 text-xs">
                    <p className="font-medium text-foreground">{change.group}.{change.field}</p>
                    <p className="text-muted-foreground">now: {String(change.current_value ?? "—")}</p>
                    <p className="text-foreground">suggested: {String(change.suggested_value ?? "—")}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {busy === "preview" && (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" aria-hidden /> Compiling the prompt…
            </p>
          )}

          {preview && (
            <section className="space-y-2">
              <h3 className="text-sm font-medium">Compiled prompt</h3>
              {numberField(preview.quality) !== null && (
                <p className="text-xs text-muted-foreground">Quality {numberField(preview.quality)}{preview.quality.grade ? ` · ${String(preview.quality.grade)}` : ""}</p>
              )}
              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <Label className="text-xs text-muted-foreground">Before</Label>
                  <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-accent p-2 text-[11px]">{preview.compiledPromptBefore}</pre>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">After</Label>
                  <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-accent p-2 text-[11px]">{preview.compiledPromptAfter}</pre>
                </div>
              </div>
              {preview.issues.length > 0 && (
                <ul className="space-y-1">
                  {preview.issues.map((issue, index) => (
                    <li key={`${issue.code ?? "issue"}-${index}`} className="text-xs text-warning">
                      {issue.message ?? issue.code ?? "Lint issue"}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {applied && (
            <section className="space-y-2">
              <h3 className="text-sm font-medium">Applied to the style</h3>
              <p className="text-xs text-muted-foreground">Style revision saved. Confirm it so new generations use the improved prompt.</p>
              {isActive && !confirmedAt && (
                <Button type="button" onClick={() => void confirmForGenerations()} disabled={busy !== null || !applied.updatedAt}>
                  {busy === "confirm" ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : null} Confirm for new generations
                </Button>
              )}
              {confirmedAt && <p className="text-xs text-success">Confirmed at {confirmedAt}.</p>}
            </section>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy !== null}>Close</Button>
            {proposal && (
              <Button type="button" onClick={() => void applyChanges()} disabled={busy !== null || applied !== null}>
                {busy === "apply" ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : null} Apply to style
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
