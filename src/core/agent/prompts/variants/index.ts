/**
 * Prompt fragments per model family.
 *
 * The orchestrator asks for the variant named by the model profile's
 * `harness.promptVariant`; a family without a file of its own, and a run
 * without a profile, get the default. Each field falls back on its own, so a
 * family file states only what differs.
 */
import type { ModelFamily } from '@/core/llm/model-data/families';
import { claudeVariant } from './claude';
import { deepseekVariant } from './deepseek';
import { defaultVariant } from './default';
import { gptVariant } from './gpt';
import { kimiVariant } from './kimi';
import type { PromptVariant, ResolvedPromptVariant } from './types';

export type { PromptVariant, ResolvedPromptVariant } from './types';

export const PROMPT_VARIANTS: Readonly<Partial<Record<ModelFamily, PromptVariant>>> = {
  claude: claudeVariant,
  gpt: gptVariant,
  deepseek: deepseekVariant,
  kimi: kimiVariant,
};

/** The profile fields the prompt builders read. */
export type PromptVariantSource = { harness: { promptVariant: ModelFamily } };

export function resolvePromptVariant(profile?: PromptVariantSource): ResolvedPromptVariant {
  const family = profile?.harness.promptVariant;
  const variant = (family && PROMPT_VARIANTS[family]) ?? defaultVariant;
  const planning = variant.planning ?? defaultVariant.planning;
  if (planning === undefined) throw new Error('default prompt variant has no planning text');
  return {
    persona: variant.persona ?? defaultVariant.persona,
    planning,
    familyNotes: variant.familyNotes ?? defaultVariant.familyNotes,
  };
}

/**
 * The family notes as a prompt section body, or an empty string for a family
 * without notes. Shared by the main loop's section list and the subagent's
 * plain-string prompt.
 */
export function familyNotesFor(profile?: PromptVariantSource): string {
  return resolvePromptVariant(profile).familyNotes ?? '';
}
