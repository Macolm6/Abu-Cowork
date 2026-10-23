import type { ToolExecutionContext } from '@/types';
import { normalizeLexicalPath } from '@/utils/pathUtils';

/**
 * Which version of each file an agent has seen, so `write_file` overwrites
 * only a file the writer has read and that nobody changed since.
 *
 * A version is the SHA-256 of the file's bytes, or `null` when the agent found
 * no file at that path. Reads, and the writes of `write_file`, `edit_file` and
 * `apply_patch`, record the version they leave the agent having seen.
 *
 * Records are kept per reader: the conversation's own agent shares one set
 * across its turns, and every subagent run (each expert included) has its own,
 * keyed by its run id. The records live in this process's memory only, so
 * after a restart a file is read again before it is overwritten.
 *
 * In the desktop app this module runs in the shell, which sees every file tool
 * call: a call the sidecar executes itself reaches it through
 * `sidecar/src/shims/fileReadRecordsRun.ts`.
 */
export type FileVersion = string | null;

/** The conversation's own agent; a subagent run is keyed by its run id. */
const CONVERSATION_AGENT = '';

/** conversation id → reader → path → version */
const records = new Map<string, Map<string, Map<string, FileVersion>>>();

type ReaderContext = Pick<ToolExecutionContext, 'conversationId' | 'agentRunId' | 'fileReadRunId'> | undefined;

/** A call outside any conversation has no reader: it records nothing and has read nothing. */
function readerOf(context: ReaderContext): { conversationId: string; reader: string } | null {
  const conversationId = context?.conversationId;
  if (!conversationId) return null;
  return { conversationId, reader: context.agentRunId ?? context.fileReadRunId ?? CONVERSATION_AGENT };
}

export async function recordFileVersion(path: string, version: FileVersion, context: ReaderContext): Promise<void> {
  const owner = readerOf(context);
  if (!owner) return;
  const { conversationId, reader } = owner;
  let readers = records.get(conversationId);
  if (!readers) {
    readers = new Map();
    records.set(conversationId, readers);
  }
  let versions = readers.get(reader);
  if (!versions) {
    versions = new Map();
    readers.set(reader, versions);
  }
  versions.set(normalizeLexicalPath(path), version);
}

/** The version the reader last saw, or `undefined` when it never read the path. */
export async function recordedFileVersion(path: string, context: ReaderContext): Promise<FileVersion | undefined> {
  const owner = readerOf(context);
  if (!owner) return undefined;
  return records.get(owner.conversationId)?.get(owner.reader)?.get(normalizeLexicalPath(path));
}

/** Drops every record of a deleted conversation, its subagent runs' included. */
export function forgetConversationFileReads(conversationId: string): void {
  records.delete(conversationId);
}

/** Drops a finished subagent run's records. */
export function forgetFileReads(conversationId: string, agentRunId: string): void {
  const readers = records.get(conversationId);
  if (!readers) return;
  readers.delete(agentRunId);
  if (readers.size === 0) records.delete(conversationId);
}
