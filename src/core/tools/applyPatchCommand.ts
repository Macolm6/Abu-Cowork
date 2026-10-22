/**
 * `apply_patch` typed as a shell command.
 *
 * A model trained on apply_patch may run it through run_command
 * (`apply_patch <<'EOF' … EOF`), the way Codex lets it. While the patch tool
 * is offered to the run (the profile's patch style), that command becomes an
 * apply_patch call with the patch tool's own approval and file access; the
 * shell never sees it. Both tool executors apply the rewrite before anything
 * else: the sidecar's (run_command runs locally there) and the renderer
 * registry's (the in-process loop, the eval runner).
 *
 * Pure: no I/O, nothing the sidecar bundle cannot carry.
 */
import type { ToolExecutionContext } from '@/types';
import { TOOL_NAMES } from './toolNames';

/**
 * The patch text of a shell command that invokes `apply_patch`. Recognized
 * shapes, with or without a `bash -lc` / `sh -c` / `zsh -c` wrapper:
 *   apply_patch <<'EOF' … EOF        (heredoc, any delimiter, quoted or bare)
 *   apply_patch '…'                  (single-quoted argument)
 *   apply_patch "…"                  (double-quoted argument)
 * Anything else is an ordinary command and returns null.
 */
export function extractApplyPatchCommand(command: string): string | null {
  const trimmed = command.trim();
  const wrapped = /^(?:bash|sh|zsh)\s+-l?c\s+([\s\S]+)$/.exec(trimmed);
  if (wrapped) {
    const inner = unquoteShellArgument(wrapped[1].trim());
    return inner === null ? null : extractApplyPatchCommand(inner);
  }
  const heredoc = /^apply_patch\s*<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1\s*\n([\s\S]*?)\n[ \t]*\2[ \t]*$/.exec(trimmed);
  if (heredoc) return heredoc[3];
  const quoted = /^apply_patch\s+([\s\S]+)$/.exec(trimmed);
  if (!quoted) return null;
  const argument = unquoteShellArgument(quoted[1].trim());
  return argument !== null && argument.startsWith('*** Begin Patch') ? argument : null;
}

/** One single- or double-quoted shell word; null for anything else. */
function unquoteShellArgument(text: string): string | null {
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/'\\''/g, "'");
  }
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\([\\"$`\n])/g, '$1');
  }
  return null;
}

/**
 * The call to execute for a tool call: an apply_patch call when `name` is
 * run_command, the patch tool is offered to this run and the command is an
 * apply_patch invocation; otherwise the call as it came.
 */
export function rewriteShellApplyPatch(
  name: string,
  input: Record<string, unknown>,
  context: Pick<ToolExecutionContext, 'offeredToolNames'> | undefined,
): { name: string; input: Record<string, unknown> } {
  if (name !== TOOL_NAMES.RUN_COMMAND || !context?.offeredToolNames?.includes(TOOL_NAMES.APPLY_PATCH)) {
    return { name, input };
  }
  const patch = extractApplyPatchCommand(typeof input.command === 'string' ? input.command : '');
  return patch === null ? { name, input } : { name: TOOL_NAMES.APPLY_PATCH, input: { input: patch } };
}
