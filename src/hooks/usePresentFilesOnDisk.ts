import { useEffect, useState } from 'react';
import { exists } from '@/core/tools/fsBridge';
import { useRenderMemoryStore } from '@/stores/renderMemoryStore';
import type { PresentedFile } from '@/utils/presentedFiles';

const NO_FILES: PresentedFile[] = [];

interface DiskCheck {
  key: string;
  files: PresentedFile[];
}

// The last answer for each list is remembered across launches: a message row
// mounted again (switching back to a conversation, scrolling it back into
// view, opening it after a restart) shows the cards it showed before while it
// checks again, instead of adding them a moment later and pushing the
// transcript.
function listKey(files: readonly PresentedFile[]): string {
  return JSON.stringify(files.map((file) => file.path));
}

function rememberedAnswer(key: string, declared: readonly PresentedFile[]): PresentedFile[] | null {
  const paths = useRenderMemoryStore.getState().presentFiles[key];
  if (!paths) return null;
  const onDisk = new Set(paths);
  return declared.filter((file) => onDisk.has(file.path));
}

export interface PresentFilesOnDisk {
  /** The files to show: this mount's answer, else the last answer for the list, else `null`. */
  files: PresentedFile[] | null;
  /** Whether this mount's check of the list has answered. */
  checked: boolean;
}

/**
 * The presented files that are on disk right now, in their declared order.
 *
 * A list checked before shows its last answer at once while this mount checks
 * it again; a list never checked shows `null` until its check answers. While
 * `enabled` is false the files are an empty list and nothing is read from
 * disk. The list is checked when it changes and each time the window regains
 * focus.
 */
export function usePresentFilesOnDisk(files: readonly PresentedFile[], enabled: boolean): PresentFilesOnDisk {
  // Callers pass a fresh array per render; the serialized list is the identity.
  const serialized = JSON.stringify(files);
  const key = listKey(files);
  const active = enabled && files.length > 0;
  const [check, setCheck] = useState<DiskCheck | null>(null);

  useEffect(() => {
    if (!active) return;
    const declared = JSON.parse(serialized) as PresentedFile[];
    let cancelled = false;
    let latestRun = 0;

    const run = async () => {
      const runId = ++latestRun;
      const present = await Promise.all(declared.map((file) => exists(file.path)));
      if (cancelled || runId !== latestRun) return;
      const onDisk = declared.filter((_, index) => present[index]);
      useRenderMemoryStore.getState().rememberPresentFiles(key, onDisk.map((file) => file.path));
      setCheck({ key: serialized, files: onDisk });
    };

    void run();
    const onFocus = () => { void run(); };
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
    };
  }, [serialized, key, active]);

  if (!active) return { files: NO_FILES, checked: true };
  if (check !== null && check.key === serialized) return { files: check.files, checked: true };
  return { files: rememberedAnswer(key, files), checked: false };
}
