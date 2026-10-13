import type { AgentLocale, SkillMetadata } from '@/types';

/**
 * The description the interface shows for a skill in `locale`:
 * `displayDescription[locale] ?? description`. Prompts read `description`.
 */
export function localizedSkillDescription(
  skill: Pick<SkillMetadata, 'description' | 'displayDescription'>,
  locale: AgentLocale,
): string {
  return skill.displayDescription?.[locale] ?? skill.description;
}
