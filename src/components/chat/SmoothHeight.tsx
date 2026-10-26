import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';

// Matches claude.ai's collapsible-block transition duration (280ms ease-out),
// which our expand-on-mount animation (.block-expand-enter, 200ms) sits just
// under — swaps read slightly slower than streaming growth, deliberately.
const DURATION_MS = 280;

// appearance.ts writes the app's reduce-motion choice here (the design
// preview can force it too), so the chat follows one switch app-wide.
const reduceMotion = () => document.documentElement.dataset.motion === 'reduced';

/**
 * Smooths the height change of a layout swap among its children: when
 * `swapKey` changes, the wrapper keeps the height it had before the swap and
 * transitions to the new natural height instead of letting it land in a
 * single frame.
 *
 * Why this exists: with the chat pinned to the bottom, a one-frame shrink of
 * the last message group (the completion fold replacing the expanded thinking
 * block) clamps scrollTop instantly — the whole view visibly jumps DOWN. The
 * mount direction is covered by .block-expand-enter, but the fold is a
 * component *swap* (TaskBlock unmounts, the "用时 Xs" header mounts), so no
 * CSS enter/exit animation on either component can bridge it. Animating the
 * measured height of the region that contains the swap can.
 *
 * The old height is pinned in a layout effect, after the swapped children are
 * in the DOM and before the browser lays them out, so the message row never
 * reaches its new height in one layout pass. The chat list measures rows with
 * its own ResizeObserver; a height it reads in the same pass that the wrapper
 * then pins back would leave the list one row-delta taller than the row it
 * holds, and the bottom-pinned view would show that empty space for a frame.
 *
 * Every other height change — streamed tokens, a chart or widget finishing
 * its render, an image loading — is content arriving, and lands instantly.
 * A change that arrives while a swap is animating retargets that animation.
 *
 * Non-goals / guarantees:
 * - Nothing animates before the first measure after mount — history rows
 *   remounting during virtualized scrolling must not dance.
 * - Honors the app's reduced motion (<html data-motion="reduced">); no-ops entirely without ResizeObserver
 *   (jsdom).
 */
export default function SmoothHeight({
  children,
  enabled = true,
  swapKey,
}: {
  children: ReactNode;
  /**
   * When false the wrapper renders but observes nothing — height changes are
   * instant. Callers that render many instances (one per virtualized message
   * group) disable all but the one that can actually swap (the live group);
   * keeping the wrapper elements mounted either way means toggling `enabled`
   * never restructures the DOM (which would remount children and reset their
   * state, e.g. iframe widgets).
   */
  enabled?: boolean;
  /**
   * Names the children's current layout state. A render that changes it is a
   * swap, and the height change that swap causes animates.
   */
  swapKey: string;
}) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const lastHeightRef = useRef<number | null>(null);
  const animatingRef = useRef(false);
  const armedRef = useRef(false);
  const swapKeyRef = useRef(swapKey);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const settle = useCallback(() => {
    animatingRef.current = false;
    armedRef.current = false;
    const outer = outerRef.current;
    if (!outer) return;
    outer.style.height = '';
    outer.style.overflow = '';
    outer.style.transition = '';
  }, []);
  // Timer instead of transitionend: 'transitionend' is swallowed when the
  // transition is retargeted or the element is display-toggled mid-flight, and
  // a swap whose height did not change fires no resize at all; either would
  // leave the height pinned forever.
  const scheduleSettle = useCallback(() => {
    clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(settle, DURATION_MS + 50);
  }, [settle]);

  useLayoutEffect(() => {
    if (swapKeyRef.current === swapKey) return;
    swapKeyRef.current = swapKey;
    const outer = outerRef.current;
    const prev = lastHeightRef.current;
    if (!enabled || !outer || prev == null || reduceMotion()) return;
    armedRef.current = true;
    // A swap during a running animation is picked up by the retarget below;
    // the outer box is already pinned to its in-between height.
    if (!animatingRef.current) {
      outer.style.transition = 'none';
      outer.style.height = `${prev}px`;
      // Clip while pinned smaller than the content (grow direction).
      outer.style.overflow = 'hidden';
    }
    scheduleSettle();
  });

  useEffect(() => {
    if (!enabled) return;
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner || typeof ResizeObserver === 'undefined') return;

    const ro = new ResizeObserver((entries) => {
      const newHeight =
        entries[entries.length - 1]?.contentRect.height ?? inner.offsetHeight;
      lastHeightRef.current = newHeight;
      if (!armedRef.current && !animatingRef.current) return;
      armedRef.current = false;
      if (reduceMotion()) {
        settle();
        return;
      }
      // The outer box is pinned (a fresh swap) or mid-transition, so its rect
      // is the height the user is seeing right now.
      const startHeight = outer.getBoundingClientRect().height;
      if (Math.abs(startHeight - newHeight) < 1) {
        settle();
        return;
      }
      animatingRef.current = true;
      outer.style.transition = 'none';
      outer.style.height = `${startHeight}px`;
      outer.style.overflow = 'hidden';
      // Commit the start height before enabling the transition, or the browser
      // coalesces both writes and nothing animates.
      void outer.offsetHeight;
      outer.style.transition = `height ${DURATION_MS}ms var(--ease-enter)`;
      outer.style.height = `${newHeight}px`;
      scheduleSettle();
    });
    ro.observe(inner);
    return () => {
      ro.disconnect();
      clearTimeout(settleTimerRef.current);
      settle();
      // Re-enabling later must not animate the first measure it sees.
      lastHeightRef.current = null;
    };
  }, [enabled, scheduleSettle, settle]);

  return (
    <div ref={outerRef}>
      <div ref={innerRef}>{children}</div>
    </div>
  );
}
