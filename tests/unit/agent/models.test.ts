import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL,
  modelLabel,
  normalizeModelSelection,
  resolveModelArg,
  supportedModels,
} from '../../../src/agent/models.js';

describe('OMP model selection', () => {
  it('offers the OMP default sentinel', () => {
    expect(supportedModels()).toEqual([{ value: DEFAULT_MODEL, label: '跟随 OMP 默认（不指定）' }]);
  });

  it('preserves explicit OMP model ids and omits the default flag', () => {
    expect(normalizeModelSelection('custom-model')).toBe('custom-model');
    expect(normalizeModelSelection(undefined)).toBe(DEFAULT_MODEL);
    expect(resolveModelArg('custom-model')).toBe('custom-model');
    expect(resolveModelArg(DEFAULT_MODEL)).toBeUndefined();
    expect(modelLabel(DEFAULT_MODEL)).toContain('OMP 默认');
    expect(modelLabel('custom-model')).toBe('custom-model');
  });
});
