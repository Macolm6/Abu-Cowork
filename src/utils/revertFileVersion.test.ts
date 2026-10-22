import { beforeEach, describe, expect, it, vi } from 'vitest';

const revertToVersionMock = vi.hoisted(() => vi.fn());
vi.mock('@/utils/canvasVersions', () => ({
  revertToVersion: (...args: unknown[]) => revertToVersionMock(...args),
}));

import { usePreviewStore } from '@/stores/previewStore';
import { revertFileVersion } from './revertFileVersion';

const ORIGIN = { conversationId: 'conv-1' };

describe('revertFileVersion', () => {
  beforeEach(() => {
    revertToVersionMock.mockReset();
    revertToVersionMock.mockResolvedValue('restored');
  });

  it('hands the restore to the preview registered for the path, and writes nothing itself', async () => {
    const preview = vi.fn().mockResolvedValue(undefined);
    const unregister = usePreviewStore.getState().registerVersionReverter('/w/notes.md', preview);

    await revertFileVersion('/w/notes.md', 'v1', ORIGIN);

    expect(preview).toHaveBeenCalledExactlyOnceWith('v1', ORIGIN);
    expect(revertToVersionMock).not.toHaveBeenCalled();
    unregister();
  });

  it('finds the preview under another spelling of the path', async () => {
    const preview = vi.fn().mockResolvedValue(undefined);
    const unregister = usePreviewStore.getState().registerVersionReverter('C:\\w\\notes.md', preview);

    await revertFileVersion('C:/w/notes.md', 'v1', ORIGIN);

    expect(preview).toHaveBeenCalledOnce();
    unregister();
  });

  it('uses the latest registration of a path, and the earlier one once the latest is taken back', async () => {
    const first = vi.fn().mockResolvedValue(undefined);
    const second = vi.fn().mockResolvedValue(undefined);
    const unregisterFirst = usePreviewStore.getState().registerVersionReverter('/w/notes.md', first);
    const unregisterSecond = usePreviewStore.getState().registerVersionReverter('/w/notes.md', second);

    await revertFileVersion('/w/notes.md', 'v1', ORIGIN);
    unregisterSecond();
    await revertFileVersion('/w/notes.md', 'v2', ORIGIN);

    expect(second.mock.calls).toEqual([['v1', ORIGIN]]);
    expect(first.mock.calls).toEqual([['v2', ORIGIN]]);
    unregisterFirst();
  });

  it('writes the version directly once no preview is registered for the path', async () => {
    const preview = vi.fn().mockResolvedValue(undefined);
    usePreviewStore.getState().registerVersionReverter('/w/notes.md', preview)();

    await revertFileVersion('/w/notes.md', 'v1', ORIGIN);

    expect(preview).not.toHaveBeenCalled();
    expect(revertToVersionMock).toHaveBeenCalledExactlyOnceWith('/w/notes.md', 'v1', ORIGIN);
  });

  it('rejects with the failure of the restore', async () => {
    revertToVersionMock.mockRejectedValue(new Error('disk full'));
    await expect(revertFileVersion('/w/notes.md', 'v1', ORIGIN)).rejects.toThrow('disk full');
  });
});
