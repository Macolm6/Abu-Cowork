import type { ITheme } from '@xterm/xterm';

// 13px is the code size of the design system (`--text-mono`).
export const TERMINAL_FONT_SIZE = 13;

// xterm lifts any cell whose text falls under this contrast against its own background
// (the terminal background, a program-set background, or the selection).
export const TERMINAL_MINIMUM_CONTRAST = 4.5;

export function readToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * Terminal colors from the design tokens. xterm takes concrete color values only,
 * so the `--ds-*` variables are read here and read again whenever the appearance
 * changes (`useTokenRevision`). `backgroundToken` is the surface the terminal sits
 * on (`--ds-surface` for the workspace panel card, `--ds-raised` in a popover), so
 * the terminal blends into it.
 *
 * `selectionBackground` MUST be set explicitly: xterm's built-in default is
 * `rgba(255,255,255,0.3)` (white), which is invisible on a white background —
 * users dragged to select and saw nothing, and concluded copying was broken.
 *
 * `cursorAccent` is the character under the block cursor. xterm's default is black,
 * which disappears into a cursor drawn in the label color; the terminal background
 * always contrasts with the label.
 *
 * The 16 ANSI colors stay xterm's defaults: they are the program's output. xterm keeps
 * each cell readable through `minimumContrastRatio` (see TERMINAL_MINIMUM_CONTRAST).
 */
export function resolveTerminalTheme(backgroundToken: '--ds-surface' | '--ds-raised'): ITheme {
  return {
    background: readToken(backgroundToken),
    foreground: readToken('--ds-label'),
    cursor: readToken('--ds-label'),
    cursorAccent: readToken(backgroundToken),
    selectionBackground: readToken('--ds-selection'),
  };
}
