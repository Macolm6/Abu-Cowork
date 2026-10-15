import { beforeEach, describe, expect, it, vi } from 'vitest';

const closeRunningRunsForExitMock = vi.fn();
const waitForAllConversationPersistenceMock = vi.fn();
const shutdownConversationStorageMock = vi.fn();

vi.mock('@/core/agent/agentLoopRunner', () => ({
  closeRunningRunsForExit: () => closeRunningRunsForExitMock(),
}));
const snapshotStreamingMessagesForExitMock = vi.fn();
vi.mock('@/stores/chatStore', () => ({
  snapshotStreamingMessagesForExit: () => snapshotStreamingMessagesForExitMock(),
  waitForAllConversationPersistence: () => waitForAllConversationPersistenceMock(),
}));
vi.mock('@/core/session/conversationStorage', () => ({
  shutdownConversationStorage: () => shutdownConversationStorageMock(),
}));

import {
  answerQuitRequest,
  noteQuitConfirmedByUser,
  saveConversationsForExit,
  type QuitAnswerDeps,
} from './quitFlush';

function deps(overrides: Partial<QuitAnswerDeps> = {}) {
  const log: string[] = [];
  const answer: QuitAnswerDeps = {
    hasRunningConversation: () => false,
    askToQuit: async () => {
      log.push('ask');
      return true;
    },
    report: async (requestId, stage) => {
      log.push(`${requestId}:${stage}`);
    },
    save: async () => {
      log.push('save');
    },
    ...overrides,
  };
  return { log, answer };
}

describe('answerQuitRequest', () => {
  beforeEach(async () => {
    // Use up a confirmation an earlier case may have left noted.
    await answerQuitRequest({ requestId: 0, sessionEnding: true }, deps().answer);
  });

  it('saves and reports ready without asking when nothing is running', async () => {
    const { log, answer } = deps();
    await answerQuitRequest({ requestId: 3, sessionEnding: false }, answer);
    expect(log).toEqual(['3:flushing', 'save', '3:ready']);
  });

  it('asks first when a conversation is running, and saves once the user confirms', async () => {
    const { log, answer } = deps({ hasRunningConversation: () => true });
    await answerQuitRequest({ requestId: 4, sessionEnding: false }, answer);
    expect(log).toEqual(['4:asking', 'ask', '4:flushing', 'save', '4:ready']);
  });

  it('reports cancelled and saves nothing when the user stays', async () => {
    const { log, answer } = deps({ hasRunningConversation: () => true });
    answer.askToQuit = async () => {
      log.push('ask');
      return false;
    };
    await answerQuitRequest({ requestId: 5, sessionEnding: false }, answer);
    expect(log).toEqual(['5:asking', 'ask', '5:cancelled']);
  });

  it('says it is still asking when the same request arrives again, and asks no second question', async () => {
    const { log, answer } = deps({ hasRunningConversation: () => true });
    let answerQuestion = (_quit: boolean) => {};
    answer.askToQuit = () => {
      log.push('ask');
      return new Promise<boolean>((resolve) => { answerQuestion = resolve; });
    };
    const first = answerQuitRequest({ requestId: 11, sessionEnding: false }, answer);
    await vi.waitFor(() => expect(log).toEqual(['11:asking', 'ask']));

    await answerQuitRequest({ requestId: 11, sessionEnding: false }, answer);
    expect(log).toEqual(['11:asking', 'ask', '11:asking']);

    answerQuestion(false);
    await first;
    expect(log).toEqual(['11:asking', 'ask', '11:asking', '11:cancelled']);
  });

  it('asks nothing when the session is ending', async () => {
    const { log, answer } = deps({ hasRunningConversation: () => true });
    await answerQuitRequest({ requestId: 6, sessionEnding: true }, answer);
    expect(log).toEqual(['6:flushing', 'save', '6:ready']);
  });

  it('asks nothing for the quit the user confirmed in the close dialog, and asks again for the next one', async () => {
    const first = deps({ hasRunningConversation: () => true });
    noteQuitConfirmedByUser();
    await answerQuitRequest({ requestId: 7, sessionEnding: false }, first.answer);
    expect(first.log).toEqual(['7:flushing', 'save', '7:ready']);

    const second = deps({ hasRunningConversation: () => true });
    await answerQuitRequest({ requestId: 8, sessionEnding: false }, second.answer);
    expect(second.log[0]).toBe('8:asking');
  });

  it('reports ready only after the save has finished', async () => {
    const { log, answer } = deps();
    let finishSave = () => {};
    answer.save = () => new Promise<void>((resolve) => {
      finishSave = () => {
        log.push('saved');
        resolve();
      };
    });
    const answering = answerQuitRequest({ requestId: 9, sessionEnding: false }, answer);
    await vi.waitFor(() => expect(log).toEqual(['9:flushing']));
    finishSave();
    await answering;
    expect(log).toEqual(['9:flushing', 'saved', '9:ready']);
  });
});

describe('saveConversationsForExit', () => {
  it('marks running turns, snapshots streaming replies, waits for queued writes, then shuts the writer down', async () => {
    const order: string[] = [];
    closeRunningRunsForExitMock.mockImplementation(() => { order.push('mark'); });
    snapshotStreamingMessagesForExitMock.mockImplementation(async () => { order.push('snapshot'); });
    waitForAllConversationPersistenceMock.mockImplementation(async () => { order.push('wait'); });
    shutdownConversationStorageMock.mockImplementation(async () => { order.push('shutdown'); });

    await saveConversationsForExit();

    expect(order).toEqual(['mark', 'snapshot', 'wait', 'shutdown']);
  });
});
