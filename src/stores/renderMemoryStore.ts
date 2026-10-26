/**
 * What the transcript learned about its content while rendering it, kept
 * across launches: the size an image has, the height a widget or a diagram
 * rendered at, which presented files were on disk. A row that is shown again
 * takes its final shape from here in its first frame, instead of growing a
 * moment later and moving what the reader is looking at.
 *
 * Every entry is a hint: the real answer replaces it as soon as it is known.
 * Each map keeps its newest entries, by last write.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface ImageSize {
  w: number;
  h: number;
}

interface RenderMemoryState {
  /** Image file path → its natural size. */
  imageSizes: Record<string, ImageSize>;
  /** Widget code key → the height its frame last reported. */
  widgetHeights: Record<string, number>;
  /** Diagram key → the height its block last rendered at. */
  diagramHeights: Record<string, number>;
  /** Declared-list key → the paths of the presented files that were on disk at the last check. */
  presentFiles: Record<string, string[]>;
}

interface RenderMemoryActions {
  rememberImageSize: (path: string, size: ImageSize) => void;
  rememberWidgetHeight: (key: string, height: number) => void;
  rememberDiagramHeight: (key: string, height: number) => void;
  rememberPresentFiles: (key: string, paths: string[]) => void;
}

type RenderMemoryStore = RenderMemoryState & RenderMemoryActions;

export const IMAGE_SIZES_LIMIT = 1000;
export const WIDGET_HEIGHTS_LIMIT = 200;
export const DIAGRAM_HEIGHTS_LIMIT = 200;
export const PRESENT_FILES_LIMIT = 500;

/** `record` with `key` as its newest entry, and no more than `limit` entries. */
function withEntry<T>(record: Record<string, T>, key: string, value: T, limit: number): Record<string, T> {
  const next: Record<string, T> = {};
  for (const [existing, held] of Object.entries(record)) {
    if (existing !== key) next[existing] = held;
  }
  next[key] = value;
  const keys = Object.keys(next);
  for (let i = 0; i < keys.length - limit; i += 1) delete next[keys[i]];
  return next;
}

function sameSize(a: ImageSize | undefined, b: ImageSize): boolean {
  return a !== undefined && a.w === b.w && a.h === b.h;
}

function samePaths(a: string[] | undefined, b: string[]): boolean {
  return a !== undefined && a.length === b.length && a.every((path, index) => path === b[index]);
}

export const useRenderMemoryStore = create<RenderMemoryStore>()(
  persist(
    (set, get) => ({
      imageSizes: {},
      widgetHeights: {},
      diagramHeights: {},
      presentFiles: {},

      rememberImageSize: (path, size) => {
        if (sameSize(get().imageSizes[path], size)) return;
        set((state) => ({ imageSizes: withEntry(state.imageSizes, path, size, IMAGE_SIZES_LIMIT) }));
      },
      rememberWidgetHeight: (key, height) => {
        if (get().widgetHeights[key] === height) return;
        set((state) => ({ widgetHeights: withEntry(state.widgetHeights, key, height, WIDGET_HEIGHTS_LIMIT) }));
      },
      rememberDiagramHeight: (key, height) => {
        if (get().diagramHeights[key] === height) return;
        set((state) => ({ diagramHeights: withEntry(state.diagramHeights, key, height, DIAGRAM_HEIGHTS_LIMIT) }));
      },
      rememberPresentFiles: (key, paths) => {
        if (samePaths(get().presentFiles[key], paths)) return;
        set((state) => ({ presentFiles: withEntry(state.presentFiles, key, paths, PRESENT_FILES_LIMIT) }));
      },
    }),
    {
      name: 'abu-render-memory',
      version: 1,
      partialize: (state) => ({
        imageSizes: state.imageSizes,
        widgetHeights: state.widgetHeights,
        diagramHeights: state.diagramHeights,
        presentFiles: state.presentFiles,
      }),
    },
  ),
);

/** The key a diagram's height is remembered under: its renderer and its code. */
export function diagramHeightKey(label: string, code: string): string {
  return `${label}\n${code.length}\n${code.slice(0, 200)}`;
}

/** The key a widget's frame height is remembered under: the start of its code. */
export function widgetHeightKey(code: string): string {
  return code.substring(0, 200);
}

/** The height a diagram block had when its code was last shown, or undefined. */
export function recallDiagramHeight(label: string, code: string): number | undefined {
  return useRenderMemoryStore.getState().diagramHeights[diagramHeightKey(label, code)];
}

/** The height a widget's frame last reported for its code, or undefined. */
export function recallWidgetHeight(code: string): number | undefined {
  return useRenderMemoryStore.getState().widgetHeights[widgetHeightKey(code)];
}
