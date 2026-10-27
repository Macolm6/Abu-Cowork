import { describe, it, expect, beforeEach } from 'vitest';
import type { Message, ToolCall } from '@/types';
import {
  COMPACT_BOUNDARY_ID_PREFIX,
  isCompactBoundary,
  findLastCompactBoundary,
  createCompactBoundaryMarker,
  createFailedCompactBoundaryMarker,
  planStepCompaction,
  buildContextFromBoundary,
} from './compactBoundary';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let seq = 0;
function msg(role: 'user' | 'assistant' | 'system', overrides: Partial<Message> = {}): Message {
  seq++;
  return { id: `msg-${seq}`, role, content: `content-${seq}`, timestamp: 1000 * seq, ...overrides };
}

/** One step: an assistant message carrying its tool calls and results. */
function step(toolCalls: Partial<ToolCall>[] = [{ name: 'run_command' }], overrides: Partial<Message> = {}): Message {
  return msg('assistant', {
    toolCalls: toolCalls.map((call, index) => ({
      id: `tc-${seq}-${index}`,
      name: 'run_command',
      input: {},
      result: 'ok',
      ...call,
    })) as ToolCall[],
    ...overrides,
  });
}

/** Each message weighs 10 tokens, so token budgets read as message counts. */
const tenEach = (msgs: Message[]) => msgs.length * 10;

function marker(params: Partial<Parameters<typeof createCompactBoundaryMarker>[0]> & { summarizedToId: string }): Message {
  return createCompactBoundaryMarker({
    summaryText: 'summary',
    summarizedFromId: 'msg-1',
    keptUserMessageIds: [],
    restoredFiles: [],
    source: 'auto',
    timestamp: 99_000,
    ...params,
  });
}

beforeEach(() => {
  seq = 0;
});

describe('isCompactBoundary', () => {
  it('is true for a marker and false for ordinary messages', () => {
    expect(isCompactBoundary(marker({ summarizedToId: 'x' }))).toBe(true);
    expect(isCompactBoundary(msg('user'))).toBe(false);
    expect(isCompactBoundary(msg('system', { isSystem: true }))).toBe(false);
    expect(isCompactBoundary(msg('system', { id: `${COMPACT_BOUNDARY_ID_PREFIX}x` }))).toBe(false);
  });
});

describe('createCompactBoundaryMarker', () => {
  it('builds a visible version-2 divider inside the run that compacted', () => {
    const m = marker({ summarizedToId: 'msg-9', keptUserMessageIds: ['msg-1'], loopId: 'loop-1' });
    expect(m.id.startsWith(COMPACT_BOUNDARY_ID_PREFIX)).toBe(true);
    expect(m.role).toBe('system');
    expect(m.content).toBe('');
    expect(m.isSystem).toBeUndefined();
    expect(m.loopId).toBe('loop-1');
    expect(m.compactBoundary).toMatchObject({
      version: 2,
      status: 'done',
      summarizedToId: 'msg-9',
      keptUserMessageIds: ['msg-1'],
      source: 'auto',
    });
  });

  it('leaves out loopId for manual /compact, so the divider sits between turns', () => {
    expect(marker({ summarizedToId: 'msg-9', source: 'manual' }).loopId).toBeUndefined();
  });
});

describe('findLastCompactBoundary', () => {
  it('finds the newest successful marker and passes over a failed one', () => {
    const done = marker({ summarizedToId: 'msg-1' });
    const failed = createFailedCompactBoundaryMarker({ source: 'auto', timestamp: 100_000 });
    const found = findLastCompactBoundary([msg('user'), done, msg('assistant'), failed]);
    expect(found?.marker).toBe(done);
    expect(found?.index).toBe(1);
  });

  it('returns null when only a failed marker exists', () => {
    expect(findLastCompactBoundary([createFailedCompactBoundaryMarker({ source: 'auto', timestamp: 1 })])).toBeNull();
  });
});

