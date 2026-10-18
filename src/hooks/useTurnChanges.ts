import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  collectConversationChangedFiles,
  type ConversationChangedFile,
  type ConversationTurn,
  type RunningTurnChanges,
} from '@/core/session/conversationChangedFiles';
import { getMessageText } from '@/core/context/contextUtils';
import {
  onTurnChangesSaved,
  readTurnChanges,
  readTurnIndex,
  readTurnUndoRecord,
  type TurnChanges,
  type TurnIndex,
  type TurnIndexEntry,
} from '@/core/session/turnChanges';
import {
  planTurnUndo,
  reapplyTurn,
  undoTurn,
  type TurnUndoDirection,
  type TurnUndoPlan,
  type TurnUndoResult,
} from '@/core/session/turnUndo';
import type { TurnUndoRecord } from '@/core/session/turnUndoRecord';
import { checkWritePath } from '@/core/tools/pathSafety';
import { createLogger } from '@/core/logging/logger';
import { useChatStore } from '@/stores/chatStore';
import { canonicalizeElectronPathForPolicy } from '@/utils/electronHost';
import { normalizeSeparators } from '@/utils/pathUtils';
import type { Conversation, ToolCall } from '@/types';

const logger = createLogger('turnChanges');

export type TurnChangesStatus = 'loading' | 'ready' | 'error';

interface TurnRecord {
  status: TurnChangesStatus;
  turn: TurnChanges | null;
}

const LOADING: TurnRecord = { status: 'loading', turn: null };

/** conversationId → its index as last read; null until the first read settles, and after a read that failed. */
const indexRecords = new Map<string, TurnIndex | null>();
const indexRequests = new Map<string, number>();
const turnRecords = new Map<string, TurnRecord>();
const turnRequests = new Map<string, number>();
/** Turn key → its undo record as last read; null until the first read settles, after a failed read, and for a turn without one. */
const undoRecords = new Map<string, TurnUndoRecord | null>();
const undoRequests = new Map<string, number>();
const subscribers = new Set<() => void>();
let stopListening: (() => void) | null = null;

function turnKey(conversationId: string, loopId: string): string {
  return `${conversationId}/${loopId}`;
}

