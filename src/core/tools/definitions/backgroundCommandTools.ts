import { invoke } from '@tauri-apps/api/core';
import stripAnsi from 'strip-ansi';
import type { ToolDefinition, ToolExecutionContext } from '../../../types';
import { TOOL_NAMES } from '../toolNames';
import { format, getI18n } from '../../../i18n';

const DEFAULT_TAIL_LINES = 200;

type BackgroundCommandStatus = 'running' | 'stopping' | 'completed' | 'failed' | 'stopped';

/** A row of `background_command_list` (electron/backgroundCommands.cjs). */
interface BackgroundCommandRow {
  id: string;
  command: string;
  cwd: string | null;
  status: BackgroundCommandStatus;
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
}

interface BackgroundCommandOutput {
  text: string;
  next: number;
  gap: boolean;
  status: BackgroundCommandStatus;
  exitCode: number | null;
}

function conversationOf(context: ToolExecutionContext | undefined): string {
  const conversationId = context?.conversationId;
  if (!conversationId) throw new TypeError('background commands belong to a conversation; this call has none');
  return conversationId;
}

function optionalId(input: Record<string, unknown>): string | undefined {
  if (input.id === undefined) return undefined;
  if (typeof input.id !== 'string' || input.id === '') throw new TypeError('id must be a background command id');
  return input.id;
}

function tailLines(input: Record<string, unknown>): number {
  if (input.tail_lines === undefined) return DEFAULT_TAIL_LINES;
  if (!Number.isInteger(input.tail_lines) || (input.tail_lines as number) < 1) {
    throw new TypeError('tail_lines must be a positive integer');
  }
  return input.tail_lines as number;
}

function describeStatus(status: BackgroundCommandStatus, exitCode: number | null): string {
  return status === 'failed' && exitCode !== null ? `failed (exit code ${exitCode})` : status;
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h${minutes}m${seconds}s`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

function listRows(conversationId: string): Promise<BackgroundCommandRow[]> {
  return invoke<BackgroundCommandRow[]>('background_command_list', { conversationId });
}

/** The row the main process has just accepted for this conversation. */
async function ownedRow(conversationId: string, id: string): Promise<BackgroundCommandRow> {
  const row = (await listRows(conversationId)).find((candidate) => candidate.id === id);
  if (!row) throw new Error(`background command ${id} is no longer listed in conversation ${conversationId}`);
  return row;
}

function formatList(rows: BackgroundCommandRow[]): string {
  const t = getI18n().toolResult.backgroundCommand;
  if (rows.length === 0) return t.noCommands;
  const now = Date.now();
  const lines = rows.map((row) => {
    const duration = formatDuration((row.finishedAt ?? now) - row.startedAt);
    return `- ${row.id} · ${describeStatus(row.status, row.exitCode)} · ${duration} · ${row.command}`;
  });
  return `${t.listHeader}\n${lines.join('\n')}`;
}

/** Output lines as a terminal shows them: a carriage return redraws its line (progress bars). */
function outputLines(text: string): string[] {
  const lines = stripAnsi(text).split('\n').map((raw) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    return line.slice(line.lastIndexOf('\r') + 1);
  });
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function formatOutput(row: BackgroundCommandRow, output: BackgroundCommandOutput, limit: number): string {
  const t = getI18n().toolResult.backgroundCommand;
  const parts = [
    `id: ${row.id}`,
    `command: ${row.command}`,
    `status: ${describeStatus(output.status, output.exitCode)}`,
  ];
  if (output.exitCode !== null) parts.push(`exit code: ${output.exitCode}`);
  if (output.gap) parts.push(t.earlierOutputDropped);
  const lines = outputLines(output.text);
  if (lines.length === 0) {
    parts.push(`output: ${t.noOutput}`);
  } else if (lines.length > limit) {
    parts.push(`${format(t.outputTail, { count: limit, total: lines.length })}\n${lines.slice(-limit).join('\n')}`);
  } else {
    parts.push(`output:\n${lines.join('\n')}`);
  }
  return parts.join('\n');
}

export const backgroundCommandOutputTool: ToolDefinition = {
  name: TOOL_NAMES.BACKGROUND_COMMAND_OUTPUT,
  description: `Read the background commands this conversation started with run_command (background: true).

With an id: returns that command's status, exit code and its most recent output lines (ANSI color codes removed).
Without an id: lists this conversation's background commands with their id, status, running time and command.`,
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Background command id from the run_command result (bg-…). Omit to list them all.' },
      tail_lines: { type: 'integer', description: `How many of the most recent output lines to return (default ${DEFAULT_TAIL_LINES}).` },
    },
  },
  execute: async (input, context) => {
    const conversationId = conversationOf(context);
    const id = optionalId(input);
    const limit = tailLines(input);
    if (id === undefined) return formatList(await listRows(conversationId));

    // The main process checks that the command belongs to this conversation and throws otherwise.
    const output = await invoke<BackgroundCommandOutput>('background_command_output', { conversationId, id, since: 0 });
    const row = await ownedRow(conversationId, id);
    context?.reportMetadata?.({ backgroundCommand: { command: row.command } });
    return formatOutput(row, output, limit);
  },
  isConcurrencySafe: true,
};

export const stopBackgroundCommandTool: ToolDefinition = {
  name: TOOL_NAMES.STOP_BACKGROUND_COMMAND,
  description: 'Stop a background command this conversation started with run_command (background: true), together with every process it started.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Background command id from the run_command result (bg-…).' },
    },
    required: ['id'],
  },
  execute: async (input, context) => {
    const conversationId = conversationOf(context);
    const id = optionalId(input);
    if (id === undefined) throw new TypeError('id is required');

    // The main process checks that the command belongs to this conversation and throws otherwise.
    const outcome = await invoke<'requested' | 'already-finished'>('background_command_stop', { conversationId, id });
    const row = await ownedRow(conversationId, id);
    context?.reportMetadata?.({ backgroundCommand: { command: row.command } });
    const t = getI18n().toolResult.backgroundCommand;
    if (outcome === 'requested') return format(t.stopRequested, { id, command: row.command });
    if (outcome !== 'already-finished') throw new Error(`background_command_stop returned ${String(outcome)}`);
    return format(t.alreadyFinished, { id, command: row.command, status: describeStatus(row.status, row.exitCode) });
  },
};
