/**
 * Pure helpers for compact-boundary markers.
 *
 * A compact-boundary marker is a Message with:
 *   - role: 'system'
 *   - id prefix: COMPACT_BOUNDARY_ID_PREFIX
 *   - compactBoundary payload set
 *   - isSystem NOT set (must reach the UI renderer as a divider, not be hidden)
 *
 * Markers never mutate earlier entries. The send-side rebuilds a compact
 * context on the fly by honouring the LAST successful marker in the array.
 *
 * Compaction works in steps: one model reply together with all of its tool
 * calls and results, which Abu stores as one assistant message, so cutting at
 * message boundaries always keeps a tool call with its result. The user's own
 * messages are kept verbatim (within a budget), the most recent steps are kept
 * verbatim (within a budget), and everything else becomes the summary.
 */

import type { Message, RestoredFile } from '@/types';
import { TOOL_NAMES } from '@/core/tools/toolNames';
import { getMessageText } from './contextUtils';

export const COMPACT_BOUNDARY_ID_PREFIX = 'compact-boundary-';

/** Most files re-read after a compaction (Claude Code keeps 5). */
export const MAX_RESTORED_FILES = 5;

const SUMMARY_HEADER = '[Summary of the earlier part of this task]\n'
  + 'The earlier messages of this conversation were condensed into the summary below. '
  + 'Continue the task from where it stopped. Do not start over and do not repeat steps the summary says are done.';

const RESTORED_FILES_HEADER = '[Files read before the summary, with their content when the summary was written]';

/** True iff msg is a compaction boundary marker (id prefix + payload present). */
export function isCompactBoundary(msg: Message): boolean {
  return (
    msg.id.startsWith(COMPACT_BOUNDARY_ID_PREFIX) &&
    msg.compactBoundary !== undefined
  );
}

function isDoneBoundary(msg: Message): boolean {
  return isCompactBoundary(msg) && msg.compactBoundary!.status !== 'failed';
}

/** Last (highest-index) successful marker in the array, or null. */
export function findLastCompactBoundary(
  messages: Message[],
): { marker: Message; index: number } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isDoneBoundary(messages[i])) {
      return { marker: messages[i], index: i };
    }
  }
  return null;
}

