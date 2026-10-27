// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getLanguageSetting, initLanguage, type LanguageSetting } from '@/i18n';
import type { ModelDeclaredCapabilities } from '@/types/provider';
import AdvancedCapabilitiesFields from './AdvancedCapabilitiesFields';

function Harness({ detected, estimated }: { detected?: number; estimated: number }) {
  const [declared, setDeclared] = useState<ModelDeclaredCapabilities>({});
  return (
    <>
      <AdvancedCapabilitiesFields
        declared={declared}
        setDeclared={setDeclared}
        apiFormat="openai-compatible"
        contextWindow={{
          size: Math.min(detected ?? estimated, 200000),
          uncappedSize: detected ?? estimated,
          source: detected === undefined ? 'estimate' : 'service',
        }}
      />
      <output data-testid="context-length">{declared.maxInputTokens ?? ''}</output>
    </>
  );
}

describe('AdvancedCapabilitiesFields', () => {
  let previous: LanguageSetting;

  beforeEach(() => {
    previous = getLanguageSetting();
    initLanguage('zh-CN');
  });

  afterEach(() => {
    cleanup();
    initLanguage(previous);
  });

  it('names the field 上下文长度 and explains it', () => {
    render(<Harness estimated={32768} />);
    expect(screen.getByText('上下文长度')).toBeInTheDocument();
    expect(screen.getByText('阿布每次处理的内容上限')).toBeInTheDocument();
  });

  it('names the 能看图 checkbox so it can be found by its label', async () => {
    render(<Harness estimated={32768} />);
    const canSeeImages = screen.getByRole('checkbox', { name: '能看图' });
    expect(canSeeImages).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(canSeeImages);
    expect(canSeeImages).toHaveAttribute('aria-checked', 'true');
  });

  it('shows the length the service reported', () => {
    render(<Harness detected={8192} estimated={32768} />);
    expect(screen.getByText('模型支持 8K')).toBeInTheDocument();
    expect(screen.getByText('当前使用 8K（默认）')).toBeInTheDocument();
  });

  it('says what blank means when nothing was reported', () => {
    render(<Harness estimated={32768} />);
    expect(screen.getByPlaceholderText('留空使用 32K')).toBeInTheDocument();
    expect(screen.getByText('估计支持 32K')).toBeInTheDocument();
    expect(screen.getByText('当前使用 32K（默认）')).toBeInTheDocument();
  });

  it('offers 8K and 16K and takes the picked value', async () => {
    render(<Harness estimated={32768} />);
    // Output presets share these labels; scope the lookup to the context field.
    const field = within(screen.getByText('上下文长度').parentElement as HTMLElement);
    expect(field.getAllByRole('button').map((button) => button.textContent))
      .toEqual(['8K', '16K', '32K', '64K', '128K', '256K', '1M']);
    await userEvent.click(field.getByRole('button', { name: '8K' }));
    expect(screen.getByTestId('context-length')).toHaveTextContent('8192');
    await userEvent.click(field.getByRole('button', { name: '16K' }));
    expect(screen.getByTestId('context-length')).toHaveTextContent('16384');
  });

  it('keeps model capacity visible when choosing 1M and clearing back to the default', async () => {
    render(<Harness detected={1_000_000} estimated={32768} />);
    const input = screen.getByRole('textbox', { name: '上下文长度' });
    const preset = screen.getByRole('button', { name: '1M' });
    expect(input).toHaveAccessibleDescription('阿布每次处理的内容上限 模型支持 1M 当前使用 200K（默认）');
    expect(input).toHaveValue('');
    expect(preset).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(preset);
    expect(input).toHaveValue('1000000');
    expect(preset).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('模型支持 1M')).toBeInTheDocument();
    expect(screen.getByText('当前使用 1M')).toBeInTheDocument();
    expect(screen.queryByText('当前使用 200K（默认）')).not.toBeInTheDocument();
    await userEvent.clear(input);
    expect(screen.getByText('当前使用 200K（默认）')).toBeInTheDocument();
    expect(preset).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows an uncapped estimate alongside the default and updates after switching models', () => {
    const { rerender } = render(<Harness estimated={1_000_000} />);
    expect(screen.getByText('估计支持 1M')).toBeInTheDocument();
    expect(screen.getByText('当前使用 200K（默认）')).toBeInTheDocument();
    rerender(<Harness estimated={128000} />);
    expect(screen.getByText('估计支持 128K')).toBeInTheDocument();
    expect(screen.getByText('当前使用 128K（默认）')).toBeInTheDocument();
    expect(screen.queryByText(/200K/)).not.toBeInTheDocument();
  });

  it('follows manual input with the same positive integer rule as the runtime', () => {
    render(<Harness detected={1_000_000} estimated={32768} />);
    const input = screen.getByRole('textbox', { name: '上下文长度' });
    fireEvent.change(input, { target: { value: '500000' } });
    expect(screen.getByText('当前使用 500K')).toBeInTheDocument();
    expect(screen.getByText('模型支持 1M')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1M' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.change(input, { target: { value: '1' } });
    expect(screen.getByText('当前使用 1')).toBeInTheDocument();
    fireEvent.change(input, { target: { value: '0' } });
    expect(screen.getByText('当前使用 200K（默认）')).toBeInTheDocument();
    fireEvent.change(input, { target: { value: '9007199254740992' } });
    expect(screen.getByText('当前使用 200K（默认）')).toBeInTheDocument();
  });

  it('labels the image checkbox 能看图 with its explanation', () => {
    render(<Harness estimated={32768} />);
    expect(screen.getByText('能看图')).toBeInTheDocument();
    expect(screen.getByText('模型能识别图片和屏幕截图')).toBeInTheDocument();
  });

  it('ties the explanation to the 能看图 checkbox, and to no other checkbox', () => {
    render(<Harness estimated={32768} />);
    expect(screen.getByRole('checkbox', { name: '能看图' })).toHaveAccessibleDescription('模型能识别图片和屏幕截图');
    expect(screen.getByRole('checkbox', { name: '工具调用' })).not.toHaveAttribute('aria-describedby');
  });
});
