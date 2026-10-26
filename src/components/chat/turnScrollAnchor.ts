import type { Message } from '@/types';

export const ANCHOR_TOLERANCE_PX = 2;
export const CHAPTER_RAIL_BOTTOM_THRESHOLD_PX = 24;
export const CHAT_AT_BOTTOM_THRESHOLD_PX = 100;

export interface TurnAnchorCandidate {
  conversationId: string;
  messageId: string;
}

/**
 * The active turn's user message held at `targetTop` below the viewport top.
 *
 * The hold is a minimum height on the scrolled content: just tall enough that
 * the anchor's scroll position is reachable. A flex filler after the list takes
 * up whatever the list does not yet cover, so list growth replaces filler in
 * the same layout pass — including growth the list applies to its own
 * explicitly sized container when rows are measured. Nothing is kept as a running
 * ledger: every reconcile derives the hold from the geometry it reads.
 */
export interface TurnScrollAnchor extends TurnAnchorCandidate {
  phase: 'armed' | 'exhausted';
  targetTop: number;
  minContentHeight: number;
}

export interface TurnScrollAnchorExit {
  anchor: null;
  minContentHeight: number;
  pinned: boolean;
}

export type TurnScrollAnchorExitReason =
  | 'user-scroll-intent'
  | 'explicit-latest'
  | 'conversation-switch'
  | 'run-terminal'
  | 'arm-abandoned'
  | 'search-jump'
  | 'chapter-jump';

function nonNegative(value: number): number {
  return Math.max(0, value);
}

export function selectLatestUserAnchor(
  conversationId: string,
  messages: readonly Message[],
): TurnAnchorCandidate | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') {
      return { conversationId, messageId: messages[index].id };
    }
  }
  return null;
}

export function findUserMessageAnchor(root: ParentNode, messageId: string): HTMLElement | null {
  for (const element of root.querySelectorAll<HTMLElement>('[data-message-id]')) {
    if (element.dataset.messageId === messageId) return element;
  }
  return null;
}

export function armTurnScrollAnchor(input: {
  conversationId: string;
  messageId: string;
  targetTop: number;
}): TurnScrollAnchor {
  return {
    conversationId: input.conversationId,
    messageId: input.messageId,
    phase: 'armed',
    targetTop: input.targetTop,
    minContentHeight: 0,
  };
}

/**
 * Where the anchor wants the viewport, from one geometry read.
 *
 * `anchorTop` and `contentTop` are measured from the viewport top. The
 * returned minimum content height makes exactly the anchor's scroll position
 * reachable: no reserve, so the hold never leaves blank range below it.
 */
export function resolveTurnAnchorLayout(input: {
  targetTop: number;
  anchorTop: number;
  contentTop: number;
  scrollTop: number;
  clientHeight: number;
}): { minContentHeight: number; scrollCorrection: number } {
  const targetScrollTop = nonNegative(input.scrollTop + input.anchorTop - input.targetTop);
  const contentOffset = input.scrollTop + input.contentTop;
  return {
    minContentHeight: Math.ceil(nonNegative(targetScrollTop + input.clientHeight - contentOffset)),
    scrollCorrection: getAnchorScrollCorrection(input.targetTop, input.anchorTop),
  };
}

/**
 * The anchor holds while the filler still covers part of the hold. Once the
 * list alone reaches the minimum height the answer fills the viewport below
 * the anchor, and the turn hands over to bottom-follow.
 */
export function settleTurnScrollAnchor(
  anchor: TurnScrollAnchor,
  input: { minContentHeight: number; fillerHeight: number },
): TurnScrollAnchor {
  if (input.fillerHeight > 0) {
    return { ...anchor, phase: 'armed', minContentHeight: input.minContentHeight };
  }
  return { ...anchor, phase: 'exhausted', minContentHeight: 0 };
}

export function canArmTurnScrollAnchor(input: {
  anchorHeight: number;
  viewportHeight: number;
  targetTop: number;
}): boolean {
  if (input.anchorHeight <= 0 || input.viewportHeight <= 0) return false;
  // Keep one target-sized breathing band below the user bubble. Otherwise a
  // viewport-height prompt anchored at the top hides the assistant response.
  return input.anchorHeight <= input.viewportHeight - (input.targetTop * 2);
}

export function getAnchorScrollCorrection(targetTop: number, currentTop: number): number {
  const delta = currentTop - targetTop;
  return Math.abs(delta) <= ANCHOR_TOLERANCE_PX ? 0 : delta;
}

export function shouldFollowOutput(anchor: TurnScrollAnchor | null): 'auto' | false {
  return anchor?.phase === 'armed' ? false : 'auto';
}

export function isChapterRailAtBottom(
  distanceToBottom: number,
  anchor: TurnScrollAnchor | null,
  pinned: boolean,
): boolean {
  if (anchor?.phase === 'armed' && pinned) return true;
  return distanceToBottom <= CHAPTER_RAIL_BOTTOM_THRESHOLD_PX;
}

export function isAtBottomFromGeometry(distanceToBottom: number): boolean {
  return distanceToBottom <= CHAT_AT_BOTTOM_THRESHOLD_PX;
}

export function exitTurnScrollAnchor(
  anchor: TurnScrollAnchor | null,
  reason: TurnScrollAnchorExitReason,
): TurnScrollAnchorExit {
  if (reason === 'user-scroll-intent') {
    return {
      anchor: null,
      minContentHeight: anchor?.minContentHeight ?? 0,
      pinned: false,
    };
  }
  if (reason === 'search-jump' || reason === 'chapter-jump') {
    return {
      anchor: null,
      minContentHeight: 0,
      pinned: false,
    };
  }
  return {
    anchor: null,
    minContentHeight: 0,
    pinned: true,
  };
}
