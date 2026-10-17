/**
 * Pre-edit snapshots for AI file tools (write_file / edit_file).
 *
 * Bridges the AI edit path into the same per-file version history the preview
 * panel's manual editor uses (`canvasVersions`), so every AI turn that touches
 * a file leaves a revertable "before" state. Follows the competitor consensus
 * (Claude Code / WorkBuddy / TRAE — see
 * docs/2026-07-19-ai-edit-version-history-design.md): snapshot on FIRST touch
 * per turn, full content. Snapshot storage failures allow the edit to continue;
 * authorization refusals terminate the file operation.
 */

import { exists, readTextFile, stat } from '@tauri-apps/plugin-fs';
import { normalizePath, snapshotVersion } from '@/utils/canvasVersions';
import { getMessageText } from '@/core/context/contextUtils';
import { useChatStore } from '@/stores/chatStore';
import { captureBefore } from '@/core/session/turnChanges';
import { FileOperationDenied, type ToolFileAccess } from '@/core/tools/fileOperation';

/** Files larger than this are not read into memory in the stat-then-read
 *  branch below — guards against loading a huge file just to snapshot it.
 *  Same value as canvasVersions.ts's own cap (which is the actual, centralized
 *  enforcement point for every write path into version history); kept here
 *  too so the stat branch can skip the disk read entirely instead of reading
 *  the file only to have the store reject it. */
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
/** Max label length persisted into the version index. */
const MAX_LABEL_CHARS = 60;
/** Bounded number of loops tracked for first-touch dedup (LRU-evicted beyond this). */
const MAX_TRACKED_LOOPS = 8;

// loopId -> normalized paths already snapshotted this turn. Eviction is true
// LRU by touch recency, not loop-creation order: every markTouched() call
// (including a dedupe hit on an already-tracked path) bumps that loop to the
// most-recently-used end, so an actively-editing loop is never pushed out by
// merely having been created earlier. Without this, a session running more
// than MAX_TRACKED_LOOPS concurrent loops could evict a loop that is still
// mid-edit; its subsequent "first touch" would re-snapshot mid-turn content
// as if it were the turn's true "before" state, polluting history with an
// intermediate state instead of the original — the store's content dedupe
// does NOT reliably absorb this, since the intermediate content differs from
// both the true original and the final state.
const touchedByLoop = new Map<string, Set<string>>();

/** Returns true when this is the first touch of `path` within `loopId`. */
function markTouched(loopId: string, path: string): boolean {
  const existing = touchedByLoop.get(loopId);
  const set = existing ?? new Set<string>();

  // Recency bump: re-inserting moves this loopId to the end of the Map's
  // iteration order (Map preserves insertion order), so the eviction below
  // always removes the least-recently-touched loop.
  touchedByLoop.delete(loopId);
  touchedByLoop.set(loopId, set);

  if (!existing) {
    while (touchedByLoop.size > MAX_TRACKED_LOOPS) {
      const oldest = touchedByLoop.keys().next().value;
      if (oldest === undefined) break;
      touchedByLoop.delete(oldest);
    }
  }

  if (set.has(path)) return false;
  set.add(path);
  return true;
}

/** Best-effort label: latest non-system user message of the conversation. */
function latestUserMessageLabel(conversationId?: string): string | undefined {
  if (!conversationId) return undefined;
  try {
    const conv = useChatStore.getState().conversations[conversationId];
    if (!conv) return undefined;
    for (let i = conv.messages.length - 1; i >= 0; i--) {
      const m = conv.messages[i];
      if (m.role === 'user' && !m.isSystem) {
        const text = getMessageText(m.content).trim();
        if (!text) return undefined;
        return text.length > MAX_LABEL_CHARS ? `${text.slice(0, MAX_LABEL_CHARS)}…` : text;
      }
    }
  } catch {
    // Label is decoration only — never let it interfere with the snapshot.
  }
  return undefined;
}

