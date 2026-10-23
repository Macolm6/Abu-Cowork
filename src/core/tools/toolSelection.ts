/**
 * The tool roster a model is offered, chosen from its profile.
 *
 * Both agent loops pass the resolved tools through `selectToolsForProfile`
 * once, right after the registry handed them out:
 *
 *  - `harness.editToolStyle === 'patch'`: the model edits with `apply_patch`;
 *    `edit_file` and `write_file` are withdrawn (an `*** Add File` section
 *    covers a new file). The two are withdrawn only while `apply_patch` is in
 *    the roster, so a role or policy that excluded it still leaves the model
 *    an editor.
 *  - `harness.editToolStyle === 'replace'`: `apply_patch` is withdrawn.
 *  - `harness.promptVariant`: a tool that carries a description written for
 *    that family (`ToolDefinition.descriptionByFamily`) is offered with it.
 */
import type { ToolDefinition } from '@/types';
import type { ModelProfile } from '@/core/llm/modelProfile';
import { TOOL_NAMES } from './toolNames';

export type ToolSelectionProfile = Pick<ModelProfile, 'harness'>;

export function selectToolsForProfile(tools: ToolDefinition[], profile: ToolSelectionProfile): ToolDefinition[] {
  const { editToolStyle, promptVariant } = profile.harness;
  const offersPatch = tools.some((tool) => tool.name === TOOL_NAMES.APPLY_PATCH);
  const withdrawn = new Set<string>(
    editToolStyle === 'patch'
      ? (offersPatch ? [TOOL_NAMES.EDIT_FILE, TOOL_NAMES.WRITE_FILE] : [])
      : [TOOL_NAMES.APPLY_PATCH],
  );
  return tools
    .filter((tool) => !withdrawn.has(tool.name))
    .map((tool) => {
      const description = tool.descriptionByFamily?.[promptVariant];
      return description === undefined ? tool : { ...tool, description };
    });
}
