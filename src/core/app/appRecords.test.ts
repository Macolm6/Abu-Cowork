// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { locks } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { invoke } from '@tauri-apps/api/core';
import { homeDir } from '@tauri-apps/api/path';
import { useAppStore } from '@/stores/appStore';
import { usePluginStore } from '@/stores/pluginStore';
import { useAppAddFlowStore } from '@/stores/appAddFlowStore';
import { useAppDraftStore } from '@/stores/appDraftStore';
import { useTeamStore } from '@/stores/teamStore';
import { agentRegistry } from '@/core/agent/registry';
import { planInstall, releasePreparedInstall } from '@/core/plugin/installer';
import { commitAppDraft } from './appDraft';
import { GENERAL_APP_ID } from '@/types/app';
import { copyFile, exists, lstat, mkdir, readDir, readFile, readTextFile, remove, rename, writeFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { addedAppId, addedAppsPath, appDir, loadAddedApps, readAddedApps, removeAddedApp, saveAddedApp, type AddedAppRecord } from './appRecords';
import { cancelAddApp, confirmAddApp, planAddApp } from './appInstaller';

let root: string;
let source: string;
const operationHosts: Array<{ shutdown: () => Promise<void> }> = [];
type Mutation = (input: unknown) => Promise<unknown>;
const { createPluginSnapshotHost } = createRequire(import.meta.url)('../../../electron/pluginSnapshotHost.cjs') as {
  createPluginSnapshotHost: (options: { home: string; mutate?: Mutation }) => Record<string, (sender: EventEmitter, request: object) => Promise<unknown>>;
};
const { createPluginRegistryHost } = createRequire(import.meta.url)('../../../electron/pluginRegistryHost.cjs') as {
  createPluginRegistryHost: (options: { home: string; mutate?: Mutation }) => { dispatch: (action: string, request: object) => Promise<unknown> };
};
const { createOperationSession } = createRequire(import.meta.url)('../../../electron/pluginOperationSession.cjs') as {
  createOperationSession: (home: string) => { mutate: Mutation; registry: Mutation };
};
const { createPluginOperationHost } = createRequire(import.meta.url)('../../../electron/pluginOperationHost.cjs') as {
  createPluginOperationHost: (options: { home: string; registry: object; snapshots: object; session: object;
    encrypt: (value: string) => Buffer; decrypt: (value: Buffer) => string }) => {
    dispatch: (sender: EventEmitter, action: string, request: object) => Promise<unknown>;
    materialize: (sender: EventEmitter, request: object) => Promise<unknown>;
    external: (action: string, actionBody: () => Promise<unknown>) => Promise<unknown>;
    shutdown: () => Promise<void>;
  };
};

/** The plugin-fs calls the module makes, served by the real disk under a temp root. */
function useRealTree() {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command !== 'atomic_write_text') throw new Error(`Unexpected command: ${command}`);
    const { path, content } = args as { path: string; content: string };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  });
  vi.mocked(readTextFile).mockImplementation(async (p) => readFileSync(String(p), 'utf8'));
  vi.mocked(readFile).mockImplementation(async (p) => new Uint8Array(readFileSync(String(p))));
  vi.mocked(writeFile).mockImplementation(async (p, data) => { writeFileSync(String(p), data as Uint8Array); });
  vi.mocked(writeTextFile).mockImplementation(async (p, data, options) => {
    writeFileSync(String(p), data, { flag: options?.createNew ? 'wx' : options?.create === false ? 'r+' : 'w' });
  });
  vi.mocked(copyFile).mockImplementation(async (from, to) => { writeFileSync(String(to), readFileSync(String(from))); });
  vi.mocked(readDir).mockImplementation(async (p) => readdirSync(String(p), { withFileTypes: true }).map((d) => ({
    name: d.name, isDirectory: d.isDirectory(), isFile: d.isFile(), isSymlink: d.isSymbolicLink(),
  })) as never);
  vi.mocked(mkdir).mockImplementation(async (p) => { mkdirSync(String(p), { recursive: true }); });
  vi.mocked(exists).mockImplementation(async (p) => existsSync(String(p)));
  vi.mocked(lstat).mockImplementation(async (p) => ({ isSymlink: lstatSync(String(p)).isSymbolicLink(), isDirectory: lstatSync(String(p)).isDirectory(), isFile: lstatSync(String(p)).isFile() }) as never);
  vi.mocked(remove).mockImplementation(async (p) => { rmSync(String(p), { recursive: true, force: true }); });
  vi.mocked(rename).mockImplementation(async (from, to) => { renameSync(String(from), String(to)); });
}

