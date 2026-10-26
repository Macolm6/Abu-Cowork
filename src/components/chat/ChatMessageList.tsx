import { useCallback, useImperativeHandle, useLayoutEffect, useRef, useState, type Key, type ReactNode, type Ref } from 'react';
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual';
import { cn } from '@/lib/utils';
import {
  CHAT_GROUP_ESTIMATE_PX,
  CHAT_LIST_EXTEND_PX,
  extendRangeByPx,
  initialScrollOffset,
  rowResizeMovesScroll,
  type ChatListLocation,
} from './chatListRange';
import RowMountProvider from './RowMountProvider';

/** How long the move to the newest message takes at most, and the share of the remaining distance each frame covers. */
const LATEST_SCROLL_MS = 320;
const LATEST_SCROLL_STEP = 0.22;

export interface ChatMessageListHandle {
  scrollToIndex(location: ChatListLocation & { behavior: 'auto' | 'smooth' }): void;
}

interface ChatMessageListProps<T> {
  ref?: Ref<ChatMessageListHandle>;
  data: readonly T[];
  computeItemKey: (index: number, item: T) => Key;
  itemContent: (index: number, item: T) => ReactNode;
  /** The scrolled element the list lives in; it may hold content above and below the list. */
  scrollParent: HTMLElement;
  /** Where the list is when it first paints. Read at mount only: the owner remounts the list per conversation. */
  initialLocation: ChatListLocation;
  itemClassName: string;
  /** Rendered after the last row, inside the scrolled content. */
  footer: ReactNode;
  /** Asked when rows are appended, with whether the view was at the bottom before; 'auto' moves it to the end. */
  followOutput: false | ((atBottom: boolean) => 'auto' | false);
  atBottomThreshold: number;
  atBottomStateChange: (atBottom: boolean) => void;
  totalListHeightChanged: (height: number) => void;
  /**
   * Asked when a row's measured height changes while the view is at the
   * bottom; true keeps the view at the bottom in the same frame.
   */
  keepsBottom: () => boolean;
}

/**
 * The conversation transcript, virtualized: only the rows near the viewport are
 * mounted.
 *
 * The list computes its first range at `initialLocation` and scrolls there in
 * the layout pass of its mount. Rows measure themselves while React commits,
 * and the virtualizer re-renders synchronously with the measured sizes, so the
 * first frame the browser paints already shows the target rows at their final
 * position: switching conversations goes from the old transcript to the new
 * one with no empty frame in between.
 *
 * Rows are placed with `top`, not `transform`: a transformed ancestor would
 * become the containing block of `position: fixed` content inside a message
 * (an MCP app's fullscreen surface).
 */
