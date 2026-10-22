/**
 * Eval Report Generator
 *
 * Generates CLI summary + JSON report from eval results.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import type {
  CaseResult,
  EvalReport,
  EvalTarget,
  CategoryStats,
  TargetSummary,
  FileEditCase,
  FileEditCaseResult,
  FileEditReport,
  FileEditTargetSummary,
} from './types';

const RESULTS_DIR = join(process.cwd(), 'eval-results');

/**
 * Save a report under `eval-results/<family>/<date>-<model>-<dataset>.json`,
 * the committed location for per-family baselines. A second run on the same
 * day gets a numeric suffix instead of overwriting the first.
 */
export function saveFamilyReport(
  report: EvalReport | FileEditReport,
  family: string,
  modelId: string,
  dataset: string,
  date: string = new Date().toISOString().slice(0, 10),
): string {
  const dir = join(RESULTS_DIR, family);
  mkdirSync(dir, { recursive: true });
  const safeModel = modelId.replace(/[^A-Za-z0-9._-]+/g, '_');
  const base = `${date}-${safeModel}-${dataset}`;
  let filepath = join(dir, `${base}.json`);
  for (let n = 2; existsSync(filepath); n++) {
    filepath = join(dir, `${base}-${n}.json`);
  }
  writeFileSync(filepath, JSON.stringify(report, null, 2) + '\n', 'utf-8');
  return filepath;
}

function average(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
}

function tally(
  results: FileEditCaseResult[],
  caseMap: Map<string, FileEditCase>,
  key: (c: FileEditCase) => string,
): Record<string, CategoryStats> {
  const stats: Record<string, CategoryStats> = {};
  for (const result of results) {
    const evalCase = caseMap.get(result.caseId);
    if (!evalCase) continue;
    const bucket = key(evalCase);
    if (!stats[bucket]) stats[bucket] = { pass: 0, total: 0 };
    stats[bucket].total++;
    if (result.passed) stats[bucket].pass++;
  }
  return stats;
}

export function summarizeFileEditResults(results: FileEditCaseResult[]): FileEditTargetSummary {
  const passCount = results.filter((r) => r.passed).length;
  return {
    passRate: results.length > 0 ? passCount / results.length : 0,
    passCount,
    failCount: results.length - passCount,
    errorCount: results.filter((r) => r.error !== undefined).length,
    textOnlyEndTurnCount: results.filter((r) => r.textOnlyEndTurn).length,
    avgToolCalls: average(results.map((r) => r.toolCallCount)),
    avgWriteToolCalls: average(results.map((r) => r.writeToolCallCount)),
    avgTurns: average(results.map((r) => r.turns)),
    avgLatencyMs: average(results.map((r) => r.latencyMs)),
    totalTokens: {
      input: results.reduce((sum, r) => sum + r.tokenUsage.input, 0),
      output: results.reduce((sum, r) => sum + r.tokenUsage.output, 0),
    },
  };
}

export function buildFileEditReport(
  results: FileEditCaseResult[],
  cases: FileEditCase[],
  meta: { runId: string; target: EvalTarget; family: string; toolNames: string[]; maxTurns: number; timestamp?: string },
): FileEditReport {
  const caseMap = new Map(cases.map((c) => [c.id, c]));
  return {
    metadata: {
      timestamp: meta.timestamp ?? new Date().toISOString(),
      runId: meta.runId,
      target: meta.target,
      family: meta.family,
      dataset: 'file-edit',
      totalCases: results.length,
      toolNames: meta.toolNames,
      maxTurns: meta.maxTurns,
    },
    summary: {
      ...summarizeFileEditResults(results),
      byCategory: tally(results, caseMap, (c) => c.category),
      byDifficulty: tally(results, caseMap, (c) => c.difficulty),
    },
    results,
  };
}