function writeApp(dir: string, overrides: Record<string, unknown> = {}) {
  mkdirSync(join(dir, '.abu-app'), { recursive: true });
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'assets', 'logo.png'), 'png');
  writeFileSync(join(dir, '.abu-app', 'app.json'), JSON.stringify({
    name: 'contract-review',
    version: '1.0.0',
    minAbuVersion: '0.51.0',
    interface: { displayName: '合同审阅', shortDescription: '按律所的做法审合同', logo: 'assets/logo.png' },
    home: { modes: { items: [{ modeId: 'm', title: 'M', scenes: [{ id: 's', title: 'S', run: { team: 'builtin-team:reporting' }, templates: [{ id: 'a', title: 'A', prompt: 'A' }, { id: 'b', title: 'B', prompt: 'B' }, { id: 'c', title: 'C', prompt: 'C' }] }] }] } },
    ...overrides,
  }));
}

function record(overrides: Partial<AddedAppRecord> = {}): AddedAppRecord {
  return { appId: 'contract-review@lawyer-market', name: 'contract-review', version: '1.0.0', origin: { kind: 'market', market: 'lawyer-market' }, addedAt: '2026-09-28T00:00:00.000Z', ...overrides };
}

beforeEach(() => {
  Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
  root = mkdtempSync(join(tmpdir(), 'abu-app-records-'));
  source = join(root, 'source');
  writeApp(source);
  useRealTree();
  vi.mocked(homeDir).mockResolvedValue(root);
  useAppStore.setState({ addedApps: [], managedApps: {}, selectedAppId: GENERAL_APP_ID });
  usePluginStore.setState({ installed: [], marketplaces: [] });
  useAppAddFlowStore.setState({ flow: { kind: 'closed' }, running: false });
});

