/**
 * Rendering and resolution of a conversation's active skills.
 *
 * Shell-only: everything here reads the skill index (`skillLoader`), which is
 * populated in the shell process and nowhere else. The agent loop may run in
 * the sidecar, so it never renders skill text itself. It receives the text
 * (a `use_skill` tool result, or the entry system-prompt section for skills
 * that were already active when the run started) and the per-skill facts it
 * needs for tool exposure (`ActiveSkillInfo`).
 */
import type { PromptSection } from '../llm/promptSections';
import type { Skill } from '../../types';
import { joinPath } from '../../utils/pathUtils';
import { skillLoader } from './loader';
import { substituteVariables } from './preprocessor';

/** What the agent loop needs to know about an active skill. Plain data, safe to send to the sidecar. */
export interface ActiveSkillInfo {
  name: string;
  blockedTools?: string[];
}

/**
 * Resolve active skill names against the skill index. A name the index does
 * not return (removed, disabled by the organization's policy) is dropped, so
 * it stops influencing the run.
 */
export function resolveActiveSkillInfo(names: readonly string[] | undefined): ActiveSkillInfo[] {
  const resolved: ActiveSkillInfo[] = [];
  for (const name of names ?? []) {
    const skill = skillLoader.getSkill(name);
    if (!skill) continue;
    resolved.push(skill.blockedTools?.length
      ? { name: skill.name, blockedTools: [...skill.blockedTools] }
      : { name: skill.name });
  }
  return resolved;
}

/** One skill's instructions: its body with variables substituted, then its reference files. */
export async function renderSkillInstructions(
  skill: Skill,
  args: string,
  conversationId: string,
): Promise<string> {
  const processed = substituteVariables(skill.content, args, skill.skillDir, conversationId);
  let block = `### ${skill.name}\n${processed}`;

  // SK-5: List supporting files for progressive disclosure
  const supportingFiles = await skillLoader.listSupportingFiles(skill.name);
  if (supportingFiles.length > 0) {
    block += '\n\n**Available reference files** (use `read_skill_file` tool to load when needed):\n';
    block += supportingFiles.map(f => {
      if (f.startsWith('scripts/') || f.startsWith('scripts\\')) {
        const absPath = joinPath(skill.skillDir, f);
        return `- ${f} (path: ${absPath})`;
      }
      return `- ${f}`;
    }).join('\n');
  }

  return block;
}

/**
 * System-prompt section for the skills that are already active when a run
 * starts (a project's default skills). Skills the model activates during the
 * run arrive in the `use_skill` tool result instead.
 */
export async function buildActiveSkillsSection(
  names: readonly string[] | undefined,
  argsByName: Readonly<Record<string, string>> | undefined,
  conversationId: string,
): Promise<PromptSection | undefined> {
  const blocks: string[] = [];
  for (const name of names ?? []) {
    const skill = skillLoader.getSkill(name);
    if (!skill) continue;
    blocks.push(await renderSkillInstructions(skill, argsByName?.[name] ?? '', conversationId));
  }
  if (blocks.length === 0) return undefined;
  return {
    name: 'active-skills',
    text: `## Active Skill Instructions\n${blocks.join('\n\n')}`,
    cacheable: true,
  };
}
