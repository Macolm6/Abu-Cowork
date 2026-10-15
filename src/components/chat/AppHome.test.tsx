// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { agentRegistry } from '@/core/agent/registry';
import { redactFailureText } from '@/core/diagnostic/scrub';
import { DEFAULT_APP_CONFIG } from '@/data/defaultAppConfig';
import { format, getI18n } from '@/i18n';
import * as appRefs from '@/core/app/appRefs';
import type { AppDefinition } from '@/types/app';
import { useAppStore } from '@/stores/appStore';
import { useChatStore } from '@/stores/chatStore';
import { useTeamStore } from '@/stores/teamStore';
import { clearAllComposerDrafts } from '@/stores/composerDraftStore';
import { prepareExpertEntry } from '@/core/team/expertEntry';
import { createAppDraft } from '@/core/app/appDraft';
import AppHome, { AppHomeScenes } from './AppHome';

const app: AppDefinition = {
  appId: 'shop@local', name: 'Shop', version: '1.0.0', origin: { kind: 'folder', dir: '/shop' }, plugins: [],
  config: {
    version: 1,
    defaultRun: { team: 'mine:default-team' },
    home: { modes: { items: [{ modeId: 'daily', title: 'Daily', scenes: [
      { id: 'review', title: 'Review', run: { team: 'mine:chosen-team' }, templates: [] },
    ] }] } },
  },
};
const onPlaceholderChange = () => {};

beforeEach(() => {
  clearAllComposerDrafts();
  useChatStore.setState({ activeConversationId: null, conversations: {}, conversationIndex: {}, pendingTeamId: undefined, pendingOwnerSource: undefined,
    pendingAgentName: null, pendingAppBinding: undefined, pendingExpertContact: null, pendingReferences: [], pendingAttachmentRequests: [] });
  useAppStore.setState({ selectedAppId: app.appId, selectedModeIdByApp: {}, expandedSceneIdByApp: {}, dismissedConnectorHintByApp: {} });
  useTeamStore.setState({ teams: ['default-team', 'chosen-team'].map((id) => ({
    id, name: id, leaderRoleId: 'builtin:analyst', memberRoleIds: ['builtin:analyst'], createdAt: 0,
  })), managedTeamSources: {} });
});
afterEach(cleanup);

