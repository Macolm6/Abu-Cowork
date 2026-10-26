// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SmoothHeight from './SmoothHeight';

// jsdom has no ResizeObserver; install a controllable stub so tests can drive
// the resize callback by hand with fixed heights (determinism rule: no real
// layout, no real timers beyond vitest's fake clock).
type ROCallback = (entries: { contentRect: { height: number } }[]) => void;
let roCallback: ROCallback | null = null;
let observed: Element | null = null;

class ResizeObserverStub {
  constructor(cb: ROCallback) {
    roCallback = cb;
  }
  observe(el: Element) {
    observed = el;
  }
  disconnect() {
    roCallback = null;
    observed = null;
  }
}

function fireResize(height: number) {
  roCallback?.([{ contentRect: { height } }]);
}

// The rendered height of the outer box, as the browser would lay it out.
function setRenderedHeight(outer: HTMLElement, height: number) {
  vi.spyOn(outer, 'getBoundingClientRect').mockReturnValue({ height } as DOMRect);
}

describe('SmoothHeight', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    roCallback = null;
    observed = null;
  });

  function renderWrapper({ enabled = true }: { enabled?: boolean } = {}) {
    const view = render(
      <SmoothHeight enabled={enabled} swapKey="collapsed">
        <span>content</span>
      </SmoothHeight>,
    );
    const outer = view.container.firstElementChild as HTMLDivElement;
    const swap = (swapKey: string) =>
      view.rerender(
        <SmoothHeight enabled={enabled} swapKey={swapKey}>
          <span>content</span>
        </SmoothHeight>,
      );
    return { outer, swap };
  }

  it('observes the inner content element', () => {
    const { outer } = renderWrapper();
    expect(observed).toBe(outer.firstElementChild);
  });

  it('lets content that arrives without a swap land instantly (a chart finishing its render)', () => {
    const { outer } = renderWrapper();
    fireResize(544);
    fireResize(2148);
    fireResize(2100);
    expect(outer.style.height).toBe('');
    expect(outer.style.transition).toBe('');
    expect(outer.style.overflow).toBe('');
  });

  it('pins the pre-swap height when the swap commits, before any resize is observed', () => {
    const { outer, swap } = renderWrapper();
    fireResize(300);
    swap('expanded');
    expect(outer.style.height).toBe('300px');
    expect(outer.style.overflow).toBe('hidden');
    expect(outer.style.transition).toBe('none');
  });

  it('animates the swap to the new natural height and settles back to auto', async () => {
    const { outer, swap } = renderWrapper();
    fireResize(300);
    swap('expanded');
    setRenderedHeight(outer, 300);
    fireResize(100);
    expect(outer.style.height).toBe('100px');
    expect(outer.style.transition).toContain('height');
    expect(outer.style.overflow).toBe('hidden');
    // After the transition window (280ms + 50ms settle margin) the inline
    // overrides are cleared → auto.
    await vi.advanceTimersByTimeAsync(330);
    expect(outer.style.height).toBe('');
    expect(outer.style.transition).toBe('');
    expect(outer.style.overflow).toBe('');
  });

  it('releases the pin when the swap does not change the height', async () => {
    const { outer, swap } = renderWrapper();
    fireResize(300);
    swap('expanded');
    expect(outer.style.height).toBe('300px');
    await vi.advanceTimersByTimeAsync(330);
    expect(outer.style.height).toBe('');
    expect(outer.style.overflow).toBe('');
  });

  it('retargets a running swap animation to the newest height', async () => {
    const { outer, swap } = renderWrapper();
    fireResize(300);
    swap('expanded');
    setRenderedHeight(outer, 300);
    fireResize(100);
    setRenderedHeight(outer, 220);
    fireResize(140);
    expect(outer.style.height).toBe('140px');
    expect(outer.style.transition).toContain('height');
    await vi.advanceTimersByTimeAsync(330);
    expect(outer.style.height).toBe('');
  });

  it('never animates a swap before the first measure after mount (virtualized remounts must not dance)', () => {
    const { outer, swap } = renderWrapper();
    swap('expanded');
    fireResize(500);
    expect(outer.style.height).toBe('');
    expect(outer.style.transition).toBe('');
  });

  it('does not animate when the app asks for reduced motion (<html data-motion="reduced">)', () => {
    document.documentElement.dataset.motion = 'reduced';
    try {
      const { outer, swap } = renderWrapper();
      fireResize(300);
      swap('expanded');
      fireResize(100);
      expect(outer.style.height).toBe('');
      expect(outer.style.transition).toBe('');
    } finally {
      delete document.documentElement.dataset.motion;
    }
  });

  it('follows the app setting, not the system media query', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({ matches: true }),
    );
    const { outer, swap } = renderWrapper();
    fireResize(300);
    swap('expanded');
    setRenderedHeight(outer, 300);
    fireResize(100);
    expect(outer.style.height).toBe('100px');
    expect(outer.style.transition).toContain('height');
  });

  it('observes nothing and pins nothing when disabled (settled history groups)', () => {
    const { outer, swap } = renderWrapper({ enabled: false });
    expect(observed).toBeNull();
    swap('expanded');
    expect(outer.style.height).toBe('');
  });

  it('renders inert without ResizeObserver (jsdom safety)', () => {
    vi.unstubAllGlobals();
    // @ts-expect-error — simulate an environment without ResizeObserver
    delete globalThis.ResizeObserver;
    const { container } = render(
      <SmoothHeight swapKey="collapsed">
        <span>content</span>
      </SmoothHeight>,
    );
    expect(container.textContent).toBe('content');
  });
});