/**
 * Keeps `path` as it is now for the turn's change record
 * (`core/session/turnChanges.ts`). Call it before an AI tool writes or removes
 * the file. Storage failures are non-blocking; authorization refusals propagate.
 */
export async function captureTurnFileBefore(path: string, loopId: string | undefined, files?: ToolFileAccess): Promise<void> {
  if (!loopId) return;
  try {
    await files?.assertCurrent();
    await (files ? captureBefore(loopId, path, files) : captureBefore(loopId, path));
    await files?.assertCurrent();
  } catch (err) {
    if (err instanceof FileOperationDenied) throw err;
    console.warn('[aiEditSnapshots] turn capture failed (non-blocking)', path, err);
  }
}

/**
 * What a file tool running in this process calls before it overwrites `path`:
 * the turn capture, then the version-history snapshot. Authorization refusals propagate.
 */
export async function snapshotBeforeAiEdit(
  path: string,
  opts: { loopId?: string; conversationId?: string; knownContent?: string; files?: ToolFileAccess }
): Promise<void> {
  await captureTurnFileBefore(path, opts.loopId, opts.files);
  await snapshotVersionBeforeAiEdit(path, opts);
}

/**
 * Snapshot the current on-disk content of `path` before an AI tool overwrites
 * it. First-touch-per-loop semantics; new files (nothing on disk yet) and
 * oversize files are skipped. Storage failures are non-blocking; authorization refusals propagate.
 */
export async function snapshotVersionBeforeAiEdit(
  path: string,
  opts: { loopId?: string; conversationId?: string; knownContent?: string; files?: ToolFileAccess }
): Promise<void> {
  const key = normalizePath(path);
  const io = opts.files ?? { exists, stat, readTextFile };
  try {
    await opts.files?.assertCurrent();
    // Missing loopId (not expected in practice) degrades to attempting every
    // time — the store's content dedupe keeps history from growing.
    if (opts.loopId && !markTouched(opts.loopId, key)) return;

    // When the caller already has the content (edit_file just read the file
    // to compute its diff), skip the existence check entirely — it would
    // just be a second IPC round trip to confirm something the caller has
    // already proven by having the content in hand.
    if (opts.knownContent === undefined && !(await io.exists(path))) return; // new file — no "before" to capture

    let content = opts.knownContent;
    if (content === undefined) {
      const info = await io.stat(path);
      if (info.size > MAX_SNAPSHOT_BYTES) {
        console.warn('[aiEditSnapshots] skip oversize file', path, info.size);
        return;
      }
      content = await io.readTextFile(path);
    }
    // Note: no oversize check for the knownContent branch here — the caller
    // already has the content in memory (it just read/produced it), and
    // snapshotVersion() now enforces the same MAX_SNAPSHOT_BYTES cap itself,
    // so every path into version history is covered by one authoritative
    // check instead of duplicating it here.

    await opts.files?.assertCurrent();
    const snapshotOptions = {
      source: 'ai',
      label: latestUserMessageLabel(opts.conversationId),
    } as const;
    await (opts.files ? snapshotVersion(path, content, snapshotOptions, opts.files) : snapshotVersion(path, content, snapshotOptions));
    await opts.files?.assertCurrent();
  } catch (err) {
    // Unmark so the next tool call touching this path in this loop retries —
    // a transient failure (stat/readTextFile/snapshotVersion all throw here)
    // must not permanently block history for the rest of the turn just
    // because the first attempt hit a hiccup. Intentional skips (missing
    // file, oversize file) return above before ever reaching this catch, so
    // they correctly stay marked (same-turn semantics unchanged for those).
    if (opts.loopId) touchedByLoop.get(opts.loopId)?.delete(key);
    if (err instanceof FileOperationDenied) throw err;
    console.warn('[aiEditSnapshots] snapshot failed (non-blocking)', path, err);
  }
}

/** @internal — exposed for unit tests only */
export const __testing = { markTouched, MAX_SNAPSHOT_BYTES, MAX_TRACKED_LOOPS };
