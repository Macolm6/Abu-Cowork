import { TOOL_NAMES } from '@/core/tools/toolNames';
import type { CommandOutcome, FileReadOutcome, HttpFetchOutcome, ToolCall } from '@/types';

export interface ToolViewRecord {
  input: Record<string, unknown>;
  commandOutcome?: CommandOutcome;
  fileReadOutcome?: FileReadOutcome;
  httpFetchOutcome?: HttpFetchOutcome;
}

export const TOOL_VIEW_NAMES: ReadonlySet<string> = new Set([
  TOOL_NAMES.RUN_COMMAND,
  TOOL_NAMES.READ_FILE,
  TOOL_NAMES.SEARCH_FILES,
  TOOL_NAMES.FIND_FILES,
  TOOL_NAMES.LIST_DIRECTORY,
  TOOL_NAMES.HTTP_FETCH,
  TOOL_NAMES.WEB_SEARCH,
]);

export function hasToolView(toolName: string | undefined): boolean {
  return toolName !== undefined && TOOL_VIEW_NAMES.has(toolName);
}

/** Records of this turn's own tool calls (fromSubagent left out), by tool call id; a `_durableTruncated` input counts as {}. */
export function collectToolViewRecords(toolCalls: readonly ToolCall[]): Map<string, ToolViewRecord> {
  const records = new Map<string, ToolViewRecord>();
  for (const call of toolCalls) {
    if (call.fromSubagent) continue;
    const record: ToolViewRecord = { input: '_durableTruncated' in call.input ? {} : call.input };
    if (call.commandOutcome) record.commandOutcome = call.commandOutcome;
    if (call.fileReadOutcome) record.fileReadOutcome = call.fileReadOutcome;
    if (call.httpFetchOutcome) record.httpFetchOutcome = call.httpFetchOutcome;
    records.set(call.id, record);
  }
  return records;
}
