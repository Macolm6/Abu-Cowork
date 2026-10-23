// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import LoginPage from './LoginPage';

// What this release ships: personal accounts off, so an enterprise build offers the organization sign-in alone.
vi.mock('@/config/featureGates', () => ({
  IS_ENTERPRISE_BUILD: true,
  IS_PERSONAL_ACCOUNT_ENABLED: false,
}));

const noop = () => {};

describe('LoginPage while personal accounts are off', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
  });

  it('offers the organization sign-in as the one way in, filled', () => {
    render(
      <LoginPage
        status="signed_out"
        error={null}
        hasAccount={false}
        onPersonalLogin={noop}
        onEnterpriseLogin={noop}
        onCancel={noop}
        onSignOut={noop}
      />,
    );
    expect(screen.queryByRole('button', { name: '个人账号登录' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '企业账号登录' })).toHaveClass('bg-emphasis');
  });

  it('still says that Abu works without signing in', () => {
    render(
      <LoginPage
        status="signed_out"
        error={null}
        hasAccount={false}
        onPersonalLogin={noop}
        onEnterpriseLogin={noop}
        onCancel={noop}
        onSignOut={noop}
      />,
    );
    expect(screen.getByText('不登录也能继续使用本地模型和自己的 API Key')).toBeInTheDocument();
  });

  it('offers no personal sign-in after a session has expired either', () => {
    render(
      <LoginPage
        status="expired"
        error="session_expired"
        hasAccount
        onPersonalLogin={noop}
        onEnterpriseLogin={noop}
        onCancel={noop}
        onSignOut={noop}
      />,
    );
    expect(screen.queryByRole('button', { name: '重新登录' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '企业账号登录' })).toBeInTheDocument();
  });
});
