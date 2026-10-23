/**
 * Sidecar-local replacement for `src/core/skill/skillNamePolicy.ts`.
 *
 * A BUNDLE-GRAPH shim: the real module's default reads the organization's
 * policy through `getCurrentPolicy()`, which reaches the enterprise store —
 * never allowed in this bundle. `skill/loader.ts` is here only because
 * `subagentLoop.ts` imports `prompts/preloadedSkills.ts`, which imports it;
 * the sidecar's loader is never populated. Skills are resolved in the shell:
 * `use_skill` runs there and returns the instructions in its tool result,
 * skills active at run start arrive as a rendered system-prompt section with
 * their tool facts (`activeSkillInfoSnapshot`, `state.convPatch`), and a
 * subagent's preloaded skills arrive as rendered text — `subagentHost.ts`.
 *
 * The default therefore refuses every name. Today that changes nothing (there
 * is nothing to refuse). If the sidecar ever starts discovering skills without
 * wiring a real policy through `setSkillNamePolicy`, every skill disappears —
 * loud and caught at once — instead of the organization's blacklist quietly
 * stopping to apply.
 */
import type { SkillNamePolicy } from '@/core/skill/skillNamePolicy';

let current: SkillNamePolicy = () => false;

export function isSkillNameAllowed(name: string): boolean {
  return current(name);
}

export function setSkillNamePolicy(policy: SkillNamePolicy): void {
  current = policy;
}
