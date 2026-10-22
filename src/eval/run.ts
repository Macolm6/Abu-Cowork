#!/usr/bin/env tsx
/**
 * Abu Agent Eval — CLI Entry Point
 *
 * Usage:
 *   tsx src/eval/run.ts tool-selection --provider anthropic --model claude-sonnet-5
 *   tsx src/eval/run.ts tool-selection --category file-ops
 *   tsx src/eval/run.ts tool-selection --filter file-read-01,file-write-01
 *   tsx src/eval/run.ts file-edit --provider deepseek --model deepseek-v4-pro
 *   tsx src/eval/run.ts report --diff <hint1> <hint2>
 */

// Must be first — shims Tauri APIs for Node.js environment
import './shimTauri';

import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ApiFormat } from '@/types';
import type { LLMAdapter } from '@/core/llm/adapter';
import type { EvalTarget, FileEditCase, ToolSelectionCase } from './types';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    provider:    { type: 'string', default: 'anthropic' },
    model:       { type: 'string', default: 'claude-sonnet-5' },
    'api-key':   { type: 'string' },
    'base-url':  { type: 'string' },
    filter:      { type: 'string' },
    category:    { type: 'string' },
    thinking:    { type: 'boolean', default: false },
    diff:        { type: 'string', multiple: true },
    label:       { type: 'string' },
    'max-turns': { type: 'string', default: '12' },
    'run-id':    { type: 'string' },
    'prompt-variant': { type: 'string', default: 'family' },
  },
});

/** `--prompt-variant default` builds the prompt without the target family's fragments (the A side of an A/B run). */
function familyPromptEnabled(): boolean {
  const value = values['prompt-variant'];
  if (value === 'family') return true;
  if (value === 'default') return false;
  console.error(`Error: --prompt-variant must be "family" or "default", got "${value}"`);
  process.exit(1);
}

const command = positionals[0];

async function main() {
  if (!command) {
    console.log(`
Abu Agent Eval Framework

Commands:
  tool-selection    Run L2 tool selection eval (single turn, no tool execution)
  file-edit         Run L3 file-edit eval (real adapter + real file tools on disk)
  report            Show or diff eval reports

Options:
  --provider <id>   Provider ID from providerConfigs (default: anthropic)
  --model <id>      Model ID (default: claude-sonnet-5)
  --api-key <key>   API key (or set <PROVIDER>_API_KEY, e.g. DEEPSEEK_API_KEY)
  --base-url <url>  API base URL override (default: the provider's configured base URL)
  --filter <ids>    Comma-separated case IDs to run
  --category <cat>  Only run cases in this category
  --thinking        Enable extended thinking (tool-selection, Anthropic only)
  --label <name>    Custom label for this target
  --max-turns <n>   file-edit: model requests allowed per case (default: 12)
  --run-id <id>     file-edit: workspace folder name under .agent/eval-workspace/
  --prompt-variant <family|default>  Prompt fragments: the target family's (default) or the plain default ones
  --diff <a> <b>    Diff two reports by filename hint

Results are saved under eval-results/<family>/<date>-<model>-<dataset>.json.

Examples:
  tsx src/eval/run.ts tool-selection
  tsx src/eval/run.ts tool-selection --provider deepseek --model deepseek-v4-pro --api-key sk-xxx
  tsx src/eval/run.ts file-edit --provider openai --model gpt-4.1
  tsx src/eval/run.ts file-edit --category special-chars
  tsx src/eval/run.ts report --diff 2026-10-19 2026-10-20
    `);
    process.exit(0);
  }

  if (command === 'tool-selection') {
    await runToolSelection();
  } else if (command === 'file-edit') {
    await runFileEdit();
  } else if (command === 'report') {
    await runReport();
  } else {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
  }
}

interface ResolvedTarget {
  target: EvalTarget;
  apiKey: string;
  baseUrl: string;
  format: ApiFormat;
}

/**
 * Provider id → base URL and wire format, from the same table the settings
 * page uses, so the eval talks to each vendor the way the app does.
 */
