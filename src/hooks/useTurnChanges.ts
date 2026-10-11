import { useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  onTurnChangesSaved,
  readTurnChanges,
  readTurnIndex,
  type TurnChanges,
  type TurnIndex,
  type TurnIndexEntry,
} from '@/core/session/turnChanges';
import { createLogger } from '@/core/logging/logger';

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

function subscribe(onChange: () => void): () => void {
  subscribers.add(onChange);
  stopListening ??= onTurnChangesSaved((conversationId, loopId) => {
    if (indexRecords.has(conversationId)) loadIndex(conversationId);
    if (turnRecords.has(turnKey(conversationId, loopId))) loadTurn(conversationId, loopId, true);
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

/** @internal — exposed for unit tests only */
export const __testing = {
  reset(): void {
    indexRecords.clear();
    indexRequests.clear();
    turnRecords.clear();
    turnRequests.clear();
    stopListening?.();
    stopListening = null;
  },
};
