/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { DesignSystemProvider } from '@/components/ds/provider';
import { useRenderMemoryStore } from '@/stores/renderMemoryStore';
import HtmlWidgetBlock, { buildFullHtml, buildReceiverHtml } from './HtmlWidgetBlock';

describe('buildReceiverHtml — initial theme stamp (P3)', () => {
  it('stamps class="dark" on <body> when isDark is true (avoids first-paint flash)', () => {
    const html = buildReceiverHtml(true);
    expect(html).toContain('<body class="dark">');
  });

  it('leaves <body> without a dark class when isDark is false', () => {
    const html = buildReceiverHtml(false);
    expect(html).toContain('<body>');
    expect(html).not.toContain('<body class="dark">');
  });

  it('still wires the P3 receiver-side globals (sendPrompt, onerror, unhandledrejection)', () => {
    const html = buildReceiverHtml(false);
    expect(html).toContain('window.sendPrompt');
    expect(html).toContain('window.onerror');
    expect(html).toContain('unhandledrejection');
  });

  it('records errors and only posts widget:error inside the blank-fallback path (C2 — no eager posting)', () => {
    const html = buildReceiverHtml(false);
    // Error handlers record into abuCapturedError rather than posting eagerly.
    expect(html).toContain('abuCapturedError');
    expect(html).toContain('abuRecordErr');
    // The only widget:error post sits behind the abuApplyBlankFallback() guard.
    const blankIdx = html.indexOf('abuApplyBlankFallback()');
    const errorPostIdx = html.indexOf("type:'widget:error'");
    expect(blankIdx).toBeGreaterThan(-1);
    expect(errorPostIdx).toBeGreaterThan(blankIdx);
  });
});

describe('buildReceiverHtml — height reports', () => {
  it('reports the height of the content and never the scroll height of the root', () => {
    const html = buildReceiverHtml(false);
    expect(html).toContain('var h=abuContentHeight();');
    expect(html).not.toContain('document.documentElement.scrollHeight');
  });

  it('measures again when the size of the content changes', () => {
    expect(buildReceiverHtml(false)).toContain('new ResizeObserver(reportHeight).observe(document.body);');
  });
});

describe('buildFullHtml — fullscreen wrapper', () => {
  it('injects the design system into the FRAGMENT-wrap branch', () => {
    // A widget styled inline with .w-*/--w-* must render identically
    // fullscreen — the wrap has to ship the same design CSS as RECEIVER_HTML.
    const html = buildFullHtml('<div class="w-card">hi</div>', false);
    expect(html).toContain('.w-card {');
    expect(html).toContain('--w-primary:');
  });

  it('leaves the full-DOCUMENT passthrough branch alone (author owns styling)', () => {
    // Complete documents render verbatim; our classes don't apply there, so we
    // must NOT inject the design system into them.
    const doc = '<!DOCTYPE html><html><head></head><body><p>x</p></body></html>';
    const out = buildFullHtml(doc, false);
    expect(out).not.toContain('.w-card {');
    expect(out).not.toContain('--w-primary:');
  });

  // The enlarged fragment follows the appearance through the same class as the inline frame.
  it('stamps the dark class on the body of an enlarged fragment in the dark appearance', () => {
    expect(buildFullHtml('<p>fixture widget</p>', true)).toContain('<body class="dark"><div class="abu-fs-center">');
  });

  it('leaves the body of an enlarged fragment without the class in the light appearance', () => {
    const html = buildFullHtml('<p>fixture widget</p>', false);
    expect(html).toContain('<body><div class="abu-fs-center">');
    expect(html).not.toContain('class="dark"');
  });

  it('hands a complete document on unchanged in either appearance', () => {
    const doc = '<!DOCTYPE html><html><head></head><body><p>x</p></body></html>';
    expect(buildFullHtml(doc, true)).toBe(doc);
    expect(buildFullHtml(doc, false)).toBe(doc);
  });
});

