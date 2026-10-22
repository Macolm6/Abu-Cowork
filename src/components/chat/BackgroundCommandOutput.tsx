import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { invoke } from '@tauri-apps/api/core';
import { useI18n } from '@/i18n';
import { IconButton } from '@/components/ds/button';
import { AppIcons } from '@/components/ds/icons';
import { useTokenRevision } from '@/hooks/useTokenRevision';
import {
  TERMINAL_FONT_SIZE,
  TERMINAL_MINIMUM_CONTRAST,
  readToken,
  resolveTerminalTheme,
} from '@/components/common/terminalTheme';
import type { BackgroundCommandStatus } from '@/stores/backgroundCommandStore';

const POLL_MS = 500;
const COPIED_MS = 2000;
const SCROLLBACK_LINES = 10_000;
// ESC c (RIS): xterm rebuilds its buffers, scrollback included, when it parses this.
const FULL_RESET = '\x1bc';

interface OutputChunk {
  text: string;
  next: number;
  gap: boolean;
  status: BackgroundCommandStatus;
  exitCode: number | null;
}

function isRunning(status: BackgroundCommandStatus): boolean {
  return status === 'running' || status === 'stopping';
}

async function readOutput(conversationId: string, id: string, since: number): Promise<OutputChunk> {
  const chunk = await invoke<OutputChunk>('background_command_output', { conversationId, id, since });
  if (typeof chunk?.text !== 'string' || !Number.isInteger(chunk.next)) {
    throw new Error(`background_command_output returned an unexpected value for ${id}`);
  }
  return chunk;
}

// Once the buffer holds the whole scrollback and a screen, xterm drops a line from the
// top for every new one: the terminal no longer shows the beginning of the output.
function writeOutput(term: Terminal, text: string, onDropped: () => void): void {
  term.write(text, () => {
    if (term.buffer.active.length >= SCROLLBACK_LINES + term.rows) onDropped();
  });
}

/**
 * The output of one background command, read while this component is mounted: the whole
 * buffer first, then what was added every 500 ms until the command has finished. The
 * caller mounts it only while the list is open and the row is expanded.
 *
 * Output goes into a read-only xterm, which handles carriage returns (progress bars)
 * and parses large writes in slices of its own, so a 1 MB answer is one write.
 */
export default function BackgroundCommandOutput({ conversationId, commandId }: {
  conversationId: string;
  commandId: string;
}) {
  const { t } = useI18n();
  const tokenRevision = useTokenRevision();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  // Text read before the terminal exists; the terminal takes it in one write.
  const pendingRef = useRef('');
  const [hasOutput, setHasOutput] = useState(false);
  const [dropped, setDropped] = useState(false);
  const [readOnce, setReadOnce] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let since = 0;
    const read = async () => {
      const chunk = await readOutput(conversationId, commandId, since);
      if (cancelled) return;
      since = chunk.next;
      const term = termRef.current;
      if (chunk.gap) {
        // The main process answers a gap with everything it still holds, which starts after
        // the dropped part: it replaces what is shown, so the notice on the first line is true.
        setDropped(true);
        // RIS goes through the write queue, so the reset comes after any text xterm has not parsed yet.
        if (term) term.write(FULL_RESET);
        pendingRef.current = '';
      }
      if (chunk.text) {
        if (term) writeOutput(term, chunk.text, () => setDropped(true));
        else {
          pendingRef.current += chunk.text;
          setHasOutput(true);
        }
      }
      setReadOnce(true);
      // Once the command has finished, the read above held everything it wrote.
      if (isRunning(chunk.status)) timer = setTimeout(() => { void read(); }, POLL_MS);
    };
    void read();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [conversationId, commandId]);

  useEffect(() => {
    if (!hasOutput) return;
    const container = containerRef.current;
    if (!container) throw new Error('background command output container is not mounted');
    const term = new Terminal({
      fontSize: TERMINAL_FONT_SIZE,
      fontFamily: readToken('--ds-font-mono'),
      disableStdin: true,
      cursorBlink: false,
      cursorInactiveStyle: 'none',
      // The output comes from pipes, where a line ends with \n alone.
      convertEol: true,
      scrollback: SCROLLBACK_LINES,
      minimumContrastRatio: TERMINAL_MINIMUM_CONTRAST,
      theme: resolveTerminalTheme('--ds-raised'),
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    const fitIfVisible = () => {
      if (container.clientWidth > 0 && container.clientHeight > 0) fitAddon.fit();
    };
    fitIfVisible();
    writeOutput(term, pendingRef.current, () => setDropped(true));
    pendingRef.current = '';
    termRef.current = term;
    const resizeObserver = new ResizeObserver(fitIfVisible);
    resizeObserver.observe(container);
    return () => {
      resizeObserver.disconnect();
      term.dispose();
      termRef.current = null;
    };
  }, [hasOutput]);

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = resolveTerminalTheme('--ds-raised');
  }, [tokenRevision]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const handleCopy = async () => {
    const term = termRef.current;
    if (!term) throw new Error('background command output terminal is not open');
    term.selectAll();
    const text = term.getSelection();
    term.clearSelection();
    await navigator.clipboard.writeText(text);
    setCopied(true);
  };

  if (!readOnce) return null;

  if (!hasOutput) {
    return (
      <div className="text-ui-sm text-label-tertiary">
        {dropped && <div>{t.chat.backgroundCommands.outputDropped}</div>}
        <div>{t.chat.backgroundCommands.noOutput}</div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-1">
        <span className="min-w-0 flex-1 truncate text-ui-sm text-label-tertiary">
          {dropped ? t.chat.backgroundCommands.outputDropped : null}
        </span>
        {copied && <span className="text-caption text-label-tertiary">{t.chat.htmlWidgetCopied}</span>}
        <IconButton
          size="sm"
          icon={copied ? AppIcons.done : AppIcons.copy}
          label={copied ? t.chat.htmlWidgetCopied : t.chat.copy}
          onClick={() => { void handleCopy(); }}
        />
      </div>
      <div ref={containerRef} className="h-48 w-full overflow-hidden" />
    </div>
  );
}
