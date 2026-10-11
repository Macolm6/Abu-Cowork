import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { Button } from '@/components/ds/button';
import { LoadError } from '@/components/ds/load-error';
import { Pressable } from '@/components/ds/pressable';
import { SegmentedControl } from '@/components/ds/segmented-control';
import { ChangeAmount } from '@/components/chat/ChangedFilesCard';
import { DiffLines } from '@/components/diff/DiffLines';
import { DiffSplit } from '@/components/diff/DiffSplit';
import { limitHunkLines, MAX_RENDERED_DIFF_LINES } from '@/components/diff/hunkLimit';
import { focusIsOnWindow } from '@/components/toolbox/cardFocus';
import { useTurnChangesDetail } from '@/hooks/useTurnChanges';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { usePreviewStore } from '@/stores/previewStore';
import type { TurnChangedFile } from '@/core/session/turnChanges';

export type DiffLayout = 'split' | 'unified';

/** Below this panel width a comparison starts out with before above after. */
const SPLIT_MIN_WIDTH = 640;

/** The width of the element `ref` is attached to; 0 until it is laid out, and while it is hidden. */
function useElementWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let frame: number | null = null;
    const measure = (): void => {
      frame = null;
      setWidth(element.getBoundingClientRect().width);
    };
    measure();
    const observer = new ResizeObserver(() => {
      if (frame === null) frame = requestAnimationFrame(measure);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, []);
  return [ref, width];
}

/**
 * The comparison of one changed file, or the line that says there is none.
 * At most `maxLines` diff lines are rendered; a longer comparison ends with
 * the line that says it is cut.
 */
export function TurnFileComparison({ file, layout, maxLines = MAX_RENDERED_DIFF_LINES }: {
  file: TurnChangedFile;
  layout: DiffLayout;
  maxLines?: number;
}) {
  const { t } = useI18n();
  const limited = useMemo(
    () => (file.hunks ? limitHunkLines(file.hunks, maxLines) : null),
    [file.hunks, maxLines],
  );
  if (!limited || limited.hunks.length === 0) {
    return <p className="px-3 py-6 text-center text-ui text-label-secondary">{t.panel.noDiffToShow}</p>;
  }
  return (
    <div data-testid="changes-diff" data-diff-layout={layout}>
      {layout === 'split'
        ? <DiffSplit hunks={limited.hunks} cut={limited.cut} />
        : <DiffLines hunks={limited.hunks} cut={limited.cut} />}
    </div>
  );
}

/**
 * Body of a changes tab: the files one turn changed and, for the file in view,
 * its content at the start of the turn compared with its content at the end.
 */
function ChangesTab({ tabId, conversationId, loopId, fileIndex }: {
  tabId: string;
  conversationId: string;
  loopId: string;
  fileIndex: number;
}) {
  const { t } = useI18n();
  const detail = useTurnChangesDetail(conversationId, loopId);
  const selectFile = usePreviewStore((s) => s.selectTurnChangesFile);
  const openPreview = usePreviewStore((s) => s.openPreview);
  const [containerRef, width] = useElementWidth<HTMLDivElement>();
  // The reader's own choice of layout; until there is one the panel width decides.
  const [chosenLayout, setChosenLayout] = useState<DiffLayout | null>(null);
  const layout: DiffLayout = chosenLayout ?? (width > 0 && width < SPLIT_MIN_WIDTH ? 'unified' : 'split');

  const files = detail.turn?.files ?? [];
  const selectedIndex = fileIndex >= 0 && fileIndex < files.length ? fileIndex : 0;
  const file = files[selectedIndex];
  const unreadable = detail.status === 'error' || (detail.status === 'ready' && !file);
  // A retry is reading: the explanation stays, so the button under the focus does not leave the page.
  const [retrying, setRetrying] = useState(false);
  const rowRefs = useRef(new Map<number, HTMLButtonElement>());
  const loaded = detail.status === 'ready' && file !== undefined;

  useEffect(() => {
    if (!retrying || detail.status === 'loading') return;
    setRetrying(false);
    if (loaded && focusIsOnWindow()) rowRefs.current.get(selectedIndex)?.focus();
  }, [retrying, detail.status, loaded, selectedIndex]);

  const retry = (): void => {
    setRetrying(true);
    detail.reload();
  };

  // One tab stop for the list; the arrow keys, Home and End walk its rows.
  const walkRows = (event: KeyboardEvent<HTMLUListElement>): void => {
    const current = [...rowRefs.current.entries()].find(([, row]) => row === document.activeElement)?.[0];
    if (current === undefined) return;
    const target = event.key === 'ArrowDown' ? Math.min(current + 1, files.length - 1)
      : event.key === 'ArrowUp' ? Math.max(current - 1, 0)
        : event.key === 'Home' ? 0
          : event.key === 'End' ? files.length - 1
            : null;
    if (target === null) return;
    event.preventDefault();
    rowRefs.current.get(target)?.focus();
  };

  return (
    <div ref={containerRef} data-testid="changes-tab" className="flex h-full flex-col">
      {(unreadable || (retrying && detail.status === 'loading')) && (
        <LoadError reason={t.panel.changesUnreadable} onRetry={retry} busy={detail.status === 'loading'} />
      )}
      {loaded && (
        <>
          <ul onKeyDown={walkRows} className="max-h-40 shrink-0 overflow-y-auto border-b border-separator py-1">
            {files.map((entry, index) => (
              <li key={entry.path}>
                <Pressable
                  ref={(row) => {
                    if (row) rowRefs.current.set(index, row);
                    else rowRefs.current.delete(index);
                  }}
                  tabIndex={index === selectedIndex ? 0 : -1}
                  onClick={() => selectFile(tabId, index)}
                  aria-current={index === selectedIndex ? 'true' : undefined}
                  title={entry.display}
                  className={cn(
                    'flex w-full items-center gap-3 px-3 py-1 text-left text-ui-sm transition-colors duration-fast',
                    index === selectedIndex
                      ? 'bg-fill-selected text-label'
                      : 'text-label-secondary hover:bg-fill-hover hover:text-label',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{entry.display}</span>
                  <ChangeAmount file={entry} />
                </Pressable>
              </li>
            ))}
          </ul>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-b border-separator px-3 py-2">
            <SegmentedControl
              label={`${t.panel.diffUnified} / ${t.panel.diffSplit}`}
              value={layout}
              onValueChange={(value) => setChosenLayout(value === 'unified' ? 'unified' : 'split')}
              options={[
                { value: 'unified', label: t.panel.diffUnified },
                { value: 'split', label: t.panel.diffSplit },
              ]}
            />
            {/* This panel leaves the page when the preview tab opens, so the focus goes to that tab. */}
            <Button size="sm" onClick={() => openPreview(file.path, { focusTab: true })}>{t.panel.openFile}</Button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-3">
            <TurnFileComparison key={file.path} file={file} layout={layout} />
          </div>
        </>
      )}
    </div>
  );
}

export default memo(ChangesTab);
