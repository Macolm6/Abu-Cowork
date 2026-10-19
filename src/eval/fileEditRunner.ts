/**
 * L3 — File-edit eval runner
 *
 * Runs every case of `datasets/file-edit.json` against one model through
 * Abu's real pieces: the real LLM adapter (`ClaudeAdapter` /
 * `OpenAICompatibleAdapter`), the real system prompt sections, and the real
 * file tools (`read_file` / `write_file` / `edit_file` / `list_directory` /
 * `search_files` / `find_files`) executing against real files on disk. The
 * agent loop itself (`agentLoop.ts`) depends on the shell's stores, ports and
 * permission bridge, so this runner drives the smallest loop that matches it
 * for file editing: send the history, run every tool call the model emitted,
 * append the assistant turn with its tool results, repeat until the model
 * ends a turn without tool calls.
 *
 * Judged per case: did the files end up exactly as expected, how many tool
 * calls it took, how many of them wrote, token usage, and whether the model
 * ended without ever writing (`textOnlyEndTurn`).
 */

import type { LLMAdapter, ChatOptions } from '@/core/llm/adapter';
import type { ToolFileAccess } from '@/core/tools/fileOperation';
import { toolResultToString } from '@/core/tools/toolResultToString';
import { TOOL_NAMES } from '@/core/tools/toolNames';
import type { Message, StreamEvent, ToolCall, ToolDefinition, ToolExecutionContext } from '@/types';
import type {
  EvalTarget,
  FileEditCase,
  FileEditCaseResult,
  FileEditMismatch,
  FileEditToolCallRecord,
} from './types';

/** Tools the model is offered in this eval — the file tool set, nothing that runs a shell. */
export const FILE_EDIT_TOOL_NAMES: readonly string[] = [
  TOOL_NAMES.READ_FILE,
  TOOL_NAMES.WRITE_FILE,
  TOOL_NAMES.EDIT_FILE,
  TOOL_NAMES.LIST_DIRECTORY,
  TOOL_NAMES.SEARCH_FILES,
  TOOL_NAMES.FIND_FILES,
];

const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([TOOL_NAMES.WRITE_FILE, TOOL_NAMES.EDIT_FILE]);

export const DEFAULT_MAX_TURNS = 12;

/**
 * Workspace used to lay out a case's initial files and to read back the
 * result. Kept behind an interface so the runner's loop and judging can be
 * unit-tested on an in-memory workspace while the CLI uses the real disk.
 */
export interface EvalWorkspace {
  /** Absolute directory for one case; created empty by `prepare`. */
  caseDir(caseId: string): string;
  prepare(caseId: string, files: Record<string, string>): Promise<void>;
  /** File content, or `null` when the path does not exist. */
  readText(absolutePath: string): Promise<string | null>;
  /** Every regular file under the directory, as paths relative to it. */
  listFiles(dir: string): Promise<string[]>;
}

export interface FileEditRunDeps {
  adapter: LLMAdapter;
  /** The tools offered to the model; each is executed through its real `execute`. */
  tools: ToolDefinition[];
  /** Injected into every tool call's context so the tools do their I/O here. */
  fileAccess: ToolFileAccess;
  workspace: EvalWorkspace;
  systemPrompt: string;
  chatOptions: Pick<ChatOptions, 'model' | 'apiKey' | 'baseUrl' | 'maxTokens' | 'temperature' | 'declaredCapabilities' | 'enableThinking' | 'thinkingBudget' | 'reasoningEffort'>;
  runId: string;
  maxTurns?: number;
  /** Clock, injectable for deterministic tests. */
  now?: () => number;
  log?: (line: string) => void;
}

export interface FileEditRunFilters {
  filter?: string[];
  category?: string;
}

interface CollectedTurn {
  text: string;
  toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  usage: { input: number; output: number };
  stopReason: string;
  error?: string;
}

/**
 * One model request. Collects the streamed events into the text, the tool
 * calls and the usage of that request.
 */