function notify(): void {
  for (const subscriber of [...subscribers]) subscriber();
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function loadIndex(conversationId: string): void {
  const request = (indexRequests.get(conversationId) ?? 0) + 1;
  indexRequests.set(conversationId, request);
  if (!indexRecords.has(conversationId)) indexRecords.set(conversationId, null);
  readTurnIndex(conversationId).then(
    (index) => {
      if (indexRequests.get(conversationId) !== request) return;
      indexRecords.set(conversationId, index);
      notify();
    },
    (error: unknown) => {
      if (indexRequests.get(conversationId) !== request) return;
      logger.warn('turn changes index could not be read', { conversationId, errorKind: errorKind(error) });
    },
  );
}

/** `keepShown` leaves what readers see in place until the new read settles. */
function loadTurn(conversationId: string, loopId: string, keepShown: boolean): void {
  const key = turnKey(conversationId, loopId);
  const request = (turnRequests.get(key) ?? 0) + 1;
  turnRequests.set(key, request);
  if (!keepShown || !turnRecords.has(key)) {
    turnRecords.set(key, LOADING);
    notify();
  }
  readTurnChanges(conversationId, loopId).then(
    (turn) => {
      if (turnRequests.get(key) !== request) return;
      turnRecords.set(key, { status: 'ready', turn });
      notify();
    },
    (error: unknown) => {
      if (turnRequests.get(key) !== request) return;
      logger.warn('turn changes could not be read', { conversationId, errorKind: errorKind(error) });
      turnRecords.set(key, { status: 'error', turn: null });
      notify();
    },
  );
}

/** What readers see stays in place until the new read settles. A read that fails rejects unhandled and changes nothing. */
function loadUndoRecord(conversationId: string, loopId: string): void {
  const key = turnKey(conversationId, loopId);
  const request = (undoRequests.get(key) ?? 0) + 1;
  undoRequests.set(key, request);
  if (!undoRecords.has(key)) undoRecords.set(key, null);
  void readTurnUndoRecord(conversationId, loopId).then((record) => {
    if (undoRequests.get(key) !== request) return;
    undoRecords.set(key, record);
    notify();
  });
}

function subscribe(onChange: () => void): () => void {
  subscribers.add(onChange);
  stopListening ??= onTurnChangesSaved((conversationId, loopId) => {
    if (indexRecords.has(conversationId)) loadIndex(conversationId);
    if (turnRecords.has(turnKey(conversationId, loopId))) loadTurn(conversationId, loopId, true);
    if (undoRecords.has(turnKey(conversationId, loopId))) loadUndoRecord(conversationId, loopId);
  });
  return () => {
    subscribers.delete(onChange);
  };
}

/**
 * Totals of what a turn changed. Null while the conversation's index is being
 * read, when it could not be read, and for a turn that changed nothing. The
 * index is read once per conversation and again whenever one of its turns is
 * saved.
 */
export function useTurnChangesEntry(
  conversationId: string,
  loopId: string | undefined,
  enabled: boolean,
): TurnIndexEntry | null {
  const active = enabled && Boolean(loopId);
  useEffect(() => {
    if (active && !indexRecords.has(conversationId)) loadIndex(conversationId);
  }, [active, conversationId]);
  return useSyncExternalStore(subscribe, () => (
    active ? indexRecords.get(conversationId)?.[loopId as string] ?? null : null
  ));
}

type MessageFact = string | number | boolean | ToolCall[] | undefined;

const NO_FACTS: MessageFact[] = [];
const NO_FILES: ConversationChangedFile[] = [];
const LOADING_FILES = { status: 'loading' as const, files: NO_FILES };

/**
 * What the changed-files list reads from a conversation's messages, as a flat
 * list of plain values: whether a turn runs, then per user message 'u', its
 * first line and time, and per reply 'a', its loop id and tool calls. A
 * reply's tool call list keeps its identity while text streams into it, so
 * the list stays equal then.
 */
function messageFacts(conversation: Conversation | undefined): MessageFact[] {
  if (!conversation) return NO_FACTS;
  const facts: MessageFact[] = [conversation.status === 'running'];
  for (const message of conversation.messages) {
    if (message.role === 'user' && !message.isSystem) {
      facts.push('u', getMessageText(message.content).split('\n', 1)[0], message.timestamp);
    } else if (message.role === 'assistant' && message.loopId) {
      facts.push('a', message.loopId, message.toolCalls);
    }
  }
  return facts;
}

interface TurnsOfMessages {
  turns: Array<{ loopId: string; prompt: string; at: number }>;
  running: RunningTurnChanges | null;
}

function turnsOf(facts: MessageFact[]): TurnsOfMessages {
  const turns: TurnsOfMessages['turns'] = [];
  const toolCallsByLoop = new Map<string, ToolCall[]>();
  let prompt = '';
  let at = 0;
  for (let i = 1; i < facts.length; i += 3) {
    if (facts[i] === 'u') {
      prompt = facts[i + 1] as string;
      at = facts[i + 2] as number;
      continue;
    }
    const loopId = facts[i + 1] as string;
    if (!toolCallsByLoop.has(loopId)) {
      toolCallsByLoop.set(loopId, []);
      turns.push({ loopId, prompt, at });
    }
    (toolCallsByLoop.get(loopId) as ToolCall[]).push(...((facts[i + 2] as ToolCall[] | undefined) ?? []));
  }
  const last = turns.at(-1);
  if (facts[0] !== true || !last) return { turns, running: null };
  const changes = (toolCallsByLoop.get(last.loopId) as ToolCall[])
    .flatMap((toolCall) => (toolCall.fileChange && !toolCall.fromSubagent ? [toolCall.fileChange] : []));
  return { turns, running: { ...last, changes } };
}

/**
 * The files a conversation changed, for the task summary: the saved turns of
 * its messages from the changes index, and the file tools' changes of the
 * turn that runs. Loading until the index has been read.
 */
export function useConversationChangedFiles(conversationId: string): { status: 'loading' | 'ready'; files: ConversationChangedFile[] } {
  useEffect(() => {
    if (!indexRecords.has(conversationId)) loadIndex(conversationId);
  }, [conversationId]);
  const index = useSyncExternalStore(subscribe, () => indexRecords.get(conversationId) ?? null);
  const facts = useChatStore(useShallow((s) => messageFacts(s.conversations[conversationId])));
  const messageTurns = useMemo(() => turnsOf(facts), [facts]);
  return useMemo(() => {
    if (!index) return LOADING_FILES;
    const turns: ConversationTurn[] = [];
    for (const turn of messageTurns.turns) {
      const entry = index[turn.loopId];
      if (entry) turns.push({ ...turn, files: entry.files, undone: entry.undone === true });
    }
    return { status: 'ready' as const, files: collectConversationChangedFiles(turns, messageTurns.running) };
  }, [index, messageTurns]);
}

export interface TurnChangesDetail {
  status: TurnChangesStatus;
  /** The saved turn; null while loading, after an error, and for a turn that saved nothing. */
  turn: TurnChanges | null;
  reload: () => void;
}

/** The files of one turn with their hunks, read on first use and again when that turn is saved again. */
export function useTurnChangesDetail(conversationId: string, loopId: string, enabled = true): TurnChangesDetail {
  const key = turnKey(conversationId, loopId);
  useEffect(() => {
    if (enabled && !turnRecords.has(key)) loadTurn(conversationId, loopId, false);
  }, [enabled, key, conversationId, loopId]);
  const record = useSyncExternalStore(subscribe, () => (enabled ? turnRecords.get(key) ?? LOADING : LOADING));
  const reload = useCallback(() => loadTurn(conversationId, loopId, false), [conversationId, loopId]);
  return { status: record.status, turn: record.turn, reload };
}

/**
 * The undo record of a turn: which of its files can be restored and what the
 * latest undo or put-back did with each. Null while it is read, when it could
 * not be read, and for a turn without one. Read on first use and again
 * whenever the turn is saved.
 */
export function useTurnUndoRecord(conversationId: string, loopId: string, enabled: boolean): TurnUndoRecord | null {
  const key = turnKey(conversationId, loopId);
  useEffect(() => {
    if (enabled && !undoRecords.has(key)) loadUndoRecord(conversationId, loopId);
  }, [enabled, key, conversationId, loopId]);
  return useSyncExternalStore(subscribe, () => (enabled ? undoRecords.get(key) ?? null : null));
}

/**
 * `path` as it is spelled under the conversation's workspace. A turn records
 * the resolved path of a file; when the workspace is reached through a link,
 * that path starts with the resolved folder, and the write check judges a path
 * by the spelling the workspace was authorized in.
 */
async function inWorkspaceSpelling(workspacePath: string | null | undefined, path: string): Promise<string> {
  if (!workspacePath) return path;
  const folder = normalizeSeparators(workspacePath).replace(/\/+$/, '');
  if (path.startsWith(`${folder}/`)) return path;
  const resolved = await canonicalizeElectronPathForPolicy(folder);
  if (resolved === null) return path;
  const resolvedFolder = normalizeSeparators(resolved).replace(/\/+$/, '');
  return path.startsWith(`${resolvedFolder}/`) ? `${folder}${path.slice(resolvedFolder.length)}` : path;
}

/** A file may be written when the write check allows its path as things stand; nothing is asked. */
async function mayWrite(conversationId: string, path: string): Promise<boolean> {
  const workspacePath = useChatStore.getState().conversations[conversationId]?.workspacePath;
  return (await checkWritePath(await inWorkspaceSpelling(workspacePath, path))).allowed;
}

export interface TurnUndoControls {
  /** What undoing the turn, or putting its changes back, would do right now. */
  plan: (direction: TurnUndoDirection) => Promise<TurnUndoPlan>;
  /** Undoes the turn or puts its changes back. Resolves to null when a run is already going. */
  run: (direction: TurnUndoDirection) => Promise<TurnUndoResult | null>;
  /** True while `run` is going. */
  busy: boolean;
}

/** Undoing one turn's file changes and putting them back, for the card of that turn. */
export function useTurnUndo(conversationId: string, loopId: string): TurnUndoControls {
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const isConversationPresent = useCallback(
    () => Boolean(useChatStore.getState().conversations[conversationId]),
    [conversationId],
  );
  // The plan and the run judge a write by the same check, so the question lists what the run will do.
  const authorize = useCallback((path: string) => mayWrite(conversationId, path), [conversationId]);
  const plan = useCallback(
    (direction: TurnUndoDirection) => planTurnUndo(conversationId, loopId, direction, { authorize, isConversationPresent }),
    [conversationId, loopId, authorize, isConversationPresent],
  );
  const run = useCallback(async (direction: TurnUndoDirection) => {
    if (running.current) return null;
    running.current = true;
    setBusy(true);
    try {
      const options = { authorize, isConversationPresent };
      return await (direction === 'undo' ? undoTurn(conversationId, loopId, options) : reapplyTurn(conversationId, loopId, options));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, [conversationId, loopId, authorize, isConversationPresent]);
  return { plan, run, busy };
}

/** @internal — exposed for unit tests only */
export const __testing = {
  reset(): void {
    indexRecords.clear();
    indexRequests.clear();
    turnRecords.clear();
    turnRequests.clear();
    undoRecords.clear();
    undoRequests.clear();
    stopListening?.();
    stopListening = null;
  },
};
