/**
 * Session Memory — full tool results on disk.
 *
 * A tool result too long for the conversation is written here in full, and
 * the conversation keeps its beginning, its end and this file's path (see
 * `context/toolResultSpill.ts`), so the model can read the rest with
 * read_file. Deleting the conversation removes the directory.
 *
 * Layout:
 *   ~/Library/Application Support/com.abu.app/conversations/{convId}/results/{contentHash}.txt
 */

import { exists, mkdir, readTextFile, writeTextFile, remove } from '@tauri-apps/plugin-fs';
import { appDataDir } from '@tauri-apps/api/path';
import { joinPath } from '../../utils/pathUtils';
import { createConversationPaths, type ConversationPaths } from './conversationPaths';
import { sha256Hex } from './turnUndoRecord';

/** Marker prefix of the references older builds stored in place of a result */
export const DISK_REF_PREFIX = '[session-memory:';
export const DISK_REF_SUFFIX = ']';

let cachedPaths: ConversationPaths | null = null;

async function conversationPaths(): Promise<ConversationPaths> {
  if (!cachedPaths) {
    cachedPaths = createConversationPaths(await appDataDir());
  }
  return cachedPaths;
}

/**
 * Get the results directory for a specific conversation.
 */
async function getResultsDir(conversationId: string): Promise<string> {
  return (await conversationPaths()).resultsDir(conversationId);
}

/**
 * Check if a result string is a disk reference.
 */
export function isDiskRef(result: string): boolean {
  return result.startsWith(DISK_REF_PREFIX) && result.includes(DISK_REF_SUFFIX);
}

/**
 * Extract the tool call ID from a disk reference string.
 */
export function extractRefId(result: string): string | null {
  if (!isDiskRef(result)) return null;
  const start = DISK_REF_PREFIX.length;
  const end = result.indexOf(DISK_REF_SUFFIX, start);
  if (end === -1) return null;
  return result.substring(start, end);
}

/**
 * Write a tool result's full text to the conversation's results directory.
 * Returns the file's path. A failed write throws.
 */
export async function writeToolResultFile(
  conversationId: string,
  toolCallId: string,
  result: string,
): Promise<string> {
  const dir = await getResultsDir(conversationId);
  const contentHash = await sha256Hex(new TextEncoder().encode(JSON.stringify([toolCallId, result])));
  if (!(await exists(dir))) {
    await mkdir(dir, { recursive: true });
  }

  const filePath = joinPath(dir, `${contentHash}.txt`);
  await writeTextFile(filePath, result);
  return filePath;
}

/**
 * Load a full tool result from disk.
 * Returns the full content, or null if the file doesn't exist.
 */
export async function loadResult(
  conversationId: string,
  toolCallId: string,
): Promise<string | null> {
  const dir = await getResultsDir(conversationId);
  const filePath = joinPath(dir, `${toolCallId}.txt`);

  try {
    if (await exists(filePath)) {
      return await readTextFile(filePath);
    }
    // Fallback: check old `sessions/` path for backward compatibility with pre-migration data
    const paths = await conversationPaths();
    const legacyPath = joinPath(paths.legacySessionDir(conversationId), 'results', `${toolCallId}.txt`);
    if (await exists(legacyPath)) {
      return await readTextFile(legacyPath);
    }
  } catch {
    // File read failed — return null
  }
  return null;
}

/**
 * Clean up all session results for a conversation.
 */
export async function cleanupConversationResults(conversationId: string): Promise<void> {
  const dir = await getResultsDir(conversationId);
  try {
    if (await exists(dir)) {
      await remove(dir, { recursive: true });
    }
  } catch {
    // Cleanup failure is non-critical
  }
}
