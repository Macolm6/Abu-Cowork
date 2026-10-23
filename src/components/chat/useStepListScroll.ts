import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

export interface StepListEdges { canScrollUp: boolean; canScrollDown: boolean }

// How far from an end still counts as being at it, in pixels.
const EDGE_SLACK = 1;

/** Pure follow rule: whether the list should jump to its end after content grew. */
export function shouldFollow(state: { following: boolean }, metrics: { top: number; floor: number }): boolean {
  return state.following && metrics.top < metrics.floor;
}

function sameEdges(a: StepListEdges, b: StepListEdges): boolean {
  return a.canScrollUp === b.canScrollUp && a.canScrollDown === b.canScrollDown;
}

/**
 * Scroll position of the work process's step list. A running turn opens at
 * its last step and follows new steps while the reader stays at the end; a
 * finished turn opens at its first step. `edges` says which ends have more
 * steps beyond them, for the fades.
 */
export function useStepListScroll(
  listRef: RefObject<HTMLDivElement | null>, open: boolean, active: boolean,
): { edges: StepListEdges; onScroll: () => void } {
  const [edges, setEdges] = useState<StepListEdges>({ canScrollUp: false, canScrollDown: false });
  const followingRef = useRef(true);
  // The scroll position last seen, set by the hook or by a scroll event. The
  // event of the hook's own jump can arrive after more content came in, so
  // only a move above this position is the reader leaving the end.
  const lastTopRef = useRef(0);
  // Read when the list opens only: the turn ending while the list is open
  // must not move it.
  const activeRef = useRef(active);

  const readEdges = useCallback((list: HTMLDivElement) => {
    const floor = list.scrollHeight - list.clientHeight;
    const next = { canScrollUp: list.scrollTop > EDGE_SLACK, canScrollDown: list.scrollTop < floor - EDGE_SLACK };
    setEdges((previous) => (sameEdges(previous, next) ? previous : next));
  }, []);

  useLayoutEffect(() => {
    activeRef.current = active;
  }, [active]);

  useLayoutEffect(() => {
    if (!open) {
      followingRef.current = true;
      return;
    }
    const list = listRef.current;
    if (!list) return;
    followingRef.current = activeRef.current;
    list.scrollTop = activeRef.current ? list.scrollHeight - list.clientHeight : 0;
    lastTopRef.current = list.scrollTop;
  }, [open, listRef]);

  useEffect(() => {
    const list = listRef.current;
    if (!open || !list) return;
    const observer = new ResizeObserver(() => {
      const floor = list.scrollHeight - list.clientHeight;
      if (shouldFollow({ following: followingRef.current }, { top: list.scrollTop, floor })) {
        list.scrollTop = floor;
        lastTopRef.current = list.scrollTop;
      }
      readEdges(list);
    });
    observer.observe(list);
    for (const child of Array.from(list.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [open, listRef, readEdges]);

  const onScroll = useCallback(() => {
    const list = listRef.current!;
    if (list.scrollHeight - list.clientHeight - list.scrollTop <= EDGE_SLACK) followingRef.current = true;
    else if (list.scrollTop < lastTopRef.current) followingRef.current = false;
    lastTopRef.current = list.scrollTop;
    readEdges(list);
  }, [listRef, readEdges]);

  return { edges, onScroll };
}
