// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  IMAGE_SIZES_LIMIT,
  WIDGET_HEIGHTS_LIMIT,
  diagramHeightKey,
  useRenderMemoryStore,
} from './renderMemoryStore';

describe('renderMemoryStore', () => {
  beforeEach(() => {
    useRenderMemoryStore.setState({ imageSizes: {}, widgetHeights: {}, diagramHeights: {}, presentFiles: {} });
    localStorage.removeItem('abu-render-memory');
  });

  it('remembers an image size and gives it back', () => {
    useRenderMemoryStore.getState().rememberImageSize('/ws/chart.png', { w: 800, h: 600 });
    expect(useRenderMemoryStore.getState().imageSizes['/ws/chart.png']).toEqual({ w: 800, h: 600 });
  });

  it('writes nothing when the value is the one it holds', () => {
    const store = useRenderMemoryStore.getState();
    store.rememberImageSize('/ws/chart.png', { w: 800, h: 600 });
    const before = useRenderMemoryStore.getState().imageSizes;
    useRenderMemoryStore.getState().rememberImageSize('/ws/chart.png', { w: 800, h: 600 });
    expect(useRenderMemoryStore.getState().imageSizes).toBe(before);

    useRenderMemoryStore.getState().rememberPresentFiles('list', ['/ws/a.md']);
    const files = useRenderMemoryStore.getState().presentFiles;
    useRenderMemoryStore.getState().rememberPresentFiles('list', ['/ws/a.md']);
    expect(useRenderMemoryStore.getState().presentFiles).toBe(files);
  });

  it('keeps the newest entries when a map is full, by last write', () => {
    const store = useRenderMemoryStore.getState();
    for (let i = 0; i < IMAGE_SIZES_LIMIT; i += 1) store.rememberImageSize(`/ws/${i}.png`, { w: i, h: i });
    // Writing the oldest again makes it the newest.
    useRenderMemoryStore.getState().rememberImageSize('/ws/0.png', { w: 1, h: 1 });
    useRenderMemoryStore.getState().rememberImageSize('/ws/new.png', { w: 2, h: 2 });
    const sizes = useRenderMemoryStore.getState().imageSizes;
    expect(Object.keys(sizes)).toHaveLength(IMAGE_SIZES_LIMIT);
    expect(sizes['/ws/0.png']).toEqual({ w: 1, h: 1 });
    expect(sizes['/ws/1.png']).toBeUndefined();
    expect(sizes['/ws/new.png']).toEqual({ w: 2, h: 2 });
  });

  it('keeps each map within its own limit', () => {
    const store = useRenderMemoryStore.getState();
    for (let i = 0; i <= WIDGET_HEIGHTS_LIMIT; i += 1) store.rememberWidgetHeight(`widget-${i}`, i);
    expect(Object.keys(useRenderMemoryStore.getState().widgetHeights)).toHaveLength(WIDGET_HEIGHTS_LIMIT);
    expect(useRenderMemoryStore.getState().widgetHeights['widget-0']).toBeUndefined();
  });

  it('persists the four maps under its own key and version', () => {
    useRenderMemoryStore.getState().rememberDiagramHeight(diagramHeightKey('mermaid', 'graph TD'), 320);
    const raw = localStorage.getItem('abu-render-memory');
    expect(raw).not.toBeNull();
    const persisted = JSON.parse(raw as string) as { version: number; state: Record<string, unknown> };
    expect(persisted.version).toBe(1);
    expect(Object.keys(persisted.state).sort()).toEqual(['diagramHeights', 'imageSizes', 'presentFiles', 'widgetHeights']);
    expect((persisted.state.diagramHeights as Record<string, number>)[diagramHeightKey('mermaid', 'graph TD')]).toBe(320);
  });

  it('keys a diagram by its renderer, its length and its first 200 characters', () => {
    expect(diagramHeightKey('mermaid', 'graph TD')).toBe('mermaid\n8\ngraph TD');
    expect(diagramHeightKey('mermaid', 'a'.repeat(300))).toBe(`mermaid\n300\n${'a'.repeat(200)}`);
  });
});
