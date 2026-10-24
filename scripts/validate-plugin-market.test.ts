import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { checkMarket } from './validate-plugin-market.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hostVersion = '0.51.0';

describe('validate-plugin-market', () => {
  it.each([
    { plugins: [] },
    { name: 'invalid', plugins: [{ name: 'tool', source: './tool', author: { email: 'a@example.com' } }] },
    { name: 'invalid', apps: [{ name: 'app', source: './app', description: '' }] },
  ])('refuses metadata that the client cannot load: %j', async (manifest) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'abu-market-metadata-'));
    try {
      mkdirSync(path.join(dir, '.abu-plugin'));
      writeFileSync(path.join(dir, '.abu-plugin', 'marketplace.json'), JSON.stringify(manifest));
      await expect(checkMarket(dir, { hostVersion })).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes the official market and the example market', async () => {
    const official = await checkMarket(path.join(repoRoot, 'builtin-plugin-market'), { hostVersion });
    expect(official.failures.map(String)).toEqual([]);
    expect(official.checked.map(entry => `${entry.kind} ${entry.name}`)).toEqual([
      'plugin abu-prd-doctor',
      'plugin ecommerce',
      'app ecommerce',
    ]);

    const examples = await checkMarket(path.join(repoRoot, 'examples', 'plugin-market'), { hostVersion });
    expect(examples.failures.map(String)).toEqual([]);
    expect(examples.checked.map(entry => `${entry.kind} ${entry.name}`)).toEqual(['plugin shop-assistant', 'app shop-ops']);
  });

  it('identifies an unsupported description locale before scanning packages', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'abu-market-locale-'));
    try {
      mkdirSync(path.join(dir, '.abu-plugin'));
      writeFileSync(path.join(dir, '.abu-plugin', 'marketplace.json'), JSON.stringify({
        name: 'invalid-locale', apps: [{ name: 'app', source: './app', description: { 'fr-FR': 'Description' } }],
      }));
      await expect(checkMarket(dir, { hostVersion })).rejects.toThrow('apps[0].description.fr-FR');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names the failing field for every broken fixture entry', async () => {
    const result = await checkMarket(path.join(repoRoot, 'tests', 'fixtures', 'plugin-market-broken'), { hostVersion });
    const byEntry = new Map<string, string[]>();
    for (const failure of result.failures) byEntry.set(failure.entry, [...(byEntry.get(failure.entry) ?? []), failure.field ?? '']);
    expect(byEntry.get('missing-min-version')).toEqual(['minAbuVersion']);
    // The scan reads a package by the rules the renderer installs it by, so a
    // name or a connector map the installer would refuse is refused here and
    // the market never lists a package nobody can install.
    expect(byEntry.get('unsafe-skill-name')).toEqual(['skills/tools']);
    expect(byEntry.get('bad-mcp-shape')).toEqual(['mcpServers']);
    // An app's plugin references are checked against what the plugin ships,
    // and its plugins against the markets it can be added from.
    expect(byEntry.get('app wrong-ref')).toContain('home.modes.items[0].scenes[0].run.team');
    expect(byEntry.get('app unknown-plugin')).toContain('plugins[0]');
    expect(byEntry.get('app version-drift')).toContain('version');
  });

  it('reports an app that needs a newer Abu', async () => {
    const result = await checkMarket(path.join(repoRoot, 'examples', 'plugin-market'), { hostVersion: '0.50.0' });
    expect(result.failures.map(failure => `${failure.entry} ${failure.field}`)).toEqual(['shop-assistant minAbuVersion', 'app shop-ops minAbuVersion']);
  });
});