async function resolveTarget(): Promise<ResolvedTarget> {
  const { PROVIDER_CONFIGS } = await import('@/utils/providerConfigs');
  const providerId = values.provider ?? 'anthropic';
  const modelId = values.model ?? 'claude-sonnet-5';
  const config = (PROVIDER_CONFIGS as Record<string, { baseUrl: string; format: ApiFormat } | undefined>)[providerId];

  const baseUrl = values['base-url'] ?? config?.baseUrl;
  if (!baseUrl) {
    console.error(`Error: unknown provider "${providerId}" and no --base-url given.`);
    process.exit(1);
  }
  const format: ApiFormat = config?.format ?? 'openai-compatible';

  const envKey = `${providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
  const apiKey = values['api-key']
    ?? process.env[envKey]
    ?? (format === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY)
    ?? '';
  if (!apiKey) {
    console.error(`Error: No API key provided. Use --api-key or set ${envKey}.`);
    process.exit(1);
  }

  return {
    target: { providerId, modelId, label: values.label ?? `${providerId}:${modelId}` },
    apiKey,
    baseUrl,
    format,
  };
}

async function createAdapter(format: ApiFormat): Promise<LLMAdapter> {
  if (format === 'anthropic') {
    const { ClaudeAdapter } = await import('@/core/llm/claude');
    return new ClaudeAdapter();
  }
  const { OpenAICompatibleAdapter } = await import('@/core/llm/openai-compatible');
  return new OpenAICompatibleAdapter();
}

async function runToolSelection() {
  const { runToolSelectionEval, runToolSelectionEvalWithAdapter } = await import('./toolSelectionRunner');
  const { buildReport, enrichReportWithCaseData, saveFamilyReport, printReport } = await import('./report');
  const { resolveEvalFamily } = await import('./modelFamily');

  // Load dataset
  const datasetPath = join(process.cwd(), 'src/eval/datasets/tool-selection.json');
  const cases: ToolSelectionCase[] = JSON.parse(readFileSync(datasetPath, 'utf-8'));

  const { target, apiKey, baseUrl, format } = await resolveTarget();

  console.log(`\n🔍 Running tool selection eval`);
  console.log(`   Target: ${target.label}`);
  console.log(`   Cases: ${cases.length}`);
  console.log(`   Transport: ${format === 'anthropic' ? 'anthropic sdk' : 'abu openai-compatible adapter'}`);
  console.log(`   Thinking: ${values.thinking ? 'on' : 'off'}\n`);

  const filters = { filter: values.filter?.split(','), category: values.category, familyPrompt: familyPromptEnabled() };
  console.log(`   Prompt fragments: ${filters.familyPrompt ? 'target family' : 'default'}\n`);
  const results = format === 'anthropic'
    ? await runToolSelectionEval(cases, target, {
        apiKey,
        baseUrl: values['base-url'],
        temperature: 0,
        enableThinking: values.thinking,
        ...filters,
      })
    : await runToolSelectionEvalWithAdapter(cases, target, await createAdapter(format), {
        apiKey,
        baseUrl,
        ...filters,
      });

  // Build and print report
  const report = buildReport(results, 'tool-selection', [target]);
  enrichReportWithCaseData(report, cases);
  printReport(report);

  // Save
  const filepath = saveFamilyReport(report, resolveEvalFamily(target.modelId), target.modelId, 'tool-selection');
  console.log(`📄 Report saved: ${filepath}\n`);
}

async function runFileEdit() {
  const { runFileEditEval, FILE_EDIT_TOOL_NAMES } = await import('./fileEditRunner');
  const { createNodeFileAccess, createNodeEvalWorkspace } = await import('./nodeFileAccess');
  const { buildFileEditReport, printFileEditReport, saveFamilyReport } = await import('./report');
  const { resolveEvalFamily } = await import('./modelFamily');
  const { registerBuiltinTools } = await import('@/core/tools/builtins');
  const { toolRegistry } = await import('@/core/tools/registry');
  const { buildSystemPromptSections, routeInput } = await import('@/core/agent/orchestrator');
  const { sectionsToString } = await import('@/core/llm/promptSections');

  const datasetPath = join(process.cwd(), 'src/eval/datasets/file-edit.json');
  const cases: FileEditCase[] = JSON.parse(readFileSync(datasetPath, 'utf-8'));

  const { target, apiKey, baseUrl, format } = await resolveTarget();
  const maxTurns = Number(values['max-turns']);
  if (!Number.isInteger(maxTurns) || maxTurns < 1) {
    console.error(`Error: --max-turns must be a positive integer, got "${values['max-turns']}"`);
    process.exit(1);
  }
  const runId = values['run-id'] ?? `${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}_${target.modelId.replace(/[^A-Za-z0-9._-]+/g, '_')}`;
  const rootDir = join(process.cwd(), '.agent', 'eval-workspace', runId);
  const family = resolveEvalFamily(target.modelId);

  registerBuiltinTools();
  const tools = FILE_EDIT_TOOL_NAMES.map((name) => {
    const tool = toolRegistry.get(name);
    if (!tool) throw new Error(`Tool "${name}" is not registered`);
    return tool;
  });

  // The real system prompt sections, built the same way the tool-selection
  // eval builds them; the workspace is the run's root folder, and the target
  // model's profile picks the family's prompt fragments.
  const { resolveModelProfile } = await import('@/core/llm/modelProfile');
  const route = routeInput('');
  const familyPrompt = familyPromptEnabled();
  const profile = familyPrompt ? resolveModelProfile({ modelId: target.modelId, baseUrl }) : undefined;
  const sections = await buildSystemPromptSections(route, '', `eval-${runId}`, { platform: 'eval', workspacePath: rootDir }, 0, undefined, profile);
  const systemPrompt = sectionsToString(sections);

  console.log(`\n✏️  Running file-edit eval`);
  console.log(`   Target: ${target.label} (family: ${family})`);
  console.log(`   Cases: ${cases.length}`);
  console.log(`   Adapter: ${format === 'anthropic' ? 'ClaudeAdapter' : 'OpenAICompatibleAdapter'} → ${baseUrl}`);
  console.log(`   Workspace: ${rootDir}`);
  console.log(`   Max turns per case: ${maxTurns}`);
  console.log(`   Prompt fragments: ${familyPrompt ? 'target family' : 'default'}\n`);

  const results = await runFileEditEval(cases, target, {
    adapter: await createAdapter(format),
    tools,
    fileAccess: createNodeFileAccess(),
    workspace: createNodeEvalWorkspace(rootDir),
    systemPrompt,
    chatOptions: { model: target.modelId, apiKey, baseUrl },
    runId,
    maxTurns,
    log: (line) => console.log(line),
  }, { filter: values.filter?.split(','), category: values.category });

  const report = buildFileEditReport(results, cases, {
    runId,
    target,
    family,
    toolNames: [...FILE_EDIT_TOOL_NAMES],
    maxTurns,
  });
  printFileEditReport(report);

  const filepath = saveFamilyReport(report, family, target.modelId, 'file-edit');
  console.log(`📄 Report saved: ${filepath}\n`);
}

async function runReport() {
  const { loadReport, diffReports, printReport } = await import('./report');

  const diffHints = values.diff;
  if (diffHints && diffHints.length >= 2) {
    const before = loadReport(diffHints[0]);
    const after = loadReport(diffHints[1]);

    if (!before) {
      console.error(`Cannot find report matching "${diffHints[0]}"`);
      process.exit(1);
    }
    if (!after) {
      console.error(`Cannot find report matching "${diffHints[1]}"`);
      process.exit(1);
    }

    diffReports(before, after);
  } else {
    // Show latest report
    const latest = loadReport('');
    if (latest) {
      printReport(latest);
    } else {
      console.log('No eval reports found. Run an eval first.');
    }
  }
}

main().catch(err => {
  console.error('Eval failed:', err);
  process.exit(1);
});
