// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shouldFollow, useStepListScroll } from './useStepListScroll';

// happy-dom's ResizeObserver never fires without real layout, so record every
// observer and let a test drive it by hand (determinism rule).
const resizeCallbacks: Array<() => void> = [];

class RecordingResizeObserver {
  constructor(callback: () => void) {
    resizeCallbacks.push(callback);
  }
  observe() {}
  disconnect() {}
}

/**
 * A list element whose scroll height the test sets; it shows 400px of it.
 * `grow` changes the height and reports the resize; `growUnobserved` changes
 * it before the observer has run.
 */
function listWithHeight(initial: number): {
  list: HTMLDivElement;
  grow: (height: number) => void;
  growUnobserved: (height: number) => void;
} {
  let height = initial;
  const list = document.createElement('div');
  list.appendChild(document.createElement('div'));
  Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => height });
  Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
  return {
    list,
    grow: (next) => {
      height = next;
      act(() => resizeCallbacks.forEach((callback) => callback()));
    },
    growUnobserved: (next) => {
      height = next;
    },
  };
}

describe('useStepListScroll', () => {
  beforeEach(() => {
    resizeCallbacks.length = 0;
    vi.stubGlobal('ResizeObserver', RecordingResizeObserver);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('follows only while the reader is at the end', () => {
    expect(shouldFollow({ following: true }, { top: 550, floor: 600 })).toBe(true);
    expect(shouldFollow({ following: false }, { top: 550, floor: 600 })).toBe(false);
  });

  it('stops following when the reader scrolls up and follows again at the end', () => {
    const { list, grow } = listWithHeight(1000);
    const ref = { current: list };
    const { result } = renderHook(() => useStepListScroll(ref, true, true));
    expect(list.scrollTop).toBe(600);

    list.scrollTop = 550;
    act(() => result.current.onScroll());
    expect(result.current.edges).toEqual({ canScrollUp: true, canScrollDown: true });
    grow(1200);
    expect(list.scrollTop).toBe(550);

    list.scrollTop = 800;
    act(() => result.current.onScroll());
    expect(result.current.edges).toEqual({ canScrollUp: true, canScrollDown: false });
    grow(1500);
    expect(list.scrollTop).toBe(1100);
  });

  it('keeps following when content grows between its own scroll and the scroll event', () => {
    const { list, grow, growUnobserved } = listWithHeight(1000);
    const ref = { current: list };
    const { result } = renderHook(() => useStepListScroll(ref, true, true));
    grow(1200);
    expect(list.scrollTop).toBe(800);

    // The scroll event of that jump arrives after more content was committed.
    growUnobserved(1500);
    act(() => result.current.onScroll());
    grow(1800);
    expect(list.scrollTop).toBe(1400);
  });

  it('opens a running list at its end and a finished list at its start', () => {
    const running = listWithHeight(1000);
    const runningRef = { current: running.list };
    const runningHook = renderHook(({ open }) => useStepListScroll(runningRef, open, true), {
      initialProps: { open: false },
    });
    runningHook.rerender({ open: true });
    expect(running.list.scrollTop).toBe(600);

    const finished = listWithHeight(1000);
    finished.list.scrollTop = 300;
    const finishedRef = { current: finished.list };
    const finishedHook = renderHook(({ open }) => useStepListScroll(finishedRef, open, false), {
      initialProps: { open: false },
    });
    finishedHook.rerender({ open: true });
    expect(finished.list.scrollTop).toBe(0);
  });
});
