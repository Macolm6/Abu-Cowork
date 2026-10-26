// Pure geometry for ChatMessageList: which rows to keep mounted, and where the
// list starts before any row has been measured.

/** Estimated height of one message group before it is measured. */
export const CHAT_GROUP_ESTIMATE_PX = 400;

/** Rows mounted above and below the viewport, in pixels. Keeps inline iframe
 *  widgets (HtmlWidgetBlock) alive through the small scroll jitter of normal
 *  reading, which a bare unmount would reset (srcdoc reload, widget JS state). */
export const CHAT_LIST_EXTEND_PX = 900;

export interface ChatListLocation {
  index: number | 'LAST';
  align: 'start' | 'center' | 'end';
}

interface RowExtent {
  start: number;
  end: number;
}

/**
 * Indexes from `startIndex` to `endIndex`, widened by every row that lies
 * within `extendPx` above the first visible row or below the last one.
 */
export function extendRangeByPx(
  measurements: readonly RowExtent[],
  startIndex: number,
  endIndex: number,
  extendPx: number,
): number[] {
  if (measurements.length === 0) return [];
  const last = measurements.length - 1;
  const from = Math.max(0, Math.min(startIndex, last));
  const to = Math.max(from, Math.min(endIndex, last));
  const top = measurements[from].start - extendPx;
  const bottom = measurements[to].end + extendPx;
  let first = from;
  while (first > 0 && measurements[first - 1].end >= top) first -= 1;
  let final = to;
  while (final < last && measurements[final + 1].start <= bottom) final += 1;
  return Array.from({ length: final - first + 1 }, (_, i) => first + i);
}

/**
 * The scroll offset the list computes its first range from, before any row is
 * measured: every row at the estimate, `location` placed as a scroll to it
 * would place it.
 */
export function initialScrollOffset({
  location,
  count,
  estimate,
  scrollMargin,
  viewportHeight,
}: {
  location: ChatListLocation;
  count: number;
  estimate: number;
  scrollMargin: number;
  viewportHeight: number;
}): number {
  const index = location.index === 'LAST' ? count - 1 : location.index;
  const rowStart = scrollMargin + index * estimate;
  const offset = location.align === 'start'
    ? rowStart
    : location.align === 'center'
      ? rowStart + estimate / 2 - viewportHeight / 2
      : rowStart + estimate - viewportHeight;
  return Math.max(0, offset);
}
