/**
 * Background command rows per conversation, mirrored from the main process.
 *
 * EPHEMERAL: no persist middleware. The main process keeps background commands
 * in memory only, so after a restart there is nothing to show.
 */
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export const BACKGROUND_COMMANDS_CHANGED_EVENT = 'background-commands://changed';

export type BackgroundCommandStatus = 'running' | 'stopping' | 'completed' | 'failed' | 'stopped';

export interface BackgroundCommandRow {
  id: string;
  command: string;
  cwd: string;
  status: BackgroundCommandStatus;
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
}

interface BackgroundCommandState {
  rows: Record<string, BackgroundCommandRow[]>;
}

interface BackgroundCommandActions {
  refresh: (conversationId: string) => Promise<void>;
}

type BackgroundCommandStore = BackgroundCommandState & BackgroundCommandActions;

// Latest request per conversation: an older answer that arrives late is dropped.
const latestRequest = new Map<string, number>();
let requestCounter = 0;

export const useBackgroundCommandStore = create<BackgroundCommandStore>()((set) => ({
  rows: {},
  refresh: async (conversationId) => {
    const request = ++requestCounter;
    latestRequest.set(conversationId, request);
    const result = await invoke<unknown>('background_command_list', { conversationId });
    if (!Array.isArray(result)) {
      throw new Error(`background_command_list returned a non-array for conversation ${conversationId}`);
    }
    if (latestRequest.get(conversationId) !== request) return;
    set((state) => ({ rows: { ...state.rows, [conversationId]: result as BackgroundCommandRow[] } }));
  },
}));

/** Re-reads a conversation's rows whenever the main process reports a change. Returns the unsubscribe function. */
export function startBackgroundCommandSync(): () => void {
  let stopped = false;
  let unlisten: (() => void) | null = null;
  void listen<{ conversationId: string }>(BACKGROUND_COMMANDS_CHANGED_EVENT, (event) => {
    if (stopped) return;
    void useBackgroundCommandStore.getState().refresh(event.payload.conversationId);
  }).then((fn) => {
    if (stopped) fn();
    else unlisten = fn;
  });
  return () => {
    stopped = true;
    unlisten?.();
  };
}
