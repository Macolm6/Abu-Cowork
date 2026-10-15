import { describe, expect, it } from 'vitest';
import { answerQuitRequest, noteQuitConfirmedByUser, type QuitAnswerDeps } from './quitFlush';

function fixture(running = false, approved = true) {
  const events: string[] = [];
  const deps: QuitAnswerDeps = {
    hasRunningConversation: () => running,
    askToQuit: async () => { events.push('ask'); return approved; },
    report: async (id, stage) => { events.push(`${id}:${stage}`); },
  };
  return { events, deps };
}

describe('quit confirmation', () => {
  it('allows an idle quit without asking', async () => {
    const f = fixture();
    await answerQuitRequest({ requestId: 1, sessionEnding: false }, f.deps);
    expect(f.events).toEqual(['1:ready']);
  });
  it('waits for confirmation before allowing interruption', async () => {
    const f = fixture(true);
    await answerQuitRequest({ requestId: 2, sessionEnding: false }, f.deps);
    expect(f.events).toEqual(['2:asking', 'ask', '2:ready']);
  });
  it('keeps the application active when the user cancels', async () => {
    const f = fixture(true, false);
    await answerQuitRequest({ requestId: 3, sessionEnding: false }, f.deps);
    expect(f.events).toEqual(['3:asking', 'ask', '3:cancelled']);
  });
  it('uses a close-dialog confirmation once and asks on the next attempt', async () => {
    const f = fixture(true);
    noteQuitConfirmedByUser();
    await answerQuitRequest({ requestId: 4, sessionEnding: false }, f.deps);
    await answerQuitRequest({ requestId: 5, sessionEnding: false }, f.deps);
    expect(f.events).toEqual(['4:ready', '5:asking', 'ask', '5:ready']);
  });
  it('does not ask during OS session shutdown', async () => {
    const f = fixture(true);
    await answerQuitRequest({ requestId: 6, sessionEnding: true }, f.deps);
    expect(f.events).toEqual(['6:ready']);
  });
  it('answers repeated requests without opening another question', async () => {
    const f = fixture(true);
    let answer!: (value: boolean) => void;
    f.deps.askToQuit = () => new Promise(resolve => { answer = resolve; });
    const first = answerQuitRequest({ requestId: 7, sessionEnding: false }, f.deps);
    await Promise.resolve();
    await answerQuitRequest({ requestId: 7, sessionEnding: false }, f.deps);
    answer(false);
    await first;
    expect(f.events).toEqual(['7:asking', '7:asking', '7:cancelled']);
  });
});