describe('app home conversation routing', () => {
  it('resolves the default team when its directory arrives after the home', () => {
    const teams = useTeamStore.getState().teams;
    useTeamStore.setState({ teams: [] });
    render(<AppHome app={app} onPlaceholderChange={onPlaceholderChange} />);
    expect(useChatStore.getState().pendingTeamId).toBeUndefined();
    act(() => { useTeamStore.setState({ teams }); });
    expect(useChatStore.getState().pendingTeamId).toBe('default-team');
  });

  it('refreshes the app snapshot while preserving an explicitly chosen team', () => {
    const view = render(<AppHome app={app} onPlaceholderChange={onPlaceholderChange} />);
    act(() => { useChatStore.getState().setPendingTeamId('chosen-team'); });
    const updated = { ...app, version: '2.0.0', config: { ...app.config, promptAppend: 'Updated guidance', defaultRun: { team: 'mine:chosen-team' } } };
    view.rerender(<AppHome app={updated} onPlaceholderChange={onPlaceholderChange} />);
    expect(useChatStore.getState().pendingTeamId).toBe('chosen-team');
    expect(useChatStore.getState().pendingAppBinding?.appVersion).toBe('2.0.0');
    expect(useChatStore.getState().pendingAppBinding?.promptAppend).toBe('Updated guidance');
    expect(useChatStore.getState().pendingAppBinding?.run).toEqual(updated.config.defaultRun);
  });

  it('keeps an explicitly cleared team when its directory arrives later', () => {
    const teams = useTeamStore.getState().teams;
    useTeamStore.setState({ teams: [] });
    render(<AppHome app={app} onPlaceholderChange={onPlaceholderChange} />);
    act(() => { useChatStore.getState().setPendingTeamId(undefined); });
    act(() => { useTeamStore.setState({ teams }); });
    expect(useChatStore.getState().pendingTeamId).toBeUndefined();
  });

  it('keeps an expert selected before the default team directory arrives', () => {
    const teams = useTeamStore.getState().teams;
    useTeamStore.setState({ teams: [] });
    render(<AppHome app={app} onPlaceholderChange={onPlaceholderChange} />);
    act(() => { useChatStore.getState().setPendingAgent('analyst'); });
    act(() => { useTeamStore.setState({ teams }); });
    expect(useChatStore.getState().pendingTeamId).toBeUndefined();
    expect(useChatStore.getState().pendingAgentName).toBe('analyst');
  });

  it('keeps a team chosen from its detail when the home mounts', () => {
    prepareExpertEntry({ identity: { key: 'team:chosen-team', kind: 'team', name: 'Chosen' } });
    render(<AppHome app={app} onPlaceholderChange={onPlaceholderChange} />);
    expect(useChatStore.getState().pendingTeamId).toBe('chosen-team');
    expect(useChatStore.getState().pendingAppBinding?.appId).toBe('shop@local');
  });

  it('keeps an expert chosen from its detail without assigning the default team', () => {
    prepareExpertEntry({ identity: { key: 'agent:role:analyst', kind: 'agent', name: 'Analyst', agentName: 'analyst' } });
    render(<AppHome app={app} onPlaceholderChange={onPlaceholderChange} />);
    expect(useChatStore.getState().pendingTeamId).toBeUndefined();
    expect(useChatStore.getState().pendingAgentName).toBe('analyst');
  });

  it('keeps the chosen team when a catalog refresh replaces the app object', () => {
    const view = render(<AppHome app={app} onPlaceholderChange={onPlaceholderChange} />);
    act(() => { useChatStore.getState().setPendingTeamId('chosen-team'); });
    view.rerender(<AppHome app={structuredClone(app)} onPlaceholderChange={onPlaceholderChange} />);
    expect(useChatStore.getState().pendingTeamId).toBe('chosen-team');
  });

  it('keeps a removed team selection when the home mounts again', () => {
    const view = render(<AppHome app={app} onPlaceholderChange={onPlaceholderChange} />);
    act(() => { useChatStore.getState().setPendingTeamId(undefined); });
    view.unmount();
    render(<AppHome app={app} onPlaceholderChange={onPlaceholderChange} />);
    expect(useChatStore.getState().pendingTeamId).toBeUndefined();
  });

  it('restores the default for a new task while the home is already visible', () => {
    render(<AppHome app={app} onPlaceholderChange={onPlaceholderChange} />);
    act(() => { useChatStore.getState().setPendingTeamId('chosen-team'); });
    act(() => { useChatStore.getState().startNewConversation(); });
    expect(useChatStore.getState().pendingTeamId).toBe('default-team');
    expect(useChatStore.getState().pendingAppBinding?.appId).toBe('shop@local');
  });

  it('uses the default when the user selects a different scene', () => {
    render(<AppHome app={app} onPlaceholderChange={onPlaceholderChange} />);
    act(() => { useChatStore.getState().setPendingTeamId('chosen-team'); });
    act(() => { useAppStore.getState().setExpandedScene(app.appId, 'review'); });
    expect(useChatStore.getState().pendingTeamId).toBe('default-team');
    expect(useChatStore.getState().pendingAppBinding?.sceneId).toBe('review');
  });

  it('creates an app in a conversation with its own routing', async () => {
    render(<AppHome app={app} onPlaceholderChange={onPlaceholderChange} />);
    await act(async () => { await createAppDraft({ leaveApp: true }); });
    const chat = useChatStore.getState();
    const conversation = chat.conversations[chat.activeConversationId!];
    expect(conversation.teamId).toBeUndefined();
    expect(conversation.appBinding).toBeUndefined();
  });
});
const templates = [
  { id: 'reply', title: '回复买家', prompt: '帮我回复这位买家：' },
  { id: 'refund', title: '处理退款', prompt: '帮我处理这笔退款：' },
  { id: 'review', title: '回应差评', prompt: '帮我回应这条差评：' },
];
const shop: AppDefinition = {
  appId: 'enterprise-app:shop', name: '店铺运营', version: '1.0.0', origin: { kind: 'enterprise' }, plugins: [],
  config: {
    ...DEFAULT_APP_CONFIG,
    home: { modes: { items: [{ modeId: 'service', title: '客服', scenes: [{ id: 'support', title: '客服回复', run: { expert: 'enterprise:support' }, templates }] }] } },
  },
};
const HOST_REASON = 'GET https://console.example.test/api/skills?token=abc123secret answered 403';

describe('AppHomeScenes', () => {
  beforeEach(() => {
    vi.spyOn(appRefs, 'resolveRun').mockReturnValue({ owner: { status: 'needs-preparation', roleIds: ['enterprise:support'], label: '客服专家' } });
    useAppStore.setState({ expandedSceneIdByApp: { [shop.appId]: 'support' }, selectedModeIdByApp: {} });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useAppStore.setState({ expandedSceneIdByApp: {}, selectedModeIdByApp: {} });
  });

  describe('a scene whose organization expert cannot be set up', () => {
    it('says so in plain words with what to do, and sends the host\'s reason to the console only', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const prepare = vi.spyOn(agentRegistry, 'prepareManagedAgent').mockRejectedValue(new Error(HOST_REASON));
      render(<AppHomeScenes app={shop} visible />, { wrapper: DesignSystemProvider });

      fireEvent.click(screen.getByTestId('app-home-template-reply'));

      const status = await screen.findByTestId('app-home-preparing');
      await waitFor(() => expect(status).toHaveAttribute('data-state', 'failed'));
      expect(status).toHaveTextContent(format(getI18n().appHome.scenePrepareFailed, { name: '客服专家' }));
      expect(status.textContent).toBe(format(getI18n().appHome.scenePrepareFailed, { name: '客服专家' }));
      expect(document.body.innerHTML).not.toContain('console.example.test');
      expect(prepare).toHaveBeenCalledExactlyOnceWith('enterprise:support');
      expect(redactFailureText(HOST_REASON)).not.toContain('abc123secret');
      expect(warn).toHaveBeenCalledExactlyOnceWith('[app] prepare scene failed:', redactFailureText(HOST_REASON));
    });
  });
});
