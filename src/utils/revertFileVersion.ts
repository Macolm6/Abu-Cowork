import { versionReverterFor } from '@/stores/previewStore';
import { revertToVersion, type VersionOrigin } from '@/utils/canvasVersions';

/**
 * Restores `path` to its version `id`, from any place that offers the
 * version history. A preview that shows the file restores it itself, so its
 * editor shows the restored content and its pending autosave cannot write
 * over it; with no such preview the file is written directly.
 */
export async function revertFileVersion(path: string, id: string, origin: VersionOrigin | null): Promise<void> {
  const revert = versionReverterFor(path);
  if (revert) {
    await revert(id, origin);
    return;
  }
  await revertToVersion(path, id, origin);
}
