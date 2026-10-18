import type { FileChangeHunk } from '@/types/fileChange';

/** Diff lines one file renders at most. */
export const MAX_RENDERED_DIFF_LINES = 5000;

/**
 * The leading `maxLines` lines of `hunks`. `cut` says lines were left out; the
 * hunk the limit falls in is shortened and its line counts follow.
 */
export function limitHunkLines(hunks: FileChangeHunk[], maxLines: number): { hunks: FileChangeHunk[]; cut: boolean } {
  const total = hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
  if (total <= maxLines) return { hunks, cut: false };

  const kept: FileChangeHunk[] = [];
  let remaining = maxLines;
  for (const hunk of hunks) {
    if (remaining === 0) break;
    if (hunk.lines.length <= remaining) {
      kept.push(hunk);
      remaining -= hunk.lines.length;
      continue;
    }
    const lines = hunk.lines.slice(0, remaining);
    kept.push({
      oldStart: hunk.oldStart,
      oldLines: lines.filter((line) => !line.startsWith('+')).length,
      newStart: hunk.newStart,
      newLines: lines.filter((line) => !line.startsWith('-')).length,
      lines,
    });
    remaining = 0;
  }
  return { hunks: kept, cut: true };
}
