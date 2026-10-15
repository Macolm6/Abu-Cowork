// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { homeDir } from '@tauri-apps/api/path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { getI18n } from '@/i18n';
import { useAppStore } from '@/stores/appStore';
import { useAppAddFlowStore } from '@/stores/appAddFlowStore';
import { usePluginStore } from '@/stores/pluginStore';
import AppMarketDialog from './AppMarketDialog';

beforeEach(() => {
  useAppStore.setState({ appMarketOpen: true, addedApps: [] });
  useAppAddFlowStore.setState({ flow: { kind: 'closed' } });
  usePluginStore.setState({ marketplaces: [], installed: [] });
  vi.mocked(homeDir).mockResolvedValue('/Users/testuser');
});
afterEach(() => vi.unstubAllGlobals());

describe('application market bootstrap failures', () => {
  it.each(['home', 'operation'] as const)('shows a retry after %s access fails and reads again', async (boundary) => {
    let failed = true;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    if (boundary === 'home') {
      vi.mocked(homeDir).mockImplementation(async () => {
        if (failed) throw new Error('EACCES /private/home');
        await pending;
        return '/Users/testuser';
      });
    } else {
      vi.stubGlobal('__ABU_SHELL__', {
        pluginRegistry: async (action: string) => {
          if (action !== 'read') throw new Error(`Unexpected registry action: ${action}`);
          return null;
        },
        pluginOperation: async () => {
          if (failed) throw new Error('IPC unavailable');
          await pending;
          return null;
        },
      });
    }
    render(<AppMarketDialog />, { wrapper: DesignSystemProvider });
    const error = await screen.findByRole('alert');
    expect(error).toHaveTextContent(getI18n().appSwitcher.fileAccessFailed);
    expect(error).not.toHaveTextContent('/private/home');
    failed = false;
    const retry = screen.getByRole('button', { name: getI18n().common.retry });
    retry.focus();
    fireEvent.click(retry);
    await waitFor(() => expect(retry).toHaveAttribute('aria-disabled', 'true'));
    expect(retry).toHaveFocus();
    await act(async () => { finish(); });
    await screen.findByTestId('app-market-empty');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('app-market-search')).toHaveFocus();
  });
});
