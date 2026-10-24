import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureAppPage } from './appPageBridge';

type Shell = { appPage: (action: string, input: object) => Promise<unknown> };

function installShell(answer: unknown): Shell['appPage'] {
  const appPage = vi.fn(async () => answer);
  (globalThis as typeof globalThis & { __ABU_SHELL__?: Shell }).__ABU_SHELL__ = { appPage };
  return appPage;
}

describe('captureAppPage', () => {
  afterEach(() => {
    delete (globalThis as typeof globalThis & { __ABU_SHELL__?: Shell }).__ABU_SHELL__;
  });

  it('asks the host for the named page and returns its frame', async () => {
    const appPage = installShell('data:image/png;base64,AAAA');
    await expect(captureAppPage('shop@org', 'portal')).resolves.toBe('data:image/png;base64,AAAA');
    expect(vi.mocked(appPage).mock.calls).toEqual([['capture', { appId: 'shop@org', navItemId: 'portal' }]]);
  });

  it('returns null when the host has no frame to give', async () => {
    installShell(null);
    await expect(captureAppPage('shop@org', 'portal')).resolves.toBeNull();
  });

  it('refuses an answer that is no image', async () => {
    installShell('https://shop.example.com/');
    await expect(captureAppPage('shop@org', 'portal')).rejects.toThrow('App page capture returned no image');
  });
});
