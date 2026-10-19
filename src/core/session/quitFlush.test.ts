import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { format, getI18n, getLanguageSetting, initLanguage, type LanguageSetting } from '@/i18n';
import { answerQuitRequest, noteQuitConfirmedByUser, quitQuestion, type QuitAnswerDeps, type QuitReason } from './quitFlush';

function fixture(running = false, approved = true) {
  const events: string[] = [];
  const reasons: QuitReason[] = [];
  const deps: QuitAnswerDeps = {
    hasRunningConversation: () => running,
    askToQuit: async (reason) => { events.push('ask'); reasons.push(reason); return approved; },
    report: async (id, stage) => { events.push(`${id}:${stage}`); },
  };
  return { events, reasons, deps };
}

describe('quit confirmation', () => {
  it('allows an idle quit without asking', async () => {
    const f = fixture();
    await answerQuitRequest({ requestId: 1, sessionEnding: false, backgroundCommandCount: 0 }, f.deps);
    expect(f.events).toEqual(['1:ready']);
  });
  it('waits for confirmation before allowing interruption', async () => {
    const f = fixture(true);
    await answerQuitRequest({ requestId: 2, sessionEnding: false, backgroundCommandCount: 0 }, f.deps);
    expect(f.events).toEqual(['2:asking', 'ask', '2:ready']);
    expect(f.reasons).toEqual([{ runningConversation: true, backgroundCommandCount: 0 }]);
  });
  it('keeps the application active when the user cancels', async () => {
    const f = fixture(true, false);
    await answerQuitRequest({ requestId: 3, sessionEnding: false, backgroundCommandCount: 0 }, f.deps);
    expect(f.events).toEqual(['3:asking', 'ask', '3:cancelled']);
  });
  it('uses a close-dialog confirmation once and asks on the next attempt', async () => {
    const f = fixture(true);
    noteQuitConfirmedByUser();
    await answerQuitRequest({ requestId: 4, sessionEnding: false, backgroundCommandCount: 0 }, f.deps);
    await answerQuitRequest({ requestId: 5, sessionEnding: false, backgroundCommandCount: 0 }, f.deps);
    expect(f.events).toEqual(['4:ready', '5:asking', 'ask', '5:ready']);
  });
  it('does not ask during OS session shutdown', async () => {
    const f = fixture(true);
    await answerQuitRequest({ requestId: 6, sessionEnding: true, backgroundCommandCount: 0 }, f.deps);
    expect(f.events).toEqual(['6:ready']);
  });
  it('answers repeated requests without opening another question', async () => {
    const f = fixture(true);
    let answer!: (value: boolean) => void;
    f.deps.askToQuit = () => new Promise(resolve => { answer = resolve; });
    const first = answerQuitRequest({ requestId: 7, sessionEnding: false, backgroundCommandCount: 0 }, f.deps);
    await Promise.resolve();
    await answerQuitRequest({ requestId: 7, sessionEnding: false, backgroundCommandCount: 0 }, f.deps);
    answer(false);
    await first;
    expect(f.events).toEqual(['7:asking', '7:asking', '7:cancelled']);
  });
});

describe('quit confirmation with background commands', () => {
  let previousLanguage: LanguageSetting;
  beforeEach(() => {
    previousLanguage = getLanguageSetting();
    initLanguage('zh-CN');
  });
  afterEach(() => { initLanguage(previousLanguage); });

  it('asks when only background commands are running', async () => {
    const f = fixture(false, false);
    await answerQuitRequest({ requestId: 8, sessionEnding: false, backgroundCommandCount: 2 }, f.deps);
    expect(f.events).toEqual(['8:asking', 'ask', '8:cancelled']);
    expect(f.reasons).toEqual([{ runningConversation: false, backgroundCommandCount: 2 }]);
    const text = getI18n().windowClose;
    expect(quitQuestion(f.reasons[0], text)).toEqual({
      title: '还有 2 个后台命令在运行，退出后会停止',
    });
  });

  it('asks once with both reasons', async () => {
    const f = fixture(true);
    await answerQuitRequest({ requestId: 9, sessionEnding: false, backgroundCommandCount: 3 }, f.deps);
    expect(f.events).toEqual(['9:asking', 'ask', '9:ready']);
    const text = getI18n().windowClose;
    expect(quitQuestion(f.reasons[0], text)).toEqual({
      title: '阿布还在处理任务，现在退出会中断它。',
      message: '还有 3 个后台命令在运行，退出后会停止',
    });
  });

  it('keeps the running-task question alone when no background command runs', () => {
    const text = getI18n().windowClose;
    expect(quitQuestion({ runningConversation: true, backgroundCommandCount: 0 }, text)).toEqual({
      title: text.quitWhileRunning,
    });
  });

  it('does not ask when the session is ending', async () => {
    const f = fixture();
    await answerQuitRequest({ requestId: 10, sessionEnding: true, backgroundCommandCount: 2 }, f.deps);
    expect(f.events).toEqual(['10:ready']);
  });

  it('uses a close-dialog confirmation that showed the background commands', async () => {
    const f = fixture();
    noteQuitConfirmedByUser();
    await answerQuitRequest({ requestId: 11, sessionEnding: false, backgroundCommandCount: 1 }, f.deps);
    expect(f.events).toEqual(['11:ready']);
  });

  it('words the count in English', () => {
    initLanguage('en-US');
    const text = getI18n().windowClose;
    expect(quitQuestion({ runningConversation: false, backgroundCommandCount: 4 }, text)).toEqual({
      title: format(text.backgroundCommandsRunning, { count: 4 }),
    });
    expect(text.backgroundCommandsRunning).toBe('{count} background commands are still running and will stop when Abu quits');
  });

  it('words one command in the singular in English', () => {
    initLanguage('en-US');
    const text = getI18n().windowClose;
    expect(quitQuestion({ runningConversation: false, backgroundCommandCount: 1 }, text)).toEqual({
      title: '1 background command is still running and will stop when Abu quits',
    });
    expect(quitQuestion({ runningConversation: true, backgroundCommandCount: 1 }, text)).toEqual({
      title: text.quitWhileRunning,
      message: '1 background command is still running and will stop when Abu quits',
    });
  });

  it('words one command the same way in Chinese', () => {
    const text = getI18n().windowClose;
    expect(quitQuestion({ runningConversation: false, backgroundCommandCount: 1 }, text)).toEqual({
      title: '还有 1 个后台命令在运行，退出后会停止',
    });
  });
});
