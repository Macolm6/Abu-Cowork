/**
 * Source-to-UX-category mapping.
 *
 * The Toolbox shows 3 top-level skill buckets (`SkillUXCategory`), split by
 * whose work a skill is:
 *
 *   - **mine** — skills the user or Abu wrote for them
 *     (user/standard/project/project-standard/workspace-auto), and skills the
 *     organization pushed (badged).
 *   - **agent-evolved** — draft only. Pending agent proposals awaiting
 *     user review. Shown via SkillDraftsPanel when draftsCount > 0.
 *   - **market** — the 市场 bucket: what ships with the app, and what a
 *     plugin brought in (badged, read-only, leaves with its plugin). Both
 *     are someone else's work, as on the experts and teams pages.
 *
 * All Toolbox grouping goes through this function, so the enum-to-
 * bucket mapping stays in one place and it's hard to forget a new
 * source (unknown values log a warning instead of silently landing
 * in `mine`).
 */

import type { SkillSource, SkillUXCategory } from '../../types';

export function sourceToUXCategory(source: SkillSource | undefined): SkillUXCategory | null {
  switch (source) {
    case 'user':
    case 'standard':
    case 'project':
    case 'project-standard':
      return 'mine';
    case 'workspace-auto':
      return 'mine';
    case 'enterprise':
      // Pushed to this user by their organization: theirs to use, badged.
      return 'mine';
    case 'plugin':
      // Brought in by a plugin: badged with it, read-only, and removed by
      // uninstalling the plugin.
      return 'market';
    case 'draft':
      return 'agent-evolved';
    case 'builtin':
      return 'market';
    case undefined:
      // Legacy skills loaded before `source` was populated. Treat as
      // "mine" — matches historical behavior for un-tagged files.
      return 'mine';
    default: {
      // Exhaustiveness guard — if SkillSource grows a new member
      // and this switch isn't updated, TS narrows to `never` and
      // the assignment fails at build time. We also log at runtime
      // so mislabeled on-disk skills don't silently disappear.
      const _exhaustive: never = source;
      void _exhaustive;
      console.warn(
        `[sourceToUXCategory] unknown skill source "${String(source)}" — skill will be hidden`,
      );
      return null;
    }
  }
}
