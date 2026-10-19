// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { act, cleanup, fireEvent, render as renderBare, screen, within } from '@testing-library/react';
import { useEffect, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { holdConversationStarts, type StartHold } from '@/core/agent/conversationStartHold';
import { createMemoryHostFs, type MemoryHostFs } from '@/core/session/__fixtures__/memoryHostFs';
import { beginTurn, captureBefore, endTurn, onTurnChangesSaved, readTurnIndex } from '@/core/session/turnChanges';
import { authorizeWorkspace, revokeWorkspace } from '@/core/tools/pathSafety';
import { format, getI18n, initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import type { Conversation, Message } from '@/types';
import type { ConversationWorkspaceFiles } from '@/core/files/workspaceFiles';
import { useRedoTurn, type RedoOutcome, type RedoRequest } from './redoTurn';

const host = vi.hoisted(() => ({
  fs: null as unknown as import('@/core/session/__fixtures__/memoryHostFs').MemoryHostFs,
  listWorkspace: null as unknown as import('vitest').Mock,
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: (path: string) => host.fs.pluginFs.exists(path),
  mkdir: (path: string, options?: { recursive?: boolean }) => host.fs.pluginFs.mkdir(path, options),
  readFile: (path: string) => host.fs.pluginFs.readFile(path),
  readTextFile: (path: string) => host.fs.pluginFs.readTextFile(path),
  writeFile: (path: string, bytes: Uint8Array, options?: { create?: boolean; createNew?: boolean }) => host.fs.pluginFs.writeFile(path, bytes, options),
  remove: (path: string, options?: { recursive?: boolean }) => host.fs.pluginFs.remove(path, options),
  readDir: (path: string) => host.fs.pluginFs.readDir(path),
  stat: (path: string) => host.fs.pluginFs.stat(path),
  // The write check inspects the components of a path; the memory disk holds no link.
  lstat: async () => ({ isSymlink: false }),
}));
vi.mock('@tauri-apps/api/core', () => ({
  // The trash goes to the memory disk; every other host command answers as the global mock does.
  invoke: (command: string, args: { path: string }) => (command === 'move_to_trash' ? host.fs.moveToTrash(args.path) : undefined),
  transformCallback: vi.fn(),
}));
vi.mock('@/core/tools/fsBridge', () => ({
  exists: (path: string) => host.fs.bridge.exists(path),
  stat: (path: string) => host.fs.bridge.stat(path),
  readFile: (path: string) => host.fs.bridge.readFile(path),
}));
vi.mock('@/utils/atomicFs', () => ({
  atomicWrite: (path: string, content: string) => host.fs.atomicWrite(path, content),
  writeFileAtomic: (path: string, bytes: Uint8Array, mode: 'replace' | 'create') => host.fs.writeFileAtomic(path, bytes, mode),
}));
vi.mock('@/core/files/workspaceFiles', () => ({
  listConversationWorkspaceFiles: (...args: unknown[]) => host.listWorkspace(...args),
}));

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

const HOME = '/Users/testuser';
const WS = `${HOME}/project`;

let fs: MemoryHostFs;
/** Each test has a conversation of its own, so the per-conversation state of turnChanges never carries over. */
let conversationId: string;
let conversationCount = 0;
const originalDeleteMessagesFrom = useChatStore.getState().deleteMessagesFrom;

/** The hook under test, with `redo` handed out for the test to call. */
const harness: { redo: (request: RedoRequest) => Promise<RedoOutcome> } = { redo: () => { throw new Error('not rendered'); } };
function Harness({ onRedo }: { onRedo: (redo: (request: RedoRequest) => Promise<RedoOutcome>) => void }) {
  const { redo, dialog } = useRedoTurn();
  useEffect(() => { onRedo(redo); }, [onRedo, redo]);
  return <>{dialog}</>;
}
const takeRedo = (redo: (request: RedoRequest) => Promise<RedoOutcome>) => { harness.redo = redo; };

function message(id: string, role: Message['role'], loopId: string): Message {
  return { id, role, content: `${role} ${id}`, timestamp: 1_000, loopId };
}

/** A turn of the agent: its user message, its reply and the file edits its tools made. */
async function turn(loopId: string, edits: Record<string, string> = {}): Promise<Message[]> {
  await beginTurn(conversationId, loopId, WS);
  for (const [file, content] of Object.entries(edits)) {
    await captureBefore(loopId, `${WS}/${file}`);
    fs.write(`${WS}/${file}`, content);
  }
  await endTurn(loopId);
  return [message(`u-${loopId}`, 'user', loopId), message(`a-${loopId}`, 'assistant', loopId)];
}

function putConversation(messages: Message[]): void {
  const conversation: Conversation = {
    id: conversationId, title: 'Redo', messages, createdAt: 1_000, updatedAt: 1_000, status: 'idle', workspacePath: WS,
  };
  useChatStore.setState((state) => ({ conversations: { ...state.conversations, [conversationId]: conversation } }));
}

/** loop-1 modifies a.md, loop-2 modifies a.md and b.md, loop-3 creates c.md. */
async function conversationWithFiles(): Promise<void> {
  fs.write(`${WS}/a.md`, 'v0');
  fs.write(`${WS}/b.md`, 'b0');
  const messages = [
    ...await turn('loop-1', { 'a.md': 'v1' }),
    ...await turn('loop-2', { 'a.md': 'v2', 'b.md': 'b1' }),
    ...await turn('loop-3', { 'c.md': 'c3' }),
  ];
  putConversation(messages);
}

/** loop-1 modifies a.md; loop-4 and loop-5 change no file. */
async function conversationWithLaterTurnsOnly(): Promise<void> {
  fs.write(`${WS}/a.md`, 'v0');
  const messages = [...await turn('loop-1', { 'a.md': 'v1' }), ...await turn('loop-4'), ...await turn('loop-5')];
  putConversation(messages);
}

function workspaceFiles(): Record<string, string> {
  return Object.fromEntries(fs.list(`${WS}/`).map((path) => [path.slice(WS.length + 1), fs.read(path)]));
}

const AFTER_THREE_TURNS = { 'a.md': 'v2', 'b.md': 'b1', 'c.md': 'c3' };
const BEFORE_LOOP_2 = { 'a.md': 'v1', 'b.md': 'b0' };

function messageIds(): string[] {
  return (useChatStore.getState().conversations[conversationId]?.messages ?? []).map((m) => m.id);
}

function request(overrides: Partial<RedoRequest> = {}): RedoRequest {
  return {
    conversationId,
    entry: 'regenerate',
    cutMessageId: 'u-loop-2',
    messageIds: ['u-loop-2'],
    canProceed: () => true,
    start: vi.fn(async () => undefined),
    ...overrides,
  };
}

const dialog = () => screen.queryByTestId('redo-turn-dialog');
const confirmButton = () => within(screen.getByTestId('redo-turn-dialog')).getByRole('button', { name: getI18n().chat.redoRegenerateConfirm });
const cancelButton = () => within(screen.getByTestId('redo-turn-dialog')).getByRole('button', { name: getI18n().common.cancel });
const restoreCheckbox = () => within(screen.getByTestId('redo-turn-dialog')).queryByRole('checkbox', { name: getI18n().chat.redoRestoreFiles });
const toastTitles = () => useToastStore.getState().toasts.map((toast) => toast.title);

/** The conversation is not held: a hold can be taken, and is given back. */
function expectReleased(): void {
  const hold = holdConversationStarts(conversationId);
  expect(hold).not.toBeNull();
  hold?.release();
}

/** Calls `redo` and waits for its question to be on the page; the outcome is wrapped so that the await does not take it in. */
async function open(req: RedoRequest): Promise<{ outcome: Promise<RedoOutcome> }> {
  const outcome = harness.redo(req);
  await screen.findByTestId('redo-turn-dialog');
  return { outcome };
}

describe('useRedoTurn', () => {
  beforeEach(() => {
    initLanguage('en-US');
    fs = createMemoryHostFs();
    host.fs = fs;
    host.listWorkspace = vi.fn(async (_conversationId: string, root: string): Promise<ConversationWorkspaceFiles> => fs.listWorkspace(root));
    conversationCount += 1;
    conversationId = `redo-conv-${conversationCount}`;
    authorizeWorkspace(WS);
    useToastStore.setState({ toasts: [] });
    render(<Harness onRedo={takeRedo} />);
  });

  afterEach(() => {
    cleanup();
    revokeWorkspace(WS);
    useChatStore.setState({ deleteMessagesFrom: originalDeleteMessagesFrom });
    initLanguage('en-US');
  });

  it('starts at once when nothing can be restored and no turn follows', async () => {
    await conversationWithLaterTurnsOnly();
    const start = vi.fn(async () => undefined);

    const outcome = await harness.redo(request({ cutMessageId: 'u-loop-5', messageIds: ['u-loop-5'], start }));

    expect(dialog()).toBeNull();
    expect(start).toHaveBeenCalledTimes(1);
    expect(outcome).toBe('started');
    expect(messageIds()).toEqual(['u-loop-1', 'a-loop-1', 'u-loop-4', 'a-loop-4']);
  });

  it('asks with the later turns line alone when only later turns would go', async () => {
    await conversationWithLaterTurnsOnly();

    const { outcome } = await open(request({ cutMessageId: 'u-loop-4', messageIds: ['u-loop-4'] }));

    expect(screen.getByTestId('redo-turn-dialog')).toHaveTextContent(format(getI18n().chat.redoLaterTurns, { count: 1 }));
    expect(restoreCheckbox()).toBeNull();
    fireEvent.click(cancelButton());
    expect(await outcome).toBe('cancelled');
  });

  it('restores, then deletes, forgets and starts, in that order', async () => {
    await conversationWithFiles();
    const order: string[] = [];
    let filesAtCut: Record<string, string> | null = null;
    useChatStore.setState({
      deleteMessagesFrom: vi.fn((convId: string, messageId: string) => {
        order.push('delete');
        filesAtCut = workspaceFiles();
        originalDeleteMessagesFrom(convId, messageId);
      }),
    });
    let heldAtStart: StartHold | null | undefined;
    const start = vi.fn(async () => {
      order.push('start');
      heldAtStart = holdConversationStarts(conversationId);
    });

    const { outcome } = await open(request({ start }));
    fireEvent.click(confirmButton());

    expect(await outcome).toBe('started');
    expect(order).toEqual(['delete', 'start']);
    expect(filesAtCut).toEqual(BEFORE_LOOP_2);
    expect(workspaceFiles()).toEqual(BEFORE_LOOP_2);
    expect(heldAtStart).toBeNull();
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ conversationId }));
    expect(messageIds()).toEqual(['u-loop-1', 'a-loop-1']);
    await vi.waitFor(async () => {
      expect(Object.keys(await readTurnIndex(conversationId))).toEqual(['loop-1']);
    });
    expectReleased();
  });

  it('leaves the files alone when the option is unchecked', async () => {
    await conversationWithFiles();
    const start = vi.fn(async () => undefined);

    const { outcome } = await open(request({ start }));
    const box = restoreCheckbox();
    expect(box).toBeChecked();
    fireEvent.click(box as HTMLElement);
    expect(restoreCheckbox()).not.toBeChecked();
    fireEvent.click(confirmButton());

    expect(await outcome).toBe('started');
    expect(workspaceFiles()).toEqual(AFTER_THREE_TURNS);
    expect(start).toHaveBeenCalledTimes(1);
    expect(messageIds()).toEqual(['u-loop-1', 'a-loop-1']);
  });

  it('opens with the option checked every time', async () => {
    await conversationWithFiles();

    const first = await open(request());
    fireEvent.click(restoreCheckbox() as HTMLElement);
    expect(restoreCheckbox()).not.toBeChecked();
    fireEvent.click(cancelButton());
    expect(await first.outcome).toBe('cancelled');

    const second = await open(request());
    expect(restoreCheckbox()).toBeChecked();
    fireEvent.click(cancelButton());
    expect(await second.outcome).toBe('cancelled');
    expect(workspaceFiles()).toEqual(AFTER_THREE_TURNS);
  });

  it('stops without deleting or starting when a file is not restored, and says so', async () => {
    await conversationWithFiles();
    const deleteMessagesFrom = vi.fn();
    useChatStore.setState({ deleteMessagesFrom });
    const start = vi.fn(async () => undefined);
    const onCommit = vi.fn();
    fs.failNextWrite(`${WS}/a.md`);

    const { outcome } = await open(request({ start, onCommit }));
    fireEvent.click(confirmButton());

    expect(await outcome).toBe('stopped');
    expect(workspaceFiles()).toEqual({ 'a.md': 'v2', 'b.md': 'b0' });
    expect(deleteMessagesFrom).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    expect(toastTitles()).toEqual([format(getI18n().chat.undoPartialNotice, { done: 2, notDone: 1 })]);
    expectReleased();
  });

  it('does nothing when a run started while the question was open', async () => {
    await conversationWithFiles();
    const start = vi.fn(async () => undefined);

    const { outcome } = await open(request({ start }));
    useChatStore.getState().setConversationStatus(conversationId, 'running');
    fireEvent.click(confirmButton());

    expect(await outcome).toBe('cancelled');
    expect(workspaceFiles()).toEqual(AFTER_THREE_TURNS);
    expect(messageIds()).toEqual(['u-loop-1', 'a-loop-1', 'u-loop-2', 'a-loop-2', 'u-loop-3', 'a-loop-3']);
    expect(start).not.toHaveBeenCalled();
    expectReleased();
  });

  it('does nothing when a run started while the plan waited for the just-ended turn', async () => {
    fs.write(`${WS}/a.md`, 'v0');
    fs.write(`${WS}/b.md`, 'b0');
    const messages = [...await turn('loop-1', { 'a.md': 'v1' }), ...await turn('loop-2', { 'a.md': 'v2', 'b.md': 'b1' })];
    // loop-3 has ended for the user, but its run has not released its file record yet.
    await beginTurn(conversationId, 'loop-3', WS);
    await captureBefore('loop-3', `${WS}/c.md`);
    fs.write(`${WS}/c.md`, 'c3');
    putConversation([...messages, message('u-loop-3', 'user', 'loop-3'), message('a-loop-3', 'assistant', 'loop-3')]);
    const start = vi.fn(async () => undefined);

    const outcome = harness.redo(request({ start }));
    useChatStore.getState().setConversationStatus(conversationId, 'running');
    await act(() => endTurn('loop-3'));
    await screen.findByTestId('redo-turn-dialog');
    fireEvent.click(confirmButton());

    expect(await outcome).toBe('cancelled');
    expect(workspaceFiles()).toEqual(AFTER_THREE_TURNS);
    expect(messageIds()).toEqual(['u-loop-1', 'a-loop-1', 'u-loop-2', 'a-loop-2', 'u-loop-3', 'a-loop-3']);
    expect(start).not.toHaveBeenCalled();
    expectReleased();
  });

  it('does nothing when the messages changed while the question was open', async () => {
    await conversationWithFiles();
    const start = vi.fn(async () => undefined);

    const { outcome } = await open(request({ start }));
    useChatStore.getState().addMessage(conversationId, message('u-loop-6', 'user', 'loop-6'));
    fireEvent.click(confirmButton());

    expect(await outcome).toBe('cancelled');
    expect(workspaceFiles()).toEqual(AFTER_THREE_TURNS);
    expect(messageIds()).toHaveLength(7);
    expect(start).not.toHaveBeenCalled();
    expectReleased();
  });

  it('does nothing when the conversation was deleted while the question was open', async () => {
    await conversationWithFiles();
    const start = vi.fn(async () => undefined);

    const { outcome } = await open(request({ start }));
    useChatStore.getState().deleteConversation(conversationId);
    fireEvent.click(confirmButton());

    expect(await outcome).toBe('cancelled');
    expect(workspaceFiles()).toEqual(AFTER_THREE_TURNS);
    expect(start).not.toHaveBeenCalled();
    expectReleased();
  });

  it('does not cut or start when the conversation was deleted during the restore', async () => {
    await conversationWithFiles();
    const deleteMessagesFrom = vi.fn();
    useChatStore.setState({ deleteMessagesFrom });
    const start = vi.fn(async () => undefined);
    const onCommit = vi.fn();
    // The restore records each turn it restored a file of; the conversation goes at the first record.
    const stop = onTurnChangesSaved((savedConversationId) => {
      if (savedConversationId !== conversationId) return;
      stop();
      useChatStore.getState().deleteConversation(conversationId);
    });

    const { outcome } = await open(request({ start, onCommit }));
    fireEvent.click(confirmButton());

    expect(await outcome).toBe('cancelled');
    expect(workspaceFiles()).toEqual(BEFORE_LOOP_2);
    expect(useChatStore.getState().conversations[conversationId]).toBeUndefined();
    expect(onCommit).not.toHaveBeenCalled();
    expect(deleteMessagesFrom).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expectReleased();
  });

  it('keeps a question asked during the run of an earlier redo open until it is answered', async () => {
    await conversationWithLaterTurnsOnly();
    let endRun!: () => void;
    const firstStart = vi.fn(() => new Promise<void>((resolve) => { endRun = resolve; }));
    const first = await open(request({ cutMessageId: 'u-loop-4', messageIds: ['u-loop-4'], start: firstStart }));
    fireEvent.click(confirmButton());
    await vi.waitFor(() => expect(firstStart).toHaveBeenCalledTimes(1));
    expect(dialog()).toBeNull();

    // The run has ended on the conversation's side; the dispatcher's promise settles later.
    const secondStart = vi.fn(async () => undefined);
    const second = await open(request({ cutMessageId: 'u-loop-1', messageIds: ['u-loop-1'], start: secondStart }));
    // Inside act, so every state change the first redo makes on its way out is painted.
    await act(async () => {
      endRun();
      expect(await first.outcome).toBe('started');
    });

    // Open, as against a dialog that is fading out after being closed.
    expect(screen.getByTestId('redo-turn-dialog')).toHaveAttribute('data-state', 'open');
    fireEvent.click(confirmButton());
    expect(await second.outcome).toBe('started');
    expect(secondStart).toHaveBeenCalledTimes(1);
    expect(workspaceFiles()).toEqual({ 'a.md': 'v0' });
    expectReleased();
  });

  it('checks canProceed before restoring', async () => {
    await conversationWithFiles();
    const start = vi.fn(async () => undefined);
    const canProceed = vi.fn(() => false);

    const { outcome } = await open(request({ start, canProceed }));
    fireEvent.click(confirmButton());

    expect(await outcome).toBe('cancelled');
    expect(canProceed).toHaveBeenCalledTimes(1);
    expect(workspaceFiles()).toEqual(AFTER_THREE_TURNS);
    expect(messageIds()).toHaveLength(6);
    expect(start).not.toHaveBeenCalled();
    expectReleased();
  });

  it('returns cancelled when another redo holds the conversation', async () => {
    await conversationWithFiles();
    const start = vi.fn(async () => undefined);

    const { outcome } = await open(request({ start }));
    const other = holdConversationStarts(conversationId);
    expect(other).not.toBeNull();
    fireEvent.click(confirmButton());

    expect(await outcome).toBe('cancelled');
    expect(workspaceFiles()).toEqual(AFTER_THREE_TURNS);
    expect(messageIds()).toHaveLength(6);
    expect(start).not.toHaveBeenCalled();
    other?.release();
  });

  it('releases the hold when start throws', async () => {
    await conversationWithFiles();
    const failure = new Error('dispatch failed');
    const start = vi.fn(async () => { throw failure; });

    const { outcome } = await open(request({ start }));
    fireEvent.click(confirmButton());

    await expect(outcome).rejects.toBe(failure);
    expect(start).toHaveBeenCalledTimes(1);
    expectReleased();
  });

  it('calls onCommit right before the conversation is cut', async () => {
    await conversationWithFiles();
    const order: string[] = [];
    useChatStore.setState({
      deleteMessagesFrom: vi.fn((convId: string, messageId: string) => {
        order.push('delete');
        originalDeleteMessagesFrom(convId, messageId);
      }),
    });
    const onCommit = vi.fn(() => { order.push('commit'); });

    const cancelled = await open(request({ onCommit }));
    fireEvent.click(cancelButton());
    expect(await cancelled.outcome).toBe('cancelled');
    expect(onCommit).not.toHaveBeenCalled();

    const started = await open(request({ onCommit }));
    fireEvent.click(confirmButton());
    expect(await started.outcome).toBe('started');
    expect(order).toEqual(['commit', 'delete']);
    expectReleased();
  });
});
