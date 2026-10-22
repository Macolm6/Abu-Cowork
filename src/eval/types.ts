/**
 * Agent Eval Framework — Type Definitions
 *
 * Defines the data structures for Abu's multi-layer evaluation system:
 * - L2: Tool selection evaluation (single-turn LLM, no tool execution)
 * - L3: End-to-end task completion (multi-turn with sandbox execution)
 * - L4: Output quality judging (LLM-as-Judge)
 */

import type { ModelCapability } from '@/types/provider';

// ─── Eval Target (Provider × Model) ───

export interface EvalTarget {
  providerId: string;
  modelId: string;
  /** Display name, e.g. "Claude Sonnet 4" */
  label: string;
}

// ─── L2: Tool Selection Cases ───

export type ToolSelectionCategory =
  | 'file-ops'
  | 'search'
  | 'command'
  | 'multi-step'
  | 'skill'
  | 'memory'
  | 'web'
  | 'knowledge'
  | 'delegate';

export interface ToolSelectionCase {
  id: string;
  category: ToolSelectionCategory;
  /** User input message */
  input: string;
  /** Multi-turn context messages */
  contextMessages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  expected: {
    /** Tools that MUST be called */
    requiredTools: string[];
    /** Tools that MUST NOT be called */
    forbiddenTools?: string[];
    /** Partial parameter matching (contains semantics) */
    toolParams?: Record<string, Record<string, unknown>>;
    /** Extra tool calls that are acceptable but not required */
    optionalTools?: string[];
  };
  difficulty: 'easy' | 'medium' | 'hard';
  /** Skip this case if model lacks these capabilities */
  requiredCapabilities?: ModelCapability[];
}

// ─── L3: End-to-End Cases ───

export interface E2ECase {
  id: string;
  category: string;
  /** User task description */
  input: string;
  /** Sandbox environment setup */
  setup: {
    files?: Record<string, string>;
    dirs?: string[];
  };
  /** Success criteria */
  assertions: Assertion[];
  /** Timeout in seconds (default 60) */
  timeoutSeconds?: number;
  /** Max agent turns (default 10) */
  maxTurns?: number;
  difficulty: 'easy' | 'medium' | 'hard';
  requiredCapabilities?: ModelCapability[];
}

export type Assertion =
  | { type: 'file_exists'; path: string }
  | { type: 'file_not_exists'; path: string }
  | { type: 'file_contains'; path: string; content: string }
  | { type: 'file_not_contains'; path: string; content: string }
  | { type: 'file_matches'; path: string; regex: string }
  | { type: 'output_contains'; content: string }
  | { type: 'output_not_contains'; content: string }
  | { type: 'tool_was_called'; toolName: string; minTimes?: number; maxTimes?: number }
  | { type: 'tool_not_called'; toolName: string }
  | { type: 'turns_within'; max: number }
  | { type: 'tokens_within'; maxInput?: number; maxOutput?: number };

// ─── Results ───

export interface CaseResult {
  caseId: string;
  target: EvalTarget;
  passed: boolean;
  toolsCalled: string[];
  details: {
    missingTools: string[];
    forbiddenToolsCalled: string[];
    paramMismatches: string[];
  };
  latencyMs: number;
  tokenUsage: { input: number; output: number };
  thinking?: string;
  error?: string;
}

// ─── Aggregated Report ───

export interface CategoryStats {
  pass: number;
  total: number;
}

export interface TargetSummary {
  passRate: number;
  passCount: number;
  failCount: number;
  avgLatencyMs: number;
  totalTokens: { input: number; output: number };
}

export interface EvalReport {
  metadata: {
    timestamp: string;
    targets: EvalTarget[];
    dataset: string;
    totalCases: number;
  };
  summary: {
    byTarget: Record<string, TargetSummary>;
    byCategory: Record<string, Record<string, CategoryStats>>;
    byDifficulty: Record<string, Record<string, CategoryStats>>;
  };
  results: CaseResult[];
}

// ─── L3: File-edit cases (per-model file-editing eval) ───

export type FileEditCategory =
  | 'single-replace'
  | 'multi-replace'
  | 'create'
  | 'delete-fragment'
  | 'special-chars'
  | 'multi-file'
  | 'read-then-edit';

export interface FileEditCase {
  id: string;
  category: FileEditCategory;
  difficulty: 'easy' | 'medium' | 'hard';
  /** User instruction, written in Chinese (Abu's users write Chinese). */
  instruction: string;
  /** Initial workspace files: path relative to the case directory → content. */
  files: Record<string, string>;
  /**
   * Expected final files: relative path → exact content. Every path listed
   * here must exist with this content after the run. A path present in
   * `files` but absent here must be left unchanged.
   */
  expected: Record<string, string>;
}

export interface FileEditToolCallRecord {
  name: string;
  /** The `path` argument when the tool call carried one. */
  path?: string;
  isError: boolean;
}

export type FileEditMismatchReason = 'missing' | 'content' | 'unexpected-change';

export interface FileEditMismatch {
  path: string;
  reason: FileEditMismatchReason;
  expected?: string;
  actual?: string;
}

export interface FileEditCaseResult {
  caseId: string;
  target: EvalTarget;
  passed: boolean;
  toolCalls: FileEditToolCallRecord[];
  toolCallCount: number;
  /** Calls to write_file or edit_file (whether or not they succeeded). */
  writeToolCallCount: number;
  /**
   * The model ended the run without ever calling write_file or edit_file.
   * This is the "says it will change the file but never does" symptom the
   * end-turn nudge guard is meant to catch; a run that ended in a transport
   * error is not counted.
   */
  textOnlyEndTurn: boolean;
  /** Model requests made for this case. */
  turns: number;
  tokenUsage: { input: number; output: number };
  latencyMs: number;
  mismatches: FileEditMismatch[];
  /** Files present after the run that neither `files` nor `expected` named. */
  extraFiles: string[];
  /** Text of the model's last turn. */
  finalText: string;
  error?: string;
}

export interface FileEditTargetSummary {
  passRate: number;
  passCount: number;
  failCount: number;
  errorCount: number;
  textOnlyEndTurnCount: number;
  avgToolCalls: number;
  avgWriteToolCalls: number;
  avgTurns: number;
  avgLatencyMs: number;
  totalTokens: { input: number; output: number };
}

export interface FileEditReport {
  metadata: {
    timestamp: string;
    runId: string;
    target: EvalTarget;
    family: string;
    dataset: 'file-edit';
    totalCases: number;
    /** Tools the model was offered, by name. */
    toolNames: string[];
    maxTurns: number;
  };
  summary: FileEditTargetSummary & {
    byCategory: Record<string, CategoryStats>;
    byDifficulty: Record<string, CategoryStats>;
  };
  results: FileEditCaseResult[];
}

// ─── L4: Judge Scores ───

export interface JudgeScore {
  completion: number;
  toolUsage: number;
  quality: number;
  safety: number;
  overall: number;
  reason: string;
}
