// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { initLanguage } from '@/i18n';
import { useAppStore } from '@/stores/appStore';
import { DEFAULT_APP_CONFIG } from '@/data/defaultAppConfig';
import type { ConversationAppBinding } from '@/types/app';
import ConversationAppNotice from './ConversationAppNotice';

const binding = (origin: ConversationAppBinding['origin'], appId = 'contract@lawyer'): ConversationAppBinding => ({
  version: 2, appId, appVersion: '1.0.0', origin, appName: '合同审阅', modeId: 'm',
});

beforeEach(() => {
  initLanguage('zh-CN');
  useAppStore.setState({ addedApps: [], managedApps: {} });
});
afterEach(() => {
  cleanup();
  useAppStore.setState({ addedApps: [], managedApps: {} });
});

describe('ConversationAppNotice', () => {
  it('says nothing while the app is still there', () => {
    useAppStore.setState({ addedApps: [{ appId: 'contract@lawyer', name: '合同审阅', config: DEFAULT_APP_CONFIG, version: '1.0.0', origin: { kind: 'market', market: 'lawyer' }, plugins: [] }] });
    render(<ConversationAppNotice binding={binding('market')} />);
    expect(screen.queryByTestId('conversation-app-removed')).toBeNull();
  });

  it('offers 去添加 for an app from a market or a folder', () => {
    render(<ConversationAppNotice binding={binding('folder')} />);
    expect(screen.getByText('这个会话所属的应用「合同审阅」已移除，重新添加以后可以继续')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '去添加' })).toBeInTheDocument();
  });

  it('only says removed for an app the user made, since nothing can add it back', () => {
    render(<ConversationAppNotice binding={binding('created', 'weekly@mine')} />);
    expect(screen.getByText('这个会话所属的应用「合同审阅」已移除')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '去添加' })).toBeNull();
  });

  it('asks the user to sign in for a conversation belonging to an organization', () => {
    render(<ConversationAppNotice binding={binding('enterprise', 'enterprise-app:1')} />);
    expect(screen.getByText('登录组织账号后可以继续使用这个应用')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '去添加' })).toBeNull();
  });
});
