export type CostMode = 'strict_style' | 'strict_1000' | 'balanced' | 'quality';

export const COST_MODE_OPTIONS: Array<{
  id: CostMode; label: string; description: string;
  styleBudget: number; // maxChars for capsule
  defaultReferenceLimit: number;
  defaultTemperature: number;
  preserveRequestedModel: boolean;
}> = [
  { id: 'strict_style',  label: 'Strict style',  description: 'Best fidelity. Capsule 2800 chars, ≤4 refs, temp 0.45.', styleBudget: 2800, defaultReferenceLimit: 4, defaultTemperature: 0.45, preserveRequestedModel: true },
  { id: 'strict_1000',   label: 'Strict budget', description: 'Low cost. Capsule 1600, 1 ref, temp 0.75.',           styleBudget: 1600, defaultReferenceLimit: 1, defaultTemperature: 0.75, preserveRequestedModel: false },
  { id: 'balanced',      label: 'Balanced',      description: 'Middle ground. Capsule 1600, ≤2 refs, temp 0.70.',      styleBudget: 1600, defaultReferenceLimit: 2, defaultTemperature: 0.70, preserveRequestedModel: false },
  { id: 'quality',       label: 'Quality',        description: 'High quality. Capsule 2400, ≤4 refs, temp 0.65.',       styleBudget: 2400, defaultReferenceLimit: 4, defaultTemperature: 0.65, preserveRequestedModel: true },
];

export function getCostModeConfig(mode: CostMode) {
  return (
    COST_MODE_OPTIONS.find((m) => m.id === mode) ?? COST_MODE_OPTIONS[1]
  );
}

export const getStyleBudget = (mode: CostMode) => getCostModeConfig(mode).styleBudget;
export const getReferenceLimit = (mode: CostMode) => getCostModeConfig(mode).defaultReferenceLimit;
export const getTemperature = (mode: CostMode) => getCostModeConfig(mode).defaultTemperature;