export function printFileEditReport(report: FileEditReport): void {
  const line = '─'.repeat(60);
  const s = report.summary;
  console.log(`\n${line}`);
  console.log(`  Abu File-Edit Eval Report`);
  console.log(`  Target: ${report.metadata.target.label} (family: ${report.metadata.family})`);
  console.log(`  Cases: ${report.metadata.totalCases}   Run: ${report.metadata.runId}`);
  console.log(line);
  console.log(`  Pass Rate: ${s.passCount}/${s.passCount + s.failCount} (${(s.passRate * 100).toFixed(1)}%)`);
  console.log(`  Errors: ${s.errorCount}   textOnlyEndTurn: ${s.textOnlyEndTurnCount}`);
  console.log(`  Avg tool calls: ${s.avgToolCalls.toFixed(2)} (writes ${s.avgWriteToolCalls.toFixed(2)}), avg turns: ${s.avgTurns.toFixed(2)}`);
  console.log(`  Avg latency: ${s.avgLatencyMs.toFixed(0)}ms   Tokens: ${s.totalTokens.input} in / ${s.totalTokens.output} out`);

  console.log(`\n  By Category:`);
  for (const [cat, stats] of Object.entries(s.byCategory)) {
    console.log(`    ${cat.padEnd(16)} ${stats.pass}/${stats.total}`);
  }
  console.log(`\n  By Difficulty:`);
  for (const diff of ['easy', 'medium', 'hard']) {
    const stats = s.byDifficulty[diff];
    if (stats) console.log(`    ${diff.padEnd(16)} ${stats.pass}/${stats.total}`);
  }

  const failures = report.results.filter((r) => !r.passed);
  if (failures.length > 0) {
    console.log(`\n  ❌ Failed Cases:`);
    for (const f of failures) {
      console.log(`    ${f.caseId}: tools=[${f.toolCalls.map((tc) => tc.name + (tc.isError ? '!' : '')).join(', ')}]`);
      if (f.error) console.log(`      → error: ${f.error}`);
      if (f.textOnlyEndTurn) console.log(`      → textOnlyEndTurn`);
      for (const m of f.mismatches) console.log(`      → ${m.path}: ${m.reason}`);
      if (f.extraFiles.length) console.log(`      → extra files: ${f.extraFiles.join(', ')}`);
    }
  }
  console.log(`\n${line}\n`);
}

/**
 * Build aggregated report from raw results.
 */
export function buildReport(
  results: CaseResult[],
  dataset: string,
  targets: EvalTarget[],
): EvalReport {
  const byTarget: Record<string, TargetSummary> = {};
  const byCategory: Record<string, Record<string, CategoryStats>> = {};
  const byDifficulty: Record<string, Record<string, CategoryStats>> = {};

  for (const target of targets) {
    const targetResults = results.filter(r => r.target.label === target.label);
    const passCount = targetResults.filter(r => r.passed).length;
    const failCount = targetResults.length - passCount;

    byTarget[target.label] = {
      passRate: targetResults.length > 0 ? passCount / targetResults.length : 0,
      passCount,
      failCount,
      avgLatencyMs: targetResults.length > 0
        ? targetResults.reduce((sum, r) => sum + r.latencyMs, 0) / targetResults.length
        : 0,
      totalTokens: {
        input: targetResults.reduce((sum, r) => sum + r.tokenUsage.input, 0),
        output: targetResults.reduce((sum, r) => sum + r.tokenUsage.output, 0),
      },
    };
  }

  // Category/difficulty grouping is done by enrichReportWithCaseData() after construction

  return {
    metadata: {
      timestamp: new Date().toISOString(),
      targets,
      dataset,
      totalCases: results.length,
    },
    summary: { byTarget, byCategory, byDifficulty },
    results,
  };
}

/**
 * Build category/difficulty stats from results + original cases.
 */
