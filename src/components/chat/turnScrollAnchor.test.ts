import { describe, expect, it } from 'vitest';
import type { Message } from '@/types';
import {
  ANCHOR_TOLERANCE_PX,
  CHAPTER_RAIL_BOTTOM_THRESHOLD_PX,
  VIRTUOSO_AT_BOTTOM_THRESHOLD_PX,
  armTurnScrollAnchor,
  canArmTurnScrollAnchor,
  exitTurnScrollAnchor,
  getAnchorScrollCorrection,
  isAtBottomFromGeometry,
  isChapterRailAtBottom,
  resolveTurnAnchorLayout,
  selectLatestUserAnchor,
  settleTurnScrollAnchor,
  shouldFollowOutput,
} from './turnScrollAnchor';

function arm() {
  return armTurnScrollAnchor({
    conversationId: 'conversation-1',
    messageId: 'user-1',
    targetTop: 20,
  });
}

function held(minContentHeight = 900) {
  return settleTurnScrollAnchor(arm(), { minContentHeight, fillerHeight: 200 });
}

describe('turn scroll anchor invariants', () => {
  it('keeps correction inside the 2px anchor tolerance at zero', () => {
    expect(ANCHOR_TOLERANCE_PX).toBe(2);
    expect(getAnchorScrollCorrection(20, 21.9)).toBe(0);
    expect(getAnchorScrollCorrection(20, 22.1)).toBeCloseTo(2.1);
    expect(getAnchorScrollCorrection(20, 17)).toBe(-3);
  });

  it('arms with no hold until geometry has been read', () => {
    expect(arm()).toEqual({
      conversationId: 'conversation-1',
      messageId: 'user-1',
      phase: 'armed',
      targetTop: 20,
      minContentHeight: 0,
    });
  });

  it('holds exactly the content height that makes the anchor position reachable', () => {
    // Anchor 420px below the viewport top at scrollTop 300: the anchor scroll
    // position is 700, so the content (starting at scroll offset 0) must reach
    // 700 + 600 = 1300. No reserve on top.
    expect(resolveTurnAnchorLayout({
      targetTop: 20,
      anchorTop: 420,
      contentTop: -300,
      scrollTop: 300,
      clientHeight: 600,
    })).toEqual({ minContentHeight: 1_300, scrollCorrection: 400 });
  });

  it('derives the hold from geometry alone, so a repeated read never accumulates', () => {
    // Once the viewport is at the anchor position, every later read yields the
    // same hold whatever the list below the anchor did meanwhile.
    for (let index = 0; index < 5; index += 1) {
      expect(resolveTurnAnchorLayout({
        targetTop: 20,
        anchorTop: 20,
        contentTop: -700,
        scrollTop: 700,
        clientHeight: 600,
      })).toEqual({ minContentHeight: 1_300, scrollCorrection: 0 });
    }
  });

  it('accounts for content that starts below the scroll origin and rounds the hold up', () => {
    expect(resolveTurnAnchorLayout({
      targetTop: 20,
      anchorTop: 120.4,
      contentTop: 10,
      scrollTop: 0,
      clientHeight: 500,
    })).toEqual({ minContentHeight: 591, scrollCorrection: 100.4 });
  });

  it('never asks for a negative scroll position or hold', () => {
    expect(resolveTurnAnchorLayout({
      targetTop: 20,
      anchorTop: 5,
      contentTop: 0,
      scrollTop: 0,
      clientHeight: 0,
    })).toEqual({ minContentHeight: 0, scrollCorrection: -15 });
  });

  it('stays armed while the filler still covers part of the hold', () => {
    expect(held(900)).toMatchObject({ phase: 'armed', minContentHeight: 900 });
    expect(shouldFollowOutput(held())).toBe(false);
  });

  it('hands over to bottom-follow once the list alone fills the hold', () => {
    const exhausted = settleTurnScrollAnchor(held(), { minContentHeight: 900, fillerHeight: 0 });

    expect(exhausted).toMatchObject({ phase: 'exhausted', minContentHeight: 0 });
    expect(shouldFollowOutput(exhausted)).toBe('auto');
  });

  it('risk E — never follows content after explicit upward intent and preserves the frozen hold', () => {
    expect(exitTurnScrollAnchor(held(), 'user-scroll-intent')).toEqual({
      anchor: null,
      minContentHeight: 900,
      pinned: false,
    });
  });

  it('risk E — releases the hold and restores pinned bottom state for an explicit latest jump', () => {
    expect(exitTurnScrollAnchor(held(), 'explicit-latest')).toEqual({
      anchor: null,
      minContentHeight: 0,
      pinned: true,
    });
  });

  it.each([
    ['conversation-switch', true],
    ['run-terminal', true],
    ['arm-abandoned', true],
    ['search-jump', false],
    ['chapter-jump', false],
  ] as const)('resets anchor state for %s', (reason, pinned) => {
    expect(exitTurnScrollAnchor(held(), reason)).toEqual({
      anchor: null,
      minContentHeight: 0,
      pinned,
    });
  });

  it('risk F7 — derives bottom state from geometry instead of forcing false on unpin', () => {
    expect(VIRTUOSO_AT_BOTTOM_THRESHOLD_PX).toBe(100);
    expect(isAtBottomFromGeometry(1)).toBe(true);
    expect(isAtBottomFromGeometry(99.9)).toBe(true);
    expect(isAtBottomFromGeometry(100.1)).toBe(false);
  });

  it('risk F8 — declines a top anchor when the user bubble would consume the viewport', () => {
    expect(canArmTurnScrollAnchor({ anchorHeight: 240, viewportHeight: 600, targetTop: 20 })).toBe(true);
    expect(canArmTurnScrollAnchor({ anchorHeight: 580, viewportHeight: 600, targetTop: 20 })).toBe(false);
  });
});

describe('risk A — chapter rail geometry', () => {
  it('treats an armed pinned spacer as the newest chapter despite its physical distance', () => {
    expect(CHAPTER_RAIL_BOTTOM_THRESHOLD_PX).toBe(24);
    expect(isChapterRailAtBottom(300, arm(), true)).toBe(true);
    expect(isChapterRailAtBottom(300, arm(), false)).toBe(false);
    expect(isChapterRailAtBottom(23.9, null, false)).toBe(true);
    expect(isChapterRailAtBottom(24.1, null, false)).toBe(false);
  });
});

describe('risk D — anchor rebinding', () => {
  it('selects the newest persisted user id even when legacy turns reused one loop id', () => {
    const messages: Message[] = [
      { id: 'user-1', role: 'user', content: 'first', timestamp: 1, loopId: 'loop-1' },
      { id: 'assistant-1', role: 'assistant', content: 'answer', timestamp: 2, loopId: 'loop-1' },
      { id: 'user-2', role: 'user', content: 'queued', timestamp: 3, loopId: 'loop-1' },
      { id: 'assistant-2', role: 'assistant', content: '', timestamp: 4, loopId: 'loop-1', isStreaming: true },
    ];

    expect(selectLatestUserAnchor('conversation-1', messages)).toEqual({
      conversationId: 'conversation-1',
      messageId: 'user-2',
    });
    expect(messages.map((message) => message.id)).toEqual([
      'user-1',
      'assistant-1',
      'user-2',
      'assistant-2',
    ]);
  });
});
