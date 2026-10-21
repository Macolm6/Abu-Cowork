/**
 * Model family used to file eval results under `eval-results/<family>/`.
 *
 * Local to the eval framework on purpose: the product's model profile layer
 * (`src/core/llm`) is being built in a separate batch, and the eval must keep
 * running against whatever that layer looks like. The six named families are
 * the ones the model-profile brief supports first; everything else is `other`.
 */
export type EvalModelFamily = 'claude' | 'gpt' | 'deepseek' | 'kimi' | 'qwen' | 'glm' | 'other';

export const EVAL_MODEL_FAMILIES: readonly EvalModelFamily[] = ['claude', 'gpt', 'deepseek', 'kimi', 'qwen', 'glm', 'other'];

export function resolveEvalFamily(modelId: string): EvalModelFamily {
  const bare = (modelId.includes('/') ? modelId.split('/').pop()! : modelId).toLowerCase();
  if (/claude/.test(bare)) return 'claude';
  if (/^o[1-9]\b|^o[1-9]-|gpt-?[345]/.test(bare)) return 'gpt';
  if (/deepseek/.test(bare)) return 'deepseek';
  if (/kimi|moonshot/.test(bare)) return 'kimi';
  if (/qwen|qwq/.test(bare)) return 'qwen';
  if (/glm/.test(bare)) return 'glm';
  return 'other';
}