describe('planStepCompaction', () => {
  it('compacts one user message followed by many steps, keeping the user message verbatim', () => {
    const user = msg('user');
    const steps = Array.from({ length: 30 }, () => step());
    const plan = planStepCompaction([user, ...steps], {
      retainTokens: 50,
      userMessageBudget: 1_000,
      estimateTokens: tenEach,
    });

    expect(plan).not.toBeNull();
    expect(plan!.keptUserMessageIds).toEqual([user.id]);
    expect(plan!.summarizedFromId).toBe(user.id);
    // 50 tokens of tail = the newest 5 steps; everything before goes into the summary.
    expect(plan!.summarizedToId).toBe(steps[24].id);
    expect(plan!.summarize.map((m) => m.id)).toEqual([user.id, ...steps.slice(0, 25).map((m) => m.id)]);
  });

  it('always keeps the newest step verbatim, even with no tail budget', () => {
    const user = msg('user');
    const steps = [step(), step(), step()];
    const plan = planStepCompaction([user, ...steps], { retainTokens: 0, userMessageBudget: 1_000, estimateTokens: tenEach });
    expect(plan!.summarizedToId).toBe(steps[1].id);
  });

  it('returns null when nothing before the tail is a step', () => {
    const plan = planStepCompaction([msg('user'), step()], { retainTokens: 0, userMessageBudget: 1_000, estimateTokens: tenEach });
    expect(plan).toBeNull();
    expect(planStepCompaction([msg('user')], { retainTokens: 0, userMessageBudget: 1_000, estimateTokens: tenEach })).toBeNull();
  });

  it('keeps the newest user messages within their budget, oldest first in order', () => {
    const history = [msg('user'), step(), msg('user'), step(), msg('user'), step(), step()];
    const plan = planStepCompaction(history, { retainTokens: 0, userMessageBudget: 20, estimateTokens: tenEach });
    expect(plan!.keptUserMessageIds).toEqual([history[2].id, history[4].id]);
  });

  it('keeps the beginning of the message that crosses the budget, and sends that beginning', () => {
    const task = msg('user', { content: 'A'.repeat(1_000) });
    const steps = [step(), step(), step()];
    const history = [task, ...steps];
    // The task weighs 100 tokens, steps 10 each; 40 tokens of room keep 40 % of its text.
    const weigh = (msgs: Message[]) => msgs.reduce((sum, m) => sum + (m.role === 'user' ? 100 : 10), 0);
    const plan = planStepCompaction(history, { retainTokens: 0, userMessageBudget: 40, estimateTokens: weigh });

    expect(plan!.keptUserMessageIds).toEqual([task.id]);
    expect(plan!.cutUserMessage?.id).toBe(task.id);
    expect(plan!.cutUserMessage?.text.startsWith('A'.repeat(400))).toBe(true);
    expect(plan!.cutUserMessage?.text).not.toContain('A'.repeat(401));

    const m = marker({
      summarizedToId: plan!.summarizedToId,
      keptUserMessageIds: plan!.keptUserMessageIds,
      cutUserMessage: plan!.cutUserMessage,
    });
    const view = buildContextFromBoundary([...history, m]);
    expect(view[0].id).toBe(task.id);
    expect(view[0].content).toBe(plan!.cutUserMessage!.text);
  });

  it('does not keep system wake-ups as the user\'s own words', () => {
    const history = [msg('user'), step(), msg('user', { isSystem: true }), step(), step()];
    const plan = planStepCompaction(history, { retainTokens: 0, userMessageBudget: 1_000, estimateTokens: tenEach });
    expect(plan!.keptUserMessageIds).toEqual([history[0].id]);
  });

  it('lists files read before the tail, newest first, without those read in the tail', () => {
    const history = [
      msg('user'),
      step([{ name: 'read_file', input: { path: '/a.ts' } }]),
      step([{ name: 'read_file', input: { path: '/b.ts' } }, { name: 'read_file', input: { path: '/a.ts' } }]),
      step([{ name: 'read_file', input: { path: '/c.ts' }, isError: true }]),
      step([{ name: 'read_file', input: { path: '/b.ts' } }]),
    ];
    const plan = planStepCompaction(history, { retainTokens: 0, userMessageBudget: 1_000, estimateTokens: tenEach });
    expect(plan!.readFilePaths).toEqual(['/a.ts']);
  });

  it('summarizes from the current view on a second compaction, so the earlier summary is merged', () => {
    const user = msg('user');
    const first = [step(), step(), step()];
    const firstMarker = marker({ summarizedToId: first[1].id, keptUserMessageIds: [user.id] });
    const later = [step(), step(), step()];
    const history = [user, ...first, firstMarker, ...later];

    const plan = planStepCompaction(history, { retainTokens: 0, userMessageBudget: 1_000, estimateTokens: tenEach });
    expect(plan!.summarize.map((m) => m.id)).toEqual([
      user.id,
      `context-summary-${firstMarker.id}`,
      first[2].id,
      later[0].id,
      later[1].id,
    ]);
    expect(plan!.summarizedToId).toBe(later[1].id);
  });
});

