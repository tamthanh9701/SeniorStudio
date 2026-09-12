"use client";

import { useState } from "react";
import { LoaderCircle } from "lucide-react";
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
    const response = await fetch(`/api/styles/${styleId}/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedUpdatedAt, userWishes: wishes || undefined, answers: Object.values(answers) }),
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok) await onUpdated();
    else setError(`${body.error?.code ?? "SYNTHESIS_FAILED"}: ${body.error?.message ?? "Synthesis failed"}`);
    setSubmitting(false);
  };
  return <section className="space-y-3 rounded-xl border border-white/10 bg-white/[0.025] p-3">
    <div><h4 className="font-medium text-[#d0d5dd]">Refine your style</h4><p className="mt-1 text-xs text-[#667085]">Answer questions and describe the direction for a synthesis proposal.</p></div>
    <textarea className="studio-control min-h-20 w-full" placeholder="Optional wishes for the style" value={wishes} onChange={(event) => setWishes(event.target.value)} />
    {questions.questions.map((question) => {
      const answer = answers[question.id];
      return <fieldset key={question.id} className="space-y-2 rounded-lg border border-white/10 p-3">
        <legend className="px-1 text-sm font-medium">{question.question}</legend>
        <p className="text-xs text-[#667085]">{question.help_text}</p>
        {question.type === "single_choice" && <div className="grid gap-2">{question.options?.map((option) => <label key={option} className="flex gap-2 text-xs"><input type="radio" name={question.id} checked={answer?.selected_option === option} onChange={() => update(question.id, { selected_option: option })} />{option}</label>)}</div>}
        {question.type === "multi_choice" && <div className="grid gap-2">{question.options?.map((option) => { const selected = answer?.selected_options ?? []; return <label key={option} className="flex gap-2 text-xs"><input type="checkbox" checked={selected.includes(option)} onChange={(event) => update(question.id, { selected_options: event.target.checked ? [...selected, option] : selected.filter((item) => item !== option) })} />{option}</label>; })}</div>}
        {question.type === "short_text" && <textarea className="studio-control min-h-20 w-full" value={answer?.custom_text ?? ""} onChange={(event) => update(question.id, { custom_text: event.target.value })} />}
        {question.type === "scale" && <label className="flex items-center gap-3 text-xs"><input type="range" min={1} max={10} value={answer?.scale_value ?? (typeof question.default_answer === "number" ? question.default_answer : 5)} onChange={(event) => update(question.id, { scale_value: Number(event.target.value) })} /><span>{answer?.scale_value ?? (typeof question.default_answer === "number" ? question.default_answer : 5)}/10</span></label>}
      </fieldset>;
    })}
    {error && <p role="alert" className="text-xs text-[#ff9b9b]">{error}</p>}
    <button type="button" className="studio-button-primary w-full" disabled={submitting} onClick={() => void submit()}>{submitting ? <LoaderCircle className="size-4 animate-spin" /> : null} Preview synthesis proposal</button>
  </section>;
}


