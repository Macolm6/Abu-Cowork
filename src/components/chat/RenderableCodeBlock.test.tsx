// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, act, screen } from '@testing-library/react';
import { DesignSystemProvider } from '@/components/ds/provider';
import RenderableCodeBlock, { type CodeBlockRendererConfig } from './RenderableCodeBlock';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

// happy-dom has no ResizeObserver; the stub delivers one measurement on observe.
type ROCallback = () => void;
function stubResizeObserver(): void {
  vi.stubGlobal('ResizeObserver', class {
    private readonly callback: ROCallback;
    constructor(callback: ROCallback) { this.callback = callback; }
    observe() { this.callback(); }
    disconnect() {}
  });
}

function makeConfig(render: CodeBlockRendererConfig['render']): CodeBlockRendererConfig {
  return {
    label: 'diagram-test',
    fallbackLanguage: 'mermaid',
    render,
    debounceMs: 10,
    i18n: { loading: 'Rendering', renderError: 'Failed', expand: 'Expand', collapse: 'Collapse' },
  };
}

describe('RenderableCodeBlock bordered mode', () => {
  it('paints the diagram on the fixed diagram canvas', async () => {
    let target: HTMLDivElement | null = null;
    const config = makeConfig(async (_code, container) => {
      target = container;
      container.innerHTML = '<svg></svg>';
    });
    render(<DesignSystemProvider><RenderableCodeBlock code="graph TD; A-->B" config={config} /></DesignSystemProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(target).not.toBeNull();
    const canvas = (target as unknown as HTMLDivElement).parentElement?.parentElement;
    expect(canvas).toHaveClass('bg-diagram-canvas');
  });

  it('holds the height the block had last time while it renders again, and tells the height it renders at', async () => {
    stubResizeObserver();
    const code = 'graph TD; C-->D';
    const heights = new Map([[code, 322]]);
    let outer: HTMLElement | null = null;
    const config: CodeBlockRendererConfig = {
      ...makeConfig(async (_code, container) => {
        container.innerHTML = '<svg></svg>';
        outer = container.parentElement;
        const root = container.closest('.group\\/widget') as HTMLElement;
        vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({ height: 412 } as DOMRect);
      }),
      heightMemory: { recall: (c) => heights.get(c), remember: (c, height) => { heights.set(c, height); } },
    };
    const { container } = render(<DesignSystemProvider><RenderableCodeBlock code={code} config={config} /></DesignSystemProvider>);

    // While rendering: the box inside the border holds the remembered height,
    // so nothing below the block moves.
    const loading = container.querySelector('.invisible') as HTMLElement;
    expect(loading.style.minHeight).toBe('320px');

    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect((outer as HTMLElement | null)?.style.minHeight ?? '').toBe('');
    // The whole block, border included.
    expect(heights.get(code)).toBe(412);
  });

  it('holds the remembered height on the seamless loading box as well', () => {
    const code = '<div>widget</div>';
    const config: CodeBlockRendererConfig = {
      ...makeConfig(async () => {}),
      seamless: true,
      preview: { render: () => false },
      heightMemory: { recall: () => 1060 },
    };
    const { container } = render(<DesignSystemProvider><RenderableCodeBlock code={code} config={config} /></DesignSystemProvider>);
    const loading = container.querySelector('.bg-code') as HTMLElement;
    expect(loading.style.minHeight).toBe('1060px');
  });

  it('reserves nothing for a block shown for the first time', () => {
    const config: CodeBlockRendererConfig = { ...makeConfig(async () => {}), heightMemory: { recall: () => undefined } };
    const { container } = render(<DesignSystemProvider><RenderableCodeBlock code="graph TD; E-->F" config={config} /></DesignSystemProvider>);
    const loading = container.querySelector('.invisible') as HTMLElement;
    expect(loading.style.minHeight).toBe('');
  });

  it('keeps the reset-zoom button at the button text size', async () => {
    const config = makeConfig(async (_code, container) => { container.innerHTML = '<svg></svg>'; });
    render(<DesignSystemProvider><RenderableCodeBlock code="graph TD; B-->C" config={config} /></DesignSystemProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    const reset = screen.getByRole('button', { name: '100%' });
    expect(reset).toHaveClass('text-ui-sm');
    expect(reset).not.toHaveClass('text-caption');
  });
});
