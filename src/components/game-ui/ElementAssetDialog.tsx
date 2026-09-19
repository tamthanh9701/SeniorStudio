"use client";

// Per-element asset production.  Two modes with different promises:
//   - exact: crop the original pixels and multiply their alpha by the user's matte.
//     Deterministic, and the label says so.
//   - reconstruction: ask a provider to redraw the element on a transparent
//     background.  Explicitly allowed to differ, so it is never the default and
//     always shows the plan and the cost warning before it is confirmed.

import { CheckCircle2, LoaderCircle, Scissors, Sparkles, Trash2 } from "lucide-react";
import Image from "next/image";
import { useState } from "react";
import ForegroundMaskEditor from "@/components/game-ui/ForegroundMaskEditor";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type { GameUiElement } from "@/lib/game-ui/contracts";
import type { GameUiOutputView } from "@/lib/game-ui/service";
import { kindLabel } from "@/lib/game-ui/taxonomy";
import { sizeLabel } from "@/lib/ai/presentation";
import type { ModelCatalogEntry } from "@/lib/ai/models";
import { formatDateTime } from "@/lib/format/datetime";

/** jsdom predates crypto.randomUUID; a v4-shaped id keeps the request valid there. */
function newId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  const digits = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16));
  digits[12] = "4";
  digits[16] = ((Number.parseInt(digits[16], 16) & 0x3) | 0x8).toString(16);
  const joined = digits.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

type ReconstructionPlan = {
  effectiveModelId: string;
  provider: string;
  size: string;
  quality: string;
  referenceIds: string[];
  omittedReferenceIds: string[];
  explanation: string;
  compiledPrompt: string;
  planHash: string;
};

/** Why an output cannot be used as a pack asset, or null when it can. */
function outputProblem(output: GameUiOutputView): string | null {
  if (output.alphaStatus !== "transparent") {
    return "Unusable: the result is opaque, so the background was not removed. Refine the mask and extract again.";
  }
  return null;
}