function markerId(timestamp: number): string {
  // Random suffix follows the project id convention — two markers created in the
  // same millisecond must not collide (appendMessage dedups by id and would drop
  // the second; React keys would clash).
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${COMPACT_BOUNDARY_ID_PREFIX}${timestamp.toString(36)}-${suffix}`;
}

/**
 * Build a marker Message for a summary that was written.
 *
 * role = 'system', content = '', isSystem NOT set. `loopId` places the divider
 * inside the run that compacted; manual /compact passes none.
 */
export function createCompactBoundaryMarker(params: {
  summaryText: string;
  summarizedFromId: string;
  summarizedToId: string;
  keptUserMessageIds: string[];
  cutUserMessage?: { id: string; text: string };
  restoredFiles: RestoredFile[];
  source: 'auto' | 'manual';
  loopId?: string;
  timestamp: number;
}): Message {
  const { timestamp, loopId, cutUserMessage } = params;
  return {
    id: markerId(timestamp),
    role: 'system',
    content: '',
    timestamp,
    ...(loopId ? { loopId } : {}),
    compactBoundary: {
      version: 2,
      status: 'done',
      summaryText: params.summaryText,
      summarizedFromId: params.summarizedFromId,
      summarizedToId: params.summarizedToId,
      keptUserMessageIds: params.keptUserMessageIds,
      ...(cutUserMessage ? { cutUserMessage } : {}),
      restoredFiles: params.restoredFiles,
      createdAt: timestamp,
      source: params.source,
    },
  };
}

/** A marker recording a summary request that did not succeed. The context ignores it. */
export function createFailedCompactBoundaryMarker(params: {
  source: 'auto' | 'manual';
  loopId?: string;
  timestamp: number;
}): Message {
  const { timestamp, loopId } = params;
  return {
    id: markerId(timestamp),
    role: 'system',
    content: '',
    timestamp,
    ...(loopId ? { loopId } : {}),
    compactBoundary: {
      version: 2,
      status: 'failed',
      summaryText: '',
      summarizedFromId: '',
      summarizedToId: '',
      createdAt: timestamp,
      source: params.source,
    },
  };
}

/** What a compaction summarizes and what it keeps. */
export interface StepCompactionPlan {
  /** The model's current view up to the retained tail: the summary request's conversation. */
  summarize: Message[];
  summarizedFromId: string;
  summarizedToId: string;
  /** User messages up to `summarizedToId`, sent verbatim before the summary. */
  keptUserMessageIds: string[];
  /** The oldest kept user message when only its beginning fits the budget. */
  cutUserMessage?: { id: string; text: string };
  /** Files read before the tail, newest first, to re-read after the summary. */
  readFilePaths: string[];
}

const CUT_USER_MESSAGE_NOTE = '[... the rest of this message is condensed into the summary ...]';

function isUserInstruction(msg: Message): boolean {
  return msg.role === 'user' && !msg.isSystem;
}

function readFilePathsOf(msg: Message): string[] {
  if (msg.role !== 'assistant') return [];
  return (msg.toolCalls ?? []).flatMap((toolCall) => (
    toolCall.name === TOOL_NAMES.READ_FILE
      && !toolCall.isError
      && !toolCall.fromSubagent
      && typeof toolCall.input.path === 'string'
      ? [toolCall.input.path]
      : []
  ));
}

/**
 * Choose what a compaction summarizes.
 *
 * - The retained tail is the newest messages whose estimate reaches
 *   `retainTokens`, and always holds at least the newest step.
 * - Everything before the tail is summarized, starting from the model's
 *   current view: an earlier summary is part of what the new one condenses.
 * - User messages up to the tail are kept verbatim, newest first, while they
 *   fit `userMessageBudget`; older ones exist only in the summary.
 *
 * Returns null when nothing before the tail is a step (summarizing would not
 * shrink anything the model sees).
 */
export function planStepCompaction(
  historyMessages: Message[],
  opts: {
    retainTokens: number;
    userMessageBudget: number;
    estimateTokens: (msgs: Message[]) => number;
  },
): StepCompactionPlan | null {
  const clean = historyMessages.filter((m) => !isCompactBoundary(m));
  const previous = findLastCompactBoundary(historyMessages);
  const previousToIdx = previous
    ? clean.findIndex((m) => m.id === previous.marker.compactBoundary!.summarizedToId)
    : -1;
  const fresh = clean.slice(previousToIdx + 1);

  let lastStep = fresh.length - 1;
  while (lastStep >= 0 && fresh[lastStep].role !== 'assistant') lastStep -= 1;
  if (lastStep === -1) return null;
  let tailStart = fresh.length;
  let retained = 0;
  while (tailStart > 0 && (tailStart > lastStep || retained < opts.retainTokens)) {
    tailStart -= 1;
    retained += opts.estimateTokens([fresh[tailStart]]);
  }

  const range = fresh.slice(0, tailStart);
  if (!range.some((m) => m.role === 'assistant')) return null;

  // A marker that cannot be applied leaves the whole history in view.
  const rebuilt = buildContextFromBoundary(historyMessages);
  const view = rebuilt === historyMessages ? clean : rebuilt;
  const summarize = view.slice(0, view.length - (fresh.length - tailStart));

  const summarizedToId = range[range.length - 1].id;
  const throughTo = clean.slice(0, previousToIdx + 1 + tailStart);
  // Newest first while they fit; the one that crosses the budget keeps the
  // beginning of its text that fits (Codex keeps it the same way).
  const keptUserMessageIds: string[] = [];
  let cutUserMessage: StepCompactionPlan['cutUserMessage'];
  let userTokens = 0;
  for (let i = throughTo.length - 1; i >= 0; i--) {
    const msg = throughTo[i];
    if (!isUserInstruction(msg)) continue;
    const tokens = opts.estimateTokens([msg]);
    if (userTokens + tokens > opts.userMessageBudget) {
      const text = getMessageText(msg.content);
      const room = opts.userMessageBudget - userTokens;
      const keptChars = Math.floor(text.length * (room / tokens));
      if (keptChars > 0) {
        keptUserMessageIds.unshift(msg.id);
        cutUserMessage = { id: msg.id, text: `${text.slice(0, keptChars)}\n${CUT_USER_MESSAGE_NOTE}` };
      }
      break;
    }
    userTokens += tokens;
    keptUserMessageIds.unshift(msg.id);
  }

  const tailPaths = new Set(fresh.slice(tailStart).flatMap(readFilePathsOf));
  const earlierPaths = [
    ...range.flatMap(readFilePathsOf).reverse(),
    ...(previous?.marker.compactBoundary!.restoredFiles ?? []).map((file) => file.path),
  ];
  const readFilePaths: string[] = [];
  for (const path of earlierPaths) {
    if (tailPaths.has(path) || readFilePaths.includes(path)) continue;
    readFilePaths.push(path);
    if (readFilePaths.length === MAX_RESTORED_FILES) break;
  }

  return {
    summarize,
    summarizedFromId: clean[0].id,
    summarizedToId,
    keptUserMessageIds,
    ...(cutUserMessage ? { cutUserMessage } : {}),
    readFilePaths,
  };
}

// Internal predicate — a message that is NOT a compact-boundary marker
function notMarker(m: Message): boolean {
  return !isCompactBoundary(m);
}

function formatRestoredFiles(files: RestoredFile[]): string {
  return [
    RESTORED_FILES_HEADER,
    ...files.map((file) => `<file path="${file.path}">\n${file.content}\n</file>`),
  ].join('\n\n');
}

/**
 * Send-side: rebuild the context array honouring the last successful marker.
 *
 * - No marker → historyMessages unchanged (same reference).
 * - The marker's `summarizedToId` is gone (the user deleted that message) or,
 *   for an old marker, its range is inverted → historyMessages unchanged: the
 *   marker cannot be applied.
 * - Version 2: [kept user messages, summary, restored files, everything after
 *   `summarizedToId` except markers].
 * - Older markers: [everything before `summarizedFromId` (their first round),
 *   summary, everything after `summarizedToId` except markers].
 *
 * The synthetic summary and file messages are `isSystem` user messages: the
 * model reads them as context, not as the user's instruction.
 */
export function buildContextFromBoundary(historyMessages: Message[]): Message[] {
  const found = findLastCompactBoundary(historyMessages);
  if (found === null) {
    return historyMessages;
  }

  const { marker } = found;
  const b = marker.compactBoundary!; // guaranteed by isCompactBoundary

  const toIdx = historyMessages.findIndex((m) => m.id === b.summarizedToId);
  if (toIdx === -1) return historyMessages;

  if (b.version !== 2) {
    const fromIdx = historyMessages.findIndex((m) => m.id === b.summarizedFromId);
    if (fromIdx === -1 || toIdx < fromIdx) return historyMessages;
    return [
      ...historyMessages.slice(0, fromIdx).filter(notMarker),
      {
        id: `context-summary-${marker.id}`,
        role: 'user',
        content: `[对话历史摘要]\n${b.summaryText}`,
        timestamp: b.createdAt,
      },
      ...historyMessages.slice(toIdx + 1).filter(notMarker),
    ];
  }

  const keptIds = new Set(b.keptUserMessageIds ?? []);
  const restoredFiles = b.restoredFiles ?? [];
  const cut = b.cutUserMessage;
  return [
    ...historyMessages.slice(0, toIdx + 1)
      .filter((m) => keptIds.has(m.id))
      .map((m) => (m.id === cut?.id ? { ...m, content: cut.text } : m)),
    {
      id: `context-summary-${marker.id}`,
      role: 'user',
      content: `${SUMMARY_HEADER}\n\n${b.summaryText}`,
      timestamp: b.createdAt,
      isSystem: true,
    },
    ...(restoredFiles.length > 0
      ? [{
          id: `context-files-${marker.id}`,
          role: 'user' as const,
          content: formatRestoredFiles(restoredFiles),
          timestamp: b.createdAt,
          isSystem: true,
        }]
      : []),
    ...historyMessages.slice(toIdx + 1).filter(notMarker),
  ];
}
