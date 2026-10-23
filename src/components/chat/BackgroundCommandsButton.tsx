import { memo, useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useI18n, format, type TranslationDict } from '@/i18n';
import { cn } from '@/lib/utils';
import { createLogger } from '@/core/logging/logger';
import { Button, IconButton } from '@/components/ds/button';
import { Disclosure } from '@/components/ds/disclosure';
import { AppIcons } from '@/components/ds/icons';
import { InlineMessage } from '@/components/ds/inline-message';
import { Popover } from '@/components/ds/popover';
import { Tooltip } from '@/components/ds/tooltip';
import {
  useBackgroundCommandStore,
  type BackgroundCommandRow,
  type BackgroundCommandStatus,
} from '@/stores/backgroundCommandStore';
import BackgroundCommandOutput from './BackgroundCommandOutput';

const logger = createLogger('backgroundCommands');

const CONFIRM_STOP_MS = 3000;
const STOP_FAILED_MS = 4000;
const TICK_MS = 1000;

type Strings = TranslationDict['chat']['backgroundCommands'];

// One stable empty list, so a conversation without rows does not re-render on every store change.
const NO_ROWS: BackgroundCommandRow[] = [];

function isRunning(status: BackgroundCommandStatus): boolean {
  return status === 'running' || status === 'stopping';
}

function formatDuration(ms: number, s: Strings): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return format(s.durationHours, { h: hours, m: minutes });
  if (minutes > 0) return format(s.durationMinutes, { m: minutes, s: seconds });
  return format(s.durationSeconds, { s: seconds });
}

function statusText(row: BackgroundCommandRow, s: Strings): string {
  switch (row.status) {
    case 'running': return s.statusRunning;
    case 'stopping': return s.statusStopping;
    case 'completed': return s.statusCompleted;
    case 'stopped': return s.statusStopped;
    case 'failed':
      return row.exitCode === null ? s.statusFailed : format(s.statusFailedWithCode, { code: row.exitCode });
  }
}

// Same dots as the sidebar's conversation status.
function StatusDot({ status }: { status: BackgroundCommandStatus }) {
  return (
    <span
      className={cn(
        'h-2 w-2 shrink-0 rounded-full',
        status === 'running' && 'bg-warning animate-pulse',
        status === 'stopping' && 'bg-warning',
        status === 'completed' && 'bg-success',
        status === 'failed' && 'bg-danger',
        status === 'stopped' && 'bg-current text-label-tertiary',
      )}
    />
  );
}

type StopState = 'idle' | 'confirm' | 'requested';

function StopControl({ conversationId, row }: { conversationId: string; row: BackgroundCommandRow }) {
  const { t } = useI18n();
  const s = t.chat.backgroundCommands;
  const [state, setState] = useState<StopState>('idle');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (state !== 'confirm') return;
    const timer = setTimeout(() => setState('idle'), CONFIRM_STOP_MS);
    return () => clearTimeout(timer);
  }, [state]);

  useEffect(() => {
    if (!failed) return;
    const timer = setTimeout(() => setFailed(false), STOP_FAILED_MS);
    return () => clearTimeout(timer);
  }, [failed]);

  const stop = async () => {
    setState('requested');
    setFailed(false);
    try {
      // The row changes to stopping or to its end through the store; the button waits for that.
      await invoke('background_command_stop', { conversationId, id: row.id });
    } catch (error) {
      logger.error('Failed to stop background command', { id: row.id, error: String(error) });
      setState('idle');
      setFailed(true);
    }
  };

  return (
    <div className="flex h-7 shrink-0 items-center gap-1">
      {failed && <span className="text-ui-sm text-danger">{s.stopFailed}</span>}
      {state === 'idle' ? (
        <IconButton size="sm" icon={AppIcons.stop} label={s.stop} onClick={() => setState('confirm')} />
      ) : (
        <Button
          variant="danger"
          size="sm"
          busy={state === 'requested'}
          onClick={() => {
            if (state === 'confirm') void stop();
          }}
        >
          {s.confirmStop}
        </Button>
      )}
    </div>
  );
}

