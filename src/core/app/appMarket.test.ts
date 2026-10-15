import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { exists, readTextFile } from '@tauri-apps/plugin-fs';
import { initLanguage } from '@/i18n';
import type { Marketplace } from '@/core/plugin/marketplace';
import * as marketplaceReader from '@/core/plugin/loadMarketplace';
import type { MarketplaceRef } from '@/stores/pluginStore';
import type { RefCatalog } from './appRefs';
import { loadAppListings } from './appMarket';

const catalog: RefCatalog = { plugins: [], teams: [], getAgent: () => undefined, findManagedAgent: () => undefined, skillNames: new Set(), enterpriseSkillNames: new Set() };
const files = new Map<string, string>();
const market = { name: 'remote-market', dir: '/markets/remote' };

beforeEach(() => {
  initLanguage('zh-CN');
  files.clear();
  vi.mocked(exists).mockImplementation(async (path) => files.has(String(path)));
  vi.mocked(readTextFile).mockImplementation(async (path) => {
    const file = files.get(String(path));
    if (file === undefined) throw new Error(`Missing file: ${path}`);
    return file;
  });
});
afterEach(() => { initLanguage('en-US'); vi.restoreAllMocks(); });

describe('remote application listings', () => {
  it.each(['url', 'git-subdir'])('lists pinned %s metadata and identifies applications needing a newer host', async (source) => {
    files.set(`${market.dir}/.abu-plugin/marketplace.json`, JSON.stringify({ name: market.name, apps: [{
      name: 'remote-app', description: 'Remote application', version: '2.0.0', minAbuVersion: '99.0.0',
      source: { source, url: 'https://example.com/app.git', path: 'apps/remote', sha: 'a'.repeat(40) },
    }] }));
    const result = await loadAppListings([market], catalog);
    expect(result.failures).toEqual([]);
    expect(result.listings).toEqual([expect.objectContaining({ appId: 'remote-app@remote-market', description: 'Remote application', version: '2.0.0', needsUpgrade: true })]);
    expect(result.listings[0].invalid).toBeUndefined();
  });

  it('marks an unpinned remote app unavailable before the user starts adding it', async () => {
    files.set(`${market.dir}/.abu-plugin/marketplace.json`, JSON.stringify({ name: market.name, apps: [{
      name: 'remote-app', version: '1.0.0', description: 'Remote application', minAbuVersion: '0.51.0', source: { source: 'url', url: 'https://example.com/app.zip' },
    }] }));
    const result = await loadAppListings([market], catalog);
    expect(result.listings[0].invalid).toBe(true);
  });
});

const acme: MarketplaceRef = { name: 'acme', dir: '/Users/testuser/.abu/markets/acme' };
const gone: MarketplaceRef = { name: 'gone', dir: '/Users/testuser/.abu/markets/gone' };
const listed: Marketplace = {
  name: 'acme',
  plugins: [],
  apps: [{ name: 'broken', source: { kind: 'relative', path: './apps/broken' }, version: '1.0.0' }],
};

describe('loadAppListings', () => {
  let warn: MockInstance<typeof console.warn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(marketplaceReader, 'loadMarketplaceFromDir');
  });
  afterEach(() => { warn.mockRestore(); });

  it('marks an app whose own file does not read, and sends what the parser said to the console only', async () => {
    vi.mocked(marketplaceReader.loadMarketplaceFromDir).mockResolvedValue(listed);
    vi.mocked(readTextFile).mockResolvedValueOnce('{ "name": "broken" }');

    const result = await loadAppListings([acme], catalog);

    expect(result.failures).toEqual([]);
    expect(result.listings).toHaveLength(1);
    expect(result.listings[0]).toMatchObject({ appId: 'broken@acme', name: 'broken', invalid: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe('[app] read app "broken" of market "acme" failed:');
  });

  it('names a market whose list cannot be read, keeps the others, and sends the reason to the console only', async () => {
    vi.mocked(marketplaceReader.loadMarketplaceFromDir).mockImplementation(async (dir) => {
      if (dir === gone.dir) throw new Error(`Marketplace manifest is not valid JSON: ${gone.dir}/.abu-plugin/marketplace.json`);
      return { name: 'acme', plugins: [], apps: [] };
    });

    const result = await loadAppListings([gone, acme], catalog);

    expect(result).toEqual({ listings: [], failures: [{ market: gone }] });
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '[app] read market "gone" failed:',
      `Marketplace manifest is not valid JSON: ${gone.dir}/.abu-plugin/marketplace.json`,
    );
  });
});
