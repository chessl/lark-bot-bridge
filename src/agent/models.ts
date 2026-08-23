/** Selection meaning "let OMP choose its configured default model". */
export const DEFAULT_MODEL = 'default';

export interface ModelOption {
  value: string;
  label: string;
}

const OMP_MODELS: ModelOption[] = [
  { value: DEFAULT_MODEL, label: '跟随 OMP 默认（不指定）' },
];

export function supportedModels(): ModelOption[] {
  return OMP_MODELS;
}

export function normalizeModelSelection(value: string | undefined): string {
  return value?.trim() || DEFAULT_MODEL;
}

export function resolveModelArg(value: string | undefined): string | undefined {
  const normalized = normalizeModelSelection(value);
  return normalized === DEFAULT_MODEL ? undefined : normalized;
}

export function modelLabel(value: string | undefined): string {
  const normalized = normalizeModelSelection(value);
  return OMP_MODELS.find((model) => model.value === normalized)?.label ?? normalized;
}