function CommandRow({ conversationId, row, now, expanded, onExpandedChange }: {
  conversationId: string;
  row: BackgroundCommandRow;
  now: number;
  expanded: boolean;
  onExpandedChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const s = t.chat.backgroundCommands;
  const duration = formatDuration((row.finishedAt ?? now) - row.startedAt, s);

  return (
    <div className="flex items-start gap-1">
      <div className="min-w-0 flex-1">
        <Disclosure
          open={expanded}
          onOpenChange={onExpandedChange}
          title={(
            <span className="flex min-w-0 flex-1 items-center gap-2 font-normal">
              <StatusDot status={row.status} />
              <span className="min-w-0 flex-1 truncate font-code text-mono">{row.command}</span>
              <span className="shrink-0 text-ui-sm text-label-secondary">{statusText(row, s)}</span>
              <Tooltip content={format(row.finishedAt === null ? s.runningFor : s.took, { duration })}>
                <span className="shrink-0 text-ui-sm tabular-nums text-label-tertiary">{duration}</span>
              </Tooltip>
            </span>
          )}
        >
          {expanded && <BackgroundCommandOutput conversationId={conversationId} commandId={row.id} />}
        </Disclosure>
      </div>
      {row.status === 'running' && <StopControl conversationId={conversationId} row={row} />}
    </div>
  );
}

// Mounted only while the popover is open: the clock ticks and output is read only then.
function CommandList({ conversationId, rows }: { conversationId: string; rows: BackgroundCommandRow[] }) {
  const { t } = useI18n();
  const s = t.chat.backgroundCommands;
  const [readFailed, setReadFailed] = useState(false);
  const [reading, setReading] = useState(false);
  // Opening the list reads the rows again: an update that failed while it was closed left an
  // older list, which stays below the failure line until a read succeeds.
  const readRows = useCallback(async () => {
    try {
      await useBackgroundCommandStore.getState().refresh(conversationId);
      setReadFailed(false);
    } catch (error) {
      logger.warn('Failed to read background commands', { error: String(error) });
      setReadFailed(true);
    } finally {
      setReading(false);
    }
  }, [conversationId]);
  useEffect(() => { void readRows(); }, [readRows]);
  const [now, setNow] = useState(() => Date.now());
  // One row is expanded at a time.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const running = rows.filter((row) => isRunning(row.status));
  const finished = rows.filter((row) => !isRunning(row.status));
  const hasRunning = running.length > 0;

  useEffect(() => {
    if (!hasRunning) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [hasRunning]);

  const renderRow = (row: BackgroundCommandRow) => (
    <CommandRow
      key={row.id}
      conversationId={conversationId}
      row={row}
      now={now}
      expanded={expandedId === row.id}
      onExpandedChange={(open) => setExpandedId(open ? row.id : null)}
    />
  );

  return (
    <div className="max-h-120 overflow-y-auto">
      {readFailed && (
        <div className="mb-2">
          <InlineMessage
            tone="warning"
            action={(
              <Button
                variant="plain"
                size="sm"
                busy={reading}
                onClick={() => {
                  if (reading) return;
                  setReading(true);
                  void readRows();
                }}
              >
                {s.retry}
              </Button>
            )}
          >
            {s.loadFailed}
          </InlineMessage>
        </div>
      )}
      {running.map(renderRow)}
      {finished.length > 0 && (
        <>
          <div className={cn('flex h-7 items-center justify-between', hasRunning && 'mt-2 border-t border-separator pt-2')}>
            <span className="text-ui-sm text-label-secondary">{format(s.finished, { count: finished.length })}</span>
            <Button
              variant="plain"
              size="sm"
              onClick={() => { void invoke('background_command_clear', { conversationId }); }}
            >
              {s.clear}
            </Button>
          </div>
          {finished.map(renderRow)}
        </>
      )}
    </div>
  );
}

/**
 * The conversation header's entry to the background commands Abu started in this
 * conversation. It shows nothing while the conversation has none.
 */
function BackgroundCommandsButton({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  const s = t.chat.backgroundCommands;
  const rows = useBackgroundCommandStore((state) => state.rows[conversationId] ?? NO_ROWS);
  const [open, setOpen] = useState(false);

  if (rows.length === 0) return null;

  const runningCount = rows.filter((row) => isRunning(row.status)).length;
  const label = runningCount > 0
    ? (runningCount === 1 ? s.runningOne : format(s.running, { count: runningCount }))
    : (rows.length === 1 ? s.totalOne : format(s.total, { count: rows.length }));

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      label={label}
      className="w-96"
      trigger={(
        <Button variant="plain" size="sm">
          {runningCount > 0 && <StatusDot status="running" />}
          {label}
        </Button>
      )}
    >
      {open && <CommandList conversationId={conversationId} rows={rows} />}
    </Popover>
  );
}

// ChatView re-renders on every streamed token; the entry re-renders when its rows change.
export default memo(BackgroundCommandsButton);