afterEach(async () => {
  for (const host of operationHosts.splice(0)) await host.shutdown();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

describe('addedAppId', () => {
  it('names an app by its name and where it came from', () => {
    expect(addedAppId('contract-review', { kind: 'market', market: 'lawyer-market' })).toBe('contract-review@lawyer-market');
    expect(addedAppId('contract-review', { kind: 'folder', dir: '/work/app' })).toBe('contract-review@local');
    expect(addedAppId('weekly', { kind: 'created', authoringId: 'a1' })).toBe('weekly@mine');
  });

  it('refuses an id that would not stay one directory', () => {
    expect(() => appDir(root, '../escape')).toThrow('cannot name a directory');
    expect(() => appDir(root, '..')).toThrow('cannot name a directory');
  });
});

describe('saving, loading and removing', () => {
  it('removes a failed draft publication and allows its experts and team to be created on retry', async () => {
    useTeamStore.setState({ teams: [] });
    useAppDraftStore.setState({ draftsByConversation: {} });
    await usePluginStore.getState().refreshInstalled(root);
    await agentRegistry.discoverAgents();
    mkdirSync(join(source, 'agents'), { recursive: true });
    mkdirSync(join(source, 'teams'), { recursive: true });
    writeFileSync(join(source, 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Review documents\n---\nReview the supplied documents.\n');
    writeFileSync(join(source, 'teams', 'review.json'), JSON.stringify({
      name: 'Draft review team', description: 'Review documents together', leader: 'reviewer', members: ['reviewer', 'builtin:产品经理'],
    }));
    writeApp(source, { home: { modes: { items: [{ modeId: 'm', title: 'M', scenes: [{
      id: 's', title: 'S', run: { team: 'mine:review' }, templates: [
        { id: 'a', title: 'A', prompt: 'A' }, { id: 'b', title: 'B', prompt: 'B' }, { id: 'c', title: 'C', prompt: 'C' },
      ],
    }] }] } } });
    useAppDraftStore.getState().record('draft-conversation', { id: 'draft', dir: source, createdAt: '2026-10-11T00:00:00Z' });
    const atomicInvoke = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'atomic_write_text' && (args as { path: string }).path === addedAppsPath(root)) throw new Error('app record write failed');
      return atomicInvoke(command, args);
    });
    await expect(commitAppDraft('draft-conversation')).rejects.toThrow('app record write failed');
    expect(useTeamStore.getState().teams).toEqual([]);
    expect(existsSync(join(root, '.abu', 'agents', 'reviewer', 'AGENT.md'))).toBe(false);
    expect(await readAddedApps(root)).toEqual([]);
    expect(useAppDraftStore.getState().draftsByConversation['draft-conversation'].appId).toBeUndefined();
    vi.mocked(invoke).mockImplementation(atomicInvoke);
    expect(await commitAppDraft('draft-conversation')).toBe('contract-review@mine');
    expect(useTeamStore.getState().teams).toHaveLength(1);
    expect(existsSync(join(root, '.abu', 'agents', 'reviewer', 'AGENT.md'))).toBe(true);
    expect((await loadAddedApps(root))[0].config.home?.modes?.items[0].scenes[0].run).toEqual({ team: `mine:${useTeamStore.getState().teams[0].id}` });
    expect(useAppDraftStore.getState().draftsByConversation['draft-conversation'].appName).toBe('合同审阅');
    expect(readdirSync(join(root, '.abu', 'apps', '.prepared'))).toEqual([]);
  });

  it.each(['new', 'update', 'other-market'] as const)('compensates publication failure and preserves existing dependencies: %s', async (mode) => {
    const updating = mode === 'update';
    const previouslyInstalled = mode !== 'new';
    const market = join(root, 'tools-market');
    mkdirSync(join(market, '.abu-plugin'), { recursive: true });
    const entries = ['review-tools', 'supplement-tools'].map((name) => ({ name, source: `./${name}` }));
    writeFileSync(join(market, '.abu-plugin', 'marketplace.json'), JSON.stringify({ name: 'tools-market', description: 'Review tools', plugins: entries }));
    const writePlugin = (name: string, version: string, skill: string) => {
      const dir = join(market, name);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(join(dir, '.abu-plugin'), { recursive: true });
      mkdirSync(join(dir, 'skills', skill), { recursive: true });
      writeFileSync(join(dir, '.abu-plugin', 'plugin.json'), JSON.stringify({ name, version }));
      writeFileSync(join(dir, 'skills', skill, 'SKILL.md'), `---\nname: ${skill}\ndescription: Review a document\n---\nReview the document.\n`);
    };
    writePlugin('review-tools', previouslyInstalled ? '1.0.0' : '2.0.0', previouslyInstalled ? 'old-review' : 'review');
    writePlugin('supplement-tools', '1.0.0', 'extra');
    const session = createOperationSession(root);
    const host = createPluginSnapshotHost({ home: root, mutate: input => session.mutate(input) });
    const registry = createPluginRegistryHost({ home: root, mutate: input => session.registry(input) });
    const operations = createPluginOperationHost({ home: root, registry, snapshots: host, session,
      encrypt: value => Buffer.from(value), decrypt: value => value.toString() });
    operationHosts.push(operations);
    const sender = new EventEmitter();
    vi.stubGlobal('__ABU_SHELL__', {
      pluginRegistry: (action: string, request: object) => operations.external(action, () => registry.dispatch(action, request)),
      pluginOperation: (action: string, request: object) => operations.dispatch(sender, action, request),
      pluginSnapshot: async (action: string, request: { token?: string }) => {
        return action === 'materialize' ? operations.materialize(sender, request) : host[action](sender, request);
      },
    });
    usePluginStore.setState({ marketplaces: [{ name: 'tools-market', dir: market }] });
    if (previouslyInstalled) {
      const entry = { name: 'review-tools', source: { kind: 'relative' as const, path: './review-tools' } };
      const previousName = updating ? 'tools-market' : 'other-market';
      const previousDir = updating ? market : join(root, 'other-market');
      if (!updating) {
        cpSync(market, previousDir, { recursive: true });
        writeFileSync(join(previousDir, '.abu-plugin', 'marketplace.json'), JSON.stringify({ name: previousName, plugins: entries }));
      }
      const options = { home: root, marketplaceName: previousName, marketplaceDir: previousDir, entry, prepareSnapshot: true };
      const disclosure = await planInstall(options);
      await usePluginStore.getState().install({ ...options, preparedToken: disclosure.preparedToken });
      await releasePreparedInstall(disclosure.preparedToken!);
      writePlugin('review-tools', '2.0.0', 'review');
    }
    writeApp(source, { plugins: ['review-tools', ...(updating ? ['supplement-tools'] : [])], home: { modes: { items: [{ modeId: 'm', title: 'M', scenes:
      (updating ? ['review-tools/review', 'supplement-tools/extra'] : ['review-tools/review']).map((skill, index) => ({
        id: `s${index}`, title: 'Review', run: { skill: `plugin:${skill}` }, templates: [
          { id: 'a', title: 'A', prompt: 'A' }, { id: 'b', title: 'B', prompt: 'B' }, { id: 'c', title: 'C', prompt: 'C' },
        ],
      })),
    }] } } });
    const plan = await planAddApp({ kind: 'folder', dir: source }, root);
    if (updating) expect(plan.steps.map((step) => step.kind)).toEqual(['install', 'update']);
    const atomicInvoke = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'atomic_write_text' && (args as { path: string }).path === addedAppsPath(root)) throw new Error('app record write failed');
      return atomicInvoke(command, args);
    });
    await expect(confirmAddApp(plan, root, {})).rejects.toThrow('app record write failed');
    expect(usePluginStore.getState().installed.map(({ key, version }) => ({ key, version }))).toEqual(previouslyInstalled
      ? [{ key: `review-tools@${updating ? 'tools-market' : 'other-market'}`, version: updating ? '2.0.0' : '1.0.0' }] : []);
    expect(await readAddedApps(root)).toEqual([]);
    expect(existsSync(plan.sourceDir)).toBe(false);
    expect(readdirSync(join(root, '.abu', 'plugin-prepared'))).toEqual([]);
  });

  it('keeps the latest request while an earlier request is releasing an old preview', async () => {
    const previous = await planAddApp({ kind: 'folder', dir: source }, root);
    useAppAddFlowStore.setState({ flow: { kind: 'ready', purpose: 'preview', plan: previous } });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const removeFile = vi.mocked(remove).getMockImplementation()!;
    vi.mocked(remove).mockImplementation(async (path, options) => {
      if (path === previous.preparedDir) await pending;
      return removeFile(path, options);
    });
    const older = useAppAddFlowStore.getState().start({ kind: 'folder', dir: source }, 'Older', 'preview');
    const latestDir = join(root, 'latest');
    writeApp(latestDir, { name: 'latest' });
    await useAppAddFlowStore.getState().start({ kind: 'folder', dir: latestDir }, 'Latest', 'preview');
    release();
    await older;
    expect(useAppAddFlowStore.getState().flow).toMatchObject({ kind: 'ready', plan: { appId: 'latest@local' } });
    await useAppAddFlowStore.getState().cancel();
  });

  it('checks expert and skill references against the real plugin snapshot disclosure', async () => {
    const market = join(root, 'market');
    cpSync(join(process.cwd(), 'examples/plugin-market'), market, { recursive: true });
    const host = createPluginSnapshotHost({ home: root });
    const sender = new EventEmitter();
    vi.stubGlobal('__ABU_SHELL__', { pluginSnapshot: async (action: string, request: object) => host[action](sender, request) });
    usePluginStore.setState({ marketplaces: [{ name: 'abu-examples', dir: market }] });
    writeApp(source, { plugins: ['shop-assistant'], home: { modes: { items: [{ modeId: 'm', title: 'M', scenes: [{
      id: 's', title: 'S', run: { expert: 'plugin:shop-assistant/店铺客服顾问', skill: 'plugin:shop-assistant/product-listing' },
      templates: [{ id: 'a', title: 'A', prompt: 'A' }, { id: 'b', title: 'B', prompt: 'B' }, { id: 'c', title: 'C', prompt: 'C' }],
    }] }] } } });
    const plan = await planAddApp({ kind: 'folder', dir: source }, root);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].disclosure.agents.map((agent) => agent.name)).toContain('店铺客服顾问');
    expect(plan.steps[0].disclosure.skills).toContain('product-listing');
    await cancelAddApp(plan);
    expect(readdirSync(join(root, '.abu', 'plugin-prepared'))).toEqual([]);
  });

  it.each(['url', 'git-subdir'] as const)('prepares and releases a pinned remote %s application', async (kind) => {
    const atomicInvoke = vi.mocked(invoke).getMockImplementation()!;
    let fetched = '';
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command !== 'plugin_git_fetch') return atomicInvoke(command, args);
      fetched = (args as { destDir: string }).destDir;
      cpSync(source, fetched, { recursive: true });
      return { destDir: fetched, sha: 'a'.repeat(40) };
    });
    const remote = kind === 'url'
      ? { kind, url: 'https://example.com/app.zip', sha: 'a'.repeat(40) }
      : { kind, url: 'https://example.com/apps.git', path: 'apps/contract-review', sha: 'a'.repeat(40) };
    const plan = await planAddApp({ kind: 'market', market: { name: 'lawyer-market', dir: root }, entry: { name: 'contract-review', version: '1.0.0', source: remote } }, root);
    expect(existsSync(fetched)).toBe(false);
    expect(existsSync(plan.sourceDir)).toBe(true);
    await confirmAddApp(plan, root, {});
    expect(existsSync(plan.sourceDir)).toBe(false);
    expect(useAppStore.getState().selectedAppId).toBe('contract-review@lawyer-market');
  });

  it('replaces a folder application with the new version while preserving the current selection', async () => {
    const first = await planAddApp({ kind: 'folder', dir: source }, root);
    await confirmAddApp(first, root, {});
    expect(useAppStore.getState().selectedAppId).toBe('contract-review@local');
    useAppStore.getState().exitApp();
    const selected = useAppStore.getState().selectedAppId;
    writeApp(source, { version: '2.0.0' });
    const update = await planAddApp({ kind: 'folder', dir: source }, root);
    expect(update.replacing).toBe(true);
    await confirmAddApp(update, root, {});
    expect(useAppStore.getState().selectedAppId).toBe(selected);
    expect(await readAddedApps(root)).toEqual([expect.objectContaining({ version: '2.0.0', origin: { kind: 'folder', dir: source } })]);
  });

  it.each([
    { name: 'another-app', version: '1.0.0' },
    { name: 'contract-review', version: '2.0.0' },
    { name: 'contract-review', version: '1.0.0', minAbuVersion: '0.52.0' },
  ])('refuses remote contents that differ from the listing and releases their copies: %j', async (metadata) => {
    let fetched = '';
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command !== 'plugin_git_fetch') throw new Error(`Unexpected command: ${command}`);
      fetched = (args as { destDir: string }).destDir;
      cpSync(source, fetched, { recursive: true });
      return { destDir: fetched, sha: 'a'.repeat(40) };
    });
    await expect(planAddApp({ kind: 'market', market: { name: 'lawyer-market', dir: root }, entry: {
      ...metadata, source: { kind: 'url', url: 'https://example.com/app.zip', sha: 'a'.repeat(40) },
    } }, root)).rejects.toThrow();
    expect(existsSync(fetched)).toBe(false);
    expect(readdirSync(join(root, '.abu', 'apps', '.prepared'))).toEqual([]);
    expect(await readAddedApps(root)).toEqual([]);
  });

  it('refuses a linked manifest directory before presenting an install plan', async () => {
    const external = join(root, 'shared-manifest');
    renameSync(join(source, '.abu-app'), external);
    symlinkSync(external, join(source, '.abu-app'), 'junction');
    await expect(planAddApp({ kind: 'folder', dir: source }, root)).rejects.toThrow('regular files');
    expect(await readAddedApps(root)).toEqual([]);
    expect(readdirSync(join(root, '.abu', 'apps', '.prepared'))).toEqual([]);
    expect(existsSync(join(external, 'app.json'))).toBe(true);
  });

  it('installs the reviewed copy after its source changes', async () => {
    const plan = await planAddApp({ kind: 'folder', dir: source }, root);
    writeApp(source, { version: '2.0.0' });
    await saveAddedApp(root, plan.sourceDir, record());
    expect((await loadAddedApps(root))[0].version).toBe('1.0.0');
    await cancelAddApp(plan);
    expect(existsSync(plan.sourceDir)).toBe(false);
  });

  it('keeps both records when two applications are saved concurrently', async () => {
    const other = join(root, 'other');
    writeApp(other, { name: 'weekly' });
    await Promise.all([
      saveAddedApp(root, source, record()),
      saveAddedApp(root, other, record({ appId: 'weekly@local', name: 'weekly', origin: { kind: 'folder', dir: other } })),
    ]);
    expect((await readAddedApps(root)).map((item) => item.name).sort()).toEqual(['contract-review', 'weekly']);
  });

  it('restores the installed files when recording an update fails', async () => {
    await saveAddedApp(root, source, record());
    writeApp(source, { version: '2.0.0' });
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command !== 'atomic_write_text') throw new Error(`Unexpected command: ${command}`);
      const { path, content } = args as { path: string; content: string };
      if (path === addedAppsPath(root)) throw new Error('Disk full');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    });
    await expect(saveAddedApp(root, source, record({ version: '2.0.0' }))).rejects.toThrow('Disk full');
    expect(await readAddedApps(root)).toEqual([record()]);
    expect((await loadAddedApps(root))[0].version).toBe('1.0.0');
    expect(readdirSync(join(root, '.abu', 'apps', '.staging'))).toEqual([]);
  });

  it('reports commitment before an old copy fails to be cleaned up', async () => {
    await saveAddedApp(root, source, record());
    writeApp(source, { version: '2.0.0' });
    const removeFile = vi.mocked(remove).getMockImplementation()!;
    vi.mocked(remove).mockImplementation(async (path, options) => {
      if (String(path).endsWith('-previous')) throw new Error('cleanup blocked');
      return removeFile(path, options);
    });
    let committed = false;
    await expect(saveAddedApp(root, source, record({ version: '2.0.0' }), () => { committed = true; })).rejects.toThrow('cleanup blocked');
    expect(committed).toBe(true);
    expect((await readAddedApps(root))[0].version).toBe('2.0.0');
    expect((await loadAddedApps(root))[0].version).toBe('2.0.0');
  });

  it('rejects an incomplete copied manifest before replacing the installed app', async () => {
    await saveAddedApp(root, source, record());
    rmSync(join(source, '.abu-app', 'app.json'));
    await expect(saveAddedApp(root, source, record())).rejects.toThrow();
    expect((await loadAddedApps(root))[0].version).toBe('1.0.0');
    expect(readdirSync(join(root, '.abu', 'apps', '.staging'))).toEqual([]);
  });

  it('rejects an existing market with a reserved name when planning an app', async () => {
    await expect(planAddApp({ kind: 'market', market: { name: 'mine', dir: root },
      entry: { name: 'contract-review', source: { kind: 'relative', path: './source' } } }, root)).rejects.toThrow();
    expect(await readAddedApps(root)).toEqual([]);
  });

  it('checks the origin again when confirming a previously prepared plan', async () => {
    const plan = await planAddApp({ kind: 'folder', dir: source }, root);
    const legacy = record({ appId: plan.appId, origin: { kind: 'market', market: 'local' } });
    writeApp(appDir(root, legacy.appId));
    writeFileSync(addedAppsPath(root), JSON.stringify([legacy]));
    await expect(confirmAddApp(plan, root, {})).rejects.toThrow();
    expect(await readAddedApps(root)).toEqual([legacy]);
  });

  it('releases prepared plugin snapshots without installing when confirmation finds a conflict', async () => {
    const plan = await planAddApp({ kind: 'folder', dir: source }, root);
    const released: string[] = [];
    vi.stubGlobal('__ABU_SHELL__', { pluginSnapshot: async (action: string, value: { token: string }) => {
      if (action !== 'release') throw new Error(`Unexpected snapshot action: ${action}`);
      released.push(value.token);
      return { released: true };
    } });
    plan.steps.push({ kind: 'install', marketplace: { name: 'tools-market', dir: source },
      entry: { name: 'tools', source: { kind: 'relative', path: './tools' } },
      disclosure: { key: 'tools@tools-market', name: 'tools', marketplace: 'tools-market', version: '1.0.0',
        manifest: { name: 'tools' }, sourceDir: source, skills: [], agents: [], mcpServers: [], ignoredPayloads: [], preparedToken: 'prepared-tools' } });
    const legacy = record({ appId: plan.appId, origin: { kind: 'market', market: 'local' } });
    writeApp(appDir(root, legacy.appId));
    writeFileSync(addedAppsPath(root), JSON.stringify([legacy]));
    await expect(confirmAddApp(plan, root, {})).rejects.toThrow('another source');
    expect(released).toEqual(['prepared-tools']);
    expect(await readAddedApps(root)).toEqual([legacy]);
    expect(existsSync(join(root, '.abu', 'plugin-packages', 'installed.json'))).toBe(false);
  });

  it.each(['mine', 'local', 'Mine', 'LOCAL', 'mine.', 'local...'])('refuses a market using the personal suffix %s before replacing files', async (market) => {
    const suffix = market.toLowerCase().replace(/\.+$/, '');
    const own = record({ appId: `contract-review@${suffix}`, origin: suffix === 'mine'
      ? { kind: 'created', authoringId: 'draft-1' } : { kind: 'folder', dir: source } });
    await saveAddedApp(root, source, own);
    writeApp(source, { version: '9.0.0' });
    await expect(saveAddedApp(root, source, record({ appId: `contract-review@${market}`, origin: { kind: 'market', market } }))).rejects.toThrow();
    expect(await readAddedApps(root)).toEqual([own]);
    expect(JSON.parse(readFileSync(join(appDir(root, own.appId), '.abu-app', 'app.json'), 'utf8')).version).toBe('1.0.0');
  });

  it('refuses replacing a legacy market app with a personal app of the same id', async () => {
    const legacy = record({ appId: 'contract-review@mine', origin: { kind: 'market', market: 'mine' } });
    const target = appDir(root, legacy.appId);
    writeApp(target);
    writeFileSync(addedAppsPath(root), JSON.stringify([legacy]));
    await expect(saveAddedApp(root, source, record({ appId: legacy.appId, origin: { kind: 'created', authoringId: 'draft-1' } }))).rejects.toThrow();
    expect(await readAddedApps(root)).toEqual([legacy]);
    expect(readFileSync(join(target, '.abu-app', 'app.json'), 'utf8')).toBe(readFileSync(join(source, '.abu-app', 'app.json'), 'utf8'));
  });

  it('refuses a different app id that would use the same directory on Windows', async () => {
    await saveAddedApp(root, source, record());
    await expect(saveAddedApp(root, source, record({ appId: 'contract-review@LAWYER-MARKET', origin: { kind: 'market', market: 'LAWYER-MARKET' } }))).rejects.toThrow();
    expect(await readAddedApps(root)).toEqual([record()]);
  });

  it('checks every legacy record sharing a Windows directory', async () => {
    await saveAddedApp(root, source, record());
    const records = [record(), record({ appId: 'contract-review@LAWYER-MARKET', origin: { kind: 'market', market: 'LAWYER-MARKET' } })];
    writeFileSync(addedAppsPath(root), JSON.stringify(records));
    await expect(saveAddedApp(root, source, record())).rejects.toThrow();
    expect(await readAddedApps(root)).toEqual(records);
  });

  it('refuses an app id whose trailing dot aliases an existing directory on Windows', async () => {
    await saveAddedApp(root, source, record());
    await expect(saveAddedApp(root, source, record({ appId: 'contract-review@lawyer-market.', origin: { kind: 'market', market: 'lawyer-market.' } }))).rejects.toThrow();
    expect(await readAddedApps(root)).toEqual([record()]);
  });

  it('copies the files, records the app and loads it for the switcher', async () => {
    await saveAddedApp(root, source, record());
    expect(await readAddedApps(root)).toEqual([record()]);
    const [app] = await loadAddedApps(root);
    expect(app).toMatchObject({ appId: 'contract-review@lawyer-market', name: '合同审阅', description: '按律所的做法审合同', version: '1.0.0', origin: { kind: 'market', market: 'lawyer-market' }, plugins: [] });
    expect(app.logo?.replace(/\\/g, '/')).toBe(`${appDir(root, app.appId)}/assets/logo.png`.replace(/\\/g, '/'));
    // What runs is the copy: the source can go away.
    rmSync(source, { recursive: true, force: true });
    expect((await loadAddedApps(root)).map((item) => item.appId)).toEqual(['contract-review@lawyer-market']);
  });

  it('replaces the app when the same app is added again', async () => {
    await saveAddedApp(root, source, record());
    writeApp(source, { version: '1.1.0' });
    await saveAddedApp(root, source, record({ version: '1.1.0' }));
    expect(await readAddedApps(root)).toEqual([record({ version: '1.1.0' })]);
    expect((await loadAddedApps(root))[0].version).toBe('1.1.0');
    expect(readdirSync(join(root, '.abu', 'apps', '.staging'))).toEqual([]);
  });

  it('removes only the app', async () => {
    await saveAddedApp(root, source, record());
    await removeAddedApp(root, 'contract-review@lawyer-market');
    expect(await readAddedApps(root)).toEqual([]);
    expect(existsSync(appDir(root, 'contract-review@lawyer-market'))).toBe(false);
    await expect(removeAddedApp(root, 'contract-review@lawyer-market')).rejects.toThrow('is not added');
  });

  it('keeps other apps when one app no longer reads', async () => {
    await saveAddedApp(root, source, record());
    const other = join(root, 'other');
    writeApp(other, { name: 'weekly' });
    await saveAddedApp(root, other, record({ appId: 'weekly@local', name: 'weekly', origin: { kind: 'folder', dir: other } }));
    writeFileSync(join(appDir(root, 'contract-review@lawyer-market'), '.abu-app', 'app.json'), '{"name":"contract-review"}');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await loadAddedApps(root)).map((app) => app.appId)).toEqual(['weekly@local']);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('contract-review@lawyer-market'), expect.anything());
    errors.mockRestore();
  });

  it('reads a missing file as nothing added and refuses a damaged one', async () => {
    expect(await readAddedApps(root)).toEqual([]);
    mkdirSync(dirname(addedAppsPath(root)), { recursive: true });
    writeFileSync(addedAppsPath(root), '{}');
    await expect(readAddedApps(root)).rejects.toThrow('not a list');
    writeFileSync(addedAppsPath(root), JSON.stringify([{ ...record(), appId: 'other@lawyer-market' }]));
    await expect(readAddedApps(root)).rejects.toThrow('entry 0 is not an app record');
  });
});