async function requestTurn(
  adapter: LLMAdapter,
  messages: Message[],
  options: ChatOptions,
): Promise<CollectedTurn> {
  const turn: CollectedTurn = { text: '', toolUses: [], usage: { input: 0, output: 0 }, stopReason: '' };
  const onEvent = (event: StreamEvent): void => {
    switch (event.type) {
      case 'text':
        turn.text += event.text;
        break;
      case 'tool_use':
        turn.toolUses.push({ id: event.id, name: event.name, input: event.input });
        break;
      case 'usage':
        turn.usage.input = Math.max(turn.usage.input, event.usage.inputTokens);
        turn.usage.output = Math.max(turn.usage.output, event.usage.outputTokens);
        break;
      case 'done':
        turn.stopReason = event.stopReason;
        if (event.usage) {
          turn.usage.input = Math.max(turn.usage.input, event.usage.inputTokens);
          turn.usage.output = Math.max(turn.usage.output, event.usage.outputTokens);
        }
        break;
      case 'error':
        turn.error = event.error;
        break;
      case 'thinking':
        break;
    }
  };
  try {
    await adapter.chat(messages, options, onEvent);
  } catch (err) {
    turn.error = err instanceof Error ? err.message : String(err);
  }
  return turn;
}

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

/**
 * A leading BOM (write_file adds one to .csv files on purpose), line endings
 * and the end-of-file newline are not what this eval measures.
 */
export function normalizeFileText(text: string): string {
  const withoutBom = text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text;
  return withoutBom.replace(/\r\n/g, '\n').replace(/\n+$/, '');
}

function toRelative(dir: string, relativePath: string): string {
  return `${dir}/${relativePath}`;
}

/**
 * Compare the workspace after the run with the case's expectation: every
 * expected file must match, every initial file not in `expected` must be
 * unchanged. Files the model created beyond that are reported, not judged.
 */
export async function judgeFileEditCase(
  evalCase: FileEditCase,
  dir: string,
  workspace: EvalWorkspace,
): Promise<{ mismatches: FileEditMismatch[]; extraFiles: string[] }> {
  const mismatches: FileEditMismatch[] = [];

  for (const [relativePath, expected] of Object.entries(evalCase.expected)) {
    const actual = await workspace.readText(toRelative(dir, relativePath));
    if (actual === null) {
      mismatches.push({ path: relativePath, reason: 'missing', expected });
      continue;
    }
    if (normalizeFileText(actual) !== normalizeFileText(expected)) {
      mismatches.push({ path: relativePath, reason: 'content', expected, actual });
    }
  }

  for (const [relativePath, initial] of Object.entries(evalCase.files)) {
    if (relativePath in evalCase.expected) continue;
    const actual = await workspace.readText(toRelative(dir, relativePath));
    if (actual === null || normalizeFileText(actual) !== normalizeFileText(initial)) {
      mismatches.push({ path: relativePath, reason: 'unexpected-change', expected: initial, actual: actual ?? undefined });
    }
  }

  const known = new Set([...Object.keys(evalCase.files), ...Object.keys(evalCase.expected)]);
  const extraFiles = (await workspace.listFiles(dir)).filter((p) => !known.has(p)).sort();

  return { mismatches, extraFiles };
}

/** The user message for a case: the instruction plus where the files are. */
export function buildUserInstruction(evalCase: FileEditCase, dir: string): string {
  return `${evalCase.instruction}\n\n（文件都在这个目录下：${dir}）`;
}

export function applyFilters(cases: FileEditCase[], filters: FileEditRunFilters): FileEditCase[] {
  let filtered = cases;
  if (filters.filter?.length) {
    filtered = filtered.filter((c) => filters.filter!.includes(c.id));
  }
  if (filters.category) {
    filtered = filtered.filter((c) => c.category === filters.category);
  }
  return filtered;
}

/**
 * Run one case: lay out its files, drive the model until it ends a turn
 * without tool calls (or the turn limit is hit), then judge the files.
 */
