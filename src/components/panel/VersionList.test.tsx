// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from '@/components/ds/button';
import { Menu } from '@/components/ds/menu';
import { DesignSystemProvider } from '@/components/ds/provider';
import { setLanguage } from '@/i18n';

const listVersionsMock = vi.fn();
vi.mock('@/utils/canvasVersions', async () => ({
  ...(await vi.importActual<typeof import('@/utils/canvasVersions')>('@/utils/canvasVersions')),
  listVersions: (...args: unknown[]) => listVersionsMock(...args),
}));

import { VersionList } from './VersionList';

describe('VersionList', () => {
  beforeAll(() => {
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.setPointerCapture ??= () => {};
    Element.prototype.releasePointerCapture ??= () => {};
    Element.prototype.scrollIntoView ??= () => {};
  });

  beforeEach(() => {
    listVersionsMock.mockReset();
    setLanguage('zh-CN');
  });

  afterEach(() => {
    cleanup();
    setLanguage('system');
  });

  it('lists only the versions of the conversation it is given, and hands the chosen one over', async () => {
    const user = userEvent.setup();
    const version = { id: '2-1', ts: 2, byteSize: 10, source: 'ai' as const, label: '整理笔记', origins: [{ conversationId: 'conv-a' }] };
    listVersionsMock.mockResolvedValue([version]);
    const onPick = vi.fn();
    render(
      <DesignSystemProvider>
        <Menu open trigger={<Button>Open</Button>}>
          <VersionList filePath="/w/notes.md" conversationId="conv-a" onPick={onPick} />
        </Menu>
      </DesignSystemProvider>,
    );

    await user.click(await screen.findByRole('menuitem'));

    expect(listVersionsMock).toHaveBeenCalledExactlyOnceWith('/w/notes.md', { conversationId: 'conv-a' });
    expect(onPick).toHaveBeenCalledExactlyOnceWith(version);
  });
});