export function enrichReportWithCaseData(
  report: EvalReport,
  cases: Array<{ id: string; category: string; difficulty: string }>,
): void {
  const caseMap = new Map(cases.map(c => [c.id, c]));

  for (const target of report.metadata.targets) {
    const targetResults = report.results.filter(r => r.target.label === target.label);

    // By category
    if (!report.summary.byCategory[target.label]) {
      report.summary.byCategory[target.label] = {};
    }
    if (!report.summary.byDifficulty[target.label]) {
      report.summary.byDifficulty[target.label] = {};
    }

    for (const result of targetResults) {
      const caseInfo = caseMap.get(result.caseId);
      if (!caseInfo) continue;

      // Category
      const catStats = report.summary.byCategory[target.label];
      if (!catStats[caseInfo.category]) catStats[caseInfo.category] = { pass: 0, total: 0 };
      catStats[caseInfo.category].total++;
      if (result.passed) catStats[caseInfo.category].pass++;

      // Difficulty
      const diffStats = report.summary.byDifficulty[target.label];
      if (!diffStats[caseInfo.difficulty]) diffStats[caseInfo.difficulty] = { pass: 0, total: 0 };
      diffStats[caseInfo.difficulty].total++;
      if (result.passed) diffStats[caseInfo.difficulty].pass++;
    }
  }
}

/**
 * Save report as JSON.
 */
export function saveReport(report: EvalReport): string {
  if (!existsSync(RESULTS_DIR)) {
    mkdirSync(RESULTS_DIR, { recursive: true });
  }

  const date = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
  const targetNames = report.metadata.targets.map(t => t.label.replace(/\s+/g, '-')).join('_vs_');
  const filename = `${date}_${report.metadata.dataset}_${targetNames}.json`;
  const filepath = join(RESULTS_DIR, filename);

  writeFileSync(filepath, JSON.stringify(report, null, 2), 'utf-8');
  return filepath;
}

/**
 * Print CLI report.
 */
export function printReport(report: EvalReport): void {
  const line = '─'.repeat(60);
  console.log(`\n${line}`);
  console.log(`  Abu Agent Eval Report`);
  console.log(`  Dataset: ${report.metadata.dataset} (${report.metadata.totalCases} cases)`);
  console.log(`  Time: ${report.metadata.timestamp}`);
  console.log(line);

  for (const target of report.metadata.targets) {
    const summary = report.summary.byTarget[target.label];
    if (!summary) continue;

    const pct = (summary.passRate * 100).toFixed(1);
    console.log(`\n  📊 ${target.label}`);
    console.log(`     Pass Rate: ${summary.passCount}/${summary.passCount + summary.failCount} (${pct}%)`);
    console.log(`     Avg Latency: ${summary.avgLatencyMs.toFixed(0)}ms`);
    console.log(`     Tokens: ${summary.totalTokens.input} in / ${summary.totalTokens.output} out`);

    // Category breakdown
    const catStats = report.summary.byCategory[target.label];
    if (catStats && Object.keys(catStats).length > 0) {
      console.log(`\n     By Category:`);
      for (const [cat, stats] of Object.entries(catStats)) {
        const catPct = stats.total > 0 ? ((stats.pass / stats.total) * 100).toFixed(0) : '0';
        const bar = '█'.repeat(Math.round(stats.pass / Math.max(stats.total, 1) * 10));
        console.log(`       ${cat.padEnd(12)} ${stats.pass}/${stats.total} (${catPct.padStart(3)}%) ${bar}`);
      }
    }

    // Difficulty breakdown
    const diffStats = report.summary.byDifficulty[target.label];
    if (diffStats && Object.keys(diffStats).length > 0) {
      console.log(`\n     By Difficulty:`);
      for (const diff of ['easy', 'medium', 'hard']) {
        const stats = diffStats[diff];
        if (!stats) continue;
        const diffPct = stats.total > 0 ? ((stats.pass / stats.total) * 100).toFixed(0) : '0';
        console.log(`       ${diff.padEnd(12)} ${stats.pass}/${stats.total} (${diffPct.padStart(3)}%)`);
      }
    }
  }

  // Failed cases
  const failures = report.results.filter(r => !r.passed);
  if (failures.length > 0) {
    console.log(`\n  ❌ Failed Cases:`);
    for (const f of failures) {
      const reasons = [
        ...f.details.missingTools.map(t => `missing: ${t}`),
        ...f.details.forbiddenToolsCalled.map(t => `forbidden: ${t}`),
        ...f.details.paramMismatches,
      ];
      console.log(`     ${f.caseId} [${f.target.label}]`);
      console.log(`       tools called: [${f.toolsCalled.join(', ')}]`);
      for (const reason of reasons) {
        console.log(`       → ${reason}`);
      }
      if (f.error) {
        console.log(`       → error: ${f.error}`);
      }
    }
  }

  console.log(`\n${line}\n`);
}

