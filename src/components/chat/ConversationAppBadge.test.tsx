// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { initLanguage } from '@/i18n';
import type { ConversationAppBinding } from '@/types/app';
import ConversationAppBadge from './ConversationAppBadge';

const binding = (appName: ConversationAppBinding['appName']): ConversationAppBinding => ({
  version: 2, appId: 'recruiting@abu-official', appVersion: '1.0.0', origin: 'market', appName, modeId: 'prepare',
});

afterEach(() => {
  cleanup();
  initLanguage('system');
});

describe('ConversationAppBadge', () => {
  it('shows a name given per locale in the interface language', () => {
    const name = { 'zh-CN': '招聘', 'en-US': 'Recruiting' };
    initLanguage('en-US');
    const english = render(<ConversationAppBadge binding={binding(name)} />);
    expect(screen.getByTestId('chat-title-app-badge')).toHaveTextContent('Recruiting');
    expect(screen.getByTestId('chat-title-app-badge')).toHaveAttribute('title', 'Recruiting');
    english.unmount();

    initLanguage('zh-CN');
    render(<ConversationAppBadge binding={binding(name)} />);
    expect(screen.getByTestId('chat-title-app-badge')).toHaveTextContent('招聘');
    expect(screen.getByTestId('chat-title-app-badge')).toHaveAttribute('title', '招聘');
  });

  it('shows the name of a conversation saved with one string as that string', () => {
    initLanguage('en-US');
    render(<ConversationAppBadge binding={binding('招聘')} />);
    expect(screen.getByTestId('chat-title-app-badge')).toHaveTextContent('招聘');
    expect(screen.getByTestId('chat-title-app-badge')).toHaveAttribute('title', '招聘');
  });
});
