import type { ToolExecutionContext, ToolExecutionMetadata, ToolResult } from '@/types';
import { normalizeBatchTerminalSummary } from '@/core/agent/batchTerminalSummary';
import { parseFileChange } from '@/core/files/fileChange';
import { parseBackgroundCommandRef } from '@/core/tools/helpers/backgroundCommandRef';
import { parseCommandOutcome, parseFileReadOutcome, parseHttpFetchOutcome } from '@/core/tools/helpers/toolOutcomes';
import { RpcError } from './protocol';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseToolExecutionMetadata(
  value: unknown,
  expectedBatchIdentity?: { conversationId?: string; batchToolCallId?: string },
): ToolExecutionMetadata | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new RpcError(-32603, 'Invalid tool.invoke metadata envelope');
  const metadata: ToolExecutionMetadata = {};
  if (value.outputSnapshotsHandled !== undefined) {
    if (typeof value.outputSnapshotsHandled !== 'boolean') throw new RpcError(-32603, 'Invalid output capture metadata');
    metadata.outputSnapshotsHandled = value.outputSnapshotsHandled;
  }
  if (value.subagentStopReason !== undefined) {
    const reason = value.subagentStopReason;
    if (reason !== 'completed' && reason !== 'aborted' && reason !== 'error' && reason !== 'max_turns') {
      throw new RpcError(-32603, 'Invalid tool.invoke subagent metadata envelope');
    }
    metadata.subagentStopReason = reason;
  }
  if (value.batchTerminalSummary !== undefined) {
    const summary = normalizeBatchTerminalSummary(value.batchTerminalSummary, expectedBatchIdentity);
    if (!summary) throw new RpcError(-32603, 'Invalid tool.invoke batch summary envelope');
    metadata.batchTerminalSummary = summary;
  }
  if (value.sandboxRecovery !== undefined) {
    if (!isRecord(value.sandboxRecovery) || value.sandboxRecovery.kind !== 'app-automation') {
      throw new RpcError(-32603, 'Invalid tool.invoke sandbox recovery envelope');
    }
    metadata.sandboxRecovery = typeof value.sandboxRecovery.targetApp === 'string'
      ? { kind: 'app-automation', targetApp: value.sandboxRecovery.targetApp }
      : { kind: 'app-automation' };
  }
  if (value.fileChange !== undefined) {
    const fileChange = parseFileChange(value.fileChange);
    if (!fileChange) throw new RpcError(-32603, 'Invalid tool.invoke file change envelope');
    metadata.fileChange = fileChange;
  }
  if (value.backgroundCommand !== undefined) {
    const backgroundCommand = parseBackgroundCommandRef(value.backgroundCommand);
    if (!backgroundCommand) throw new RpcError(-32603, 'Invalid tool.invoke background command envelope');
    metadata.backgroundCommand = backgroundCommand;
  }
  if (value.commandOutcome !== undefined) {
    const commandOutcome = parseCommandOutcome(value.commandOutcome);
    if (!commandOutcome) throw new RpcError(-32603, 'Invalid tool.invoke command outcome envelope');
    metadata.commandOutcome = commandOutcome;
  }
  if (value.fileReadOutcome !== undefined) {
    const fileReadOutcome = parseFileReadOutcome(value.fileReadOutcome);
    if (!fileReadOutcome) throw new RpcError(-32603, 'Invalid tool.invoke file read outcome envelope');
    metadata.fileReadOutcome = fileReadOutcome;
  }
  if (value.httpFetchOutcome !== undefined) {
    const httpFetchOutcome = parseHttpFetchOutcome(value.httpFetchOutcome);
    if (!httpFetchOutcome) throw new RpcError(-32603, 'Invalid tool.invoke http fetch outcome envelope');
    metadata.httpFetchOutcome = httpFetchOutcome;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

/** Decode the shell's result and report its validated metadata in either agent host. */
export function unwrapToolInvokeResult(response: unknown, context: ToolExecutionContext | undefined): ToolResult {
  if (!isRecord(response)) return response as ToolResult;
  if (!('result' in response)) throw new RpcError(-32603, 'Invalid tool.invoke metadata envelope');
  const result = response.result;
  if (typeof result !== 'string' && !Array.isArray(result)) {
    throw new RpcError(-32603, 'Invalid tool.invoke result in subagent metadata envelope');
  }
  const metadata = parseToolExecutionMetadata(
    response.metadata ?? (response.subagentStopReason !== undefined ? { subagentStopReason: response.subagentStopReason } : undefined),
    { conversationId: context?.conversationId, batchToolCallId: context?.toolCallId },
  );
  if (metadata) context?.reportMetadata?.(metadata);
  return result as ToolResult;
}
