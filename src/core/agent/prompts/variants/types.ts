/**
 * One model family's prompt fragments.
 *
 * Every field is optional: a family file states only what differs from
 * `default.ts`, and `resolvePromptVariant` fills each missing field from the
 * default on its own. The texts are English, like every other prompt section.
 */
export interface PromptVariant {
  /** Replaces the capability prompt (`basePrompt`) and the fork-mode identity line. */
  persona?: string;
  /** Replaces the `## Execution Rules` section. */
  planning?: string;
  /** Appended as its own section after the planning rules; also appended to a subagent's prompt. */
  familyNotes?: string;
}

/** A variant with the planning text present: the default always has one. */
export interface ResolvedPromptVariant {
  persona?: string;
  planning: string;
  familyNotes?: string;
}
