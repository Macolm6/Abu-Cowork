// Allowlist-aware gate over `npm audit --json`.
//
// npm audit has no way to accept a finding that has no upstream fix (e.g. an
// advisory whose patched_versions is null). Without that, the audit job is
// permanently red and stops carrying signal. This script fails on any
// high/critical finding that is not covered by an unexpired allowlist entry,
// and also fails when an entry has expired, so every acceptance gets re-reviewed.
//
// It takes one report per audited lockfile. The allowlist is shared, so an entry
// is reported as unused only when no report matches it.
//
//   npm audit --omit=dev --json > audit.json || true
//   node scripts/npm-audit-check.mjs audit.json [sub/audit.json ...] [--allowlist=path] [--asof=YYYY-MM-DD]
//
// Allowlist shape (.github/npm-audit-allowlist.json):
//   { "entries": [ { "ghsa", "package", "reason", "expires" } ] }
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_ALLOWLIST_PATH = '.github/npm-audit-allowlist.json';
const BLOCKING_SEVERITIES = new Set(['high', 'critical']);
const GHSA_PATTERN = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function ghsaIdFromUrl(url) {
  const match = typeof url === 'string' ? url.match(GHSA_PATTERN) : null;
  return match ? match[0].toUpperCase() : null;
}

function assertIsoDate(value, label) {
  if (typeof value !== 'string' || !ISO_DATE_PATTERN.test(value)) {
    throw new Error(`${label} must be YYYY-MM-DD, got ${JSON.stringify(value)}`);
  }
  return value;
}

export function parseAllowlist(allowlist, asOf) {
  assertIsoDate(asOf, 'asOf');
  const entries = allowlist?.entries;
  if (!Array.isArray(entries)) {
    throw new Error('allowlist must be an object with an "entries" array');
  }
  const active = new Map();
  const expired = [];
  for (const entry of entries) {
    for (const field of ['ghsa', 'package', 'reason', 'expires']) {
      if (typeof entry?.[field] !== 'string' || entry[field].trim() === '') {
        throw new Error(`allowlist entry is missing "${field}": ${JSON.stringify(entry)}`);
      }
    }
    const ghsa = ghsaIdFromUrl(entry.ghsa);
    if (!ghsa) {
      throw new Error(`allowlist entry has a malformed GHSA id: ${entry.ghsa}`);
    }
    assertIsoDate(entry.expires, `allowlist entry ${ghsa} "expires"`);
    // ISO dates compare correctly as strings.
    if (entry.expires < asOf) {
      expired.push({ ...entry, ghsa });
    } else {
      active.set(ghsa, { ...entry, ghsa });
    }
  }
  return { active, expired };
}

// reports: [{ source, report }], one per audited lockfile; source names it in the output.
export function evaluateAudit(reports, allowlist, asOf) {
  if (!Array.isArray(reports) || reports.length === 0) {
    throw new Error('evaluateAudit needs at least one { source, report }');
  }
  const { active, expired } = parseAllowlist(allowlist, asOf);
  const usedEntries = new Set();
  const sources = reports.map(({ source, report }) => ({
    source,
    ...evaluateReport(source, report, active, usedEntries),
  }));
  const unused = [...active.values()].filter((entry) => !usedEntries.has(entry.ghsa));
  return {
    sources,
    blocking: sources.flatMap((item) => item.blocking),
    allowlisted: sources.flatMap((item) => item.allowlisted),
    expired,
    unused,
    asOf,
  };
}

function evaluateReport(source, report, active, usedEntries) {
  if (!report || typeof report !== 'object' || !report.vulnerabilities || typeof report.vulnerabilities !== 'object') {
    const detail = report?.error ? ` (npm reported: ${JSON.stringify(report.error)})` : '';
    throw new Error(`audit report ${source} has no "vulnerabilities" object${detail}`);
  }
  const vulnerabilities = report.vulnerabilities;
  const coveredByName = new Map();

  // A package is covered when every path that makes it vulnerable is covered:
  // advisory objects by an active allowlist entry for that package, string
  // entries (transitive "via <package>") by that package being covered.
  function isCovered(name, stack) {
    if (coveredByName.has(name)) return coveredByName.get(name);
    if (stack.has(name)) return false;
    const vulnerability = vulnerabilities[name];
    if (!vulnerability || !Array.isArray(vulnerability.via) || vulnerability.via.length === 0) return false;
    stack.add(name);
    let covered = true;
    for (const via of vulnerability.via) {
      if (typeof via === 'string') {
        if (!isCovered(via, stack)) covered = false;
        continue;
      }
      const ghsa = ghsaIdFromUrl(via.url);
      const entry = ghsa ? active.get(ghsa) : null;
      if (entry && entry.package === via.name) {
        usedEntries.add(ghsa);
      } else {
        covered = false;
      }
    }
    stack.delete(name);
    coveredByName.set(name, covered);
    return covered;
  }

  const blocking = [];
  const allowlisted = [];
  for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
    if (!BLOCKING_SEVERITIES.has(vulnerability.severity)) continue;
    const advisories = vulnerability.via
      .filter((via) => typeof via === 'object' && via !== null)
      .map((via) => ({ ghsa: ghsaIdFromUrl(via.url), title: via.title, range: via.range }));
    const viaPackages = vulnerability.via.filter((via) => typeof via === 'string');
    const item = { source, name, severity: vulnerability.severity, advisories, viaPackages };
    (isCovered(name, new Set()) ? allowlisted : blocking).push(item);
  }
  return { blocking, allowlisted };
}