export async function runFileEditCase(
  evalCase: FileEditCase,
  target: EvalTarget,
  deps: FileEditRunDeps,
): Promise<FileEditCaseResult> {
  const now = deps.now ?? Date.now;
  const maxTurns = deps.maxTurns ?? DEFAULT_MAX_TURNS;
  const start = now();
  const dir = deps.workspace.caseDir(evalCase.id);
  await deps.workspace.prepare(evalCase.id, evalCase.files);

  const toolMap = new Map(deps.tools.map((t) => [t.name, t]));
  const toolCalls: FileEditToolCallRecord[] = [];
  const tokenUsage = { input: 0, output: 0 };
  let turns = 0;
  let finalText = '';
  let error: string | undefined;
  let idCounter = 0;
  const nextId = (): string => `${evalCase.id}-${++idCounter}`;

  const messages: Message[] = [
    { id: nextId(), role: 'user', content: buildUserInstruction(evalCase, dir), timestamp: now() },
  ];

  const chatOptions: ChatOptions = {
    ...deps.chatOptions,
    systemPrompt: deps.systemPrompt,
    tools: deps.tools,
    metadata: { conversationId: `eval-${deps.runId}` },
    supportsVision: false,
  };

  while (turns < maxTurns) {
    turns += 1;
    const turn = await requestTurn(deps.adapter, messages, chatOptions);
    tokenUsage.input += turn.usage.input;
    tokenUsage.output += turn.usage.output;

    if (turn.error) {
      error = turn.error;
      break;
    }

    const assistant: Message = {
      id: nextId(),
      role: 'assistant',
      content: turn.text,
      timestamp: now(),
      toolCalls: [],
    };

    if (turn.toolUses.length === 0) {
      finalText = turn.text;
      messages.push(assistant);
      break;
    }

    for (const toolUse of turn.toolUses) {
      const context: ToolExecutionContext = {
        workspacePath: dir,
        conversationId: `eval-${deps.runId}`,
        loopId: `eval-${deps.runId}-${evalCase.id}`,
        toolCallId: toolUse.id,
        files: deps.fileAccess,
        supportsVision: false,
      };
      const tool = toolMap.get(toolUse.name);
      let result: string;
      if (!tool) {
        result = `Error: unknown tool ${toolUse.name}`;
      } else {
        try {
          result = toolResultToString(await tool.execute(toolUse.input, context));
        } catch (err) {
          result = `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      const isError = /^Error\b/.test(result);
      const path = typeof toolUse.input.path === 'string' ? toolUse.input.path : undefined;
      toolCalls.push({ name: toolUse.name, path, isError });
      const record: ToolCall = { id: toolUse.id, name: toolUse.name, input: toolUse.input, result, isError };
      assistant.toolCalls!.push(record);
      deps.log?.(`    ${isError ? '⚠️' : '🔧'} ${toolUse.name}${path ? ` ${path}` : ''}`);
    }
    messages.push(assistant);

    if (turns === maxTurns) {
      error = `Turn limit reached (${maxTurns}) with tool calls still pending`;
    }
  }

  const { mismatches, extraFiles } = await judgeFileEditCase(evalCase, dir, deps.workspace);
  const writeToolCallCount = toolCalls.filter((tc) => WRITE_TOOL_NAMES.has(tc.name)).length;

  return {
    caseId: evalCase.id,
    target,
    passed: error === undefined && mismatches.length === 0,
    toolCalls,
    toolCallCount: toolCalls.length,
    writeToolCallCount,
    textOnlyEndTurn: error === undefined && writeToolCallCount === 0,
    turns,
    tokenUsage,
    latencyMs: now() - start,
    mismatches,
    extraFiles,
    finalText,
    error,
  };
}

export async function runFileEditEval(
  cases: FileEditCase[],
  target: EvalTarget,
  deps: FileEditRunDeps,
  filters: FileEditRunFilters = {},
): Promise<FileEditCaseResult[]> {
  const results: FileEditCaseResult[] = [];
  for (const evalCase of applyFilters(cases, filters)) {
    deps.log?.(`  ▶ ${evalCase.id}`);
    const result = await runFileEditCase(evalCase, target, deps);
    results.push(result);
    const status = result.passed ? '✅' : '❌';
    const note = result.error
      ? ` error=${result.error}`
      : result.textOnlyEndTurn
        ? ' textOnlyEndTurn'
        : result.mismatches.length
          ? ` mismatches=${result.mismatches.map((m) => `${m.path}:${m.reason}`).join(',')}`
          : '';
    deps.log?.(`  ${status} ${evalCase.id} (${result.latencyMs}ms, ${result.turns} turns, ${result.toolCallCount} tool calls, ${result.writeToolCallCount} writes)${note}`);
  }
  return results;
}
