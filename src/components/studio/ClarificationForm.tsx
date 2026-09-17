"use client";

import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import type { StyleClarificationQuestionSet } from "@/lib/style/clarification-questions";
import type { StyleClarificationAnswer } from "@/lib/style/clarification-answers";

interface ClarificationFormProps {
  styleId: string;
  expectedUpdatedAt: string;
  questions: StyleClarificationQuestionSet;
  onUpdated: () => Promise<unknown>;
}

export default function ClarificationForm({ styleId, expectedUpdatedAt, questions, onUpdated }: ClarificationFormProps) {
  const [answers, setAnswers] = useState<Record<string, StyleClarificationAnswer>>({});
  const [wishes, setWishes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = (questionId: string, patch: Partial<StyleClarificationAnswer>) => setAnswers((current) => ({ ...current, [questionId]: { ...current[questionId], ...patch, question_id: questionId } }));

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/styles/${styleId}/synthesize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedUpdatedAt, userWishes: wishes || undefined, answers: Object.values(answers) }),
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok) await onUpdated();
      else setError(`${body.error?.code ?? "SYNTHESIS_FAILED"}: ${body.error?.message ?? "Synthesis failed"}`);
    } catch {
      setError("NETWORK_ERROR: Unable to request a synthesis proposal");
    } finally {
      setSubmitting(false);
    }
  };
  return <Card className="gap-3 py-4">
    <CardHeader className="px-4">
      <CardTitle className="font-medium">Refine your style</CardTitle>
      <CardDescription className="mt-1 text-xs">Answer questions and describe the direction for a synthesis proposal.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-3 px-4">
      <Textarea placeholder="Optional wishes for the style" value={wishes} onChange={(event) => setWishes(event.target.value)} />
      {questions.questions.map((question) => {
        const answer = answers[question.id];
        return <fieldset key={question.id} className="space-y-2 rounded-lg border p-3">
          <legend className="px-1 text-sm font-medium">{question.question}</legend>
          <p className="text-xs text-muted-foreground">{question.help_text}</p>
          {question.type === "single_choice" && question.options?.length ? <Select value={answer?.selected_option ?? undefined} onValueChange={(next) => update(question.id, { selected_option: next })}>
            <SelectTrigger id={`${question.id}-option`} className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{question.options.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent>
          </Select> : null}
          {question.type === "multi_choice" && <div className="grid gap-2">{question.options?.map((option, index) => { const selected = answer?.selected_options ?? []; return <Label key={option} className="flex gap-2 text-xs font-normal"><Checkbox id={`${question.id}-${index}`} checked={selected.includes(option)} onCheckedChange={(checked) => update(question.id, { selected_options: checked === true ? [...selected, option] : selected.filter((item) => item !== option) })} />{option}</Label>; })}</div>}
          {question.type === "short_text" && <Textarea value={answer?.custom_text ?? ""} onChange={(event) => update(question.id, { custom_text: event.target.value })} />}
          {question.type === "scale" && <div className="flex items-center gap-3 text-xs"><Slider min={1} max={10} value={[answer?.scale_value ?? (typeof question.default_answer === "number" ? question.default_answer : 5)]} onValueChange={(next) => update(question.id, { scale_value: next[0] })} /><span>{answer?.scale_value ?? (typeof question.default_answer === "number" ? question.default_answer : 5)}/10</span></div>}
        </fieldset>;
      })}
      {error && <Alert variant="destructive"><AlertDescription className="text-xs">{error}</AlertDescription></Alert>}
      <Button type="button" className="w-full" disabled={submitting} onClick={() => void submit()}>{submitting ? <LoaderCircle className="size-4 animate-spin" /> : null} Preview synthesis proposal</Button>
    </CardContent>
  </Card>;
}