// The frame is a document of its own: a variable of the host page does not exist in it. The base
// styles give the frame's own variables (the names widget authors use) literal values, light by
// default and dark under the `dark` class the host stamps on <body>.
describe.each([
  ['the inline frame', () => buildReceiverHtml(false)],
  ['the enlarged fragment', () => buildFullHtml('<p>fixture widget</p>', false)],
])('base styles of %s', (_name, build) => {
  // The page color and the text color of the frame come from the kit's variables (`--w-bg`,
  // `--w-fg`), which follow the appearance; no second rule gives the body a color.
  it('color the body in one rule, from the kit', () => {
    const colored = [...build().matchAll(/(?:^|[\s}])body\s*\{([^}]*)\}/g)]
      .map((match) => match[1].trim())
      .filter((declarations) => /(?:^|[;\s])(?:color|background)\s*:/.test(declarations));
    expect(colored).toEqual(['background: var(--w-bg); color: var(--w-fg);']);
  });

  it('do not read the text color of the host page', () => {
    expect(build()).not.toContain('var(--abu-text-primary)');
  });

  it('do not read the accent color of the host page', () => {
    expect(build()).not.toContain('var(--abu-clay)');
  });

  it('do not read the muted fill of the host page', () => {
    expect(build()).not.toContain('var(--abu-bg-muted)');
  });

  it('do not read the pressed fill of the host page', () => {
    expect(build()).not.toContain('var(--abu-bg-pressed)');
  });

  it('do not define a variable through itself', () => {
    expect(build()).not.toContain('--abu-text-muted: var(--abu-text-muted)');
  });

  it('keep every variable name widget authors use, with the light values', () => {
    const html = build();
    expect(html).toContain('--abu-primary: #0a84ff;');
    expect(html).toContain('--abu-text: #1d1d1f;');
    expect(html).toContain('--abu-text-muted: #66666b;');
    expect(html).toContain('--abu-bg: #fff;');
    expect(html).toContain('--abu-bg-secondary: #f5f5f7;');
    expect(html).toContain('--abu-border: rgba(0, 0, 0, 0.14);');
    expect(html).toContain('--abu-font: system-ui, -apple-system, sans-serif;');
  });

  it('give the same names the dark values under the dark class', () => {
    const dark = /\.dark \{([^}]*--abu-primary:[^}]*)\}/.exec(build())?.[1] ?? '';
    expect(dark).toContain('--abu-primary: #409cff;');
    expect(dark).toContain('--abu-text: #f5f5f7;');
    expect(dark).toContain('--abu-text-muted: #98989d;');
    expect(dark).toContain('--abu-bg: #1c1c1e;');
    expect(dark).toContain('--abu-bg-secondary: #2a2a2d;');
    expect(dark).toContain('--abu-border: rgba(255, 255, 255, 0.16);');
  });

  it('still draw buttons and sliders from those names', () => {
    const html = build();
    expect(html).toContain('border: 1px solid var(--abu-border); border-radius: 6px;');
    expect(html).toContain('background: var(--abu-bg); color: var(--abu-text);');
    expect(html).toContain('button:hover { background: var(--abu-bg-secondary); }');
    expect(html).toContain('input[type="range"] { accent-color: var(--abu-primary); }');
  });
});

describe('the inline frame', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useRenderMemoryStore.setState({ widgetHeights: {} });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    document.documentElement.classList.remove('dark');
  });

  // Each case has its own code: the block keeps the heights it saw per code for the whole run.
  async function renderWidget(code = '<p>fixture widget</p>') {
    render(<DesignSystemProvider><HtmlWidgetBlock code={code} /></DesignSystemProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    return document.querySelector('iframe')!;
  }

  it('may run scripts and nothing else', async () => {
    const frame = await renderWidget();
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
  });

  it('is stamped light while the host page is light', async () => {
    const frame = await renderWidget();
    expect(frame.srcdoc).toBe(buildReceiverHtml(false));
  });

  it('is stamped dark while the host page carries the dark class', async () => {
    document.documentElement.classList.add('dark');
    const frame = await renderWidget();
    expect(frame.srcdoc).toBe(buildReceiverHtml(true));
  });

  it('keeps its content policy', async () => {
    const frame = await renderWidget();
    expect(frame.srcdoc).toContain("default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com");
  });

  function report(frame: HTMLIFrameElement, height: number): void {
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'abu-widget-resize', height, first: false },
        source: frame.contentWindow,
      }));
    });
  }

  it('opens at the height it had in an earlier launch', async () => {
    useRenderMemoryStore.getState().rememberWidgetHeight('<p>remembered widget</p>', 1664);
    const frame = await renderWidget('<p>remembered widget</p>');
    expect(frame.style.height).toBe('1664px');
  });

  it('holds a smaller report for a moment after opening at a known height, and takes a larger one at once', async () => {
    useRenderMemoryStore.getState().rememberWidgetHeight('<p>held widget</p>', 1664);
    const frame = await renderWidget('<p>held widget</p>');

    // The document before its scripts have drawn: not yet.
    report(frame, 32);
    expect(frame.style.height).toBe('1664px');
    // The drawn document: at once.
    report(frame, 1700);
    expect(frame.style.height).toBe('1700px');
    // A smaller report with no larger one after it lands once the moment has passed.
    report(frame, 900);
    expect(frame.style.height).toBe('1700px');
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    expect(frame.style.height).toBe('900px');
  });

  it('takes every report at once when it opened at the default height', async () => {
    const frame = await renderWidget('<p>new widget</p>');
    expect(frame.style.height).toBe('60px');
    report(frame, 32);
    expect(frame.style.height).toBe('32px');
  });

  it('remembers the reported height a moment after the last report', async () => {
    const frame = await renderWidget('<p>reporting widget</p>');
    report(frame, 300);
    report(frame, 420);
    expect(useRenderMemoryStore.getState().widgetHeights['<p>reporting widget</p>']).toBeUndefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(useRenderMemoryStore.getState().widgetHeights['<p>reporting widget</p>']).toBe(420);
  });
});