export default function ChatMessageList<T>({
  ref,
  data,
  computeItemKey,
  itemContent,
  scrollParent,
  initialLocation,
  itemClassName,
  footer,
  followOutput,
  atBottomThreshold,
  atBottomStateChange,
  totalListHeightChanged,
  keepsBottom,
}: ChatMessageListProps<T>) {
  const listRef = useRef<HTMLDivElement>(null);
  const [startLocation] = useState(initialLocation);
  const [scrollMargin, setScrollMargin] = useState(0);
  // eslint-disable-next-line react-hooks/incompatible-library -- the build does not run React Compiler; the virtualizer re-renders this component itself
  const virtualizer: Virtualizer<HTMLElement, HTMLDivElement> = useVirtualizer<HTMLElement, HTMLDivElement>({
    count: data.length,
    getScrollElement: () => scrollParent,
    estimateSize: () => CHAT_GROUP_ESTIMATE_PX,
    getItemKey: (index) => computeItemKey(index, data[index]),
    scrollMargin,
    initialRect: { width: scrollParent.clientWidth, height: scrollParent.clientHeight },
    initialOffset: () => initialScrollOffset({
      location: startLocation,
      count: data.length,
      estimate: CHAT_GROUP_ESTIMATE_PX,
      scrollMargin,
      viewportHeight: scrollParent.clientHeight,
    }),
    // Called while the rows render, after `virtualizer` is assigned.
    rangeExtractor: (range): number[] => extendRangeByPx(
      virtualizer.measurementsCache,
      range.startIndex,
      range.endIndex,
      CHAT_LIST_EXTEND_PX,
    ),
  });

  // The owner's callbacks change between renders; the listeners below read the latest.
  const latest = useRef({ followOutput, atBottomThreshold, atBottomStateChange, totalListHeightChanged, keepsBottom });
  useLayoutEffect(() => {
    latest.current = { followOutput, atBottomThreshold, atBottomStateChange, totalListHeightChanged, keepsBottom };
  });

  const atBottomRef = useRef(true);
  const reportAtBottom = useCallback(() => {
    const distance = scrollParent.scrollHeight - scrollParent.scrollTop - scrollParent.clientHeight;
    const atBottom = distance <= latest.current.atBottomThreshold;
    if (atBottom === atBottomRef.current) return;
    atBottomRef.current = atBottom;
    latest.current.atBottomStateChange(atBottom);
  }, [scrollParent]);

  // A row that grows after it is shown (a chart or widget finishing its render)
  // keeps a reader at the bottom there in the frame it grows: the virtualizer
  // moves the offset by the row's delta and re-renders synchronously inside its
  // ResizeObserver callback, before the browser paints. The owner's own
  // bottom-follow reacts to the new list height a frame later.
  useLayoutEffect(() => {
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => rowResizeMovesScroll({
      keepsBottom: atBottomRef.current && latest.current.keepsBottom(),
      firstMeasure: !instance.itemSizeCache.has(item.key),
      row: item,
      scrollOffset: instance.scrollOffset ?? 0,
      scrollingBackward: instance.scrollDirection === 'backward',
    });
  }, [virtualizer]);

  // Where the list starts inside the scrolled content (the content's own top padding).
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    setScrollMargin(list.getBoundingClientRect().top - scrollParent.getBoundingClientRect().top + scrollParent.scrollTop);
  }, [scrollParent]);

  useLayoutEffect(() => {
    if (startLocation.index === 'LAST') {
      virtualizer.scrollToEnd();
    } else {
      virtualizer.scrollToIndex(startLocation.index, { align: startLocation.align });
    }
    reportAtBottom();
  }, [reportAtBottom, startLocation, virtualizer]);

  // A smooth move to the newest message is animated here, frame by frame,
  // towards the bottom as it is in that frame. The browser's own smooth scroll
  // stops when the content height changes on the way, which it does whenever a
  // row entering the range is measured, and nothing would resume it.
  const latestAnimationRef = useRef(0);
  const cancelLatestAnimation = useCallback(() => {
    cancelAnimationFrame(latestAnimationRef.current);
    latestAnimationRef.current = 0;
  }, []);
  const animateToEnd = useCallback(() => {
    cancelLatestAnimation();
    const start = performance.now();
    const step = (now: number) => {
      const bottom = scrollParent.scrollHeight - scrollParent.clientHeight;
      const remaining = bottom - scrollParent.scrollTop;
      if (now - start >= LATEST_SCROLL_MS || Math.abs(remaining) <= 1) {
        scrollParent.scrollTop = bottom;
        latestAnimationRef.current = 0;
        return;
      }
      scrollParent.scrollTop += remaining * LATEST_SCROLL_STEP;
      latestAnimationRef.current = requestAnimationFrame(step);
    };
    latestAnimationRef.current = requestAnimationFrame(step);
  }, [cancelLatestAnimation, scrollParent]);
  // The reader's own scrolling takes over from the animation.
  useLayoutEffect(() => {
    const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
    for (const name of events) scrollParent.addEventListener(name, cancelLatestAnimation, { passive: true });
    return () => {
      for (const name of events) scrollParent.removeEventListener(name, cancelLatestAnimation);
      cancelLatestAnimation();
    };
  }, [cancelLatestAnimation, scrollParent]);

  useImperativeHandle(ref, () => ({
    scrollToIndex({ index, align, behavior }) {
      cancelLatestAnimation();
      if (index === 'LAST' && behavior === 'smooth') {
        animateToEnd();
      } else if (index === 'LAST') {
        virtualizer.scrollToEnd();
      } else {
        virtualizer.scrollToIndex(index, { align, behavior });
      }
    },
  }), [animateToEnd, cancelLatestAnimation, virtualizer]);

  // Appended rows follow the bottom when the owner says so. Runs before the
  // at-bottom state below takes in the new height, so it reads the state from
  // before the append.
  const countRef = useRef(data.length);
  useLayoutEffect(() => {
    const previousCount = countRef.current;
    countRef.current = data.length;
    if (data.length <= previousCount) return;
    const follow = latest.current.followOutput;
    if (follow !== false && follow(atBottomRef.current) === 'auto') virtualizer.scrollToEnd();
  }, [data.length, virtualizer]);

  const totalSize = virtualizer.getTotalSize();
  const totalRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (totalRef.current !== totalSize) {
      totalRef.current = totalSize;
      latest.current.totalListHeightChanged(totalSize);
    }
    reportAtBottom();
  }, [reportAtBottom, totalSize]);

  useLayoutEffect(() => {
    const onScroll = () => reportAtBottom();
    scrollParent.addEventListener('scroll', onScroll, { passive: true });
    // A viewport that gets shorter (the composer grows) keeps a reader who was
    // at the bottom there.
    let viewportHeight = scrollParent.clientHeight;
    const observer = new ResizeObserver(() => {
      const nextHeight = scrollParent.clientHeight;
      const shrank = nextHeight < viewportHeight;
      viewportHeight = nextHeight;
      if (shrank && atBottomRef.current && latest.current.followOutput !== false) {
        scrollParent.scrollTop = scrollParent.scrollHeight;
      }
      reportAtBottom();
    });
    observer.observe(scrollParent);
    return () => {
      scrollParent.removeEventListener('scroll', onScroll);
      observer.disconnect();
    };
  }, [reportAtBottom, scrollParent]);

  return (
    <>
      <div ref={listRef} data-testid="chat-message-list" className="relative w-full" style={{ height: totalSize }}>
        {virtualizer.getVirtualItems().map((item) => (
          <div
            key={item.key}
            ref={virtualizer.measureElement}
            data-index={item.index}
            className={cn('absolute left-0 w-full', itemClassName)}
            style={{ top: item.start - scrollMargin }}
          >
            <RowMountProvider>{itemContent(item.index, data[item.index])}</RowMountProvider>
          </div>
        ))}
      </div>
      {footer}
    </>
  );
}
