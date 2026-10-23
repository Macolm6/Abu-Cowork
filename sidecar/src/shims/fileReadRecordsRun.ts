/**
 * Sidecar-local replacement for `src/core/tools/fileReadRecords.ts`.
 *
 * The records of what each agent has read live in the shell: subagent and
 * expert runs execute every tool there, and the main loop's own file tools
 * reach it too whenever they cannot run here (a PDF read, the reverse-path
 * retry of a read, `apply_patch`, host-owned file execution). A record kept in
 * this process would be missing for those calls and `write_file` would refuse
 * a file the agent did read. So the locally-executed `read_file`,
 * `write_file` and `edit_file` forward each record and each lookup to the
 * shell (`agentLoopRunner.ts`'s `handleFileReadsRecord` / `handleFileReadsGet`),
 * which resolves the reader from its own session for this run.
 *
 * The run comes from the ambient agent-run context; a subagent nested inside
 * this loop (the direct-delegate path) names its own run through the call's
 * `agentRunId`, which travels with the request.
 */
import { sendRequest } from '../rpcClient';
import { getCurrentAgentRunContext } from '../agentRunContext';
import type { ToolExecutionContext } from '@/types';
import type { FileVersion } from '@/core/tools/fileReadRecords';
import type { ShimThrowKind } from './shimThrowKind';

/**
 * 本文件把读取记录的写入与查询转交给 shell。唯一一处抛出错误在 `recordedFileVersion()`：
 * shell 的答复格式不对时拒绝作答，`write_file` 随之报错并且不写入。
 */
export const SHIM_THROW_KIND: ShimThrowKind = 'input-check';

type ReaderContext = Pick<ToolExecutionContext, 'conversationId' | 'agentRunId' | 'fileReadRunId'> | undefined;

export async function recordFileVersion(path: string, version: FileVersion, context: ReaderContext): Promise<void> {
  const { runId } = getCurrentAgentRunContext();
  await sendRequest('fileReads.record', { runId, agentRunId: context?.agentRunId, path, version });
}

export async function recordedFileVersion(path: string, context: ReaderContext): Promise<FileVersion | undefined> {
  const { runId } = getCurrentAgentRunContext();
  const reply = await sendRequest('fileReads.get', { runId, agentRunId: context?.agentRunId, path }) as
    { recorded?: unknown; version?: unknown } | null;
  if (reply?.recorded === false) return undefined;
  if (reply?.recorded === true && (reply.version === null || typeof reply.version === 'string')) return reply.version;
  throw new Error('Invalid fileReads.get reply');
}