export default function ElementAssetDialog({
  renderId,
  elementSetId,
  element,
  imageUrl,
  imageWidth,
  imageHeight,
  outputs,
  models,
  onClose,
  onRefresh,
}: {
  renderId: string;
  elementSetId: string;
  element: GameUiElement;
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  outputs: GameUiOutputView[];
  models: ModelCatalogEntry[];
  onClose: () => void;
  onRefresh: () => void;
}) {
  const transparentModels = models.filter((model) => model.supportsTransparentBackground === true);
  const [matte, setMatte] = useState<Uint8Array<ArrayBuffer> | null>(null);
  const [instruction, setInstruction] = useState("");
  const [modelId, setModelId] = useState(transparentModels[0]?.id ?? "");
  const [size, setSize] = useState<string>(transparentModels[0]?.sizes[0] ?? "1024x1024");
  const [quality, setQuality] = useState<string>(transparentModels[0]?.qualities[0] ?? "auto");
  const [plan, setPlan] = useState<ReconstructionPlan | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: "error" | "success"; text: string } | null>(null);

  const { bounds } = element;
  // The preview shows the real crop: a background image cannot be expressed by
  // next/image's fit modes, so the box is scaled and offset by hand.
  const scale = Math.min(1, 420 / Math.max(1, bounds.width), 320 / Math.max(1, bounds.height));

  const uploadMatte = async (bytes: Uint8Array<ArrayBuffer>): Promise<string | null> => {
    const form = new FormData();
    form.append("file", new File([bytes], `matte-${element.id}.png`, { type: "image/png" }));
    form.append("elementSetId", elementSetId);
    const response = await fetch(`/api/game-ui/renders/${renderId}/elements/${element.id}/matte`, { method: "POST", body: form });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setFeedback({ kind: "error", text: `${body.error?.code ?? "UPLOAD_FAILED"}: ${body.error?.message ?? "Unable to store the matte"}` });
      return null;
    }
    return typeof body.inputId === "string" ? body.inputId : null;
  };

  const extract = async () => {
    if (!matte || busy !== null) return;
    setBusy("extract");
    setFeedback(null);
    try {
      const matteInputId = await uploadMatte(matte);
      if (!matteInputId) return;
      // The id is allocated before the request so an ambiguous response can be
      // resolved by asking for the same output again.
      const response = await fetch(`/api/game-ui/renders/${renderId}/elements/${element.id}/extract`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ elementSetId, matteInputId, outputId: newId() }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setFeedback({ kind: "error", text: `${body.error?.code ?? "EXTRACT_FAILED"}: ${body.error?.message ?? "Extraction failed"}` });
        return;
      }
      // The route answers with the stored row, not a view: the refreshed output list
      // is what tells the user whether the result is transparent or opaque.
      setFeedback({ kind: "success", text: "Extraction finished. Review the result below and accept it to include it in a pack." });
      onRefresh();
    } catch {
      setFeedback({ kind: "error", text: "NETWORK_ERROR: Extraction failed" });
    } finally {
      setBusy(null);
    }
  };

  const previewReconstruction = async () => {
    if (busy !== null || !instruction.trim() || !modelId) return;
    setBusy("plan");
    setPlan(null);
    setFeedback(null);
    try {
      const response = await fetch(`/api/game-ui/renders/${renderId}/elements/${element.id}/reconstruction-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ elementSetId, instruction: instruction.trim(), model: modelId, size, quality, costMode: "strict_1000" }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setFeedback({ kind: "error", text: `${body.error?.code ?? "PLAN_FAILED"}: ${body.error?.message ?? "Unable to resolve the reconstruction plan"}` });
        return;
      }
      setPlan(body.plan as ReconstructionPlan);
    } catch {
      setFeedback({ kind: "error", text: "NETWORK_ERROR: Unable to resolve the reconstruction plan" });
    } finally {
      setBusy(null);
    }
  };

  const reconstruct = async () => {
    if (!plan || busy !== null) return;
    setBusy("reconstruct");
    setFeedback(null);
    try {
      const response = await fetch(`/api/game-ui/renders/${renderId}/elements/${element.id}/reconstruct`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          elementSetId,
          instruction: instruction.trim(),
          model: modelId,
          size,
          quality,
          costMode: "strict_1000",
          requestId: newId(),
          // The hash the plan step returned; consent is never renewed silently.
          consent: { planHash: plan.planHash },
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setPlan(null);
        setFeedback({ kind: "error", text: `${body.error?.code ?? "SUBMIT_FAILED"}: ${body.error?.message ?? "Unable to start the reconstruction"}` });
        return;
      }
      setPlan(null);
      setFeedback({ kind: "success", text: "Reconstruction started. The result appears below when the provider finishes." });
      onRefresh();
    } catch {
      setFeedback({ kind: "error", text: "NETWORK_ERROR: Unable to start the reconstruction" });
    } finally {
      setBusy(null);
    }
  };

  const review = async (output: GameUiOutputView, status: "accepted" | "discarded") => {
    if (busy !== null) return;
    setBusy(output.id);
    setFeedback(null);
    try {
      const response = await fetch(`/api/game-ui/outputs/${output.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedReviewStatus: output.reviewStatus, status }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setFeedback({ kind: "error", text: `${body.error?.code ?? "REVIEW_FAILED"}: ${body.error?.message ?? "Unable to review this output"}` });
        return;
      }
      onRefresh();
    } catch {
      setFeedback({ kind: "error", text: "NETWORK_ERROR: Unable to review this output" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{element.name}</DialogTitle>
          <DialogDescription className="text-xs">
            {kindLabel(element.kind, element.custom_type)} · box {bounds.width}×{bounds.height} at {bounds.x},{bounds.y} of the
            source image.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="overflow-hidden rounded-lg border border-border" style={{ width: bounds.width * scale, height: bounds.height * scale }}>
            <Image
              src={imageUrl}
              alt={`${element.name} source crop`}
              width={imageWidth}
              height={imageHeight}
              sizes={`${Math.round(bounds.width * scale)}px`}
              style={{ width: imageWidth * scale, height: imageHeight * scale, maxWidth: "none", marginLeft: -bounds.x * scale, marginTop: -bounds.y * scale }}
            />
          </div>

          {feedback && (
            <Alert variant={feedback.kind === "error" ? "destructive" : "default"} role="alert" className="px-3 py-2">
              <AlertDescription className={feedback.kind === "error" ? "text-sm" : "text-sm text-success"}>{feedback.text}</AlertDescription>
            </Alert>
          )}

          <Tabs defaultValue="exact" className="gap-3">
            <TabsList variant="line" className="h-auto! flex flex-wrap gap-1 bg-transparent p-0">
              <TabsTrigger value="exact" className="h-11 min-h-11 px-3 text-sm font-medium">Exact extraction</TabsTrigger>
              <TabsTrigger value="reconstruct" className="h-11 min-h-11 px-3 text-sm font-medium">AI reconstruction</TabsTrigger>
            </TabsList>

            <TabsContent value="exact" className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Keeps the original pixels of this box; the matte only decides which of them survive. Nothing is redrawn, so the
                result matches the screen exactly.
              </p>
              <ForegroundMaskEditor imageUrl={imageUrl} width={bounds.width} height={bounds.height} onMatteChange={setMatte} />
              <Button type="button" onClick={() => void extract()} disabled={busy !== null || matte === null}>
                {busy === "extract" ? <><LoaderCircle className="size-4 animate-spin" aria-hidden /> Extracting…</> : <><Scissors className="size-4" aria-hidden /> Extract exact pixels</>}
              </Button>
              {matte === null && <p className="text-xs text-warning">Nothing is kept in this matte, so there is nothing to extract yet.</p>}
            </TabsContent>

            <TabsContent value="reconstruct" className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Asks a model to redraw this element on a transparent background. <strong>It may differ from the original</strong> —
                use it when the element is occluded or cut off, not when you need the exact pixels.
              </p>
              {transparentModels.length === 0 ? (
                <Alert variant="default" role="status" className="px-3 py-2">
                  <AlertDescription className="text-sm text-warning">
                    No configured model can return a transparent background in this workspace, so reconstruction is unavailable.
                    Exact extraction still works.
                  </AlertDescription>
                </Alert>
              ) : (
                <>
                  <div className="space-y-1">
                    <Label htmlFor="reconstruction-instruction" className="text-xs font-medium text-muted-foreground">What should the element show?</Label>
                    <Textarea
                      id="reconstruction-instruction"
                      value={instruction}
                      maxLength={2000}
                      className="min-h-20"
                      placeholder="e.g. the same button with the hidden edge completed"
                      onChange={(event) => { setInstruction(event.target.value); setPlan(null); }}
                    />
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <div className="space-y-1">
                      <Label htmlFor="reconstruction-model" className="text-xs font-medium text-muted-foreground">Model</Label>
                      <Select value={modelId} onValueChange={(value) => { const next = transparentModels.find((model) => model.id === value); if (!next) return; setModelId(next.id); setSize(next.sizes[0]); setQuality(next.qualities[0]); setPlan(null); }}>
                        <SelectTrigger id="reconstruction-model" className="w-full"><SelectValue /></SelectTrigger>
                        <SelectContent>{transparentModels.map((model) => <SelectItem key={model.id} value={model.id}>{model.label}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="reconstruction-size" className="text-xs font-medium text-muted-foreground">Size</Label>
                      <Select value={size} onValueChange={(value) => { setSize(value); setPlan(null); }}>
                        <SelectTrigger id="reconstruction-size" className="w-full"><SelectValue /></SelectTrigger>
                        <SelectContent>{(transparentModels.find((model) => model.id === modelId)?.sizes ?? ["1024x1024"]).map((option) => <SelectItem key={option} value={option}>{sizeLabel(option)}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="reconstruction-quality" className="text-xs font-medium text-muted-foreground">Quality</Label>
                      <Select value={quality} onValueChange={(value) => { setQuality(value); setPlan(null); }}>
                        <SelectTrigger id="reconstruction-quality" className="w-full"><SelectValue /></SelectTrigger>
                        <SelectContent>{(transparentModels.find((model) => model.id === modelId)?.qualities ?? ["auto"]).map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                  </div>
                  <Button type="button" variant={plan ? "outline" : "default"} onClick={() => void previewReconstruction()} disabled={busy !== null || !instruction.trim()}>
                    {busy === "plan" ? <><LoaderCircle className="size-4 animate-spin" aria-hidden /> Preparing…</> : "Preview reconstruction plan"}
                  </Button>
                  {plan && (
                    <Card className="gap-2 p-4">
                      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                        <div><dt className="text-muted-foreground">Model</dt><dd className="truncate font-medium">{plan.effectiveModelId}</dd></div>
                        <div><dt className="text-muted-foreground">Provider</dt><dd className="truncate font-medium">{plan.provider}</dd></div>
                        <div><dt className="text-muted-foreground">Size</dt><dd className="font-medium">{sizeLabel(plan.size)}</dd></div>
                        <div><dt className="text-muted-foreground">Quality</dt><dd className="font-medium">{plan.quality}</dd></div>
                      </dl>
                      {plan.explanation && <p className="text-xs text-muted-foreground">{plan.explanation}</p>}
                      <p className="text-xs text-warning">This calls a paid provider once and the result may not match the original.</p>
                      <Collapsible>
                        <CollapsibleTrigger asChild>
                          <Button variant="ghost" className="h-9 w-full justify-start px-2 text-xs font-normal text-muted-foreground">Compiled prompt</Button>
                        </CollapsibleTrigger>
                        <CollapsibleContent>
                          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-accent p-3 text-[11px]">{plan.compiledPrompt}</pre>
                        </CollapsibleContent>
                      </Collapsible>
                      <Button type="button" onClick={() => void reconstruct()} disabled={busy !== null}>
                        {busy === "reconstruct" ? <><LoaderCircle className="size-4 animate-spin" aria-hidden /> Starting…</> : <><Sparkles className="size-4" aria-hidden /> Confirm reconstruction</>}
                      </Button>
                    </Card>
                  )}
                </>
              )}
            </TabsContent>
          </Tabs>

          <Card className="gap-3 p-4">
            <h3 className="text-sm font-semibold">Outputs for this element</h3>
            {outputs.length === 0 ? (
              <p role="status" className="text-xs text-muted-foreground">No output yet. Extract the exact pixels or reconstruct the element.</p>
            ) : (
              <ul className="space-y-3">
                {outputs.map((output) => {
                  const problem = outputProblem(output);
                  return (
                    <li key={output.id} className="flex flex-wrap items-start gap-3 rounded-lg border border-border p-3">
                      <span className="checker-stage flex size-16 shrink-0 items-center justify-center overflow-hidden rounded border border-border">
                        {output.url ? <Image src={output.url} alt="" width={64} height={64} sizes="64px" className="size-16 object-contain" /> : <span className="text-[10px] text-muted-foreground">No preview</span>}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap gap-2">
                          <Badge variant="secondary">{output.mode === "exact" ? "Exact pixels" : "AI reconstruction"}</Badge>
                          <Badge variant={output.alphaStatus === "transparent" ? "default" : "destructive"}>{output.alphaStatus}</Badge>
                          <Badge variant="secondary">{output.reviewStatus}</Badge>
                        </div>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {output.width}×{output.height} · {formatDateTime(output.createdAt)}
                          {output.model ? ` · ${output.model}` : ""}
                        </p>
                        {problem && <p role="alert" className="mt-1 text-xs text-warning">{problem}</p>}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          size="sm"
                          aria-label={`Accept output ${output.id}`}
                          disabled={busy !== null || problem !== null || output.reviewStatus === "accepted"}
                          onClick={() => void review(output, "accepted")}
                        >
                          <CheckCircle2 className="size-3.5" aria-hidden /> Accept
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          aria-label={`Discard output ${output.id}`}
                          disabled={busy !== null || output.reviewStatus === "discarded"}
                          onClick={() => void review(output, "discarded")}
                        >
                          <Trash2 className="size-3.5" aria-hidden /> Discard
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>
      </DialogContent>
    </Dialog>
  );
}