describe('buildContextFromBoundary', () => {
  it('returns the same array when there is no successful marker', () => {
    const history = [msg('user'), step(), createFailedCompactBoundaryMarker({ source: 'auto', timestamp: 1 })];
    expect(buildContextFromBoundary(history)).toBe(history);
  });

  it('version 2: kept user messages, the summary, the restored files, then everything after the range', () => {
    const user = msg('user');
    const steps = [step(), step(), step()];
    const m = marker({
      summaryText: 'what happened',
      summarizedToId: steps[1].id,
      keptUserMessageIds: [user.id],
      restoredFiles: [{ path: '/a.ts', content: 'export const a = 1;' }],
    });
    const after = step();
    const view = buildContextFromBoundary([user, ...steps, m, after]);

    expect(view.map((v) => v.id)).toEqual([
      user.id,
      `context-summary-${m.id}`,
      `context-files-${m.id}`,
      steps[2].id,
      after.id,
    ]);
    expect(view[1]).toMatchObject({ role: 'user', isSystem: true });
    expect(view[1].content).toContain('what happened');
    expect(view[2].content).toContain('<file path="/a.ts">');
    expect(view.some(isCompactBoundary)).toBe(false);
  });

  it('version 2 without restored files adds no file message', () => {
    const user = msg('user');
    const steps = [step(), step()];
    const m = marker({ summarizedToId: steps[0].id, keptUserMessageIds: [user.id] });
    expect(buildContextFromBoundary([user, ...steps, m]).map((v) => v.id)).toEqual([
      user.id,
      `context-summary-${m.id}`,
      steps[1].id,
    ]);
  });

  it('rebuilds a marker written before version 2 with its first round kept whole', () => {
    const firstRound = [msg('user'), msg('assistant')];
    const middle = [msg('user'), msg('assistant')];
    const recent = [msg('user'), msg('assistant')];
    const old: Message = {
      id: `${COMPACT_BOUNDARY_ID_PREFIX}old`,
      role: 'system',
      content: '',
      timestamp: 1,
      compactBoundary: {
        summaryText: 'old summary',
        summarizedFromId: middle[0].id,
        summarizedToId: middle[1].id,
        createdAt: 1,
        source: 'auto',
      },
    };
    const view = buildContextFromBoundary([...firstRound, ...middle, ...recent, old]);
    expect(view.map((v) => v.id)).toEqual([
      firstRound[0].id,
      firstRound[1].id,
      `context-summary-${old.id}`,
      recent[0].id,
      recent[1].id,
    ]);
    expect(view[2].content).toBe('[对话历史摘要]\nold summary');
  });

  it('returns the same array when the summarized-to message is gone', () => {
    const history = [msg('user'), step(), marker({ summarizedToId: 'deleted' })];
    expect(buildContextFromBoundary(history)).toBe(history);
  });
});