/**
 * Diff two reports.
 */
export function diffReports(before: EvalReport, after: EvalReport): void {
  const line = '─'.repeat(60);
  console.log(`\n${line}`);
  console.log(`  A/B Comparison`);
  console.log(`  Before: ${before.metadata.timestamp}`);
  console.log(`  After:  ${after.metadata.timestamp}`);
  console.log(line);

  // Match results by caseId
  const beforeMap = new Map(before.results.map(r => [`${r.caseId}:${r.target.label}`, r]));
  const afterMap = new Map(after.results.map(r => [`${r.caseId}:${r.target.label}`, r]));

  const improved: string[] = [];
  const regressed: string[] = [];
  const unchanged = { pass: 0, fail: 0 };

  for (const [key, afterResult] of afterMap) {
    const beforeResult = beforeMap.get(key);
    if (!beforeResult) continue;

    if (!beforeResult.passed && afterResult.passed) {
      improved.push(afterResult.caseId);
    } else if (beforeResult.passed && !afterResult.passed) {
      regressed.push(afterResult.caseId);
    } else if (afterResult.passed) {
      unchanged.pass++;
    } else {
      unchanged.fail++;
    }
  }

  // Pass rate comparison per target
  for (const target of after.metadata.targets) {
    const beforeSummary = before.summary.byTarget[target.label];
    const afterSummary = after.summary.byTarget[target.label];
    if (!beforeSummary || !afterSummary) continue;

    const beforePct = (beforeSummary.passRate * 100).toFixed(1);
    const afterPct = (afterSummary.passRate * 100).toFixed(1);
    const delta = (afterSummary.passRate - beforeSummary.passRate) * 100;
    const arrow = delta > 0 ? '↑' : delta < 0 ? '↓' : '→';
    console.log(`\n  ${target.label}: ${beforePct}% → ${afterPct}% (${delta > 0 ? '+' : ''}${delta.toFixed(1)}%) ${arrow}`);
  }

  if (improved.length > 0) {
    console.log(`\n  ✅ Improved (${improved.length}):`);
    for (const id of improved) console.log(`     ${id}: fail → pass`);
  }

  if (regressed.length > 0) {
    console.log(`\n  ❌ Regressed (${regressed.length}):`);
    for (const id of regressed) console.log(`     ${id}: pass → fail`);
  }

  console.log(`\n  Unchanged: ${unchanged.pass} pass, ${unchanged.fail} fail`);
  console.log(`\n${line}\n`);
}

/**
 * Load a report from eval-results/ by partial filename match.
 */
export function loadReport(nameHint: string): EvalReport | null {
  if (!existsSync(RESULTS_DIR)) return null;

  // Flat files plus the per-family subdirectories.
  const files: string[] = [];
  for (const entry of readdirSync(RESULTS_DIR)) {
    const full = join(RESULTS_DIR, entry);
    if (statSync(full).isDirectory()) {
      for (const inner of readdirSync(full)) {
        if (inner.endsWith('.json') && inner.includes(nameHint)) files.push(join(entry, inner));
      }
    } else if (entry.endsWith('.json') && entry.includes(nameHint)) {
      files.push(entry);
    }
  }
  if (files.length === 0) return null;

  // Take the most recent (file names start with the date)
  files.sort((a, b) => a.split('/').pop()!.localeCompare(b.split('/').pop()!)).reverse();
  const content = readFileSync(join(RESULTS_DIR, files[0]), 'utf-8');
  return JSON.parse(content);
}
