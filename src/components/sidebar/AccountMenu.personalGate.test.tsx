// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { initLanguage } from '@/i18n';
import AccountMenu from './AccountMenu';

function renderMenu() {
  return render(<AccountMenu onEditProfile={() => {}} />, { wrapper: DesignSystemProvider });
}

// Menu items run once the menu has gone, from Radix's focus-scope timer.
async function flushMenuClose() {
  await act(() => vi.runOnlyPendingTimersAsync());
}

const mocks = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  account: {} as Record<string, unknown>,
  enterprise: {} as Record<string, unknown>,
  startEnterpriseLogin: vi.fn(),
  openAccountLogin: vi.fn(),
}));

// What this release ships: personal accounts off, so an enterprise build offers the organization sign-in alone.
vi.mock('@/config/featureGates', () => ({
  IS_ENTERPRISE_BUILD: true,
  IS_PERSONAL_ACCOUNT_ENABLED: false,
}));

vi.mock('@/core/enterprise/accountLogin', () => ({
  startEnterpriseAccountLogin: mocks.startEnterpriseLogin,
}));

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.settings),
}));

vi.mock('@/core/account/accountStore', () => ({
  useAccountStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.account),
}));

vi.mock('@/stores/enterpriseStore', () => ({
  useEnterpriseStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.enterprise),
}));

describe('AccountMenu while personal accounts are off', () => {
  beforeAll(() => {
    // happy-dom lacks the pointer-capture and scroll APIs Radix menus call.
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.releasePointerCapture ??= () => {};
    Element.prototype.scrollIntoView ??= () => {};
  });
  afterEach(() => { vi.useRealTimers(); });

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    initLanguage('zh-CN');
    mocks.openAccountLogin.mockReset();
    mocks.startEnterpriseLogin.mockReset();
    mocks.startEnterpriseLogin.mockResolvedValue('started');
    mocks.settings = {
      userAvatar: '',
      userNickname: '本地昵称',
      theme: 'light',
      setTheme: vi.fn(),
      language: 'zh-CN',
      setLanguage: vi.fn(),
      openSystemSettings: vi.fn(),
      openAccountLogin: mocks.openAccountLogin,
      updateInfo: null,
      updateChecking: false,
      updateDownloadProgress: null,
      updateInstalling: false,
      updaterUnsupported: false,
    };
    // Personal credentials left on disk must not read as a signed-in identity.
    mocks.account = {
      status: 'signed_in',
      account: {
        serverUrl: 'https://accounts.example.com',
        userId: 'user-1',
        kind: 'personal',
        name: '张三',
        email: 'zhangsan@example.com',
      },
      profileStatus: 'ready',
      signOut: vi.fn(),
    };
    mocks.enterprise = { mode: { kind: 'personal' }, unbind: vi.fn() };
  });

  it('offers the organization sign-in at the bottom, and no personal sign-in', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderMenu();
    await user.click(screen.getByRole('button', { name: '本地昵称' }));
    expect(screen.getByRole('menuitem', { name: '企业账号登录' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: '登录' })).not.toBeInTheDocument();
  });

  it('starts the organization sign-in directly, without the sign-in window', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderMenu();
    await user.click(screen.getByRole('button', { name: '本地昵称' }));
    await user.click(screen.getByRole('menuitem', { name: '企业账号登录' }));
    await flushMenuClose();
    expect(mocks.startEnterpriseLogin).toHaveBeenCalledOnce();
    expect(mocks.openAccountLogin).not.toHaveBeenCalled();
  });

  it('shows no identity and no personal actions for leftover personal credentials', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderMenu();
    await user.click(screen.getByRole('button', { name: '本地昵称' }));
    expect(screen.queryByText('zhangsan@example.com')).toBeNull();
    expect(screen.queryByRole('menuitem', { name: '账号设置' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: '退出个人账号' })).not.toBeInTheDocument();
  });
});
