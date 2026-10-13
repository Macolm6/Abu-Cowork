import type { AgentLocale } from '@/types';
import type { Team } from '@/stores/teamStore';

/**
 * The team as the interface shows it in `locale`: each display field is
 * `i18n[locale].<field> ?? <field>`. A team with no text for `locale` is
 * returned as it is. Display only — saving, matching by name and prompts read
 * the team from the store.
 */
export function localizedTeam(team: Team, locale: AgentLocale): Team {
  const text = team.i18n?.[locale];
  if (!text) return team;
  return {
    ...team,
    name: text.name ?? team.name,
    description: text.description ?? team.description,
    intro: text.intro ?? team.intro,
    expertise: text.expertise ?? team.expertise,
    samplePrompts: text.samplePrompts ?? team.samplePrompts,
  };
}
