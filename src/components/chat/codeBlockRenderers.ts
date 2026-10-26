/**
 * Code Block Renderer Registry
 *
 * Decouples MarkdownRenderer from specific visualization libraries.
 *
 * Architecture:
 * - Built-in DSL formats (mermaid) use dedicated renderers for best quality
 *   (bundled library, no CDN, no iframe overhead, proper streaming handling)
 * - html/svg use HtmlWidgetBlock (iframe sandbox)
 * - User-created skills should output ```html code blocks with any CDN library
 *   — HtmlWidgetBlock handles them directly, no frontend changes needed.
 *
 * To add a new renderable code block type:
 * 1. Create a renderer component with props { code: string }
 * 2. Register it here with registerCodeBlockRenderer('language', ...)
 * 3. (Optional) Create a corresponding skill in builtin-skills/ to guide LLM output
 *
 * MarkdownRenderer will automatically pick it up — no changes needed there.
 */
import { lazy, type ComponentType } from 'react';
import { recallDiagramHeight, recallWidgetHeight } from '@/stores/renderMemoryStore';
import { wrapSvgAsHtml } from './transforms';

export interface CodeBlockRenderer {
  /** Lazy-loaded component that renders the code block */
  component: React.LazyExoticComponent<ComponentType<{ code: string }>>;
  /**
   * The height the block had when this code was last shown, or undefined. The
   * box shown while the component loads takes it, so a block that loads after
   * the message is painted moves nothing below it.
   */
  recallHeight?: (code: string) => number | undefined;
}

const registry = new Map<string, CodeBlockRenderer>();

/**
 * Register a code block renderer for a specific language.
 * The component should accept { code: string } props.
 */
export function registerCodeBlockRenderer(
  language: string,
  component: React.LazyExoticComponent<ComponentType<{ code: string }>>,
  recallHeight?: (code: string) => number | undefined,
) {
  registry.set(language, { component, ...(recallHeight ? { recallHeight } : {}) });
}

/** Look up a renderer for a code block language */
export function getCodeBlockRenderer(language: string): CodeBlockRenderer | undefined {
  return registry.get(language);
}

// --- Built-in registrations ---

// Mermaid: dedicated renderer (bundled library, no CDN, proper streaming)
registerCodeBlockRenderer(
  'mermaid',
  lazy(() => import('./MermaidBlock')),
  (code) => recallDiagramHeight('mermaid', code),
);

// HTML widget: iframe sandbox, streaming preview, user-extensible via skills
registerCodeBlockRenderer(
  'html',
  lazy(() => import('./HtmlWidgetBlock')),
  recallWidgetHeight,
);

// SVG: thin wrapper → HtmlWidgetBlock (no scripts needed, just CSS)
registerCodeBlockRenderer(
  'svg',
  lazy(() => import('./SvgHtmlBlock')),
  (code) => recallWidgetHeight(wrapSvgAsHtml(code)),
);