export function formatReport(result) {
  const lines = ['### npm audit (production, high+, allowlist-aware)', ''];
  const describe = (item) => {
    const advisories = item.advisories.map((advisory) => `${advisory.ghsa ?? '?'} ${advisory.title ?? ''}`.trim());
    const via = item.viaPackages.map((name) => `via ${name}`);
    return `- **${item.name}** (${item.severity}): ${[...advisories, ...via].join('; ')}`;
  };
  for (const { source, blocking, allowlisted } of result.sources) {
    lines.push(`#### \`${source}\``, '');
    if (blocking.length > 0) {
      lines.push(`❌ ${blocking.length} blocking finding(s) not covered by the allowlist:`);
      lines.push(...blocking.map(describe));
      lines.push('');
    }
    if (allowlisted.length > 0) {
      lines.push(`⚠️ ${allowlisted.length} finding(s) accepted by allowlist (see ${DEFAULT_ALLOWLIST_PATH}):`);
      lines.push(...allowlisted.map(describe));
      lines.push('');
    }
    if (blocking.length === 0) {
      lines.push(allowlisted.length === 0 ? '✅ no high/critical findings.' : '✅ no unaccepted high/critical findings.', '');
    }
  }
  if (result.expired.length > 0) {
    lines.push(`❌ ${result.expired.length} allowlist entr${result.expired.length === 1 ? 'y' : 'ies'} expired (as of ${result.asOf}) — re-review and extend or remove:`);
    lines.push(...result.expired.map((entry) => `- ${entry.ghsa} (${entry.package}) expired ${entry.expires}: ${entry.reason}`));
    lines.push('');
  }
  if (result.unused.length > 0) {
    lines.push(`ℹ️ ${result.unused.length} allowlist entr${result.unused.length === 1 ? 'y' : 'ies'} no longer matched by any audited lockfile — safe to delete:`);
    lines.push(...result.unused.map((entry) => `- ${entry.ghsa} (${entry.package})`));
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function parseArgs(argv) {
  const options = { reportPaths: [], allowlistPath: DEFAULT_ALLOWLIST_PATH, asOf: null };
  for (const arg of argv) {
    if (arg.startsWith('--allowlist=')) options.allowlistPath = arg.slice('--allowlist='.length);
    else if (arg.startsWith('--asof=')) options.asOf = arg.slice('--asof='.length);
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else options.reportPaths.push(arg);
  }
  if (options.reportPaths.length === 0) {
    throw new Error('usage: node scripts/npm-audit-check.mjs <audit.json> [sub/audit.json ...] [--allowlist=path] [--asof=YYYY-MM-DD]');
  }
  return options;
}

export function runCli(argv, { cwd = process.cwd(), env = process.env, today } = {}) {
  const options = parseArgs(argv);
  const asOf = options.asOf ?? env.NPM_AUDIT_ASOF ?? today ?? new Date().toISOString().slice(0, 10);
  const reports = options.reportPaths.map((source) => ({
    source,
    report: JSON.parse(readFileSync(path.resolve(cwd, source), 'utf8')),
  }));
  const allowlist = JSON.parse(readFileSync(path.resolve(cwd, options.allowlistPath), 'utf8'));
  const result = evaluateAudit(reports, allowlist, asOf);
  return { result, output: formatReport(result), ok: result.blocking.length === 0 && result.expired.length === 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { output, ok } = runCli(process.argv.slice(2));
    console.log(output);
    process.exitCode = ok ? 0 : 1;
  } catch (error) {
    console.error(`npm-audit-check: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
