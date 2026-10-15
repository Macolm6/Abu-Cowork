import { beforeEach, describe, expect, it, vi } from 'vitest';
import { exists, readTextFile } from '@tauri-apps/plugin-fs';
import { getI18n, initLanguage } from '@/i18n';
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
    expect(result.listings[0].invalid).toBe(getI18n().appMarket.remoteNeedsSha.replace('{name}', 'remote-app'));
  });
});
