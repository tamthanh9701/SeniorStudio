import type { StyleClarificationQuestion, StyleClarificationQuestionSet } from './clarification-questions';

export const STYLE_CLARIFICATION_ANSWERS_VERSION = 'style_clarification_answers_v1' as const;

export interface StyleClarificationAnswer {
  question_id: string;
  selected_option?: string;
  selected_options?: string[];
  custom_text?: string;
  scale_value?: number;
  skipped?: boolean;
}

export interface StyleClarificationAnswerSet {
  version: typeof STYLE_CLARIFICATION_ANSWERS_VERSION;
  answered_at: string;
  answers: StyleClarificationAnswer[];
}

export interface StyleClarificationAnswerValidationResult {
  ok: boolean;
  answers: StyleClarificationAnswer[];
  errors: string[];
  missing_required_question_ids: string[];
}

type UnknownRecord = Record<string, unknown>;
function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}


function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
  return items.length ? items : undefined;
}

function asScale(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(1, Math.min(10, parsed));
}

function hasCustomOtherSelection(answer: StyleClarificationAnswer): boolean {
  const values = [answer.selected_option, ...(answer.selected_options || [])].filter(Boolean).join(' ').toLowerCase();
  return values.includes('tôi sẽ tự ghi rõ') || values.includes('custom') || values.includes('i will provide') || values.includes('use a custom description');
}

function isAnswered(question: StyleClarificationQuestion, answer: StyleClarificationAnswer): boolean {
  if (answer.skipped) return false;
  if (question.type === 'single_choice') {
    if (!answer.selected_option && !answer.custom_text) return false;
    // Validate option membership when options array exists
    if (answer.selected_option && Array.isArray(question.options) && question.options.length > 0) {
      if (!question.options.includes(answer.selected_option)) return false;
    }
    return true;
  }
  if (question.type === 'multi_choice') return Boolean(answer.selected_options?.length || answer.custom_text);
  if (question.type === 'short_text') return Boolean(answer.custom_text);
  if (question.type === 'scale') return typeof answer.scale_value === 'number';
  return false;
}

function normalizeOneAnswer(question: StyleClarificationQuestion, raw: unknown): StyleClarificationAnswer {
  if (!raw || typeof raw !== 'object') return { question_id: question.id, skipped: true };
  const rawRecord = raw as Record<string, unknown>;
  const answer: StyleClarificationAnswer = {
    question_id: question.id,
    selected_option: asString(rawRecord.selected_option),
    selected_options: asStringArray(rawRecord.selected_options),
    custom_text: asString(rawRecord.custom_text),
    scale_value: asScale(rawRecord.scale_value),
    skipped: rawRecord.skipped === true,
  };

  if (question.type === 'single_choice' && !answer.selected_option && Array.isArray(rawRecord.selected_options)) {
    answer.selected_option = asString(rawRecord.selected_options[0]);
  }
  if (question.type === 'multi_choice' && !answer.selected_options && typeof rawRecord.selected_option === 'string') {
    answer.selected_options = [rawRecord.selected_option.trim()].filter(Boolean);
  }
  return answer;
}

export function normalizeStyleClarificationAnswers(params: {
  questions: StyleClarificationQuestionSet;
  rawAnswers: unknown;
}): StyleClarificationAnswerValidationResult {
  const { questions, rawAnswers } = params;
  const errors: string[] = [];
  const missingRequired: string[] = [];

  const providedAnswers: unknown[] = Array.isArray(rawAnswers)
    ? rawAnswers
    : isRecord(rawAnswers) && Array.isArray(rawAnswers.answers)
      ? rawAnswers.answers
      : [];
  const providedById = new Map<string, unknown>();
  for (const raw of providedAnswers) {
    if (raw && typeof raw === 'object' && typeof (raw as Record<string, unknown>).question_id === 'string') {
      const id = (raw as Record<string, unknown>).question_id as string;
      if (providedById.has(id)) {
        errors.push(`Duplicate question_id: ${id}`);
        continue;
      }
      providedById.set(id, raw);
    }
  }

  const knownIds = new Set(questions.questions.map(q => q.id));
  for (const [id] of providedById) {
    if (!knownIds.has(id)) {
      errors.push(`Unknown question_id: ${id}`);
    }
  }
  const answers = questions.questions.map((question) => {
    const normalized = normalizeOneAnswer(question, providedById.get(question.id));
    if (question.priority === 'required' && !isAnswered(question, normalized)) {
      missingRequired.push(question.id);
      errors.push(`Required style clarification question was not answered: ${question.id}`);
    }
    if (hasCustomOtherSelection(normalized) && !normalized.custom_text) {
      errors.push(`Custom text is required for question ${question.id} because the answer selected a custom/freeform option.`);
    }
    if (question.type === 'single_choice' && normalized.selected_option && Array.isArray(question.options) && question.options.length > 0 && !question.options.includes(normalized.selected_option)) {
      errors.push(`Selected option '${normalized.selected_option}' is not a valid option for question ${question.id}.`);
    }
    return normalized;
  });

  return {
    ok: errors.length === 0,
    answers,
    errors,
    missing_required_question_ids: missingRequired,
  };
}

export function makeStyleClarificationAnswerSet(answers: StyleClarificationAnswer[]): StyleClarificationAnswerSet {
  return {
    version: STYLE_CLARIFICATION_ANSWERS_VERSION,
    answered_at: new Date().toISOString(),
    answers,
  };
}
