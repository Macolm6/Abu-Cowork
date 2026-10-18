import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
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
export async function mayWrite(conversationId: string, path: string): Promise<boolean> {
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
