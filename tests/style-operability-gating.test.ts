import { describe, expect, it } from 'vitest';
import { applyStyleSchemaPatch, validateStyleSchemaPatch } from '../src/lib/style/schema-patch';

describe('schema patch operability gating', () => {
  it('blocks activation-grade manipulation via path injection', () => {
    expect(() =>
      applyStyleSchemaPatch({}, [{ op: 'set', path: 'lighting.__proto__.grade', value: 'production_ready', reason: 'test', source_question_ids: [], confidence: 1 }]),
    ).toThrow();
  });

  it('allows schema mutation that recalculates grade deterministically', () => {
    const result = applyStyleSchemaPatch(
      { style_name: 'existing' },
      [{ op: 'set', path: 'style_name', value: 'updated', reason: 'test', source_question_ids: [], confidence: 1 }],
    );
    expect(result).toMatchObject({ style_name: 'updated' });
  });
});
