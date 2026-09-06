// Style analysis provider surface. Adapters turn reference bytes plus the
// analysis system prompt into a raw schema candidate.
import type { ReferencePreprocessSummary } from "../reference-preprocess";

export interface StyleAnalysisRequest {
  references: Array<{ buffer: Buffer; mimeType: string }>;
  systemPrompt: string;
  userMessage: string;
  referenceSummary: ReferencePreprocessSummary;
  timeoutMs: number;
}

export interface StyleAnalysisResult {
  schema: unknown;
  rawText: string;
}

export interface StyleAnalysisProvider {
  analyze(input: StyleAnalysisRequest): Promise<StyleAnalysisResult>;
}
