// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppDefinition } from '@/types/app';
import { useAppStore } from '@/stores/appStore';
import { useChatStore } from '@/stores/chatStore';
import { useTeamStore } from '@/stores/teamStore';
import { clearAllComposerDrafts } from '@/stores/composerDraftStore';
import { prepareExpertEntry } from '@/core/team/expertEntry';
import { createAppDraft } from '@/core/app/appDraft';
import AppHome from './AppHome';

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
    await act(async () => { await createAppDraft(); });
    const chat = useChatStore.getState();
    const conversation = chat.conversations[chat.activeConversationId!];
    expect(conversation.teamId).toBeUndefined();
    expect(conversation.appBinding).toBeUndefined();
  });
});
